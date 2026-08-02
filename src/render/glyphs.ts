import { activeStyle } from '../style/index.ts';
import { drawStroke, type Point } from '../style/wobble.ts';

/**
 * The house letterforms.
 *
 * Title cards must not depend on whatever fonts a machine happens to have, so
 * the engine owns its own alphabet: chunky single-stroke uppercase glyphs on a
 * 10x14 grid, drawn through the same wobble treatment as everything else. The
 * lettering therefore carries the show's line identity — a heavy shaky profile
 * letters heavily and shakily — and renders identically everywhere.
 *
 * Uppercase only, on purpose. It is a card vocabulary, not a text engine.
 */

type Stroke = Point[];

/** Glyph skeletons in a 0..10 x 0..14 box. */
const GLYPHS: Record<string, Stroke[]> = {
  A: [[[0, 14], [5, 0], [10, 14]], [[2, 9], [8, 9]]],
  B: [[[0, 0], [0, 14]], [[0, 0], [7, 0], [9, 2], [9, 5], [7, 7], [0, 7]], [[7, 7], [10, 9], [10, 12], [8, 14], [0, 14]]],
  C: [[[10, 2], [8, 0], [3, 0], [0, 3], [0, 11], [3, 14], [8, 14], [10, 12]]],
  D: [[[0, 0], [0, 14]], [[0, 0], [6, 0], [10, 4], [10, 10], [6, 14], [0, 14]]],
  E: [[[10, 0], [0, 0], [0, 14], [10, 14]], [[0, 7], [7, 7]]],
  F: [[[10, 0], [0, 0], [0, 14]], [[0, 7], [7, 7]]],
  G: [[[10, 2], [7, 0], [3, 0], [0, 3], [0, 11], [3, 14], [8, 14], [10, 12], [10, 8], [6, 8]]],
  H: [[[0, 0], [0, 14]], [[10, 0], [10, 14]], [[0, 7], [10, 7]]],
  I: [[[2, 0], [8, 0]], [[5, 0], [5, 14]], [[2, 14], [8, 14]]],
  J: [[[10, 0], [10, 11], [7, 14], [3, 14], [0, 11]]],
  K: [[[0, 0], [0, 14]], [[10, 0], [0, 7], [10, 14]]],
  L: [[[0, 0], [0, 14], [10, 14]]],
  M: [[[0, 14], [0, 0], [5, 7], [10, 0], [10, 14]]],
  N: [[[0, 14], [0, 0], [10, 14], [10, 0]]],
  O: [[[3, 0], [7, 0], [10, 3], [10, 11], [7, 14], [3, 14], [0, 11], [0, 3], [3, 0]]],
  P: [[[0, 14], [0, 0], [8, 0], [10, 2], [10, 6], [8, 8], [0, 8]]],
  Q: [[[3, 0], [7, 0], [10, 3], [10, 11], [7, 14], [3, 14], [0, 11], [0, 3], [3, 0]], [[6, 10], [11, 15]]],
  R: [[[0, 14], [0, 0], [8, 0], [10, 2], [10, 6], [8, 8], [0, 8]], [[4, 8], [10, 14]]],
  S: [[[10, 2], [7, 0], [2, 0], [0, 2], [0, 5], [2, 7], [8, 7], [10, 9], [10, 12], [8, 14], [2, 14], [0, 12]]],
  T: [[[0, 0], [10, 0]], [[5, 0], [5, 14]]],
  U: [[[0, 0], [0, 11], [3, 14], [7, 14], [10, 11], [10, 0]]],
  V: [[[0, 0], [5, 14], [10, 0]]],
  W: [[[0, 0], [2, 14], [5, 6], [8, 14], [10, 0]]],
  X: [[[0, 0], [10, 14]], [[10, 0], [0, 14]]],
  Y: [[[0, 0], [5, 7], [10, 0]], [[5, 7], [5, 14]]],
  Z: [[[0, 0], [10, 0], [0, 14], [10, 14]]],
  '0': [[[3, 0], [7, 0], [10, 3], [10, 11], [7, 14], [3, 14], [0, 11], [0, 3], [3, 0]], [[2, 11], [8, 3]]],
  '1': [[[3, 3], [5, 0], [5, 14]], [[2, 14], [8, 14]]],
  '2': [[[0, 3], [2, 0], [8, 0], [10, 3], [10, 5], [0, 14], [10, 14]]],
  '3': [[[0, 2], [2, 0], [8, 0], [10, 2], [10, 5], [7, 7], [10, 9], [10, 12], [8, 14], [2, 14], [0, 12]]],
  '4': [[[8, 14], [8, 0], [0, 10], [10, 10]]],
  '5': [[[10, 0], [0, 0], [0, 6], [7, 6], [10, 9], [10, 12], [7, 14], [2, 14], [0, 12]]],
  '6': [[[9, 1], [5, 0], [2, 1], [0, 4], [0, 11], [2, 14], [7, 14], [10, 12], [10, 9], [7, 7], [0, 8]]],
  '7': [[[0, 0], [10, 0], [4, 14]]],
  '8': [[[3, 7], [1, 5], [1, 2], [3, 0], [7, 0], [9, 2], [9, 5], [7, 7], [3, 7]], [[3, 7], [0, 9], [0, 12], [3, 14], [7, 14], [10, 12], [10, 9], [7, 7], [3, 7]]],
  '9': [[[10, 7], [3, 8], [0, 5], [0, 2], [3, 0], [7, 0], [10, 3], [10, 10], [8, 13], [3, 14]]],
  '.': [[[5, 13], [5, 14]]],
  ',': [[[5, 12], [4, 15]]],
  '!': [[[5, 0], [5, 9]], [[5, 13], [5, 14]]],
  '?': [[[0, 3], [2, 0], [8, 0], [10, 3], [10, 5], [5, 8], [5, 10]], [[5, 13], [5, 14]]],
  "'": [[[5, 0], [4, 3]]],
  '-': [[[2, 7], [8, 7]]],
  ':': [[[5, 4], [5, 5]], [[5, 10], [5, 11]]],
  '&': [[[10, 14], [2, 5], [2, 2], [4, 0], [6, 0], [8, 2], [8, 4], [0, 10], [0, 12], [2, 14], [5, 14], [8, 11]]],
};

/** Grid units a glyph advances the pen, including its gap. */
const ADVANCE = 13;
const GLYPH_H = 14;

/** Characters the alphabet can draw. Anything else becomes a space. */
export function supportedText(text: string): string {
  return text
    .toUpperCase()
    .split('')
    .map((ch) => (GLYPHS[ch] || ch === ' ' ? ch : ' '))
    .join('');
}

/** Width of a line of text at a given size, in drawing units. */
export function measureText(text: string, size: number): number {
  const chars = supportedText(text).length;
  if (!chars) return 0;
  return ((chars * ADVANCE - (ADVANCE - 10)) * size) / GLYPH_H;
}

export interface TextOptions {
  x: number;
  y: number;
  /** Cap height in drawing units. */
  size: number;
  colour: string;
  /** 'start' draws rightward from x; 'middle' centres on it. */
  anchor?: 'start' | 'middle';
  /** Stroke weight relative to size. The marker nib. */
  weight?: number;
}

/**
 * A line of text as wobbled strokes.
 *
 * Every stroke goes through `drawStroke`, so the treatment — width jitter,
 * wobble amplitude — comes from the active identity like all other linework.
 * Deterministic per (text, position, size): the same title letters identically
 * on every frame it appears in.
 */
export function renderText(text: string, opts: TextOptions): string {
  const clean = supportedText(text);
  const style = activeStyle();
  const scale = opts.size / GLYPH_H;
  const weight = (opts.weight ?? 0.18) * opts.size;

  let x = opts.anchor === 'middle' ? opts.x - measureText(clean, opts.size) / 2 : opts.x;
  let out = '';

  for (const ch of clean) {
    const strokes = GLYPHS[ch];
    if (strokes) {
      for (const stroke of strokes) {
        const placed: Point[] = stroke.map(([gx, gy]) => [x + gx * scale, opts.y + gy * scale]);
        out += drawStroke(placed, style, opts.colour, weight);
      }
    }
    x += ADVANCE * scale;
  }
  return out;
}
