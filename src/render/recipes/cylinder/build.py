"""A round body with an elliptical top -- a barrel, a bin, a tank.

Faceted rather than smooth, and deliberately so: the bake projects faces down to
flat polygons, and a high-facet cylinder becomes a hundred near-identical
slivers that read as scribble under the ink line. Twelve sides is plenty for a
shape whose silhouette is the whole point.

Materials are named after palette slots, so one bake works in every palette.
"""

from math import cos, pi, sin


def material(name):
    existing = bpy.data.materials.get(name)
    return existing if existing else bpy.data.materials.new(name)


def drum(name, radius, top_radius, z0, z1, sides, slot, top_slot):
    verts = []
    for i in range(sides):
        angle = 2.0 * pi * i / sides
        verts.append((radius * cos(angle), radius * sin(angle), z0))
    for i in range(sides):
        angle = 2.0 * pi * i / sides
        verts.append((top_radius * cos(angle), top_radius * sin(angle), z1))

    faces = []
    # Sides, wound counter-clockwise from outside so the back-face cull keeps
    # only the half of the drum you can actually see.
    for i in range(sides):
        j = (i + 1) % sides
        faces.append((i, j, sides + j, sides + i))
    # Bottom, then top.
    faces.append(tuple(range(sides - 1, -1, -1)))
    top_index = len(faces)
    faces.append(tuple(range(sides, sides * 2)))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    mesh.materials.append(material(slot))
    if top_slot and top_slot != slot:
        mesh.materials.append(material(top_slot))
        mesh.polygons[top_index].material_index = 1

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(params):
    radius = float(params.get("radius", 0.36))
    height = float(params.get("height", 0.9))
    sides = max(6, min(24, int(params.get("sides", 12))))
    taper = float(params.get("taper", 0.0))
    slot = str(params.get("slot", "metal"))
    top_slot = str(params.get("topSlot", "metalDark"))

    drum("body", radius * (1.0 - taper), radius, 0.0, height, sides, slot, top_slot)

    # A band proud of the body at the lip. One extra ring, and it is what makes
    # a cylinder read as a container rather than as a post.
    if params.get("rim", True):
        drum(
            "rim",
            radius * 1.06,
            radius * 1.06,
            height - min(0.08, height * 0.12),
            height,
            sides,
            top_slot,
            top_slot,
        )
