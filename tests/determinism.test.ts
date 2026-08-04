import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { compileScene } from '../src/compile/index.ts';
import { renderFrames } from '../src/render/capture.ts';
import { SetDescriptor } from '../src/sets/schema.ts';
import { saveSet, setPath } from '../src/sets/index.ts';
import { testRigs, testPlan, tempDir, hashFrames, sha1 } from './helpers.ts';

/**
 * The load-bearing test.
 *
 * Determinism is what makes every other guarantee in the pipeline hold: it lets
 * us screenshot frames out of order, skip identical ones, resume a crashed
 * render, split work across cores, and trust that re-rendering a scene you did
 * not change gives back what you had. If this test fails, none of that is safe.
 */

/** Written into sets/ because renderFrames resolves a scene's set by name. */
const PARALLAX_FIXTURE = '_parallax-fixture';

const dirs: string[] = [];
const fixtures: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  for (const f of fixtures) await fs.rm(f, { force: true });
});

describe('compile', () => {
  it('produces identical IR for identical input', () => {
    const rigs = testRigs(['steve', 'dolores']);
    const plan = testPlan(['steve', 'dolores'], { durationSec: 4 });
    expect(sha1(JSON.stringify(compileScene(plan, rigs)))).toBe(
      sha1(JSON.stringify(compileScene(plan, rigs))),
    );
  });

  it('changes output when the seed changes', () => {
    const rigs = testRigs(['steve']);
    const a = compileScene(testPlan(['steve'], { durationSec: 8, seed: 1 }), rigs);
    const b = compileScene(testPlan(['steve'], { durationSec: 8, seed: 2 }), rigs);
    expect(sha1(JSON.stringify(a))).not.toBe(sha1(JSON.stringify(b)));
  });

  it('keeps each actor on an independent RNG stream', () => {
    // Adding a character must not disturb the blinks of one already staged,
    // or every edit to a scene silently reanimates everyone else in it.
    const rigs = testRigs(['steve', 'dolores']);
    const solo = compileScene(testPlan(['steve'], { durationSec: 8 }), rigs);
    const duo = compileScene(testPlan(['steve', 'dolores'], { durationSec: 8 }), rigs);

    const eyesOf = (ir: typeof solo) => ir.frames.map((f) => f.actors['steve']!.swaps['eyes']);
    expect(eyesOf(duo)).toEqual(eyesOf(solo));
  });

  it('holds character frames on the character frame rate', () => {
    const rigs = testRigs(['steve']);
    const ir = compileScene(testPlan(['steve'], { durationSec: 2, fps: 24, characterFps: 12 }), rigs);
    // At 12fps characters in a 24fps render, frames pair up exactly.
    for (let i = 0; i < ir.frames.length; i += 2) {
      expect(JSON.stringify(ir.frames[i]!.actors)).toBe(JSON.stringify(ir.frames[i + 1]!.actors));
    }
  });

  it('rejects a character frame rate that does not divide the render rate', () => {
    const rigs = testRigs(['steve']);
    expect(() => compileScene(testPlan(['steve'], { fps: 24, characterFps: 10 }), rigs)).toThrow(/divide/);
  });
});

describe('render', () => {
  it('produces byte-identical frames across two runs', { timeout: 180_000 }, async () => {
    const rigs = testRigs(['steve', 'dolores']);
    const plan = testPlan(['steve', 'dolores'], { durationSec: 1 });
    const ir = compileScene(plan, rigs);

    const a = await tempDir('det-a');
    const b = await tempDir('det-b');
    dirs.push(a, b);

    const ra = await renderFrames({ ir, rigs, dir: a });
    const rb = await renderFrames({ ir, rigs, dir: b });

    expect(ra.total).toBe(24);
    expect(await hashFrames(ra.framesDir)).toEqual(await hashFrames(rb.framesDir));
  });

  it('stays byte-identical with a parallaxed set', { timeout: 180_000 }, async () => {
    // Parallax puts a camera-derived transform on the DOM every frame, which is
    // exactly the kind of thing that can drift. It is a pure function of the
    // frame's own camera, so two runs must still agree byte for byte.
    const set = SetDescriptor.parse({
      name: PARALLAX_FIXTURE,
      layout: { parallax: { back: { x: 0.82, y: 1 }, mid: { x: 0.94, y: 1 } } },
      layers: {
        back: [{ prop: 'room-wall' }, { prop: 'room-floor', parallax: { x: 1, y: 1 } }],
        mid: [{ prop: 'desk', x: 420 }, { prop: 'chair', x: 760 }],
      },
    });
    await saveSet(set);
    fixtures.push(setPath(PARALLAX_FIXTURE));

    const rigs = testRigs(['steve']);
    // Deliberately off the neutral frame — at WIDE the offsets are all zero and
    // this would prove nothing.
    const ir = compileScene(
      testPlan(['steve'], { durationSec: 1, set: PARALLAX_FIXTURE, camera: { x: 300, y: 120, w: 640, h: 360 } }),
      rigs,
    );

    const a = await tempDir('det-px-a');
    const b = await tempDir('det-px-b');
    dirs.push(a, b);

    const ra = await renderFrames({ ir, rigs, dir: a });
    const rb = await renderFrames({ ir, rigs, dir: b });

    const page = await fs.readFile(ra.pagePath, 'utf8');
    expect(page).toContain('data-px="0.82"');
    expect(page).toContain('__parallaxOffset');
    expect(await hashFrames(ra.framesDir)).toEqual(await hashFrames(rb.framesDir));
    expect(ra.captured).toBeLessThan(ra.total);
  });

  it('materialises every frame, including held ones', { timeout: 180_000 }, async () => {
    const rigs = testRigs(['steve']);
    const ir = compileScene(testPlan(['steve'], { durationSec: 1 }), rigs);
    const dir = await tempDir('det-c');
    dirs.push(dir);

    const res = await renderFrames({ ir, rigs, dir });
    const files = (await fs.readdir(res.framesDir)).filter((f) => f.endsWith('.png'));

    // Dedup must never leave gaps in the sequence — ffmpeg reads it as %06d.
    expect(files.length).toBe(res.total);
    expect(res.captured).toBeLessThan(res.total);
  });
});
