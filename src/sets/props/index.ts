import type { PropDef } from './types.ts';
import { STRUCTURE_PROPS } from './structure.ts';
import { INTERIOR_PROPS } from './interior.ts';
import { EXTERIOR_PROPS, GENERIC_PROPS } from './exterior.ts';
import { BAKED_PROPS } from './baked.ts';

/**
 * The prop registry.
 *
 * This is the entire vocabulary of things a set can contain. The designer UI
 * builds its palette from it, and a model generating a set descriptor is given
 * these keys — so, like the director's capability manifest, nothing can ask for
 * something that does not exist.
 */

/**
 * Merge the sources, refusing to let one shadow another.
 *
 * A plain spread would silently drop the earlier definition, which was tolerable
 * while every prop was written here and a duplicate key was a typo caught in
 * review. Baked props arrive from a directory on disk, so a collision is now
 * something a person can cause by naming a file — and the failure it produces
 * (a set quietly rendering a different prop than the one it names) is very hard
 * to work backwards from.
 */
export function mergeProps(sources: Array<[string, Record<string, PropDef>]>): Record<string, PropDef> {
  const merged: Record<string, PropDef> = {};
  const origin = new Map<string, string>();

  for (const [name, source] of sources) {
    for (const [key, def] of Object.entries(source)) {
      const first = origin.get(key);
      if (first) {
        throw new Error(
          `duplicate prop key "${key}": defined in ${first} and again in ${name}. ` +
          'Rename one of them — a set naming this key cannot say which it means.',
        );
      }
      origin.set(key, name);
      merged[key] = def;
    }
  }
  return merged;
}

export const PROPS: Record<string, PropDef> = mergeProps([
  ['structure', STRUCTURE_PROPS],
  ['interior', INTERIOR_PROPS],
  ['exterior', EXTERIOR_PROPS],
  ['generic', GENERIC_PROPS],
  ['props/ (baked)', BAKED_PROPS],
]);

export const PROP_KEYS = Object.keys(PROPS).sort();

export function getProp(key: string): PropDef {
  const def = PROPS[key];
  if (!def) {
    throw new Error(`unknown prop "${key}". Known props: ${PROP_KEYS.join(', ')}`);
  }
  return def;
}

/** Every tag in use, for filtering the designer palette. */
export function propTags(): string[] {
  const tags = new Set<string>();
  for (const def of Object.values(PROPS)) for (const t of def.tags) tags.add(t);
  return [...tags].sort();
}

/** Registry summary for the UI and for prompting a model. */
export function propManifest() {
  return PROP_KEYS.map((key) => {
    const def = PROPS[key]!;
    return {
      key,
      label: def.label,
      tags: def.tags,
      spanning: def.spanning ?? false,
      params: def.params,
      interaction: def.interaction ?? null,
    };
  });
}

export * from './types.ts';
export { BAKED_PROPS, BAKED_ERRORS, BAKED_TOTALS, BAKE_BUDGET, PALETTE_SLOTS } from './baked.ts';
