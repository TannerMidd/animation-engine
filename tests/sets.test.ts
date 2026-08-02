import { describe, it, expect } from 'vitest';
import { renderSet, validateSet, SetDescriptor } from '../src/sets/index.ts';
import { BUILTIN_SETS, BUILTIN_SET_NAMES } from '../src/sets/builtins.ts';
import { PROPS, PROP_KEYS, propManifest, getProp } from '../src/sets/props/index.ts';
import { PALETTES, PALETTE_NAMES, getPalette } from '../src/sets/palettes.ts';
import { geometryFor } from '../src/sets/schema.ts';

describe('builtin sets', () => {
  it.each(BUILTIN_SET_NAMES)('%s validates against the prop registry', (name) => {
    expect(validateSet(BUILTIN_SETS[name]!)).toEqual([]);
  });

  it.each(BUILTIN_SET_NAMES)('%s renders to non-empty SVG', (name) => {
    const out = renderSet(BUILTIN_SETS[name]!);
    expect(out.back.length).toBeGreaterThan(100);
  });

  it.each(BUILTIN_SET_NAMES)('%s round-trips through the schema', (name) => {
    const desc = BUILTIN_SETS[name]!;
    expect(SetDescriptor.parse(JSON.parse(JSON.stringify(desc)))).toEqual(desc);
  });

  it('separates foreground props from background ones', () => {
    // The whole point of the layer split: a character stands between them.
    const out = renderSet(BUILTIN_SETS['dive-bar']!);
    expect(out.fore.length).toBeGreaterThan(0);
    expect(out.fore).not.toBe(out.back);
  });

  it('emits nothing for an empty fore layer rather than stray markup', () => {
    expect(renderSet(BUILTIN_SETS['office']!).fore.trim()).toBe('');
  });
});

describe('prop registry', () => {
  const geo = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });

  it('renders every prop in every palette without throwing', () => {
    // Props read colours from the palette rather than hardcoding them, so a
    // missing slot would only ever surface on the one set that used it.
    for (const key of PROP_KEYS) {
      for (const paletteName of PALETTE_NAMES) {
        const svg = getProp(key).render({
          palette: PALETTES[paletteName]!,
          geo,
          params: {},
          x: 640,
          y: 566,
        });
        expect(svg.length, `${key} / ${paletteName}`).toBeGreaterThan(0);
        expect(svg, `${key} / ${paletteName}`).not.toContain('undefined');
        expect(svg, `${key} / ${paletteName}`).not.toContain('NaN');
      }
    }
  });

  it('survives extreme param values', () => {
    for (const key of PROP_KEYS) {
      const def = getProp(key);
      for (const spec of def.params) {
        if (spec.type !== 'number') continue;
        for (const v of [spec.min ?? 1, spec.max ?? 1000]) {
          const svg = def.render({
            palette: PALETTES['office-fluorescent']!,
            geo,
            params: { [spec.key]: v },
            x: 640,
            y: 566,
          });
          expect(svg, `${key}.${spec.key}=${v}`).not.toContain('NaN');
        }
      }
    }
  });

  it('declares a default for every param', () => {
    // The designer UI builds controls from these, and an undefined default
    // renders as an empty input the user has to guess at.
    for (const p of propManifest()) {
      for (const spec of p.params) {
        expect(spec.default, `${p.key}.${spec.key}`).toBeDefined();
      }
    }
  });

  it('gives every prop at least one tag, for palette filtering', () => {
    for (const [key, def] of Object.entries(PROPS)) {
      expect(def.tags.length, key).toBeGreaterThan(0);
    }
  });

  it('escapes user text so a param cannot inject markup', () => {
    const svg = getProp('neon-sign').render({
      palette: PALETTES['bar-night']!,
      geo,
      params: { text: '<script>x</script>' },
      x: 640,
      y: 566,
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('names the offending key on an unknown prop', () => {
    expect(() => getProp('teleporter')).toThrow(/teleporter/);
  });
});

describe('validateSet', () => {
  const base = (): SetDescriptor => JSON.parse(JSON.stringify(BUILTIN_SETS['office']));

  it('rejects an unknown prop', () => {
    const d = base();
    d.layers.mid.push({ prop: 'hovercar', scale: 1, flip: false, params: {} });
    expect(validateSet(d).join('\n')).toMatch(/hovercar/);
  });

  it('rejects an unknown palette', () => {
    const d = base();
    d.palette = 'chartreuse-nightmare';
    expect(validateSet(d).join('\n')).toMatch(/chartreuse-nightmare/);
  });

  it('rejects a param the prop does not accept, listing what it does', () => {
    const d = base();
    d.layers.mid.push({ prop: 'desk', scale: 1, flip: false, params: { thiccness: 4 } });
    const msg = validateSet(d).join('\n');
    expect(msg).toMatch(/thiccness/);
    expect(msg).toMatch(/width/);
  });
});

describe('palettes', () => {
  it('defines the same slots in every palette', () => {
    // A prop reading `palette.glass` must work everywhere, not just where it
    // was first used.
    const slots = Object.keys(PALETTES['office-fluorescent']!).sort();
    for (const name of PALETTE_NAMES) {
      expect(Object.keys(PALETTES[name]!).sort(), name).toEqual(slots);
    }
  });

  it('names the options on an unknown palette', () => {
    expect(() => getPalette('neon-swamp')).toThrow(/office-fluorescent/);
  });
});
