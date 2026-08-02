import type { Palette } from '../palettes.ts';
import type { SetGeometry, ParamValue } from '../schema.ts';
import { activeStyle } from '../../style/index.ts';
import { drawShape, drawStroke, rectPoints, ellipsePoints } from '../../style/wobble.ts';

/**
 * Prop authoring contract.
 *
 * A prop draws itself in **local coordinates around (0, 0)**, where the origin
 * is the centre of where it meets the floor. The registry applies position,
 * scale and mirroring, so no prop does its own transform arithmetic — which is
 * exactly the class of bug that made the first puppet fall apart.
 *
 * The exception is `spanning` props (walls, floors, skies). Those cover the
 * whole set, ignore x, and draw in set coordinates using `geo`.
 */
export interface PropContext {
  palette: Palette;
  geo: SetGeometry;
  /** Read with the `num`/`str`/`bool` helpers so defaults are applied. */
  params: Record<string, ParamValue>;
  /** Set coordinates. Only meaningful to spanning props; others are pre-translated. */
  x: number;
  y: number;
}

export type ParamType = 'number' | 'text' | 'boolean' | 'choice';

/**
 * A prop's tunable value.
 *
 * Declared once here and the designer UI builds the right control from it —
 * a slider, a text field, a dropdown. Adding a param to a prop should never
 * mean touching the UI.
 */
export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
}

/** Axis-aligned local-space collision/selection bounds before instance transforms. */
export interface PropLocalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PropHandleKind = 'grip' | 'contact' | 'placement' | 'control';

/**
 * A stable interaction point in the prop's authored local coordinates.
 *
 * Consumers apply the PropInstance x/y/scale/flip transform. `radius` is the
 * useful snap/pick radius, not visual geometry; `normal` describes the outward
 * contact direction where one is meaningful.
 */
export interface PropInteractionHandle {
  id: string;
  label: string;
  kind: PropHandleKind;
  x: number;
  y: number;
  radius: number;
  normal?: { x: number; y: number };
}

/** Interaction metadata kept beside the renderer so catalogue entries cannot drift. */
export interface PropInteractionGeometry {
  /** True when attach/detach actions may move the prop away from its set placement. */
  portable: boolean;
  bounds: PropLocalBounds;
  handles: PropInteractionHandle[];
}

export interface PropDef {
  label: string;
  tags: string[];
  params: ParamSpec[];
  /** Spans the whole set and draws in set coordinates. Walls, floors, skies. */
  spanning?: boolean;
  /** Optional local-space bounds and stable handles for staging/contact authoring. */
  interaction?: PropInteractionGeometry;
  render(ctx: PropContext): string;
}

// --- param readers --------------------------------------------------------

export function num(ctx: PropContext, key: string, fallback: number): number {
  const v = ctx.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(ctx: PropContext, key: string, fallback: string): string {
  const v = ctx.params[key];
  return typeof v === 'string' ? v : fallback;
}

export function bool(ctx: PropContext, key: string, fallback: boolean): boolean {
  const v = ctx.params[key];
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Local-space y of the ceiling.
 *
 * Local origin sits on the floor, so anything that hangs rather than stands —
 * lights, signs, ceiling fans — draws at a negative y measured from here. Saves
 * every descriptor having to hardcode a y for its light fittings.
 */
export function ceilingLocalY(ctx: PropContext): number {
  return ctx.geo.ceilingY - ctx.geo.horizonY;
}

// --- drawing helpers ------------------------------------------------------

/**
 * Every prop draws through these, so the house style is applied in one place
 * rather than thirty. A prop describes *what* it is; the style decides how it
 * is rendered.
 */
export const STROKE_W = 3;

export function stroke(palette: Palette, width = STROKE_W): string {
  return `stroke="${palette.line}" stroke-width="${width}"`;
}

export function rect(
  p: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  opts: { rx?: number; outline?: boolean; strokeWidth?: number } = {},
): string {
  const style = activeStyle();

  // An unoutlined fill is a background — a wall, a floor, a sky. Wobbling those
  // opens gaps at the edge of the world, so they stay square.
  if (opts.outline === false) {
    return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${fill}"/>`;
  }

  const scale = opts.strokeWidth ? opts.strokeWidth / STROKE_W : 1;
  return drawShape(rectPoints(x, y, w, h, opts.rx ?? 0), style, fill, p.line, { widthScale: scale });
}

export function ellipse(
  p: Palette,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill: string,
  opts: { outline?: boolean } = {},
): string {
  const style = activeStyle();
  if (opts.outline === false) {
    return `<ellipse cx="${r(cx)}" cy="${r(cy)}" rx="${r(rx)}" ry="${r(ry)}" fill="${fill}"/>`;
  }
  // Fewer samples on small shapes, or the wobble overwhelms them.
  const steps = Math.max(8, Math.min(18, Math.round((rx + ry) / 6)));
  return drawShape(ellipsePoints(cx, cy, rx, ry, steps), style, fill, p.line);
}

export function poly(p: Palette, points: Array<[number, number]>, fill: string, outline = true): string {
  return drawShape(points, activeStyle(), fill, outline ? p.line : null);
}

export function line(p: Palette, x1: number, y1: number, x2: number, y2: number, colour: string, width = STROKE_W): string {
  return drawStroke([[x1, y1], [x2, y2]], activeStyle(), colour, width);
}

/**
 * Round to 2dp.
 *
 * Set SVG is embedded in the render page and hashed for frame dedup, so
 * trimming float noise keeps both smaller and stable.
 */
export function r(v: number): number {
  return Math.round(v * 100) / 100;
}
