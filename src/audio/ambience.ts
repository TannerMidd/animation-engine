import { Rng, deriveSeed } from '../core/rng.ts';
import { BUS_RATE, db, fadeEdges } from './bus.ts';

/**
 * Room tone, synthesized.
 *
 * A scene with dialogue floating in digital silence reads as a demo; the same
 * scene over a faint fluorescent hum reads as a place. These beds are built
 * from three primitives — seeded noise, one-pole filters, and detuned hum
 * partials — composed per acoustic profile. Nothing external, nothing sampled,
 * and every sample a pure function of the seed, so the determinism guarantee
 * covers the soundtrack too.
 *
 * Levels are deliberately timid. Room tone that gets noticed has failed; it is
 * felt when present and missed when gone, never listened to.
 */

export const ACOUSTIC_PROFILES = [
  'office-day',
  'office-night',
  'bar',
  'home',
  'exterior-day',
  'exterior-dusk',
  'silence',
] as const;
export type AcousticProfile = (typeof ACOUSTIC_PROFILES)[number];

/**
 * Visual palette -> acoustic profile, as the migration default.
 *
 * The two are separate axes — a night office can sound like a day one if the
 * show says so — but every palette needs a sane answer before anyone has
 * expressed an opinion, and this is that table.
 */
export const PALETTE_ACOUSTICS: Record<string, AcousticProfile> = {
  'office-fluorescent': 'office-day',
  'office-night': 'office-night',
  'bar-night': 'bar',
  'home-warm': 'home',
  'exterior-day': 'exterior-day',
  'exterior-dusk': 'exterior-dusk',
  void: 'silence',
};

export function acousticProfileFor(palette: string | null): AcousticProfile {
  return palette ? (PALETTE_ACOUSTICS[palette] ?? 'silence') : 'silence';
}

// --- primitives -----------------------------------------------------------

/** Uniform white noise in [-1, 1]. */
function whiteNoise(rng: Rng, length: number): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/** One-pole lowpass, in place. Cutoff in Hz. */
function lowpass(samples: Float64Array, cutoffHz: number): Float64Array {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / BUS_RATE);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y += alpha * (samples[i]! - y);
    samples[i] = y;
  }
  return samples;
}

/** One-pole highpass, in place. */
function highpass(samples: Float64Array, cutoffHz: number): Float64Array {
  const alpha = Math.exp((-2 * Math.PI * cutoffHz) / BUS_RATE);
  let yPrev = 0;
  let xPrev = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const y = alpha * (yPrev + x - xPrev);
    samples[i] = y;
    yPrev = y;
    xPrev = x;
  }
  return samples;
}

/**
 * A hum: a fundamental with softer harmonics, each partial slightly detuned
 * and slowly beating. Perfectly stable sines read as a test tone; the beat is
 * what makes it electrical.
 */
function hum(rng: Rng, length: number, fundamental: number, partials: number[]): Float64Array {
  const out = new Float64Array(length);
  for (let p = 0; p < partials.length; p++) {
    const freq = fundamental * (p + 1) * (1 + rng.range(-0.002, 0.002));
    const level = partials[p]!;
    const phase = rng.range(0, Math.PI * 2);
    const beatFreq = rng.range(0.05, 0.2);
    const beatPhase = rng.range(0, Math.PI * 2);
    const w = (2 * Math.PI * freq) / BUS_RATE;
    const wb = (2 * Math.PI * beatFreq) / BUS_RATE;
    for (let i = 0; i < length; i++) {
      const beat = 0.85 + 0.15 * Math.sin(wb * i + beatPhase);
      out[i]! += Math.sin(w * i + phase) * level * beat;
    }
  }
  return out;
}

/** Slow random level drift, so a bed breathes instead of sitting frozen. */
function drift(rng: Rng, samples: Float64Array, depth: number): Float64Array {
  const period = BUS_RATE * rng.range(6, 11);
  const phase = rng.range(0, Math.PI * 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i]! *= 1 - depth / 2 + (depth / 2) * Math.sin((2 * Math.PI * i) / period + phase);
  }
  return samples;
}

function mixInto(target: Float64Array, source: Float64Array, gain: number): void {
  for (let i = 0; i < target.length; i++) target[i]! += source[i]! * gain;
}

// --- recipes --------------------------------------------------------------

/**
 * One bed per acoustic profile.
 *
 * Recipes are code rather than data for now: each is a couple of primitive
 * calls, and a data format would just be these lines with worse error
 * messages. The identity profile picks *which* recipe and how loud; M18 keeps
 * the recipes themselves engine-owned.
 */
export function renderAmbience(profile: AcousticProfile, seed: number, durationMs: number): Float64Array {
  const length = Math.max(1, Math.round((durationMs / 1000) * BUS_RATE));
  const rng = new Rng(deriveSeed(seed, `ambience:${profile}`));
  const bed = new Float64Array(length);

  switch (profile) {
    case 'office-day': {
      // Fluorescent ballast hum over HVAC rumble.
      mixInto(bed, hum(rng, length, 120, [0.5, 0.22, 0.1, 0.05]), db(-14));
      mixInto(bed, drift(rng, lowpass(whiteNoise(rng, length), 260), 0.5), db(-10));
      break;
    }
    case 'office-night': {
      // The building at rest: quieter hum, deeper air, one thin whine — the
      // monitor somebody left on.
      mixInto(bed, hum(rng, length, 120, [0.4, 0.15, 0.06]), db(-20));
      mixInto(bed, drift(rng, lowpass(whiteNoise(rng, length), 150), 0.6), db(-14));
      mixInto(bed, hum(rng, length, 7900, [0.3]), db(-34));
      break;
    }
    case 'bar': {
      // Murmur is lowpassed noise with a slow wander — crowd without words —
      // plus neon buzz, which is a hum with more edge (higher partials).
      mixInto(bed, drift(rng, lowpass(whiteNoise(rng, length), 420), 0.9), db(-9));
      mixInto(bed, hum(rng, length, 60, [0.2, 0.3, 0.24, 0.16, 0.1]), db(-19));
      break;
    }
    case 'home': {
      mixInto(bed, drift(rng, lowpass(whiteNoise(rng, length), 190), 0.5), db(-13));
      mixInto(bed, hum(rng, length, 50, [0.3, 0.1]), db(-24));
      break;
    }
    case 'exterior-day': {
      // Wind: band-limited noise with a much deeper, slower swell.
      const wind = highpass(lowpass(whiteNoise(rng, length), 900), 90);
      mixInto(bed, drift(rng, wind, 1.1), db(-11));
      break;
    }
    case 'exterior-dusk': {
      const wind = highpass(lowpass(whiteNoise(rng, length), 600), 70);
      mixInto(bed, drift(rng, wind, 1.2), db(-13));
      mixInto(bed, hum(rng, length, 95, [0.3, 0.12]), db(-26));
      break;
    }
    case 'silence':
      return bed;
  }

  return fadeEdges(bed, 400);
}
