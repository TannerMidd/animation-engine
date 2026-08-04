import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../core/paths.ts';
import { SapiEngine, listSapiVoices } from './engines/sapi.ts';
import { ChatterboxEngine } from './engines/chatterbox.ts';
import { rhubarbCues, findRhubarb } from './rhubarb.ts';
import { readWav, wavDurationMs as wavDuration } from './wav.ts';
import { asrAvailable, transcribeBatch, scoreTranscript, deriveRetrySeed, type LineQa } from './qa.ts';
import type { LineTiming, MouthCue } from './visemes.ts';
import type { TtsEngine, SynthRequest } from './types.ts';
import type { MouthShape } from '../schema/index.ts';

const CACHE_DIR = path.join(ROOT, '.cache', 'voice');

/** Bump when anything that changes synthesis output changes. */
// v7 damps delivery on very short lines and walks retries down a stability
// ladder — retried takes under a v6 key would not match a cold rebuild.
// v6 peak-normalizes hot takes in the worker (was a hard clip at full scale)
// and gates generated lines through ASR verification with seed retries.
// v5 added the sampling knobs to the key and retuned the delivery table.
// v4 fixed persona propagation on cache misses: v3 keys included the resolved
// persona even though synthesis accidentally used the neutral delivery, so an
// existing v3 entry may contain audio that does not match its own fingerprint.
const CACHE_VERSION = 7;

/**
 * sha1 of a reference clip's bytes, memoized by (path, size, mtime).
 *
 * The cache key must change when the *audio* changes, and reference files are
 * routinely replaced in place — re-recording brent.ref.wav must not replay the
 * old Brent from cache, which is exactly what keying on the path string did.
 * The mtime memo keeps this from re-reading every reference on every preview.
 */
const refHashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

async function refContentHash(file: string | null): Promise<string> {
  if (!file) return '';
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    // A dangling reference synthesizes unreferenced; the key reflects that.
    return 'missing';
  }
  const memo = refHashes.get(file);
  if (memo && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs) return memo.hash;

  const hash = crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex');
  refHashes.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
  return hash;
}

export const ENGINE_NAMES = ['chatterbox', 'sapi'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export function getEngine(name: string): TtsEngine {
  switch (name) {
    case 'chatterbox':
      return new ChatterboxEngine();
    case 'sapi':
      return new SapiEngine();
    default:
      throw new Error(`unknown voice engine "${name}". Options: ${ENGINE_NAMES.join(', ')}`);
  }
}

/**
 * Expression to delivery.
 *
 * `exaggeration` is Chatterbox's emotion intensity; `cfg` is its guidance
 * weight, where lower reads as slower and more deliberate. Mapping the
 * director's expressions onto these means a DEADPAN line is actually delivered
 * flat rather than merely drawn that way — which in this genre is most of the
 * joke. SAPI ignores all of it.
 *
 * `temperature` is sampling variance: low keeps calm lines controlled and
 * repeatable-sounding, high lets hot lines actually move. The exaggeration
 * ceiling sits lower than it used to (0.8, not 0.9) and hot-line cfg drops
 * with it — pushed past that, Chatterbox races and destabilises, which reads
 * as *worse* acting, not bigger acting.
 */
const DELIVERY: Record<string, { exaggeration: number; cfg: number; temperature: number }> = {
  DEADPAN: { exaggeration: 0.3, cfg: 0.3, temperature: 0.5 },
  EXHAUSTED: { exaggeration: 0.32, cfg: 0.3, temperature: 0.55 },
  SAD: { exaggeration: 0.38, cfg: 0.34, temperature: 0.6 },
  SUSPICIOUS: { exaggeration: 0.42, cfg: 0.38, temperature: 0.65 },
  CONFUSED: { exaggeration: 0.45, cfg: 0.42, temperature: 0.7 },
  NEUTRAL: { exaggeration: 0.5, cfg: 0.45, temperature: 0.7 },
  SMUG: { exaggeration: 0.58, cfg: 0.42, temperature: 0.75 },
  JOY: { exaggeration: 0.68, cfg: 0.42, temperature: 0.8 },
  ANGRY: { exaggeration: 0.75, cfg: 0.4, temperature: 0.85 },
  SHOCKED: { exaggeration: 0.8, cfg: 0.38, temperature: 0.9 },
};

/**
 * Token-sampling knobs, pinned to what the installed Chatterbox defaults to
 * today. Passed explicitly on every request and folded into the cache key, so
 * a library upgrade that moves its defaults cannot silently change rendered
 * audio while the cache still claims it is current.
 */
export const SAMPLING = { repetitionPenalty: 1.2, minP: 0.05, topP: 1.0 } as const;

export interface VoicePersona {
  energy: number;
  pace: number;
}

export const NEUTRAL_PERSONA: VoicePersona = { energy: 1, pace: 1 };

/**
 * The expression's delivery, bent through the character's vocal persona.
 *
 * Plain multiplicative shifts: an excitable character (energy 1.2) delivers
 * every expression a notch hotter — their deadpan is never quite as flat, and
 * their shock hits the ceiling — while a restrained one never gets all the way
 * loud. `pace` does the same to the guidance weight, where lower reads slower.
 * The expression stays the dominant term; the persona is a voice, not a mood.
 */
export function deliveryFor(
  expression: string,
  persona: VoicePersona = NEUTRAL_PERSONA,
): { exaggeration: number; cfg: number; temperature: number } {
  const base = DELIVERY[expression] ?? DELIVERY['NEUTRAL']!;
  const clamp = (v: number) => Math.round(Math.max(0.1, Math.min(1, v)) * 1000) / 1000;
  return {
    exaggeration: clamp(base.exaggeration * persona.energy),
    cfg: clamp(base.cfg * persona.pace),
    // Deliberately not bent by persona: energy and pace already differentiate
    // characters, and temperature below 0.4 collapses into monotone.
    temperature: Math.max(0.4, Math.min(1, base.temperature)),
  };
}

/**
 * The delivery a specific line is actually synthesized with.
 *
 * On top of the expression mapping, very short lines are damped: a one-word
 * exclamation at full SHOCKED intensity has nowhere to put the energy and
 * Chatterbox tips into gibberish — measured on a real scene, hot one-worders
 * garbled on *every* seed while their damped versions read cleanly. A
 * slightly flatter "Unpaid?" that says "unpaid" is the joke; a perfectly
 * shocked syllable-salad is not. Both the cache key and the synthesis request
 * resolve through here, so the two can never disagree.
 */
export function deliveryForLine(line: VoiceLine): { exaggeration: number; cfg: number; temperature: number } {
  const d = deliveryFor(line.expression, line.persona);
  const words = line.text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 2) return d;
  return {
    exaggeration: Math.min(d.exaggeration, 0.55),
    cfg: Math.max(d.cfg, 0.4),
    temperature: Math.min(d.temperature, 0.7),
  };
}

export interface VoiceLine {
  /** Stable id for this line within the scene. */
  id: string;
  text: string;
  /** Drives emotional delivery on engines that support it. */
  expression: string;
  /** Engine-specific voice selector. */
  voice: string;
  rate: number;
  /** Reference clip to clone this character's voice from. */
  ref: string | null;
  /** The character's delivery personality. */
  persona?: VoicePersona;
  seed: number;
}

export interface CachedMeta {
  durationMs: number;
  cues: MouthCue[];
  /** Verification verdict for the accepted take. Absent on ungated engines. */
  qa?: LineQa;
}

/**
 * The cache key covers everything that changes the audio: the text, the
 * resolved delivery (the expression bent through the persona), the take seed,
 * and — critically — the reference clip's *content hash*, never its path.
 * Reference files live at stable paths and get replaced in place; a path-keyed
 * cache replays the old voice after a re-record, which is the worst kind of
 * stale audio because nothing looks wrong.
 */
export async function lineCacheKey(engine: string, line: VoiceLine): Promise<string> {
  return cacheKey(engine, line);
}

async function cacheKey(engine: string, line: VoiceLine): Promise<string> {
  const d = deliveryForLine(line);
  return crypto
    .createHash('sha1')
    .update(
      [
        CACHE_VERSION,
        engine,
        line.text,
        line.voice,
        line.rate,
        d.exaggeration,
        d.cfg,
        d.temperature,
        SAMPLING.repetitionPenalty,
        SAMPLING.minP,
        SAMPLING.topP,
        await refContentHash(line.ref),
        line.seed,
      ].join('\0'),
    )
    .digest('hex');
}

export interface SynthesizeOptions {
  engine: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/**
 * Resolve a line into the exact request an engine receives.
 *
 * Keeping this as one pure boundary prevents the cache fingerprint and the
 * real synthesis request from drifting apart. In particular, character
 * persona must shape both: a cache miss may not silently fall back to the
 * neutral energy/pace that happened before M22.
 */
export function buildSynthRequest(line: VoiceLine, out: string): SynthRequest {
  const delivery = deliveryForLine(line);
  return {
    id: line.id,
    out,
    text: line.text,
    voice: line.voice,
    rate: line.rate,
    exaggeration: delivery.exaggeration,
    cfgWeight: delivery.cfg,
    temperature: delivery.temperature,
    repetitionPenalty: SAMPLING.repetitionPenalty,
    minP: SAMPLING.minP,
    topP: SAMPLING.topP,
    ref: line.ref,
    seed: line.seed,
  };
}

/** How many takes a line gets before the best failure is kept and flagged. */
const MAX_SYNTH_ATTEMPTS = 3;

/**
 * Walk a retry toward stability.
 *
 * A failed take usually failed *because* of expressive intensity — high
 * exaggeration and temperature are exactly where sampling tips over. Retrying
 * the same settings on a new seed just rolls the same dice; each retry
 * instead gives up a slice of intensity for a much better chance of a take
 * that says its line. Pure in (request, attempt), so retried takes are as
 * reproducible as first takes. Attempt 0 is the identity.
 */
export function stabilizeRequest(request: SynthRequest, attempt: number): SynthRequest {
  if (attempt <= 0) return request;
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  if (attempt === 1) {
    return {
      ...request,
      exaggeration: round3(request.exaggeration * 0.85),
      cfgWeight: round3(request.cfgWeight + (0.45 - request.cfgWeight) * 0.3),
      temperature: round3(Math.max(0.5, request.temperature * 0.85)),
    };
  }
  return {
    ...request,
    exaggeration: round3(Math.min(request.exaggeration * 0.7, 0.55)),
    cfgWeight: 0.45,
    temperature: 0.6,
  };
}

interface TakeCandidate {
  audio: string;
  durationMs: number;
  cues: MouthCue[] | null;
  qa?: LineQa;
}

/** Strictly-better ordering for takes: a pass beats a fail, then similarity. */
function betterTake(a: TakeCandidate, b: TakeCandidate): boolean {
  if (!a.qa || !b.qa) return false;
  if (a.qa.passed !== b.qa.passed) return a.qa.passed;
  return a.qa.similarity > b.qa.similarity + 1e-9;
}

/**
 * Render every line, reusing cached takes.
 *
 * Caching is by content, so reordering a scene or editing one line's
 * neighbours costs nothing — only genuinely changed text is re-synthesized,
 * which matters a lot when a neural take costs seconds rather than
 * milliseconds.
 *
 * Fresh neural takes are *verified* before they enter the cache: the audio is
 * transcribed locally and scored against the script line, and a take that
 * does not say its line is retried on a derived seed (deterministic, bounded
 * by MAX_SYNTH_ATTEMPTS). Sampling occasionally garbles a take, and a
 * seed-stable pipeline would otherwise re-render that same garble forever.
 * If every attempt fails, the closest take is kept and the failure recorded
 * in the cache metadata, where preflight turns it into a release blocker —
 * an unintelligible line must be a loud decision, never a quiet default.
 */
export async function synthesizeLines(
  lines: VoiceLine[],
  opts: SynthesizeOptions,
): Promise<Map<string, LineTiming>> {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const engine = getEngine(opts.engine);
  const out = new Map<string, LineTiming>();
  const keyById = new Map<string, string>();
  const misses: VoiceLine[] = [];

  for (const line of lines) {
    const key = await cacheKey(opts.engine, line);
    keyById.set(line.id, key);

    const wav = path.join(CACHE_DIR, `${key}.wav`);
    const meta = path.join(CACHE_DIR, `${key}.json`);

    try {
      const parsed = JSON.parse(await fs.readFile(meta, 'utf8')) as CachedMeta;
      await fs.access(wav);
      out.set(line.id, { audio: wav, durationMs: parsed.durationMs, cues: parsed.cues });
      continue;
    } catch {
      // Not cached, or half-written.
    }

    misses.push(line);
  }

  // Nothing to render: return without touching the engine at all. Probing
  // Chatterbox means spawning Python and importing torch, which costs tens of
  // seconds — far too much to pay when every line is already cached, as it is
  // every time the editor rebuilds a preview.
  if (!misses.length) return out;

  const availability = await engine.available();
  if (!availability.ok) {
    throw new Error(`voice engine "${opts.engine}" is not usable: ${availability.reason}`);
  }

  // Verification is chatterbox-only: SAPI is deterministic concatenative
  // speech that cannot garble, and gating it would only cost render time.
  const gate = opts.engine === 'chatterbox' ? await asrAvailable() : { ok: false as const };

  interface LineState {
    line: VoiceLine;
    wav: string;
    best: TakeCandidate | null;
    done: boolean;
  }
  const states = new Map<string, LineState>(misses.map((line) => [
    line.id,
    { line, wav: path.join(CACHE_DIR, `${keyById.get(line.id)!}.wav`), best: null, done: false },
  ]));

  const attempts = gate.ok ? MAX_SYNTH_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const round = [...states.values()].filter((s) => !s.done);
    if (!round.length) break;

    // Retries land next to the canonical path so a worse retry can lose to an
    // earlier take; the winner is copied into place at the end. Each retry
    // rolls a derived seed *and* steps down the stability ladder.
    const requests = round.map((s) => stabilizeRequest(
      buildSynthRequest(
        { ...s.line, seed: deriveRetrySeed(s.line.seed, attempt) },
        attempt === 0 ? s.wav : `${s.wav}.retry${attempt}`,
      ),
      attempt,
    ));
    const rendered = await engine.synth(requests, (done, total) =>
      opts.onProgress?.('synth', done, total),
    );
    for (const s of round) {
      if (!rendered.get(s.line.id)) {
        throw new Error(`engine "${opts.engine}" returned no audio for line "${s.line.id}"`);
      }
    }

    if (!gate.ok) {
      for (const s of round) {
        const r = rendered.get(s.line.id)!;
        s.best = { audio: r.audio, durationMs: r.durationMs, cues: r.cues };
        s.done = true;
      }
      break;
    }

    const transcripts = await transcribeBatch(
      round.map((s) => ({ id: s.line.id, wav: rendered.get(s.line.id)!.audio })),
      (done, total) => opts.onProgress?.('verify', done, total),
    );
    for (const s of round) {
      const r = rendered.get(s.line.id)!;
      const qa: LineQa = { ...scoreTranscript(s.line.text, transcripts.get(s.line.id) ?? ''), attempt };
      const candidate: TakeCandidate = { audio: r.audio, durationMs: r.durationMs, cues: r.cues, qa };
      if (!s.best || betterTake(candidate, s.best)) s.best = candidate;
      if (qa.passed) s.done = true;
    }
  }

  // Materialize each winner at its canonical cache path, drop retry scratch.
  for (const s of states.values()) {
    const best = s.best!;
    if (best.audio !== s.wav) {
      await fs.copyFile(best.audio, s.wav);
      best.audio = s.wav;
    }
    for (let attempt = 1; attempt < attempts; attempt++) {
      await fs.rm(`${s.wav}.retry${attempt}`, { force: true });
    }
  }

  // Engines that do not report phoneme timing get sent through Rhubarb —
  // strictly after take selection, so the mouth is timed to the accepted take.
  const needLipsync = [...states.values()].filter((s) => !s.best!.cues);
  if (needLipsync.length && !(await findRhubarb())) {
    throw new Error(
      `engine "${opts.engine}" returns audio without mouth timing, so Rhubarb is required.\n` +
        `Put rhubarb.exe under tools/, or set the RHUBARB env var.\n` +
        `Download: https://github.com/DanielSWolf/rhubarb-lip-sync/releases`,
    );
  }

  let lipsynced = 0;
  for (const s of states.values()) {
    const best = s.best!;
    let cues = best.cues;
    let durationMs = best.durationMs;

    if (!cues) {
      const analysed = await rhubarbCues(best.audio, s.line.text);
      cues = analysed.cues;
      if (analysed.durationMs > 0) durationMs = analysed.durationMs;
      opts.onProgress?.('lipsync', ++lipsynced, needLipsync.length);
    }

    const key = keyById.get(s.line.id)!;
    await fs.writeFile(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify({ durationMs, cues, qa: best.qa } satisfies CachedMeta),
      'utf8',
    );
    out.set(s.line.id, { audio: best.audio, durationMs, cues });
  }

  return out;
}

/**
 * The cached metadata for a line, if a take has been rendered for exactly
 * these inputs. How preflight reads verification verdicts without touching
 * the engine.
 */
export async function readCachedLineMeta(engine: string, line: VoiceLine): Promise<CachedMeta | null> {
  const key = await cacheKey(engine, line);
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8')) as CachedMeta;
  } catch {
    return null;
  }
}

export async function listVoices(): Promise<string[]> {
  return listSapiVoices();
}

/** Duration of a PCM WAV, read straight from its header. */
export async function wavDurationMs(file: string): Promise<number> {
  return wavDuration(await readWav(file));
}

// --- recorded VO ----------------------------------------------------------

/** Vowels open the mouth; everything else narrows it. Crude, but only a fallback. */
const LETTER_SHAPE: Record<string, MouthShape> = {
  a: 'D', e: 'C', i: 'B', o: 'E', u: 'F', y: 'B',
  m: 'A', b: 'A', p: 'A',
  f: 'G', v: 'G',
  l: 'H',
  w: 'F',
};

/**
 * Estimate a mouth track from text alone, spread across a known duration.
 *
 * Only used when Rhubarb is unavailable. It gets the mouth moving in roughly
 * the right rhythm but has no idea what the recording actually says.
 */
export function estimateMouthCues(text: string, durationMs: number): MouthCue[] {
  const letters = text.toLowerCase().replace(/[^a-z ]/g, '');
  if (!letters.trim()) return [{ ms: 0, shape: 'X' }];

  const cues: MouthCue[] = [{ ms: 0, shape: 'X' }];
  const per = durationMs / letters.length;

  for (let i = 0; i < letters.length; i++) {
    const ch = letters[i]!;
    const shape: MouthShape = ch === ' ' ? 'X' : (LETTER_SHAPE[ch] ?? 'B');
    const prev = cues[cues.length - 1]!;
    if (prev.shape === shape) continue;
    cues.push({ ms: Math.round(i * per), shape });
  }
  return cues;
}

/**
 * Use a recorded WAV in place of synthesis.
 *
 * Drop `<scene>/vo/<NNN>-<speaker>.wav` next to a scene and that line switches
 * to your voice. Rhubarb analyses the recording directly, which is exactly what
 * it is for; without it we fall back to the text estimate.
 */
export async function loadRecordedVo(file: string, text: string): Promise<LineTiming> {
  if (await findRhubarb()) {
    const { cues, durationMs } = await rhubarbCues(file, text);
    return { audio: file, durationMs: durationMs || (await wavDurationMs(file)), cues };
  }
  const durationMs = await wavDurationMs(file);
  return { audio: file, durationMs, cues: estimateMouthCues(text, durationMs) };
}

export type { LineTiming, MouthCue };
