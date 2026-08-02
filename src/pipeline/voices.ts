import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR, sceneDir } from '../core/paths.ts';
import { deriveSeed } from '../core/rng.ts';
import { activeIdentity } from '../show/context.ts';
import { stampOf } from '../schema/identity.ts';
import {
  synthesizeLines, loadRecordedVo, estimateMouthCues, lineCacheKey,
  type LineTiming, type VoiceLine,
} from '../voice/index.ts';
import { ensureVoiceRefs } from '../voice/casting.ts';
import { readWav } from '../voice/wav.ts';
import { toBusSamples, fadeEdges, masterToWav, rmsDb, db, type BusClip } from '../audio/bus.ts';
import { renderAmbience, acousticProfileFor, ACOUSTIC_PROFILES, type AcousticProfile } from '../audio/ambience.ts';
import { loadSet } from '../sets/index.ts';
import { BUILTIN_SETS } from '../sets/builtins.ts';
import { estimateLineMs } from '../compile/scene.ts';
import { exists, voPath } from './scene.ts';
import { listRigs, loadRig } from '../cast/store.ts';
import type { ShotList } from '../schema/script.ts';
import type { LoadedRig } from '../cast/store.ts';

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
}

export async function resolveTimings(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  opts: VoiceOptions,
): Promise<Map<number, LineTiming>> {
  const timings = new Map<number, LineTiming>();
  const toSynth: VoiceLine[] = [];
  const beatOfLine = new Map<string, number>();

  // Which rigs actually need synthesis: a character whose every line is a
  // recorded VO override never needs a cloning reference at all.
  const needsSynth = new Set<string>();
  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;
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
    const rig = rigs.get(member.rig)?.rig;
    if (!rig) throw new Error(`no rig loaded for "${member.rig}"`);

    const vo = voPath(scene, i, beat.speaker);
    if (await exists(vo)) {
      timings.set(i, await loadRecordedVo(vo, beat.text));
      continue;
    }

    const id = `${scene}-${i}`;
    beatOfLine.set(id, i);
    toSynth.push({
      id,
      text: beat.text,
      expression: beat.expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
      persona: rig.voicePersona,
      // Derived from the scene seed, so a take is stable across re-renders but
      // differs line to line.
      seed: shots.seed * 1000 + i,
    });
  }

  if (toSynth.length) {
    const rendered = await synthesizeLines(toSynth, { engine: opts.engine, onProgress: opts.onProgress });
    for (const [id, timing] of rendered) timings.set(beatOfLine.get(id)!, timing);
  }

  return timings;
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
    timings.set(i, { audio: '', durationMs, cues: estimateMouthCues(beat.text, durationMs) });
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
export async function mixSceneAudio(
  scene: string,
  shots: ShotList,
  placements: Array<{ file: string; startMs: number }>,
  durationMs: number,
): Promise<string> {
  const identity = activeIdentity();
  const audio = identity.audio;
  const out = path.join(sceneDir(scene), 'dialogue.wav');
  await fs.mkdir(sceneDir(scene), { recursive: true });

  const clips: BusClip[] = [];
  for (const placement of placements) {
    const samples = toBusSamples(await readWav(placement.file), placement.file);
    // Edge fades kill boundary clicks without touching the body of the take.
    clips.push({ samples: fadeEdges(samples, 4), startMs: placement.startMs });
  }

  const ambience = await sceneAmbience(shots, durationMs);
  if (ambience) clips.push(ambience);

  await fs.writeFile(
    out,
    masterToWav(clips, {
      durationMs,
      targetRmsDb: audio.mix.targetRmsDb,
      ceilingDb: audio.mix.ceilingDb,
    }),
  );

  await fs.writeFile(
    soundtrackManifestPath(scene),
    JSON.stringify(await soundtrackFingerprint(scene, shots, placements, durationMs), null, 2) + '\n',
    'utf8',
  );
  return out;
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

async function resolveAcousticProfile(setName: string | null): Promise<AcousticProfile> {
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

export interface SoundtrackFingerprint {
  /** Everything the track depends on, hashed field-by-field for diffability. */
  durationMs: number;
  identity: { id: string; version: string; hash: string };
  placements: Array<{ key: string; startMs: number }>;
  ambience: { profile: string; levelDb: number; enabled: boolean };
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
  placements: Array<{ file: string; startMs: number }>,
  durationMs: number,
): Promise<SoundtrackFingerprint> {
  const identity = activeIdentity();
  const keyed = [];
  for (const p of placements) {
    keyed.push({ key: await placementKey(p.file), startMs: p.startMs });
  }

  return {
    durationMs,
    identity: stampOf(identity),
    placements: keyed,
    ambience: {
      profile: await resolveAcousticProfile(shots.set),
      levelDb: identity.audio.ambience.levelDb,
      enabled: identity.audio.ambience.enabled,
    },
    mix: identity.audio.mix,
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

  // Recompute what the placements *would* be, purely from cache keys — no
  // synthesis. A line whose take isn't cached yet makes the track stale by
  // definition.
  const expected: Array<{ key: string }> = [];
  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;

    const vo = voPath(scene, i, beat.speaker);
    if (await exists(vo)) {
      expected.push({ key: await placementKey(vo) });
      continue;
    }
    const rig = rigs.get(shots.cast.find((c) => c.id === beat.speaker)?.rig ?? '')?.rig;
    if (!rig) return false;
    const key = await lineCacheKey('chatterbox', {
      id: String(i),
      text: beat.text,
      expression: beat.expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
      persona: rig.voicePersona,
      seed: shots.seed * 1000 + i,
    });
    expected.push({ key: `${key}.wav` });
  }

  if (expected.length !== stored.placements.length) return false;
  if (!expected.every((e, i) => stored.placements[i]!.key === e.key)) return false;

  const now = await soundtrackFingerprint(scene, shots, [], 0);
  return (
    stored.identity.hash === now.identity.hash &&
    JSON.stringify(stored.ambience) === JSON.stringify(now.ambience) &&
    JSON.stringify(stored.mix) === JSON.stringify(now.mix)
  );
}
