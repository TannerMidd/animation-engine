import type { MotionValue } from '../schema/animation.ts';
import type { PartTransform, Point } from '../schema/rig.ts';

export interface PuppeteeringSample {
  /** Controller-frame index from the beginning of capture. */
  frame: number;
  value: MotionValue;
}

function components(value: MotionValue): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return [...value];
  return [value.rot, value.x, value.y, value.scale];
}

function fromComponents(like: MotionValue, values: number[]): MotionValue {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  if (typeof like === 'number') return Math.max(0.001, round(values[0]!));
  if (Array.isArray(like)) return [round(values[0]!), round(values[1]!)] as Point;
  return {
    rot: round(values[0]!),
    x: round(values[1]!),
    y: round(values[2]!),
    scale: Math.max(0.001, round(values[3]!)),
  } satisfies PartTransform;
}

function sameShape(a: MotionValue, b: MotionValue): boolean {
  return (
    typeof a === typeof b &&
    Array.isArray(a) === Array.isArray(b) &&
    components(a).length === components(b).length
  );
}

function lerpValue(a: MotionValue, b: MotionValue, t: number): MotionValue {
  const from = components(a);
  const to = components(b);
  return fromComponents(a, from.map((value, index) => value + (to[index]! - value) * t));
}

function weightedAverage(previous: MotionValue, current: MotionValue, next: MotionValue): MotionValue {
  const a = components(previous);
  const b = components(current);
  const c = components(next);
  return fromComponents(current, b.map((value, index) => (a[index]! + value * 2 + c[index]!) / 4));
}

/** Scale is dimensionless; weight it so a visible scale change survives reduction. */
function errorComponents(value: MotionValue): number[] {
  const out = components(value);
  if (!Array.isArray(value) && typeof value !== 'number') out[3]! *= 50;
  return out;
}

function distance(a: MotionValue, b: MotionValue): number {
  const left = errorComponents(a);
  const right = errorComponents(b);
  return Math.hypot(...left.map((value, index) => value - right[index]!));
}

function canonicalSamples(input: readonly PuppeteeringSample[]): PuppeteeringSample[] {
  const byFrame = new Map<number, MotionValue>();
  for (const sample of input) {
    if (!Number.isInteger(sample.frame) || sample.frame < 0) {
      throw new Error('puppeteering sample frames must be non-negative integers');
    }
    if (!Number.isFinite(sample.frame)) throw new Error('puppeteering sample frame must be finite');
    if (components(sample.value).some((value) => !Number.isFinite(value))) {
      throw new Error('puppeteering controller values must be finite');
    }
    if (
      (typeof sample.value === 'number' && sample.value <= 0) ||
      (!Array.isArray(sample.value) && typeof sample.value !== 'number' && sample.value.scale <= 0)
    ) {
      throw new Error('puppeteering controller scale must be positive');
    }
    if (byFrame.size && !sameShape(byFrame.values().next().value as MotionValue, sample.value)) {
      throw new Error('one puppeteering recording may only contain one controller value shape');
    }
    // Browser pointer events can share a frame. The last observation in that
    // frame is the one the creator actually left the controller on.
    byFrame.set(sample.frame, sample.value);
  }
  return [...byFrame.entries()]
    .map(([frame, value]) => ({ frame, value }))
    .sort((a, b) => a.frame - b.frame);
}

function smooth(input: PuppeteeringSample[], passes: number): PuppeteeringSample[] {
  let current = input;
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 3) return current;
    current = current.map((sample, index) => (
      index === 0 || index === current.length - 1
        ? sample
        : {
            frame: sample.frame,
            value: weightedAverage(
              current[index - 1]!.value,
              sample.value,
              current[index + 1]!.value,
            ),
          }
    ));
  }
  return current;
}

function reduceRange(
  samples: PuppeteeringSample[],
  first: number,
  last: number,
  tolerance: number,
  keep: Set<number>,
): void {
  if (last <= first + 1) return;
  const left = samples[first]!;
  const right = samples[last]!;
  const frameSpan = Math.max(1, right.frame - left.frame);
  let furthest = -1;
  let furthestError = tolerance;
  for (let index = first + 1; index < last; index++) {
    const sample = samples[index]!;
    const expected = lerpValue(left.value, right.value, (sample.frame - left.frame) / frameSpan);
    const error = distance(sample.value, expected);
    // Strict greater-than keeps the earliest equal-error sample, making ties
    // independent of JS sort implementation details.
    if (error > furthestError) {
      furthest = index;
      furthestError = error;
    }
  }
  if (furthest < 0) return;
  keep.add(furthest);
  reduceRange(samples, first, furthest, tolerance, keep);
  reduceRange(samples, furthest, last, tolerance, keep);
}

/**
 * Deterministic moving-average smoothing followed by time-aware key reduction.
 * Endpoints are never changed or removed; manual correction can therefore be
 * layered over the reduced waypoints without capture drift.
 */
export function reducePuppeteeringSamples(
  input: readonly PuppeteeringSample[],
  options: { smoothingPasses?: number; tolerance?: number } = {},
): PuppeteeringSample[] {
  const canonical = canonicalSamples(input);
  if (canonical.length <= 2) return canonical;
  const passes = Math.max(0, Math.min(4, Math.round(options.smoothingPasses ?? 1)));
  const tolerance = options.tolerance ?? 1.25;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('key reduction tolerance must be non-negative');
  const smoothed = smooth(canonical, passes);
  const keep = new Set([0, smoothed.length - 1]);
  reduceRange(smoothed, 0, smoothed.length - 1, tolerance, keep);
  return [...keep].sort((a, b) => a - b).map((index) => smoothed[index]!);
}
