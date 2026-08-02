import type { Rng } from '../core/rng.ts';
import type { IRTransform, PartTransform, MouthShape } from '../schema/index.ts';

/** Shared building blocks for the compilers. */

export const IDENTITY: IRTransform = [0, 0, 0, 1];

/** Compose two transforms: rotations and offsets add, scales multiply. */
export function add(a: IRTransform, b: Partial<PartTransform>): IRTransform {
  return [a[0] + (b.rot ?? 0), a[1] + (b.x ?? 0), a[2] + (b.y ?? 0), a[3] * (b.scale ?? 1)];
}

/** Blend from a toward b. Used only for the single snap frame on a pose change. */
export function lerp(a: IRTransform, b: IRTransform, t: number): IRTransform {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

export function isRest(t: IRTransform): boolean {
  return t[0] === 0 && t[1] === 0 && t[2] === 0 && t[3] === 1;
}

/** Strip rest-state parts: smaller IR, and the runtime skips them entirely. */
export function pruneRest(parts: Record<string, IRTransform>): Record<string, IRTransform> {
  for (const [id, t] of Object.entries(parts)) {
    if (isRest(t)) delete parts[id];
  }
  return parts;
}

export interface BlinkWindow {
  start: number;
  end: number;
}

/**
 * Blinks as a Poisson process rather than a metronome.
 *
 * Evenly-spaced blinks read as mechanical immediately. Exponential gaps cluster
 * the way real ones do, and that irregularity is most of what separates a
 * puppet that seems alive from one that seems switched on.
 */
export function scheduleBlinks(
  rng: Rng,
  durationSec: number,
  rateHz: number,
  blinkDur: number,
): BlinkWindow[] {
  const windows: BlinkWindow[] = [];
  let t = rng.exponential(rateHz);
  while (t < durationSec) {
    windows.push({ start: t, end: t + blinkDur });
    t += blinkDur + rng.exponential(rateHz);
  }
  return windows;
}

export function isBlinking(windows: BlinkWindow[], t: number): boolean {
  return windows.some((w) => t >= w.start && t < w.end);
}

/**
 * How far open each mouth shape is, 0 to 1.
 *
 * Drives the small head movement that accompanies speech: the head dips a
 * little on open vowels. It is a tiny effect, but without it a talking head is
 * just a mouth flapping on a mannequin.
 */
const OPENNESS: Record<MouthShape, number> = {
  X: 0,
  A: 0,
  B: 0.15,
  G: 0.15,
  F: 0.3,
  H: 0.4,
  E: 0.45,
  C: 0.55,
  D: 1,
};

export function mouthOpenness(shape: MouthShape): number {
  return OPENNESS[shape] ?? 0;
}
