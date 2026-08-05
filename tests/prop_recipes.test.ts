import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { listRecipes, getRecipe, resolveParams, bakeConfigFor } from '../src/render/recipes/index.ts';
import { PALETTE_SLOTS } from '../src/sets/props/index.ts';

/**
 * The recipes that let somebody bake without writing Python.
 *
 * Nothing here runs Blender — that is what `tests/python/prop_bake_test.py`
 * and an actual bake are for. What these pin is the part that decides whether
 * the form in front of a person can produce a working bake at all: that every
 * recipe declares controls the studio can render, names materials the palette
 * actually has, and frames its own camera from the sizes it was given.
 */

const RECIPES = listRecipes();

describe('the shipped recipes', () => {
  it('offers a useful set of shapes', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(5);
    expect(RECIPES.map((r) => r.name)).toContain('box');
    expect(RECIPES.map((r) => r.name)).toContain('cylinder');
  });

  it.each(RECIPES.map((r) => [r.name, r] as const))('%s declares a form the studio can render', (_name, recipe) => {
    expect(recipe.label).toBeTruthy();
    expect(recipe.blurb).toBeTruthy();
    expect(recipe.params.length).toBeGreaterThan(0);
    for (const spec of recipe.params) {
      // The same contract the catalogue holds a prop to: an undefined default
      // renders as an empty input somebody has to guess at.
      expect(spec.default, `${recipe.name}.${spec.key}`).toBeDefined();
      if (spec.type === 'number') {
        expect(spec.min, `${recipe.name}.${spec.key}`).toBeTypeOf('number');
        expect(spec.max, `${recipe.name}.${spec.key}`).toBeTypeOf('number');
      }
      if (spec.type === 'choice') expect(spec.choices?.length).toBeGreaterThan(0);
    }
  });

  it.each(RECIPES.map((r) => [r.name, r] as const))('%s only offers materials the palette has', (_name, recipe) => {
    // A recipe naming a slot that does not exist bakes a prop the loader
    // rejects, which is a confusing way to find out about a typo.
    for (const spec of recipe.params) {
      if (spec.type !== 'choice') continue;
      for (const choice of spec.choices ?? []) {
        expect(PALETTE_SLOTS, `${recipe.name}.${spec.key}`).toContain(choice);
      }
    }
  });

  it.each(RECIPES.map((r) => [r.name, r] as const))('%s has a build.py that defines build()', (_name, recipe) => {
    const source = fs.readFileSync(recipe.build, 'utf8');
    expect(source).toMatch(/^def build\(params\)/m);
  });

  it.each(RECIPES.map((r) => [r.name, r] as const))('%s sizes its camera from real params', (_name, recipe) => {
    expect(recipe.fit.length).toBeGreaterThan(0);
    const keys = recipe.params.map((p) => p.key);
    for (const key of recipe.fit) expect(keys, recipe.name).toContain(key);
    expect(Object.keys(recipe.views).length).toBeGreaterThan(0);
  });
});

describe('filling in the form', () => {
  const box = getRecipe('box')!;

  it('falls back to the declared default for anything not supplied', () => {
    const resolved = resolveParams(box, {});
    expect(resolved['width']).toBe(0.9);
    expect(resolved['slot']).toBe('wood');
  });

  it('takes what was supplied', () => {
    expect(resolveParams(box, { width: 2.5 })['width']).toBe(2.5);
  });

  it('refuses a choice that is not one of the choices', () => {
    // Structured input from a form should make this impossible; if it happens,
    // a default material is better than a bake the loader will not read.
    expect(resolveParams(box, { slot: 'chartreuse' })['slot']).toBe('wood');
  });

  it('ignores a number that is not one', () => {
    expect(resolveParams(box, { width: 'wide' })['width']).toBe(0.9);
  });
});

describe('framing the camera', () => {
  const box = getRecipe('box')!;

  it('stands further back for a bigger object', () => {
    const small = bakeConfigFor(box, resolveParams(box, { width: 0.5, depth: 0.5, height: 0.5 }), { label: 'S', tags: [] });
    const large = bakeConfigFor(box, resolveParams(box, { width: 3, depth: 3, height: 3 }), { label: 'L', tags: [] });
    const scaleOf = (config: Record<string, unknown>) =>
      (config['views'] as Record<string, { ortho_scale: number }>)['three-quarter']!.ortho_scale;
    expect(scaleOf(large)).toBeGreaterThan(scaleOf(small));
  });

  it('produces a config the bake worker can read', () => {
    const config = bakeConfigFor(box, resolveParams(box, {}), { label: 'Crate', tags: ['generic'] });
    expect(config['label']).toBe('Crate');
    expect(config['tags']).toEqual(['generic']);
    expect(config['resolution']).toEqual([768, 768]);
    const views = config['views'] as Record<string, { type: string; location: number[]; target: number[] }>;
    for (const view of Object.values(views)) {
      expect(view.type).toBe('ortho');
      expect(view.location).toHaveLength(3);
      expect(view.target).toHaveLength(3);
      for (const n of [...view.location, ...view.target]) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it('never puts the camera at the origin, however small the object', () => {
    const config = bakeConfigFor(box, resolveParams(box, { width: 0.01, depth: 0.01, height: 0.01 }), { label: 'X', tags: [] });
    const views = config['views'] as Record<string, { location: number[]; ortho_scale: number }>;
    for (const view of Object.values(views)) {
      expect(Math.hypot(...view.location)).toBeGreaterThan(0.5);
      expect(view.ortho_scale).toBeGreaterThan(0);
    }
  });
});
