import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR } from '../core/paths.ts';
import { Rng, deriveSeed } from '../core/rng.ts';
import { streamSeed, STREAMS } from '../core/streams.ts';
import { activeIdentity } from '../show/context.ts';
import { ffmpegPath } from '../render/encode.ts';
import { getEngine } from './index.ts';
import { referencePath } from './reference.ts';
import { loadRig, saveRig } from '../cast/store.ts';

/**
 * Minting voices.
 *
 * Chatterbox has exactly one built-in voice. Without a reference clip every
 * character clones nobody and speaks as that same person — a cast of twelve
 * with one voice between them. Minting manufactures a distinct, *stable*
 * reference per character with nothing downloaded and nothing recorded:
 *
 *   1. synthesize a fixed neutral paragraph with the built-in voice, seeded
 *      from the character's voice stream so the take itself is reproducible;
 *   2. bend it through a deterministic pitch/tempo transform whose parameters
 *      are rolled from the same stream — this is what makes it a different
 *      person rather than a different reading;
 *   3. normalise it into `cast/<name>.ref.wav`, where every later line clones
 *      from it.
 *
 * The reference is the identity anchor: once it exists, takes vary but the
 * speaker never drifts. Provenance is recorded as `minted`, so the UI can
 * offer rerolls freely — a recorded clip is someone's explicit choice and is
 * never replaced by this machinery.
 *
 * Honestly experimental where it says it is: cloning from pitch-shifted audio
 * is verified by ear through the audition flow, and a real recording always
 * wins if a minted voice sounds off.
 */

/**
 * What the mint reads aloud. Fixed forever: changing it changes every future
 * mint, and it is chosen for phonetic coverage at a neutral register rather
 * than for content — plosives, sibilants, long vowels, one question.
 */
const MINT_TEXT =
  'Here is the situation as I understand it. The building is open, the paperwork is due, ' +
  'and somebody has moved the good chairs again. Who does that? Either way, we carry on, ' +
  'same as always, until somebody tells us otherwise.';

/**
 * Base timbres.
 *
 * Pitch-shifting one voice only stretches so far — six shifts of the same man
 * are still the same man. The mint therefore starts from one of three sources:
 * the neural default, or a SAPI voice (Zira female, David male) reading the
 * paragraph. Cloning launders SAPI's robotic prosody into natural speech while
 * keeping the timbre — measured, a Zira-based mint clones at ~190 Hz against
 * the neural base's ~110 Hz — so the cast gets genuine register variety, not
 * six transpositions.
 */
export type MintBase = 'neural' | 'zira' | 'david';

/**
 * Pitch/tempo spread. Wider than feels right on the reference clip itself,
 * because cloning pulls pitch back toward the model's comfortable register —
 * measured on a six-voice cast, roughly half the shift survives into the
 * cloned speech. SAPI bases take smaller shifts; their timbre is already
 * distinct.
 */
const SPREAD: Record<MintBase, { min: number; max: number }> = {
  neural: { min: 2.2, max: 6.5 },
  zira: { min: 0.8, max: 3.5 },
  david: { min: 0.8, max: 3.5 },
};
const TEMPO_SPREAD = 0.09;

export interface MintParams {
  base: MintBase;
  seed: number;
  semitones: number;
  tempo: number;
}

/**
 * The transform a given character + salt resolves to. Pure and stable.
 *
 * Draw order is part of the contract: base first, then seed, then shift and
 * tempo. Reordering draws would silently recast every minted character.
 */
export function mintParams(charId: string, salt = ''): MintParams {
  const rng = new Rng(deriveSeed(streamSeed(activeIdentity(), STREAMS.voice, charId), `mint:${salt}`));

  const roll = rng.next();
  const base: MintBase = roll < 0.4 ? 'neural' : roll < 0.75 ? 'zira' : 'david';
  const spread = SPREAD[base];
  // Push away from the centre: a small shift just sounds like the same voice
  // on an off day, which defeats the purpose.
  const sign = rng.chance(0.5) ? 1 : -1;

  return {
    base,
    seed: rng.int(1, 2 ** 30),
    semitones: sign * rng.range(spread.min, spread.max),
    tempo: 1 + rng.range(-TEMPO_SPREAD, TEMPO_SPREAD),
  };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => reject(new Error(`could not run ffmpeg: ${err.message}`)));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr.split('\n').slice(-8).join('\n')}`)));
  });
}

/** Directory candidate clips wait in until one is committed. */
function candidateDir(): string {
  return path.join(CAST_DIR, '.candidates');
}

export function candidatePath(character: string, salt: string): string {
  return path.join(candidateDir(), `${character}.${salt || 'default'}.wav`);
}

/**
 * Mint one candidate reference clip to a target path.
 *
 * Synthesis goes through the ordinary engine (and its cache — repeated mints
 * of the same params are free), then ffmpeg applies the pitch/tempo identity
 * transform with loudness normalisation in the same pass.
 */
interface MintTask {
  charId: string;
  salt: string;
  out: string;
}

/**
 * Mint a batch of reference clips.
 *
 * One engine call for every base take — the model load costs tens of seconds
 * and dominates everything else, so a whole cast (or a fistful of candidates)
 * synthesizes on a single load. ffmpeg then applies each character's
 * pitch/tempo identity transform: asetrate shifts pitch and formants together
 * (which is what changes the apparent speaker), atempo undoes the duration
 * change and applies the character's own tempo, and loudnorm levels the lot.
 * 4.2.3-safe filters only.
 */
async function mintBatch(
  tasks: MintTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, MintParams>> {
  if (!tasks.length) return new Map();

  await fs.mkdir(candidateDir(), { recursive: true });
  const jobDir = await fs.mkdtemp(path.join(candidateDir(), 'mint-'));
  const results = new Map<string, MintParams>();

  try {
    const params = tasks.map((t) => mintParams(t.charId, t.salt));

    // Base takes, batched per engine: every neural base shares one model load,
    // and the SAPI bases are near-free. A SAPI base falling over (voice not
    // installed) falls back to the neural default rather than failing the cast.
    const request = (t: MintTask, i: number, voice: string) => ({
      id: `${t.charId}:${t.salt}`,
      out: path.join(jobDir, `base-${i}.wav`),
      text: MINT_TEXT,
      voice,
      rate: 0,
      exaggeration: 0.45,
      cfgWeight: 0.5,
      ref: null,
      seed: params[i]!.seed,
    });

    const sapiIdx = tasks.map((_, i) => i).filter((i) => params[i]!.base !== 'neural');
    let sapiOk = false;
    if (sapiIdx.length) {
      try {
        const sapi = getEngine('sapi');
        const takes = await sapi.synth(sapiIdx.map((i) => request(tasks[i]!, i, params[i]!.base === 'zira' ? 'Zira' : 'David')));
        sapiOk = sapiIdx.every((i) => takes.has(`${tasks[i]!.charId}:${tasks[i]!.salt}`));
      } catch {
        sapiOk = false;
      }
      if (!sapiOk) for (const i of sapiIdx) params[i]!.base = 'neural';
    }

    const neuralIdx = tasks.map((_, i) => i).filter((i) => params[i]!.base === 'neural');
    if (neuralIdx.length) {
      const engine = getEngine('chatterbox');
      const availability = await engine.available();
      if (!availability.ok) throw new Error(`cannot mint a voice: ${availability.reason}`);
      const takes = await engine.synth(neuralIdx.map((i) => request(tasks[i]!, i, '')), onProgress);
      for (const i of neuralIdx) {
        if (!takes.has(`${tasks[i]!.charId}:${tasks[i]!.salt}`)) {
          throw new Error(`the engine returned no audio for mint ${tasks[i]!.charId}`);
        }
      }
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const p = params[i]!;
      const base = path.join(jobDir, `base-${i}.wav`);

      const k = Math.pow(2, p.semitones / 12);
      const atempo = (1 / k) * p.tempo;
      await runFfmpeg([
        '-y', '-i', base,
        '-af',
        // asetrate against the *source* rate (SAPI writes 22.05k, the neural
        // engine 24k), resampled onto the reference format after.
        `aresample=24000,asetrate=24000*${k.toFixed(6)},aresample=24000,atempo=${atempo.toFixed(6)},loudnorm=I=-18:TP=-2:LRA=11`,
        '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
        // Explicit container: commit targets are .tmp files that rename into
        // place, and ffmpeg cannot guess a format from that extension.
        '-f', 'wav',
        task.out,
      ]);
      results.set(`${task.charId}:${task.salt}`, p);
    }
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true });
  }

  return results;
}

export interface MintedCandidate {
  salt: string;
  file: string;
  params: MintParams;
}

/** Mint several distinct candidates for auditioning side by side. One model load. */
export async function mintCandidates(character: string, charId: string, count = 3): Promise<MintedCandidate[]> {
  const tasks: MintTask[] = Array.from({ length: count }, (_, i) => ({
    charId,
    salt: String(i),
    out: candidatePath(character, String(i)),
  }));
  const params = await mintBatch(tasks);
  return tasks.map((t) => ({ salt: t.salt, file: t.out, params: params.get(`${t.charId}:${t.salt}`)! }));
}

/**
 * Commit a candidate as the character's reference, atomically.
 *
 * The clip is finished before it appears at the reference path — a crash
 * mid-commit leaves the old voice intact, never half a new one. Provenance
 * records the mint so the choice is distinguishable from a recording and
 * reproducible from its seed.
 */
export async function commitCandidate(character: string, salt: string): Promise<void> {
  const from = candidatePath(character, salt);
  const to = referencePath(character);
  const data = await fs.readFile(from);

  const tmp = `${to}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, to);

  const { rig, svg } = await loadRig(character);
  const params = mintParams(rig.charId ?? character, salt);
  await saveRig(
    {
      ...rig,
      voiceRef: path.basename(to),
      voiceProvenance: {
        source: 'minted',
        seed: params.seed,
        hash: crypto.createHash('sha1').update(data).digest('hex'),
      },
    },
    svg,
  );
  await discardCandidates(character);
}

export async function discardCandidates(character: string): Promise<void> {
  try {
    const files = await fs.readdir(candidateDir());
    await Promise.all(
      files.filter((f) => f.startsWith(`${character}.`)).map((f) => fs.rm(path.join(candidateDir(), f), { force: true })),
    );
  } catch {
    // No candidate directory: nothing to discard.
  }
}

/**
 * Mint and commit the default voice for every listed character that needs one.
 *
 * The render-time preflight. Deliberately narrow: it only touches characters
 * with no reference at all, minting their unsalted default — it re-decides
 * nothing, so an accepted voice (minted or recorded) is never disturbed. A
 * per-run lock set stops two concurrent jobs minting the same character.
 */
const minting = new Set<string>();

export async function ensureVoiceRefs(
  characters: Array<{ name: string; charId: string | undefined; voiceRef: string | null }>,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<string[]> {
  const need = characters.filter((c) => !c.voiceRef && !minting.has(c.name));
  if (!need.length) return [];

  for (const c of need) minting.add(c.name);
  const minted: string[] = [];

  try {
    // The whole cast mints on one model load; commits happen per character so
    // a failure partway leaves everyone before it fully cast, nobody half-cast.
    const tasks: MintTask[] = need.map((c) => ({
      charId: c.charId ?? c.name,
      salt: '',
      out: `${referencePath(c.name)}.tmp`,
    }));
    const params = await mintBatch(tasks, (done, total) =>
      onProgress?.(done, total, need[Math.min(done, need.length - 1)]!.name));

    for (let i = 0; i < need.length; i++) {
      const c = need[i]!;
      const out = referencePath(c.name);
      await fs.rename(tasks[i]!.out, out);

      const { rig, svg } = await loadRig(c.name);
      const data = await fs.readFile(out);
      const p = params.get(`${tasks[i]!.charId}:`)!;
      await saveRig(
        {
          ...rig,
          voiceRef: path.basename(out),
          voiceProvenance: {
            source: 'minted',
            seed: p.seed,
            hash: crypto.createHash('sha1').update(data).digest('hex'),
          },
        },
        svg,
      );
      minted.push(c.name);
      onProgress?.(i + 1, need.length, c.name);
    }
  } finally {
    for (const c of need) minting.delete(c.name);
  }
  return minted;
}
