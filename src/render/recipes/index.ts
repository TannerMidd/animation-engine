import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ParamSpec } from '../../sets/props/types.ts';

/**
 * Ready-made Blender sources, so nobody has to write Python to bake a prop.
 *
 * Baking exists for the props a flat elevation cannot describe — anything with
 * a visible top face, anything in perspective. That was worth having and it was
 * also gated behind writing a `build.py`, which is a much higher wall than
 * "open Blender" sounds like.
 *
 * A recipe is a `build.py` that takes parameters plus a declaration of what
 * those parameters are, so the studio can render the form the same way it
 * renders a prop's controls. Picking "box stack" and setting a count is the
 * whole interaction.
 *
 * Deliberately not model-written. A `build.py` is arbitrary Python executed by
 * Blender, and a form gets a better result with none of the exposure.
 */

const RECIPES_DIR = fileURLToPath(new URL('.', import.meta.url));

const ParamSpecP = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['number', 'text', 'boolean', 'choice']),
  default: z.union([z.number(), z.string(), z.boolean()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  choices: z.array(z.string()).optional(),
});

const RecipeManifest = z.object({
  label: z.string().min(1),
  blurb: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Which params describe the object's size, for framing the camera. */
  fit: z.array(z.string()).min(1),
  params: z.array(ParamSpecP).default([]),
  /**
   * Camera directions rather than positions.
   *
   * A recipe does not know how big the thing will be — that is what the form is
   * for — so it says which way to look from and the distance is worked out from
   * the parameters the author marked as sizes.
   */
  views: z.record(z.string().min(1), z.object({
    dir: z.tuple([z.number(), z.number(), z.number()]),
    /** Height of the look-at point, as a fraction of the object's span. */
    aim: z.number().default(0.4),
  })),
});
export type RecipeManifest = z.infer<typeof RecipeManifest>;

export interface Recipe extends RecipeManifest {
  name: string;
  build: string;
}

export function listRecipes(dir: string = RECIPES_DIR): Recipe[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const out: Recipe[] = [];
  for (const name of entries) {
    const manifest = path.join(dir, name, 'recipe.json');
    const build = path.join(dir, name, 'build.py');
    if (!fs.existsSync(manifest) || !fs.existsSync(build)) continue;
    try {
      const parsed = RecipeManifest.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')));
      out.push({ ...parsed, name, build });
    } catch {
      // A malformed recipe is a bug in the engine, not in anybody's prop, so it
      // is simply not offered rather than breaking the list for everything else.
      continue;
    }
  }
  return out;
}

export function getRecipe(name: string, dir?: string): Recipe | null {
  return listRecipes(dir).find((r) => r.name === name) ?? null;
}

/** Defaults, then whatever the form supplied, coerced to the declared types. */
export function resolveParams(recipe: Recipe, given: Record<string, unknown>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const spec of recipe.params) {
    const value = given[spec.key];
    if (spec.type === 'number') {
      const asNumber = typeof value === 'number' ? value : Number(value);
      out[spec.key] = Number.isFinite(asNumber) ? asNumber : Number(spec.default);
    } else if (spec.type === 'boolean') {
      out[spec.key] = typeof value === 'boolean' ? value : Boolean(spec.default);
    } else {
      const asText = typeof value === 'string' ? value : String(spec.default);
      out[spec.key] = spec.type === 'choice' && !spec.choices?.includes(asText)
        ? String(spec.default)
        : asText;
    }
  }
  return out;
}

/**
 * Turn a recipe and a set of values into the bake configuration.
 *
 * The camera is the part a person should never have to think about: the span of
 * the object comes from the params the recipe marked as sizes, and everything
 * else — how far back to stand, how much to fit in frame — follows from it.
 */
export function bakeConfigFor(
  recipe: Recipe,
  params: Record<string, number | string | boolean>,
  identity: { label: string; tags: string[] },
): Record<string, unknown> {
  const sizes = recipe.fit
    .map((key) => params[key])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const span = Math.max(0.5, ...sizes);

  const views: Record<string, unknown> = {};
  for (const [name, view] of Object.entries(recipe.views)) {
    const distance = span * 2.6;
    const length = Math.hypot(...view.dir) || 1;
    views[name] = {
      type: 'ortho',
      ortho_scale: Number((span * 2.1).toFixed(3)),
      location: view.dir.map((c) => Number(((c / length) * distance).toFixed(3))),
      target: [0, 0, Number((span * view.aim).toFixed(3))],
    };
  }

  return {
    label: identity.label,
    tags: identity.tags,
    spanning: false,
    resolution: [768, 768],
    coplanar_angle: 1.5,
    params,
    views,
  };
}
