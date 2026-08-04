import path from 'node:path';
import { OUT_DIR } from '../core/paths.ts';
import { listRigs, loadRig, validateRig } from '../cast/store.ts';
import { facePlates, bodyPlate, sheetHtml, type Plate } from '../cast/sheet.ts';

/**
 * Cast-wide inspection tools: rig validation and contact sheets.
 *
 * Both answer questions about the cast as a group — "did the generator break
 * anyone" and "do these people look like different people" — so they live
 * together, shared by `anim cast check` / `anim cast sheet` and the cast
 * editor's tool rail.
 */

export interface RigCheckResult {
  name: string;
  ok: boolean;
  errors: string[];
}

export async function checkRigs(names?: string[]): Promise<{ ok: boolean; results: RigCheckResult[] }> {
  const resolved = names?.length ? names : await listRigs();
  const results: RigCheckResult[] = [];
  for (const name of resolved) {
    try {
      const loaded = await loadRig(name);
      const errors = validateRig(loaded);
      results.push({ name, ok: !errors.length, errors });
    } catch (err) {
      results.push({ name, ok: false, errors: [(err as Error).message] });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export interface SheetOptions {
  /** One name renders every expression that character has; several render the cast side by side. */
  names?: string[];
  /** Cast-wide sheets only: the expression every body plate wears. */
  expression?: string;
}

export interface SheetResult {
  /** PNG under out/, named sheet-<label>.png. */
  file: string;
  label: string;
  plates: number;
}

/**
 * A contact sheet as a PNG.
 *
 * With a name, every expression that character has; without one, the whole cast
 * side by side. Both answer the question you actually have when you change the
 * puppet generator, which is never "does this one look right" but "does this one
 * look like a different person from that one".
 */
export async function renderCastSheet(opts: SheetOptions = {}): Promise<SheetResult> {
  const names = opts.names?.length ? opts.names : await listRigs();
  if (!names.length) throw new Error('no characters — run: anim cast new steve');

  let plates: Plate[];
  let label: string;

  if (names.length === 1) {
    const loaded = await loadRig(names[0]!);
    plates = facePlates(loaded);
    label = `faces-${names[0]}`;
  } else {
    plates = [];
    for (const n of names) {
      plates.push(bodyPlate(await loadRig(n), opts.expression));
    }
    label = 'cast';
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1760, height: 900 } });
    await page.setContent(sheetHtml(plates, { columns: Math.min(plates.length, 8) }));
    const grid = await page.$('.grid');
    const out = path.join(OUT_DIR, `sheet-${label}.png`);
    await grid!.screenshot({ path: out });
    return { file: out, label, plates: plates.length };
  } finally {
    await browser.close();
  }
}
