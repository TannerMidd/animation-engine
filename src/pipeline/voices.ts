import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR, OUT_DIR, sceneDir } from '../core/paths.ts';
import { deriveSeed } from '../core/rng.ts';
import { activeIdentity } from '../show/context.ts';
import { stampOf } from '../schema/identity.ts';
import {
  synthesizeLines, loadRecordedVo, estimateMouthCues, lineCacheKey, readCachedLineMeta,
  type LineTiming, type VoiceLine,
} from '../voice/index.ts';
import type { LineQa } from '../voice/qa.ts';
import { mouthAt, type MouthCue, type WordTiming } from '../voice/visemes.ts';
import { ensureVoiceRefs } from '../voice/casting.ts';
import { decodeWav, readWav } from '../voice/wav.ts';
import {
  BUS_RATE, toBusSamples, fadeEdges, masterToWav, stemToWav, rmsDb, db, measureProgramme, type BusClip,
} from '../audio/bus.ts';
import {
  assessProgrammeQuality,
  levelDialogueBySpeaker,
  type ProgrammeQualityGate,
  type SpeakerLevelAdjustment,
} from '../audio/quality.ts';
import { atomicWriteFile } from '../audio/files.ts';
import {
  FOLEY_EVENT_VERSION,
  deriveFoleyEvents,
  renderFoleyEvents,
  type FoleyAssetLibrary,
  type FoleyEvent,
  type FoleyEventsDocument,
} from '../audio/foley.ts';
import { renderAmbience, acousticProfileFor, ACOUSTIC_PROFILES, type AcousticProfile } from '../audio/ambience.ts';
import { loadSet } from '../sets/index.ts';
import { BUILTIN_SETS } from '../sets/builtins.ts';
import {
  estimateLineMs,
  cardTiming,
  type AudioPlacement,
  type CompiledStageAction,
} from '../compile/scene.ts';
import { alignedWordAnchorId } from '../compile/animation.ts';
import { titleSting, endSting } from '../audio/stings.ts';
import { exists, voPath } from './scene.ts';
import { listRigs, loadRig } from '../cast/store.ts';
import type { ShotList } from '../schema/script.ts';
import type { LoadedRig } from '../cast/store.ts';
import type {
  DialogueCue,
  DialogueDocument as DialogueDocumentType,
  AlignmentToken,
} from '../schema/dialogue.ts';
import {
  cueUsesEditorialTiming,
  dialogueAssetPath,
  dialogueCueTimingKey,
  dialogueScriptHash,
  readDialogueDocument,
  syncDialogueDocument,
} from './dialogue.ts';

/**
 * Turn a shot list's dialogue into audio and mouth timing.
 *
 * Every line is either a recorded VO override sitting in the scene's `vo/`
 * folder, or a synthesized take. Both come back as the same `LineTiming`, so
 * everything downstream is indifferent to which.
 */

export interface VoiceOptions {
  engine: string;
  onProgress?: (stage: string, done: number, total: number, detail?: string) => void;
  /** Test/tool override; production dialogue remains under the normal out/. */
  dialogueOutDir?: string;
  /** Immutable editorial snapshot for a gated production render. */
  dialogue?: DialogueDocumentType;
}

interface SelectedDialogueAsset {
  file: string;
  durationMs: number;
  checksum: string;
  byteLength: number;
  selectionKey: string;
  words: AlignmentToken[];
}

/** Stable fallback anchors when a selected render has no forced alignment. */
export function approximateWordTimings(
  text: string,
  startMs: number,
  endMs: number,
): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || endMs <= startMs) return [];
  const span = (endMs - startMs) / words.length;
  return words.map((word, index) => ({
    id: alignedWordAnchorId(index, word),
    text: word,
    startMs: startMs + span * index,
    endMs: startMs + span * (index + 1),
  }));
}

function trimMouthCues(cues: MouthCue[], inMs: number, outMs: number): MouthCue[] {
  const shifted: MouthCue[] = [{ ms: 0, shape: mouthAt(cues, inMs) }];
  for (const cue of cues) {
    if (cue.ms <= inMs || cue.ms >= outMs) continue;
    const next = { ms: cue.ms - inMs, shape: cue.shape };
    if (shifted[shifted.length - 1]!.shape !== next.shape) shifted.push(next);
  }
  return shifted;
}

function trimAlignedWords(words: readonly AlignmentToken[], inMs: number, outMs: number): WordTiming[] {
  return words.flatMap((word, index) => {
    if (word.endMs <= inMs || word.startMs >= outMs) return [];
    return [{
      id: alignedWordAnchorId(index, word.text),
      text: word.text,
      startMs: Math.max(inMs, word.startMs) - inMs,
      endMs: Math.min(outMs, word.endMs) - inMs,
      confidence: word.confidence,
    }];
  });
}

/** Apply a cue's non-destructive trim and authored timing to resolved audio. */
export function applyDialogueCueTiming(
  base: LineTiming,
  cue: DialogueCue,
  options: {
    selectionKey: string;
    spokenText: string;
    fps: number;
    assetDurationMs?: number;
    words?: readonly AlignmentToken[];
  },
): LineTiming {
  if (
    options.assetDurationMs !== undefined &&
    Math.abs(options.assetDurationMs - base.durationMs) > 2
  ) {
    throw new Error(
      `dialogue cue "${cue.id}" audio metadata says ${options.assetDurationMs}ms, ` +
      `but the selected file decodes to ${base.durationMs}ms`,
    );
  }

  let inMs = cue.trim?.inMs ?? 0;
  const requestedOutMs = cue.trim?.outMs ?? base.durationMs;
  if (inMs < 0 || requestedOutMs <= inMs || requestedOutMs > base.durationMs + 2) {
    throw new Error(
      `dialogue cue "${cue.id}" trim ${inMs}-${requestedOutMs}ms is outside ` +
      `the selected ${base.durationMs}ms audio`,
    );
  }
  let outMs = Math.min(base.durationMs, requestedOutMs);
  let durationMs = outMs - inMs;
  let speechOnsetMs = (cue.trim?.speechOnsetMs ?? inMs) - inMs;
  let speechEndMs = (cue.trim?.speechEndMs ?? outMs) - inMs;
  let playbackDurationMs: number | undefined;

  if (cue.durationPolicy.mode === 'fit-locked-window') {
    const targetFrames = cue.durationPolicy.targetFrames!;
    const targetMs = (targetFrames / options.fps) * 1000;
    if (targetMs < durationMs) {
      let removeMs = durationMs - targetMs;
      const trimTail = Math.min(removeMs, Math.max(0, durationMs - speechEndMs));
      outMs -= trimTail;
      durationMs -= trimTail;
      removeMs -= trimTail;
      const trimHead = Math.min(removeMs, Math.max(0, speechOnsetMs));
      inMs += trimHead;
      durationMs -= trimHead;
      speechOnsetMs -= trimHead;
      speechEndMs -= trimHead;
      removeMs -= trimHead;
      if (removeMs > 2) {
        throw new Error(
          `dialogue cue "${cue.id}" cannot fit ${targetFrames} frames without removing ` +
          `${Math.round(removeMs)}ms of voiced material; re-record to picture`,
        );
      }
    }
    durationMs = targetMs;
    playbackDurationMs = targetMs;
  } else if (cue.durationPolicy.mode === 'rerecord-to-picture') {
    const targetFrames = cue.durationPolicy.targetFrames!;
    const targetMs = (targetFrames / options.fps) * 1000;
    if (Math.abs(durationMs - targetMs) > 2) {
      throw new Error(
        `dialogue cue "${cue.id}" requests ${targetFrames} frames (${Math.round(targetMs)}ms) ` +
        `but selected playback is ${Math.round(durationMs)}ms; re-record it to picture`,
      );
    }
    durationMs = targetMs;
    playbackDurationMs = targetMs;
  }

  const exactWords = options.words?.length
    ? trimAlignedWords(options.words, inMs, outMs)
    : [];
  const words = exactWords.length
    ? exactWords
    : approximateWordTimings(options.spokenText, speechOnsetMs, speechEndMs);

  return {
    ...base,
    durationMs,
    playbackDurationMs,
    cues: trimMouthCues(base.cues, inMs, outMs),
    sourceInMs: cue.trim ? inMs : undefined,
    sourceOutMs: cue.trim ? outMs : undefined,
    speechStartMs: speechOnsetMs,
    speechOnsetMs,
    speechEndMs,
    words,
    alignment: { words },
    turnGapMs: cue.turnGapMs,
    pickupMs: cue.pickupMs,
    pauseAfterMs: cue.pauseAfterMs,
    overlapMs: cue.overlap?.ms ?? 0,
    overlapMode: cue.overlap?.mode,
    overlapWithCueId: cue.overlap?.withCueId,
    interruptAtMs: cue.overlap?.interruptAtMs,
    absoluteStartMs: cue.startFrame > 0 ? (cue.startFrame / options.fps) * 1000 : undefined,
    editorialTiming: cueUsesEditorialTiming(cue),
    cueId: cue.id,
    selectionKey: options.selectionKey,
    timingKey: dialogueCueTimingKey(cue),
  };
}

function selectedDialogueAsset(
  scene: string,
  cue: DialogueCue,
  document: DialogueDocumentType,
  outDir: string,
): SelectedDialogueAsset | null {
  if (cue.selectedRenderId) {
    const render = document.voiceRenders.find((candidate) => candidate.id === cue.selectedRenderId);
    if (!render) throw new Error(`dialogue cue "${cue.id}" selects missing render "${cue.selectedRenderId}"`);
    if (render.state !== 'ready' || !render.audio) {
      throw new Error(
        `dialogue cue "${cue.id}" explicitly selects ${render.state} render "${render.id}"; ` +
        `select a ready render or clear the selection`,
      );
    }
    return {
      file: dialogueAssetPath(scene, render.audio.file, outDir),
      durationMs: render.audio.durationMs,
      checksum: render.audio.checksum,
      byteLength: render.audio.byteLength,
      selectionKey: `render:${render.id}:${render.audio.checksum}`,
      words: render.alignment.words,
    };
  }

  if (cue.selectedTakeId) {
    const take = document.recordedTakes.find((candidate) => candidate.id === cue.selectedTakeId);
    if (!take) throw new Error(`dialogue cue "${cue.id}" selects missing take "${cue.selectedTakeId}"`);
    return {
      file: dialogueAssetPath(scene, take.audio.file, outDir),
      durationMs: take.audio.durationMs,
      checksum: take.audio.checksum,
      byteLength: take.audio.byteLength,
      selectionKey: `take:${take.id}:${take.audio.checksum}`,
      words: [],
    };
  }
  return null;
}

/**
 * Build the same editorial line timings as `resolveTimings` without reading,
 * decoding, or synthesising audio.
 *
 * Selected assets carry authoritative duration/trim/alignment metadata in the
 * dialogue document. Unselected lines retain a conservative word-count
 * estimate for draft editing; production preflight separately blocks those
 * unresolved selections.
 */
export function estimateSelectedDialogueTimings(
  shots: ShotList,
  document: DialogueDocumentType | null,
): Map<number, LineTiming> {
  const cues = new Map(document?.cues.map((cue) => [cue.id, cue]) ?? []);
  const timings = new Map<number, LineTiming>();

  shots.beats.forEach((beat, index) => {
    if (beat.kind !== 'line') return;
    const cue = cues.get(beat.id);
    const text = cue?.spokenText ?? beat.text;
    if (!cue || !document) {
      const durationMs = Math.max(400, estimateLineMs(text) - 160);
      timings.set(index, {
        audio: '',
        durationMs,
        cues: estimateMouthCues(text, durationMs),
        speechStartMs: 0,
        speechOnsetMs: 0,
        speechEndMs: durationMs,
        words: approximateWordTimings(text, 0, durationMs),
      });
      return;
    }

    const selected = selectedDialogueAsset(shots.scene, cue, document, OUT_DIR);
    const estimatedMs = Math.max(400, estimateLineMs(text) - 160);
    // A trim authored against an unresolved draft can exceed a fresh word
    // estimate. It is still useful for editing and will be rejected as an
    // unresolved production selection by the canonical policy.
    const durationMs = selected?.durationMs ?? Math.max(estimatedMs, cue.trim?.outMs ?? 0);
    const base: LineTiming = {
      audio: selected?.file ?? '',
      durationMs,
      cues: estimateMouthCues(text, durationMs),
      speechStartMs: 0,
      speechOnsetMs: 0,
      speechEndMs: durationMs,
      words: approximateWordTimings(text, 0, durationMs),
    };
    timings.set(index, applyDialogueCueTiming(base, cue, {
      selectionKey: selected?.selectionKey ?? 'estimate:unselected',
      spokenText: text,
      fps: shots.fps,
      assetDurationMs: selected?.durationMs,
      words: selected?.words,
    }));
  });

  return timings;
}

async function verifySelectedDialogueAsset(cueId: string, asset: SelectedDialogueAsset): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(asset.file);
  } catch {
    throw new Error(`dialogue cue "${cueId}" selects missing audio file ${asset.file}`);
  }
  if (bytes.length !== asset.byteLength) {
    throw new Error(
      `dialogue cue "${cueId}" selected audio byte length changed ` +
      `(${bytes.length}, expected ${asset.byteLength})`,
    );
  }
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  if (checksum !== asset.checksum.toLowerCase()) {
    throw new Error(
      `dialogue cue "${cueId}" selected audio checksum changed; append a new take/render instead of ` +
      `replacing an immutable asset in place`,
    );
  }
}

function cuePersona(
  rig: LoadedRig['rig'],
  cue: DialogueCue,
): { energy: number; pace: number } {
  const clamp = (value: number) => Math.max(0.5, Math.min(1.5, value));
  return {
    energy: clamp(rig.voicePersona.energy * cue.delivery.energy),
    pace: clamp(rig.voicePersona.pace * cue.delivery.pace),
  };
}

export async function resolveTimings(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  opts: VoiceOptions,
): Promise<Map<number, LineTiming>> {
  const dialogueOutDir = opts.dialogueOutDir ?? OUT_DIR;
  const dialogue = opts.dialogue ?? await syncDialogueDocument(scene, shots, dialogueOutDir);
  if (dialogue.scene !== scene || dialogue.scriptHash !== dialogueScriptHash(shots)) {
    throw new Error(`dialogue snapshot for "${scene}" does not match the rendered shot list`);
  }
  const cues = new Map(dialogue.cues.map((cue) => [cue.id, cue]));
  const timings = new Map<number, LineTiming>();
  const toSynth: VoiceLine[] = [];
  const pending = new Map<string, { beatIndex: number; cue: DialogueCue }>();

  // Which rigs actually need synthesis: a character whose every line is a
  // selected performance or recorded VO override never needs a cloning
  // reference at all.
  const needsSynth = new Set<string>();
  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;
    const cue = cues.get(beat.id);
    if (cue?.selectedRenderId || cue?.selectedTakeId) continue;
    if (await exists(voPath(scene, i, beat.speaker))) continue;
    const member = shots.cast.find((c) => c.id === beat.speaker);
    if (member) needsSynth.add(member.rig);
  }

  // Voice casting preflight. Idempotent and narrow: only rigs on disk, only
  // when cloning is in play, only characters with no reference at all — an
  // accepted voice, minted or recorded, is never re-decided here. Aliases
  // sharing a rig dedupe for free, because references attach to the rig.
  if (opts.engine === 'chatterbox' && needsSynth.size) {
    const onDisk = new Set(await listRigs());
    const candidates = [...needsSynth]
      .filter((name) => onDisk.has(name))
      .map((name) => {
        const rig = rigs.get(name)?.rig;
        return { name, charId: rig?.charId, voiceRef: rig?.voiceRef ?? null };
      });

    const minted = await ensureVoiceRefs(candidates, (done, total, name) =>
      opts.onProgress?.('casting', done, total === 0 ? 1 : total, name));
    // The in-memory rigs predate the mint; refresh them so this render clones
    // from the reference it just created.
    for (const name of minted) rigs.set(name, await loadRig(name));
  }

  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;

    const member = shots.cast.find((c) => c.id === beat.speaker);
    if (!member) throw new Error(`beat ${i} is spoken by "${beat.speaker}", who is not in the cast`);
    const cue = cues.get(beat.id);
    if (!cue) throw new Error(`line beat "${beat.id}" has no synchronized dialogue cue`);
    const spokenText = cue.spokenText;

    const selected = selectedDialogueAsset(scene, cue, dialogue, dialogueOutDir);
    if (selected) {
      await verifySelectedDialogueAsset(cue.id, selected);
      const loaded = await loadRecordedVo(selected.file, spokenText);
      timings.set(i, applyDialogueCueTiming(loaded, cue, {
        selectionKey: selected.selectionKey,
        spokenText,
        fps: shots.fps,
        assetDurationMs: selected.durationMs,
        words: selected.words,
      }));
      continue;
    }

    const vo = voPath(scene, i, beat.speaker);
    if (await exists(vo)) {
      timings.set(i, applyDialogueCueTiming(await loadRecordedVo(vo, spokenText), cue, {
        selectionKey: 'legacy-vo',
        spokenText,
        fps: shots.fps,
      }));
      continue;
    }

    const rig = rigs.get(member.rig)?.rig;
    if (!rig) throw new Error(`no rig loaded for "${member.rig}"`);
    const id = `${scene}-${i}`;
    pending.set(id, { beatIndex: i, cue });
    toSynth.push({
      id,
      text: spokenText,
      expression: cue.delivery.expression || beat.expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
      persona: cuePersona(rig, cue),
      // Derived from the scene seed, so a take is stable across re-renders but
      // differs line to line.
      seed: cue.seed ?? shots.seed * 1000 + i,
    });
  }

  if (toSynth.length) {
    const rendered = await synthesizeLines(toSynth, { engine: opts.engine, onProgress: opts.onProgress });
    for (const [id, timing] of rendered) {
      const item = pending.get(id)!;
      timings.set(item.beatIndex, applyDialogueCueTiming(timing, item.cue, {
        selectionKey: `tts:${opts.engine}`,
        spokenText: item.cue.spokenText,
        fps: shots.fps,
      }));
    }
  }

  return timings;
}

/**
 * Verification verdicts for every line that would ship as a *generated* take.
 *
 * Mirrors resolveTimings' line construction exactly — same cache key, same
 * engine constant (the same hardcode soundtrackIsCurrent lives with) — but
 * only reads cache metadata, so preflight can ask "does every generated line
 * demonstrably say its text?" without waking the engine. Lines covered by a
 * selected performance or legacy VO are exempt: a human chose those.
 */
export async function collectGeneratedLineQa(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  dialogue: DialogueDocumentType,
): Promise<Map<string, LineQa>> {
  const cues = new Map(dialogue.cues.map((cue) => [cue.id, cue]));
  const verdicts = new Map<string, LineQa>();

  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;
    const cue = cues.get(beat.id);
    if (!cue) continue;
    if (cue.selectedRenderId || cue.selectedTakeId) continue;
    if (await exists(voPath(scene, i, beat.speaker))) continue;

    const member = shots.cast.find((c) => c.id === beat.speaker);
    const rig = member ? rigs.get(member.rig)?.rig : undefined;
    if (!rig) continue;

    const meta = await readCachedLineMeta('chatterbox', {
      id: `${scene}-${i}`,
      text: cue.spokenText,
      expression: cue.delivery.expression || beat.expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
      persona: cuePersona(rig, cue),
      seed: cue.seed ?? shots.seed * 1000 + i,
    });
    if (meta?.qa) verdicts.set(cue.id, meta.qa);
  }

  return verdicts;
}

/**
 * Placeholder timings from word counts alone.
 *
 * Lets the editor scrub a scene the instant it is typed, before any TTS has
 * run. The mouth moves in roughly the right rhythm; it is not lipsync and does
 * not pretend to be. Real audio replaces it wholesale.
 */
export function estimateTimings(shots: ShotList): Map<number, LineTiming> {
  const timings = new Map<number, LineTiming>();
  shots.beats.forEach((beat, i) => {
    if (beat.kind !== 'line') return;
    // estimateLineMs includes the inter-line tail, which the compiler adds
    // again — subtract it so an estimated scene isn't systematically long.
    const durationMs = Math.max(400, estimateLineMs(beat.text) - 160);
    timings.set(i, {
      audio: '',
      durationMs,
      cues: estimateMouthCues(beat.text, durationMs),
      speechStartMs: 0,
      speechOnsetMs: 0,
      speechEndMs: durationMs,
      words: approximateWordTimings(beat.text, 0, durationMs),
    });
  });
  return timings;
}

/**
 * Assemble the scene's soundtrack: dialogue over room tone, mastered once.
 *
 * The single audio assembly path — preview, the Voices job, and final export
 * all come through here, so what plays in the editor is byte-identical to what
 * the MP4 muxes. Writes `soundtrack.json` beside the WAV: the fingerprint of
 * everything the track was built from, so anything serving this audio can tell
 * whether an edit since has made it a lie.
 */
export interface ProductionAudioStems {
  dialogue: string;
  ambience: string;
  foley: string;
  stings: string;
}

export interface ProductionAudioBundle {
  /** Compatibility programme master used by preview and the MP4 encoder. */
  master: string;
  stems: ProductionAudioStems;
  foleyEvents: { file: string; events: FoleyEvent[] };
  /** Punch-in guide keyed by cast id: open cues are muted while locked lines remain as context. */
  guides?: Record<string, string>;
  /** Release measurements and restrained cast levelling applied to this exact master. */
  quality?: ProgrammeQualityGate & { speakerLeveling: SpeakerLevelAdjustment[] };
  soundtrackManifest: string;
  durationMs: number;
}

export interface ProductionAudioOptions {
  /** Compiler-owned, final-clock transitions. Omit only for dialogue-only legacy callers. */
  stageActions?: readonly CompiledStageAction[];
  /** Local-only authored asset resolver; seeded synthesis fills every miss. */
  foleyLibrary?: FoleyAssetLibrary;
  /** Per performer, mute only the unlocked cues being captured; locked own lines remain punch-in context. */
  guideMuteCueIds?: Readonly<Record<string, readonly string[]>>;
  /**
   * The TTS engine that resolved these placements. Recorded in the manifest so
   * currentness recomputes cache keys against the engine that actually built
   * the track, rather than assuming the default.
   */
  engine?: string;
}

export function shouldMuteGuidePlacement(
  placement: Pick<AudioPlacement, 'speaker' | 'cueId'>,
  guideSpeaker: string,
  mutedCueIds?: readonly string[],
): boolean {
  if (placement.speaker !== guideSpeaker) return false;
  // Legacy callers have no cue identity, so retain the safe all-speaker mute.
  if (mutedCueIds === undefined || !placement.cueId) return true;
  return mutedCueIds.includes(placement.cueId);
}

export function productionAudioPaths(scene: string) {
  const dir = sceneDir(scene);
  const stems = path.join(dir, 'stems');
  return {
    dir,
    master: path.join(dir, 'dialogue.wav'),
    dialogue: path.join(stems, 'dialogue.wav'),
    ambience: path.join(stems, 'ambience.wav'),
    foley: path.join(stems, 'foley.wav'),
    stings: path.join(stems, 'stings.wav'),
    events: path.join(stems, 'foley.events.json'),
  };
}

function guideFileName(speaker: string): string {
  const safe = speaker.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'performer';
  const digest = crypto.createHash('sha1').update(speaker).digest('hex').slice(0, 8);
  return `${safe}-${digest}.wav`;
}

/** Stable path used by the mixer and the local Scene Run playback route. */
export function dialogueGuidePath(scene: string, speaker: string): string {
  return path.join(sceneDir(scene), 'stems', 'guides', guideFileName(speaker));
}

/** Lock/unlock edits change Scene Run context even when the programme master is unchanged. */
export async function dialogueGuideIsCurrent(
  scene: string,
  speaker: string,
  mutedCueIds: readonly string[],
): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(soundtrackManifestPath(scene), 'utf8')) as {
      production?: { guideMuteCueIds?: Record<string, string[]> };
    };
    const built = [...(manifest.production?.guideMuteCueIds?.[speaker] ?? [])].sort();
    const expected = [...mutedCueIds].sort();
    return JSON.stringify(built) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/** Assemble the programme master and full-length, post-fader production stems. */
export async function mixProductionAudio(
  scene: string,
  shots: ShotList,
  placements: AudioPlacement[],
  durationMs: number,
  options: ProductionAudioOptions = {},
): Promise<ProductionAudioBundle> {
  const identity = activeIdentity();
  const audio = identity.audio;
  const files = productionAudioPaths(scene);
  await fs.mkdir(files.dir, { recursive: true });

  const rawDialogueEntries: Array<{ clip: BusClip; speaker: string | null; cueId: string | null }> = [];
  for (const placement of placements) {
    const decoded = toBusSamples(await readWav(placement.file), placement.file);
    const samples = trimPlacementSamples(decoded, placement);
    rawDialogueEntries.push({
      clip: { samples: fadeEdges(samples, 4), startMs: placement.startMs },
      speaker: placement.speaker ?? null,
      cueId: placement.cueId ?? null,
    });
  }
  const levelledDialogue = levelDialogueBySpeaker(rawDialogueEntries);
  const dialogueEntries = levelledDialogue.entries.map((entry, index) => ({
    ...entry,
    cueId: rawDialogueEntries[index]!.cueId,
  }));
  const dialogueClips = dialogueEntries.map((entry) => entry.clip);

  const ambienceClip = await sceneAmbience(shots, durationMs);
  const ambienceClips = ambienceClip ? [ambienceClip] : [];

  const stingClips: BusClip[] = [];
  const stings = identity.audio.stings;
  if (stings.enabled && shots.cards) {
    const cards = cardTiming(shots);
    const gain = db(stings.levelDb);
    if (cards.titleMs > 0) {
      stingClips.push({ samples: titleSting(identity.seed), startMs: 0, gain });
    }
    if (cards.endMs > 0) {
      stingClips.push({ samples: endSting(identity.seed), startMs: durationMs - cards.endMs, gain });
    }
  }

  const foleyPlans = deriveFoleyEvents(options.stageActions ?? [], shots.seed);
  const renderedFoley = await renderFoleyEvents(foleyPlans, options.foleyLibrary);
  const allClips = [
    ...dialogueClips,
    ...ambienceClips,
    ...renderedFoley.clips,
    ...stingClips,
  ];
  const stemOptions = { durationMs, ceilingDb: audio.mix.ceilingDb };
  const eventsDocument: FoleyEventsDocument = {
    schemaVersion: FOLEY_EVENT_VERSION,
    scene,
    fps: shots.fps,
    durationMs,
    events: renderedFoley.events,
  };
  const speakers = [...new Set(dialogueEntries.flatMap((entry) => entry.speaker ? [entry.speaker] : []))].sort();
  const guides = Object.fromEntries(speakers.map((speaker) => [speaker, dialogueGuidePath(scene, speaker)]));
  const guideWrites = speakers.map((speaker) => {
    const mutedCueIds = options.guideMuteCueIds?.[speaker];
    const contextClips = [
      ...dialogueEntries
        .filter((entry) => !shouldMuteGuidePlacement(
          { speaker: entry.speaker ?? undefined, cueId: entry.cueId ?? undefined },
          speaker,
          mutedCueIds,
        ))
        .map((entry) => entry.clip),
      ...ambienceClips,
      ...renderedFoley.clips,
      ...stingClips,
    ];
    return atomicWriteFile(guides[speaker]!, masterToWav(contextClips, {
      durationMs,
      targetIntegratedLufs: audio.mix.targetIntegratedLufs,
      ceilingDb: audio.mix.ceilingDb,
    }));
  });

  const masterWav = masterToWav(allClips, {
    durationMs,
    targetIntegratedLufs: audio.mix.targetIntegratedLufs,
    ceilingDb: audio.mix.ceilingDb,
  });
  const masterMetrics = measureProgramme(toBusSamples(decodeWav(masterWav, 'programme master'), 'programme master'));
  const quality = {
    ...assessProgrammeQuality(
      masterMetrics,
      audio.mix.targetIntegratedLufs,
      audio.mix.ceilingDb,
    ),
    speakerLeveling: levelledDialogue.adjustments,
  };

  await Promise.all([
    atomicWriteFile(files.master, masterWav),
    atomicWriteFile(files.dialogue, stemToWav(dialogueClips, stemOptions)),
    atomicWriteFile(files.ambience, stemToWav(ambienceClips, stemOptions)),
    atomicWriteFile(files.foley, stemToWav(renderedFoley.clips, stemOptions)),
    atomicWriteFile(files.stings, stemToWav(stingClips, stemOptions)),
    atomicWriteFile(files.events, `${JSON.stringify(eventsDocument, null, 2)}\n`),
    ...guideWrites,
  ]);

  const fingerprint = await soundtrackFingerprint(scene, shots, placements, durationMs, options.engine ?? 'chatterbox');
  const soundtrackManifest = soundtrackManifestPath(scene);
  await atomicWriteFile(soundtrackManifest, `${JSON.stringify({
    ...fingerprint,
    production: {
      master: path.relative(files.dir, files.master).replace(/\\/g, '/'),
      stems: {
        dialogue: path.relative(files.dir, files.dialogue).replace(/\\/g, '/'),
        ambience: path.relative(files.dir, files.ambience).replace(/\\/g, '/'),
        foley: path.relative(files.dir, files.foley).replace(/\\/g, '/'),
        stings: path.relative(files.dir, files.stings).replace(/\\/g, '/'),
      },
      foleyEvents: {
        file: path.relative(files.dir, files.events).replace(/\\/g, '/'),
        schemaVersion: FOLEY_EVENT_VERSION,
        count: renderedFoley.events.length,
        eventHashes: renderedFoley.events.map((event) => event.eventSha256),
      },
      guides: Object.fromEntries(Object.entries(guides).map(([speaker, file]) => [
        speaker,
        path.relative(files.dir, file).replace(/\\/g, '/'),
      ])),
      guideMuteCueIds: Object.fromEntries(Object.entries(options.guideMuteCueIds ?? {}).map(([speaker, cueIds]) => [
        speaker,
        [...cueIds].sort(),
      ])),
      quality,
    },
  }, null, 2)}\n`);

  return {
    master: files.master,
    stems: {
      dialogue: files.dialogue,
      ambience: files.ambience,
      foley: files.foley,
      stings: files.stings,
    },
    foleyEvents: { file: files.events, events: renderedFoley.events },
    guides,
    quality,
    soundtrackManifest,
    durationMs,
  };
}

/** Backwards-compatible master-only facade used by existing callers. */
export async function mixSceneAudio(
  scene: string,
  shots: ShotList,
  placements: AudioPlacement[],
  durationMs: number,
  options: ProductionAudioOptions = {},
): Promise<string> {
  return (await mixProductionAudio(scene, shots, placements, durationMs, options)).master;
}

/** Slice a placement in selected-asset coordinates after bus-rate conversion. */
export function trimPlacementSamples(
  samples: Float64Array,
  placement: Pick<AudioPlacement, 'file' | 'sourceInMs' | 'sourceOutMs' | 'playbackDurationMs'>,
): Float64Array {
  if (
    placement.sourceInMs === undefined && placement.sourceOutMs === undefined &&
    placement.playbackDurationMs === undefined
  ) return samples;

  const durationMs = (samples.length / BUS_RATE) * 1000;
  const inMs = placement.sourceInMs ?? 0;
  const requestedOutMs = placement.sourceOutMs ?? durationMs;
  // Dialogue asset metadata is integer milliseconds and the schema permits a
  // two-millisecond decode-rounding difference. Clamp that harmless edge;
  // anything larger still identifies stale or incorrect metadata.
  const toleranceMs = 2 + 1000 / BUS_RATE;
  if (
    !Number.isFinite(inMs) || !Number.isFinite(requestedOutMs) ||
    inMs < 0 || requestedOutMs <= inMs || requestedOutMs > durationMs + toleranceMs
  ) {
    throw new Error(
      `${placement.file}: invalid source trim ${inMs}-${requestedOutMs}ms for ${durationMs.toFixed(2)}ms audio`,
    );
  }

  const start = Math.round((inMs / 1000) * BUS_RATE);
  const end = Math.min(samples.length, Math.round((requestedOutMs / 1000) * BUS_RATE));
  if (end <= start) throw new Error(`${placement.file}: source trim contains no samples`);
  const trimmed = samples.slice(start, end);
  if (placement.playbackDurationMs === undefined) return trimmed;
  const targetSamples = Math.max(1, Math.round((placement.playbackDurationMs / 1000) * BUS_RATE));
  if (trimmed.length === targetSamples) return trimmed;
  if (trimmed.length > targetSamples) return trimmed.slice(0, targetSamples);
  const fitted = new Float64Array(targetSamples);
  fitted.set(trimmed);
  return fitted;
}

/**
 * The engine whose cache the on-disk soundtrack points into.
 *
 * Anything replaying an existing mix — the preview above all — must resolve
 * timings against this engine, not the default, or a track built with another
 * engine reads as missing takes and triggers synthesis nobody asked for.
 */
export async function soundtrackEngine(scene: string): Promise<string> {
  try {
    const stored = JSON.parse(await fs.readFile(soundtrackManifestPath(scene), 'utf8')) as { engine?: string };
    return stored.engine ?? 'chatterbox';
  } catch {
    return 'chatterbox';
  }
}

/** The scene's room-tone bed, or null when the show or profile says silence. */
async function sceneAmbience(shots: ShotList, durationMs: number): Promise<BusClip | null> {
  const identity = activeIdentity();
  const settings = identity.audio.ambience;
  if (!settings.enabled) return null;

  const profile = await resolveAcousticProfile(shots.set);
  if (profile === 'silence') return null;

  const bed = renderAmbience(profile, deriveSeed(identity.seed, `scene-ambience:${shots.seed}`), durationMs);
  const measured = rmsDb(bed);
  if (!Number.isFinite(measured)) return null;

  // The recipes are voiced for character, not calibrated for level; the trim to
  // the profile's target happens here so every bed sits at the same loudness.
  return { samples: bed, startMs: 0, gain: db(settings.levelDb - measured) };
}

/** The acoustic profile the scene's room tone renders with, set overrides included. */
export async function resolveAcousticProfile(setName: string | null): Promise<AcousticProfile> {
  const identity = activeIdentity();
  if (setName) {
    const override = identity.audio.ambience.setProfiles[setName];
    if (override && (ACOUSTIC_PROFILES as readonly string[]).includes(override)) {
      return override as AcousticProfile;
    }
  }
  return acousticProfileFor(await paletteOf(setName));
}

async function paletteOf(setName: string | null): Promise<string | null> {
  if (!setName) return null;
  try {
    return (await loadSet(setName)).palette;
  } catch {
    return BUILTIN_SETS[setName]?.palette ?? null;
  }
}

// --- soundtrack fingerprint ----------------------------------------------

export function soundtrackManifestPath(scene: string): string {
  return path.join(sceneDir(scene), 'soundtrack.json');
}

// v6: dialogue upsampling moved from linear interpolation to windowed sinc,
// which changes master bytes; stale soundtracks must remix.
export const AUDIO_TIMELINE_VERSION = 6;

export interface SoundtrackPlacementFingerprint {
  key: string;
  speaker: string | null;
  startMs: number;
  sourceInMs: number | null;
  sourceOutMs: number | null;
  playbackDurationMs: number | null;
  speechOnsetMs: number | null;
  speechEndMs: number | null;
  turnGapMs: number;
  pickupMs: number;
  pauseAfterMs: number;
  overlapMs: number;
  overlapMode: 'pickup' | 'overlap' | 'interruption' | null;
  overlapWithCueId: string | null;
  interruptAtMs: number | null;
  editorialTiming: boolean;
  cueId: string | null;
  selectionKey: string | null;
  timingKey: string | null;
}

export interface SoundtrackFingerprint {
  /** Everything the track depends on, hashed field-by-field for diffability. */
  timelineVersion: number;
  /** The TTS engine whose cache the placements point into. */
  engine: string;
  programKey: string;
  durationMs: number;
  identity: { id: string; version: string; hash: string };
  placements: SoundtrackPlacementFingerprint[];
  ambience: { profile: string; levelDb: number; enabled: boolean };
  cards: { enabled: boolean; titleMs: number; endMs: number; titleFrames: number; endFrames: number };
  mix: { targetRmsDb: number; ceilingDb: number };
}

/**
 * What the soundtrack was (or would be) built from.
 *
 * Placement keys for cached synthesis are the cache filenames — already
 * content-addressed — and recorded VO hashes its bytes, so a re-recorded
 * override changes the fingerprint the same way a re-cloned voice does.
 * Computing this never synthesizes anything; it is cheap enough to run on
 * every request that serves audio.
 */
export async function soundtrackFingerprint(
  scene: string,
  shots: ShotList,
  placements: AudioPlacement[],
  durationMs: number,
  engine = 'chatterbox',
): Promise<SoundtrackFingerprint> {
  const identity = activeIdentity();
  const keyed: SoundtrackPlacementFingerprint[] = [];
  for (const p of placements) {
    keyed.push(placementFingerprint(p, await placementKey(p.file)));
  }

  return {
    timelineVersion: AUDIO_TIMELINE_VERSION,
    engine,
    programKey: soundtrackProgramKey(shots, keyed),
    durationMs,
    identity: stampOf(identity),
    placements: keyed,
    ambience: {
      profile: await resolveAcousticProfile(shots.set),
      levelDb: identity.audio.ambience.levelDb,
      enabled: identity.audio.ambience.enabled,
    },
    cards: { enabled: shots.cards, ...cardTiming(shots) },
    mix: identity.audio.mix,
  };
}

function placementFingerprint(
  placement: Omit<AudioPlacement, 'file'>,
  key: string,
): SoundtrackPlacementFingerprint {
  const hasExplicitSpeechBounds =
    placement.sourceInMs !== undefined || placement.sourceOutMs !== undefined;
  return {
    key,
    speaker: placement.speaker ?? null,
    startMs: placement.startMs,
    sourceInMs: placement.sourceInMs ?? null,
    sourceOutMs: placement.sourceOutMs ?? null,
    playbackDurationMs: placement.playbackDurationMs ?? null,
    // Full-file speech bounds are implied by the content key. Keeping only
    // authored bounds makes currentness cheap for cached synthesis.
    speechOnsetMs: hasExplicitSpeechBounds ? (placement.speechOnsetMs ?? null) : null,
    speechEndMs: hasExplicitSpeechBounds ? (placement.speechEndMs ?? null) : null,
    turnGapMs: placement.turnGapMs ?? 0,
    pickupMs: placement.pickupMs ?? 0,
    pauseAfterMs: placement.pauseAfterMs ?? 0,
    overlapMs: placement.overlapMs ?? 0,
    overlapMode: placement.overlapMode ?? null,
    overlapWithCueId: placement.overlapWithCueId ?? null,
    interruptAtMs: placement.interruptAtMs ?? null,
    editorialTiming: placement.editorialTiming ?? false,
    cueId: placement.cueId ?? null,
    selectionKey: placement.selectionKey ?? null,
    timingKey: placement.timingKey ?? null,
  };
}

function soundtrackProgramKey(
  shots: ShotList,
  placements: SoundtrackPlacementFingerprint[],
): string {
  const beats = shots.beats.map((beat) => {
    if (beat.kind === 'line') return { kind: beat.kind, id: beat.id };
    if (beat.kind === 'action') {
      return {
        kind: beat.kind,
        id: beat.id,
        ms: beat.ms,
        stage: beat.stage,
        unsupported: beat.unsupported,
      };
    }
    return { kind: beat.kind, id: beat.id, ms: beat.ms };
  });
  const sources = placements.map(({ startMs: _startMs, ...placement }) => placement);
  return crypto.createHash('sha1').update(JSON.stringify({
    timelineVersion: AUDIO_TIMELINE_VERSION,
    fps: shots.fps,
    seed: shots.seed,
    beats,
    sources,
  })).digest('hex');
}

function placementForCue(
  cue: DialogueCue,
  selectionKey: string,
  fps: number,
): Omit<AudioPlacement, 'file'> {
  let sourceInMs = cue.trim?.inMs;
  let sourceOutMs = cue.trim?.outMs;
  let speechOnsetMs = cue.trim ? cue.trim.speechOnsetMs - cue.trim.inMs : undefined;
  let speechEndMs = cue.trim ? cue.trim.speechEndMs - cue.trim.inMs : undefined;
  let playbackDurationMs: number | undefined;
  if (cue.durationPolicy.mode !== 'follow-performance' && cue.durationPolicy.targetFrames) {
    const targetMs = (cue.durationPolicy.targetFrames / fps) * 1000;
    playbackDurationMs = targetMs;
    if (cue.durationPolicy.mode === 'fit-locked-window' && cue.trim) {
      let durationMs = cue.trim.outMs - cue.trim.inMs;
      let removeMs = Math.max(0, durationMs - targetMs);
      const tail = Math.min(removeMs, Math.max(0, durationMs - (speechEndMs ?? durationMs)));
      sourceOutMs = cue.trim.outMs - tail;
      durationMs -= tail;
      removeMs -= tail;
      const head = Math.min(removeMs, Math.max(0, speechOnsetMs ?? 0));
      sourceInMs = cue.trim.inMs + head;
      speechOnsetMs = (speechOnsetMs ?? 0) - head;
      speechEndMs = (speechEndMs ?? durationMs) - head;
    }
  }
  return {
    startMs: 0,
    speaker: cue.speaker,
    sourceInMs,
    sourceOutMs,
    playbackDurationMs,
    speechOnsetMs,
    speechEndMs,
    turnGapMs: cue.turnGapMs,
    pickupMs: cue.pickupMs,
    pauseAfterMs: cue.pauseAfterMs,
    overlapMs: cue.overlap?.ms ?? 0,
    overlapMode: cue.overlap?.mode,
    overlapWithCueId: cue.overlap?.withCueId,
    interruptAtMs: cue.overlap?.interruptAtMs,
    editorialTiming: cueUsesEditorialTiming(cue),
    cueId: cue.id,
    selectionKey,
    timingKey: dialogueCueTimingKey(cue),
  };
}

/** Cache files are content-addressed by name; anything else is hashed by bytes. */
async function placementKey(file: string): Promise<string> {
  const base = path.basename(file);
  if (file.includes(`.cache${path.sep}voice`) || /^[0-9a-f]{40}\.wav$/.test(base)) return base;
  try {
    return crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex');
  } catch {
    return `missing:${base}`;
  }
}

/** Does the on-disk soundtrack still match what this shot list would build? */
export async function soundtrackIsCurrent(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
): Promise<boolean> {
  let stored: SoundtrackFingerprint;
  try {
    stored = JSON.parse(await fs.readFile(soundtrackManifestPath(scene), 'utf8')) as SoundtrackFingerprint;
  } catch {
    return false;
  }
  if (stored.timelineVersion !== AUDIO_TIMELINE_VERSION) return false;
  // Tracks built before the engine was recorded were all chatterbox.
  const engine = stored.engine ?? 'chatterbox';

  // Recompute what the placements *would* be, purely from cache keys — no
  // synthesis. A line whose take isn't cached yet makes the track stale by
  // definition.
  try {
    const document = await readDialogueDocument(scene);
    if (document?.scriptHash && document.scriptHash !== dialogueScriptHash(shots)) return false;
    const cues = new Map(document?.cues.map((cue) => [cue.id, cue]) ?? []);
    const expected: SoundtrackPlacementFingerprint[] = [];

    for (let i = 0; i < shots.beats.length; i++) {
      const beat = shots.beats[i]!;
      if (beat.kind !== 'line') continue;
      const cue = cues.get(beat.id);

      if (cue && document && (cue.selectedRenderId || cue.selectedTakeId)) {
        const selected = selectedDialogueAsset(scene, cue, document, OUT_DIR);
        if (!selected) return false;
        await verifySelectedDialogueAsset(cue.id, selected);
        expected.push(placementFingerprint(
          placementForCue(cue, selected.selectionKey, shots.fps),
          await placementKey(selected.file),
        ));
        continue;
      }

      const vo = voPath(scene, i, beat.speaker);
      if (await exists(vo)) {
      const placement: Omit<AudioPlacement, 'file'> = cue
          ? placementForCue(cue, 'legacy-vo', shots.fps)
          : { startMs: 0, speaker: beat.speaker };
        expected.push(placementFingerprint(placement, await placementKey(vo)));
        continue;
      }

      const rig = rigs.get(shots.cast.find((c) => c.id === beat.speaker)?.rig ?? '')?.rig;
      if (!rig) return false;
      const key = await lineCacheKey(engine, {
        id: String(i),
        text: cue?.spokenText ?? beat.text,
        expression: cue?.delivery.expression || beat.expression,
        voice: rig.voice,
        rate: rig.voiceRate,
        ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
        persona: cue ? cuePersona(rig, cue) : rig.voicePersona,
        seed: cue?.seed ?? shots.seed * 1000 + i,
      });
      const placement: Omit<AudioPlacement, 'file'> = cue
        ? placementForCue(cue, `tts:${engine}`, shots.fps)
        : { startMs: 0, speaker: beat.speaker };
      expected.push(placementFingerprint(placement, `${key}.wav`));
    }

    if (expected.length !== stored.placements.length) return false;
    const withoutStart = (placement: SoundtrackPlacementFingerprint) => {
      const { startMs: _startMs, ...rest } = placement;
      return rest;
    };
    if (!expected.every((item, index) => (
      JSON.stringify(withoutStart(stored.placements[index]!)) ===
      JSON.stringify(withoutStart(item))
    ))) return false;
    if (stored.programKey !== soundtrackProgramKey(shots, expected)) return false;
  } catch {
    return false;
  }

  const now = await soundtrackFingerprint(scene, shots, [], 0);
  return (
    stored.identity.hash === now.identity.hash &&
    JSON.stringify(stored.ambience) === JSON.stringify(now.ambience) &&
    JSON.stringify(stored.cards) === JSON.stringify(now.cards) &&
    JSON.stringify(stored.mix) === JSON.stringify(now.mix)
  );
}
