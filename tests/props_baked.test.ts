import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  BAKE_BUDGET,
  PALETTE_SLOTS,
  bakedProp,
  loadBakedProps,
  BakedProp,
} from '../src/sets/props/baked.ts';
import { allProps, propKeys, getProp, mergeProps, bakedErrors, bakedTotals } from '../src/sets/props/index.ts';
import { PALETTE_NAMES, getPalette } from '../src/sets/palettes.ts';
import { geometryFor, SetDescriptor } from '../src/sets/schema.ts';
import { lintSet } from '../src/sets/index.ts';
import type { PropContext, PropDef } from '../src/sets/props/types.ts';
import { tempDir } from './helpers.ts';

/**
 * Baked props are the ingest half of the foundry, tested without any of it.
 *
 * Nothing here runs Blender. The question this suite answers is the one that
 * decides whether the foundry is worth building at all: does geometry that came
 * from outside survive the house style and behave like a prop the engine
 * already knew about.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
});

const GEO = geometryFor({ marginX: 420, marginY: 220, horizonY: 566, ceilingY: 92 });

function ctx(palette = 'office-fluorescent'): PropContext {
  return { palette: getPalette(palette), geo: GEO, params: {}, x: 0, y: 0 };
}

/** A small but complete manifest — two filled faces, a seam, and an edge shape. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    key: 'test-block',
    label: 'Test block',
    tags: ['baked'],
    provenance: { blender: '4.5.1', source: 'sha1:abc', baked: '2026-08-04' },
    views: {
      front: {
        shapes: [
          { f: 'wood', l: 1, c: 1, p: [-40, 0, 40, 0, 40, -60, -40, -60] },
          { f: 'woodDark', l: 1, c: 1, p: [40, 0, 60, -20, 60, -80, 40, -60] },
          { f: null, l: 1, c: 0, p: [-40, -30, 40, -30] },
        ],
      },
    },
    ...overrides,
  };
}

async function writeFixture(name: string, body: unknown): Promise<string> {
  const dir = await tempDir('baked');
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, `${name}.geo.json`), JSON.stringify(body), 'utf8');
  return dir;
}

describe('baked prop geometry', () => {
  it.each(PALETTE_NAMES)('renders under %s with no holes in the output', (palette) => {
    const def = bakedProp(BakedProp.parse(manifest()));
    const svg = def.render(ctx(palette));
    expect(svg.length).toBeGreaterThan(100);
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
  });

  it('is deterministic, like every other prop', () => {
    const def = bakedProp(BakedProp.parse(manifest()));
    expect(def.render(ctx())).toBe(def.render(ctx()));
  });

  it('goes through the house style rather than around it', () => {
    // The whole premise: imported polylines get the same wobble, off-register
    // fill and jittered line weight as a hand-drawn rectangle. If these come out
    // as straight-line paths, baked props will read as foreign next to the rest.
    const svg = bakedProp(BakedProp.parse(manifest())).render(ctx());
    expect(svg).toContain(' C ');
    expect(svg).toContain('stroke-linejoin="round"');
    // Fill and outline are separate paths, the fill deliberately shifted.
    expect(svg).toMatch(/<path d="[^"]+" fill="#[0-9a-f]{6}" stroke="none" transform="translate\(/);
  });

  it('draws edge-of-world shapes square so the misprint cannot open a seam', () => {
    const edge = bakedProp(BakedProp.parse(manifest({
      views: { front: { shapes: [{ f: 'wall', l: 1, c: 1, e: 1, p: [-420, -220, 1700, -220, 1700, 940, -420, 940] }] } },
    })));
    const svg = edge.render(ctx());
    // No curves, no outline, no fill offset — exactly what an unoutlined
    // background rect does today.
    expect(svg).not.toContain(' C ');
    expect(svg).not.toContain('transform=');
    expect(svg).toContain('stroke="none"');
    expect(svg.match(/<path/g)).toHaveLength(1);
  });

  it('exposes a view picker only when there is more than one view', () => {
    const single = bakedProp(BakedProp.parse(manifest()));
    expect(single.params).toEqual([]);

    const multi = bakedProp(BakedProp.parse(manifest({
      views: {
        front: { shapes: [{ f: 'wood', p: [-10, 0, 10, 0, 10, -10, -10, -10] }] },
        side: { shapes: [{ f: 'metal', p: [-5, 0, 5, 0, 5, -10, -5, -10] }] },
      },
    })));
    // Declaration order, so the author's primary view wins rather than whichever
    // name happens to sort first.
    expect(multi.params).toEqual([
      { key: 'view', label: 'View', type: 'choice', default: 'front', choices: ['front', 'side'] },
    ]);
    const reversed = bakedProp(BakedProp.parse(manifest({
      views: {
        side: { shapes: [{ f: 'metal', p: [-5, 0, 5, 0, 5, -10, -5, -10] }] },
        front: { shapes: [{ f: 'wood', p: [-10, 0, 10, 0, 10, -10, -10, -10] }] },
      },
    })));
    expect(reversed.params[0]!.default).toBe('side');
    // The picker actually selects, and an unknown view falls back rather than
    // rendering nothing.
    const front = multi.render({ ...ctx(), params: { view: 'front' } });
    const side = multi.render({ ...ctx(), params: { view: 'side' } });
    expect(front).not.toBe(side);
    expect(multi.render({ ...ctx(), params: { view: 'nope' } })).toBe(front);
  });

  it('survives a round trip through JSON unchanged', () => {
    const parsed = BakedProp.parse(manifest());
    const again = BakedProp.parse(JSON.parse(JSON.stringify(parsed)));
    expect(bakedProp(again).render(ctx())).toBe(bakedProp(parsed).render(ctx()));
  });
});

describe('baked rooms', () => {
  const room = () => manifest({
    key: 'test-room',
    spanning: true,
    frame: { x0: -420, y0: -220, width: 2120, height: 1160, horizonY: 566, ceilingY: 92 },
    views: { default: { shapes: [{ f: 'wall', l: 1, c: 1, e: 1, p: [-420, -220, 1700, -220, 1700, 566, -420, 566] }] } },
  });

  it('requires a spanning bake to record the frame it assumed', () => {
    // Perspective is baked in, so a room without its stage geometry recorded is
    // a prop nothing can check for drift.
    const orphan = manifest({ key: 'test-room', spanning: true });
    expect(() => BakedProp.parse(orphan)).toThrow(/draw from the set geometry|record the frame/);
    expect(() => BakedProp.parse(room())).not.toThrow();
  });

  it('carries the frame onto the prop so the linter can reach it', () => {
    expect(bakedProp(BakedProp.parse(room())).bakedFrame).toEqual({
      x0: -420, y0: -220, width: 2120, height: 1160, horizonY: 566, ceilingY: 92,
    });
    expect(bakedProp(BakedProp.parse(manifest())).bakedFrame).toBeUndefined();
  });

  it('says so when a set has drifted from the room it was baked against', () => {
    // A drawn wall rebuilds itself around any horizon. A baked one cannot, and
    // the symptom is characters standing partway up the back wall.
    const matching = SetDescriptor.parse({
      name: 'in-step',
      layers: { back: [{ prop: 'room-perspective' }] },
    });
    expect(lintSet(matching).find((n) => n.message.includes('baked room'))).toBeUndefined();

    const drifted = SetDescriptor.parse({
      name: 'out-of-step',
      layout: { horizonY: 480, ceilingY: 92 },
      layers: { back: [{ prop: 'room-perspective' }] },
    });
    const note = lintSet(drifted).find((n) => n.message.includes('baked room'));
    expect(note).toBeDefined();
    expect(note!.message).toContain('horizonY 480');
    expect(note!.fix).toContain('566');
  });

  it('ships a room whose perspective lands on the engine default layout', () => {
    // The point of solving the camera rather than eyeballing it: the room drops
    // into an existing set without moving anyone's feet.
    const frame = getProp('room-perspective').bakedFrame!;
    expect(frame.horizonY).toBe(566);
    expect(frame.ceilingY).toBe(92);
    expect(frame.width).toBe(2120);
  });

  it('draws the world edge square so the misprint cannot open a seam', () => {
    const svg = getProp('room-perspective').render(ctx());
    // Every shape that reaches the boundary must be a flat path.
    const edgeShapes = svg.match(/<path d="M [^"]*" fill="#[0-9a-f]{6}" stroke="none"\/>/g) ?? [];
    expect(edgeShapes.length).toBeGreaterThan(0);
    for (const shape of edgeShapes) expect(shape).not.toContain(' C ');
  });
});

describe('baked prop loading', () => {
  it('reports a bad palette slot instead of throwing', async () => {
    // A throw here would run at module load and take the CLI, the server and
    // doctor down together — leaving nothing able to say which file is wrong.
    const dir = await writeFixture('test-block', manifest({
      views: { front: { shapes: [{ f: 'mahogany', p: [0, 0, 10, 0, 10, -10, 0, -10] }] } },
    }));
    const loaded = loadBakedProps(dir);
    expect(loaded.props).toEqual({});
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]!.file).toBe('test-block/test-block.geo.json');
    expect(loaded.errors[0]!.error).toMatch(/mahogany/);
  });

  it('rejects a bake that would swamp the house style', async () => {
    const shapes = Array.from({ length: BAKE_BUDGET.maxShapes + 1 }, (_, i) => ({
      f: 'wood', p: [i, 0, i + 1, 0, i + 1, -1, i, -1],
    }));
    const dir = await writeFixture('test-block', manifest({ views: { front: { shapes } } }));
    const loaded = loadBakedProps(dir);
    expect(loaded.props).toEqual({});
    expect(loaded.errors[0]!.error).toContain(String(BAKE_BUDGET.maxShapes));
  });

  it('rejects a bake that is too many points even at few shapes', async () => {
    // Points are the real cost: each becomes a cubic in the render page.
    const p: number[] = [];
    for (let i = 0; i < BAKE_BUDGET.maxPoints + 10; i++) p.push(i, -i);
    const dir = await writeFixture('test-block', manifest({ views: { front: { shapes: [{ f: 'wood', p }] } } }));
    const loaded = loadBakedProps(dir);
    expect(loaded.props).toEqual({});
    expect(loaded.errors[0]!.error).toContain(String(BAKE_BUDGET.maxPoints));
  });

  it('refuses a manifest whose key disagrees with its directory', async () => {
    const dir = await writeFixture('test-block', manifest({ key: 'something-else' }));
    const loaded = loadBakedProps(dir);
    expect(loaded.props).toEqual({});
    expect(loaded.errors[0]!.error).toContain('does not match its directory');
  });

  it('treats a missing props directory as an empty catalogue', () => {
    const loaded = loadBakedProps(path.join('F:', 'no', 'such', 'directory'));
    expect(loaded).toEqual({ props: {}, errors: [], shapes: 0, points: 0 });
  });

  it('loads the committed catalogue cleanly', () => {
    // Whatever is in props/ has to be valid, or the registry is lying about
    // what a set may reference.
    expect(bakedErrors()).toEqual([]);
    expect(bakedTotals().shapes).toBeGreaterThan(0);
  });
});

describe('the merged registry', () => {
  it('registers baked props alongside the built-in ones', () => {
    expect(propKeys()).toContain('crate-stack');
    expect(propKeys()).toContain('crate');
    expect(getProp('crate-stack').tags).toContain('baked');
  });

  it('renders every prop in the catalogue, baked or not, in every palette', () => {
    // The existing guard, restated here because baked props are the first
    // entries a person can add without touching TypeScript.
    for (const key of propKeys()) {
      for (const palette of PALETTE_NAMES) {
        const svg = allProps()[key]!.render(ctx(palette));
        expect(svg, `${key} @ ${palette}`).not.toContain('undefined');
        expect(svg, `${key} @ ${palette}`).not.toContain('NaN');
      }
    }
  });

  it('refuses to let one source silently shadow another', () => {
    const a: Record<string, PropDef> = { dupe: bakedProp(BakedProp.parse(manifest({ key: 'dupe' }))) };
    const b: Record<string, PropDef> = { dupe: bakedProp(BakedProp.parse(manifest({ key: 'dupe' }))) };
    expect(() => mergeProps([['builtin', a], ['props/ (baked)', b]]))
      .toThrow(/duplicate prop key "dupe".*builtin.*props\//s);
  });

  it('derives palette slots from a real palette rather than a second list', () => {
    expect(PALETTE_SLOTS).toEqual(Object.keys(getPalette('bar-night')));
    expect(PALETTE_SLOTS).toContain('line');
    expect(PALETTE_SLOTS).toContain('wood');
  });
});
