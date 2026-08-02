import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compileShotList, type CompiledStageAction, type CompiledStageState } from '../src/compile/scene.ts';
import { sceneDir } from '../src/core/paths.ts';
import {
  LocalFoleyAssetLibrary,
  SYNTHESIZED_ONLY_FOLEY_LIBRARY,
  deriveFoleyEvents,
  renderFoleyEvents,
} from '../src/audio/foley.ts';
import { fileSha256 } from '../src/audio/files.ts';
import { BUS_RATE } from '../src/audio/bus.ts';
import {
  dialogueGuideIsCurrent,
  mixProductionAudio,
  shouldMuteGuidePlacement,
} from '../src/pipeline/voices.ts';
import { ShotList, type StageAction } from '../src/schema/script.ts';
import { decodeWav, encodeWav, toInt16 } from '../src/voice/wav.ts';
import { tempDir, testRigs } from './helpers.ts';

const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true });
});

function actionBeat(text: string, ms: number, stage: StageAction[]) {
  return {
    kind: 'action' as const,
    text,
    ms,
    stage,
    unsupported: [],
    reactions: {},
    shot: 'WIDE' as const,
    focus: [],
    camera: 'HOLD' as const,
  };
}

function foleyShots(scene: string, cards: boolean) {
  return ShotList.parse({
    scene,
    cards,
    fps: 24,
    characterFps: 12,
    seed: 47,
    cast: [{ id: 'alice', rig: 'alice', mark: 'SL', visible: false }],
    beats: [
      actionBeat('Alice enters and crosses.', 1_000, [
        { type: 'enter', actor: 'alice', durationFrames: 6, to: { mark: 'SL' } },
        { type: 'move', actor: 'alice', to: { mark: 'SR' } },
      ]),
      actionBeat('Alice sits.', 500, [{ type: 'sit', actor: 'alice' }]),
      actionBeat('Alice stands.', 500, [{ type: 'stand', actor: 'alice' }]),
      actionBeat('Alice looks left.', 300, [{ type: 'look', actor: 'alice', direction: 'left' }]),
      actionBeat('Alice exits.', 700, [{ type: 'exit', actor: 'alice' }]),
    ],
  });
}

function pcmPeak(samples: Int16Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

const standingState: CompiledStageState = {
  visible: true,
  x: 500,
  y: 698,
  depth: 0,
  flip: false,
  pose: 'IDLE',
  lookTarget: null,
  lookDirection: null,
  turnTarget: null,
  turnDirection: null,
  heldPropId: null,
  heldHand: null,
};

describe('compiled Foley planning', () => {
  it('places pickup, put-down, and repeated-tap sounds on exact semantic contacts', async () => {
    const contactAction = (
      type: 'pick_up' | 'put_down' | 'tap',
      actionIndex: number,
      startMs: number,
      endMs: number,
      contacts: CompiledStageAction['contacts'],
    ): CompiledStageAction => ({
      id: `beat-contact:stage-${actionIndex}`,
      beatId: 'beat-contact',
      beatIndex: 0,
      actionIndex,
      type,
      actor: 'alice',
      startMs,
      endMs,
      before: { ...standingState },
      after: { ...standingState },
      contacts,
    });
    const target = {
      kind: 'prop' as const,
      id: 'mug-1',
      prop: 'mug',
      handle: 'rim-contact',
    };
    const actions: CompiledStageAction[] = [
      contactAction('pick_up', 0, 100, 500, [{
        id: 'beat-contact:stage-0:grasp-1', kind: 'grasp', actor: 'alice', hand: 'right',
        atMs: 320, ordinal: 1, total: 1, target, point: { x: 540, y: 610 },
      }]),
      contactAction('tap', 1, 600, 1_200, [
        {
          id: 'beat-contact:stage-1:tap-1', kind: 'tap', actor: 'alice', hand: 'right',
          atMs: 750, ordinal: 1, total: 2, target, point: { x: 540, y: 610 },
        },
        {
          id: 'beat-contact:stage-1:tap-2', kind: 'tap', actor: 'alice', hand: 'right',
          atMs: 1_050, ordinal: 2, total: 2, target, point: { x: 540, y: 610 },
        },
      ]),
      contactAction('put_down', 2, 1_300, 1_800, [{
        id: 'beat-contact:stage-2:release-1', kind: 'release', actor: 'alice', hand: 'right',
        atMs: 1_660, ordinal: 1, total: 1, target, point: { x: 565, y: 698 },
      }]),
    ];

    const plans = deriveFoleyEvents(actions, 73);
    expect(plans.map((event) => ({
      type: event.type,
      at: event.placementMs,
      ordinal: event.contact?.ordinal,
      prop: event.contact?.targetId,
    }))).toEqual([
      { type: 'pick_up', at: 320, ordinal: 1, prop: 'mug-1' },
      { type: 'tap', at: 750, ordinal: 1, prop: 'mug-1' },
      { type: 'tap', at: 1_050, ordinal: 2, prop: 'mug-1' },
      { type: 'put_down', at: 1_660, ordinal: 1, prop: 'mug-1' },
    ]);
    expect(new Set(plans.map((event) => event.id)).size).toBe(4);

    const rendered = await renderFoleyEvents(plans, SYNTHESIZED_ONLY_FOLEY_LIBRARY);
    expect(rendered.events.every((event) => event.renderedDurationMs > 0)).toBe(true);
    expect(rendered.clips.every((clip) => clip.samples.some((sample) => sample !== 0))).toBe(true);
  });

  it('uses canonical action windows on the final card-shifted programme clock', () => {
    const shots = foleyShots('foley-clock', true);
    const compiled = compileShotList(shots, testRigs(['alice']), new Map());
    const titleMs = compiled.beatStarts[0]!;

    expect(compiled.stageActions.map((action) => ({
      type: action.type,
      startMs: action.startMs,
      endMs: action.endMs,
    }))).toEqual([
      { type: 'enter', startMs: titleMs, endMs: titleMs + 250 },
      { type: 'move', startMs: titleMs + 250, endMs: titleMs + 1_000 },
      { type: 'sit', startMs: titleMs + 1_000, endMs: titleMs + 1_500 },
      { type: 'stand', startMs: titleMs + 1_500, endMs: titleMs + 2_000 },
      { type: 'look', startMs: titleMs + 2_000, endMs: titleMs + 2_300 },
      { type: 'exit', startMs: titleMs + 2_300, endMs: titleMs + 3_000 },
    ]);

    const events = deriveFoleyEvents(compiled.stageActions, shots.seed);
    expect(events.map((event) => event.type)).toEqual(['enter', 'move', 'sit', 'stand', 'exit']);
    expect(events[0]!.transitionStartMs).toBe(titleMs);
    expect(events[2]!.placementMs).toBe(titleMs + 1_310);
    expect(events[3]!.placementMs).toBe(titleMs + 1_710);
  });

  it('renders stable event-isolated synthesized fallbacks', async () => {
    const shots = foleyShots('foley-determinism', false);
    const compiled = compileShotList(shots, testRigs(['alice']), new Map());
    const plans = deriveFoleyEvents(compiled.stageActions, shots.seed);
    const first = await renderFoleyEvents(plans, SYNTHESIZED_ONLY_FOLEY_LIBRARY);
    const second = await renderFoleyEvents(plans, SYNTHESIZED_ONLY_FOLEY_LIBRARY);

    expect(first.events).toEqual(second.events);
    expect(first.clips.map((clip) => clip.samples)).toEqual(second.clips.map((clip) => clip.samples));
    expect(first.events.every((event) => event.source.kind === 'synthesized')).toBe(true);
    expect(new Set(first.events.map((event) => event.eventSha256)).size).toBe(first.events.length);

    const withUnrelated = await renderFoleyEvents(
      [{ ...plans[0]!, id: 'unrelated-event', seed: 999 }, ...plans],
      SYNTHESIZED_ONLY_FOLEY_LIBRARY,
    );
    expect(withUnrelated.clips[2]!.samples).toEqual(first.clips[1]!.samples);
  });

  it('prefers an authored local WAV and records immutable provenance', async () => {
    const root = await tempDir('foley-library');
    cleanup.push(root);
    const authored = new Int16Array(2_400);
    for (let i = 0; i < authored.length; i++) authored[i] = Math.round(Math.sin(i / 8) * 5_000);
    const asset = path.join(root, 'move.wav');
    await fs.writeFile(asset, encodeWav(authored, 24_000, 1));

    const shots = foleyShots('foley-authored', false);
    const compiled = compileShotList(shots, testRigs(['alice']), new Map());
    const plan = deriveFoleyEvents(compiled.stageActions, shots.seed).find((event) => event.type === 'move')!;
    const rendered = await renderFoleyEvents([plan], new LocalFoleyAssetLibrary(root, 'test-library'));

    expect(rendered.events[0]!.source).toEqual({
      kind: 'authored-local',
      libraryId: 'test-library',
      assetId: 'move.wav',
      assetPath: 'move.wav',
      assetSha256: await fileSha256(asset),
    });
    expect(rendered.clips[0]!.samples.length).toBe(4_800);
  });
});

describe('production audio stems', () => {
  it('writes deterministic full-length 48 kHz stereo stems and Foley metadata atomically', async () => {
    const scene = `production-audio-${process.pid}`;
    const dir = sceneDir(scene);
    cleanup.push(dir);
    await fs.rm(dir, { recursive: true, force: true });
    const shots = foleyShots(scene, false);
    const compiled = compileShotList(shots, testRigs(['alice']), new Map());

    const render = () => mixProductionAudio(scene, shots, [], compiled.durationMs, {
      stageActions: compiled.stageActions,
      foleyLibrary: SYNTHESIZED_ONLY_FOLEY_LIBRARY,
    });
    const first = await render();
    const firstHashes = await Promise.all([
      first.master,
      first.stems.dialogue,
      first.stems.ambience,
      first.stems.foley,
      first.stems.stings,
      first.foleyEvents.file,
    ].map(fileSha256));
    const second = await render();
    const secondHashes = await Promise.all([
      second.master,
      second.stems.dialogue,
      second.stems.ambience,
      second.stems.foley,
      second.stems.stings,
      second.foleyEvents.file,
    ].map(fileSha256));
    expect(secondHashes).toEqual(firstHashes);

    const files = [
      second.master,
      second.stems.dialogue,
      second.stems.ambience,
      second.stems.foley,
      second.stems.stings,
    ];
    for (const file of files) {
      const wav = decodeWav(await fs.readFile(file), file);
      expect(wav.sampleRate).toBe(BUS_RATE);
      expect(wav.channels).toBe(2);
      expect(wav.bitsPerSample).toBe(16);
      expect(toInt16(wav).length).toBe(Math.round(compiled.durationMs / 1_000 * BUS_RATE) * 2);
    }
    expect(pcmPeak(toInt16(decodeWav(await fs.readFile(second.stems.foley))))).toBeGreaterThan(0);
    expect(pcmPeak(toInt16(decodeWav(await fs.readFile(second.stems.dialogue))))).toBe(0);
    expect(second.foleyEvents.events).toHaveLength(5);
    expect(second.quality).toMatchObject({
      standard: 'ITU-R-BS.1770-style',
      targetIntegratedLufs: -16,
      truePeakCeilingDbtp: -1,
    });
    expect(typeof second.quality?.passed).toBe('boolean');
    expect(second.quality?.metrics.integratedLufs).not.toBeNull();
    expect(second.quality?.metrics.truePeakDbtp).toBeLessThanOrEqual(-0.95);
    const soundtrack = JSON.parse(await fs.readFile(second.soundtrackManifest, 'utf8')) as {
      production: { quality: unknown };
    };
    expect(soundtrack.production.quality).toEqual(second.quality);
    expect((await fs.readdir(path.dirname(second.stems.foley))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('writes a deterministic Scene Run guide with each performer muted from their own mix', async () => {
    expect(shouldMuteGuidePlacement({ speaker: 'alice', cueId: 'open' }, 'alice', ['open'])).toBe(true);
    expect(shouldMuteGuidePlacement({ speaker: 'alice', cueId: 'locked-context' }, 'alice', ['open'])).toBe(false);
    expect(shouldMuteGuidePlacement({ speaker: 'bob', cueId: 'reply' }, 'alice', ['open'])).toBe(false);
    expect(shouldMuteGuidePlacement({ speaker: 'alice' }, 'alice', ['open'])).toBe(true);

    const scene = `performance-guides-${process.pid}`;
    const dir = sceneDir(scene);
    cleanup.push(dir);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const aliceFile = path.join(dir, 'alice-source.wav');
    const bobFile = path.join(dir, 'bob-source.wav');
    const aliceTone = Int16Array.from({ length: BUS_RATE / 4 }, (_, index) => Math.round(Math.sin(index / 8) * 5_000));
    const bobTone = Int16Array.from({ length: BUS_RATE / 4 }, (_, index) => Math.round(Math.sin(index / 15) * 7_000));
    await Promise.all([
      fs.writeFile(aliceFile, encodeWav(aliceTone, BUS_RATE, 1)),
      fs.writeFile(bobFile, encodeWav(bobTone, BUS_RATE, 1)),
    ]);
    const shots = foleyShots(scene, false);
    const compiled = compileShotList(shots, testRigs(['alice']), new Map());
    const bundle = await mixProductionAudio(scene, shots, [
      { file: aliceFile, speaker: 'alice', cueId: 'alice-open', startMs: 0 },
      { file: bobFile, speaker: 'bob', cueId: 'bob-reply', startMs: 300 },
    ], compiled.durationMs, {
      stageActions: compiled.stageActions,
      foleyLibrary: SYNTHESIZED_ONLY_FOLEY_LIBRARY,
      guideMuteCueIds: { alice: ['alice-open'], bob: ['bob-reply'] },
    });

    expect(Object.keys(bundle.guides ?? {})).toEqual(['alice', 'bob']);
    expect(bundle.quality?.speakerLeveling.map((item) => item.speaker)).toEqual(['alice', 'bob']);
    expect(bundle.quality?.speakerLeveling.every((item) => Math.abs(item.adjustmentDb) <= 3)).toBe(true);
    const aliceGuide = bundle.guides?.alice;
    const bobGuide = bundle.guides?.bob;
    expect(aliceGuide).toBeTruthy();
    expect(bobGuide).toBeTruthy();
    expect(await fileSha256(aliceGuide!)).not.toBe(await fileSha256(bobGuide!));
    expect(await dialogueGuideIsCurrent(scene, 'alice', ['alice-open'])).toBe(true);
    expect(await dialogueGuideIsCurrent(scene, 'alice', ['alice-open', 'locked-context'])).toBe(false);
    for (const file of [aliceGuide!, bobGuide!]) {
      const wav = decodeWav(await fs.readFile(file), file);
      expect(wav.sampleRate).toBe(BUS_RATE);
      expect(wav.channels).toBe(2);
      expect(toInt16(wav).length).toBe(Math.round(compiled.durationMs / 1_000 * BUS_RATE) * 2);
    }
  });
});
