import { describe, it, expect } from 'vitest';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import { validateRig } from '../src/cast/store.ts';
import { namespaceSvg } from '../src/render/page.ts';
import { MOUTH_SHAPES } from '../src/schema/index.ts';

describe('placeholder rigs', () => {
  it('generate cleanly and satisfy their own manifest', () => {
    for (const name of ['steve', 'dolores', 'carl', 'x']) {
      const rig = buildPlaceholderRig(name);
      const svg = buildPlaceholderSvg(name);
      expect(validateRig({ rig, svg }), `rig "${name}"`).toEqual([]);
    }
  });

  it('supply every Rhubarb mouth shape', () => {
    // Rhubarb can emit any of these, so a gap here becomes a missing mouth at
    // render time rather than an error at build time.
    const svg = buildPlaceholderSvg('steve');
    for (const shape of MOUTH_SHAPES) {
      expect(svg, `mouth shape ${shape}`).toContain(`id="mouth_${shape}"`);
    }
  });

  it('look the same every time for a given name', () => {
    expect(buildPlaceholderSvg('steve')).toBe(buildPlaceholderSvg('steve'));
  });

  it('look different for different names', () => {
    expect(buildPlaceholderSvg('steve')).not.toBe(buildPlaceholderSvg('dolores'));
  });

  it('place every joint pivot inside the canvas', () => {
    const rig = buildPlaceholderRig('steve');
    for (const part of rig.parts) {
      expect(part.pivot[0], `${part.id} x`).toBeGreaterThanOrEqual(0);
      expect(part.pivot[0], `${part.id} x`).toBeLessThanOrEqual(rig.canvas.width);
      expect(part.pivot[1], `${part.id} y`).toBeGreaterThanOrEqual(0);
      expect(part.pivot[1], `${part.id} y`).toBeLessThanOrEqual(rig.canvas.height);
    }
  });
});

describe('validateRig', () => {
  const base = () => ({ rig: buildPlaceholderRig('steve'), svg: buildPlaceholderSvg('steve') });

  it('reports a part with no matching SVG element', () => {
    const { rig, svg } = base();
    rig.parts.push({ id: 'tail', parent: 'torso', pivot: [100, 200], z: 0 });
    expect(validateRig({ rig, svg }).join('\n')).toMatch(/missing id="tail"/);
  });

  it('reports a parent that is not a declared part', () => {
    const { rig, svg } = base();
    rig.parts.push({ id: 'head', parent: 'ghost', pivot: [100, 200], z: 0 });
    expect(validateRig({ rig, svg }).join('\n')).toMatch(/parent "ghost"/);
  });

  it('catches a parent cycle rather than hanging on it', () => {
    const { rig, svg } = base();
    rig.parts.find((p) => p.id === 'torso')!.parent = 'head';
    expect(validateRig({ rig, svg }).join('\n')).toMatch(/cycle/);
  });

  it('reports an expression pointing at a variant that does not exist', () => {
    const { rig, svg } = base();
    rig.expressions[0]!.swaps['eyes'] = 'eyes_lasers';
    expect(validateRig({ rig, svg }).join('\n')).toMatch(/eyes_lasers/);
  });

  it('reports a swap default that is not one of its own variants', () => {
    const { rig, svg } = base();
    rig.swapSets[0]!.default = 'mouth_ZZ';
    expect(validateRig({ rig, svg }).join('\n')).toMatch(/default "mouth_ZZ"/);
  });
});

describe('namespaceSvg', () => {
  it('prefixes ids so one rig can be staged twice', () => {
    const out = namespaceSvg(buildPlaceholderSvg('steve'), 'goon2');
    expect(out).toContain('id="goon2__head"');
    expect(out).not.toMatch(/\bid="head"/);
  });

  it('rewrites internal references alongside the ids they point at', () => {
    // Hand-drawn art routinely carries gradients, clip paths and <use>. If the
    // references are not rewritten with the ids, two actors sharing a rig both
    // resolve to whichever one was inlined first.
    const svg = `<svg><defs><linearGradient id="g1"/><clipPath id="c1"/></defs>` +
      `<g id="body" clip-path="url(#c1)" fill="url(#g1)"/><use href="#body"/></svg>`;
    const out = namespaceSvg(svg, 'a');
    expect(out).toContain('url(#a__c1)');
    expect(out).toContain('url(#a__g1)');
    expect(out).toContain('href="#a__body"');
    expect(out).not.toContain('url(#c1)');
  });
});
