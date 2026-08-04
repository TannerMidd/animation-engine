import { describe, it, expect } from 'vitest';
import {
  PropDocument, propFromDocument, documentBoxes, countView, BAKE_BUDGET, PALETTE_SLOTS,
} from '../src/sets/props/document.ts';
import { rect, ellipse, poly, line, type PropContext } from '../src/sets/props/types.ts';
import { getPalette, PALETTE_NAMES } from '../src/sets/palettes.ts';
import { geometryFor, type ParamValue } from '../src/sets/schema.ts';

/**
 * The prop document: a prop expressed as data rather than as a render function.
 *
 * The claim these tests have to defend is that a document prop is not merely
 * similar to a coded one but takes the same code path — that a rectangle in a
 * file and a `rect()` call in TypeScript produce the same markup, wobble and
 * all. If that ever stops being true the catalogue splits into two looks.
 */

const GEO = geometryFor({ marginX: 420, marginY: 220, horizonY: 566, ceilingY: 92 });
const P = getPalette('office-fluorescent');

function ctx(params: Record<string, ParamValue> = {}, palette = P): PropContext {
  return { palette, geo: GEO, params, x: 0, y: 0 };
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 2,
    key: 'test-thing',
    label: 'Test thing',
    tags: ['test'],
    provenance: { blender: 'none (drawn in the editor)', source: 'sha1:0', baked: '2026-08-04' },
    views: { default: { primitives: [{ k: 'rect', f: 'wood', x: -40, y: -60, w: 80, h: 60 }] } },
    ...overrides,
  };
}

const build = (overrides: Record<string, unknown> = {}) => propFromDocument(PropDocument.parse(doc(overrides)));
const draw = (overrides: Record<string, unknown> = {}, params: Record<string, ParamValue> = {}) =>
  build(overrides).render(ctx(params));

/**
 * How many primitives were filled with a colour.
 *
 * Counting `translate` would not work: the house style gives every filled shape
 * a deliberately misregistered fill, which is itself a translate, so a drawn
 * rectangle and a repeat offset look the same to a naive match.
 */
function fills(svg: string, colour: string): number {
  const needle = `fill="${colour}"`;
  let n = 0;
  for (let at = svg.indexOf(needle); at !== -1; at = svg.indexOf(needle, at + 1)) n++;
  return n;
}

/** A one-primitive document, for comparing a primitive against its helper. */
const only = (primitive: Record<string, unknown>, params: unknown[] = []) =>
  draw({ params, views: { default: { primitives: [primitive] } } });

describe('primitives take the same code path as the drawing helpers', () => {
  it('draws a rect exactly as rect() does', () => {
    expect(only({ k: 'rect', f: 'wood', x: -125, y: -96, w: 250, h: 16 }))
      .toBe(rect(P, -125, -96, 250, 16, P.wood));
  });

  it('carries the corner radius and the stroke width through', () => {
    expect(only({ k: 'rect', f: 'metal', x: -54, y: -92, w: 108, h: 76, rx: 6 }))
      .toBe(rect(P, -54, -92, 108, 76, P.metal, { rx: 6 }));
    expect(only({ k: 'rect', f: 'glass', x: 0, y: 0, w: 46, h: 56, sw: 2 }))
      .toBe(rect(P, 0, 0, 46, 56, P.glass, { strokeWidth: 2 }));
  });

  it('draws an unoutlined rect square, as a background must be', () => {
    expect(only({ k: 'rect', f: 'screen', x: -10, y: -20, w: 40, h: 30, l: 0 }))
      .toBe(rect(P, -10, -20, 40, 30, P.screen, { outline: false }));
  });

  it('draws an ellipse exactly as ellipse() does', () => {
    expect(only({ k: 'ellipse', f: 'foliage', cx: 0, cy: -120, rx: 170, ry: 133 }))
      .toBe(ellipse(P, 0, -120, 170, 133, P.foliage));
    expect(only({ k: 'ellipse', f: 'light', cx: 0, cy: -4, rx: 30, ry: 12, l: 0 }))
      .toBe(ellipse(P, 0, -4, 30, 12, P.light, { outline: false }));
  });

  it('draws a poly exactly as poly() does', () => {
    const points: Array<[number, number]> = [[-60, 0], [-34, -57], [8, -70], [42, -42], [60, 0]];
    expect(only({ k: 'poly', f: 'surface', p: points.flat() })).toBe(poly(P, points, P.surface));
    expect(only({ k: 'poly', f: 'surface', p: points.flat(), l: 0 })).toBe(poly(P, points, P.surface, false));
  });

  it('draws a line exactly as line() does', () => {
    expect(only({ k: 'line', f: 'woodDark', x1: -45, y1: -90, x2: 45, y2: 0, sw: 4 }))
      .toBe(line(P, -45, -90, 45, 0, P.woodDark, 4));
  });

  it('defaults a line to the ink colour and the house stroke width', () => {
    expect(only({ k: 'line', x1: 0, y1: 0, x2: 10, y2: 0 })).toBe(line(P, 0, 0, 10, 0, P.line));
  });
});

describe('crisp shapes', () => {
  it('draws an edge-of-world shape square and fill-only', () => {
    const svg = only({ k: 'poly', f: 'wall', p: [-420, -220, 860, -220, 860, 500, -420, 500], e: 1 });
    expect(svg).toBe('<path d="M -420 -220 L 860 -220 L 860 500 L -420 500 Z" fill="' + P.wall + '" stroke="none"/>');
  });

  it('keeps the outline on a smooth shape, which the edge flag drops', () => {
    // The case that used to force a prop to emit raw SVG: a clock face is not
    // at the edge of the world, it just wants to be a circle.
    const smooth = only({ k: 'ellipse', f: 'surface', cx: 0, cy: -380, rx: 34, ry: 34, sm: 1 });
    expect(smooth).toContain(`stroke="${P.line}"`);
    expect(smooth).toMatch(/^<path d="M /);
    expect(smooth).not.toContain('C');
  });

  it('omits a shape that would draw nothing at all', () => {
    expect(only({ k: 'poly', f: null, p: [0, 0, 10, 10], e: 1 })).toBe('');
  });
});

describe('expressions drive geometry', () => {
  const desk = {
    params: [
      { key: 'width', label: 'Width', type: 'number', default: 250, min: 80, max: 700, step: 10 },
      { key: 'height', label: 'Height', type: 'number', default: 96, min: 40, max: 200, step: 5 },
    ],
    views: {
      default: {
        primitives: [
          { k: 'rect', f: 'woodDark', x: '-width / 2 + 14', y: '-height + 16', w: 12, h: 'height - 16' },
          { k: 'rect', f: 'wood', x: '-width / 2', y: '-height', w: 'width', h: 16 },
        ],
      },
    },
  };

  it('uses the declared default when the instance says nothing', () => {
    expect(draw(desk)).toBe(
      rect(P, -125 + 14, -96 + 16, 12, 80, P.woodDark) + rect(P, -125, -96, 250, 16, P.wood),
    );
  });

  it('answers to the params an instance sets', () => {
    expect(draw(desk, { width: 400 })).toBe(
      rect(P, -200 + 14, -80, 12, 80, P.woodDark) + rect(P, -200, -96, 400, 16, P.wood),
    );
  });

  it('refuses a document whose expression names something undeclared', () => {
    expect(() => build({
      params: [{ key: 'width', label: 'W', type: 'number', default: 10 }],
      views: { default: { primitives: [{ k: 'rect', f: 'wood', x: 'depth', y: 0, w: 1, h: 1 }] } },
    })).toThrow(/unknown name "depth"/);
  });
});

describe('show', () => {
  const lamp = {
    params: [{ key: 'on', label: 'Lit', type: 'boolean', default: true }],
    views: {
      default: {
        primitives: [
          { k: 'rect', f: 'metal', x: -6, y: -40, w: 12, h: 40 },
          { k: 'ellipse', f: 'light', cx: 0, cy: -44, rx: 20, ry: 10, show: 'on' },
          { k: 'ellipse', f: 'metalDark', cx: 0, cy: -44, rx: 20, ry: 10, show: '!on' },
        ],
      },
    },
  };

  it('includes a primitive when its condition holds', () => {
    expect(draw(lamp, { on: true })).toContain(P.light);
    expect(draw(lamp, { on: true })).not.toContain(P.metalDark);
  });

  it('swaps to the alternative when it does not', () => {
    expect(draw(lamp, { on: false })).toContain(P.metalDark);
    expect(draw(lamp, { on: false })).not.toContain(P.light);
  });

  it('follows the declared default', () => {
    expect(draw(lamp)).toContain(P.light);
  });
});

describe('text', () => {
  const sign = {
    params: [{ key: 'text', label: 'Text', type: 'text', default: 'EXIT' }],
    views: { default: { primitives: [{ k: 'text', f: 'line', x: 0, y: -30, size: 23, value: '$text' }] } },
  };

  it('interpolates the param', () => {
    expect(draw(sign)).toContain('>EXIT<');
    expect(draw(sign, { text: 'OPEN' })).toContain('>OPEN<');
  });

  it('escapes it, so a param cannot inject markup', () => {
    const svg = draw(sign, { text: '<script>x</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('exposes the text length to arithmetic, since a sign sizes to its words', () => {
    const svg = draw({
      params: [
        { key: 'text', label: 'Text', type: 'text', default: 'OPEN' },
        { key: 'size', label: 'Size', type: 'number', default: 44 },
      ],
      views: {
        default: {
          primitives: [
            { k: 'rect', f: 'metalDark', x: 0, y: 0, w: 'max(80, textLength * size * 0.72 + 40)', h: 10 },
          ],
        },
      },
    }, { text: 'CLOSED', size: 44 });
    expect(svg).toBe(rect(P, 0, 0, Math.max(80, 6 * 44 * 0.72 + 40), 10, P.metalDark));
  });

  it('carries a stroked copy for a glow, without any filter', () => {
    const svg = only({ k: 'text', f: 'accent', st: 'accentGlow', x: 0, y: 0, size: 44, value: 'NEON', sw: 9, o: 0.45 });
    expect(svg).toContain(`stroke="${P.accentGlow}"`);
    expect(svg).toContain('stroke-width="9"');
    expect(svg).toContain('opacity="0.45"');
    expect(svg).not.toContain('filter');
  });
});

describe('repeat', () => {
  const shelf = (n: number) => draw({
    params: [{ key: 'shelves', label: 'Shelves', type: 'number', default: 4, min: 2, max: 8, step: 1 }],
    views: {
      default: {
        primitives: [{
          k: 'repeat', n: 'shelves', dy: '-70',
          of: [{ k: 'rect', f: 'wood', x: -90, y: -12, w: 180, h: 12 }],
        }],
      },
    },
  }, { shelves: n });

  it('expands to the requested count', () => {
    expect(fills(shelf(4), P.wood)).toBe(4);
    expect(fills(shelf(8), P.wood)).toBe(8);
  });

  it('draws nothing at a count of zero, rather than failing', () => {
    expect(shelf(0)).toBe('');
  });

  it('puts the index in scope, so a repeat can vary rather than merely duplicate', () => {
    // facade's lit-window rule. The point is that this is arithmetic, not RNG:
    // a prop that varied per render would break frame dedup.
    const svg = draw({
      params: [{ key: 'windows', label: 'Windows', type: 'number', default: 6 }],
      views: {
        default: {
          primitives: [{
            k: 'repeat', n: 'windows', dx: 40,
            of: [{ k: 'rect', f: 'light', x: 0, y: -30, w: 24, h: 30, show: 'i % 3 != 1' }],
          }],
        },
      },
    });
    // Six windows, and the one in three that stays dark is always the same one.
    expect(fills(svg, P.light)).toBe(4);
  });

  it('nests, which is how a facade gets floors of windows', () => {
    const svg = draw({
      params: [
        { key: 'floors', label: 'Floors', type: 'number', default: 3 },
        { key: 'perFloor', label: 'Per floor', type: 'number', default: 3 },
      ],
      views: {
        default: {
          primitives: [{
            k: 'repeat', n: 'floors', dy: -120,
            of: [{
              k: 'repeat', n: 'perFloor', dx: 80,
              of: [{ k: 'rect', f: 'glass', x: 0, y: -40, w: 40, h: 40, show: '(i * perFloor + j) % 3 != 1' }],
            }],
          }],
        },
      },
    });
    // Three floors of three, minus the one in three that stays dark.
    expect((svg.match(/<path/g) ?? []).length).toBe(6 * 2);
  });

  it('puts the index in scope only inside the repeat that owns it', () => {
    // Otherwise `i` at the top level would silently be zero, which reads as
    // "the first one" and draws a plausible-looking wrong prop.
    expect(() => build({
      views: { default: { primitives: [{ k: 'rect', f: 'wood', x: 'i * 10', y: 0, w: 1, h: 1 }] } },
    })).toThrow(/unknown name "i"/);
  });

  it('refuses to nest deeper than the loop variables allow', () => {
    const nest = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { k: 'rect', f: 'wood', x: 0, y: 0, w: 1, h: 1 }
        : { k: 'repeat', n: 2, of: [nest(depth - 1)] };
    expect(() => build({ views: { default: { primitives: [nest(3)] } } })).not.toThrow();
    expect(() => build({ views: { default: { primitives: [nest(4)] } } })).toThrow(/nest at most/);
  });

  it('clamps a runaway count rather than hanging the render', () => {
    const svg = draw({
      params: [{ key: 'n', label: 'N', type: 'number', default: 100000 }],
      views: {
        default: {
          primitives: [{ k: 'repeat', n: 'n', dx: 1, of: [{ k: 'rect', f: 'wood', x: 0, y: 0, w: 1, h: 1 }] }],
        },
      },
    });
    expect(fills(svg, P.wood)).toBeLessThanOrEqual(512);
  });
});

describe('views', () => {
  const twoViews = {
    views: {
      'three-quarter': { primitives: [{ k: 'rect', f: 'wood', x: 0, y: 0, w: 10, h: 10 }] },
      side: { primitives: [{ k: 'rect', f: 'metal', x: 0, y: 0, w: 10, h: 10 }] },
    },
  };

  it('gives a multi-view prop a dropdown for free', () => {
    const def = build(twoViews);
    expect(def.params).toEqual([
      { key: 'view', label: 'View', type: 'choice', default: 'three-quarter', choices: ['three-quarter', 'side'] },
    ]);
    expect(build().params).toEqual([]);
  });

  it('treats the first declared view as the prop\'s normal appearance', () => {
    // Not alphabetical: sorting would let "side" quietly beat "three-quarter".
    expect(build(twoViews).render(ctx())).toContain(P.wood);
    expect(build(twoViews).render(ctx({ view: 'side' }))).toContain(P.metal);
  });

  it('falls back to the first view when asked for one that is gone', () => {
    expect(build(twoViews).render(ctx({ view: 'nope' }))).toContain(P.wood);
  });
});

describe('interaction geometry', () => {
  const chair = {
    params: [
      { key: 'height', label: 'Seat height', type: 'number', default: 90, min: 40, max: 180, step: 5 },
      { key: 'width', label: 'Seat width', type: 'number', default: 112, min: 70, max: 180, step: 4 },
    ],
    interaction: {
      portable: false,
      bounds: { x: '-width / 2', y: '-height - 90', width: 'width', height: 'height + 90' },
      handles: [
        { id: 'seat', label: 'Seat cushion', kind: 'seat', x: 0, y: '-height - 6', radius: 'width * 0.42', normal: { x: 0, y: -1 } },
      ],
    },
  };

  it('resolves at the declared defaults', () => {
    expect(build(chair).interaction).toEqual({
      portable: false,
      bounds: { x: -56, y: -180, width: 112, height: 180 },
      handles: [{ id: 'seat', label: 'Seat cushion', kind: 'seat', x: 0, y: -96, radius: 112 * 0.42, normal: { x: 0, y: -1 } }],
    });
  });

  it('answers to the params an instance sets, so a taller chair has a higher seat', () => {
    const resolved = build(chair).interactionFor!({ height: 140 });
    expect(resolved.handles[0]!.y).toBe(-146);
    expect(resolved.bounds.height).toBe(230);
  });

  it('is absent when the document declares none, leaving the prop as scenery', () => {
    expect(build().interaction).toBeUndefined();
    expect(build().interactionFor).toBeUndefined();
  });
});

describe('format 1', () => {
  it('reads a baked shape as a polygon, unchanged', () => {
    const points: Array<[number, number]> = [[-60, -90], [60, -90], [90, -115], [-30, -115]];
    const one = propFromDocument(PropDocument.parse(doc({
      format: 1,
      views: { front: { shapes: [{ f: 'wood', l: 1, c: 1, p: points.flat() }] } },
    })));
    expect(one.render(ctx())).toBe(poly(P, points, P.wood));
  });

  it('applies the old defaults for omitted flags', () => {
    const one = propFromDocument(PropDocument.parse(doc({
      format: 1,
      views: { front: { shapes: [{ p: [0, 0, 10, 0, 10, 10] }] } },
    })));
    // f defaults to null, l to 1: an unfilled outlined shape.
    expect(one.render(ctx())).toContain(`stroke="${P.line}"`);
  });
});

describe('validation', () => {
  it('requires a spanning prop to record its frame', () => {
    expect(() => PropDocument.parse(doc({ spanning: true }))).toThrow(/must record the frame/);
    expect(() => PropDocument.parse(doc({
      spanning: true,
      frame: { x0: -420, y0: -220, width: 2120, height: 1160, horizonY: 566, ceilingY: 92 },
    }))).not.toThrow();
  });

  it('rejects a palette slot that is not one', () => {
    expect(() => PropDocument.parse(doc({
      views: { default: { primitives: [{ k: 'rect', f: 'chartreuse', x: 0, y: 0, w: 1, h: 1 }] } },
    }))).toThrow();
  });

  it('rejects duplicate params and a choice with no choices', () => {
    const spec = { label: 'X', type: 'number', default: 1 };
    // Zod stringifies its issues as JSON, so the quotes around the name arrive
    // escaped — match the sentence, not the punctuation.
    expect(() => PropDocument.parse(doc({ params: [{ ...spec, key: 'w' }, { ...spec, key: 'w' }] })))
      .toThrow(/duplicate param/);
    expect(() => PropDocument.parse(doc({ params: [{ key: 'v', label: 'V', type: 'choice', default: 'a' }] })))
      .toThrow(/lists no choices/);
  });

  it('rejects a param that would shadow the length of a text param', () => {
    expect(() => PropDocument.parse(doc({
      params: [
        { key: 'sign', label: 'Sign', type: 'text', default: 'HI' },
        { key: 'signLength', label: 'Len', type: 'number', default: 2 },
      ],
    }))).toThrow(/collides with the length/);
  });

  it('rejects a key that is not kebab-case', () => {
    expect(() => PropDocument.parse(doc({ key: 'Test Thing' }))).toThrow(/kebab-case/);
  });

  it('rejects geometry over the shape budget', () => {
    const many = Array.from({ length: BAKE_BUDGET.maxShapes + 1 }, () => ({ k: 'rect', f: 'wood', x: 0, y: 0, w: 1, h: 1 }));
    expect(() => PropDocument.parse(doc({ views: { default: { primitives: many } } }))).toThrow(/exceeds the 300/);
  });

  it('rejects geometry over the point budget', () => {
    // Ten shapes is well under the shape budget; 2100 points is over the one
    // that actually costs, because every point becomes a cubic.
    const fat = { k: 'poly', f: 'wood', p: Array.from({ length: 420 }, (_, n) => n) };
    const many = Array.from({ length: 10 }, () => fat);
    expect(() => PropDocument.parse(doc({ views: { default: { primitives: many } } }))).toThrow(/exceeds the 2000/);
  });

  it('counts a repeat against the budget rather than treating it as free', () => {
    const view = { primitives: [{ k: 'repeat' as const, n: 10, of: [{ k: 'rect' as const, f: 'wood', x: 0, y: 0, w: 1, h: 1 }] }] };
    expect(countView(view as never).shapes).toBe(10);
  });
});

describe('measuring where the primitives landed', () => {
  const boxes = (overrides: Record<string, unknown>, params: Record<string, ParamValue> = {}) =>
    documentBoxes(PropDocument.parse(doc(overrides)), params);

  it('reports the authored geometry, so a handle sits where the shape was drawn', () => {
    // Not the drawn geometry: the wobble pushes outlines a few units past this,
    // and a handle that chased the wobble would sit somewhere nobody put anything.
    expect(boxes({})).toEqual([
      { path: [0], kind: 'rect', x: -40, y: -60, width: 80, height: 60, copy: [] },
    ]);
  });

  it('measures each primitive kind by what it covers', () => {
    const [ellipse, line, poly] = boxes({
      views: {
        default: {
          primitives: [
            { k: 'ellipse', f: 'wood', cx: 10, cy: -20, rx: 30, ry: 15 },
            { k: 'line', f: 'line', x1: 40, y1: 0, x2: -10, y2: -50 },
            { k: 'poly', f: 'wood', p: [0, 0, 60, -10, 20, -70] },
          ],
        },
      },
    });
    expect(ellipse).toMatchObject({ x: -20, y: -35, width: 60, height: 30 });
    expect(line).toMatchObject({ x: -10, y: -50, width: 50, height: 50 });
    expect(poly).toMatchObject({ x: 0, y: -70, width: 60, height: 70 });
  });

  it('follows expressions, so the boxes move when the params do', () => {
    const parametric = {
      params: [{ key: 'width', label: 'W', type: 'number', default: 100, min: 10, max: 400 }],
      views: { default: { primitives: [{ k: 'rect', f: 'wood', x: '-width / 2', y: -10, w: 'width', h: 10 }] } },
    };
    expect(boxes(parametric)[0]).toMatchObject({ x: -50, width: 100 });
    expect(boxes(parametric, { width: 300 })[0]).toMatchObject({ x: -150, width: 300 });
  });

  it('gives every expansion of a repeat its own box, under one authored address', () => {
    // The canvas needs a handle per copy but a selection per shape: clicking the
    // third shelf must select the shelf, not a third of one.
    const shelves = boxes({
      params: [{ key: 'shelves', label: 'S', type: 'number', default: 3 }],
      views: {
        default: {
          primitives: [{
            k: 'repeat', n: 'shelves', dy: -70,
            of: [{ k: 'rect', f: 'wood', x: -90, y: -12, w: 180, h: 12 }],
          }],
        },
      },
    });
    expect(shelves).toHaveLength(3);
    expect(shelves.map((b) => b.y)).toEqual([-12, -82, -152]);
    expect(new Set(shelves.map((b) => b.path.join('.'))).size).toBe(1);
    expect(shelves.map((b) => b.copy)).toEqual([[0], [1], [2]]);
  });

  it('leaves out what the params have hidden', () => {
    const lamp = {
      params: [{ key: 'on', label: 'Lit', type: 'boolean', default: true }],
      views: {
        default: {
          primitives: [
            { k: 'rect', f: 'metal', x: -6, y: -40, w: 12, h: 40 },
            { k: 'ellipse', f: 'light', cx: 0, cy: -44, rx: 20, ry: 10, show: 'on' },
          ],
        },
      },
    };
    expect(boxes(lamp, { on: true })).toHaveLength(2);
    expect(boxes(lamp, { on: false })).toHaveLength(1);
  });

  it('caps a runaway repeat rather than handing the canvas a hundred thousand targets', () => {
    const many = boxes({
      params: [{ key: 'n', label: 'N', type: 'number', default: 100000 }],
      views: {
        default: {
          primitives: [{ k: 'repeat', n: 'n', dx: 1, of: [{ k: 'rect', f: 'wood', x: 0, y: 0, w: 1, h: 1 }] }],
        },
      },
    });
    expect(many.length).toBeLessThanOrEqual(400);
  });

  it('measures a format-1 baked shape as the polygon it becomes', () => {
    const upgraded = documentBoxes(PropDocument.parse(doc({
      format: 1,
      views: { front: { shapes: [{ f: 'wood', l: 1, c: 1, p: [-60, 0, 60, 0, 60, -90, -60, -90] }] } },
    })));
    expect(upgraded).toEqual([
      { path: [0], kind: 'poly', x: -60, y: -90, width: 120, height: 90, copy: [] },
    ]);
  });
});

describe('the whole catalogue contract', () => {
  it('renders in every palette without holes', () => {
    const def = build({
      params: [{ key: 'text', label: 'Text', type: 'text', default: 'HI' }],
      views: {
        default: {
          primitives: [
            { k: 'rect', f: 'wood', x: -40, y: -60, w: 80, h: 60 },
            { k: 'text', f: 'line', x: 0, y: -20, size: 12, value: '$text' },
          ],
        },
      },
    });
    for (const name of PALETTE_NAMES) {
      const svg = def.render(ctx({}, getPalette(name)));
      expect(svg, name).not.toContain('undefined');
      expect(svg, name).not.toContain('NaN');
      expect(svg.length, name).toBeGreaterThan(0);
    }
  });

  it('names every slot a palette defines, so a document can reach all of them', () => {
    expect(PALETTE_SLOTS).toContain('wood');
    expect(PALETTE_SLOTS).toContain('accentGlow');
    expect(new Set(PALETTE_SLOTS).size).toBe(PALETTE_SLOTS.length);
  });

  it('is a pure function of its params', () => {
    const def = build({
      params: [{ key: 'width', label: 'W', type: 'number', default: 100 }],
      views: { default: { primitives: [{ k: 'rect', f: 'wood', x: '-width / 2', y: -10, w: 'width', h: 10 }] } },
    });
    const first = def.render(ctx({ width: 220 }));
    for (let n = 0; n < 20; n++) expect(def.render(ctx({ width: 220 }))).toBe(first);
  });

  it('round-trips through JSON without changing what it draws', () => {
    const parsed = PropDocument.parse(doc({
      params: [{ key: 'n', label: 'N', type: 'number', default: 3 }],
      views: {
        default: {
          primitives: [{ k: 'repeat', n: 'n', dx: 20, of: [{ k: 'rect', f: 'wood', x: 0, y: -10, w: 10, h: 10 }] }],
        },
      },
    }));
    const again = PropDocument.parse(JSON.parse(JSON.stringify(parsed)));
    expect(propFromDocument(again).render(ctx())).toBe(propFromDocument(parsed).render(ctx()));
  });
});
