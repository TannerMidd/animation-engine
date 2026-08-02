import type { SceneIR, Rig } from '../schema/index.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { RenderedSet } from '../sets/index.ts';
import { activeStyle } from '../style/index.ts';
import { grainOverlay } from '../style/wobble.ts';

/**
 * Rewrite every id in an SVG fragment to be unique to one actor.
 *
 * Without this, staging the same rig twice (two identical goons, a character
 * and their reflection) puts duplicate ids in the document. Scoped
 * querySelector would still resolve correctly, but the document would be
 * invalid and devtools would be miserable to work in. Internal references —
 * gradients, clip paths, masks, <use> — are rewritten alongside, which matters
 * much more for hand-drawn Inkscape art than it does for placeholders.
 */
export function namespaceSvg(svg: string, prefix: string): string {
  const ids = new Set(Array.from(svg.matchAll(/\bid="([^"]+)"/g), (m) => m[1]!));
  let out = svg;

  for (const id of ids) {
    const q = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\bid="${q}"`, 'g'), `id="${prefix}__${id}"`)
      .replace(new RegExp(`url\\(#${q}\\)`, 'g'), `url(#${prefix}__${id})`)
      .replace(new RegExp(`\\b(xlink:href|href)="#${q}"`, 'g'), `$1="#${prefix}__${id}"`);
  }
  return out;
}

/** Strip the outer <svg> wrapper, keeping only its children. */
function svgInner(svg: string): string {
  const open = svg.search(/<svg\b/i);
  if (open === -1) throw new Error('not an SVG: no <svg> element found');
  const contentStart = svg.indexOf('>', open) + 1;
  const close = svg.lastIndexOf('</svg>');
  if (close === -1) throw new Error('malformed SVG: no closing </svg>');
  return svg.slice(contentStart, close);
}

export interface PageOptions {
  ir: SceneIR;
  rigs: Map<string, LoadedRig>;
  runtime: string;
  /** Rendered set fragments. Resolved by the caller from the scene's descriptor. */
  set?: RenderedSet | null;
  /** Fallback flat colour when the scene has no set. */
  background?: string;
}

/**
 * Rig data the browser runtime needs. Deliberately a narrow subset — the
 * runtime only cares about structure (parts, pivots, swap slots), never about
 * poses or expressions, which the compiler has already resolved into IR.
 */
function runtimeRig(rig: Rig) {
  return {
    anchor: rig.anchor,
    parts: rig.parts.map((p) => ({ id: p.id, pivot: p.pivot })),
    swapSets: rig.swapSets.map((s) => ({ slot: s.slot, variants: s.variants })),
  };
}

export async function buildPage(opts: PageOptions): Promise<string> {
  const { ir, rigs, runtime } = opts;

  // Set art is split around the actors: back and mid behind them, fore in
  // front. That is the whole reason a character can stand behind a bar rather
  // than on top of it.
  const setBack = opts.set ? `<g id="set-back">${opts.set.back}</g>` : '';
  const setFore = opts.set ? `<g id="set-fore">${opts.set.fore}</g>` : '';

  const actorMarkup = ir.cast
    .map((member) => {
      const loaded = rigs.get(member.rig);
      if (!loaded) throw new Error(`buildPage: no rig loaded for "${member.rig}"`);
      const inner = svgInner(namespaceSvg(loaded.svg, member.id));
      return `<g id="actor-${member.id}">${inner}</g>`;
    })
    .join('\n    ');

  // Runtime rig data is keyed by rig name, but ids in the DOM are prefixed by
  // actor id, so the runtime resolves parts through its actor's prefix.
  const rigData: Record<string, ReturnType<typeof runtimeRig>> = {};
  for (const [name, loaded] of rigs) rigData[name] = runtimeRig(loaded.rig);

  const bg = opts.background ?? '#1a1a1a';

  // Grain sits in its own overlay rather than inside the stage SVG, so it is
  // locked to the frame. Put it in the stage and it would ride the camera's
  // viewBox — sliding across the picture on every pan, which reads as a
  // texture painted onto the world rather than onto the print.
  const style = activeStyle();
  const grain = style.grain > 0
    ? `<svg class="grain" width="${ir.meta.width}" height="${ir.meta.height}" xmlns="http://www.w3.org/2000/svg">` +
      `${grainOverlay(style, 'paper-grain', 0, 0, ir.meta.width, ir.meta.height)}</svg>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Determinism: nothing in the page may animate on its own or depend on a clock. */
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: ${bg};
    width: ${ir.meta.width}px;
    height: ${ir.meta.height}px;
    overflow: hidden;
  }
  #stage {
    display: block;
    width: ${ir.meta.width}px;
    height: ${ir.meta.height}px;
    shape-rendering: geometricPrecision;
  }
  .grain {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
</style>
</head>
<body>
<svg id="stage" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    ${setBack}
    ${actorMarkup}
    ${setFore}
</svg>
${grain}
<script>
window.__IR = ${JSON.stringify(ir)};
window.__RIGS = ${JSON.stringify(rigData)};
</script>
<script>
${runtime}
</script>
</body>
</html>
`;
}
