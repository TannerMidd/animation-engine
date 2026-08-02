import { describe, expect, it } from 'vitest';
import { AnimationDocument, type TimeAnchor } from '../src/schema/animation.ts';
import {
  resolveAnimation,
  resolveTimeAnchor,
  sampleAnimation,
  type AnimationTimeline,
} from '../src/compile/animation.ts';
import {
  assertAnimationLocks,
  defaultAnimation,
  retimeAnimationForDialogue,
  retimeMotionEndpoint,
  retimeMotionSegment,
} from '../src/pipeline/animation.ts';
import { reducePuppeteeringSamples } from '../src/animation/recording.ts';
import { compileShotList } from '../src/compile/scene.ts';
import { ShotList } from '../src/schema/script.ts';
import { testRigs } from './helpers.ts';

const timeline: AnimationTimeline = {
  durationMs: 2_000,
  beats: [{
    id: 'line-one',
    startMs: 100,
    endMs: 1_100,
    speech: {
      startMs: 200,
      endMs: 900,
      words: [{ id: 'word-one', startMs: 300, endMs: 500 }],
    },
  }],
};

const generated = {
  id: 'generated', name: 'Generated', ownership: 'generated' as const,
  priority: 0, enabled: true, locked: false,
};
const manual = {
  id: 'manual', name: 'Manual', ownership: 'manual' as const,
  priority: 0, enabled: true, locked: false,
};

interface RootSegmentDraft {
  id: string;
  layerId: string;
  actorId: string;
  channel: 'root.position';
  blend: 'override';
  easing: 'linear';
  locked?: boolean;
  path: { shape: 'linear' | 'smooth' | 'arc'; curvature: number };
  assist: { anticipation: number; overshoot: number; hold: number; recovery: number };
  source: 'drag';
  from: { id: string; time: TimeAnchor; value: [number, number]; locked?: boolean };
  to: { id: string; time: TimeAnchor; value: [number, number]; locked?: boolean };
  waypoints: Array<{ id: string; at: number; value: [number, number]; locked?: boolean }>;
}

function rootSegment(id: string, startMs = 0, endMs = 1_000): RootSegmentDraft {
  return {
    id,
    layerId: 'manual',
    actorId: 'brent',
    channel: 'root.position' as const,
    blend: 'override' as const,
    easing: 'linear' as const,
    path: { shape: 'linear' as const, curvature: 0 },
    assist: { anticipation: 0, overshoot: 0, hold: 0, recovery: 0.15 },
    source: 'drag' as const,
    from: { id: `${id}:from`, time: { kind: 'absolute', ms: startMs }, value: [0, 0] },
    to: { id: `${id}:to`, time: { kind: 'absolute', ms: endMs }, value: [100, 0] },
    waypoints: [],
  };
}

function documentFor(segments: unknown[], tracks: unknown[] = [], scene = 'segment-test') {
  return AnimationDocument.parse({
    schemaVersion: 1,
    scene,
    layers: [generated, manual],
    tracks,
    segments,
    events: [],
  });
}

describe('motion segment schema and timing', () => {
  it('keeps pre-segment documents backward compatible', () => {
    const document = AnimationDocument.parse({
      schemaVersion: 1,
      scene: 'old-scene',
      layers: [manual],
      tracks: [],
      events: [],
    });
    expect(document.segments).toEqual([]);
    expect(defaultAnimation('new-scene').segments).toEqual([]);
  });

  it('resolves semantic endpoints while keeping waypoint placement normalized', () => {
    const segment = rootSegment('semantic');
    segment.from.time = {
      kind: 'word', beatId: 'line-one', wordId: 'word-one', edge: 'start', offsetMs: 10,
    };
    segment.to.time = {
      kind: 'beat', beatId: 'line-one', edge: 'end', offsetMs: -10,
    };
    segment.waypoints.push({ id: 'semantic:waypoint', at: 0.4, value: [40, 20] });

    const first = resolveAnimation(documentFor([segment]), timeline);
    const movedTimeline = structuredClone(timeline);
    movedTimeline.beats[0]!.speech!.words[0]!.startMs = 450;
    const second = resolveAnimation(documentFor([segment]), movedTimeline);

    expect(first.segments[0]).toMatchObject({ startMs: 310, endMs: 1_090 });
    expect(second.segments[0]).toMatchObject({ startMs: 460, endMs: 1_090 });
    expect(second.segments[0]!.segment.waypoints[0]!.at).toBe(0.4);
  });

  it('retimes endpoints and whole segments without baking semantic anchors', () => {
    const segment = rootSegment('retime');
    segment.from.time = {
      kind: 'speech', beatId: 'line-one', edge: 'start', offsetMs: 15,
    };
    segment.to.time = {
      kind: 'speech', beatId: 'line-one', edge: 'end', offsetMs: -20,
    };
    const document = documentFor([segment]);

    const shifted = retimeMotionSegment(document, 'retime', 25);
    expect(shifted.segments[0]!.from.time).toEqual({
      kind: 'speech', beatId: 'line-one', edge: 'start', offsetMs: 40,
    });
    expect(shifted.segments[0]!.to.time).toEqual({
      kind: 'speech', beatId: 'line-one', edge: 'end', offsetMs: 5,
    });

    const endpoint = retimeMotionEndpoint(shifted, 'retime', 'to', {
      kind: 'word', beatId: 'line-one', wordId: 'word-one', edge: 'end', offsetMs: 30,
    });
    expect(endpoint.segments[0]!.to.time).toEqual({
      kind: 'word', beatId: 'line-one', wordId: 'word-one', edge: 'end', offsetMs: 30,
    });
  });
});

describe('dialogue-driven animation retiming', () => {
  const expandedTimeline: AnimationTimeline = {
    durationMs: 2_500,
    beats: [{
      id: 'line-one',
      startMs: 100,
      endMs: 1_600,
      speech: {
        startMs: 300,
        endMs: 1_300,
        words: [{ id: 'word-one', startMs: 450, endMs: 700 }],
      },
    }],
  };

  it('proportionally retimes attached semantic and absolute motion when requested', () => {
    const segment = rootSegment('dialogue-retime', 300, 900);
    segment.from.time = {
      kind: 'word', beatId: 'line-one', wordId: 'word-one', edge: 'start', offsetMs: 0,
    };
    const document = documentFor([segment], [{
      id: 'attached-key', layerId: 'manual', actorId: 'brent', channel: 'root.scale',
      keys: [{
        id: 'attached-key-a',
        time: { kind: 'speech', beatId: 'line-one', edge: 'end', offsetMs: 0 },
        value: 1.1,
      }],
    }]);

    const retimed = retimeAnimationForDialogue(
      document, 'line-one', timeline, expandedTimeline, 'retime-attached-motion',
    );
    expect(resolveTimeAnchor(retimed.segments[0]!.from.time, expandedTimeline)).toBeCloseTo(400);
    expect(retimed.segments[0]!.to.time).toEqual({ kind: 'absolute', ms: 1_300 });
    expect(resolveTimeAnchor(retimed.tracks[0]!.keys[0]!.time, expandedTimeline)).toBeCloseTo(1_300);
  });

  it('bakes affected semantic anchors to their old picture time for preserve-absolute', () => {
    const segment = rootSegment('preserve-picture');
    segment.from.time = {
      kind: 'speech', beatId: 'line-one', edge: 'start', offsetMs: 25,
    };
    segment.to.time = {
      kind: 'word', beatId: 'line-one', wordId: 'word-one', edge: 'end', offsetMs: 15,
    };
    const retimed = retimeAnimationForDialogue(
      documentFor([segment]), 'line-one', timeline, expandedTimeline, 'preserve-absolute',
    );
    expect(retimed.segments[0]!.from.time).toEqual({ kind: 'absolute', ms: 225 });
    expect(retimed.segments[0]!.to.time).toEqual({ kind: 'absolute', ms: 515 });
  });

  it('refuses to move a locked attached control and leaves ripple documents untouched', () => {
    const segment = rootSegment('locked-dialogue');
    segment.from.time = { kind: 'beat', beatId: 'line-one', edge: 'start', offsetMs: 10 };
    segment.from.locked = true;
    const document = documentFor([segment]);
    expect(() => retimeAnimationForDialogue(
      document, 'line-one', timeline, expandedTimeline, 'retime-attached-motion',
    )).toThrow(/locked motion segment/);
    expect(retimeAnimationForDialogue(document, 'line-one', timeline, expandedTimeline, 'ripple')).toBe(document);
  });
});

describe('motion path and assist compilation', () => {
  it('samples arcs and smooth waypoint paths deterministically', () => {
    const arc = rootSegment('arc');
    arc.path = { shape: 'arc', curvature: 0.5 };
    const arcMid = sampleAnimation(resolveAnimation(documentFor([arc]), timeline), 500).brent!;
    expect(arcMid.x).toBeCloseTo(50);
    expect(arcMid.y).toBeCloseTo(50);

    const smooth = rootSegment('smooth');
    smooth.path = { shape: 'smooth', curvature: 0 };
    smooth.waypoints.push({ id: 'smooth:waypoint', at: 0.5, value: [50, 80] });
    const smoothMid = sampleAnimation(resolveAnimation(documentFor([smooth]), timeline), 500).brent!;
    expect(smoothMid).toMatchObject({ x: 50, y: 80 });
  });

  it('compiles anticipation, overshoot, recovery and final hold without baking keys', () => {
    const segment = rootSegment('assisted');
    segment.from.value = [100, 100];
    segment.to.value = [200, 100];
    segment.assist = { anticipation: 0.2, overshoot: 0.2, hold: 0.1, recovery: 0.2 };
    const resolved = resolveAnimation(documentFor([segment]), timeline);

    expect(sampleAnimation(resolved, 50).brent!.x).toBeLessThan(100);
    expect(sampleAnimation(resolved, 750).brent!.x).toBeGreaterThan(200);
    expect(sampleAnimation(resolved, 950).brent!.x).toBe(200);
    expect(resolved.document.segments[0]!.waypoints).toEqual([]);
  });

  it('keeps manual segments above generated tracks and selects sequential segments by start', () => {
    const first = rootSegment('first', 0, 500);
    const second = rootSegment('second', 500, 1_000);
    second.from.value = [100, 0];
    second.to.value = [200, 0];
    const generatedTrack = {
      id: 'generated-root', layerId: 'generated', actorId: 'brent', channel: 'root.position',
      keys: [{ id: 'generated-root:key', time: { kind: 'absolute', ms: 0 }, value: [999, 999] }],
    };
    const resolved = resolveAnimation(documentFor([first, second], [generatedTrack]), timeline);

    expect(sampleAnimation(resolved, 250).brent).toMatchObject({ x: 50, y: 0 });
    expect(sampleAnimation(resolved, 750).brent).toMatchObject({ x: 150, y: 0 });
    expect(sampleAnimation(resolved, 1_200).brent).toMatchObject({ x: 200, y: 0 });
  });

  it('rejects overlapping segments on one layer and target', () => {
    expect(() => resolveAnimation(documentFor([
      rootSegment('one', 0, 700),
      rootSegment('two', 500, 900),
    ]), timeline)).toThrow(/motion segments .* overlap/);
  });
});

describe('motion locks and puppeteering reduction', () => {
  it('requires explicit unlocks for segments and individual controls', () => {
    const lockedSegment = rootSegment('locked-segment');
    lockedSegment.locked = true;
    const before = documentFor([lockedSegment]);
    const edited = structuredClone(before);
    edited.segments[0]!.path.curvature = 0.5;
    expect(() => assertAnimationLocks(before, edited)).toThrow(/must be unlocked/);

    const unlocked = structuredClone(before);
    unlocked.segments[0]!.locked = false;
    expect(() => assertAnimationLocks(before, unlocked)).not.toThrow();

    const controlSegment = rootSegment('locked-control');
    controlSegment.waypoints.push({
      id: 'locked-control:waypoint', at: 0.5, value: [50, 10], locked: true,
    });
    const controlBefore = documentFor([controlSegment]);
    const controlEdited = structuredClone(controlBefore);
    const candidate = controlEdited.segments[0]!;
    if (candidate.channel !== 'root.position') throw new Error('test invariant');
    candidate.waypoints[0]!.value = [55, 10];
    expect(() => assertAnimationLocks(controlBefore, controlEdited)).toThrow(/motion control/);
  });

  it('smooths and reduces recordings deterministically while preserving endpoints', () => {
    const input = Array.from({ length: 21 }, (_, frame) => ({
      frame,
      value: [frame * 5, frame % 2 === 0 ? 0 : 0.4] as [number, number],
    }));
    const first = reducePuppeteeringSamples(input);
    const second = reducePuppeteeringSamples(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.length).toBeLessThan(input.length);
    expect(first[0]).toEqual(input[0]);
    expect(first.at(-1)).toEqual(input.at(-1));

    const sharedFrame = reducePuppeteeringSamples([
      { frame: 0, value: [0, 0] },
      { frame: 1, value: [10, 0] },
      { frame: 1, value: [10, 8] },
      { frame: 2, value: [20, 0] },
    ], { smoothingPasses: 0, tolerance: 0 });
    expect(sharedFrame).toContainEqual({ frame: 1, value: [10, 8] });
  });
});

describe('scene integration validation', () => {
  function shots() {
    return ShotList.parse({
      scene: 'segment-scene',
      cards: false,
      width: 1_280,
      height: 720,
      fps: 24,
      characterFps: 12,
      cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER', resting: 'DEADPAN' }],
      beats: [{
        id: 'pause', kind: 'pause', ms: 1_000, reactions: {}, shot: 'MID',
        focus: ['brent'], camera: 'HOLD',
      }],
    });
  }

  it('applies a document containing only motion segments to the compiled scene', () => {
    const segment = rootSegment('scene-root');
    segment.from.value = [100, 700];
    segment.to.value = [300, 700];
    const compiled = compileShotList(shots(), testRigs(['brent']), new Map(), documentFor([segment], [], 'segment-scene'));
    expect(compiled.ir.frames[12]!.actors.brent).toMatchObject({ x: 200, y: 700 });
  });

  it('rejects off-stage root paths and unreachable part controls', () => {
    const offStage = rootSegment('off-stage');
    offStage.from.value = [-1, 100];
    expect(() => compileShotList(
      shots(), testRigs(['brent']), new Map(), documentFor([offStage], [], 'segment-scene'),
    )).toThrow(/leaves the authored stage/);

    const curvedOffStage = rootSegment('curved-off-stage');
    curvedOffStage.from.value = [100, 10];
    curvedOffStage.to.value = [200, 10];
    curvedOffStage.path = { shape: 'arc', curvature: -1 };
    expect(() => compileShotList(
      shots(), testRigs(['brent']), new Map(), documentFor([curvedOffStage], [], 'segment-scene'),
    )).toThrow(/leaves the authored stage/);

    const unreachable = {
      id: 'unreachable-head', layerId: 'manual', actorId: 'brent', channel: 'part.transform', partId: 'head',
      from: { id: 'unreachable-head:from', time: { kind: 'absolute', ms: 0 }, value: { rot: 0, x: 60, y: 0, scale: 1 } },
      to: { id: 'unreachable-head:to', time: { kind: 'absolute', ms: 1_000 }, value: { rot: 0, x: 0, y: 0, scale: 1 } },
      waypoints: [],
    };
    expect(() => compileShotList(
      shots(), testRigs(['brent']), new Map(), documentFor([unreachable], [], 'segment-scene'),
    )).toThrow(/exceeds head reach/);

    const assistedReach = {
      ...unreachable,
      id: 'assisted-head',
      partId: 'torso',
      from: { ...unreachable.from, id: 'assisted-head:from', value: { rot: 0, x: 80, y: 0, scale: 1 } },
      to: { ...unreachable.to, id: 'assisted-head:to', value: { rot: 0, x: 110, y: 0, scale: 1 } },
      assist: { anticipation: 0, overshoot: 0.5, hold: 0, recovery: 0.2 },
    };
    expect(() => compileShotList(
      shots(), testRigs(['brent']), new Map(), documentFor([assistedReach], [], 'segment-scene'),
    )).toThrow(/exceeds torso reach/);
  });
});
