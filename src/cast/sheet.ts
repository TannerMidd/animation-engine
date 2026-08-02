import type { LoadedRig } from './store.ts';
import { faceBox } from './placeholder.ts';

/**
 * Contact sheets.
 *
 * An expression is impossible to judge one at a time — the question is never
 * "is this angry", it is "is this angry clearly *not* the other nine". Seeing
 * the whole set at once is the only way that question gets answered, so the
 * editor shows them side by side and the CLI can dump the same thing to a PNG.
 */

export interface Plate {
  label: string;
  svg: string;
}

/**
 * Show one variant per swap slot and hide the rest.
 *
 * The renderer does this at runtime by toggling display; here it is baked into
 * the markup so each plate is a standalone SVG that needs no script to look
 * right. Ids are the rig contract, so this works on hand-drawn puppets too.
 */
function applySwaps(svg: string, loaded: LoadedRig, want: Record<string, string>): string {
  let out = svg;
  for (const set of loaded.rig.swapSets) {
    const shown = want[set.slot] ?? set.default;
    for (const variant of set.variants) {
      if (variant === shown) continue;
      out = out.replace(`<g id="${variant}">`, `<g id="${variant}" style="display:none">`);
    }
  }
  return out;
}

/** Re-frame a puppet SVG onto a new viewBox, dropping the fixed pixel size. */
function reframe(svg: string, box: { x: number; y: number; w: number; h: number }): string {
  return svg.replace(
    /<svg\b([^>]*)>/,
    (_m, attrs: string) => {
      const cleaned = attrs
        .replace(/\s(viewBox|width|height)="[^"]*"/g, '')
        .trim();
      return `<svg ${cleaned} viewBox="${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}" preserveAspectRatio="xMidYMid meet">`;
    },
  );
}

/**
 * A whole puppet showing one expression.
 *
 * Without the swaps applied, every variant of every slot draws at once — nine
 * mouths, six pairs of eyes and eight sets of brows stacked on one face. The
 * renderer hides them at runtime, so a static dump has to do it itself.
 */
export function bodyPlate(loaded: LoadedRig, expression?: string): Plate {
  const expr = expression ? loaded.rig.expressions.find((e) => e.name === expression) : undefined;
  return {
    label: loaded.rig.name,
    svg: applySwaps(loaded.svg, loaded, expr?.swaps ?? {}),
  };
}

/** One face plate per expression, cropped to the head. */
export function facePlates(loaded: LoadedRig): Plate[] {
  const box = faceBox(loaded.rig);
  return loaded.rig.expressions.map((e) => ({
    label: e.name,
    svg: reframe(applySwaps(loaded.svg, loaded, e.swaps), box),
  }));
}

/** One plate per pose, full body. Poses are body-only, so the face stays neutral. */
export function posePlates(loaded: LoadedRig): Plate[] {
  // Poses are part transforms rather than swaps, and applying them properly
  // means running the compiler — which the live preview already does. These
  // plates exist to *list* what a rig can do, so they show the rest pose and
  // leave the driving to the preview.
  return loaded.rig.poses.map((p) => ({ label: p.name, svg: loaded.svg }));
}

/** A grid of plates as a standalone page, for dumping to a PNG. */
export function sheetHtml(plates: Plate[], opts: { columns?: number; paper?: string } = {}): string {
  const columns = opts.columns ?? Math.min(plates.length, 8);
  const paper = opts.paper ?? '#e9e3d6';

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #2b2f36; font-family: ui-monospace, SFMono-Regular, monospace; }
  .grid { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 6px; padding: 10px; }
  .cell { background: ${paper}; border-radius: 5px; padding: 6px; text-align: center; }
  .cell svg { width: 100%; height: auto; display: block; }
  .label { font-size: 11px; color: #2b2f36; padding-top: 4px; letter-spacing: 0.04em; }
</style></head><body>
<div class="grid">
${plates.map((p) => `  <div class="cell">${p.svg}<div class="label">${p.label}</div></div>`).join('\n')}
</div>
</body></html>
`;
}
