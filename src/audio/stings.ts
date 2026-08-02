import { Rng, deriveSeed } from '../core/rng.ts';
import { BUS_RATE, db } from './bus.ts';

/**
 * Stings: the two- and one-note punctuation under title and end cards.
 *
 * Bumper-minimal by design — a couple of soft synthesized tones with a fast
 * decay, not music. They exist to mark the card rhythm (here is the show;
 * there, it stopped), and anything more melodic starts making promises the
 * scene has to keep. Seeded like everything else, so a show's sting is *its*
 * sting on every render.
 */

/** One decaying tone with a couple of quiet harmonics. */
function tone(rng: Rng, freq: number, durationMs: number, level: number): Float64Array {
  const length = Math.round((durationMs / 1000) * BUS_RATE);
  const out = new Float64Array(length);
  const detune = 1 + rng.range(-0.003, 0.003);
  const w = (2 * Math.PI * freq * detune) / BUS_RATE;
  const decay = 4.5 / length;

  for (let i = 0; i < length; i++) {
    const env = Math.exp(-decay * i) * Math.min(1, i / (BUS_RATE * 0.004));
    out[i] =
      (Math.sin(w * i) + 0.35 * Math.sin(2 * w * i) + 0.12 * Math.sin(3 * w * i)) * env * level;
  }
  return out;
}

function overlay(target: Float64Array, source: Float64Array, offsetMs: number): void {
  const offset = Math.round((offsetMs / 1000) * BUS_RATE);
  for (let i = 0; i < source.length && offset + i < target.length; i++) {
    target[offset + i]! += source[i]!;
  }
}

/**
 * The title sting: two notes, a fourth apart, the second landing just behind
 * the first. The interval and register are rolled once from the show's seed —
 * stable per show, different between shows.
 */
export function titleSting(seed: number, durationMs = 1400): Float64Array {
  const rng = new Rng(deriveSeed(seed, 'sting:title'));
  const root = rng.range(196, 262); // G3..C4 — announcement register, not alarm.
  const out = new Float64Array(Math.round((durationMs / 1000) * BUS_RATE));

  overlay(out, tone(rng, root, durationMs * 0.9, db(-14)), 0);
  overlay(out, tone(rng, root * (4 / 3), durationMs * 0.75, db(-16)), durationMs * 0.16);
  return out;
}

/** The end sting: one lower note. The door closing. */
export function endSting(seed: number, durationMs = 1100): Float64Array {
  const rng = new Rng(deriveSeed(seed, 'sting:end'));
  const root = rng.range(110, 147); // A2..D3.
  const out = new Float64Array(Math.round((durationMs / 1000) * BUS_RATE));
  overlay(out, tone(rng, root, durationMs, db(-13)), 0);
  return out;
}
