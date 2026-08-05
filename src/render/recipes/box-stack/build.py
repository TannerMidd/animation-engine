"""Crates piled up.

Geometry is deliberately low-poly. The engine draws in a flat graphic style with
a heavy ink line, so a model with hundreds of faces reads as scribble rather
than as detail. Build the form, not the surface.

Materials are named after palette slots, so one bake works in every palette.
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
    count = max(1, int(params.get("count", 2)))
    width = float(params.get("width", 0.9))
    depth = float(params.get("depth", 0.9))
    height = float(params.get("height", 0.7))
    taper = float(params.get("taper", 0.12))
    shift = float(params.get("shift", 0.12))
    slot = str(params.get("slot", "wood"))
    top_slot = str(params.get("topSlot", "wood"))

    z = 0.0
    for i in range(count):
        # Each box up the stack is a little smaller and a little off-centre.
        # Perfectly aligned identical boxes read as one tall column, which is
        # the one thing a stack must not look like.
        shrink = 1.0 - taper * (i / max(1, count - 1) if count > 1 else 0.0)
        w = width * shrink
        d = depth * shrink
        offset = shift * (1 if i % 2 else -1) * (0 if i == 0 else 1)

        box(
            "crate-%02d" % i,
            (offset - w / 2.0, -d / 2.0, z),
            (offset + w / 2.0, d / 2.0, z + height),
            slot,
            top_slot=top_slot,
        )
        z += height
