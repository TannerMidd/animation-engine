"""Tests for the foundry's pure geometry, under plain CPython.

No Blender anywhere. The module under test deliberately keeps ``bpy`` out of its
imports so every decision that ends up in the artwork -- what gets culled, what
order it draws in, how far it is simplified, how it is rounded -- can be pinned
without a 300 MB dependency and without a GPU.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "render"))

import prop_geometry as geom


failures = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        failures.append("%s %s" % (name, detail))
        print("  FAIL %s %s" % (name, detail))


def identity_mvp():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def ortho_mvp():
    """Looking down -Z with w pinned to 1: NDC equals world x/y."""
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]]


print("projection")
mvp = ortho_mvp()
centre = geom.project(mvp, (0.0, 0.0, 0.0), 200, 100)
check("world origin lands mid-frame", centre[:2] == (100.0, 50.0), str(centre))

right = geom.project(mvp, (1.0, 0.0, 0.0), 200, 100)
check("+x goes right", right[0] > centre[0], str(right))

up = geom.project(mvp, (0.0, 1.0, 0.0), 200, 100)
check("+y goes UP in world, DOWN in pixels", up[1] < centre[1], str(up))

behind = geom.project([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 0]], (0.0, 0.0, -5.0), 200, 100)
check("a point behind the camera is dropped", behind is None, str(behind))

# The regression that produced a staircase drawn inside out. Under an ortho
# projection the clip w is constant 1, so depth has to come from z -- keying on
# w gives every face the same depth and the painter's sort silently collapses
# into its tie-break.
near = geom.project(mvp, (0.0, 0.0, 1.0), 200, 100)
far = geom.project(mvp, (0.0, 0.0, -1.0), 200, 100)
check("ortho still separates near from far", near[2] != far[2], "%s vs %s" % (near[2], far[2]))
check("further away is a larger depth", far[2] > near[2], "%s vs %s" % (far[2], near[2]))

persp = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1.2, -2.2], [0, 0, -1, 0]]
p_near = geom.project(persp, (0.0, 0.0, -2.0), 200, 100)
p_far = geom.project(persp, (0.0, 0.0, -20.0), 200, 100)
check("perspective orders the same way", p_far[2] > p_near[2], "%s vs %s" % (p_far[2], p_near[2]))


print("back-face culling")
# A face at the origin whose normal points away from a camera at +Z.
check(
    "normal pointing away is culled",
    geom.back_facing((0.0, 0.0, -1.0), (0.0, 0.0, 0.0), (0.0, 0.0, 10.0)),
)
check(
    "normal pointing at the camera is kept",
    not geom.back_facing((0.0, 0.0, 1.0), (0.0, 0.0, 0.0), (0.0, 0.0, 10.0)),
)
# Under perspective the view vector matters, not the normal's z: a face off to
# one side can face the camera while its normal has the "wrong" sign in z.
check(
    "uses the view vector, not normal.z",
    not geom.back_facing((1.0, 0.0, 0.0), (5.0, 0.0, 0.0), (10.0, 0.0, 0.0)),
)


print("area and bounds")
square = [(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)]
check("shoelace area", geom.polygon_area(square) == 12.0, str(geom.polygon_area(square)))
check("area ignores winding", geom.polygon_area(list(reversed(square))) == 12.0)
check("degenerate has no area", geom.polygon_area([(0.0, 0.0), (1.0, 1.0)]) == 0.0)
check("bounds", geom.bounds(square) == (0.0, 0.0, 4.0, 3.0))


print("simplification")
collinear = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (4.0, 0.0)]
check("collinear run collapses to its ends", geom.rdp(collinear, 0.5) == [(0.0, 0.0), (4.0, 0.0)])

bumpy = [(0.0, 0.0), (2.0, 5.0), (4.0, 0.0)]
check("a real corner survives", len(geom.rdp(bumpy, 0.5)) == 3)
check("a big epsilon flattens it", len(geom.rdp(bumpy, 10.0)) == 2)

dense = [(float(i), 0.0) for i in range(8)] + [(7.0, float(i)) for i in range(1, 8)]
capped = geom.enforce_point_cap(dense, False, 4, 0.5)
check("point cap is enforced", len(capped) <= 4, str(len(capped)))

loop = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]
simplified = geom.simplify_closed(loop, 0.5)
check("closed loop keeps at least a triangle", len(simplified) >= 3, str(simplified))
check("closed loop is not left duplicated", simplified[0] != simplified[-1], str(simplified))


print("painter order")
shapes = [
    {"depth": 1.0, "object": "b", "index": 0, "p": [0, 0, 1, 0, 1, 1]},
    {"depth": 9.0, "object": "a", "index": 5, "p": [0, 0, 1, 0, 1, 1]},
    {"depth": 5.0, "object": "c", "index": 2, "p": [0, 0, 1, 0, 1, 1]},
]
ordered = geom.sort_back_to_front(shapes)
check("furthest draws first", [s["depth"] for s in ordered] == [9.0, 5.0, 1.0])

# The tie-break is the load-bearing part: coplanar faces must not reshuffle
# between runs just because the input arrived in a different order.
tied = [
    {"depth": 3.0, "object": "z", "index": 1, "p": []},
    {"depth": 3.0, "object": "a", "index": 9, "p": []},
    {"depth": 3.0, "object": "a", "index": 2, "p": []},
]
first = [(s["object"], s["index"]) for s in geom.sort_back_to_front(tied)]
second = [(s["object"], s["index"]) for s in geom.sort_back_to_front(list(reversed(tied)))]
check("ties resolve identically whatever the input order", first == second, "%s vs %s" % (first, second))
check("tie-break is object then index", first == [("a", 2), ("a", 9), ("z", 1)], str(first))


print("edge shapes")
frame = (-420.0, -220.0, 1700.0, 940.0)
inner = geom.build_shape([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], "wood", True, True, 1.0)
outer = geom.build_shape([(-420.0, -220.0), (1700.0, -220.0), (1700.0, 940.0)], "wall", True, True, 1.0)
geom.mark_edge_shapes([inner, outer], frame)
check("interior shape is not flagged", inner["e"] == 0)
check("shape touching the frame is flagged", outer["e"] == 1)


print("rounding and local space")
shape = geom.build_shape([(10.06, -4.04), (20.0, -4.0)], "wood", True, False, 2.0, origin=(10.0, 0.0))
check("origin is subtracted", shape["p"][0] == 0.1, str(shape["p"]))
check("rounded to 1dp", shape["p"] == [0.1, -4.0, 10.0, -4.0], str(shape["p"]))
check("outline flag", shape["l"] == 1)
check("open polyline", shape["c"] == 0)


print("slot validation")
ok = [{"f": "wood", "p": []}, {"f": None, "p": []}]
bad = [{"f": "mahogany", "p": []}]
check("known slots pass", geom.validate_slots(ok, ["wood", "metal", "line"]) == [])
problems = geom.validate_slots(bad, ["wood", "metal", "line"])
check("unknown slot is reported", len(problems) == 1 and "mahogany" in problems[0], str(problems))
check("the report suggests alternatives", "wood" in problems[0], str(problems))


print("budget")
small = [{"p": [0, 0, 1, 1, 2, 2]} for _ in range(5)]
errors, warnings = geom.check_budget(small)
check("a small bake passes clean", errors == [] and warnings == [])

many = [{"p": [0, 0, 1, 1, 2, 2]} for _ in range(geom.DEFAULT_BUDGET["max_shapes"] + 1)]
errors, _ = geom.check_budget(many)
check("too many shapes is an error", len(errors) >= 1 and "shapes" in errors[0], str(errors))

wide = [{"p": [0.0] * (2 * (geom.DEFAULT_BUDGET["max_points"] + 5))}]
errors, _ = geom.check_budget(wide)
check("too many points is an error even at one shape", any("points" in e for e in errors), str(errors))

warn_only = [{"p": [0, 0, 1, 1, 2, 2]} for _ in range(geom.DEFAULT_BUDGET["warn_shapes"] + 1)]
errors, warnings = geom.check_budget(warn_only)
check("the comfortable limit warns rather than fails", errors == [] and len(warnings) == 1, str(warnings))


print("emission")
manifest = geom.build_manifest(
    "test-block", "Test block", ["baked"], False,
    {"blender": "4.5.1", "source": "sha1:abc", "baked": "2026-08-04"},
    {"front": {"shapes": geom.strip_internals([inner, outer])}},
)
text = geom.dumps_manifest(manifest)
parsed = json.loads(text)
check("round-trips as JSON", parsed["key"] == "test-block")
check("internals are stripped", "depth" not in parsed["views"]["front"]["shapes"][0])
check("the edge flag survives", parsed["views"]["front"]["shapes"][1]["e"] == 1)
check("one shape per line, for reviewable diffs", text.count('{"c"') == 2, str(text.count('{"c"')))
check("emission is byte-stable across runs", geom.dumps_manifest(manifest) == text)


print()
if failures:
    print("%d failure(s):" % len(failures))
    for failure in failures:
        print("  - %s" % failure)
    sys.exit(1)
print("prop_bake_test: all checks passed")
