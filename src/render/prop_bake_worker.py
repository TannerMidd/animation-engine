"""Blender-side driver for the prop foundry.

Run headless by ``src/pipeline/propbake.ts``:

    blender --background --factory-startup --python-exit-code 1 \
            --python prop_bake_worker.py -- --job <job.json>

``--factory-startup`` is not optional: without it the user's startup file, unit
settings, colour management and enabled add-ons all leak into the geometry.
``--python-exit-code 1`` is the non-obvious one -- without it Blender can exit 0
even after the script raised, and the spawning side would call a failed bake a
success.

All the arithmetic lives in ``prop_geometry.py``, which does not import bpy and
is tested under plain CPython. This file only reads a scene and hands over
numbers.
"""

import json
import os
import sys
from math import radians

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prop_geometry as geom  # noqa: E402

MIN_VERSION = (3, 6)


def log(**kwargs):
    """One JSON object per line, flushed -- the protocol every worker here uses."""
    print(json.dumps(kwargs), flush=True)


def argv_after_double_dash():
    """Blender leaves its own arguments in sys.argv; ours follow a bare ``--``."""
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1:]


def clear_scene():
    """Start from genuinely nothing, not from the factory cube.

    Done through ``bpy.data`` rather than ``bpy.ops`` because operators depend on
    context -- a selection, an active object, the right mode -- and none of that
    is reliable in background mode.
    """
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras):
        for item in list(collection):
            collection.remove(item)


def load_builder(source):
    """Execute a procedural source file and hand back its ``build`` function.

    The source is Python rather than a .blend on purpose: the whole catalogue
    then lives in git as text that diffs, and there is no binary asset to keep in
    sync with the code that reads it.
    """
    namespace = {"bpy": bpy, "bmesh": bmesh, "Vector": Vector, "radians": radians, "__name__": "propsource"}
    with open(source, "r", encoding="utf8") as handle:
        code = handle.read()
    exec(compile(code, source, "exec"), namespace)
    build = namespace.get("build")
    if not callable(build):
        raise RuntimeError('%s must define build(params) -- it defines %s' % (
            source, ", ".join(sorted(k for k in namespace if not k.startswith("__"))) or "nothing",
        ))
    return build


def setup_camera(view, config):
    """Place the camera for one view.

    Orthographic is the default and the right choice for a single prop: it reads
    correctly in a flat graphic style and cannot clip on the near plane.
    Perspective exists for spanning rooms, where vanishing points are the point.
    """
    data = bpy.data.cameras.new("bake-cam")
    data.type = "ORTHO" if view.get("type", "ortho") == "ortho" else "PERSP"
    if data.type == "ORTHO":
        data.ortho_scale = float(view.get("ortho_scale", config.get("ortho_scale", 4.0)))
    else:
        data.lens = float(view.get("lens", 50.0))

    cam = bpy.data.objects.new("bake-cam", data)
    bpy.context.scene.collection.objects.link(cam)

    location = Vector(view.get("location", [0.0, -6.0, 2.0]))
    target = Vector(view.get("target", [0.0, 0.0, 1.0]))
    cam.location = location
    cam.rotation_euler = (target - location).to_track_quat("-Z", "Y").to_euler()

    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x = int(config["resolution"][0])
    scene.render.resolution_y = int(config["resolution"][1])
    scene.render.resolution_percentage = 100
    # One Blender pixel must equal one engine unit, or nothing downstream lines up.
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0
    return cam


def projection_matrix(cam):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene
    # calc_matrix_camera lives on the Object, not on the Camera data block.
    proj = cam.calc_matrix_camera(
        depsgraph,
        x=scene.render.resolution_x,
        y=scene.render.resolution_y,
        scale_x=scene.render.pixel_aspect_x,
        scale_y=scene.render.pixel_aspect_y,
    )
    mvp = proj @ cam.matrix_world.inverted()
    return [[mvp[r][c] for c in range(4)] for r in range(4)]


def slot_for(material, warnings):
    """Material name -> palette slot, with the two suffix conventions applied.

    ``<slot>.noink`` fills without an outline, which is the main lever for
    keeping a detailed model from reading as scribble. ``<slot>.edge`` forces the
    square, unwobbled treatment for anything meeting the frame boundary.
    """
    if material is None:
        warnings.append("a face has no material; defaulting to surface")
        return "surface", True, False

    name = material.name
    outline = True
    edge = False
    if name.endswith(".noink"):
        name = name[: -len(".noink")]
        outline = False
    elif name.endswith(".edge"):
        name = name[: -len(".edge")]
        edge = True
    # Blender uniquifies duplicates as "wood.001".
    if "." in name and name.rsplit(".", 1)[1].isdigit():
        name = name.rsplit(".", 1)[0]
    return name, outline, edge


def collect_faces(obj, mvp, cam_origin, config, budget, warnings):
    """Project one object's faces into flat shapes."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    # Merge coplanar neighbours that share a material. This is the single
    # biggest decimation win, and it handles n-gons and holes properly rather
    # than by a hand-rolled boundary walk.
    bmesh.ops.dissolve_limit(
        bm,
        angle_limit=radians(float(config.get("coplanar_angle", 1.5))),
        delimit={"MATERIAL"},
        verts=bm.verts[:],
        edges=bm.edges[:],
    )
    bm.transform(obj.matrix_world)
    bm.normal_update()

    res_x = int(config["resolution"][0])
    res_y = int(config["resolution"][1])
    shapes = []

    for index, face in enumerate(bm.faces):
        centroid = face.calc_center_median()
        if geom.back_facing(tuple(face.normal), tuple(centroid), cam_origin):
            continue

        projected = [geom.project(mvp, tuple(v.co), res_x, res_y) for v in face.verts]
        if any(p is None for p in projected):
            # A vertex behind the camera. Near-plane clipping is deliberately not
            # implemented -- for a bake you control, moving the camera is the fix.
            warnings.append(
                'object "%s" has geometry behind the camera; move the camera back '
                "or reduce the model's depth" % obj.name
            )
            continue

        points = [(p[0], p[1]) for p in projected]
        if geom.polygon_area(points) < float(budget["min_area_px"]):
            continue

        material = None
        if obj.material_slots and face.material_index < len(obj.material_slots):
            material = obj.material_slots[face.material_index].material
        slot, outline, edge = slot_for(material, warnings)

        points = geom.simplify_closed(points, float(budget["simplify_epsilon"]))
        points = geom.enforce_point_cap(
            points, True, int(budget["max_points_per_shape"]), float(budget["simplify_epsilon"])
        )
        if len(points) < 3:
            continue

        depth = sum(p[2] for p in projected) / len(projected)
        shape = geom.build_shape(points, slot, outline, True, depth, obj.name, index)
        if edge:
            shape["e"] = 1
        shapes.append(shape)

    bm.free()
    evaluated.to_mesh_clear()
    return shapes


def assert_one_point(view, name):
    """A spanning room must be baked in one-point perspective.

    The engine has no ground-plane depth model: ``horizonY`` is a single
    horizontal line and an actor stands at the same height whatever their x. A
    room baked from an off-axis or tilted camera implies a character at stage
    left should be smaller and higher than one at stage right, and nothing in the
    staging code can express that -- so correct blocking would look wrong against
    a correct room. Keeping the camera on the room's centre axis and level keeps
    the floor's near edge a horizontal band, which is the geometry the rest of
    the engine already assumes.

    This is a constraint, not a preference, which is why it is asserted here
    rather than written down in a comment somewhere.
    """
    location = view.get("location", [0.0, -6.0, 2.0])
    target = view.get("target", [0.0, 0.0, 1.0])
    if abs(location[0] - target[0]) > 1e-6:
        raise RuntimeError(
            'view "%s": a spanning room must be baked on the room\'s centre axis, but the camera '
            "is at x=%g looking at x=%g. Off-axis gives two-point perspective, which implies a "
            "ground plane the engine cannot stage actors on." % (name, location[0], target[0])
        )
    if abs(location[2] - target[2]) > 1e-6:
        raise RuntimeError(
            'view "%s": a spanning room must be baked level, but the camera is at z=%g looking at '
            "z=%g. Tilting converges the verticals and bends the horizon the actors stand on."
            % (name, location[2], target[2])
        )


def bake_view(name, view, config, budget, warnings):
    spanning = bool(config.get("spanning"))
    if spanning:
        assert_one_point(view, name)

    cam = setup_camera(view, config)
    mvp = projection_matrix(cam)
    cam_origin = tuple(cam.matrix_world.translation)

    res_x = int(config["resolution"][0])
    res_y = int(config["resolution"][1])

    if spanning:
        # A spanning prop draws in set coordinates, not around a floor-contact
        # origin, so the rendered frame *is* the artwork rect and the projection
        # maps straight onto it.
        frame = config["frame"]
        origin_2d = (-float(frame[0]), -float(frame[1]))
    else:
        # Everything else draws locally around where it meets the floor, which by
        # convention is the world origin in the source scene.
        origin = geom.project(mvp, (0.0, 0.0, 0.0), res_x, res_y)
        if origin is None:
            raise RuntimeError('view "%s": the world origin is behind the camera' % name)
        origin_2d = (origin[0], origin[1])

    shapes = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        shapes.extend(collect_faces(obj, mvp, cam_origin, config, budget, warnings))

    # Measure where the room's own geometry put the horizon rather than asking
    # the author to predict it. The set layout has to agree with the bake, and
    # deriving it from a probe point makes the manifest self-consistent by
    # construction -- the linter then only has to compare two recorded numbers.
    measured = None
    if spanning:
        measured = {}
        for key, probe in (("horizonY", "horizon_probe"), ("ceilingY", "ceiling_probe")):
            point = config.get(probe)
            if point is None:
                raise RuntimeError('a spanning bake needs "%s" — the world point whose height '
                                   "defines the set's %s" % (probe, key))
            hit = geom.project(mvp, tuple(point), res_x, res_y)
            if hit is None:
                raise RuntimeError('%s is behind the camera' % probe)
            measured[key] = round(hit[1] - origin_2d[1], 1)

    shapes = geom.sort_back_to_front(shapes)
    for shape in shapes:
        shape["p"] = geom.round_points(
            [(shape["p"][i] - origin_2d[0], shape["p"][i + 1] - origin_2d[1])
             for i in range(0, len(shape["p"]), 2)]
        )

    # Anything reaching the boundary draws square. Wobble and the off-register
    # fill both move geometry a couple of units, which is the whole style in the
    # middle of a picture and a gap onto the background at its edge.
    if spanning:
        geom.mark_edge_shapes(shapes, config["frame"])

    bpy.data.objects.remove(cam, do_unlink=True)
    return shapes, measured


def main():
    if bpy.app.version < MIN_VERSION:
        log(kind="fatal", message="Blender %d.%d is older than the required %d.%d"
            % (bpy.app.version[0], bpy.app.version[1], MIN_VERSION[0], MIN_VERSION[1]))
        raise SystemExit(1)

    args = argv_after_double_dash()
    if len(args) < 2 or args[0] != "--job":
        log(kind="fatal", message="usage: -- --job <job.json>")
        raise SystemExit(1)

    with open(args[1], "r", encoding="utf8") as handle:
        job = json.load(handle)

    config = job["config"]
    budget = dict(geom.DEFAULT_BUDGET)
    budget.update(job.get("budget") or {})
    views = config["views"]

    log(kind="loading", message="building %s" % job["key"], total=len(views))
    clear_scene()
    build = load_builder(job["source"])
    build(config.get("params") or {})
    log(kind="loaded", objects=len([o for o in bpy.context.scene.objects if o.type == "MESH"]))

    warnings = []
    baked = {}
    measured_frame = None
    for name, view in views.items():
        shapes, measured = bake_view(name, view, config, budget, warnings)
        if measured:
            frame = config["frame"]
            measured_frame = {
                "x0": frame[0],
                "y0": frame[1],
                "width": frame[2] - frame[0],
                "height": frame[3] - frame[1],
                "horizonY": measured["horizonY"],
                "ceilingY": measured["ceilingY"],
            }

        problems = geom.validate_slots(shapes, job["slots"])
        errors, budget_warnings = geom.check_budget(shapes, budget)
        for warning in budget_warnings:
            log(kind="warn", message="%s: %s" % (name, warning))
        if problems or errors:
            for message in problems + errors:
                log(kind="error", message="%s: %s" % (name, message))
            log(kind="fatal", message='view "%s" did not pass validation' % name)
            raise SystemExit(1)

        baked[name] = {"shapes": geom.strip_internals(shapes)}
        log(kind="item", id=name, shapes=len(shapes), points=geom.count_points(shapes))

    for warning in sorted(set(warnings)):
        log(kind="warn", message=warning)

    manifest = geom.build_manifest(
        job["key"], config.get("label", job["key"]), config.get("tags", []),
        config.get("spanning", False),
        {
            "blender": "%d.%d.%d" % bpy.app.version,
            "source": job["sourceHash"],
            "baked": job["bakedAt"],
        },
        baked,
    )

    if config.get("spanning"):
        manifest["frame"] = measured_frame

    os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
    with open(job["out"], "w", encoding="utf8") as handle:
        handle.write(geom.dumps_manifest(manifest))

    log(kind="done", out=job["out"])


if __name__ == "__main__":
    main()
