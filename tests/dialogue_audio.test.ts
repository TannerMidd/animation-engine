import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUS_RATE } from '../src/audio/bus.ts';
import { animationTimelineForTimings, compileShotList } from '../src/compile/scene.ts';
import { sceneDir } from '../src/core/paths.ts';
import {
  applyDialogueCueTiming,
  approximateWordTimings,
  estimateSelectedDialogueTimings,
  mixSceneAudio,
  resolveTimings,
  soundtrackFingerprint,
  soundtrackIsCurrent,
  trimPlacementSamples,
} from '../src/pipeline/voices.ts';
import {
  readDialogueDocument,
  syncDialogueDocument,
  writeDialogueDocument,
} from '../src/pipeline/dialogue.ts';
import { DialogueCue, DialogueDocument } from '../src/schema/dialogue.ts';
import { ShotList } from '../src/schema/script.ts';
import { encodeWav } from '../src/voice/wav.ts';
import type { LineTiming } from '../src/voice/visemes.ts';
import { tempDir, testRigs } from './helpers.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

function oneLineShots(scene = 'dialogue-audio') {
  return ShotList.parse({
    scene,
    cards: false,
    cast: [{ id: 'mel', rig: 'mel', mark: 'CENTER', resting: 'DEADPAN' }],
    beats: [{
      kind: 'line', speaker: 'mel', text: 'Hello there.', expression: 'DEADPAN', gesture: 'NONE',
      reactions: {}, shot: 'CU', focus: ['mel'], camera: 'HOLD',
    }],
  });
}

function editableCue(overrides: Record<string, unknown> = {}) {
  return DialogueCue.parse({
    id: 'line-1',
    beatIndex: 0,
    speaker: 'mel',
    displayText: 'Alpha beta.',
    spokenText: 'Alpha beta.',
    ...overrides,
  });
}

describe('dialogue timing resolution', () => {
  it('trims audio, mouth cues and exact alignment into line-local coordinates', () => {
    const cue = editableCue({
      trim: { inMs: 200, outMs: 800, speechOnsetMs: 250, speechEndMs: 750 },
      turnGapMs: 180,
      pickupMs: 40,
      pauseAfterMs: 260,
    });
    const base: LineTiming = {
      audio: 'take.wav',
      durationMs: 1000,
      cues: [
        { ms: 0, shape: 'X' },
        { ms: 100, shape: 'C' },
        { ms: 500, shape: 'D' },
        { ms: 900, shape: 'X' },
      ],
    };
    const timing = applyDialogueCueTiming(base, cue, {
      selectionKey: 'render:r1:checksum',
      spokenText: cue.spokenText,
      fps: 24,
      assetDurationMs: 1000,
      words: [
        { text: 'Alpha', startMs: 260, endMs: 400, confidence: 0.99 },
        { text: 'beta', startMs: 450, endMs: 700, confidence: 0.98 },
      ],
    });

    expect(timing).toMatchObject({
      durationMs: 600,
      sourceInMs: 200,
      sourceOutMs: 800,
      speechOnsetMs: 50,
      speechEndMs: 550,
      turnGapMs: 180,
      pickupMs: 40,
      pauseAfterMs: 260,
      editorialTiming: true,
      selectionKey: 'render:r1:checksum',
    });
    expect(timing.cues).toEqual([
      { ms: 0, shape: 'C' },
      { ms: 300, shape: 'D' },
    ]);
    expect(timing.words).toEqual([
      { id: 'w000-alpha', text: 'Alpha', startMs: 60, endMs: 200, confidence: 0.99 },
      { id: 'w001-beta', text: 'beta', startMs: 250, endMs: 500, confidence: 0.98 },
    ]);
  });

  it('makes fallback word IDs stable across duration changes', () => {
    const first = approximateWordTimings('Hello, strange world!', 0, 1000);
    const retimed = approximateWordTimings('Hello, strange world!', 120, 1600);
    expect(retimed.map((word) => word.id)).toEqual(first.map((word) => word.id));
    expect(first.map((word) => word.id)).toEqual([
      'w000-hello', 'w001-strange', 'w002-world',
    ]);
  });

  it('pads a shorter take with tail silence to satisfy a picture-locked duration exactly', () => {
    const cue = editableCue({
      durationPolicy: { mode: 'fit-locked-window', targetFrames: 24 },
    });
    const timing = applyDialogueCueTiming(
      { audio: 'take.wav', durationMs: 600, cues: [{ ms: 0, shape: 'X' }] },
      cue,
      { selectionKey: 'take:t1:x', spokenText: cue.spokenText, fps: 24 },
    );
    expect(timing.durationMs).toBe(1000);
    expect(timing.playbackDurationMs).toBe(1000);
    expect(timing.sourceOutMs).toBeUndefined();
  });

  it('refuses a picture lock that would remove voiced material', () => {
    const cue = editableCue({
      trim: { inMs: 0, outMs: 1000, speechOnsetMs: 20, speechEndMs: 980 },
      durationPolicy: { mode: 'fit-locked-window', targetFrames: 12 },
    });
    expect(() => applyDialogueCueTiming(
      { audio: 'take.wav', durationMs: 1000, cues: [{ ms: 0, shape: 'X' }] },
      cue,
      { selectionKey: 'take:t1:x', spokenText: cue.spokenText, fps: 24 },
    )).toThrow(/cannot fit.*without removing.*voiced material/);
  });

  it('places and trims an authored interruption on the exact programme clock', () => {
    const shots = ShotList.parse({
      scene: 'dialogue-interruption', cards: false, fps: 24, characterFps: 12,
      cast: [
        { id: 'mel', rig: 'mel', mark: 'SL' },
        { id: 'vern', rig: 'vern', mark: 'SR' },
      ],
      beats: [
        { id: 'line-a', kind: 'line', speaker: 'mel', text: 'Alpha beta.', expression: 'NEUTRAL', gesture: 'NONE' },
        { id: 'line-b', kind: 'line', speaker: 'vern', text: 'Stop.', expression: 'NEUTRAL', gesture: 'NONE' },
      ],
    });
    const timings = new Map<number, LineTiming>([
      [0, {
        audio: 'alpha.wav', durationMs: 1_000, playbackDurationMs: 1_000,
        speechOnsetMs: 100, speechEndMs: 900, editorialTiming: true, cueId: 'line-a',
        cues: [{ ms: 0, shape: 'X' }, { ms: 700, shape: 'D' }],
        words: [
          { id: 'word-0', text: 'Alpha', startMs: 120, endMs: 420 },
          { id: 'word-1', text: 'beta', startMs: 500, endMs: 820 },
        ],
      }],
      [1, {
        audio: 'stop.wav', durationMs: 700, speechOnsetMs: 50, speechEndMs: 600,
        editorialTiming: true, cueId: 'line-b', overlapMode: 'interruption', overlapWithCueId: 'line-a',
        overlapMs: 200, interruptAtMs: 600, cues: [{ ms: 0, shape: 'X' }],
      }],
    ]);
    const compiled = compileShotList(shots, testRigs(['mel', 'vern']), timings);

    expect(compiled.beatStarts).toEqual([0, 550]);
    expect(compiled.audio[0]).toMatchObject({ cueId: 'line-a', startMs: 0, playbackDurationMs: 600, speechEndMs: 600 });
    expect(compiled.audio[1]).toMatchObject({ cueId: 'line-b', startMs: 550, interruptAtMs: 600 });
    expect(compiled.captions).toEqual([
      { id: 'line-a', speaker: 'mel', text: 'Alpha beta.', startMs: 100, endMs: 600 },
      { id: 'line-b', speaker: 'vern', text: 'Stop.', startMs: 600, endMs: 1_150 },
    ]);
    expect(compiled.durationMs).toBe(1_250);
  });

  it('prefers an explicitly selected take and uses its spoken text and trim', async () => {
    const outDir = await tempDir('selected-dialogue');
    dirs.push(outDir);
    const shots = oneLineShots('selected-dialogue');
    const synced = await syncDialogueDocument(shots.scene, shots, outDir);
    const sceneRoot = path.join(outDir, shots.scene);
    const relativeFile = 'takes/selected.wav';
    const file = path.join(sceneRoot, relativeFile);
    const samples = new Int16Array(BUS_RATE);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / BUS_RATE) * 5000);
    }
    const wav = encodeWav(samples, BUS_RATE, 1);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, wav);
    const checksum = crypto.createHash('sha256').update(wav).digest('hex');
    const cueId = shots.beats[0]!.id;

    const selected = DialogueDocument.parse({
      ...synced,
      revision: synced.revision + 1,
      recordedTakes: [{
        id: 'take-1',
        cueId,
        speaker: 'mel',
        displayText: 'Hello there.',
        spokenText: 'Hello, there.',
        scriptTextHash: 'a'.repeat(64),
        audio: {
          file: relativeFile,
          checksum,
          byteLength: wav.length,
          sampleRate: BUS_RATE,
          channels: 1,
          sampleCount: BUS_RATE,
          durationMs: 1000,
        },
        capture: {
          mode: 'line-booth',
          recordedAt: '2026-08-02T18:00:00.000Z',
        },
      }],
      cues: [{
        ...synced.cues[0]!,
        spokenText: 'Hello, there.',
        selectedTakeId: 'take-1',
        trim: { inMs: 200, outMs: 800, speechOnsetMs: 250, speechEndMs: 750 },
        pickupMs: 30,
        turnGapMs: 175,
      }],
    });
    await writeDialogueDocument(shots.scene, selected, outDir);

    const timings = await resolveTimings(shots.scene, shots, testRigs(['mel']), {
      engine: 'chatterbox',
      dialogueOutDir: outDir,
    });
    expect(timings.get(0)).toMatchObject({
      audio: file,
      durationMs: 600,
      sourceInMs: 200,
      sourceOutMs: 800,
      speechOnsetMs: 50,
      speechEndMs: 550,
      pickupMs: 30,
      turnGapMs: 175,
      selectionKey: `take:take-1:${checksum}`,
    });
    expect(timings.get(0)!.words!.map((word) => word.text)).toEqual(['Hello,', 'there.']);
    expect(animationTimelineForTimings(
      shots,
      estimateSelectedDialogueTimings(shots, selected),
    )).toEqual(animationTimelineForTimings(shots, timings));
  }, 20_000);
});

describe('compiled dialogue timeline', () => {
  it('supports overlapping speakers while assigning the latest beat to camera intent', () => {
    const shots = ShotList.parse({
      scene: 'overlap-test',
      cards: false,
      cast: [
        { id: 'alice', rig: 'alice', mark: 'SL', resting: 'DEADPAN' },
        { id: 'bob', rig: 'bob', mark: 'SR', resting: 'DEADPAN' },
      ],
      beats: [
        {
          kind: 'line', speaker: 'alice', text: 'First.', expression: 'DEADPAN', gesture: 'NONE',
          reactions: {}, shot: 'CU', focus: ['alice'], camera: 'HOLD',
        },
        {
          kind: 'line', speaker: 'bob', text: 'Second.', expression: 'DEADPAN', gesture: 'NONE',
          reactions: {}, shot: 'CU', focus: ['bob'], camera: 'HOLD',
        },
      ],
    });
    const timings = new Map<number, LineTiming>([
      [0, {
        audio: 'alice.wav', durationMs: 1000, cues: [{ ms: 0, shape: 'C' }],
        speechOnsetMs: 0, speechEndMs: 1000, editorialTiming: true,
      }],
      [1, {
        audio: 'bob.wav', durationMs: 800, cues: [{ ms: 0, shape: 'D' }],
        sourceInMs: 200, sourceOutMs: 1000,
        speechOnsetMs: 0, speechEndMs: 800, editorialTiming: true, overlapMs: 300,
        cueId: 'bob-cue', selectionKey: 'take:bob:x', timingKey: 'timing-bob',
      }],
    ]);

    const compiled = compileShotList(shots, testRigs(['alice', 'bob']), timings);
    expect(compiled.beatStarts).toEqual([0, 700]);
    expect(compiled.durationMs).toBe(1500);
    expect(compiled.audio[1]).toMatchObject({
      startMs: 700,
      sourceInMs: 200,
      sourceOutMs: 1000,
      selectionKey: 'take:bob:x',
    });

    const overlap = compiled.ir.frames[Math.round(0.75 * shots.fps)]!;
    expect(overlap.actors['alice']!.swaps.mouth).toBe('mouth_C');
    expect(overlap.actors['bob']!.swaps.mouth).toBe('mouth_D');
    expect(overlap.camera.x + overlap.camera.w / 2).toBeGreaterThan(shots.width / 2);
  });
});

describe('audio trim and soundtrack identity', () => {
  it('slices source samples at the shared bus rate', () => {
    const samples = Float64Array.from({ length: BUS_RATE / 10 }, (_, index) => index);
    const trimmed = trimPlacementSamples(samples, {
      file: 'take.wav', sourceInMs: 25, sourceOutMs: 75,
    });
    expect(trimmed.length).toBe(BUS_RATE * 0.05);
    expect(trimmed[0]).toBe(BUS_RATE * 0.025);
    expect(trimmed[trimmed.length - 1]).toBe(BUS_RATE * 0.075 - 1);
  });

  it('invalidates the soundtrack program for trim or selection changes', async () => {
    const dir = await tempDir('soundtrack-fingerprint');
    dirs.push(dir);
    const file = path.join(dir, 'same.wav');
    await fs.writeFile(file, 'same source bytes');
    const shots = oneLineShots('fingerprint-test');
    const base = {
      file,
      startMs: 0,
      sourceInMs: 100,
      sourceOutMs: 900,
      speechOnsetMs: 40,
      speechEndMs: 740,
      cueId: shots.beats[0]!.id,
      selectionKey: 'take:t1:aaa',
      timingKey: 'timing-a',
      editorialTiming: true,
    };
    const first = await soundtrackFingerprint(shots.scene, shots, [base], 1000);
    const retrimmed = await soundtrackFingerprint(
      shots.scene, shots, [{ ...base, sourceInMs: 120 }], 1000,
    );
    const reselection = await soundtrackFingerprint(
      shots.scene, shots, [{ ...base, selectionKey: 'take:t2:bbb' }], 1000,
    );

    expect(first.programKey).not.toBe(retrimmed.programKey);
    expect(first.programKey).not.toBe(reselection.programKey);
    expect(first.placements[0]).toMatchObject({
      sourceInMs: 100,
      sourceOutMs: 900,
      selectionKey: 'take:t1:aaa',
    });
  });

  it('marks a mixed soundtrack stale when a selected cue is retrimmed', async () => {
    const scene = `dialogue-currentness-${process.pid}`;
    const output = sceneDir(scene);
    dirs.push(output);
    await fs.rm(output, { recursive: true, force: true });
    const shots = oneLineShots(scene);
    const rigs = testRigs(['mel']);
    const synced = await syncDialogueDocument(scene, shots);
    const file = path.join(output, 'takes', 'take.wav');
    const samples = new Int16Array(BUS_RATE);
    const wav = encodeWav(samples, BUS_RATE, 1);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, wav);
    const checksum = crypto.createHash('sha256').update(wav).digest('hex');
    const selected = DialogueDocument.parse({
      ...synced,
      revision: synced.revision + 1,
      recordedTakes: [{
        id: 'take-current',
        cueId: shots.beats[0]!.id,
        speaker: 'mel',
        displayText: 'Hello there.',
        spokenText: 'Hello there.',
        scriptTextHash: 'b'.repeat(64),
        audio: {
          file: 'takes/take.wav', checksum, byteLength: wav.length,
          sampleRate: BUS_RATE, channels: 1, sampleCount: BUS_RATE, durationMs: 1000,
        },
        capture: { mode: 'line-booth', recordedAt: '2026-08-02T18:00:00.000Z' },
      }],
      cues: [{
        ...synced.cues[0]!,
        selectedTakeId: 'take-current',
        trim: { inMs: 100, outMs: 900, speechOnsetMs: 150, speechEndMs: 850 },
      }],
    });
    await writeDialogueDocument(scene, selected);

    const timings = await resolveTimings(scene, shots, rigs, { engine: 'chatterbox' });
    const compiled = compileShotList(shots, rigs, timings);
    await mixSceneAudio(scene, shots, compiled.audio, compiled.durationMs);
    expect(await soundtrackIsCurrent(scene, shots, rigs)).toBe(true);

    const current = (await readDialogueDocument(scene))!;
    await writeDialogueDocument(scene, DialogueDocument.parse({
      ...current,
      revision: current.revision + 1,
      cues: [{
        ...current.cues[0]!,
        trim: { inMs: 120, outMs: 900, speechOnsetMs: 150, speechEndMs: 850 },
      }],
    }));
    expect(await soundtrackIsCurrent(scene, shots, rigs)).toBe(false);
  }, 20_000);
});

describe('dialogue persistence locks', () => {
  it('requires separate saves to unlock a cue or a locked field', async () => {
    const outDir = await tempDir('dialogue-locks');
    dirs.push(outDir);
    const shots = oneLineShots('dialogue-locks');
    const base = await syncDialogueDocument(shots.scene, shots, outDir);
    const cue = base.cues[0]!;

    const fullyLocked = DialogueDocument.parse({
      ...base,
      revision: 2,
      cues: [{ ...cue, locked: true }],
    });
    await writeDialogueDocument(shots.scene, fullyLocked, outDir);
    await expect(writeDialogueDocument(shots.scene, DialogueDocument.parse({
      ...fullyLocked,
      revision: 3,
      cues: [{ ...fullyLocked.cues[0]!, locked: false, pauseAfterMs: 300 }],
    }), outDir)).rejects.toThrow(/only be unlocked in a separate save/);

    const unlocked = DialogueDocument.parse({
      ...fullyLocked,
      revision: 3,
      cues: [{ ...fullyLocked.cues[0]!, locked: false }],
    });
    await writeDialogueDocument(shots.scene, unlocked, outDir);

    const fieldLocked = DialogueDocument.parse({
      ...unlocked,
      revision: 4,
      cues: [{ ...unlocked.cues[0]!, lockedFields: ['timing'] }],
    });
    await writeDialogueDocument(shots.scene, fieldLocked, outDir);
    await expect(writeDialogueDocument(shots.scene, DialogueDocument.parse({
      ...fieldLocked,
      revision: 5,
      cues: [{ ...fieldLocked.cues[0]!, lockedFields: [], turnGapMs: 999 }],
    }), outDir)).rejects.toThrow(/field "timing" is locked/);

    const fieldUnlocked = DialogueDocument.parse({
      ...fieldLocked,
      revision: 5,
      cues: [{ ...fieldLocked.cues[0]!, lockedFields: [] }],
    });
    await writeDialogueDocument(shots.scene, fieldUnlocked, outDir);
    await writeDialogueDocument(shots.scene, DialogueDocument.parse({
      ...fieldUnlocked,
      revision: 6,
      cues: [{ ...fieldUnlocked.cues[0]!, turnGapMs: 999 }],
    }), outDir);
    expect((await readDialogueDocument(shots.scene, outDir))!.cues[0]!.turnGapMs).toBe(999);
  });
});
