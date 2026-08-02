import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { compileShotList, type CompiledScene } from '../src/compile/scene.ts';
import { buildPage } from '../src/render/page.ts';
import { ShotList, type StageAction } from '../src/schema/script.ts';
import { renderSet } from '../src/sets/index.ts';
import { SetDescriptor, type SetDescriptor as SetDescriptorType } from '../src/sets/schema.ts';
import { testRigs } from './helpers.ts';

function actionBeat(
  id: string,
  text: string,
  ms: number,
  stage: StageAction[],
  shot: 'WIDE' | 'MID' | 'CU' = 'MID',
) {
  return {
    id,
    kind: 'action' as const,
    text,
    ms,
    stage,
    unsupported: [],
    reactions: {},
    shot,
    focus: ['alice'],
    camera: 'HOLD' as const,
  };
}

function pauseBeat(id: string, ms: number, shot: 'WIDE' | 'MID' | 'CU' = 'CU') {
  return {
    id,
    kind: 'pause' as const,
    ms,
    reactions: {},
    shot,
    focus: ['alice'],
    camera: 'HOLD' as const,
  };
}

function propSet(items: Array<Record<string, unknown>>): SetDescriptorType {
  return SetDescriptor.parse({
    name: 'prop-stage',
    layers: { back: [], mid: items, fore: [] },
  });
}

function shotsFor(
  beats: Array<ReturnType<typeof actionBeat> | ReturnType<typeof pauseBeat>>,
  visible = true,
) {
  return ShotList.parse({
    scene: 'prop-actions',
    set: 'prop-stage',
    cards: false,
    fps: 24,
    characterFps: 12,
    cast: [{
      id: 'alice',
      rig: 'alice',
      mark: 'CENTER',
      position: { x: 600, y: 698 },
      visible,
    }],
    beats,
  });
}

function frameAt(scene: CompiledScene, ms: number) {
  const index = Math.min(scene.ir.frames.length - 1, Math.floor(ms / 1_000 * scene.ir.meta.fps));
  return scene.ir.frames[index]!;
}

describe('structured dynamic prop actions', () => {
  it('supports a hidden actor entering with an initially carried stable prop', () => {
    const set = propSet([{ id: 'hero-mug', prop: 'mug', x: 640, y: 540 }]);
    const base = shotsFor([
      actionBeat('enter-carrying', 'Alice enters with the mug.', 700, [
        { type: 'enter', actor: 'alice', to: { mark: 'CENTER' } },
      ], 'WIDE'),
      actionBeat('place-carried', 'Alice puts down the mug.', 700, [
        { type: 'put_down', actor: 'alice', prop: 'hero-mug', to: { x: 680, y: 540 } },
      ]),
    ], false);
    const shots = ShotList.parse({
      ...base,
      cast: base.cast.map((member) => ({
        ...member,
        heldProp: 'hero-mug',
        heldHand: 'right',
      })),
    });
    const compiled = compileShotList(shots, testRigs(['alice']), new Map(), null, set);

    expect(frameAt(compiled, 50).props?.['hero-mug']).toMatchObject({ heldBy: 'alice', visible: false });
    expect(frameAt(compiled, 750).props?.['hero-mug']).toMatchObject({ heldBy: 'alice', visible: true });
    expect(frameAt(compiled, 1_350).props?.['hero-mug']).toMatchObject({ heldBy: null, x: 680, y: 540, visible: true });
  });

  it('keeps pickup state held across a cut, follows the hand, and persists putdown placement', async () => {
    const set = propSet([{ id: 'hero-mug', prop: 'mug', x: 640, y: 540 }]);
    const shots = shotsFor([
      actionBeat('pickup', 'Alice picks up the mug.', 1_000, [
        { type: 'pick_up', actor: 'alice', prop: 'hero-mug' },
      ], 'WIDE'),
      pauseBeat('held-cut', 500, 'CU'),
      actionBeat('putdown', 'Alice puts down the mug.', 1_000, [
        { type: 'put_down', actor: 'alice', prop: 'hero-mug', to: { x: 720, y: 540 } },
      ], 'MID'),
    ]);
    const rigs = testRigs(['alice']);
    const first = compileShotList(shots, rigs, new Map(), null, set);
    const second = compileShotList(shots, testRigs(['alice']), new Map(), null, set);

    expect(first.ir).toEqual(second.ir);
    expect(first.ir.props).toEqual([{ id: 'hero-mug', prop: 'mug' }]);
    expect(frameAt(first, 100).props?.['hero-mug']).toMatchObject({ mode: 'set', heldBy: null });

    const afterPickup = frameAt(first, 1_050).props?.['hero-mug'];
    const acrossCut = frameAt(first, 1_250).props?.['hero-mug'];
    expect(afterPickup).toMatchObject({ mode: 'world', heldBy: 'alice', visible: true });
    expect(acrossCut).toMatchObject({ mode: 'world', heldBy: 'alice', visible: true });
    // The held prop remains attached while the actor's idle torso/arm motion
    // subtly moves it; it must not snap back to the authored set x=640.
    expect(Math.abs(acrossCut!.x - afterPickup!.x)).toBeLessThan(2);
    expect(acrossCut?.x).not.toBe(afterPickup!.x);
    expect(frameAt(first, 1_250).camera).not.toEqual(frameAt(first, 500).camera);

    const placed = frameAt(first, 2_350).props?.['hero-mug'];
    expect(placed).toMatchObject({
      mode: 'world',
      x: 720,
      y: 540,
      heldBy: null,
      visible: true,
    });

    const pickupArm = frameAt(first, 500).actors.alice!.parts.arm_R_upper;
    const restingArm = frameAt(first, 0).actors.alice!.parts.arm_R_upper;
    expect(pickupArm).not.toEqual(restingArm);

    expect(first.stageActions.map((action) => action.contacts)).toEqual([
      [{
        id: 'pickup:stage:0:contact:0',
        kind: 'grasp',
        actor: 'alice',
        hand: 'right',
        atMs: 550,
        ordinal: 1,
        total: 1,
        target: { kind: 'prop', id: 'hero-mug', prop: 'mug', handle: 'grip' },
        point: { x: 670, y: 515 },
      }],
      [{
        id: 'putdown:stage:0:contact:0',
        kind: 'release',
        actor: 'alice',
        hand: 'right',
        atMs: 2_220,
        ordinal: 1,
        total: 1,
        target: { kind: 'prop', id: 'hero-mug', prop: 'mug', handle: 'grip' },
        point: { x: 750, y: 515 },
      }],
    ]);

    const runtime = await fs.readFile(new URL('../src/render/runtime.js', import.meta.url), 'utf8');
    const html = await buildPage({ ir: first.ir, rigs, runtime, set: renderSet(set) });
    expect(html).toContain('id="set-prop-hero-mug"');
    expect(html).toContain('id="dynamic-prop-hero-mug"');
    expect(html.indexOf('id="dynamic-props"')).toBeGreaterThan(html.indexOf('id="actor-alice"'));

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      await page.waitForFunction('window.__ready === true');
      await page.evaluate((index) => (window as never as { __seek(index: number): number }).__seek(index), 30);
      const heldDom = await page.evaluate(() => ({
        set: document.getElementById('set-prop-hero-mug')!.style.display,
        dynamic: document.getElementById('dynamic-prop-hero-mug')!.style.display,
        transform: document.getElementById('dynamic-prop-hero-mug')!.getAttribute('transform'),
      }));
      expect(heldDom.set).toBe('none');
      expect(heldDom.dynamic).toBe('');
      expect(heldDom.transform).toMatch(/^translate\(/);

      const rig = rigs.get('alice')!.rig;
      const upper = rig.parts.find((part) => part.id === 'arm_R_upper')!;
      const fore = rig.parts.find((part) => part.id === 'arm_R_fore')!;
      const dx = fore.pivot[0] - upper.pivot[0];
      const dy = fore.pivot[1] - upper.pivot[1];
      const endpoint = { x: fore.pivot[0] + dx, y: fore.pivot[1] + dy };
      const attachment = await page.evaluate(({ endpoint }) => {
        const svg = document.querySelector<SVGSVGElement>('#stage')!;
        const transformed = (element: SVGGraphicsElement, x: number, y: number) => {
          const point = svg.createSVGPoint();
          point.x = x;
          point.y = y;
          const out = point.matrixTransform(element.getCTM()!);
          return { x: out.x, y: out.y };
        };
        return {
          hand: transformed(document.querySelector<SVGGraphicsElement>('#alice__arm_R_fore')!, endpoint.x, endpoint.y),
          grip: transformed(document.querySelector<SVGGraphicsElement>('#dynamic-prop-hero-mug')!, 30, -25),
        };
      }, { endpoint });
      expect(Math.hypot(
        attachment.hand.x - attachment.grip.x,
        attachment.hand.y - attachment.grip.y,
      )).toBeLessThan(0.05);

      await page.evaluate((index) => (window as never as { __seek(index: number): number }).__seek(index), 56);
      expect(await page.locator('#dynamic-prop-hero-mug').getAttribute('transform')).toContain('translate(720,540)');
    } finally {
      await browser.close();
    }
  });

  it('emits every repeated tap contact while leaving the target at its set placement', () => {
    const set = propSet([{ id: 'work-laptop', prop: 'laptop', x: 550, y: 540 }]);
    const shots = shotsFor([
      actionBeat('three-taps', 'Alice taps the laptop three times.', 1_200, [
        { type: 'tap', actor: 'alice', target: 'work-laptop', count: 3 },
      ]),
    ]);
    const scene = compileShotList(shots, testRigs(['alice']), new Map(), null, set);
    const action = scene.stageActions[0]!;

    expect(action.contacts.map((contact) => ({ kind: contact.kind, atMs: contact.atMs, ordinal: contact.ordinal }))).toEqual([
      { kind: 'tap', atMs: 200, ordinal: 1 },
      { kind: 'tap', atMs: 600, ordinal: 2 },
      { kind: 'tap', atMs: 1_000, ordinal: 3 },
    ]);
    expect(scene.ir.frames.every((frame) => frame.props?.['work-laptop']?.mode === 'set')).toBe(true);
    expect(frameAt(scene, 200).actors.alice!.parts.arm_L_upper).not.toEqual(
      frameAt(scene, 400).actors.alice!.parts.arm_L_upper,
    );
  });

  it('supports one legacy unnamed instance by type with a deterministic runtime id', () => {
    const set = propSet([{ prop: 'cup', x: 640, y: 540 }]);
    const shots = shotsFor([actionBeat('legacy-pickup', 'Alice picks up the cup.', 800, [
      { type: 'pick_up', actor: 'alice', prop: 'cup' },
    ])]);
    const first = compileShotList(shots, testRigs(['alice']), new Map(), null, set);
    const second = compileShotList(shots, testRigs(['alice']), new Map(), null, set);

    expect(first.ir.props).toEqual([{ id: 'auto:mid:0:cup', prop: 'cup' }]);
    expect(first.ir.props).toEqual(second.ir.props);
    expect(first.stageActions[0]!.contacts[0]!.target.id).toBe('auto:mid:0:cup');
  });

  it('rejects missing/ambiguous targets and invalid pickup/putdown continuity', () => {
    const oneMug = propSet([{ id: 'hero-mug', prop: 'mug', x: 640, y: 540 }]);
    const twoMugs = propSet([
      { id: 'left-mug', prop: 'mug', x: 560, y: 540 },
      { id: 'right-mug', prop: 'mug', x: 680, y: 540 },
    ]);
    const rigs = testRigs(['alice']);

    const missing = shotsFor([actionBeat('missing', 'Reach.', 500, [
      { type: 'reach', actor: 'alice', target: 'stapler' },
    ])]);
    expect(() => compileShotList(missing, rigs, new Map(), null, oneMug)).toThrow(/missing prop "stapler"/i);

    const ambiguous = shotsFor([actionBeat('ambiguous', 'Pick up a mug.', 500, [
      { type: 'pick_up', actor: 'alice', prop: 'mug' },
    ])]);
    expect(() => compileShotList(ambiguous, rigs, new Map(), null, twoMugs)).toThrow(/ambiguous.*stable instance ids/i);

    const noPickup = shotsFor([actionBeat('no-pickup', 'Put it down.', 500, [
      { type: 'put_down', actor: 'alice', prop: 'hero-mug' },
    ])]);
    expect(() => compileShotList(noPickup, rigs, new Map(), null, oneMug)).toThrow(/not holding a prop/i);

    const doublePickup = shotsFor([
      actionBeat('first-pickup', 'Pick it up.', 500, [{ type: 'pick_up', actor: 'alice', prop: 'hero-mug' }]),
      actionBeat('second-pickup', 'Pick it up again.', 500, [{ type: 'pick_up', actor: 'alice', prop: 'hero-mug' }]),
    ]);
    expect(() => compileShotList(doublePickup, rigs, new Map(), null, oneMug)).toThrow(/pick up a second prop|already held/i);
  });

  it('rejects hidden performers and unreachable prop targets instead of inventing motion', () => {
    const near = propSet([{ id: 'hero-mug', prop: 'mug', x: 640, y: 540 }]);
    const hidden = shotsFor([actionBeat('hidden', 'Hidden pickup.', 500, [
      { type: 'pick_up', actor: 'alice', prop: 'hero-mug' },
    ])], false);
    expect(() => compileShotList(hidden, testRigs(['alice']), new Map(), null, near)).toThrow(/hidden actor.*pick_up/i);

    const far = propSet([{ id: 'far-mug', prop: 'mug', x: 1_150, y: 540 }]);
    const unreachable = shotsFor([actionBeat('far', 'Far pickup.', 500, [
      { type: 'pick_up', actor: 'alice', prop: 'far-mug' },
    ])]);
    expect(() => compileShotList(unreachable, testRigs(['alice']), new Map(), null, far)).toThrow(/out of reach/i);
  });
});
