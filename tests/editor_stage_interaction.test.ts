import { describe, expect, it } from 'vitest';
import type { SetDescriptor } from '../ui/src/types.ts';
import {
  clientToWorld,
  stageToWorld,
  worldPerCssPx,
  worldToOverlay,
  type CameraRect,
  type FrameGeom,
} from '../ui/src/editor/stage/coords.ts';
import {
  actorIdFromDom,
  actorLocalToWorld,
  availableControllers,
  buildSnapCandidates,
  clampToArea,
  controllerForPart,
  controllerLocalPoint,
  controllerPartIds,
  dragTargetTo,
  listPropTargets,
  partIdFromDom,
  partMaxReach,
  partOffsetTo,
  propInstanceId,
  snapPoint,
  solveArm,
  worldToActorLocal,
  type ControllerId,
  type RuntimeRigData,
} from '../ui/src/editor/stage/interaction.ts';

const FULL_CAM: CameraRect = { x: 0, y: 0, w: 1280, h: 720 };
const CROP_CAM: CameraRect = { x: 200, y: 100, w: 640, h: 360 };

describe('stage coordinates', () => {
  const geoms: FrameGeom[] = [
    { width: 1280, height: 720, scale: 0.62 },   // typical fit
    { width: 1280, height: 720, scale: 1.5625 }, // zoomed in
    { width: 720, height: 1280, scale: 0.4 },    // 9:16 publish layout
  ];

  it('round-trips client → world → overlay at any zoom, camera and aspect', () => {
    for (const g of geoms) {
      for (const cam of [FULL_CAM, CROP_CAM]) {
        const frame = { left: 137.5, top: 42.25 };
        for (const client of [[137.5, 42.25], [300.4, 250.9], [137.5 + g.width * g.scale, 42.25 + g.height * g.scale]] as const) {
          const world = clientToWorld(cam, g, frame.left, frame.top, client[0], client[1]);
          const overlay = worldToOverlay(cam, g, world);
          expect(overlay[0] + frame.left).toBeCloseTo(client[0], 6);
          expect(overlay[1] + frame.top).toBeCloseTo(client[1], 6);
        }
      }
    }
  });

  it('maps stage corners through a cropped camera', () => {
    const g: FrameGeom = { width: 1280, height: 720, scale: 1 };
    expect(stageToWorld(CROP_CAM, g, [0, 0])).toEqual([200, 100]);
    expect(stageToWorld(CROP_CAM, g, [1280, 720])).toEqual([840, 460]);
    expect(stageToWorld(CROP_CAM, g, [640, 360])).toEqual([520, 280]);
  });

  it('converts a CSS-pixel threshold into world units', () => {
    expect(worldPerCssPx(FULL_CAM, { width: 1280, height: 720, scale: 0.5 })).toBeCloseTo(2, 9);
    expect(worldPerCssPx(CROP_CAM, { width: 1280, height: 720, scale: 1 })).toBeCloseTo(0.5, 9);
  });
});

describe('DOM id mapping', () => {
  it('extracts actor and part ids from namespaced DOM ids', () => {
    expect(actorIdFromDom('actor-bob')).toBe('bob');
    expect(actorIdFromDom('set-prop-desk')).toBeNull();
    expect(partIdFromDom('bob__arm_L_fore', 'bob')).toBe('arm_L_fore');
    expect(partIdFromDom('bob__head', 'alice')).toBeNull();
    expect(partIdFromDom('shadow', 'bob')).toBeNull();
  });
});

describe('controllers', () => {
  const FULL = new Set(['torso', 'head', 'leg_L', 'leg_R', 'arm_L_upper', 'arm_L_fore', 'arm_R_upper', 'arm_R_fore']);

  it('offers exactly the controllers the rig supports', () => {
    expect(availableControllers(FULL)).toEqual(['body', 'head', 'torso', 'wrist_L', 'wrist_R']);
    expect(availableControllers(new Set(['torso', 'arm_L_upper']))).toEqual(['body', 'torso']);
    expect(availableControllers(new Set())).toEqual(['body']);
  });

  it('maps picture hits to controllers, degrading to body', () => {
    const available = new Set<ControllerId>(availableControllers(FULL));
    expect(controllerForPart('arm_L_fore', available)).toBe('wrist_L');
    expect(controllerForPart('arm_R_upper', available)).toBe('wrist_R');
    expect(controllerForPart('head', available)).toBe('head');
    expect(controllerForPart('torso', available)).toBe('torso');
    expect(controllerForPart('leg_L', available)).toBe('body');
    expect(controllerForPart(null, available)).toBe('body');
    const armless = new Set<ControllerId>(['body', 'head']);
    expect(controllerForPart('arm_L_fore', armless)).toBe('body');
    expect(controllerForPart('torso', armless)).toBe('body');
  });

  it('lists the rig parts each controller drives', () => {
    expect(controllerPartIds('wrist_L')).toEqual(['arm_L_upper', 'arm_L_fore']);
    expect(controllerPartIds('body')).toEqual([]);
    expect(controllerPartIds('head')).toEqual(['head']);
  });
});

const RIG: RuntimeRigData = {
  anchor: [100, 400],
  parts: [
    { id: 'torso', pivot: [100, 266.4] },
    { id: 'head', pivot: [100, 95.8] },
    { id: 'arm_L_upper', pivot: [58.1, 119.8] },
    { id: 'arm_L_fore', pivot: [58.1, 178.6] },
  ],
};

describe('forward kinematics', () => {
  it('places the body controller at the anchor', () => {
    expect(controllerLocalPoint('body', RIG, {})).toEqual([100, 400]);
  });

  it('applies authored offsets to simple parts', () => {
    expect(controllerLocalPoint('head', RIG, { head: [12, 5, -3, 1] })).toEqual([105, 92.8]);
    expect(controllerLocalPoint('torso', RIG, {})).toEqual([100, 266.4]);
  });

  it('chains the wrist through both arm segments', () => {
    const straight = controllerLocalPoint('wrist_L', RIG, {})!;
    expect(straight[0]).toBeCloseTo(58.1, 6);
    expect(straight[1]).toBeCloseTo(119.8 + 58.8 * 1.92, 6);
    const bent = controllerLocalPoint('wrist_L', RIG, {
      arm_L_upper: [90, 0, 0, 1],
      arm_L_fore: [0, 0, 0, 1],
    })!;
    expect(bent[0]).toBeCloseTo(58.1 - 58.8 * 1.92, 6);
    expect(bent[1]).toBeCloseTo(119.8, 6);
    expect(controllerLocalPoint('wrist_R', RIG, {})).toBeNull();
  });

  it('round-trips actor local ↔ world, including flipped actors', () => {
    for (const actor of [
      { x: 640, y: 500, scale: 1.2, flip: false },
      { x: 200, y: 480, scale: 0.9, flip: true },
    ]) {
      const local: [number, number] = [58.1, 178.6];
      const world = actorLocalToWorld(local, actor, RIG.anchor);
      const back = worldToActorLocal(world, actor, RIG.anchor);
      expect(back[0]).toBeCloseTo(local[0], 9);
      expect(back[1]).toBeCloseTo(local[1], 9);
    }
  });
});

describe('solveArm', () => {
  const shoulder: [number, number] = [58.1, 119.8];
  const elbow: [number, number] = [58.1, 178.6];
  const upperLength = 58.8;

  const fkOf = (upper: number, fore: number): [number, number] =>
    controllerLocalPoint('wrist_L', RIG, {
      arm_L_upper: [upper, 0, 0, 1],
      arm_L_fore: [fore, 0, 0, 1],
    })!;

  it('reaches an in-range target exactly (FK ∘ IK = target)', () => {
    const target: [number, number] = [95, 160];
    const solved = solveArm(shoulder, elbow, target, 0, 0);
    expect(solved.clampedTarget[0]).toBeCloseTo(target[0], 6);
    expect(solved.clampedTarget[1]).toBeCloseTo(target[1], 6);
    const wrist = fkOf(solved.upper, solved.fore);
    expect(wrist[0]).toBeCloseTo(target[0], 4);
    expect(wrist[1]).toBeCloseTo(target[1], 4);
  });

  it('clamps an unreachable target onto the reach circle', () => {
    const solved = solveArm(shoulder, elbow, [shoulder[0], shoulder[1] + 500], 0, 0);
    const reach = Math.hypot(
      solved.clampedTarget[0] - shoulder[0],
      solved.clampedTarget[1] - shoulder[1],
    );
    expect(reach).toBeCloseTo(upperLength * 1.92 - 1, 6);
    const wrist = fkOf(solved.upper, solved.fore);
    expect(wrist[0]).toBeCloseTo(solved.clampedTarget[0], 4);
    expect(wrist[1]).toBeCloseTo(solved.clampedTarget[1], 4);
  });

  it('prefers the elbow branch nearest the current pose', () => {
    const target: [number, number] = [95, 160];
    const a = solveArm(shoulder, elbow, target, 0, 120);
    const b = solveArm(shoulder, elbow, target, 0, -120);
    expect(a.fore).toBeGreaterThan(0);
    expect(b.fore).toBeLessThan(0);
  });

  it('handles a target on the shoulder without dividing by zero', () => {
    const solved = solveArm(shoulder, elbow, shoulder, 0, 0);
    expect(Number.isFinite(solved.upper)).toBe(true);
    expect(Number.isFinite(solved.fore)).toBe(true);
  });
});

describe('drag math', () => {
  it('preserves the grab offset instead of teleporting the anchor', () => {
    const to = dragTargetTo([640, 500], [660, 430], [700, 460]);
    expect(to).toEqual([680, 530]);
  });

  it('clamps to the walkable area with 0.1 rounding', () => {
    const area = { x: 100, y: 380, width: 1080, height: 160 };
    expect(clampToArea([50, 600], area)).toEqual([100, 540]);
    expect(clampToArea([640.16, 500.04], area)).toEqual([640.2, 500]);
  });

  it('clamps part offsets to their reach', () => {
    expect(partMaxReach('head')).toBe(48);
    expect(partMaxReach('torso')).toBe(120);
    const inside = partOffsetTo([0, 0], [100, 95.8], [110, 90], 48);
    expect(inside).toEqual([10, -5.8]);
    const clamped = partOffsetTo([0, 0], [100, 95.8], [100 + 500, 95.8], 48);
    expect(clamped[0]).toBeCloseTo(48, 6);
    expect(clamped[1]).toBeCloseTo(0, 6);
  });
});

const SET: SetDescriptor = {
  name: 'office',
  palette: 'office',
  layout: {
    horizonY: 430,
    ceilingY: 60,
    marginX: 40,
    marginY: 20,
    walkable: { x: 100, y: 380, width: 1080, height: 160 },
    parallax: { back: { x: 1, y: 1 }, mid: { x: 1, y: 1 }, fore: { x: 1, y: 1 } },
  },
  layers: {
    back: [
      { prop: 'window', scale: 1, flip: false, params: {} },                     // no x/y — not draggable
      { id: 'desk-a', prop: 'desk', x: 400, y: 470, scale: 1, flip: false, params: {} },
    ],
    mid: [
      { prop: 'plant', x: 1120, y: 480, scale: 1, flip: false, params: {} },
      { prop: 'lamp', x: 640, y: 40, scale: 1, flip: false, params: {} },        // above walkable
    ],
    fore: [],
  },
};

describe('snapping', () => {
  it('builds mark, seat and edge candidates inside the walkable area', () => {
    const candidates = buildSnapCandidates(1280, SET, SET.layout.walkable);
    const marks = candidates.filter((c) => c.kind === 'mark');
    expect(marks.map((c) => c.id)).toEqual(['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R']);
    expect(marks.find((c) => c.id === 'CENTER')?.x).toBe(640);
    const seats = candidates.filter((c) => c.kind === 'seat');
    expect(seats.map((c) => c.id)).toEqual(['desk-a', 'auto:mid:0:plant']);
    expect(candidates.filter((c) => c.kind === 'edge')).toHaveLength(4);
  });

  it('drops marks that fall outside a narrow walkable area', () => {
    const narrow = { x: 300, y: 380, width: 500, height: 160 };
    const candidates = buildSnapCandidates(1280, null, narrow);
    expect(candidates.filter((c) => c.kind === 'mark').map((c) => c.id)).toEqual(['SL', 'CENTER']);
  });

  it('snaps x to a mark while preserving y', () => {
    const candidates = buildSnapCandidates(1280, null, null);
    const { point, hits } = snapPoint([648, 512], candidates, 12);
    expect(point).toEqual([640, 512]);
    expect(hits.map((h) => h.id)).toEqual(['CENTER']);
  });

  it('prefers a whole seat over an axis snap when it is nearer', () => {
    const candidates = buildSnapCandidates(1280, SET, SET.layout.walkable);
    const { point, hits } = snapPoint([403, 473], candidates, 12);
    expect(point).toEqual([400, 470]);
    expect(hits.map((h) => h.kind)).toEqual(['seat']);
  });

  it('combines independent x and y snaps and respects the threshold', () => {
    const walkable = { x: 100, y: 380, width: 1080, height: 160 };
    const candidates = buildSnapCandidates(1280, null, walkable);
    const corner = snapPoint([645, 536], candidates, 12);
    expect(corner.point).toEqual([640, 540]);
    expect(corner.hits.map((h) => h.id)).toEqual(['CENTER', 'walkable-bottom']);
    const far = snapPoint([700, 450], candidates, 12);
    expect(far.point).toEqual([700, 450]);
    expect(far.hits).toEqual([]);
  });
});

describe('prop targets', () => {
  it('mirrors the renderer identity rule', () => {
    expect(propInstanceId({ id: 'desk-a', prop: 'desk', scale: 1, flip: false, params: {} }, 'back', 1)).toBe('desk-a');
    expect(propInstanceId({ prop: 'coffee mug', scale: 1, flip: false, params: {} }, 'mid', 0)).toBe('auto:mid:0:coffee-mug');
  });

  it('lists only instances with an authored position', () => {
    const targets = listPropTargets(SET);
    expect(targets.map((t) => t.id)).toEqual(['desk-a', 'auto:mid:0:plant', 'auto:mid:1:lamp']);
    expect(targets[0]).toMatchObject({ layer: 'back', index: 1, prop: 'desk', x: 400, y: 470 });
  });
});
