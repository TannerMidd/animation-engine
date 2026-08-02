import { describe, it, expect } from 'vitest';
import { CLEAN, activeStyle } from '../src/style/index.ts';
import { wobbleShape, amplitudeFor, rectPoints, ellipsePoints, drawShape } from '../src/style/wobble.ts';
import { buildPlaceholderSvg } from '../src/cast/placeholder.ts';

// The default identity's treatment — the house marker look, now profile-owned.
const marker = activeStyle();
const clean = CLEAN;

/**
 * The wobble must be a pure function of geometry.
 *
 * If it varied per call, per frame, or per render, lines would boil between
 * frames and the determinism test would be meaningless — so these pin the
 * property directly rather than relying on the render test to notice.
 */
describe('wobble determinism', () => {
  const square = rectPoints(0, 0, 100, 100);

  it('produces identical output for identical geometry', () => {
    expect(wobbleShape(square, marker)).toBe(wobbleShape(square, marker));
  });

  it('produces identical output across many repeats', () => {
    const first = wobbleShape(square, marker);
    for (let i = 0; i < 25; i++) expect(wobbleShape(square, marker)).toBe(first);
  });

  it('gives a shape at a different position its own wobble', () => {
    expect(wobbleShape(rectPoints(0, 0, 100, 100), marker))
      .not.toBe(wobbleShape(rectPoints(400, 0, 100, 100), marker));
  });

  it('is disabled entirely by the clean style', () => {
    expect(amplitudeFor(square, clean)).toBe(0);
  });
});

describe('wobble scales with the shape', () => {
  it('gives a large shape more displacement than a small one', () => {
    // A flat amplitude waves a wall pleasantly and shreds a hand.
    const wall = amplitudeFor(rectPoints(0, 0, 900, 500), marker);
    const hand = amplitudeFor(ellipsePoints(0, 0, 8, 8, 10), marker);
    expect(wall).toBeGreaterThan(hand);
  });

  it('never exceeds the style budget', () => {
    const huge = amplitudeFor(rectPoints(0, 0, 4000, 4000), marker);
    expect(huge).toBeLessThanOrEqual(marker.wobble);
  });

  it('never collapses to nothing on a tiny shape', () => {
    const tiny = amplitudeFor(ellipsePoints(0, 0, 2, 2, 8), marker);
    expect(tiny).toBeGreaterThan(0);
  });
});

describe('drawShape', () => {
  it('emits fill and outline as separate paths so the fill can misregister', () => {
    const svg = drawShape(rectPoints(0, 0, 200, 100), marker, '#abc', '#000');
    expect(svg.match(/<path/g)?.length).toBe(2);
    expect(svg).toContain('translate(');
  });

  it('omits the fill path when there is no fill', () => {
    const svg = drawShape(rectPoints(0, 0, 200, 100), marker, null, '#000');
    expect(svg.match(/<path/g)?.length).toBe(1);
  });

  it('never emits NaN into a path', () => {
    for (const pts of [rectPoints(0, 0, 1, 1), ellipsePoints(0, 0, 0.5, 0.5, 8), rectPoints(-500, -500, 9000, 20)]) {
      expect(drawShape(pts, marker, '#fff', '#000')).not.toContain('NaN');
    }
  });
});

describe('puppets carry the style', () => {
  it('draws with paths rather than raw primitives', () => {
    // Primitives cannot wobble; if these come back the puppet has bypassed the
    // style system and will look ruler-straight against a hand-drawn set.
    const svg = buildPlaceholderSvg('steve');
    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<rect[^>]*id="torso"/);
  });

  it('records which body archetype was rolled', () => {
    expect(buildPlaceholderSvg('steve')).toMatch(/data-build="(squat|lanky|boxy|round|pear)"/);
  });

  it('gives different names different builds', () => {
    const build = (n: string) => /data-build="(\w+)"/.exec(buildPlaceholderSvg(n))?.[1];
    const builds = new Set(['steve', 'brent', 'paul', 'doug', 'janice', 'wanda', 'phil', 'marge'].map(build));
    // A cast that all rolls the same build reads as one puppet recoloured.
    expect(builds.size).toBeGreaterThan(2);
  });

  it('stays stable for a given name', () => {
    expect(buildPlaceholderSvg('steve')).toBe(buildPlaceholderSvg('steve'));
  });
});

describe('style ownership', () => {
  it('takes the treatment from the active identity profile', () => {
    expect(activeStyle().name).toBe('house');
    expect(activeStyle().wobble).toBeGreaterThan(0);
  });

  it('keeps the clean baseline available for diffing', () => {
    expect(CLEAN.wobble).toBe(0);
    expect(CLEAN.grain).toBe(0);
  });
});
