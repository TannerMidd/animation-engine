import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR } from '../core/paths.ts';
import { Rng, deriveSeed } from '../core/rng.ts';
import { streamSeed, STREAMS } from '../core/streams.ts';
import { activeIdentity } from '../show/context.ts';
import { ffmpegPath } from '../render/encode.ts';
import { kokoroAvailable, kokoroMint, type KokoroMintItem } from './engines/kokoro.ts';
import { referencePath } from './reference.ts';
import { loadRig, saveRig, listRigs } from '../cast/store.ts';

/**
 * Minting voices.
 *
 * Chatterbox has exactly one built-in voice. Without a reference clip every
 * character clones nobody and speaks as that same person — a cast of twelve
 * with one voice between them. Minting manufactures a distinct, *stable*
 * reference per character with nothing recorded:
 *
 *   1. a curated bank voice (Kokoro-82M, natural human-sounding speech) reads
 *      a fixed neutral paragraph, seeded from the character's voice stream so
 *      the take itself is reproducible;
 *   2. the clip is loudness-normalised into `cast/<name>.ref.wav`, where every
 *      later line clones from it.
 *
 * The reference is the identity anchor: once it exists, takes vary but the
 * speaker never drifts. Provenance is recorded as `minted` with the bank
 * voice's name, so the UI can offer rerolls freely — a recorded clip is
 * someone's explicit choice and is never replaced by this machinery.
 *
 * History: minting used to synthesize with SAPI or the neural default and
 * then pitch/tempo-shift the result into a "different person". The robotic
 * SAPI prosody and the shift's formant artifacts cloned straight into every
 * performance — the bank replaces all of that. Distinctness now comes from
 * *actually different human-sounding voices*, and nothing in this chain
 * pitch-shifts anything.
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
 * The curated bank: distinct, natural Kokoro voices, half feminine and half
 * masculine, American and British registers mixed. Two deliberate exclusions:
 * the deepest masculine voices sit near the voice converter's 95 Hz
 * conditioning floor (chatterbox_vc_worker.py lifts references under it, which
 * is exactly the kind of transform minting exists to avoid), and novelty
 * voices don't survive cloning with their character intact.
 */
const VOICE_BANK = [
  'af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore', 'af_sarah',
  'bf_emma', 'bf_isabella',
  'am_michael', 'am_fenrir', 'am_puck', 'am_eric',
  'bm_george', 'bm_fable',
] as const;
// bm_lewis was in the first cut and is out for cause: loudness-normalised it
// measures ~87 Hz, under the converter's 95 Hz conditioning floor, and the
// resulting lift landed conversions ~6 st off register (measured via
// `voices check`). The floor is exactly the transform minting exists to avoid.

export interface MintParams {
  /** Which bank voice read the paragraph. */
  bankVoice: string;
  /** Kokoro's clean duration control, held near 1 — never a pitch shift. */
  speed: number;
  seed: number;
}

/**
 * A character's pure voice preference: a seeded shuffle of the whole bank,
 * plus a slight speed and the synthesis seed. Stable for (charId, salt);
 * the caller resolves the first *available* preference so two characters
 * never share a bank voice while there are voices to spare.
 *
 * Draw order is part of the contract: the shuffle draws first, then speed,
 * then seed. Reordering draws would silently recast every minted character.
 */
export function bankPreference(charId: string, salt = ''): { order: string[]; speed: number; seed: number } {
  const rng = new Rng(deriveSeed(streamSeed(activeIdentity(), STREAMS.voice, charId), `mint:${salt}`));

  const order: string[] = [...VOICE_BANK];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  return {
    order,
    speed: 1 + rng.range(-0.05, 0.05),
    seed: rng.int(1, 2 ** 30),
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
 * Sidecar recording what a candidate actually is. Bank assignment depends on
 * what the rest of the cast has taken *at mint time*, so a commit must read
 * the recorded params rather than recompute them in a possibly-changed cast.
 */
function candidateParamsPath(character: string, salt: string): string {
  return path.join(candidateDir(), `${character}.${salt || 'default'}.json`);
}

interface MintTask {
  /** Cast name, used to exclude the character's own rig from collision checks. */
  character: string;
  charId: string;
  salt: string;
  out: string;
}

/**
 * Resolve tasks to concrete bank voices given what is already taken. The pure
 * core of assignment, separated so the contract is testable: each task takes
 * the first preference not yet claimed, batch order is the tiebreak, and an
 * exhausted bank (a cast larger than the bank) falls back to the raw first
 * preference — differing speed and cloning drift keep reused bases apart, and
 * that is still a stronger guarantee than the three shared bases the old
 * pitch-shift mint chain had.
 */
export function resolveBankAssignments(
  tasks: Array<{ charId: string; salt: string }>,
  taken: ReadonlySet<string>,
): MintParams[] {
  const claimed = new Set(taken);
  return tasks.map((t) => {
    const pref = bankPreference(t.charId, t.salt);
    const bankVoice = pref.order.find((v) => !claimed.has(v)) ?? pref.order[0]!;
    if (claimed.has(bankVoice)) {
      console.warn(`voice bank exhausted: reusing ${bankVoice} for ${t.charId}`);
    }
    claimed.add(bankVoice);
    return { bankVoice, speed: pref.speed, seed: pref.seed };
  });
}

/**
 * Collect the bank voices committed on every *other* character's rig, then
 * assign. A character re-minting keeps its own current voice out of the taken
 * set — a reroll is allowed to land back on the same base.
 */
async function assignBankVoices(tasks: MintTask[]): Promise<MintParams[]> {
  const mintingNow = new Set(tasks.map((t) => t.character));
  const taken = new Set<string>();
  try {
    for (const name of await listRigs()) {
      if (mintingNow.has(name)) continue;
      try {
        const { rig } = await loadRig(name);
        const bankVoice = rig.voiceProvenance?.bankVoice;
        if (bankVoice) taken.add(bankVoice);
      } catch {
        // A broken rig can't hold a voice.
      }
    }
  } catch {
    // No cast directory yet: nothing is taken.
  }

  return resolveBankAssignments(tasks, taken);
}

/**
 * Mint a batch of reference clips.
 *
 * One worker spawn for the whole batch — the model load dominates everything
 * else, so a whole cast (or a fistful of candidates) synthesizes on a single
 * load. ffmpeg then only levels the result onto the reference format: same
 * loudness contract as an uploaded recording, no other processing.
 */
async function mintBatch(
  tasks: MintTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, MintParams>> {
  if (!tasks.length) return new Map();

  const params = await assignBankVoices(tasks);

  const availability = await kokoroAvailable([...new Set(params.map((p) => p.bankVoice))]);
  if (!availability.ok) throw new Error(`cannot mint a voice: ${availability.reason}`);

  await fs.mkdir(candidateDir(), { recursive: true });
  const jobDir = await fs.mkdtemp(path.join(candidateDir(), 'mint-'));
  const results = new Map<string, MintParams>();

  try {
    const items: KokoroMintItem[] = tasks.map((t, i) => ({
      id: `${t.charId}:${t.salt}`,
      out: path.join(jobDir, `base-${i}.wav`),
      text: MINT_TEXT,
      bankVoice: params[i]!.bankVoice,
      speed: params[i]!.speed,
      seed: params[i]!.seed,
    }));

    const takes = await kokoroMint(items, onProgress);
    for (const t of tasks) {
      if (!takes.has(`${t.charId}:${t.salt}`)) {
        throw new Error(`the engine returned no audio for mint ${t.charId}`);
      }
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      await runFfmpeg([
        '-y', '-i', path.join(jobDir, `base-${i}.wav`),
        '-af', 'aresample=24000,loudnorm=I=-18:TP=-2:LRA=11',
        '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
        // Explicit container: commit targets are .tmp files that rename into
        // place, and ffmpeg cannot guess a format from that extension.
        '-f', 'wav',
        task.out,
      ]);
      results.set(`${task.charId}:${task.salt}`, params[i]!);
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
    character,
    charId,
    salt: String(i),
    out: candidatePath(character, String(i)),
  }));
  const params = await mintBatch(tasks);

  const candidates: MintedCandidate[] = [];
  for (const t of tasks) {
    const p = params.get(`${t.charId}:${t.salt}`)!;
    // The sidecar is what commit reads; without it a commit would have to
    // re-run assignment inside a cast that may have changed since the mint.
    await fs.writeFile(candidateParamsPath(character, t.salt), JSON.stringify(p, null, 2), 'utf8');
    candidates.push({ salt: t.salt, file: t.out, params: p });
  }
  return candidates;
}

/**
 * Commit a candidate as the character's reference, atomically.
 *
 * The clip is finished before it appears at the reference path — a crash
 * mid-commit leaves the old voice intact, never half a new one. Provenance
 * records the mint (bank voice included) so the choice is distinguishable
 * from a recording and reproducible from its seed.
 */
export async function commitCandidate(character: string, salt: string): Promise<void> {
  const from = candidatePath(character, salt);
  const to = referencePath(character);
  const data = await fs.readFile(from);

  const tmp = `${to}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, to);

  const { rig, svg } = await loadRig(character);
  let params: MintParams;
  try {
    params = JSON.parse(await fs.readFile(candidateParamsPath(character, salt), 'utf8')) as MintParams;
  } catch {
    // Sidecar lost (pre-upgrade candidate, manual cleanup): fall back to the
    // character's raw first preference, which is what an empty cast mints.
    const pref = bankPreference(rig.charId ?? character, salt);
    params = { bankVoice: pref.order[0]!, speed: pref.speed, seed: pref.seed };
  }
  await saveRig(
    {
      ...rig,
      voiceRef: path.basename(to),
      voiceProvenance: {
        source: 'minted',
        seed: params.seed,
        hash: crypto.createHash('sha1').update(data).digest('hex'),
        bankVoice: params.bankVoice,
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
      character: c.name,
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
            bankVoice: p.bankVoice,
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
