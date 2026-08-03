import { describe, expect, it } from 'vitest';
import type { AnimationDocument, MotionSegment } from '../ui/src/types.ts';
import { motionDeletionBlocker, withoutMotionSegment } from '../ui/src/editor/lib.ts';

function segment(id: string, locked = false): MotionSegment {
  return {
    id,
    layerId: 'manual',
    actorId: 'alice',
    channel: 'part.transform',
    partId: 'torso',
    blend: 'additive',
    enabled: true,
    locked,
    easing: 'ease-in-out',
    path: { shape: 'smooth', curvature: 0.2 },
    assist: { anticipation: 0, overshoot: 0.08, hold: 0.08, recovery: 0.15 },
    source: 'drag',
    from: {
      id: `${id}:from`,
      time: { kind: 'absolute', ms: 1_000 },
      value: { rot: 0, x: 0, y: 0, scale: 1 },
      locked: false,
    },
    to: {
      id: `${id}:to`,
      time: { kind: 'absolute', ms: 1_500 },
      value: { rot: 4, x: 10, y: 0, scale: 1 },
      locked: false,
    },
    waypoints: [],
  };
}

function documentWith(...segments: MotionSegment[]): AnimationDocument {
  return {
    schemaVersion: 1,
    scene: 'test',
    revision: 4,
    layers: [{
      id: 'manual',
      name: 'Manual performance',
      ownership: 'manual',
      priority: 100,
      enabled: true,
      locked: false,
    }],
    tracks: [],
    segments,
    events: [],
  };
}

describe('timeline motion deletion', () => {
  it('removes exactly the selected segment', () => {
    const first = segment('motion-one');
    const second = segment('motion-two');
    const before = documentWith(first, second);

    const after = withoutMotionSegment(before, first.id);

    expect(after.segments).toEqual([second]);
    expect(after.layers).toBe(before.layers);
    expect(after.tracks).toBe(before.tracks);
    expect(after.events).toBe(before.events);
    expect(before.segments).toHaveLength(2);
  });

  it('requires locked layers, segments, and controls to be explicitly unlocked', () => {
    const lockedSegment = documentWith(segment('locked', true));
    expect(motionDeletionBlocker(lockedSegment, 'locked')).toMatch(/Unlock this motion/);
    expect(() => withoutMotionSegment(lockedSegment, 'locked')).toThrow(/Unlock this motion/);

    const lockedControl = documentWith(segment('control'));
    lockedControl.segments[0]!.from.locked = true;
    expect(motionDeletionBlocker(lockedControl, 'control')).toMatch(/Unlock motion control/);

    const lockedLayer = documentWith(segment('layer'));
    lockedLayer.layers[0]!.locked = true;
    expect(motionDeletionBlocker(lockedLayer, 'layer')).toMatch(/Unlock the Manual performance layer/);
  });
});
