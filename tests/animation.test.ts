import fs from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { AnimationDocument, type AnimationTrackInput } from '../src/schema/animation.ts';
import {
  resolveAnimation,
  resolveTimeAnchor,
  sampleAnimation,
  sampleAnimationFrames,
  type AnimationTimeline,
} from '../src/compile/animation.ts';
import { assertAnimationLocks, defaultAnimation, writeAnimation } from '../src/pipeline/animation.ts';
import { compileShotList, cardTiming } from '../src/compile/scene.ts';
import { buildPreview } from '../src/pipeline/preview.ts';
import { ShotList } from '../src/schema/script.ts';
import { sceneDir } from '../src/core/paths.ts';
import type { LineTiming } from '../src/voice/visemes.ts';
import { testRigs } from './helpers.ts';

const timeline: AnimationTimeline = {
  durationMs: 2_000,
  beats: [
    {
      id: 'beat-one',
      startMs: 100,
      endMs: 1_100,
      speech: {
        startMs: 200,
        endMs: 900,
        words: [
          { id: 'word-hello', text: 'Hello', startMs: 250, endMs: 430 },
          { id: 'word-there', text: 'there', startMs: 500, endMs: 720 },
        ],
      },
    },
    { id: 'beat-two', startMs: 1_100, endMs: 2_000 },
  ],
};

const generated = {
  id: 'generated', name: 'Generated', ownership: 'generated' as const,
  priority: 0, enabled: true, locked: false,
};
const manual = {
  id: 'manual', name: 'Manual', ownership: 'manual' as const,
  priority: 0, enabled: true, locked: false,
};

function documentFor(tracks: AnimationTrackInput[], layers = [generated, manual]) {
  return AnimationDocument.parse({
    schemaVersion: 1,
    scene: 'animation-test',
    layers,
    tracks,
    events: [],
  });
}

describe('animation locks', () => {
  it('requires a locked track to be unlocked in a separate edit', () => {
    const before = documentFor([{
      id: 'locked-move', layerId: 'manual', actorId: 'brent', channel: 'root.position', locked: true,
      keys: [{ id: 'a', time: { kind: 'absolute', ms: 0 }, value: [10, 20] }],
    }]);
    const edited = structuredClone(before);
    (edited.tracks[0]!.keys[0]!.value as [number, number])[0] = 99;
    expect(() => assertAnimationLocks(before, edited)).toThrow(/must be unlocked/);

    const unlocked = structuredClone(before);
    unlocked.tracks[0]!.locked = false;
    expect(() => assertAnimationLocks(before, unlocked)).not.toThrow();
  });

  it('protects individually locked keys on otherwise editable tracks', () => {
    const before = documentFor([{
      id: 'move', layerId: 'manual', actorId: 'brent', channel: 'root.position',
      keys: [{ id: 'locked-key', locked: true, time: { kind: 'absolute', ms: 0 }, value: [10, 20] }],
    }]);
    const edited = structuredClone(before);
    edited.tracks[0]!.keys.splice(0, 1);
    expect(() => assertAnimationLocks(before, edited)).toThrow(/locked animation key/);
  });
});

describe('animation interpolation', () => {
  it('interpolates root and part values without affecting time before the first key', () => {
    const document = documentFor([
      {
        id: 'move', layerId: 'manual', actorId: 'brent', channel: 'root.position', blend: 'override',
        keys: [
          { id: 'move-a', time: { kind: 'absolute', ms: 500 }, value: [20, 40] },
          { id: 'move-b', time: { kind: 'absolute', ms: 1_500 }, value: [120, 80] },
        ],
      },
      {
        id: 'arm', layerId: 'manual', actorId: 'brent', channel: 'part.transform', partId: 'arm_R',
        blend: 'override',
        keys: [
          { id: 'arm-a', time: { kind: 'absolute', ms: 500 }, value: { rot: 0 } },
          { id: 'arm-b', time: { kind: 'absolute', ms: 1_500 }, value: { rot: 60, x: 10, scale: 1.2 } },
        ],
      },
    ]);
    const resolved = resolveAnimation(document, timeline);

    const before = sampleAnimation(resolved, 400, {
      brent: { x: 7, y: 9, parts: { arm_R: [3, 0, 0, 1] } },
    });
    expect(before.brent).toEqual({ x: 7, y: 9, parts: { arm_R: [3, 0, 0, 1] } });

    const middle = sampleAnimation(resolved, 1_000);
    expect(middle.brent!.x).toBeCloseTo(70);
    expect(middle.brent!.y).toBeCloseTo(60);
    expect(middle.brent!.parts.arm_R).toEqual([30, 5, 0, 1.1]);
  });

  it('holds a segment when its outgoing key requests hold interpolation', () => {
    const document = documentFor([{
      id: 'visibility', layerId: 'manual', actorId: 'janice', channel: 'visibility',
      keys: [
        { id: 'hidden', time: { kind: 'absolute', ms: 0 }, value: false },
        { id: 'arrived', time: { kind: 'absolute', ms: 750 }, value: true },
      ],
    }]);
    const resolved = resolveAnimation(document, timeline);
    expect(sampleAnimation(resolved, 749).janice!.visible).toBe(false);
    expect(sampleAnimation(resolved, 750).janice!.visible).toBe(true);
  });
});

describe('semantic time anchors', () => {
  it('resolves beat, speech and stable word edges with offsets', () => {
    expect(resolveTimeAnchor(
      { kind: 'beat', beatId: 'beat-one', edge: 'end', offsetMs: -50 }, timeline,
    )).toBe(1_050);
    expect(resolveTimeAnchor(
      { kind: 'speech', beatId: 'beat-one', edge: 'start', offsetMs: 25 }, timeline,
    )).toBe(225);
    expect(resolveTimeAnchor(
      { kind: 'word', beatId: 'beat-one', wordId: 'word-there', edge: 'end', offsetMs: 10 }, timeline,
    )).toBe(730);
  });

  it('moves an authored key when the aligned word moves', () => {
    const track: AnimationTrackInput = {
      id: 'nod', layerId: 'manual', actorId: 'brent', channel: 'part.transform', partId: 'head',
      blend: 'override', enabled: true, locked: false,
      keys: [{
        id: 'nod-on-there',
        time: { kind: 'word', beatId: 'beat-one', wordId: 'word-there', edge: 'start', offsetMs: 0 },
        value: { rot: 8, x: 0, y: 0, scale: 1 }, interpolation: 'linear', easing: 'linear', locked: false,
      }],
    };
    const first = resolveAnimation(documentFor([track]), timeline);
    const moved: AnimationTimeline = structuredClone(timeline);
    moved.beats[0]!.speech!.words[1]!.startMs = 620;
    const second = resolveAnimation(documentFor([track]), moved);
    expect(first.tracks[0]!.keys[0]!.timeMs).toBe(500);
    expect(second.tracks[0]!.keys[0]!.timeMs).toBe(620);
  });
});

describe('layer composition', () => {
  it('applies manual overrides after generated direction regardless of array order', () => {
    const document = documentFor([
      {
        id: 'manual-position', layerId: 'manual', actorId: 'brent', channel: 'root.position',
        blend: 'override', keys: [{ id: 'manual-position-a', time: { kind: 'absolute', ms: 0 }, value: [90, 80] }],
      },
      {
        id: 'generated-position', layerId: 'generated', actorId: 'brent', channel: 'root.position',
        blend: 'override', keys: [{ id: 'generated-position-a', time: { kind: 'absolute', ms: 0 }, value: [10, 20] }],
      },
    ], [manual, generated]);
    expect(sampleAnimation(resolveAnimation(document, timeline), 500).brent).toMatchObject({ x: 90, y: 80 });
  });

  it('composes an additive manual part transform over a generated pose', () => {
    const document = documentFor([
      {
        id: 'generated-arm', layerId: 'generated', actorId: 'brent', channel: 'part.transform',
        partId: 'arm_R', blend: 'override',
        keys: [{ id: 'generated-arm-a', time: { kind: 'absolute', ms: 0 }, value: { rot: 10, x: 2 } }],
      },
      {
        id: 'manual-arm', layerId: 'manual', actorId: 'brent', channel: 'part.transform',
        partId: 'arm_R', blend: 'additive',
        keys: [{ id: 'manual-arm-a', time: { kind: 'absolute', ms: 0 }, value: { rot: 5, x: 1, scale: 2 } }],
      },
    ]);
    expect(sampleAnimation(resolveAnimation(document, timeline), 0).brent!.parts.arm_R).toEqual([15, 3, 0, 2]);
  });
});

describe('determinism and conflict rejection', () => {
  it('samples byte-identically when layer and track arrays arrive in a different order', () => {
    const tracks: AnimationTrackInput[] = [
      {
        id: 'generated-move', layerId: 'generated', actorId: 'brent', channel: 'root.position',
        keys: [
          { id: 'generated-move-a', time: { kind: 'absolute', ms: 0 }, value: [0, 0] },
          { id: 'generated-move-b', time: { kind: 'absolute', ms: 2_000 }, value: [100, 40] },
        ],
      },
      {
        id: 'manual-scale', layerId: 'manual', actorId: 'brent', channel: 'root.scale',
        keys: [{ id: 'manual-scale-a', time: { kind: 'absolute', ms: 0 }, value: 1.25 }],
      },
    ];
    const a = resolveAnimation(documentFor(tracks, [generated, manual]), timeline);
    const b = resolveAnimation(documentFor([...tracks].reverse(), [manual, generated]), timeline);
    expect(JSON.stringify(sampleAnimationFrames(a, 24))).toBe(JSON.stringify(sampleAnimationFrames(b, 24)));
  });

  it('rejects two tracks claiming the same channel in one layer', () => {
    const document = documentFor([
      {
        id: 'move-a', layerId: 'manual', actorId: 'brent', channel: 'root.position',
        keys: [{ id: 'move-a-key', time: { kind: 'absolute', ms: 0 }, value: [0, 0] }],
      },
      {
        id: 'move-b', layerId: 'manual', actorId: 'brent', channel: 'root.position',
        keys: [{ id: 'move-b-key', time: { kind: 'absolute', ms: 0 }, value: [10, 10] }],
      },
    ]);
    expect(() => resolveAnimation(document, timeline)).toThrow(/animation conflict/);
  });

  it('rejects keys whose different semantic anchors resolve to the same instant', () => {
    const document = documentFor([{
      id: 'bad-keys', layerId: 'manual', actorId: 'brent', channel: 'root.scale',
      keys: [
        { id: 'absolute-key', time: { kind: 'absolute', ms: 100 }, value: 1 },
        { id: 'beat-key', time: { kind: 'beat', beatId: 'beat-one', edge: 'start', offsetMs: 0 }, value: 2 },
      ],
    }]);
    expect(() => resolveAnimation(document, timeline)).toThrow(/two keys resolving/);
  });

  it('creates a stable empty authoring document for a new scene', () => {
    const document = defaultAnimation('new-scene');
    expect(document.schemaVersion).toBe(1);
    expect(document.layers.map((layer) => layer.ownership)).toEqual(['generated', 'manual']);
    expect(document.tracks).toEqual([]);
  });
});

const PREVIEW_SCENE = 'animation-saved-preview-test';

afterAll(async () => {
  await fs.rm(sceneDir(PREVIEW_SCENE), { recursive: true, force: true });
});

function integrationShots(scene: string, cards = false) {
  return ShotList.parse({
    scene,
    cards,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER', resting: 'DEADPAN' }],
    beats: [
      {
        id: 'line-hello', kind: 'line', speaker: 'brent', text: 'Hello there.',
        expression: 'DEADPAN', gesture: 'NONE', reactions: {}, shot: 'MID',
        focus: ['brent'], camera: 'HOLD',
      },
      {
        id: 'pause-after', kind: 'pause', ms: 840, reactions: {}, shot: 'MID',
        focus: ['brent'], camera: 'HOLD',
      },
    ],
  });
}

type RichLineTiming = LineTiming & {
  speechOnsetMs: number;
  speechEndMs: number;
  words: Array<{ id: string; text: string; startMs: number; endMs: number }>;
};

function integrationTimings(): Map<number, LineTiming> {
  const line: RichLineTiming = {
    audio: '',
    durationMs: 1_000,
    cues: [{ ms: 0, shape: 'X' }],
    speechOnsetMs: 200,
    speechEndMs: 800,
    words: [
      { id: 'aligned-hello', text: 'Hello', startMs: 220, endMs: 390 },
      { id: 'aligned-there', text: 'there', startMs: 400, endMs: 620 },
    ],
  };
  return new Map([[0, line]]);
}

function integrationAnimation(scene: string) {
  return AnimationDocument.parse({
    schemaVersion: 1,
    scene,
    layers: [generated, manual],
    tracks: [
      {
        id: 'generated-root', layerId: 'generated', actorId: 'brent', channel: 'root.position',
        keys: [{ id: 'generated-root-key', time: { kind: 'absolute', ms: 0 }, value: [25, 700] }],
      },
      {
        id: 'manual-root', layerId: 'manual', actorId: 'brent', channel: 'root.position',
        keys: [
          {
            id: 'manual-root-start',
            time: { kind: 'speech', beatId: 'line-hello', edge: 'start' },
            value: [100, 700],
          },
          {
            id: 'manual-root-end',
            time: { kind: 'speech', beatId: 'line-hello', edge: 'end' },
            value: [300, 700],
          },
        ],
      },
      {
        id: 'manual-head', layerId: 'manual', actorId: 'brent', channel: 'part.transform',
        partId: 'head',
        keys: [{
          id: 'manual-head-key',
          time: { kind: 'word', beatId: 'line-hello', wordId: 'word-1', edge: 'start' },
          value: { rot: 12 },
        }],
      },
      {
        id: 'manual-visible', layerId: 'manual', actorId: 'brent', channel: 'visibility',
        keys: [{
          id: 'manual-visible-key',
          time: { kind: 'beat', beatId: 'line-hello', edge: 'end' },
          value: false,
        }],
      },
    ],
    events: [],
  });
}

function actorAtMs(ir: ReturnType<typeof compileShotList>['ir'], ms: number) {
  return ir.frames[Math.floor((ms / 1_000) * ir.meta.fps)]!.actors.brent!;
}

describe('AnimationDocument scene integration', () => {
  it('overlays speech/word-authored motion on staging with manual precedence', () => {
    const shots = integrationShots('animation-compile-test');
    const animation = integrationAnimation(shots.scene);
    const compiled = compileShotList(shots, testRigs(['brent']), integrationTimings(), animation);

    const middle = actorAtMs(compiled.ir, 500);
    // 500ms is halfway between the measured 200ms onset and 800ms speech end.
    expect(middle.x).toBeCloseTo(200);
    expect(middle.y).toBe(700);
    // The word starts at 400ms. Manual part override wins over generated
    // breathing/head motion from the staged base.
    expect(middle.parts.head).toEqual([12, 0, 0, 1]);
    expect(middle.visible).toBe(true);
    expect(actorAtMs(compiled.ir, 1_200).visible).toBe(false);
    expect(compiled.captions).toEqual([{
      id: 'line-hello', speaker: 'brent', text: 'Hello there.', startMs: 200, endMs: 800,
    }]);

    // Authored curves sample on output frames rather than inheriting the 12fps
    // generated-character hold grid.
    expect(compiled.ir.frames[11]!.actors.brent!.x).not.toBe(compiled.ir.frames[12]!.actors.brent!.x);
  });

  it('uses final-programme time when cards shift semantic beat anchors', () => {
    const shots = integrationShots('animation-card-test', true);
    const animation = integrationAnimation(shots.scene);
    const compiled = compileShotList(shots, testRigs(['brent']), integrationTimings(), animation);
    const cards = cardTiming(shots);
    const firstBodyFrame = cards.titleFrames;

    expect(compiled.beatStarts[0]).toBe(cards.titleMs);
    expect(compiled.captions[0]).toMatchObject({
      startMs: cards.titleMs + 200,
      endMs: cards.titleMs + 800,
    });
    // At the first body frame the generated absolute key is active; the manual
    // speech track does not begin until title + measured speech onset.
    expect(compiled.ir.frames[firstBodyFrame]!.actors.brent).toMatchObject({ x: 25, y: 700 });
  });

  it('keeps the original compiler path byte-compatible when no document is supplied', () => {
    const shots = integrationShots('animation-backcompat-test');
    const rigs = testRigs(['brent']);
    const timings = integrationTimings();
    const omitted = compileShotList(shots, rigs, timings);
    const explicit = compileShotList(shots, rigs, timings, null);
    const empty = compileShotList(shots, rigs, timings, defaultAnimation(shots.scene));
    expect(JSON.stringify(omitted.ir)).toBe(JSON.stringify(explicit.ir));
    expect(JSON.stringify(omitted.ir)).toBe(JSON.stringify(empty.ir));
  });

  it('rejects tracks that do not exist on the staged cast/rig', () => {
    const shots = integrationShots('animation-target-test');
    const animation = integrationAnimation(shots.scene);
    animation.tracks.push(AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      layers: [manual],
      tracks: [{
        id: 'bad-part', layerId: 'manual', actorId: 'brent', channel: 'part.transform',
        partId: 'missing_part',
        keys: [{ id: 'bad-part-key', time: { kind: 'absolute', ms: 0 }, value: { rot: 1 } }],
      }],
    }).tracks[0]!);
    expect(() => compileShotList(
      shots, testRigs(['brent']), integrationTimings(), animation,
    )).toThrow(/missing part/);
  });

  it('loads the saved per-scene document for preview by default', async () => {
    const shots = integrationShots(PREVIEW_SCENE);
    const animation = integrationAnimation(PREVIEW_SCENE);
    await writeAnimation(PREVIEW_SCENE, animation);

    const preview = await buildPreview(shots, testRigs(['brent']), integrationTimings());
    expect(actorAtMs(preview.ir, 500).x).toBeCloseTo(200);
    expect(actorAtMs(preview.ir, 500).parts.head).toEqual([12, 0, 0, 1]);

    // Before audio exists, deterministic word estimates keep semantic tracks
    // previewable; rendered alignment replaces these estimates later.
    const estimated = await buildPreview(shots, testRigs(['brent']), null);
    expect(estimated.estimated).toBe(true);
    expect(actorAtMs(estimated.ir, 500).parts.head).toEqual([12, 0, 0, 1]);
  });
});
