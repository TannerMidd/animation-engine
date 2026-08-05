"""Open shelving: two uprights, a stack of shelves, optionally a back.

The reason this wants baking rather than drawing is the shelf tops. In a flat
elevation a shelf is a line; here it is a surface you can see across, which is
what makes the unit read as having depth at all.

Geometry is deliberately low-poly, and materials are named after palette slots
so one bake works in every palette.
"""

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
    width = float(params.get("width", 1.1))
    height = float(params.get("height", 1.8))
    depth = float(params.get("depth", 0.4))
    shelves = max(2, int(params.get("shelves", 4)))
    slot = str(params.get("slot", "wood"))
    top_slot = str(params.get("topSlot", "woodDark"))

    thickness = min(0.06, width * 0.06)
    half_w = width / 2.0
    half_d = depth / 2.0

    box("upright-l", (-half_w, -half_d, 0.0), (-half_w + thickness, half_d, height), slot)
    box("upright-r", (half_w - thickness, -half_d, 0.0), (half_w, half_d, height), slot)

    # Shelves are evenly spaced including the top, so the unit always reads as
    # closed rather than as an open-topped frame.
    for i in range(shelves):
        z = height * (i + 1) / shelves
        box(
            "shelf-%02d" % i,
            (-half_w + thickness, -half_d, z - thickness),
            (half_w - thickness, half_d, z),
            slot,
            top_slot=top_slot,
        )

    if params.get("back", False):
        box(
            "back",
            (-half_w + thickness, half_d - thickness * 0.5, 0.0),
            (half_w - thickness, half_d, height),
            top_slot,
        )
