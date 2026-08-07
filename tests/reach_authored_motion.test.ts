import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { compileShotList } from '../src/compile/scene.ts';
import { buildPage } from '../src/render/page.ts';
import { AnimationDocument } from '../src/schema/animation.ts';
import { ShotList } from '../src/schema/script.ts';
import { renderSet } from '../src/sets/index.ts';
import { getProp } from '../src/sets/props/index.ts';
import { SetDescriptor, type SetDescriptor as SetDescriptorType } from '../src/sets/schema.ts';
import { testRigs } from './helpers.ts';

/**
 * Reaching for something you were dragged next to.
 *
 * Staging says where the shot list put someone. A drag writes a `root.position`
 * phrase, which is applied after the pose is composed — so a creator who moved
 * a character to the desk and watched them stand at it was told the desk was
 * out of reach anyway, because the check read the shot list instead of the
 * screen. There is no way to act on that message: the actor is already there.
 */

const FLOOR_Y = 698;
const DESK_X = 1_000;

function deskSet(): SetDescriptorType {
  return SetDescriptor.parse({
    name: 'reach-stage',
    layers: { back: [], mid: [{ id: 'desk-main', prop: 'desk', x: DESK_X, y: 540 }], fore: [] },
  });
}

function tapScene(x: number) {
  return ShotList.parse({
    scene: 'reach-scene',
    set: 'reach-stage',
    cards: false,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER', position: { x, y: FLOOR_Y }, visible: true }],
    beats: [
      { id: 'settle', kind: 'pause', ms: 3_000, reactions: {}, shot: 'WIDE', focus: ['alice'], camera: 'HOLD' },
      {
        id: 'tap-it',
        kind: 'action',
        text: 'Alice taps the desk.',
        ms: 1_000,
        stage: [{ type: 'tap', actor: 'alice', target: 'desk-main', count: 2 }],
        unsupported: [],
        reactions: {},
        shot: 'MID',
        focus: ['alice'],
        camera: 'HOLD',
      },
    ],
  });
}

/** A drag carrying Alice somewhere else, finished well before the tap lands. */
function draggedTo(x: number) {
  return AnimationDocument.parse({
    schemaVersion: 1,
    scene: 'reach-scene',
    layers: [{
      id: 'manual', name: 'Manual', ownership: 'manual',
      priority: 0, enabled: true, locked: false,
    }],
    tracks: [],
    events: [],
    segments: [{
      id: 'walk',
      layerId: 'manual',
      actorId: 'alice',
      channel: 'root.position',
      blend: 'override',
      easing: 'linear',
      path: { shape: 'linear', curvature: 0 },
      assist: { anticipation: 0, overshoot: 0, hold: 0, recovery: 0.15 },
      source: 'drag',
      from: { id: 'walk:from', time: { kind: 'absolute', ms: 0 }, value: [500, FLOOR_Y] },
      to: { id: 'walk:to', time: { kind: 'absolute', ms: 900 }, value: [x, FLOOR_Y] },
      waypoints: [],
    }],
  });
}

function compile(shots: ReturnType<typeof tapScene>, animation: ReturnType<typeof draggedTo> | null) {
  return compileShotList(shots, testRigs(['alice']), new Map(), animation, deskSet());
}

describe('reaching from where the puppet actually stands', () => {
  it('refuses a tap the actor is genuinely too far from', () => {
    expect(() => compile(tapScene(500), null)).toThrow(/out of reach/);
  });

  it('allows the same tap once a drag has carried the actor to the prop', () => {
    expect(() => compile(tapScene(500), draggedTo(DESK_X))).not.toThrow();
  });

  it('refuses a tap the actor was dragged away from, staged in reach or not', () => {
    // Staged at the desk, so the shot list alone would allow this.
    expect(() => compile(tapScene(DESK_X), null)).not.toThrow();
    expect(() => compile(tapScene(DESK_X), draggedTo(200))).toThrow(/out of reach/);
  });

  it('names the position it measured from, so a drag can be told apart from staging', () => {
    expect(() => compile(tapScene(500), null)).toThrow(/standing at 500,698/);
    // The dragged-away case reports where the phrase left them, not the mark.
    expect(() => compile(tapScene(DESK_X), draggedTo(200))).toThrow(/standing at 200,698/);
  });

  it('aims both rendered taps from the dragged root at the desk contact', async () => {
    const set = deskSet();
    const rigs = testRigs(['alice']);
    const scene = compileShotList(tapScene(500), rigs, new Map(), draggedTo(DESK_X), set);
    const contacts = scene.stageActions[0]!.contacts;
    expect(contacts).toHaveLength(2);

    const runtime = await fs.readFile(new URL('../src/render/runtime.js', import.meta.url), 'utf8');
    const html = await buildPage({ ir: scene.ir, rigs, runtime, set: renderSet(set) });
    const handle = getProp('desk').interaction!.handles.find((item) => item.id === 'work-surface')!;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await page.waitForFunction('window.__ready === true');

      for (const contact of contacts) {
        const frame = Math.floor(contact.atMs / 1_000 * scene.ir.meta.fps);
        await page.evaluate((index) => (
          window as never as { __seek(index: number): number }
        ).__seek(index), frame);

        const rig = rigs.get('alice')!.rig;
        const side = contact.hand === 'right' ? 'R' : 'L';
        const upper = rig.parts.find((part) => part.id === `arm_${side}_upper`)!;
        const fore = rig.parts.find((part) => part.id === `arm_${side}_fore`)!;
        const endpoint = {
          x: fore.pivot[0] + (fore.pivot[0] - upper.pivot[0]),
          y: fore.pivot[1] + (fore.pivot[1] - upper.pivot[1]),
        };
        const points = await page.evaluate(({ side, endpoint, handle }) => {
          const svg = document.querySelector<SVGSVGElement>('#stage')!;
          const transformed = (element: SVGGraphicsElement, x: number, y: number) => {
            const point = svg.createSVGPoint();
            point.x = x;
            point.y = y;
            const out = point.matrixTransform(element.getCTM()!);
            return { x: out.x, y: out.y };
          };
          return {
            hand: transformed(
              document.querySelector<SVGGraphicsElement>(`#alice__arm_${side}_fore`)!,
              endpoint.x,
              endpoint.y,
            ),
            target: transformed(
              document.querySelector<SVGGraphicsElement>('#set-prop-desk-main')!,
              handle.x,
              handle.y,
            ),
          };
        }, { side, endpoint, handle });

        expect(
          Math.hypot(points.hand.x - points.target.x, points.hand.y - points.target.y),
          `tap ${contact.ordinal} hand should land on ${contact.target.id}:${contact.target.handle}`,
        ).toBeLessThan(25);
      }
    } finally {
      await browser.close();
    }
  });
});
