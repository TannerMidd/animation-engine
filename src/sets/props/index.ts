import type { PropDef } from './types.ts';
import { STRUCTURE_PROPS } from './structure.ts';
import { INTERIOR_PROPS } from './interior.ts';
import { EXTERIOR_PROPS, GENERIC_PROPS } from './exterior.ts';
import { loadBakedProps, type BakedPropError, type LoadedBakedProps } from './baked.ts';

/**
 * The prop registry.
 *
 * This is the entire vocabulary of things a set can contain. The designer UI
 * builds its palette from it, and a model generating a set descriptor is given
 * these keys — so, like the director's capability manifest, nothing can ask for
 * something that does not exist.
 *
 * It is read through functions rather than exported as a constant because props
 * are now authored while the server is running. A constant would mean a prop
 * someone just drew stayed invisible until they restarted, which is the kind of
 * thing that teaches people the tool is lying to them.
 */

/**
 * Merge the sources, refusing to let one shadow another.
 *
 * A plain spread would silently drop the earlier definition, which was tolerable
 * while every prop was written here and a duplicate key was a typo caught in
 * review. Documents arrive from a directory on disk, so a collision is now
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

let disk: LoadedBakedProps = loadBakedProps();
let registry: Record<string, PropDef> = assemble();
let keys: string[] = Object.keys(registry).sort();

function assemble(): Record<string, PropDef> {
  return mergeProps([
    ['structure', STRUCTURE_PROPS],
    ['interior', INTERIOR_PROPS],
    ['exterior', EXTERIOR_PROPS],
    ['generic', GENERIC_PROPS],
    ['props/ (on disk)', disk.props],
  ]);
}

/**
 * Re-read the props directory.
 *
 * Called after a document is written or deleted. A collision rolls the whole
 * thing back rather than leaving the process with a half-built registry: the
 * write that caused it should fail loudly while every set that was renderable a
 * moment ago still is.
 */
export function reloadProps(dir?: string): void {
  const previous = disk;
  disk = loadBakedProps(dir);
  try {
    registry = assemble();
  } catch (err) {
    disk = previous;
    registry = assemble();
    keys = Object.keys(registry).sort();
    throw err;
  }
  keys = Object.keys(registry).sort();
}

/** Every prop, by key. The returned object is the live registry — do not mutate it. */
export function allProps(): Record<string, PropDef> {
  return registry;
}

/** Every key, sorted. Handed to a model as an enum, so it must stay stable within a call. */
export function propKeys(): string[] {
  return keys;
}

export function getProp(key: string): PropDef {
  const def = registry[key];
  if (!def) {
    throw new Error(`unknown prop "${key}". Known props: ${keys.join(', ')}`);
  }
  return def;
}

/** Every tag in use, for filtering the designer palette. */
export function propTags(): string[] {
  const tags = new Set<string>();
  for (const def of Object.values(registry)) for (const t of def.tags) tags.add(t);
  return [...tags].sort();
}

/** Registry summary for the UI and for prompting a model. */
export function propManifest() {
  return keys.map((key) => {
    const def = registry[key]!;
    return {
      key,
      label: def.label,
      tags: def.tags,
      spanning: def.spanning ?? false,
      params: def.params,
      interaction: def.interaction ?? null,
      /** Only documents on disk can be edited; coded props are read-only built-ins. */
      source: key in disk.props ? ('document' as const) : ('builtin' as const),
    };
  });
}

/** Documents that failed to load, for `doctor`. Never throws them — see `loadBakedProps`. */
export function bakedErrors(): BakedPropError[] {
  return disk.errors;
}

/** Geometry totals, so a bloated document is visible without opening files. */
export function bakedTotals(): { shapes: number; points: number } {
  return { shapes: disk.shapes, points: disk.points };
}

export * from './types.ts';
export { loadBakedProps, BAKE_BUDGET, PALETTE_SLOTS, DOC_FORMAT, countView } from './baked.ts';
export { PropDocument, propFromDocument, documentBoxes, type PrimitiveBox, type Primitive } from './document.ts';
