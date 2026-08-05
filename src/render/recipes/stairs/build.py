"""Procedural staircase for the prop foundry.

Source files are Python, never .blend. The whole catalogue then lives in git as
text that diffs and reviews, and there is no binary asset to keep in step with
the code that reads it.

Geometry is deliberately low-poly. The engine draws in a flat graphic style with
a heavy ink line, so a model with hundreds of faces does not read as detail --
it reads as scribble. Build the form, not the surface.

Materials are named after palette slots. A face tagged ``wood`` takes whatever
"wood" means in the set's palette, so one bake works in an office, a dive bar and
a roadside at dusk. Two suffixes are understood: ``<slot>.noink`` fills without
an outline, and ``<slot>.edge`` forces the square, unwobbled treatment used at
the edge of the world.
"""

# Face order is fixed: bottom, top, front (-Y), right (+X), back (+Y), left (-X).
# Winding is counter-clockwise seen from outside, so normals point out and the
# back-face cull keeps the faces you can actually see.
BOX_FACES = [
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
]

TOP_FACE = 1


def material(name):
    existing = bpy.data.materials.get(name)
    return existing if existing else bpy.data.materials.new(name)


def box(name, lo, hi, slots, top_slot=None):
    """An axis-aligned box, optionally with a different material on its top face."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    verts = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], BOX_FACES)
    mesh.update()

    mesh.materials.append(material(slots))
    if top_slot:
        mesh.materials.append(material(top_slot))
        mesh.polygons[TOP_FACE].material_index = 1

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(params):
    steps = int(params.get("steps", 8))
    rise = float(params.get("rise", 0.3))
    run = float(params.get("run", 0.34))
    width = float(params.get("width", 1.6))
    half = width / 2.0

    # Each step is a solid block from the floor to its own tread. Treads catch
    # the light, so they take the lighter slot and the risers the darker one --
    # which is the only thing telling the eye this is a solid and not a zigzag.
    for i in range(steps):
        box(
            "step-%02d" % i,
            (-half, i * run, 0.0),
            (half, (i + 1) * run, (i + 1) * rise),
            str(params.get("slot", "woodDark")),
            top_slot=str(params.get("topSlot", "wood")),
        )

    # A stringer down the open side. One box, and it turns the silhouette from a
    # stack of cubes into a staircase.
    if params.get("stringer", True):
        box(
            "stringer",
            (half, 0.0, 0.0),
            (half + 0.08, steps * run, steps * rise * 0.35),
            "metalDark",
        )
