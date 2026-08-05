"""A box with a visible top -- the shape a flat elevation cannot describe.

Source files are Python, never .blend, so the whole catalogue lives in git as
text that diffs and reviews.

Geometry is deliberately low-poly. The engine draws in a flat graphic style with
a heavy ink line, so a model with hundreds of faces does not read as detail --
it reads as scribble. Build the form, not the surface.

Materials are named after palette slots. A face tagged ``wood`` takes whatever
"wood" means in the set's palette, so one bake works in an office, a dive bar
and a roadside at dusk.
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


def box(name, lo, hi, slot, top_slot=None):
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    verts = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], BOX_FACES)
    mesh.update()

    mesh.materials.append(material(slot))
    if top_slot and top_slot != slot:
        mesh.materials.append(material(top_slot))
        mesh.polygons[TOP_FACE].material_index = 1

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(params):
    width = float(params.get("width", 0.9))
    depth = float(params.get("depth", 0.9))
    height = float(params.get("height", 0.9))
    slot = str(params.get("slot", "wood"))
    top_slot = str(params.get("topSlot", "wood"))
    lid = float(params.get("lid", 0.0))

    box(
        "body",
        (-width / 2.0, -depth / 2.0, 0.0),
        (width / 2.0, depth / 2.0, height),
        slot,
        top_slot=top_slot,
    )

    # An optional lip proud of the body. It costs one box and it is the
    # difference between a crate and a cube.
    if lid > 0.0:
        box(
            "lid",
            (-width / 2.0 - lid, -depth / 2.0 - lid, height),
            (width / 2.0 + lid, depth / 2.0 + lid, height + lid * 1.6),
            top_slot,
        )
