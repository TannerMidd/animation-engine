import { describe, expect, it } from 'vitest';
import { portraitCamera, reframeScenePortrait } from '../src/pipeline/reframe.ts';
import type { IRActor, IRFrame, SceneIR } from '../src/schema/ir.ts';

const actor = (x: number, visible = true): IRActor => ({
  visible,
  x,
  y: 700,
  scale: 1,
  flip: false,
  parts: {},
  swaps: {},
});

const scene = (actors: Record<string, IRActor>, camera = { x: 0, y: 0, w: 1280, h: 720 }): SceneIR => ({
  meta: { scene: 'portrait', fps: 24, width: 1280, height: 720, seed: 7, audio: null, set: null },
  cast: Object.keys(actors).map((id) => ({ id, rig: id })),
  frames: [{ camera, actors }],
});

describe('actor-aware portrait reframing', () => {
  it('follows an off-centre focal actor instead of centre-cropping the stage', () => {
    const input = scene({ alice: actor(230) });
    const camera = portraitCamera(input.frames[0]!, input.meta);
    expect(camera.x + camera.w / 2).toBeLessThan(400);
    expect(camera.w / camera.h).toBeCloseTo(720 / 1280, 8);
  });

  it('widens a portrait relationship shot enough to retain both actors', () => {
    const input = scene({ alice: actor(300), bob: actor(980) });
    const camera = portraitCamera(input.frames[0]!, input.meta);
    expect(camera.x).toBeLessThan(300);
    expect(camera.x + camera.w).toBeGreaterThan(980);
  });

  it('keeps the approved camera centre when no actor is visible', () => {
    const frame: IRFrame = scene({ alice: actor(230, false) }, { x: 200, y: 100, w: 600, h: 337.5 }).frames[0]!;
    const camera = portraitCamera(frame, { scene: 'x', fps: 24, width: 1280, height: 720, seed: 1, audio: null, set: null });
    expect(camera.x + camera.w / 2).toBeCloseTo(500, 8);
    expect(camera.y + camera.h / 2).toBeCloseTo(268.75, 8);
  });

  it('creates deterministic portrait IR with native dimensions and cards', () => {
    const input = scene({ alice: actor(640) });
    const cards = { titleSvg: '<svg id="portrait-title"/>', endSvg: '<svg id="portrait-end"/>' };
    const first = reframeScenePortrait(input, { cards });
    const second = reframeScenePortrait(input, { cards });
    expect(first).toEqual(second);
    expect(first.meta.width).toBe(720);
    expect(first.meta.height).toBe(1280);
    expect(first.meta.cards).toEqual(cards);
    expect(input.meta.width).toBe(1280);
  });
});
