/**
 * Seeded deterministic RNG.
 *
 * Every stochastic decision in the compiler — blink timing, gesture jitter,
 * hold lengths — draws from one of these. `Math.random` is banned engine-side:
 * a scene must render identically on every run or the determinism test is
 * meaningless and re-renders can't be trusted.
 */

/** mulberry32: small, fast, good enough distribution, trivially reproducible. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    // Discard the first few outputs. mulberry32's initial values correlate with
    // the seed, so similar seeds — which is exactly what deriveSeed produces
    // for similar labels — give similar first draws. Without this, the first
    // choice made from a stream clusters: five characters rolled three
    // identical body types.
    for (let i = 0; i < 4; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * Exponentially-distributed interval for a Poisson process of the given rate.
   * Used for blinks, which cluster naturally rather than landing on a metronome.
   */
  exponential(ratePerSecond: number): number {
    if (ratePerSecond <= 0) return Infinity;
    return -Math.log(1 - this.next()) / ratePerSecond;
  }
}

/**
 * Derive a stable child seed from a parent seed and a label.
 *
 * Lets each actor own an independent RNG stream, so adding a character to a
 * scene doesn't reshuffle everyone else's blinks. FNV-1a over the label.
 */
export function deriveSeed(parentSeed: number, label: string): number {
  let h = 0x811c9dc5 ^ (parentSeed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Avalanche (murmur3 fmix32). FNV-1a alone leaves short, similar labels —
  // which is exactly what character names are — producing adjacent seeds, and
  // adjacent seeds produce similar first draws however much the stream is
  // warmed up. Without this, eight characters rolled five identical builds.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
