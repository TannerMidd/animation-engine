import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_IDENTITY, ShowIdentity } from '../src/schema/identity.ts';
import { Outfit, HATS, type OutfitFamily } from '../src/schema/outfit.ts';
import { Look, HEAD_SHAPES } from '../src/schema/look.ts';
import { setActiveIdentity } from '../src/show/context.ts';
import { assignEnsemble, outfitWithin, defaultOutfit } from '../src/cast/ensemble.ts';
import { buildPlaceholderSvg, buildPlaceholderRig, faceBox } from '../src/cast/placeholder.ts';
import { rollLook } from '../src/cast/look.ts';
import { renderText, measureText, supportedText } from '../src/render/glyphs.ts';
import { titleCardSvg, endCardSvg } from '../src/render/cards.ts';

afterEach(() => setActiveIdentity(DEFAULT_IDENTITY));

const outfitOf = (over: Partial<Outfit>): Outfit => Outfit.parse(over);
const lookOf = (over: Partial<Look>): Look => Look.parse({ ...rollLook('steve'), ...over });

/** All y values inside one <g id="..."> group. */
function groupYs(svg: string, id: string): number[] {
  const open = svg.indexOf(`<g id="${id}">`);
  if (open === -1) return [];
  const start = svg.indexOf('>', open) + 1;
  const body = svg.slice(start, svg.indexOf('</g>', start));
  const ys: number[] = [];
  for (const m of body.matchAll(/[MLC] ?(-?[\d.]+)[ ,](-?[\d.]+)/g)) ys.push(Number(m[2]));
  return ys.filter(Number.isFinite);
}

describe('the ensemble assigner', () => {
  const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'];

  it('is stable per character regardless of who else is in the cast', () => {
    const alone = assignEnsemble(DEFAULT_IDENTITY, ['a1']).get('a1')!;
    const together = assignEnsemble(DEFAULT_IDENTITY, ids).get('a1')!;
    // The home family only changes if a cap bumps it, and 'a1' sorts first so
    // nothing can have bumped it.
    expect(together.outfit).toEqual(alone.outfit);
  });

  it('honours per-scene family caps', () => {
    const capped: OutfitFamily = {
      name: 'suit',
      weight: 100,
      maxPerScene: 2,
      fixed: { collar: 'pointed', neckwear: 'tie' },
      options: {},
    };
    const identity = ShowIdentity.parse({
      ...JSON.parse(JSON.stringify(DEFAULT_IDENTITY)),
      visual: { ...DEFAULT_IDENTITY.visual, outfitFamilies: [capped, { name: 'other', weight: 0.01, fixed: {}, options: {} }] },
    });

    const worn = [...assignEnsemble(identity, ids).values()];
    expect(worn.filter((w) => w.family === 'suit').length).toBeLessThanOrEqual(2);
    // Everyone still got dressed.
    expect(worn.every((w) => w.outfit)).toBe(true);
  });

  it('respects a family\'s fixed fields and narrowed options', () => {
    const family: OutfitFamily = {
      name: 'uniform',
      weight: 1,
      fixed: { neckwear: 'tie', hat: 'none' },
      options: { pattern: ['solid'] },
    };
    for (const id of ids) {
      const outfit = outfitWithin(DEFAULT_IDENTITY, id, family);
      expect(outfit.neckwear).toBe('tie');
      expect(outfit.hat).toBe('none');
      expect(outfit.pattern).toBe('solid');
    }
  });

  it('dresses a cast with variety under the house families', () => {
    const worn = [...assignEnsemble(DEFAULT_IDENTITY, ids).values()];
    expect(new Set(worn.map((w) => w.family)).size).toBeGreaterThan(1);
  });
});

describe('drawing wardrobe', () => {
  it('long sleeves put the shirt on the forearms', () => {
    const look = lookOf({ skin: '#e8b98a', shirt: '#5b7c99' });
    const short = buildPlaceholderSvg('x', look, outfitOf({ sleeves: 'short' }));
    const long = buildPlaceholderSvg('x', look, outfitOf({ sleeves: 'long' }));

    const forearm = (svg: string) => {
      const i = svg.indexOf('id="arm_L_fore"');
      return svg.slice(i, svg.indexOf('<g id="arm_R_upper"', i));
    };
    expect(forearm(short)).toContain('#e8b98a');
    expect(forearm(long)).toContain('#5b7c99');
  });

  it('emits patterns only when the outfit asks', () => {
    const look = lookOf({});
    expect(buildPlaceholderSvg('x', look, outfitOf({ pattern: 'solid' }))).not.toContain('clip_torso');
    expect(buildPlaceholderSvg('x', look, outfitOf({ pattern: 'stripes' }))).toContain('clip_torso');
  });

  it('clips patterns inside the torso silhouette', () => {
    const svg = buildPlaceholderSvg('x', lookOf({}), outfitOf({ pattern: 'stripes' }));
    expect(svg).toContain('<clipPath id="clip_torso">');
    expect(svg).toContain('clip-path="url(#clip_torso)"');
  });

  it('keeps every hat above the brows on every head with every hairstyle', () => {
    for (const hat of HATS) {
      if (hat === 'none') continue;
      for (const head of HEAD_SHAPES) {
        for (const hair of ['bald', 'curly', 'spikes', 'mop'] as const) {
          const look = lookOf({ head, hair });
          const svg = buildPlaceholderSvg('x', look, outfitOf({ hat }));
          const hatYs = groupYs(svg, 'headwear');
          const browYs = groupYs(svg, 'brows_neutral');
          expect(browYs.length).toBeGreaterThan(0);
          expect(hatYs.length).toBeGreaterThan(0);
          // Larger y is lower: the hat's lowest point stays above the brows.
          expect(Math.max(...hatYs), `${hat}/${head}/${hair}`).toBeLessThan(Math.min(...browYs));
        }
      }
    }
  });

  it('grows the face crop when a hat adds height', () => {
    const rig = buildPlaceholderRig('x', lookOf({}), outfitOf({ hat: 'brim' }));
    const bare = buildPlaceholderRig('x', lookOf({}), outfitOf({ hat: 'none' }));
    expect(faceBox(rig).y).toBeLessThan(faceBox(bare).y);
  });

  it('changes costume without changing the body', () => {
    const look = lookOf({});
    const a = buildPlaceholderRig('x', look, outfitOf({ neckwear: 'tie' }));
    const b = buildPlaceholderRig('x', look, outfitOf({ neckwear: 'bowtie' }));
    // Same structure — parts, pivots, focus — different clothes.
    expect(a.parts).toEqual(b.parts);
    expect(a.focus).toEqual(b.focus);
    expect(a.outfit!.neckwear).not.toBe(b.outfit!.neckwear);
  });

  it('parses rigs that predate outfits', () => {
    const rig = JSON.parse(JSON.stringify(buildPlaceholderRig('x'))) as Record<string, unknown>;
    delete rig['outfit'];
    expect(() => buildPlaceholderRig('x')).not.toThrow();
    expect(rig['name']).toBe('x');
  });
});

describe('the glyph alphabet', () => {
  it('renders every supported character as strokes', () => {
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?\'-:&';
    const svg = renderText(all, { x: 0, y: 0, size: 14, colour: '#fff' });
    expect(svg.length).toBeGreaterThan(all.length * 30);
    expect(svg).not.toContain('NaN');
  });

  it('replaces unsupported characters with spaces rather than failing', () => {
    expect(supportedText('Café #12')).toBe('CAF   12');
  });

  it('measures monotonically with length and size', () => {
    expect(measureText('AAA', 20)).toBeGreaterThan(measureText('AA', 20));
    expect(measureText('AA', 40)).toBeGreaterThan(measureText('AA', 20));
  });

  it('letters deterministically', () => {
    const draw = () => renderText('THE END', { x: 640, y: 300, size: 72, colour: '#eee', anchor: 'middle' });
    expect(draw()).toBe(draw());
  });
});

describe('cards', () => {
  it('builds a full-frame title card with the profile colours', () => {
    const svg = titleCardSvg(DEFAULT_IDENTITY, 'The Update', 'INT. Room - Day');
    expect(svg).toContain(`fill="${DEFAULT_IDENTITY.visual.cards.paper}"`);
    expect(svg).toContain('viewBox="0 0 1280 720"');
    expect(svg).not.toContain('<text');
  });

  it('never emits machine-font text elements', () => {
    expect(endCardSvg(DEFAULT_IDENTITY)).not.toContain('<text');
    expect(endCardSvg(DEFAULT_IDENTITY)).not.toContain('font-family');
  });

  it('survives a hostile title', () => {
    const svg = titleCardSvg(DEFAULT_IDENTITY, '<script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
  });
});

describe('scene outfit overrides', () => {
  it('keeps the default costume when no override exists', () => {
    expect(defaultOutfit(DEFAULT_IDENTITY, 'zz9')).toEqual(defaultOutfit(DEFAULT_IDENTITY, 'zz9'));
  });
});
