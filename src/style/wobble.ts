import type { Style } from './index.ts';

/**
 * Turning geometry into hand-drawn-looking paths.
 *
 * Every shape is converted to a path whose points are displaced by a small
 * amount, then smoothed. The displacement is a pure function of the point's own
 * coordinates — not of call order, not of a counter, not of time. That matters
 * more than it sounds:
 *
 *   - identical across renders, so the determinism test still passes
 *   - identical between frames, so lines sit still instead of boiling
 *   - identical for a shape wherever it appears, so a prop placed twice looks
 *     like the same prop
 */

/** Deterministic noise in [-1, 1] from two coordinates and a channel. */
function noise(x: number, y: number, channel: number): number {
  // Quantised so sub-unit float drift doesn't change the result.
  let h = Math.imul(Math.round(x * 4) | 0, 0x27d4eb2d);
  h ^= Math.imul(Math.round(y * 4) | 0, 0x165667b1);
  h ^= Math.imul(channel + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
}

export type Point = [number, number];

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Line weight varied per shape, so no two outlines are exactly equal. */
export function jitteredWidth(style: Style, x: number, y: number): number {
  if (style.lineWidthJitter <= 0) return style.lineWidth;
  return r2(style.lineWidth * (1 + noise(x, y, 7) * style.lineWidthJitter));
}

/** Displace a point perpendicular to the edge it sits on. */
function displace(p: Point, nx: number, ny: number, amount: number, channel: number): Point {
  const d = noise(p[0], p[1], channel) * amount;
  return [p[0] + nx * d, p[1] + ny * d];
}

/**
 * Subdivide a polyline and displace the new points sideways.
 *
 * Displacing only the corners bends a shape; displacing points along each edge
 * is what makes the edge itself look drawn rather than ruled.
 */
function wobblePoints(points: Point[], style: Style, closed: boolean, amplitude: number): Point[] {
  if (amplitude <= 0) return points;

  const out: Point[] = [];
  const n = points.length;
  const last = closed ? n : n - 1;

  for (let i = 0; i < last; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // Unit normal to this edge.
    const nx = -dy / len;
    const ny = dx / len;

    // Short edges get fewer subdivisions; three wiggles across a 12-unit hand
    // is not texture, it is damage.
    const segments = Math.max(1, Math.min(style.wobbleSegments, Math.floor(len / 14) + 1));
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const p: Point = [a[0] + dx * t, a[1] + dy * t];
      // Corners move less than mid-edge points, so shapes keep their silhouette.
      const amount = amplitude * (s === 0 ? 0.45 : 1);
      out.push(displace(p, nx, ny, amount, s));
    }
  }

  if (!closed) out.push(points[n - 1]!);
  return out;
}

/** Catmull-Rom through the points, emitted as cubic beziers. */
function smoothPath(points: Point[], closed: boolean): string {
  const n = points.length;
  if (n < 2) return '';

  const at = (i: number): Point =>
    closed ? points[((i % n) + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!;

  let d = `M ${r2(points[0]![0])} ${r2(points[0]![1])}`;
  const segments = closed ? n : n - 1;

  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${r2(c1[0])} ${r2(c1[1])}, ${r2(c2[0])} ${r2(c2[1])}, ${r2(p2[0])} ${r2(p2[1])}`;
  }

  return closed ? `${d} Z` : d;
}

/**
 * Wobble scaled to the size of the thing being drawn.
 *
 * A hand-drawn line deviates by roughly a constant *fraction* of what it is
 * drawing, not a constant number of units. Applying a flat amplitude gives a
 * wall a pleasant waver and shreds a hand — so amplitude is derived from the
 * shape's own extent, then clamped so nothing is either imperceptible or
 * destroyed.
 */
export function amplitudeFor(points: Point[], style: Style): number {
  if (style.wobble <= 0) return 0;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // The short side governs: a long thin limb is as fragile as a small blob.
  const extent = Math.min(maxX - minX, maxY - minY);
  const scaled = style.wobble * (extent / 110);
  return Math.max(0.25, Math.min(style.wobble, scaled));
}

/** A polygon's outline as a hand-drawn path. */
export function wobbleShape(points: Point[], style: Style, closed = true, amplitude?: number): string {
  const amount = amplitude ?? amplitudeFor(points, style);
  return smoothPath(wobblePoints(points, style, closed, amount), closed);
}

/** Sample an ellipse as a polygon so it can go through the same treatment. */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, steps = 14): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** A rectangle as a polygon, optionally with corners cut for rounding. */
export function rectPoints(x: number, y: number, w: number, h: number, radius = 0): Point[] {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0.5) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }
  return [
    [x + r, y],
    [x + w - r, y],
    [x + w, y + r],
    [x + w, y + h - r],
    [x + w - r, y + h],
    [x + r, y + h],
    [x, y + h - r],
    [x, y + r],
  ];
}

/**
 * A filled, outlined shape with the fill deliberately off-register.
 *
 * Two paths: the fill, shifted; then the outline, in place. The fill spilling
 * past one edge and falling short of the other is the whole misprint effect.
 */
export function drawShape(
  points: Point[],
  style: Style,
  fill: string | null,
  line: string | null,
  opts: { closed?: boolean; widthScale?: number } = {},
): string {
  const closed = opts.closed ?? true;
  const amplitude = amplitudeFor(points, style);
  const d = wobbleShape(points, style, closed, amplitude);
  if (!d) return '';

  let out = '';
  const anchor = points[0] ?? [0, 0];

  if (fill) {
    // Misregistration scales with the shape too. A 2px offset on a wall is a
    // printing artefact; the same offset on a finger is a missing finger.
    const k = style.wobble > 0 ? amplitude / style.wobble : 1;
    const ox = style.fillOffset[0] * k;
    const oy = style.fillOffset[1] * k;
    const shifted = ox || oy ? ` transform="translate(${r2(ox)},${r2(oy)})"` : '';
    out += `<path d="${d}" fill="${fill}" stroke="none"${shifted}/>`;
  }

  if (line) {
    const w = jitteredWidth(style, anchor[0], anchor[1]) * (opts.widthScale ?? 1);
    out += `<path d="${d}" fill="none" stroke="${line}" stroke-width="${r2(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  return out;
}

/** An open stroke — a rail, a seam, a table edge. */
export function drawStroke(
  points: Point[],
  style: Style,
  colour: string,
  width: number,
): string {
  const d = wobbleShape(points, style, false, style.wobble * 0.6);
  if (!d) return '';
  const w = style.lineWidthJitter
    ? width * (1 + noise(points[0]![0], points[0]![1], 11) * style.lineWidthJitter)
    : width;
  return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${r2(w)}" stroke-linecap="round"/>`;
}

/**
 * Paper grain, as a tiled speckle pattern.
 *
 * A pattern rather than an SVG filter: filters like feTurbulence can render
 * differently across browser versions, and the determinism test compares actual
 * pixels.
 */
export function grainOverlay(style: Style, id: string, x: number, y: number, w: number, h: number): string {
  if (style.grain <= 0) return '';

  const tile = 64;
  let dots = '';
  for (let i = 0; i < 90; i++) {
    const px = ((noise(i, 1, 3) + 1) / 2) * tile;
    const py = ((noise(i, 2, 4) + 1) / 2) * tile;
    const rr = 0.5 + ((noise(i, 3, 5) + 1) / 2) * 0.9;
    dots += `<circle cx="${r2(px)}" cy="${r2(py)}" r="${r2(rr)}" fill="#000"/>`;
  }

  return (
    `<defs><pattern id="${id}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">${dots}</pattern></defs>` +
    `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="url(#${id})" opacity="${r2(style.grain)}" pointer-events="none"/>`
  );
}
