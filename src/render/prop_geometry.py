"""Projection and decimation for the prop foundry.

Deliberately free of ``bpy``. Everything here is arithmetic on plain tuples, so
it imports and runs under ordinary CPython and can be tested without Blender
installed -- which matters because this is where every decision that shows up in
the final artwork is made. The Blender driver next door does nothing but read a
scene and hand its numbers to these functions.

The approach is a painter's-algorithm face projection rather than Blender's
Line Art. Line Art's one hard trick is hidden-line removal, and drawing shapes
back to front gives that away for free: each shape's fill covers the outlines
behind it. Avoiding it also avoids the Grease Pencil data path, which has been
restructured twice recently, and ``bpy.ops`` calls, which are context-sensitive
and the classic failure in background mode.
"""

import json
import math

# Points are rounded to 1dp. The renderer re-rounds to 2dp when it emits paths,
# and the house style displaces every point by a couple of units anyway, so
# anything finer is noise that only costs file size.
POINT_DP = 1

DEFAULT_BUDGET = {
    "warn_shapes": 120,
    "max_shapes": 300,
    "warn_points": 800,
    "max_points": 2000,
    # Faces smaller than this project to slivers that wobble into visual noise.
    "min_area_px": 6.0,
    # Ramer-Douglas-Peucker tolerance, in engine units.
    "simplify_epsilon": 1.5,
    "max_points_per_shape": 40,
}


# --- projection -------------------------------------------------------------

def project(mvp, point, res_x, res_y):
    """World point -> ``(x_px, y_px, depth)``, or ``None`` if behind the camera.

    ``mvp`` is the camera's projection matrix times the inverted camera world
    matrix, as 4 rows of 4 numbers -- i.e. Blender's own maths, just applied
    here so the same code path is testable without it.

    Depth is normalised device z, near at -1 and far at +1, which is what the
    painter's sort orders on. It has to be the z and not the clip w: under an
    orthographic projection w is constant 1, so keying on it gives every face in
    the model the same depth and the sort silently degenerates into whatever the
    tie-break says -- which puts the far side of a staircase on top of the near
    side and looks, reasonably enough, like the geometry is inside out.
    """
    x, y, z = point
    clip = [
        mvp[i][0] * x + mvp[i][1] * y + mvp[i][2] * z + mvp[i][3]
        for i in range(4)
    ]
    w = clip[3]
    if w <= 1e-6:
        return None

    # NDC is [-1, 1] with +Y up; the engine's space has +Y down.
    px = (clip[0] / w * 0.5 + 0.5) * res_x
    py = (1.0 - (clip[1] / w * 0.5 + 0.5)) * res_y
    return (px, py, clip[2] / w)


def back_facing(normal, centroid, cam_origin):
    """Is this face pointing away from the camera?

    Uses the view vector rather than the normal's z, which is only equivalent
    under an orthographic camera and quietly wrong under a perspective one.
    """
    vx = centroid[0] - cam_origin[0]
    vy = centroid[1] - cam_origin[1]
    vz = centroid[2] - cam_origin[2]
    return normal[0] * vx + normal[1] * vy + normal[2] * vz > 0.0


# --- 2D helpers -------------------------------------------------------------

def polygon_area(points):
    """Unsigned area of a closed polygon, by the shoelace formula."""
    n = len(points)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return abs(total) * 0.5


def bounds(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _perpendicular_distance(point, start, end):
    if start == end:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    cross = abs(dx * (start[1] - point[1]) - (start[0] - point[0]) * dy)
    return cross / length


def rdp(points, epsilon):
    """Ramer-Douglas-Peucker simplification of an open polyline.

    Removes the collinear runs that survive a 3D coplanar merge -- a projected
    quad usually needs four points and arrives with rather more.
    """
    if len(points) < 3 or epsilon <= 0:
        return list(points)

    worst = 0.0
    index = 0
    for i in range(1, len(points) - 1):
        d = _perpendicular_distance(points[i], points[0], points[-1])
        if d > worst:
            worst = d
            index = i

    if worst <= epsilon:
        return [points[0], points[-1]]

    left = rdp(points[: index + 1], epsilon)
    right = rdp(points[index:], epsilon)
    return left[:-1] + right


def simplify_closed(points, epsilon):
    """RDP for a closed loop, keeping the first vertex pinned."""
    if len(points) < 4 or epsilon <= 0:
        return list(points)
    opened = list(points) + [points[0]]
    simplified = rdp(opened, epsilon)
    if len(simplified) > 1 and simplified[0] == simplified[-1]:
        simplified = simplified[:-1]
    return simplified if len(simplified) >= 3 else list(points)


def enforce_point_cap(points, closed, cap, epsilon):
    """Simplify harder until a shape is under the per-shape point cap."""
    out = list(points)
    step = max(epsilon, 0.1)
    while len(out) > cap and step < 1000.0:
        step *= 1.6
        out = simplify_closed(points, step) if closed else rdp(points, step)
    return out[:cap] if len(out) > cap else out


# --- shape assembly ---------------------------------------------------------

def painter_key(shape):
    """A total order, so ties cannot reshuffle between runs.

    Sorting on depth alone leaves coplanar faces to whatever order the mesh
    iteration happened to produce, which is stable within a Blender version and
    not something worth relying on.
    """
    return (-shape["depth"], shape.get("object", ""), shape.get("index", 0))


def sort_back_to_front(shapes):
    return sorted(shapes, key=painter_key)


def mark_edge_shapes(shapes, frame, tolerance=1.0):
    """Flag shapes that reach the edge of the artwork.

    Wobble and the deliberate fill misregistration both move geometry a couple
    of units. In the middle of a picture that is the entire point of the style;
    at its boundary it opens a gap onto the background. The renderer draws these
    square instead, exactly as an unoutlined wall or floor is drawn today.
    """
    x0, y0, x1, y1 = frame
    for shape in shapes:
        points = [(shape["p"][i], shape["p"][i + 1]) for i in range(0, len(shape["p"]), 2)]
        bx0, by0, bx1, by1 = bounds(points)
        touches = (
            bx0 <= x0 + tolerance or by0 <= y0 + tolerance
            or bx1 >= x1 - tolerance or by1 >= y1 - tolerance
        )
        if touches:
            shape["e"] = 1
    return shapes


def round_points(points, dp=POINT_DP):
    flat = []
    for x, y in points:
        flat.append(round(x, dp))
        flat.append(round(y, dp))
    return flat


def build_shape(points, slot, outline, closed, depth, obj="", index=0, origin=(0.0, 0.0)):
    """One emitted shape, in the prop's local space.

    Local space puts the origin where the prop meets the floor, which is the
    contract every hand-written prop already draws to.
    """
    moved = [(x - origin[0], y - origin[1]) for x, y in points]
    return {
        "f": slot,
        "l": 1 if outline else 0,
        "c": 1 if closed else 0,
        "e": 0,
        "p": round_points(moved),
        "depth": depth,
        "object": obj,
        "index": index,
    }


def strip_internals(shapes):
    """Drop the bookkeeping fields the manifest format does not carry."""
    out = []
    for shape in shapes:
        clean = {"f": shape["f"], "l": shape["l"], "c": shape["c"], "p": shape["p"]}
        if shape.get("e"):
            clean["e"] = 1
        out.append(clean)
    return out


# --- validation -------------------------------------------------------------

def validate_slots(shapes, slots):
    """Every fill must name a real palette slot.

    The slot list travels in the job rather than being hardcoded here, so the
    Python side cannot drift from the palette definition in TypeScript.
    """
    known = set(slots)
    problems = []
    for shape in shapes:
        slot = shape.get("f")
        if slot is None or slot in known:
            continue
        near = sorted(known, key=lambda s: (abs(len(s) - len(slot)), s))[:5]
        problems.append(
            'unknown palette slot "%s" (did you mean: %s)' % (slot, ", ".join(near))
        )
    return problems


def count_points(shapes):
    return sum(len(s["p"]) // 2 for s in shapes)


def check_budget(shapes, budget=None):
    """Returns ``(errors, warnings)``.

    Point count is the limit that matters. Every input point becomes a cubic in
    the render page, so a shape's cost is set by how many points went into it,
    not by how many shapes there are.
    """
    budget = budget or DEFAULT_BUDGET
    errors = []
    warnings = []
    points = count_points(shapes)

    if len(shapes) > budget["max_shapes"]:
        errors.append(
            "%d shapes exceeds the limit of %d. Simplify the source geometry, or mark "
            "interior detail materials .noink so they fill without an outline."
            % (len(shapes), budget["max_shapes"])
        )
    elif len(shapes) > budget["warn_shapes"]:
        warnings.append("%d shapes is above the %d comfortable limit" % (len(shapes), budget["warn_shapes"]))

    if points > budget["max_points"]:
        errors.append(
            "%d points exceeds the limit of %d. Each becomes a cubic in the render page."
            % (points, budget["max_points"])
        )
    elif points > budget["warn_points"]:
        warnings.append("%d points is above the %d comfortable limit" % (points, budget["warn_points"]))

    return errors, warnings


# --- emission ---------------------------------------------------------------

def build_manifest(key, label, tags, spanning, provenance, views, frame=None):
    manifest = {
        "format": 1,
        "key": key,
        "label": label,
        "tags": tags,
        "spanning": bool(spanning),
        "provenance": provenance,
        "views": views,
    }
    if frame:
        manifest["frame"] = frame
    return manifest


def dumps_manifest(manifest):
    """Serialise with one shape per line.

    A re-bake that moves three faces should show as three changed lines in a
    diff, not as one rewritten 50 KB line.
    """
    lines = []
    lines.append("{")
    lines.append('  "format": %d,' % manifest["format"])
    lines.append('  "key": %s,' % json.dumps(manifest["key"]))
    lines.append('  "label": %s,' % json.dumps(manifest["label"]))
    lines.append('  "tags": %s,' % json.dumps(manifest["tags"]))
    lines.append('  "spanning": %s,' % ("true" if manifest["spanning"] else "false"))
    lines.append('  "provenance": %s,' % json.dumps(manifest["provenance"], sort_keys=True))
    if "frame" in manifest:
        lines.append('  "frame": %s,' % json.dumps(manifest["frame"], sort_keys=True))
    lines.append('  "views": {')

    view_names = list(manifest["views"].keys())
    for vi, name in enumerate(view_names):
        lines.append('    %s: {' % json.dumps(name))
        lines.append('      "shapes": [')
        shapes = manifest["views"][name]["shapes"]
        for si, shape in enumerate(shapes):
            comma = "," if si < len(shapes) - 1 else ""
            lines.append("        %s%s" % (json.dumps(shape, sort_keys=True), comma))
        lines.append("      ]")
        lines.append("    }%s" % ("," if vi < len(view_names) - 1 else ""))

    lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"
