import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROPS_DIR } from '../../core/paths.ts';
import { PALETTES, type Palette } from '../palettes.ts';
import { activeStyle } from '../../style/index.ts';
import { drawShape } from '../../style/wobble.ts';
import { r, str, type PropDef, type PropContext } from './types.ts';

/**
 * Props whose geometry was produced outside the engine.
 *
 * The foundry projects 3D geometry down to flat polylines and writes them here
 * as data; this turns one of those files into an ordinary `PropDef`. Everything
 * downstream — the designer palette, the set schema enum, validation, the
 * renderer — sees a prop indistinguishable from a hand-written one, because by
 * the time it gets there it *is* one.
 *
 * The important consequence is what does not happen: nothing external runs at
 * render time. Baked geometry is committed, so a render needs no Blender, no
 * Python and no network, and the determinism guarantee is untouched.
 */

/** Slot names come from a palette rather than a second hand-maintained list. */
export const PALETTE_SLOTS = Object.keys(PALETTES['office-fluorescent']!) as Array<keyof Palette>;

const PaletteSlot = z.enum(PALETTE_SLOTS as [string, ...string[]]);

/**
 * One projected shape.
 *
 * Keys are short and points are a flat number array because a baked room runs
 * to a few hundred of these and the nesting costs more than it reads.
 */
const BakedShape = z.object({
  /** Palette slot to fill with, or null for an unfilled line. */
  f: PaletteSlot.nullable().default(null),
  /** Draw the outline. Interior detail faces usually turn this off. */
  l: z.union([z.literal(0), z.literal(1)]).default(1),
  /** Closed polygon vs open polyline. */
  c: z.union([z.literal(0), z.literal(1)]).default(1),
  /**
   * At the edge of the world.
   *
   * Wobble and the deliberate fill misregistration both move geometry by a few
   * units, which is invisible in the middle of a picture and opens a seam at its
   * boundary. Anything touching the frame therefore draws square, exactly as
   * `rect(..., { outline: false })` does for walls and floors.
   */
  e: z.union([z.literal(0), z.literal(1)]).default(0),
  /** Flat [x0, y0, x1, y1, ...] in the prop's local space. */
  p: z.array(z.number().finite()).min(4).refine((v) => v.length % 2 === 0, 'points must be x,y pairs'),
});
export type BakedShape = z.infer<typeof BakedShape>;

const BakedView = z.object({
  shapes: z.array(BakedShape),
});

export const BAKED_FORMAT = 1 as const;

/**
 * Budgets.
 *
 * Point count is the real cost, not shape count: `drawShape` subdivides every
 * edge and emits a cubic per resulting point, so a shape's price is set by how
 * many points went in. Measured against the hand-authored sets, an outlined
 * shape costs roughly 1 KB of page markup and about 288 bytes per input point.
 *
 * The binding limit is aesthetic rather than computational, though. The house
 * style is a misprint look tuned for the 16-46 large shapes a person draws by
 * hand; several hundred outlined shapes reads as scribble, not as a room. These
 * numbers are set where someone has to justify themselves, not where the
 * renderer starts to struggle.
 */
export const BAKE_BUDGET = { warnShapes: 120, maxShapes: 300, warnPoints: 800, maxPoints: 2000 } as const;

export const BakedProp = z.object({
  format: z.literal(BAKED_FORMAT),
  key: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase kebab-case key'),
  label: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  spanning: z.boolean().default(false),
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
   * meets the wall, where the ceiling sits, how far the artwork reaches past the
   * frame. Recording it lets the linter say so when a set's own layout has
   * drifted from it, instead of leaving someone to wonder why the characters
   * stand halfway up the back wall.
   */
  frame: z.object({
    x0: z.number(),
    y0: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    horizonY: z.number(),
    ceilingY: z.number(),
  }).optional(),
  views: z.record(z.string().min(1), BakedView).refine((v) => Object.keys(v).length > 0, 'needs at least one view'),
}).superRefine((prop, ctx) => {
  if (prop.spanning && !prop.frame) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['frame'],
      message: 'a spanning bake must record the frame it was baked against',
    });
  }
  for (const [name, view] of Object.entries(prop.views)) {
    const points = view.shapes.reduce((sum, s) => sum + s.p.length / 2, 0);
    if (view.shapes.length > BAKE_BUDGET.maxShapes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['views', name],
        message:
          `${view.shapes.length} shapes exceeds the ${BAKE_BUDGET.maxShapes} limit. Simplify the source ` +
          'geometry or turn off outlines on interior detail faces — the house style does not survive this ' +
          'much line work.',
      });
    }
    if (points > BAKE_BUDGET.maxPoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['views', name],
        message:
          `${points} points exceeds the ${BAKE_BUDGET.maxPoints} limit. Every point becomes a cubic in the ` +
          'render page, so this is the budget that actually costs.',
      });
    }
  }
});
export type BakedProp = z.infer<typeof BakedProp>;

/** Flat [x,y,x,y] back into the pairs `drawShape` wants. */
function pairs(flat: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** A square, unwobbled path — for shapes that reach the edge of the world. */
function flatPath(flat: number[], fill: string | null, closed: boolean): string {
  if (!fill) return '';
  const pts = pairs(flat).map(([x, y]) => `${r(x)} ${r(y)}`).join(' L ');
  return `<path d="M ${pts}${closed ? ' Z' : ''}" fill="${fill}" stroke="none"/>`;
}

/**
 * Turn a baked manifest into a prop.
 *
 * Geometry goes through `drawShape` like everything else, which is the whole
 * reason this approach works: the wobble, the jittered line weight and the
 * off-register fill are applied to imported polylines exactly as they are to a
 * hand-authored rectangle, so a baked staircase and a drawn desk look like they
 * came from the same hand.
 */
export function bakedProp(manifest: BakedProp): PropDef {
  // Declaration order, not alphabetical: the first view in the file is the one
  // the author considers the prop's normal appearance, and sorting would make
  // that an accident of naming — "side" would quietly beat "three-quarter".
  const viewKeys = Object.keys(manifest.views);
  const first = viewKeys[0]!;

  return {
    label: manifest.label,
    tags: manifest.tags,
    spanning: manifest.spanning,
    ...(manifest.frame ? { bakedFrame: manifest.frame } : {}),
    // A single-view prop takes no parameters; a multi-view one gets a dropdown
    // in the designer for free, because the UI builds controls from this.
    params: viewKeys.length > 1
      ? [{ key: 'view', label: 'View', type: 'choice' as const, default: first, choices: viewKeys }]
      : [],
    render(ctx: PropContext): string {
      const view = manifest.views[str(ctx, 'view', first)] ?? manifest.views[first]!;
      const style = activeStyle();
      let out = '';
      for (const shape of view.shapes) {
        const fill = shape.f ? ctx.palette[shape.f as keyof Palette] : null;
        if (shape.e) {
          out += flatPath(shape.p, fill, shape.c === 1);
          continue;
        }
        out += drawShape(pairs(shape.p), style, fill, shape.l ? ctx.palette.line : null, {
          closed: shape.c === 1,
        });
      }
      return out;
    },
  };
}

export interface BakedPropError {
  file: string;
  error: string;
}

export interface LoadedBakedProps {
  props: Record<string, PropDef>;
  errors: BakedPropError[];
  /** Totals for `doctor`, so a bloated bake is visible without opening files. */
  shapes: number;
  points: number;
}

/**
 * Read every baked prop under `props/`.
 *
 * Deliberately never throws. This runs at module load, and a throw here would
 * take down the CLI, the server and `doctor` together — leaving no tool capable
 * of reporting which file is broken. Collecting the failures instead means a set
 * referencing a broken prop gets the ordinary "unknown prop" error while doctor
 * shows the real cause, which is the same bargain `Availability` makes
 * everywhere else: unavailable with a remedy beats a stack trace.
 */
export function loadBakedProps(dir: string = PROPS_DIR): LoadedBakedProps {
  const out: LoadedBakedProps = { props: {}, errors: [], shapes: 0, points: 0 };

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    // No props directory at all is the normal state of a fresh checkout.
    return out;
  }

  for (const entry of entries) {
    const file = path.join(dir, entry, `${entry}.geo.json`);
    if (!fs.existsSync(file)) continue;
    const rel = path.relative(dir, file).replace(/\\/g, '/');

    try {
      const parsed = BakedProp.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.key !== entry) {
        out.errors.push({ file: rel, error: `key "${parsed.key}" does not match its directory "${entry}"` });
        continue;
      }
      for (const view of Object.values(parsed.views)) {
        out.shapes += view.shapes.length;
        for (const shape of view.shapes) out.points += shape.p.length / 2;
      }
      out.props[parsed.key] = bakedProp(parsed);
    } catch (err) {
      out.errors.push({ file: rel, error: (err as Error).message });
    }
  }

  return out;
}

const loaded = loadBakedProps();

export const BAKED_PROPS: Record<string, PropDef> = loaded.props;
export const BAKED_ERRORS: BakedPropError[] = loaded.errors;
export const BAKED_TOTALS = { shapes: loaded.shapes, points: loaded.points };
