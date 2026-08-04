"""A room with real perspective, for the prop foundry.

Every set the engine has drawn so far is a flat elevation: the wall is a
rectangle, the floor a horizontal band, and depth is implied only by what
overlaps what. This builds an actual box and lets the bake project it, so the
floor recedes, the side walls converge and the ceiling reads as above you.

It is baked in one-point perspective on purpose, and the worker refuses anything
else for a spanning prop. The engine has no ground-plane depth model -- actors
stand at one height whatever their x -- so a two-point room would imply staging
the engine cannot do, and correct blocking would look wrong against a correct
room.
"""

BOX_FACES = [
    (0, 3, 2, 1),
    (4, 5, 6, 7),
    (0, 1, 5, 4),
    (1, 2, 6, 5),
    (2, 3, 7, 6),
    (3, 0, 4, 7),
]


def material(name):
    existing = bpy.data.materials.get(name)
    return existing if existing else bpy.data.materials.new(name)


def quad(name, corners, slot):
    """One flat panel. Rooms are made of these, not of solids."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(list(corners), [], [(0, 1, 2, 3)])
    mesh.update()
    mesh.materials.append(material(slot))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box(name, lo, hi, slot):
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
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(params):
    width = float(params.get("width", 9.0))
    depth = float(params.get("depth", 7.0))
    height = float(params.get("height", 3.2))
    half = width / 2.0

    # Normals face into the room, because that is where the camera is. The
    # back-face cull then keeps exactly the surfaces you can see and drops the
    # two side walls behind the camera without any special-casing.
    quad("wall-back", [
        (-half, depth, 0.0), (half, depth, 0.0), (half, depth, height), (-half, depth, height),
    ], "wall.edge")

    quad("floor", [
        (-half, 0.0, 0.0), (half, 0.0, 0.0), (half, depth, 0.0), (-half, depth, 0.0),
    ], "floor.edge")

    quad("ceiling", [
        (-half, depth, height), (half, depth, height), (half, 0.0, height), (-half, 0.0, height),
    ], "ceiling.edge")

    quad("wall-left", [
        (-half, 0.0, 0.0), (-half, depth, 0.0), (-half, depth, height), (-half, 0.0, height),
    ], "wallLower")

    quad("wall-right", [
        (half, depth, 0.0), (half, 0.0, 0.0), (half, 0.0, height), (half, depth, height),
    ], "wallLower")

    # A skirting rail along the back wall. One thin box, and it gives the wall a
    # base instead of dissolving into the floor.
    box("skirting", (-half, depth - 0.06, 0.0), (half, depth, 0.22), "wallTrim")

    # Two ceiling panels. Their converging edges are most of what tells you the
    # ceiling is above you rather than behind you.
    if params.get("ceiling_panels", True):
        for i, y in enumerate((depth * 0.34, depth * 0.68)):
            box(
                "panel-%d" % i,
                (-width * 0.22, y - 0.28, height - 0.06),
                (width * 0.22, y + 0.28, height),
                "light.noink",
            )
