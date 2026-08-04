import fs from 'node:fs';
import path from 'node:path';
import { PROPS_DIR } from '../../core/paths.ts';
import { PropDocument, propFromDocument, countView } from './document.ts';
import type { PropDef } from './types.ts';

/**
 * Props defined by a file on disk rather than by code.
 *
 * This is the loader; the format and its renderer live in `document.ts`. The
 * split matters because these files now arrive from three directions — the
 * foundry projects Blender geometry into one, the studio writes one from a
 * drawing, a model emits one from a description — and all three land in the
 * same place and become the same thing.
 *
 * The important consequence is what does not happen: nothing external runs at
 * render time. Geometry is committed, so a render needs no Blender, no Python
 * and no network, and the determinism guarantee is untouched.
 */

export { PALETTE_SLOTS, BAKE_BUDGET, DOC_FORMAT, countView } from './document.ts';

/**
 * The foundry's names for the document type.
 *
 * Kept as aliases rather than renamed through the bake pipeline: from the
 * foundry's point of view this really is "the baked prop manifest", and a
 * document that happens to have been drawn instead is none of its business.
 */
export const BakedProp = PropDocument;
export type BakedProp = PropDocument;
export const bakedProp = propFromDocument;

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
 * Read every prop document under `props/`.
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
      const parsed = PropDocument.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.key !== entry) {
        out.errors.push({ file: rel, error: `key "${parsed.key}" does not match its directory "${entry}"` });
        continue;
      }
      for (const view of Object.values(parsed.views)) {
        const counted = countView(view);
        out.shapes += counted.shapes;
        out.points += counted.points;
      }
      // Compiling here rather than at first render means a document whose
      // expressions do not resolve is reported as a broken file, beside the
      // ones that failed to parse, instead of throwing mid-frame.
      out.props[parsed.key] = propFromDocument(parsed);
    } catch (err) {
      out.errors.push({ file: rel, error: (err as Error).message });
    }
  }

  return out;
}
