import { encodeWav, toInt16, type WavData } from '../voice/wav.ts';

/**
 * The master bus.
 *
 * One fixed production format — 48 kHz centred stereo 16-bit — is assembled
 * in mono float64 and converted/interleaved exactly once at the end.
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

/** Social/archival master sample rate. Dialogue is centred in a stereo file. */
export const BUS_RATE = 48_000;

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

/** Deterministic programme measurements on the centred stereo master. */
export interface LoudnessMetrics {
  /** ITU-R BS.1770-style gated programme loudness. Null is intentional silence. */
  integratedLufs: number | null;
  /** Four-times oversampled inter-sample peak, in dBTP. Null is silence. */
  truePeakDbtp: number | null;
  /** Discrete sample peak, retained as a useful diagnostic rather than the gate. */
  samplePeakDbfs: number | null;
}

function finiteDb(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Direct-form-I biquad. Coefficients below are the 48 kHz BS.1770 K-weighting filters. */
function biquad(input: Float64Array, c: BiquadCoefficients): Float64Array {
  const output = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function kWeight(samples: Float64Array): Float64Array {
  // Coefficients published for the BS.1770 K-weighting response at 48 kHz.
  const shelf = biquad(samples, {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
  });
  return biquad(shelf, {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: -1.99004745483398,
    a2: 0.99007225036621,
  });
}

/**
 * BS.1770-style integrated loudness for the bus's dual-mono stereo programme.
 *
 * 400 ms blocks advance by 100 ms, first passing the -70 LUFS absolute gate
 * and then the relative gate ten LU below the absolute-gated programme. Short
 * clips use their available samples, which keeps line-level QC useful without
 * pretending a padded silence was part of the performance.
 */
export function integratedLoudnessLufs(samples: Float64Array, centredStereo = true): number {
  if (!samples.length) return -Infinity;
  const weighted = kWeight(samples);
  const blockLength = Math.min(weighted.length, Math.round(BUS_RATE * 0.4));
  const hop = Math.max(1, Math.round(BUS_RATE * 0.1));
  const channelEnergy = centredStereo ? 2 : 1;
  const energies: number[] = [];
  const lastStart = Math.max(0, weighted.length - blockLength);

  for (let start = 0; start <= lastStart; start += hop) {
    let sum = 0;
    for (let i = start; i < start + blockLength; i++) sum += weighted[i]! * weighted[i]!;
    energies.push((sum / blockLength) * channelEnergy);
  }
  // Include the tail block when the duration is not an exact hop multiple.
  if (lastStart > 0 && lastStart % hop !== 0) {
    let sum = 0;
    for (let i = lastStart; i < weighted.length; i++) sum += weighted[i]! * weighted[i]!;
    energies.push((sum / blockLength) * channelEnergy);
  }

  const toLufs = (energy: number) => energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
  const absolute = energies.filter((energy) => toLufs(energy) >= -70);
  if (!absolute.length) return -Infinity;
  const absoluteMean = absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length;
  const relativeGate = toLufs(absoluteMean) - 10;
  const relative = absolute.filter((energy) => toLufs(energy) >= relativeGate);
  const integrated = relative.reduce((sum, energy) => sum + energy, 0) / relative.length;
  return toLufs(integrated);
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

/**
 * Four-times oversampled inter-sample peak.
 *
 * An eight-tap Lanczos reconstruction catches peaks between PCM samples; a
 * simple linear interpolation cannot and therefore is still only a sample
 * peak. Coefficients are precomputed and DC-normalised per phase so the result
 * is deterministic and inexpensive enough to run on every production master.
 */
export function truePeakDbtp(samples: Float64Array): number {
  if (!samples.length) return -Infinity;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));

  const phaseCoefficients: number[][] = [];
  for (let phase = 1; phase < 4; phase++) {
    const fraction = phase / 4;
    const coefficients: number[] = [];
    let total = 0;
    for (let tap = -3; tap <= 4; tap++) {
      const distance = fraction - tap;
      const coefficient = Math.abs(distance) < 4 ? sinc(distance) * sinc(distance / 4) : 0;
      coefficients.push(coefficient);
      total += coefficient;
    }
    phaseCoefficients.push(coefficients.map((coefficient) => coefficient / total));
  }

  for (let i = 0; i < samples.length - 1; i++) {
    for (const coefficients of phaseCoefficients) {
      let value = 0;
      for (let offset = 0; offset < coefficients.length; offset++) {
        const at = i + offset - 3;
        if (at >= 0 && at < samples.length) value += samples[at]! * coefficients[offset]!;
      }
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Measure the final centred-stereo programme with release-gate precision. */
export function measureProgramme(samples: Float64Array): LoudnessMetrics {
  let samplePeak = 0;
  for (let i = 0; i < samples.length; i++) samplePeak = Math.max(samplePeak, Math.abs(samples[i]!));
  return {
    integratedLufs: finiteDb(integratedLoudnessLufs(samples)),
    truePeakDbtp: finiteDb(truePeakDbtp(samples)),
    samplePeakDbfs: finiteDb(samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity),
  };
}

export interface MasterOptions {
  durationMs: number;
  /**
   * Gated integrated-loudness target for the whole programme.
   */
  targetIntegratedLufs?: number;
  /** @deprecated Accepted as a target value for old callers; measurement is LUFS. */
  targetRmsDb?: number;
  /** True-peak ceiling after limiting, in dBTP. */
  ceilingDb?: number;
}

export interface StemOptions {
  durationMs: number;
  /** Safety ceiling only. Stems deliberately skip programme normalisation. */
  ceilingDb?: number;
}

/** Sum timeline clips without changing their production gain. */
function assembleMix(clips: BusClip[], durationMs: number): Float64Array {
  const total = Math.max(1, Math.round((durationMs / 1000) * BUS_RATE));
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
  return mix;
}

function toPcm16(mix: Float64Array): Int16Array {
  const out = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) {
    const v = Math.round(mix[i]! * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * Assemble clips onto a silent timeline and master it.
 *
 * Order: sum -> integrated-loudness normalise -> sample limit -> true-peak
 * trim. The final trim is what makes the ceiling an inter-sample promise rather
 * than merely a legal PCM sample value.
 */
export function assembleMaster(clips: BusClip[], opts: MasterOptions): Int16Array {
  const mix = assembleMix(clips, opts.durationMs);

  // BS.1770 gating excludes intentional silence from the normalisation target.
  const target = opts.targetIntegratedLufs ?? opts.targetRmsDb ?? -16;
  const loud = integratedLoudnessLufs(mix);
  if (Number.isFinite(loud)) {
    const gain = Math.min(db(12), db(target - loud));
    for (let i = 0; i < mix.length; i++) mix[i]! *= gain;
  }

  const ceilingDb = opts.ceilingDb ?? -1;
  limit(mix, db(ceilingDb));
  const measuredTruePeak = truePeakDbtp(mix);
  if (Number.isFinite(measuredTruePeak) && measuredTruePeak > ceilingDb) {
    const trim = db(ceilingDb - measuredTruePeak);
    for (let i = 0; i < mix.length; i++) mix[i]! *= trim;
  }

  // Convert once, with rounding — the only int16 conversion on the bus.
  return toPcm16(mix);
}

/**
 * Assemble one production stem at authored mix gain.
 *
 * A stem is not loudness-normalised independently: doing that would destroy
 * the balance between dialogue, room tone, Foley and stings. It only receives
 * peak safety so a legal 16-bit WAV can always be written.
 */
export function assembleStem(clips: BusClip[], opts: StemOptions): Int16Array {
  const mix = assembleMix(clips, opts.durationMs);
  limit(mix, db(opts.ceilingDb ?? -1));
  return toPcm16(mix);
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
  const mono = assembleMaster(clips, opts);
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i]!;
    stereo[i * 2 + 1] = mono[i]!;
  }
  return encodeWav(stereo, BUS_RATE, 2);
}

/** A full-programme, centred 48 kHz stereo production stem. */
export function stemToWav(clips: BusClip[], opts: StemOptions): Buffer {
  const mono = assembleStem(clips, opts);
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i]!;
    stereo[i * 2 + 1] = mono[i]!;
  }
  return encodeWav(stereo, BUS_RATE, 2);
}
