import { describe, it, expect } from 'vitest';
import { propJsonSchema, normalisePrimitive, type RawPrimitive } from '../src/llm/prop.ts';
import { PALETTE_SLOTS, PropDocument, propFromDocument } from '../src/sets/props/index.ts';
import { getPalette, PALETTE_NAMES } from '../src/sets/palettes.ts';
import { geometryFor } from '../src/sets/schema.ts';

/**
 * Describing a prop to the local model.
 *
 * Nothing here runs a model. The parts worth pinning are the two that decide
 * whether a model's output can hurt anything: the schema it is constrained to,
 * and the line between what it said and what the engine is asked to draw.
 */

const GEO = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });

interface Schema {
  properties: {
    primitives: {
      items: {
        properties: { k: { enum: string[] }; f: { enum: string[] } };
        required: string[];
      };
    };
  };
  required: string[];
}

describe('the schema a model is held to', () => {
  const schema = propJsonSchema() as Schema;
  const item = schema.properties.primitives.items;

  it('offers exactly the palette slots, so a colour value cannot be invented', () => {
    // The same guard set generation gets from the prop enum: whatever writes
    // this should be unable to name something that does not exist.
    expect(item.properties.f.enum).toEqual(PALETTE_SLOTS);
    expect(item.properties.f.enum).not.toContain('#ff0000');
  });

  it('offers only the shapes the engine can draw', () => {
    expect(item.properties.k.enum).toEqual(['rect', 'ellipse', 'poly', 'line']);
  });

  it('insists a shape says what kind it is and what colour it takes', () => {
    expect(item.required).toEqual(['k', 'f']);
    expect(schema.required).toContain('primitives');
  });
});

describe('the line between what a model said and what gets drawn', () => {
  it('accepts a well-formed shape of each kind', () => {
    expect(normalisePrimitive({ k: 'rect', f: 'wood', x: -20, y: -40, w: 40, h: 40 }))
      .toEqual({ k: 'rect', f: 'wood', l: 1, x: -20, y: -40, w: 40, h: 40 });
    expect(normalisePrimitive({ k: 'ellipse', f: 'metal', cx: 0, cy: -10, rx: 8, ry: 4 }))
      .toMatchObject({ k: 'ellipse', f: 'metal', rx: 8 });
    expect(normalisePrimitive({ k: 'line', f: 'line', x1: 0, y1: 0, x2: 10, y2: -10 }))
      .toMatchObject({ k: 'line', sw: 3 });
    expect(normalisePrimitive({ k: 'poly', f: 'clay', points: [0, 0, 10, 0, 5, -10] }))
      .toMatchObject({ k: 'poly', c: 1, p: [0, 0, 10, 0, 5, -10] });
  });

  it.each([
    ['a rect with no size', { k: 'rect', f: 'wood' }],
    ['a rect with negative size', { k: 'rect', f: 'wood', x: 0, y: 0, w: -5, h: 10 }],
    ['a zero-radius ellipse', { k: 'ellipse', f: 'wood', cx: 0, cy: 0, rx: 0, ry: 4 }],
    ['a two-point polygon', { k: 'poly', f: 'wood', points: [0, 0, 10, 10] }],
    ['an odd number of coordinates', { k: 'poly', f: 'wood', points: [0, 0, 10, 10, 5] }],
    ['a shape kind that is not one', { k: 'spiral', f: 'wood', x: 0, y: 0, w: 1, h: 1 }],
    ['NaN where a number should be', { k: 'rect', f: 'wood', x: Number.NaN, y: 0, w: 10, h: 10 }],
    ['nothing at all', {}],
  ])('drops %s rather than repairing it', (_label, raw) => {
    expect(normalisePrimitive(raw as RawPrimitive)).toBeNull();
  });

  it('falls back to a neutral slot rather than failing on an unknown colour', () => {
    // Structured decoding should make this impossible; if it happens anyway,
    // a grey box is a better outcome than a set that will not render.
    expect(normalisePrimitive({ k: 'rect', f: 'chartreuse', x: 0, y: -10, w: 10, h: 10 }))
      .toMatchObject({ f: 'surface' });
  });

  it('honours a shape asking not to be outlined', () => {
    expect(normalisePrimitive({ k: 'rect', f: 'screen', outline: false, x: 0, y: -10, w: 10, h: 10 }))
      .toMatchObject({ l: 0 });
  });
});

describe('what a model produces is an ordinary prop', () => {
  it('renders in every palette once it has been through the normaliser', () => {
    const primitives = ([
      { k: 'poly', f: 'metal', points: [-17, -54, 17, -54, 11, 0, -11, 0] },
      { k: 'ellipse', f: 'metalDark', cx: 0, cy: -54, rx: 17, ry: 4 },
      { k: 'nonsense', f: 'metal' },
    ] as RawPrimitive[]).map(normalisePrimitive).filter((p) => p !== null);

    expect(primitives).toHaveLength(2);

    const doc = PropDocument.parse({
      format: 2,
      key: 'described-bin',
      label: 'Waste bin',
      tags: ['office'],
      provenance: { blender: 'none (described to a model)', source: 'sha1:0', baked: '2026-08-04' },
      views: { default: { primitives } },
    });

    const def = propFromDocument(doc);
    for (const name of PALETTE_NAMES) {
      const svg = def.render({ palette: getPalette(name), geo: GEO, params: {}, x: 640, y: 566 });
      expect(svg.length, name).toBeGreaterThan(0);
      expect(svg, name).not.toContain('NaN');
      expect(svg, name).not.toContain('undefined');
    }
  });
});
