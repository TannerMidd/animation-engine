import { describe, expect, it } from 'vitest';
import { compileShotList } from '../src/compile/scene.ts';
import { AnimationDocument } from '../src/schema/animation.ts';
import { ShotList } from '../src/schema/script.ts';
import { testRigs } from './helpers.ts';

const manual = {
  id: 'manual', name: 'Manual', ownership: 'manual' as const,
  priority: 0, enabled: true, locked: false,
};

/** A character crossing the stage under an authored motion phrase, and nothing else. */
function crossing(over: Record<string, unknown> = {}, to: [number, number] = [900, 700]) {
  return AnimationDocument.parse({
    schemaVersion: 1,
    scene: 'walk-scene',
    layers: [manual],
    tracks: [],
    events: [],
    segments: [{
      id: 'cross',
      layerId: 'manual',
      actorId: 'brent',
      channel: 'root.position',
      blend: 'override',
      easing: 'linear',
      path: { shape: 'linear', curvature: 0 },
      assist: { anticipation: 0, overshoot: 0, hold: 0, recovery: 0.15 },
      source: 'drag',
      from: { id: 'cross:from', time: { kind: 'absolute', ms: 0 }, value: [300, 700] },
      to: { id: 'cross:to', time: { kind: 'absolute', ms: 2_000 }, value: to },
      waypoints: [],
      ...over,
    }],
  });
}

function shots(pauseMs = 3_000) {
  return ShotList.parse({
    scene: 'walk-scene',
    cards: false,
    width: 1_280,
    height: 720,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER', resting: 'DEADPAN' }],
    beats: [{
      id: 'pause', kind: 'pause', ms: pauseMs, reactions: {}, shot: 'WIDE',
      focus: ['brent'], camera: 'HOLD',
    }],
  });
}

/** The same journey, asked for by the director instead of by a drag. */
function stagedCrossing(toX: number, ms = 2_000) {
  return ShotList.parse({
    scene: 'walk-scene',
    cards: false,
    width: 1_280,
    height: 720,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER', resting: 'DEADPAN' }],
    beats: [{
      id: 'cross', kind: 'action', text: 'Brent crosses the room.', ms,
      stage: [{ type: 'move', actor: 'brent', to: { x: toX } }],
      reactions: {}, shot: 'WIDE', focus: ['brent'], camera: 'HOLD',
    }],
  });
}

/** An IR part transform is [rot, x, y, scale]. */
const ROT = 0;

/** Leg rotations across the whole scene, one per compiled frame. */
function legSwing(document: ReturnType<typeof crossing> | null, pauseMs = 3_000): number[] {
  const { ir } = compileShotList(shots(pauseMs), testRigs(['brent']), new Map(), document);
  return ir.frames.map((frame) => frame.actors['brent']?.parts?.['leg_L']?.[ROT] ?? 0);
}

/** The same, for a walk the director staged rather than one someone dragged. */
function stagedLegSwing(toX: number, ms = 2_000): number[] {
  const { ir } = compileShotList(stagedCrossing(toX, ms), testRigs(['brent']), new Map(), null);
  return ir.frames.map((frame) => frame.actors['brent']?.parts?.['leg_L']?.[ROT] ?? 0);
}

/** Where the puppet's root has reached, one per compiled frame. */
function rootX(document: ReturnType<typeof crossing>, pauseMs = 3_000): number[] {
  const { ir } = compileShotList(shots(pauseMs), testRigs(['brent']), new Map(), document);
  return ir.frames.map((frame) => frame.actors['brent']?.x ?? 0);
}

/** Sign changes in the leg swing — two per completed stride. */
function zeroCrossings(swing: number[]): number {
  return swing.reduce(
    (count, rot, i) => (i > 0 && Math.sign(rot) !== Math.sign(swing[i - 1]!) ? count + 1 : count),
    0,
  );
}

describe('walking an authored root move', () => {
  it('swings the legs while the character crosses, and rests them at both ends', () => {
    const swing = legSwing(crossing());
    const moving = swing.filter((rot) => Math.abs(rot) > 1);

    expect(moving.length).toBeGreaterThan(4);
    // A stride is a cycle, not a lean: the legs must pass through both extremes.
    expect(Math.max(...swing)).toBeGreaterThan(5);
    expect(Math.min(...swing)).toBeLessThan(-5);
    // Standing still at the end of the phrase.
    expect(Math.abs(swing[swing.length - 1]!)).toBeLessThan(1);
  });

  it('mirrors the legs, so the puppet is never mid-stride on both sides at once', () => {
    const { ir } = compileShotList(shots(), testRigs(['brent']), new Map(), crossing());
    const mid = ir.frames[Math.floor(ir.frames.length / 4)]!.actors['brent']!;
    const left = mid.parts?.['leg_L']?.[ROT] ?? 0;
    const right = mid.parts?.['leg_R']?.[ROT] ?? 0;
    expect(Math.abs(left)).toBeGreaterThan(1);
    expect(right).toBeCloseTo(-left, 6);
  });

  it('takes more steps over a longer crossing, so the feet do not skate', () => {
    const short = zeroCrossings(legSwing(crossing({}, [500, 700])));
    const long = zeroCrossings(legSwing(crossing({}, [1_100, 700])));
    expect(long).toBeGreaterThan(short);
  });

  it('leaves a nudge onto a mark alone', () => {
    // Twenty pixels is an adjustment, not a journey.
    expect(legSwing(crossing({}, [320, 700])).every((rot) => Math.abs(rot) < 1)).toBe(true);
  });

  /**
   * The shape of an actual drag.
   *
   * A creator nudging someone a little way across the stage covers far less
   * ground than a scripted crossing, and this is the case that shipped broken:
   * phase taken straight from ground covered swung the legs a few degrees out
   * and left them there, which reads as a lean and looks like nothing at all.
   */
  it('takes one whole step over a move shorter than a single stride', () => {
    const swing = legSwing(crossing({}, [334, 700]));
    const peak = Math.max(...swing.map(Math.abs));

    expect(peak).toBeGreaterThan(10);
    // Out and back: a step that ends mid-swing snaps the feet together.
    expect(Math.max(...swing)).toBeGreaterThan(10);
    expect(Math.min(...swing)).toBeLessThan(-10);
  });

  it('starts and ends standing at every distance, so no walk snaps shut', () => {
    for (const x of [330, 360, 420, 600, 900, 1_180]) {
      const swing = legSwing(crossing({}, [x, 700]));
      expect(Math.abs(swing[0]!)).toBeLessThan(1);
      expect(Math.abs(swing[swing.length - 1]!)).toBeLessThan(1);
      expect(Math.max(...swing.map(Math.abs))).toBeGreaterThan(10);
    }
  });

  it('honours a phrase that asks not to walk, and one that insists', () => {
    expect(legSwing(crossing({ gait: 'none' })).every((rot) => Math.abs(rot) < 1)).toBe(true);
    expect(legSwing(crossing({ gait: 'walk' }, [320, 700])).some((rot) => Math.abs(rot) > 1)).toBe(true);
  });

  it('stays byte-identical across compiles, like everything else here', () => {
    expect(legSwing(crossing())).toEqual(legSwing(crossing()));
  });

  it('does not walk a character who is not being moved', () => {
    expect(legSwing(null).every((rot) => Math.abs(rot) < 1)).toBe(true);
  });

  /**
   * A drag is committed with the duration of the gesture that made it, so the
   * same puppet crossed at 191 px/s one time and 1071 px/s the next. Pace is a
   * property of walking rather than of the mouse, so the engine sets it.
   */
  it('walks a hurried drag at the engine pace rather than the mouse pace', () => {
    // 570 units in 300ms is 1900 px/s. At a walk it is three seconds.
    const hurried = crossing({
      to: { id: 'cross:to', time: { kind: 'absolute', ms: 300 }, value: [870, 700] },
    });
    const x = rootX(hurried, 8_000);
    const arrivedFrame = x.findIndex((value) => value >= 869.5);

    expect(arrivedFrame).toBeGreaterThan(0);
    expect((arrivedFrame / 24) * 1_000).toBeGreaterThan(2_500);
    // Still arrives, and stays put once it has.
    expect(x[x.length - 1]).toBeCloseTo(870, 1);
  });

  it('leaves a phrase that opted out of walking on its authored timing', () => {
    const carried = crossing({
      gait: 'none',
      to: { id: 'cross:to', time: { kind: 'absolute', ms: 300 }, value: [870, 700] },
    });
    const x = rootX(carried, 8_000);
    const arrivedFrame = x.findIndex((value) => value >= 869.5);

    expect(arrivedFrame).toBeGreaterThan(0);
    expect((arrivedFrame / 24) * 1_000).toBeLessThan(500);
  });

  /**
   * The invariant `stridePose` claims: staging "he crosses to the window" and
   * dragging him there are the same event, and a puppet that walked differently
   * depending on which route produced the move is a bug with two faces. Staged
   * moves used to step exactly twice however far they went.
   */
  it('takes the same strides whether the walk was staged or dragged', () => {
    // Both cover 570 units — CENTER (640) to 1210, and 300 to 870.
    const staged = zeroCrossings(stagedLegSwing(1_210));
    const dragged = zeroCrossings(legSwing(crossing({}, [870, 700]), 8_000));

    expect(staged).toBeGreaterThan(2);
    expect(Math.abs(staged - dragged)).toBeLessThanOrEqual(1);
  });
});
