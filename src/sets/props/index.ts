import type { PropDef } from './types.ts';
import { STRUCTURE_PROPS } from './structure.ts';
import { INTERIOR_PROPS } from './interior.ts';
import { EXTERIOR_PROPS, GENERIC_PROPS } from './exterior.ts';

/**
 * The prop registry.
 *
 * This is the entire vocabulary of things a set can contain. The designer UI
 * builds its palette from it, and a model generating a set descriptor is given
 * these keys — so, like the director's capability manifest, nothing can ask for
 * something that does not exist.
 */
export const PROPS: Record<string, PropDef> = {
  ...STRUCTURE_PROPS,
  ...INTERIOR_PROPS,
  ...EXTERIOR_PROPS,
  ...GENERIC_PROPS,
};

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
    };
  });
}

export * from './types.ts';
