import { describe, it, expect } from 'vitest';
import { Look, LOOK_CHOICES, HAIR_STYLES, HEAD_SHAPES, EYE_STYLES } from '../src/schema/look.ts';
import { rollLook } from '../src/cast/look.ts';
import { buildPlaceholderRig, buildPlaceholderSvg, faceBox } from '../src/cast/placeholder.ts';
import { facePlates, bodyPlate } from '../src/cast/sheet.ts';
import { referenceWarnings, IDEAL_SECONDS } from '../src/voice/reference.ts';
import { lintSet, tidySet } from '../src/sets/index.ts';
import { SetDescriptor } from '../src/sets/schema.ts';

const NAMES = ['steve', 'brent', 'dolores', 'paul', 'janice', 'wanda', 'carl', 'doug', 'gary', 'delia'];

/** All the y values appearing in a chunk of SVG path/shape markup. */
function yValues(svg: string): number[] {
  const ys: number[] = [];
  for (const m of svg.matchAll(/[MLC] ?(-?[\d.]+)[ ,](-?[\d.]+)/g)) ys.push(Number(m[2]));
  for (const m of svg.matchAll(/\bcy="(-?[\d.]+)"/g)) ys.push(Number(m[1]));
  for (const m of svg.matchAll(/\by="(-?[\d.]+)"/g)) ys.push(Number(m[1]));
  return ys.filter(Number.isFinite);
}

function group(svg: string, id: string): string {
  const open = svg.indexOf(`<g id="${id}">`);
  if (open === -1) return '';
  const start = svg.indexOf('>', open) + 1;
  // These groups never nest, so the next closing tag is theirs.
  return svg.slice(start, svg.indexOf('</g>', start));
}

describe('rolling a look', () => {
  it('is stable for a given name', () => {
    expect(rollLook('steve')).toEqual(rollLook('steve'));
  });

  it('ignores case, so a script naming STEVE gets the same character', () => {
    expect(rollLook('STEVE')).toEqual(rollLook('steve'));
  });

  it('gives different names different faces', () => {
    const faces = new Set(NAMES.map((n) => JSON.stringify(rollLook(n))));
    expect(faces.size).toBe(NAMES.length);
  });

  it('spreads across the options rather than clustering on a few', () => {
    // 400 names, so this is about the generator's distribution, not luck.
    const names = Array.from({ length: 400 }, (_, i) => `person${i}q${(i * 7919) % 331}`);
    const seen = (pick: (l: Look) => string) => new Set(names.map((n) => pick(rollLook(n)))).size;

    expect(seen((l) => l.head)).toBe(HEAD_SHAPES.length);
    expect(seen((l) => l.hair)).toBe(HAIR_STYLES.length);
    expect(seen((l) => l.eyes)).toBe(EYE_STYLES.length);
  });

  it('only produces values the schema accepts', () => {
    for (const name of NAMES) {
      const look = rollLook(name);
      expect(() => Look.parse(look)).not.toThrow();
      for (const [key, options] of Object.entries(LOOK_CHOICES)) {
        expect(options).toContain(look[key as keyof Look]);
      }
    }
  });
});

describe('drawing from a look', () => {
  it('draws what the look says, not what the name says', () => {
    const a = buildPlaceholderSvg('steve', Look.parse({ ...rollLook('steve'), build: 'lanky' }));
    const b = buildPlaceholderSvg('steve', Look.parse({ ...rollLook('steve'), build: 'squat' }));
    expect(a).toContain('data-build="lanky"');
    expect(b).toContain('data-build="squat"');
    expect(a).not.toBe(b);
  });

  it('omits features the look turns off', () => {
    const base = rollLook('steve');
    const bare = Look.parse({ ...base, hair: 'bald', glasses: 'none', facialHair: 'none' });
    const svg = buildPlaceholderSvg('steve', bare);
    expect(group(svg, 'hair_front').trim()).toBe('');
    expect(group(svg, 'hair_back').trim()).toBe('');
  });

  it('is a pure function of the look', () => {
    const look = rollLook('wanda');
    expect(buildPlaceholderSvg('x', look)).toBe(buildPlaceholderSvg('x', look));
  });

  it('carries the look on the rig it produces', () => {
    const look = Look.parse({ ...rollLook('steve'), nose: 'beak' });
    expect(buildPlaceholderRig('steve', look).look?.nose).toBe('beak');
  });
});

/**
 * The bug this guards against silently flattened every face: brows drawn at the
 * same height as the hairline merge into the cap, so all ten expressions look
 * identical from any distance. Hair is clamped to stop above the brow line, and
 * that has to hold for every hairstyle on every head — including the low fringes,
 * which are the ones that broke it.
 */
describe('hair never eats the brows', () => {
  for (const hair of HAIR_STYLES) {
    it(`leaves a forehead with "${hair}" hair`, () => {
      for (const head of HEAD_SHAPES) {
        const look = Look.parse({ ...rollLook('steve'), hair, head });
        const svg = buildPlaceholderSvg('steve', look);

        // The cap only — a curl or sideburn reaching past the brow line at the
        // temple is hair behaving like hair. It is the fringe across the
        // forehead that has to stay clear.
        const cap = yValues(group(svg, 'hair_cap'));
        const brow = yValues(group(svg, 'brows_neutral'));
        expect(brow.length).toBeGreaterThan(0);

        if (!cap.length) continue;
        // Larger y is lower on the puppet: the brows must sit below the cap.
        expect(Math.min(...brow)).toBeGreaterThan(Math.max(...cap));
      }
    });
  }

  it('draws brows over the hair, not under it', () => {
    const svg = buildPlaceholderSvg('steve');
    expect(svg.indexOf('id="brows_neutral"')).toBeGreaterThan(svg.indexOf('id="hair_front"'));
  });

  it('gives brows enough contrast to read against skin', () => {
    // A blond character on tan skin is the case that fails: sandy hair and light
    // skin are nearly the same value, so the raw hair colour disappears.
    const look = Look.parse({ ...rollLook('steve'), hairColour: '#c4a86b', skin: '#f0d0a8', brows: 'thin' });
    const brows = group(buildPlaceholderSvg('steve', look), 'brows_neutral');
    const stroke = /stroke="(#[0-9a-f]{6})"/i.exec(brows)?.[1] ?? '';
    const value = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(value(look.skin) - value(stroke)).toBeGreaterThan(120);
  });
});

describe('face plates', () => {
  const loaded = { rig: buildPlaceholderRig('steve'), svg: buildPlaceholderSvg('steve') };

  it('produces one plate per expression', () => {
    expect(facePlates(loaded).map((p) => p.label)).toEqual(loaded.rig.expressions.map((e) => e.name));
  });

  it('shows one variant per slot and hides the others', () => {
    const angry = facePlates(loaded).find((p) => p.label === 'ANGRY')!.svg;
    // Every variant not chosen by the expression must be switched off, or the
    // plate draws nine mouths at once.
    expect(angry).toContain('<g id="eyes_squint">');
    expect(angry).toContain('<g id="eyes_open" style="display:none">');
    expect(angry).toContain('<g id="mouth_X" style="display:none">');
  });

  it('crops to the head', () => {
    const box = faceBox(loaded.rig);
    const plate = facePlates(loaded)[0]!.svg;
    expect(plate).toContain(`viewBox="${box.x.toFixed(1)} ${box.y.toFixed(1)}`);
    // Tall enough for a topknot, narrow enough not to be a full body shot.
    expect(box.h).toBeLessThan(loaded.rig.canvas.height * 0.75);
  });

  it('leaves the body plate at full height', () => {
    expect(bodyPlate(loaded).svg).toContain('viewBox="0 0 200 400"');
  });
});

describe('reference clip advice', () => {
  it('says nothing about a clip of a sensible length', () => {
    expect(referenceWarnings((IDEAL_SECONDS.min + 2) * 1000)).toEqual([]);
  });

  it('warns that a very short clip will read flat', () => {
    expect(referenceWarnings(1500)[0]).toMatch(/1\.5s/);
  });

  it('warns that a very long clip is wasted effort', () => {
    expect(referenceWarnings(IDEAL_SECONDS.max * 2000 + 5000)[0]).toMatch(/longer than needed/);
  });
});

/**
 * The correction text is load-bearing. Told only that furniture belongs in
 * "mid", the model deleted the furniture — which satisfies the complaint and
 * ruins the set. Fixes have to name the props and forbid removal.
 */
describe('set lint corrections', () => {
  const crowded = SetDescriptor.parse({
    name: 'test',
    palette: 'office-fluorescent',
    layout: { horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 },
    layers: {
      back: [{ prop: 'wall-panel' }, { prop: 'floor' }],
      mid: [{ prop: 'desk', x: 200 }],
      fore: [
        { prop: 'chair', x: 400 },
        { prop: 'filing-cabinet', x: 500 },
        { prop: 'water-cooler', x: 600 },
      ],
    },
  });

  it('names the props to move rather than describing the rule', () => {
    const note = lintSet(crowded).find((n) => /fore/.test(n.message))!;
    expect(note.fix).toContain('chair');
    expect(note.fix).toContain('filing-cabinet');
  });

  it('tells the model explicitly not to delete anything', () => {
    for (const note of lintSet(crowded)) {
      expect(note.fix.toLowerCase()).toMatch(/do not delete|keep (the prop|every prop)/);
    }
  });

  it('separates what is wrong from what to do about it', () => {
    for (const note of lintSet(crowded)) {
      expect(note.message).not.toBe(note.fix);
      expect(note.message.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The repair pass exists because the linter can only complain, and a model asked
 * to fix its own layout mostly rearranges which rule it breaks. These are the
 * problems that have exactly one right answer.
 */
describe('tidying a set', () => {
  const messy = SetDescriptor.parse({
    name: 'messy',
    palette: 'office-fluorescent',
    layout: { horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 },
    layers: {
      back: [{ prop: 'room-wall', x: 440, y: 698 }, { prop: 'room-floor' }],
      mid: [{ prop: 'desk', x: 600 }],
      fore: [
        { prop: 'chair', x: 610 },
        { prop: 'filing-cabinet', x: 700 },
        { prop: 'water-cooler', x: 500 },
      ],
    },
  });

  it('keeps every prop', () => {
    const count = (s: typeof messy) => s.layers.back.length + s.layers.mid.length + s.layers.fore.length;
    expect(count(tidySet(messy))).toBe(count(messy));
  });

  it('moves furniture out of the layer that draws over faces', () => {
    const after = tidySet(messy);
    expect(after.layers.fore.map((i) => i.prop)).not.toContain('chair');
    expect(after.layers.mid.map((i) => i.prop)).toContain('chair');
  });

  it('strips positions from props that place themselves', () => {
    const wall = tidySet(messy).layers.back.find((i) => i.prop === 'room-wall')!;
    expect(wall.x).toBeUndefined();
    expect(wall.y).toBeUndefined();
  });

  it('clears the middle of frame for the characters', () => {
    const after = tidySet(messy);
    const centre = [...after.layers.back, ...after.layers.mid, ...after.layers.fore]
      .filter((i) => i.x !== undefined && i.x > 380 && i.x < 900);
    expect(centre.length).toBeLessThanOrEqual(2);
  });

  it('is idempotent, so tidying twice changes nothing', () => {
    const once = tidySet(messy);
    expect(tidySet(once)).toEqual(once);
  });

  it('silences the composition notes it is meant to answer', () => {
    const notes = lintSet(tidySet(messy)).map((n) => n.message);
    expect(notes.filter((m) => /fore|buried|floats|instance "y"/.test(m))).toEqual([]);
  });
});
