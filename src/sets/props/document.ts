import { z } from 'zod';
import { PALETTES, type Palette } from '../palettes.ts';
import type { ParamValue } from '../schema.ts';
import { activeStyle } from '../../style/index.ts';
import { drawShape, drawStroke, rectPoints, ellipsePoints } from '../../style/wobble.ts';
import { compileField, compileExpr, truthy, type CompiledExpr, type Scope } from './expr.ts';
import {
  r, rect, ellipse, poly, line, STROKE_W,
  type PropDef, type PropContext, type ParamSpec, type PropInteractionGeometry,
} from './types.ts';

/**
 * A prop as data.
 *
 * The catalogue used to be TypeScript: a `render()` per prop composing calls to
 * the drawing helpers. That works, and it is also the reason nobody without an
 * editor open could add a waste bin to a room. This is the same thing expressed
 * as a document — a list of primitives that name the *same* helpers — so the
 * studio can write one, a model can emit one, and Blender can bake one, without
 * any of the three needing a compiler.
 *
 * The primitives are deliberately the four drawing helpers rather than a
 * general vector model. Everything the house style does — the wobble, the
 * jittered line weight, the off-register fill, the square treatment at the edge
 * of the world — happens because a prop draws through `rect`/`ellipse`/`poly`/
 * `line` and nothing else. Keeping the document at that level means a document
 * prop and a coded one are not merely similar, they take the same code path.
 *
 * Numbers may be expressions over the prop's own parameters (see `expr.ts`),
 * which is what lets a document prop resize, repeat and toggle exactly as a
 * coded one did.
 */

export const DOC_FORMAT = 2 as const;

/** Slot names come from a palette rather than a second hand-maintained list. */
export const PALETTE_SLOTS = Object.keys(PALETTES['office-fluorescent']!) as Array<keyof Palette>;

const Slot = z.enum(PALETTE_SLOTS as [string, ...string[]]);
const Flag = z.union([z.literal(0), z.literal(1)]);

/** A literal, or arithmetic over the prop's params. */
const Num = z.union([z.number().finite(), z.string().min(1)]);
type Num = z.infer<typeof Num>;

/**
 * Fields every drawn primitive shares.
 *
 * `sm` (smooth) and `e` (edge) are separate on purpose. Wobble and the fill
 * misregistration both move geometry a few units, which is invisible mid-picture
 * and opens a seam at the frame boundary — that is `e`, and it also drops the
 * outline. `sm` is the narrower case of something that should simply be drawn
 * crisply where it sits: a clock face, a moon. Before this the only way to get
 * one was to bypass the helpers and emit raw SVG.
 */
const visual = {
  /** Palette slot to fill with, or null for an unfilled shape. On a line, the stroke colour. */
  f: Slot.nullable().optional(),
  /** Draw the outline. Interior detail faces usually turn this off. */
  l: Flag.optional(),
  /** At the edge of the world: square, unwobbled, fill only. */
  e: Flag.optional(),
  /** Draw crisply, keeping the outline. */
  sm: Flag.optional(),
  o: Num.optional(),
  sw: Num.optional(),
  /** Degrees, about the primitive's own centre. */
  rot: Num.optional(),
  /** Expression; the primitive is omitted when it evaluates to zero. */
  show: z.string().min(1).optional(),
};

const RectP = z.object({ k: z.literal('rect'), x: Num, y: Num, w: Num, h: Num, rx: Num.optional(), ...visual });
const EllipseP = z.object({ k: z.literal('ellipse'), cx: Num, cy: Num, rx: Num, ry: Num, ...visual });
const PolyP = z.object({
  k: z.literal('poly'),
  /** Flat [x0, y0, x1, y1, ...] in the prop's local space. */
  p: z.array(Num).min(4).refine((v) => v.length % 2 === 0, 'points must be x,y pairs'),
  /** Closed polygon vs open polyline. */
  c: Flag.optional(),
  ...visual,
});
const LineP = z.object({ k: z.literal('line'), x1: Num, y1: Num, x2: Num, y2: Num, ...visual });
const TextP = z.object({
  k: z.literal('text'),
  x: Num, y: Num, size: Num,
  /** `$key` interpolates a text param. Always escaped before it reaches markup. */
  value: z.string(),
  anchor: z.enum(['start', 'middle', 'end']).optional(),
  weight: z.enum(['normal', 'bold']).optional(),
  /** Outline colour, for the fat translucent copy that makes a neon glow. */
  st: Slot.nullable().optional(),
  ...visual,
});

export type RectPrim = z.infer<typeof RectP>;
export type EllipsePrim = z.infer<typeof EllipseP>;
export type PolyPrim = z.infer<typeof PolyP>;
export type LinePrim = z.infer<typeof LineP>;
export type TextPrim = z.infer<typeof TextP>;
export interface RepeatPrim {
  k: 'repeat';
  /** How many times, rounded and clamped at zero. */
  n: Num;
  dx?: Num;
  dy?: Num;
  of: Primitive[];
  show?: string;
}
export type Primitive = RectPrim | EllipsePrim | PolyPrim | LinePrim | TextPrim | RepeatPrim;

/**
 * The recursion lives on `of` alone, not around the union.
 *
 * A discriminated union reads `k` off each member when it is built, which a
 * `z.lazy` wrapper hides — so the laziness is confined to the one field that
 * actually needs it, and every member stays a plain object the union can
 * inspect. That keeps the good error message: a malformed primitive is told
 * which kind it claimed to be rather than being tried against all six.
 */
const RepeatP = z.object({
  k: z.literal('repeat'),
  n: Num,
  dx: Num.optional(),
  dy: Num.optional(),
  of: z.array(z.lazy(() => PrimitiveP)).min(1, 'a repeat needs something to repeat'),
  show: z.string().min(1).optional(),
});

const PrimitiveP = z.discriminatedUnion('k', [RectP, EllipseP, PolyP, LineP, TextP, RepeatP]) as unknown as z.ZodType<Primitive>;

const ParamSpecP = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'must be a plain identifier'),
  label: z.string().min(1),
  type: z.enum(['number', 'text', 'boolean', 'choice']),
  default: z.union([z.number(), z.string(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  choices: z.array(z.string()).optional(),
});

const HandleP = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['grip', 'contact', 'placement', 'control', 'seat']),
  x: Num, y: Num, radius: Num,
  normal: z.object({ x: z.number(), y: z.number() }).optional(),
});

/**
 * Interaction geometry, which baked props never had.
 *
 * Without bounds and handles a prop is scenery: staging cannot address it, so
 * nobody can pick it up, sit on it or put a mug down on it. Expressions are
 * allowed here for the same reason they are allowed in geometry — a wider desk
 * has a wider work surface.
 */
const InteractionP = z.object({
  portable: z.boolean().default(false),
  bounds: z.object({ x: Num, y: Num, width: Num, height: Num }),
  handles: z.array(HandleP).default([]),
});

const ViewP = z.object({
  /** Format 2. */
  primitives: z.array(PrimitiveP).optional(),
  /** Format 1 geometry, still read so committed bakes keep working. */
  shapes: z.array(z.object({
    f: Slot.nullable().default(null),
    l: Flag.default(1),
    c: Flag.default(1),
    e: Flag.default(0),
    p: z.array(z.number().finite()).min(4).refine((v) => v.length % 2 === 0, 'points must be x,y pairs'),
  })).optional(),
}).refine((v) => v.primitives || v.shapes, 'a view needs primitives');

/**
 * Budgets.
 *
 * Point count is the real cost, not shape count: `drawShape` subdivides every
 * edge and emits a cubic per resulting point, so a shape's price is set by how
 * many points went in.
 *
 * The binding limit is aesthetic rather than computational. The house style is
 * a misprint look tuned for the 16-46 large shapes a person draws by hand;
 * several hundred outlined shapes reads as scribble, not as a room. These
 * numbers are set where someone has to justify themselves, not where the
 * renderer starts to struggle.
 */
export const BAKE_BUDGET = { warnShapes: 120, maxShapes: 300, warnPoints: 800, maxPoints: 2000 } as const;

export const PropDocument = z.object({
  format: z.union([z.literal(1), z.literal(2)]),
  key: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase kebab-case key'),
  label: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  spanning: z.boolean().default(false),
  params: z.array(ParamSpecP).default([]),
  provenance: z.object({
    blender: z.string().min(1),
    /** sha1 of build.py + bake.json, so a stale bake is detectable. */
    source: z.string().min(1),
    baked: z.string().min(1),
  }),
  /**
   * The stage the bake assumed. Spanning room bakes only.
   *
   * A room baked in perspective is committed to one geometry: where the floor
   * meets the wall, where the ceiling sits, how far the artwork reaches past
   * the frame. Recording it lets the linter say so when a set's own layout has
   * drifted from it.
   */
  frame: z.object({
    x0: z.number(), y0: z.number(),
    width: z.number().positive(), height: z.number().positive(),
    horizonY: z.number(), ceilingY: z.number(),
  }).optional(),
  interaction: InteractionP.optional(),
  views: z.record(z.string().min(1), ViewP).refine((v) => Object.keys(v).length > 0, 'needs at least one view'),
}).superRefine((doc, ctx) => {
  if (doc.spanning && !doc.frame) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['frame'],
      message: 'a spanning prop must record the frame it was drawn against',
    });
  }

  const keys = new Set<string>();
  for (const spec of doc.params) {
    if (keys.has(spec.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params'], message: `duplicate param "${spec.key}"` });
    }
    keys.add(spec.key);
    if (spec.type === 'choice' && !spec.choices?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params'], message: `choice param "${spec.key}" lists no choices` });
    }
  }
  // A text param contributes `<key>Length` to the numeric scope, so a param
  // that spells one of those would silently shadow it.
  for (const spec of doc.params) {
    if (spec.type === 'text' && keys.has(`${spec.key}Length`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['params'],
        message: `param "${spec.key}Length" collides with the length of text param "${spec.key}"`,
      });
    }
  }

  for (const [name, view] of Object.entries(doc.views)) {
    const counted = countView(view);
    if (counted.shapes > BAKE_BUDGET.maxShapes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['views', name],
        message:
          `${counted.shapes} shapes exceeds the ${BAKE_BUDGET.maxShapes} limit. Simplify the geometry or turn ` +
          'off outlines on interior detail — the house style does not survive this much line work.',
      });
    }
    if (counted.points > BAKE_BUDGET.maxPoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['views', name],
        message:
          `${counted.points} points exceeds the ${BAKE_BUDGET.maxPoints} limit. Every point becomes a cubic in ` +
          'the render page, so this is the budget that actually costs.',
      });
    }
  }
});
export type PropDocument = z.infer<typeof PropDocument>;
type View = z.infer<typeof ViewP>;

// --- budget ---------------------------------------------------------------

/** Shape and point totals at the params' defaults, which is what a budget means. */
export function countView(view: View): { shapes: number; points: number } {
  let shapes = 0;
  let points = 0;

  const walk = (prims: Primitive[], factor: number): void => {
    for (const prim of prims) {
      if (prim.k === 'repeat') {
        // An expression count cannot be known here; assume a small fixed
        // expansion so a repeat is not free, and let the render-time check in
        // `checkProp` catch a document that blows the budget at real params.
        const n = typeof prim.n === 'number' ? Math.max(0, Math.round(prim.n)) : 4;
        walk(prim.of, factor * n);
        continue;
      }
      shapes += factor;
      points += factor * (prim.k === 'poly' ? prim.p.length / 2 : prim.k === 'line' ? 2 : prim.k === 'text' ? 1 : 4);
    }
  };

  if (view.primitives) walk(view.primitives, 1);
  for (const s of view.shapes ?? []) {
    shapes += 1;
    points += s.p.length / 2;
  }
  return { shapes, points };
}

// --- compilation ----------------------------------------------------------

/** Loop variables, one per nesting level. Three is more than any real prop needs. */
const LOOP_VARS = ['i', 'j', 'k'] as const;
export const MAX_REPEAT_DEPTH: number = LOOP_VARS.length;

/** How many times a repeat may run, so a bad expression cannot hang a render. */
const MAX_REPEAT_COUNT = 512;

/** Every name an expression in this document may use. */
export function scopeNames(doc: PropDocument, depth = MAX_REPEAT_DEPTH): string[] {
  const names: string[] = [];
  for (const spec of doc.params) {
    if (spec.type === 'number' || spec.type === 'boolean') names.push(spec.key);
    if (spec.type === 'text') names.push(`${spec.key}Length`);
  }
  return [...names, ...LOOP_VARS.slice(0, depth)];
}

/** Bind the instance's params to numbers the expressions can read. */
function scopeFor(doc: PropDocument, params: Record<string, ParamValue>): Scope {
  const scope: Scope = {};
  for (const spec of doc.params) {
    const given = params[spec.key];
    if (spec.type === 'number') {
      scope[spec.key] = typeof given === 'number' && Number.isFinite(given) ? given : Number(spec.default) || 0;
    } else if (spec.type === 'boolean') {
      scope[spec.key] = (typeof given === 'boolean' ? given : Boolean(spec.default)) ? 1 : 0;
    } else if (spec.type === 'text') {
      const text = typeof given === 'string' ? given : String(spec.default);
      scope[`${spec.key}Length`] = text.length;
    }
  }
  return scope;
}

/**
 * What a primitive needs at render time.
 *
 * Numbers and text travel separately because the expression language is purely
 * numeric — a text param reaches arithmetic only as its length, and reaches
 * markup only through a text primitive.
 */
interface Frame {
  scope: Scope;
  text: Record<string, string>;
}

type Emit = (p: Palette, frame: Frame, out: string[]) => void;

interface Ctx {
  doc: PropDocument;
  names: string[];
  depth: number;
}

const field = (v: Num | undefined, ctx: Ctx, fallback: number): CompiledExpr =>
  v === undefined ? { source: String(fallback), refs: new Set(), eval: () => fallback } : compileField(v, ctx.names);

/** Wrap emitted markup when the primitive asked to be rotated or faded. */
function decorate(body: string, rot: CompiledExpr | null, opacity: CompiledExpr | null, cx: number, cy: number, scope: Scope): string {
  if (!body) return '';
  const attrs: string[] = [];
  if (rot) {
    const a = rot.eval(scope);
    if (a) attrs.push(`transform="rotate(${r(a)} ${r(cx)} ${r(cy)})"`);
  }
  if (opacity) {
    const o = opacity.eval(scope);
    if (o !== 1) attrs.push(`opacity="${r(o)}"`);
  }
  return attrs.length ? `<g ${attrs.join(' ')}>${body}</g>` : body;
}

/**
 * A crisp path: no wobble, no misregistered fill.
 *
 * With no stroke this is byte-for-byte what format 1 emitted for edge-of-world
 * shapes, which the committed room bakes depend on. With a stroke it is the
 * case that previously forced a prop to bypass the helpers entirely.
 */
function crisp(points: Array<[number, number]>, fill: string | null, stroke: string | null, width: number, closed: boolean): string {
  if (!fill && !stroke) return '';
  const d = `M ${points.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L ')}${closed ? ' Z' : ''}`;
  if (!stroke) return `<path d="${d}" fill="${fill}" stroke="none"/>`;
  return `<path d="${d}" fill="${fill ?? 'none'}" stroke="${stroke}" stroke-width="${r(width)}"/>`;
}

function compilePrimitive(prim: Primitive, ctx: Ctx): Emit {
  const show = prim.show ? compileExpr(prim.show, ctx.names) : null;

  if (prim.k === 'repeat') {
    if (ctx.depth >= MAX_REPEAT_DEPTH) {
      throw new Error(`repeats nest at most ${MAX_REPEAT_DEPTH} deep`);
    }
    const variable = LOOP_VARS[ctx.depth]!;
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1 };
    const n = compileField(prim.n, ctx.names);
    const dx = field(prim.dx, ctx, 0);
    const dy = field(prim.dy, ctx, 0);
    const children = prim.of.map((child) => compilePrimitive(child, inner));

    return (p, { scope, text }, out) => {
      if (show && !truthy(show.eval(scope))) return;
      const raw = n.eval(scope);
      const count = Number.isFinite(raw) ? Math.min(MAX_REPEAT_COUNT, Math.max(0, Math.round(raw))) : 0;
      for (let index = 0; index < count; index++) {
        // The index is in scope, which is what lets a repeat vary rather than
        // merely duplicate — a lit-window pattern, a tapering stack.
        const local: Scope = { ...scope, [variable]: index };
        const shifted: string[] = [];
        for (const child of children) child(p, { scope: local, text }, shifted);
        const body = shifted.join('');
        if (!body) continue;
        const ox = dx.eval(local) * index;
        const oy = dy.eval(local) * index;
        out.push(ox || oy ? `<g transform="translate(${r(ox)},${r(oy)})">${body}</g>` : body);
      }
    };
  }

  const opacity = prim.o === undefined ? null : compileField(prim.o, ctx.names);
  const rot = prim.rot === undefined ? null : compileField(prim.rot, ctx.names);
  const outline = prim.l !== 0;
  const edge = prim.e === 1;
  const smooth = prim.sm === 1;
  const slot = prim.f ?? null;
  const strokeWidth = field(prim.sw, ctx, STROKE_W);

  if (prim.k === 'rect') {
    const x = compileField(prim.x, ctx.names);
    const y = compileField(prim.y, ctx.names);
    const w = compileField(prim.w, ctx.names);
    const h = compileField(prim.h, ctx.names);
    const rx = field(prim.rx, ctx, 0);

    return (p, { scope, text }, out) => {
      if (show && !truthy(show.eval(scope))) return;
      const fill = slot ? p[slot as keyof Palette] : null;
      const [vx, vy, vw, vh] = [x.eval(scope), y.eval(scope), w.eval(scope), h.eval(scope)];
      let body: string;
      if (edge || smooth) {
        body = crisp(rectPoints(vx, vy, vw, vh, rx.eval(scope)), fill, edge || !outline ? null : p.line, strokeWidth.eval(scope), true);
      } else if (!fill) {
        body = crisp(rectPoints(vx, vy, vw, vh, rx.eval(scope)), null, outline ? p.line : null, strokeWidth.eval(scope), true);
      } else {
        body = rect(p, vx, vy, vw, vh, fill, {
          rx: rx.eval(scope),
          ...(outline ? {} : { outline: false }),
          ...(prim.sw === undefined ? {} : { strokeWidth: strokeWidth.eval(scope) }),
        });
      }
      out.push(decorate(body, rot, opacity, vx + vw / 2, vy + vh / 2, scope));
    };
  }

  if (prim.k === 'ellipse') {
    const cx = compileField(prim.cx, ctx.names);
    const cy = compileField(prim.cy, ctx.names);
    const rx = compileField(prim.rx, ctx.names);
    const ry = compileField(prim.ry, ctx.names);

    return (p, { scope, text }, out) => {
      if (show && !truthy(show.eval(scope))) return;
      const fill = slot ? p[slot as keyof Palette] : null;
      const [vcx, vcy, vrx, vry] = [cx.eval(scope), cy.eval(scope), rx.eval(scope), ry.eval(scope)];
      let body: string;
      if (edge || smooth) {
        // Enough samples that a crisp circle reads as a circle rather than a
        // polygon; the wobbled path deliberately uses fewer.
        const steps = Math.max(16, Math.min(48, Math.round((vrx + vry) / 3)));
        body = crisp(ellipsePoints(vcx, vcy, vrx, vry, steps), fill, edge || !outline ? null : p.line, strokeWidth.eval(scope), true);
      } else if (!fill) {
        const steps = Math.max(8, Math.min(18, Math.round((vrx + vry) / 6)));
        body = crisp(ellipsePoints(vcx, vcy, vrx, vry, steps), null, outline ? p.line : null, strokeWidth.eval(scope), true);
      } else {
        body = ellipse(p, vcx, vcy, vrx, vry, fill, outline ? {} : { outline: false });
      }
      out.push(decorate(body, rot, opacity, vcx, vcy, scope));
    };
  }

  if (prim.k === 'poly') {
    const pts = prim.p.map((v) => compileField(v, ctx.names));
    const closed = prim.c !== 0;

    return (p, { scope, text }, out) => {
      if (show && !truthy(show.eval(scope))) return;
      const fill = slot ? p[slot as keyof Palette] : null;
      const flat = pts.map((c) => c.eval(scope));
      const points: Array<[number, number]> = [];
      for (let n = 0; n < flat.length; n += 2) points.push([flat[n]!, flat[n + 1]!]);

      const body = edge || smooth
        ? crisp(points, fill, edge || !outline ? null : p.line, strokeWidth.eval(scope), closed)
        : drawShape(points, activeStyle(), fill, outline ? p.line : null, { closed });

      let cx = 0;
      let cy = 0;
      for (const [px, py] of points) { cx += px; cy += py; }
      out.push(decorate(body, rot, opacity, cx / points.length, cy / points.length, scope));
    };
  }

  if (prim.k === 'line') {
    const x1 = compileField(prim.x1, ctx.names);
    const y1 = compileField(prim.y1, ctx.names);
    const x2 = compileField(prim.x2, ctx.names);
    const y2 = compileField(prim.y2, ctx.names);

    return (p, { scope, text }, out) => {
      if (show && !truthy(show.eval(scope))) return;
      const colour = slot ? p[slot as keyof Palette] : p.line;
      const [a, b, c, d] = [x1.eval(scope), y1.eval(scope), x2.eval(scope), y2.eval(scope)];
      const width = strokeWidth.eval(scope);
      const body = smooth || edge
        ? crisp([[a, b], [c, d]], null, colour, width, false)
        : drawStroke([[a, b], [c, d]], activeStyle(), colour, width);
      out.push(decorate(body, rot, opacity, (a + c) / 2, (b + d) / 2, scope));
    };
  }

  // text
  const tx = compileField(prim.x, ctx.names);
  const ty = compileField(prim.y, ctx.names);
  const size = compileField(prim.size, ctx.names);
  const anchor = prim.anchor ?? 'middle';
  const weight = prim.weight ?? 'bold';
  const strokeSlot = prim.st ?? null;
  const template = prim.value;

  return (p, { scope, text }, out) => {
    if (show && !truthy(show.eval(scope))) return;
    const [vx, vy, vs] = [tx.eval(scope), ty.eval(scope), size.eval(scope)];
    const fill = slot ? p[slot as keyof Palette] : null;
    const stroke = strokeSlot ? p[strokeSlot as keyof Palette] : null;
    const attrs = [
      `x="${r(vx)}"`, `y="${r(vy)}"`,
      `text-anchor="${anchor}"`,
      'font-family="Arial, Helvetica, sans-serif"',
      `font-weight="${weight}"`,
      `font-size="${r(vs)}"`,
      `fill="${fill ?? 'none'}"`,
    ];
    if (stroke) attrs.push(`stroke="${stroke}"`, `stroke-width="${r(strokeWidth.eval(scope))}"`);
    const body = `<text ${attrs.join(' ')}>${escapeXml(resolveText(template, text))}</text>`;
    out.push(decorate(body, rot, opacity, vx, vy, scope));
  };
}

/** Text params reach a text primitive through `$key`. */
function resolveText(template: string, values: Record<string, string>): string {
  return template.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (whole, key: string) => values[key] ?? whole);
}

/** Params can carry user text, and it lands inside SVG markup. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --- format 1 -------------------------------------------------------------

/** Read a format-1 view as primitives. A baked shape is exactly a polygon. */
function upgrade(view: View): Primitive[] {
  if (view.primitives) return view.primitives;
  return (view.shapes ?? []).map((s): PolyPrim => ({
    k: 'poly', p: s.p, c: s.c, f: s.f, l: s.l, e: s.e,
  }));
}

// --- the prop ------------------------------------------------------------

function resolveInteraction(doc: PropDocument, scope: Scope): PropInteractionGeometry | undefined {
  if (!doc.interaction) return undefined;
  const names = scopeNames(doc, 0);
  const val = (v: Num): number => compileField(v, names).eval(scope);
  const { bounds, handles, portable } = doc.interaction;
  return {
    portable,
    bounds: { x: val(bounds.x), y: val(bounds.y), width: val(bounds.width), height: val(bounds.height) },
    handles: handles.map((h) => ({
      id: h.id, label: h.label, kind: h.kind,
      x: val(h.x), y: val(h.y), radius: val(h.radius),
      ...(h.normal ? { normal: h.normal } : {}),
    })),
  };
}

/**
 * Turn a document into a prop.
 *
 * Geometry goes through the same drawing helpers as everything else, which is
 * the whole reason this works: the wobble, the jittered line weight and the
 * off-register fill are applied to a document's rectangle exactly as they are
 * to a hand-written one, so a drawn desk and a baked staircase look like they
 * came from the same hand.
 */
export function propFromDocument(doc: PropDocument): PropDef {
  // Declaration order, not alphabetical: the first view in the file is the one
  // the author considers the prop's normal appearance, and sorting would make
  // that an accident of naming — "side" would quietly beat "three-quarter".
  const viewKeys = Object.keys(doc.views);
  const first = viewKeys[0]!;
  const names = scopeNames(doc);

  const compiled = new Map<string, Emit[]>();
  for (const [name, view] of Object.entries(doc.views)) {
    compiled.set(name, upgrade(view).map((prim) => compilePrimitive(prim, { doc, names, depth: 0 })));
  }

  // A multi-view prop gets a dropdown in the designer for free, because the UI
  // builds controls from these. An authored `view` param wins, so a document
  // can label its own views.
  const params: ParamSpec[] = [...doc.params];
  if (viewKeys.length > 1 && !params.some((p) => p.key === 'view')) {
    params.unshift({ key: 'view', label: 'View', type: 'choice', default: first, choices: viewKeys });
  }

  const textParams = doc.params.filter((p) => p.type === 'text');

  return {
    label: doc.label,
    tags: doc.tags,
    spanning: doc.spanning,
    ...(doc.frame ? { bakedFrame: doc.frame } : {}),
    params,
    ...(doc.interaction
      ? {
          interaction: resolveInteraction(doc, scopeFor(doc, {}))!,
          interactionFor: (p: Record<string, ParamValue>) => resolveInteraction(doc, scopeFor(doc, p))!,
        }
      : {}),
    render(ctx: PropContext): string {
      const chosen = typeof ctx.params['view'] === 'string' ? String(ctx.params['view']) : first;
      const emits = compiled.get(chosen) ?? compiled.get(first)!;
      const text: Record<string, string> = {};
      for (const spec of textParams) {
        const given = ctx.params[spec.key];
        text[spec.key] = typeof given === 'string' ? given : String(spec.default);
      }
      const out: string[] = [];
      const frame: Frame = { scope: scopeFor(doc, ctx.params), text };
      for (const emit of emits) emit(ctx.palette, frame, out);
      return out.join('');
    },
  };
}
