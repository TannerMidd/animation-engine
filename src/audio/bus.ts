import { encodeWav, toInt16, type WavData } from '../voice/wav.ts';

/**
 * The master bus.
 *
 * One fixed output format — 24 kHz mono 16-bit, the native rate of the primary
 * voice engine — assembled in float64 and converted exactly once at the end.
 * Everything audible goes through here: dialogue, ambience beds, stings.
 * Assembling in integers was fine when the only sources were non-overlapping
 * speech clips; a bed under dialogue means genuine summation, and summed int16
 * either clips per-sample or wraps. Floats accumulate exactly and the limiter
 * handles the ceiling once, at the end.
 *
 * Everything here is deterministic arithmetic — no wall clock, no platform
 * resampler, no float ordering ambiguity (placements sum in call order) — so
 * the same inputs produce the same output bytes, which the soundtrack
 * fingerprint depends on.
 */

export const BUS_RATE = 24_000;

export interface BusClip {
  /** Mono samples in [-1, 1] at BUS_RATE. */
  samples: Float64Array;
  /** Placement on the timeline. */
  startMs: number;
  /** Linear gain applied at placement. */
  gain?: number;
}

/** dB -> linear gain. */
export function db(v: number): number {
  return Math.pow(10, v / 20);
}

/** Int16 WAV data -> float samples, resampled to the bus rate if needed. */
export function toBusSamples(wav: WavData, label: string): Float64Array {
  const ints = toInt16(wav, label);

  // Interleaved stereo folds to mono by averaging; the puppet show has no
  // stereo field and a channel dropped instead of averaged loses real energy.
  const mono = new Float64Array(Math.floor(ints.length / wav.channels));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) sum += ints[i * wav.channels + c]!;
    mono[i] = sum / wav.channels / 32768;
  }

  if (wav.sampleRate === BUS_RATE) return mono;
  return resampleLinear(mono, wav.sampleRate, BUS_RATE);
}

/**
 * Deterministic linear resampler.
 *
 * Linear, not windowed-sinc, on purpose: the inputs are 22.05 kHz speech and
 * noise beds heading into a 24 kHz bus under compressed video audio — the
 * difference is inaudible there, and thirty lines of exact, obviously-correct
 * arithmetic beats a filter bank that has to be proven deterministic.
 */
export function resampleLinear(input: Float64Array, from: number, to: number): Float64Array {
  if (from === to) return input;
  const outLength = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float64Array(outLength);
  const step = (input.length - 1) / Math.max(1, outLength - 1);

  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(input.length - 1, lo + 1);
    const t = pos - lo;
    out[i] = input[lo]! * (1 - t) + input[hi]! * t;
  }
  return out;
}

/** Short linear fades, applied in place. Clicks live at clip boundaries. */
export function fadeEdges(samples: Float64Array, fadeMs: number, rate = BUS_RATE): Float64Array {
  const n = Math.min(Math.floor((fadeMs / 1000) * rate), Math.floor(samples.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[i]! *= g;
    samples[samples.length - 1 - i]! *= g;
  }
  return samples;
}

/** Root-mean-square of a buffer, in dBFS. -Infinity for silence. */
export function rmsDb(samples: Float64Array): number {
  if (!samples.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export interface MasterOptions {
  durationMs: number;
  /**
   * RMS loudness target for the whole programme, in dBFS. Stated plainly: this
   * is an RMS approximation, not broadcast LUFS — right for keeping renders
   * consistent with each other, which is what matters here.
   */
  targetRmsDb?: number;
  /** Peak ceiling after limiting. */
  ceilingDb?: number;
}

/**
 * Assemble clips onto a silent timeline and master it.
 *
 * Order: sum -> loudness normalise -> limit. Normalising before the limiter
 * means the ceiling is enforced on the final level, and a hot mix trades a
 * little transient for never clipping.
 */
export function assembleMaster(clips: BusClip[], opts: MasterOptions): Int16Array {
  const total = Math.max(1, Math.round((opts.durationMs / 1000) * BUS_RATE));
  const mix = new Float64Array(total);

  for (const clip of clips) {
    const gain = clip.gain ?? 1;
    const offset = Math.round((clip.startMs / 1000) * BUS_RATE);
    for (let i = 0; i < clip.samples.length; i++) {
      const at = offset + i;
      if (at < 0) continue;
      if (at >= total) break;
      mix[at]! += clip.samples[i]! * gain;
    }
  }

  // Loudness: measured over the voiced portion only. A scene that is mostly
  // deliberate silence must not have its dialogue cranked to make the average
  // hit target — silence is a creative choice, not a level error.
  const target = opts.targetRmsDb ?? -20;
  const loud = rmsDb(gated(mix));
  if (Number.isFinite(loud)) {
    const gain = Math.min(db(12), db(target - loud));
    for (let i = 0; i < mix.length; i++) mix[i]! *= gain;
  }

  limit(mix, db(opts.ceilingDb ?? -1));

  // Convert once, with rounding — the only int16 conversion on the bus.
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const v = Math.round(mix[i]! * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Samples above a low activity floor — the material the loudness target means. */
function gated(mix: Float64Array): Float64Array {
  const floor = db(-45);
  let count = 0;
  for (let i = 0; i < mix.length; i++) if (Math.abs(mix[i]!) > floor) count++;
  if (count === 0) return mix;

  const active = new Float64Array(count);
  let at = 0;
  for (let i = 0; i < mix.length; i++) {
    if (Math.abs(mix[i]!) > floor) active[at++] = mix[i]!;
  }
  return active;
}

/**
 * A simple attack-free limiter with exponential release.
 *
 * Gain rides down instantly when the signal would exceed the ceiling and
 * recovers over ~50ms. Not transparent mastering — a safety device, present so
 * a hot sting on top of a shout can never wrap into noise.
 */
function limit(mix: Float64Array, ceiling: number): void {
  const release = Math.exp(-1 / (0.05 * BUS_RATE));
  let gain = 1;

  for (let i = 0; i < mix.length; i++) {
    const level = Math.abs(mix[i]!) * gain;
    if (level > ceiling) gain = ceiling / Math.abs(mix[i]!);
    else gain = 1 - (1 - gain) * release;
    mix[i]! *= gain;
  }
}

/** The mastered programme as a WAV file body. */
export function masterToWav(clips: BusClip[], opts: MasterOptions): Buffer {
  return encodeWav(assembleMaster(clips, opts), BUS_RATE, 1);
}
