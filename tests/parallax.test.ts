import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { baseFrame, applyMove, type ActorFrameInfo } from '../src/render/framing.ts';
import { portraitCamera, PORTRAIT_MASTER } from '../src/pipeline/reframe.ts';
import { SHOTS, CAMERA_MOVES } from '../src/schema/script.ts';
import { geometryFor, STAGE } from '../src/sets/schema.ts';
import { layerParallaxOffset } from '../ui/src/editor/stage/coords.ts';
import type { IRCamera, IRFrame, IRActor } from '../src/schema/ir.ts';

/**
 * The parallax module is loaded and evaluated exactly as the browser gets it.
 *
 * It is injected into the render page as a classic script, so importing a
 * TypeScript copy of the same maths would test a second implementation that
 * could drift from the one that actually renders. This runs the real bytes.
 */
function loadParallax(): (
  cam: IRCamera,
  k: { x: number; y: number },
  bounds: { x0: number; y0: number; width: number; height: number },
  neutral: { x: number; y: number },
) => [number, number] {
  const src = fs.readFileSync(new URL('../src/render/parallax.js', import.meta.url), 'utf8');
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fn = sandbox['__parallaxOffset'];
  if (typeof fn !== 'function') throw new Error('parallax.js did not define __parallaxOffset');
  return fn as ReturnType<typeof loadParallax>;
}

const parallaxOffset = loadParallax();

const GEO = geometryFor({ marginX: 420, marginY: 220, horizonY: 566, ceilingY: 92 });
const BOUNDS = { x0: GEO.x0, y0: GEO.y0, width: GEO.width, height: GEO.height };
const NEUTRAL = { x: STAGE.width / 2, y: STAGE.height / 2 };

function actor(id: string, x: number, headY = 300, headR = 60): ActorFrameInfo {
  return { id, x, y: 698, scale: 1.25, headX: x, headY, headR };
}

/** Covers ordinary staging plus the offstage extremes the margin exists for. */
const ARRANGEMENTS: Array<{ label: string; actors: ActorFrameInfo[] }> = [
  { label: 'centred single', actors: [actor('a', 640)] },
  { label: 'stage-left single', actors: [actor('a', 200)] },
  { label: 'stage-right single', actors: [actor('a', 1080)] },
  { label: 'offstage-left single', actors: [actor('a', -170)] },
  { label: 'offstage-right single', actors: [actor('a', 1450)] },
  { label: 'wide two-shot', actors: [actor('a', 200), actor('b', 1080)] },
  { label: 'offstage two-shot', actors: [actor('a', -170), actor('b', 1450)] },
  { label: 'large head close', actors: [actor('a', 1450, 260, 130)] },
];

const PROGRESS = [0, 0.25, 0.5, 0.75, 1];
const SHAKE_FRAMES = [0, 7, 13, 41];

/** Every camera the engine can produce for a landscape master. */
function landscapeCameras(): IRCamera[] {
  const out: IRCamera[] = [];
  for (const shot of SHOTS) {
    for (const { actors } of ARRANGEMENTS) {
      for (const focus of [[] as string[], [actors[0]!.id]]) {
        const base = baseFrame(shot, focus, actors, STAGE);
        for (const move of CAMERA_MOVES) {
          for (const t of PROGRESS) {
            for (const frame of SHAKE_FRAMES) {
              out.push(applyMove(base, move, t, frame, STAGE));
            }
          }
        }
      }
    }
  }
  return out;
}

function irActor(x: number): IRActor {
  return { visible: true, x, y: 698, scale: 1.25, flip: false, parts: {}, swaps: {} };
}

/** The portrait pass recomposes every landscape frame, so it needs covering too. */
function portraitCameras(): IRCamera[] {
  const meta = { width: STAGE.width, height: STAGE.height } as IRFrame extends never ? never
    : { width: number; height: number };
  return landscapeCameras().map((camera, i) => {
    const frame: IRFrame = {
      camera,
      actors: { a: irActor(ARRANGEMENTS[i % ARRANGEMENTS.length]!.actors[0]!.x) },
    };
    return portraitCamera(frame, meta as never, PORTRAIT_MASTER);
  });
}

/** Does the layer, shifted by `d`, still cover everything the camera sees? */
function covers(cam: IRCamera, d: [number, number]): boolean {
  return (
    BOUNDS.x0 + d[0] <= cam.x + 1e-6 &&
    BOUNDS.x0 + BOUNDS.width + d[0] >= cam.x + cam.w - 1e-6 &&
    BOUNDS.y0 + d[1] <= cam.y + 1e-6 &&
    BOUNDS.y0 + BOUNDS.height + d[1] >= cam.y + cam.h - 1e-6
  );
}

/** The offset before clamping — what the layer would do with unlimited artwork. */
function rawOffset(cam: IRCamera, k: { x: number; y: number }): [number, number] {
  const round = (v: number) => {
    const r = Math.round(v * 100) / 100;
    return r === 0 ? 0 : r;
  };
  return [
    round((cam.x + cam.w / 2 - NEUTRAL.x) * (1 - k.x)),
    round((cam.y + cam.h / 2 - NEUTRAL.y) * (1 - k.y)),
  ];
}

describe('parallax offsets', () => {
  it('is exactly zero for a layer that tracks the camera', () => {
    // The backward-compatibility invariant: every set that predates parallax
    // has to render byte-identically, and that rests entirely on this.
    for (const cam of landscapeCameras()) {
      expect(parallaxOffset(cam, { x: 1, y: 1 }, BOUNDS, NEUTRAL)).toEqual([0, 0]);
    }
  });

  it('is zero at the neutral frame regardless of depth', () => {
    // WIDE returns exactly the stage rect, so a wide shot is the rest position
    // no matter how the layers are tuned.
    const wide = baseFrame('WIDE', [], [actor('a', 200)], STAGE);
    expect(wide).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    for (const k of [{ x: 0.5, y: 0.5 }, { x: 0.85, y: 1 }, { x: 1.15, y: 1.3 }]) {
      expect(parallaxOffset(wide, k, BOUNDS, NEUTRAL)).toEqual([0, 0]);
    }
  });

  it('does not drift sideways during a centred push', () => {
    // The regression this exists for: a push shrinks the viewBox about its
    // middle, so cam.x climbs while nothing actually moves. Measuring from the
    // origin instead of the centre turns that into a visible background slide.
    const base = baseFrame('WIDE', [], [actor('a', 640)], STAGE);
    for (const move of ['PUSH_IN', 'PULL_OUT', 'SNAP_IN'] as const) {
      for (const t of PROGRESS) {
        const cam = applyMove(base, move, t, 0, STAGE);
        expect(cam.x).toBe((STAGE.width - cam.w) / 2);
        expect(parallaxOffset(cam, { x: 0.85, y: 1 }, BOUNDS, NEUTRAL)).toEqual([0, 0]);
      }
    }
  });

  it('lags a distant layer behind the camera', () => {
    const cam: IRCamera = { x: 940, y: 200, w: 300, h: 169 };
    // Centre is 1090, i.e. 450 right of neutral; a 0.85 layer gives back 15%.
    expect(parallaxOffset(cam, { x: 0.85, y: 1 }, BOUNDS, NEUTRAL)).toEqual([67.5, 0]);
    // ...and a leading layer overshoots in the same direction.
    expect(parallaxOffset(cam, { x: 1.15, y: 1 }, BOUNDS, NEUTRAL)).toEqual([-67.5, 0]);
  });

  it('never exposes an edge the camera had not already reached', () => {
    const factors = [
      { x: 0.7, y: 1 },
      { x: 0.85, y: 1 },
      { x: 0.85, y: 0.9 },
      { x: 1, y: 1 },
      { x: 1.15, y: 1 },
      { x: 1.3, y: 1.1 },
    ];
    for (const cam of [...landscapeCameras(), ...portraitCameras()]) {
      // Only meaningful where the camera is inside the set to begin with; the
      // engine never produces one that isn't.
      if (!covers(cam, [0, 0])) continue;
      for (const k of factors) {
        const d = parallaxOffset(cam, k, BOUNDS, NEUTRAL);
        expect(covers(cam, d), `${JSON.stringify({ cam, k, d })}`).toBe(true);
      }
    }
  });

  it('gives a 0.85 back layer its full travel everywhere the engine can point', () => {
    // This is the margin argument, made executable. marginX 420 is claimed to
    // cover a back layer lagging at 0.85 across every shot, every move and the
    // portrait recompose — so the clamp should never actually engage. If a
    // future shot type or a wider margin change breaks that, this fails rather
    // than the background silently stopping mid-shot.
    const k = { x: 0.85, y: 1 };
    for (const cam of [...landscapeCameras(), ...portraitCameras()]) {
      if (!covers(cam, [0, 0])) continue;
      expect(parallaxOffset(cam, k, BOUNDS, NEUTRAL), JSON.stringify(cam))
        .toEqual(rawOffset(cam, k));
    }
  });

  it('would clip a 1.15 fore layer, which is why fore defaults to 1', () => {
    // A leading layer reaches its own edge sooner than a lagging one. The clamp
    // keeps it safe, but a foreground that quietly stops tracking during the
    // tightest shot is worse than one that never started — so this documents
    // the reason for the default rather than leaving it as a comment.
    const k = { x: 1.15, y: 1 };
    const clipped = [...landscapeCameras(), ...portraitCameras()].filter(
      (cam) => covers(cam, [0, 0]) &&
        parallaxOffset(cam, k, BOUNDS, NEUTRAL)[0] !== rawOffset(cam, k)[0],
    );
    expect(clipped.length).toBeGreaterThan(0);
  });

  it('gives up rather than guessing when the camera is wider than the set', () => {
    const huge: IRCamera = { x: -600, y: -400, w: 3000, h: 1688 };
    expect(covers(huge, [0, 0])).toBe(false);
    expect(parallaxOffset(huge, { x: 0.5, y: 0.5 }, BOUNDS, NEUTRAL)).toEqual([0, 0]);
  });

  it('reads the applied layer offset back for the editor overlay', () => {
    // The overlay must put its handles on the art, so it reads the transform the
    // renderer actually wrote rather than recomputing the depth maths.
    const doc = {
      getElementById(id: string) {
        if (id === 'set-back') return { getAttribute: () => 'translate(67.5,0)' };
        if (id === 'set-mid') return { getAttribute: () => null };
        if (id === 'set-fore') return { getAttribute: () => 'scale(2)' };
        return null;
      },
    } as unknown as Document;

    expect(layerParallaxOffset(doc, 'back')).toEqual([67.5, 0]);
    // No transform is the common case: a layer at 1 carries no attribute.
    expect(layerParallaxOffset(doc, 'mid')).toEqual([0, 0]);
    // Anything that is not a plain translate is not ours to interpret.
    expect(layerParallaxOffset(doc, 'fore')).toEqual([0, 0]);
    expect(layerParallaxOffset(doc, 'nope')).toEqual([0, 0]);
    expect(layerParallaxOffset(null, 'back')).toEqual([0, 0]);
  });

  it('agrees with what the runtime would have written', () => {
    const cam: IRCamera = { x: 940, y: 200, w: 300, h: 169 };
    const [dx, dy] = parallaxOffset(cam, { x: 0.85, y: 1 }, BOUNDS, NEUTRAL);
    const doc = {
      getElementById: () => ({ getAttribute: () => `translate(${dx},${dy})` }),
    } as unknown as Document;
    expect(layerParallaxOffset(doc, 'back')).toEqual([dx, dy]);
  });

  it('rounds so the attribute is stable frame to frame', () => {
    const cam: IRCamera = { x: 811.3333, y: 100, w: 300, h: 169 };
    const [dx, dy] = parallaxOffset(cam, { x: 0.93, y: 1 }, BOUNDS, NEUTRAL);
    expect(dx).toBe(Math.round(dx * 100) / 100);
    expect(dy).toBe(0);
  });
});
