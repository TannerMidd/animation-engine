import { describe, it, expect } from 'vitest';
import { renderSet, validateSet, lintSet, SetDescriptor } from '../src/sets/index.ts';
import { BUILTIN_SETS, BUILTIN_SET_NAMES } from '../src/sets/builtins.ts';
import { allProps, propKeys, propManifest, getProp } from '../src/sets/props/index.ts';
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

  it('keeps back and mid as separate fragments in the original draw order', () => {
    // They were one string until the two planes could parallax independently.
    // Order is the part that must not have changed: back, then mid, then actors.
    const out = renderSet(BUILTIN_SETS['dive-bar']!);
    expect(out.mid.length).toBeGreaterThan(0);
    expect(out.back).not.toContain(out.mid);
    const combined = [out.back, out.mid].filter(Boolean).join('\n');
    expect(combined.indexOf(out.back)).toBe(0);
    expect(combined.endsWith(out.mid)).toBe(true);
  });

  it.each(BUILTIN_SET_NAMES)('%s defaults to tracking the camera exactly', (name) => {
    // Parallax is opt-in per set. A default of anything but 1 would silently
    // re-render every scene ever made.
    const { parallax } = renderSet(BUILTIN_SETS[name]!);
    expect(parallax).toEqual({
      back: { x: 1, y: 1 },
      mid: { x: 1, y: 1 },
      fore: { x: 1, y: 1 },
    });
  });

  it('fills in neutral parallax for a set that predates it', () => {
    const legacy = SetDescriptor.parse({ name: 'no-depth', layers: { mid: [{ prop: 'mug' }] } });
    expect(legacy.layout.parallax.back).toEqual({ x: 1, y: 1 });
    expect(legacy.layout.parallax.fore).toEqual({ x: 1, y: 1 });
  });

  it('rejects a parallax factor that looks like a slipped decimal point', () => {
    const bad = { name: 'oops', layout: { parallax: { back: { x: 85 } } }, layers: {} };
    expect(() => SetDescriptor.parse(bad)).toThrow();
  });

  it('wraps only the instances that opt out of their layer parallax', () => {
    const desc = SetDescriptor.parse({
      name: 'pinned-floor',
      layout: { parallax: { back: { x: 0.85, y: 1 } } },
      layers: {
        back: [
          { prop: 'room-wall' },
          { prop: 'room-floor', parallax: { x: 1, y: 1 } },
        ],
      },
    });
    const out = renderSet(desc);
    expect(out.back).toContain('data-px="1" data-py="1"');
    // One wrapper, for the floor only — the wall rides its layer.
    expect(out.back.match(/data-px=/g)).toHaveLength(1);
  });

  it('warns when the ground is left in a parallaxed layer', () => {
    const drifting = SetDescriptor.parse({
      name: 'sliding-floor',
      layout: { parallax: { back: { x: 0.85, y: 1 } } },
      layers: { back: [{ prop: 'room-wall' }, { prop: 'room-floor' }] },
    });
    const note = lintSet(drifting).find((n) => n.message.includes('contains the ground'));
    expect(note).toBeDefined();
    expect(note!.fix).toContain('"parallax"');

    const pinned = SetDescriptor.parse({
      name: 'pinned-floor',
      layout: { parallax: { back: { x: 0.85, y: 1 } } },
      layers: { back: [{ prop: 'room-wall' }, { prop: 'room-floor', parallax: { x: 1, y: 1 } }] },
    });
    expect(lintSet(pinned).find((n) => n.message.includes('contains the ground'))).toBeUndefined();
  });

  it('keeps legacy prop instances valid while preserving optional stable ids', () => {
    const legacy = SetDescriptor.parse({
      name: 'legacy-room',
      layers: { mid: [{ prop: 'mug' }] },
    });
    expect(legacy.layers.mid[0]!.id).toBeUndefined();

    const addressed = SetDescriptor.parse({
      name: 'addressed-room',
      layers: {
        mid: [
          { id: 'desk-mug.1', prop: 'mug' },
          { id: 'work-laptop', prop: 'laptop' },
        ],
      },
    });
    expect(addressed.layers.mid.map((prop) => prop.id)).toEqual(['desk-mug.1', 'work-laptop']);
  });

  it('requires supplied prop ids to be unique across depth layers', () => {
    expect(() => SetDescriptor.parse({
      name: 'duplicate-props',
      layers: {
        back: [{ id: 'hero-mug', prop: 'mug' }],
        fore: [{ id: 'hero-mug', prop: 'mug' }],
      },
    })).toThrow(/duplicate prop instance id.*hero-mug/);
  });
});

describe('prop registry', () => {
  const geo = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });

  it('renders every prop in every palette without throwing', () => {
    // Props read colours from the palette rather than hardcoding them, so a
    // missing slot would only ever surface on the one set that used it.
    for (const key of propKeys()) {
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
    for (const key of propKeys()) {
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
    for (const [key, def] of Object.entries(allProps())) {
      expect(def.tags.length, key).toBeGreaterThan(0);
    }
  });

  it.each(['mug', 'cup', 'laptop'])('%s exposes portable local bounds and stable interaction handles', (key) => {
    const interaction = getProp(key).interaction;
    expect(interaction?.portable).toBe(true);
    expect(interaction?.bounds.width).toBeGreaterThan(0);
    expect(interaction?.bounds.height).toBeGreaterThan(0);
    expect(interaction?.handles.some((handle) => handle.kind === 'grip')).toBe(true);
    expect(interaction?.handles.some((handle) => handle.kind === 'placement')).toBe(true);

    const handleIds = interaction!.handles.map((handle) => handle.id);
    expect(new Set(handleIds).size).toBe(handleIds.length);

    const manifestEntry = propManifest().find((prop) => prop.key === key);
    expect(manifestEntry?.interaction).toEqual(interaction);
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
