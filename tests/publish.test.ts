import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SceneIR, type IRActor, type IRFrame } from '../src/schema/ir.ts';
import {
  buildExportApprovalProvenance, evaluatePublishingSafety,
  selectThumbnailCandidates, subRip, webVtt, writePublishingBundle,
  type ExportManifest,
} from '../src/pipeline/publish.ts';
import type { CompiledCaptionCue, CompiledScene } from '../src/compile/scene.ts';
import type { FoleyEvent } from '../src/audio/foley.ts';
import { BUS_RATE } from '../src/audio/bus.ts';
import type { ProductionAudioBundle } from '../src/pipeline/voices.ts';
import { encodeWav } from '../src/voice/wav.ts';
import { tempDir } from './helpers.ts';
import { reframeScenePortrait } from '../src/pipeline/reframe.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { createDialogueDocument } from '../src/pipeline/dialogue.ts';
import { defaultAnimation } from '../src/pipeline/animation.ts';

const captions: CompiledCaptionCue[] = [
  {
    id: 'late', speaker: 'janice',
    text: 'A & B <C>\r\nNext\0',
    startMs: 3_661_001,
    endMs: 3_662_500,
  },
  {
    id: 'early', speaker: 'brent',
    text: 'Use --> this.',
    startMs: 1_250.4,
    endMs: 2_500.6,
  },
];

describe('publishing captions', () => {
  it('writes valid WebVTT timing, scheduled order, and escaped cue text', () => {
    expect(webVtt(captions)).toBe(
      'WEBVTT\n\n' +
      '00:00:01.250 --> 00:00:02.501\n' +
      'Use --&gt; this.\n\n' +
      '01:01:01.001 --> 01:01:02.500\n' +
      'A &amp; B &lt;C&gt;\nNext\n',
    );
  });

  it('writes SubRip commas, sequential indices, and the same safe text', () => {
    expect(subRip(captions)).toBe(
      '1\n' +
      '00:00:01,250 --> 00:00:02,501\n' +
      'Use --&gt; this.\n\n' +
      '2\n' +
      '01:01:01,001 --> 01:01:02,500\n' +
      'A &amp; B &lt;C&gt;\nNext\n',
    );
  });

  it('blocks captions that cannot fit the two-line mobile safe area', () => {
    const report = evaluatePublishingSafety([{
      id: 'too-long',
      speaker: 'janice',
      text: Array.from({ length: 19 }, () => 'word').join(' '),
      startMs: 0,
      endMs: 1_000,
    }]);
    expect(report.ok).toBe(false);
    expect(report.captions.violations[0]).toMatchObject({ cueId: 'too-long', estimatedLines: 4 });
    expect(report.portrait.status).toBe('not-evaluated');
  });
});

function actor(parts: number, mouth = 'mouth_X'): IRActor {
  const transforms: IRActor['parts'] = {};
  for (let i = 0; i < parts; i++) transforms[`part_${i}`] = [i + 1, 0, 0, 1];
  return {
    visible: true,
    x: 400,
    y: 680,
    scale: 1,
    flip: false,
    parts: transforms,
    swaps: { mouth, eyes: 'eyes_open' },
  };
}

function frame(cameraWidth: number, actors: Record<string, IRActor>, card?: 'title' | 'end'): IRFrame {
  return {
    camera: { x: 0, y: 0, w: cameraWidth, h: cameraWidth * (720 / 1280) },
    actors,
    card,
  };
}

const expressiveTwoShot = frame(700, {
  brent: actor(2, 'mouth_D'),
  janice: { ...actor(2, 'mouth_C'), x: 820, flip: true },
});

const thumbnailIr = SceneIR.parse({
  meta: {
    scene: 'thumbnail-test', fps: 24, width: 1280, height: 720,
    seed: 7, audio: null, set: null,
  },
  cast: [{ id: 'brent', rig: 'brent' }, { id: 'janice', rig: 'janice' }],
  frames: [
    frame(1280, {}, 'title'),
    frame(1280, { brent: actor(0) }),
    expressiveTwoShot,
    expressiveTwoShot, // held visual state; only one may become a candidate
    frame(500, { brent: actor(4, 'mouth_D') }),
    frame(1280, {}, 'end'),
  ],
});

describe('publishing approval provenance', () => {
  it('hashes identity, dialogue editorial state and animation lock state deterministically', () => {
    const dialogue = createDialogueDocument('thumbnail-test');
    const animation = defaultAnimation('thumbnail-test');
    const first = buildExportApprovalProvenance(DEFAULT_IDENTITY, dialogue, animation);
    const second = buildExportApprovalProvenance(DEFAULT_IDENTITY, dialogue, animation);
    expect(first).toEqual(second);
    expect(first.identity.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.dialogue?.approvalStateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.animation?.lockStateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(buildExportApprovalProvenance(
      DEFAULT_IDENTITY,
      { ...dialogue, revision: dialogue.revision + 1 },
      animation,
    ).dialogue?.documentSha256).not.toBe(first.dialogue?.documentSha256);
  });
});

describe('thumbnail candidate selection', () => {
  it('is deterministic, excludes cards/empty frames, and deduplicates held states', () => {
    const first = selectThumbnailCandidates(thumbnailIr, 2);
    const second = selectThumbnailCandidates(thumbnailIr, 2);

    expect(first).toEqual(second);
    expect(first.map((item) => item.frame)).toEqual([2, 4]);
    expect(first[0]!.timeMs).toBeCloseTo(83.333, 3);
    expect(first.every((item) => !thumbnailIr.frames[item.frame]!.card)).toBe(true);
    expect(new Set(first.map((item) => JSON.stringify(thumbnailIr.frames[item.frame]))).size).toBe(2);
  });
});

describe('publishing bundle manifest', () => {
  it('materialises captions/thumbnails beside the horizontal master and inventories them', async () => {
    const dir = await tempDir('publishing-bundle');
    try {
      const framesDir = path.join(dir, 'frames');
      await fs.mkdir(framesDir, { recursive: true });
      for (let frame = 0; frame < thumbnailIr.frames.length; frame++) {
        await fs.writeFile(path.join(framesDir, `${String(frame).padStart(6, '0')}.png`), `png-${frame}`);
      }
      const mp4 = path.join(dir, 'bundle-test.mp4');
      const verticalMp4 = path.join(dir, 'bundle-test.vertical.mp4');
      await fs.writeFile(mp4, 'horizontal-master');
      await fs.writeFile(verticalMp4, 'vertical-master');
      const stemsDir = path.join(dir, 'stems');
      await fs.mkdir(stemsDir, { recursive: true });
      const silentWav = encodeWav(new Int16Array(BUS_RATE / 2), BUS_RATE, 2);
      const masterAudio = path.join(dir, 'dialogue.wav');
      const stemFiles = {
        dialogue: path.join(stemsDir, 'dialogue.wav'),
        ambience: path.join(stemsDir, 'ambience.wav'),
        foley: path.join(stemsDir, 'foley.wav'),
        stings: path.join(stemsDir, 'stings.wav'),
      };
      await Promise.all([masterAudio, ...Object.values(stemFiles)].map((file) => fs.writeFile(file, silentWav)));
      const event: FoleyEvent = {
        id: 'action-1:stage:0:foley',
        type: 'move',
        actor: 'brent',
        beatId: 'action-1',
        beatIndex: 0,
        actionIndex: 0,
        transitionStartMs: 50,
        transitionEndMs: 200,
        placementMs: 50,
        seed: 17,
        gainDb: -19,
        renderedDurationMs: 150,
        source: {
          kind: 'synthesized', generator: 'deterministic-foley', generatorVersion: 2, seed: 17,
        },
        eventSha256: 'e'.repeat(64),
      };
      const eventsFile = path.join(stemsDir, 'foley.events.json');
      await fs.writeFile(eventsFile, JSON.stringify({ schemaVersion: 2, events: [event] }));
      const soundtrackManifest = path.join(dir, 'soundtrack.json');
      await fs.writeFile(soundtrackManifest, '{}');
      const productionAudio: ProductionAudioBundle = {
        master: masterAudio,
        stems: stemFiles,
        foleyEvents: { file: eventsFile, events: [event] },
        soundtrackManifest,
        durationMs: 250,
        quality: {
          standard: 'ITU-R-BS.1770-style',
          targetIntegratedLufs: -16,
          loudnessToleranceLu: 1.5,
          truePeakCeilingDbtp: -1,
          metrics: { integratedLufs: -16.1, truePeakDbtp: -1.02, samplePeakDbfs: -1.2 },
          loudnessPassed: true,
          truePeakPassed: true,
          intentionalSilence: false,
          passed: true,
          speakerLeveling: [],
        },
      };
      const compiled: CompiledScene = {
        ir: thumbnailIr,
        audio: [],
        captions: [{ id: 'line', speaker: 'brent', text: 'Hello.', startMs: 0, endMs: 200 }],
        stageActions: [],
        durationMs: 250,
        beatStarts: [0],
      };

      const bundle = await writePublishingBundle({
        scene: 'bundle-test', dir, compiled, framesDir, mp4, verticalMp4, audio: productionAudio,
        portraitIr: reframeScenePortrait(thumbnailIr),
        identity: DEFAULT_IDENTITY,
        dialogue: createDialogueDocument('thumbnail-test'),
        animation: defaultAnimation('thumbnail-test'),
        warningAcknowledgement: {
          schemaVersion: 1,
          id: 'review-abc',
          scene: 'bundle-test',
          policyId: 'production-v1',
          fingerprint: 'a'.repeat(64),
          warnings: [{ code: 'voice-review', message: 'human audition completed' }],
          acknowledgedAt: '2026-08-02T12:00:00.000Z',
          acknowledgedBy: 'creator',
        },
        thumbnailCount: 2,
      });
      const manifest = JSON.parse(await fs.readFile(bundle.manifest, 'utf8')) as ExportManifest;

      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.horizontalMaster).toMatchObject({
        role: 'horizontal-master', file: 'bundle-test.mp4', width: 1280, height: 720, fps: 24,
      });
      expect(manifest.verticalMaster).toMatchObject({
        role: 'vertical-master', file: 'bundle-test.vertical.mp4', width: 720, height: 1280, fps: 24,
      });
      expect(manifest.captions.map((item) => item.format)).toEqual(['webvtt', 'srt']);
      expect(manifest.thumbnails).toHaveLength(2);
      expect(manifest.thumbnails[0]!.primary).toBe(true);
      expect(manifest.audio?.master).toMatchObject({
        role: 'programme-master', file: 'dialogue.wav', sampleRate: 48_000, channels: 2,
      });
      expect(manifest.audio?.stems.map((item) => item.role)).toEqual([
        'dialogue', 'ambience', 'foley', 'stings',
      ]);
      expect(manifest.audio?.foleyEvents).toMatchObject({
        file: 'stems/foley.events.json', count: 1,
      });
      expect(manifest.audio?.foleyEvents.events[0]).toMatchObject({
        id: event.id,
        eventSha256: event.eventSha256,
        source: { kind: 'synthesized', generatorVersion: 2 },
      });
      expect(manifest.audio?.quality).toMatchObject({
        targetIntegratedLufs: -16,
        metrics: { integratedLufs: -16.1, truePeakDbtp: -1.02 },
        passed: true,
      });
      expect(manifest.safety).toMatchObject({ ok: true, portrait: { status: 'pass' } });
      expect(manifest.approvals).toMatchObject({
        identity: { id: DEFAULT_IDENTITY.id, hash: expect.any(String), profileSha256: expect.any(String) },
        dialogue: { documentSha256: expect.any(String), approvalStateSha256: expect.any(String) },
        animation: { documentSha256: expect.any(String), lockStateSha256: expect.any(String) },
      });
      expect(manifest.warningAcknowledgement).toMatchObject({
        id: 'review-abc', policyId: 'production-v1', acknowledgedBy: 'creator',
      });
      expect(await fs.readFile(bundle.captions.vtt, 'utf8')).toContain('WEBVTT');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
