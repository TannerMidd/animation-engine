import { describe, expect, it } from 'vitest';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import { compileShotList, type CompiledScene } from '../src/compile/scene.ts';
import { autoDirect, buildCapabilityManifest, validateShotList } from '../src/direct/index.ts';
import { parseScript } from '../src/parse/index.ts';
import { ShotList, type StageAction } from '../src/schema/script.ts';
import { SetDescriptor, type SetDescriptor as SetDescriptorType } from '../src/sets/schema.ts';
import type { LineTiming } from '../src/voice/index.ts';
import { testRigs } from './helpers.ts';

const rigFor = (name: string): LoadedRig => ({
  rig: buildPlaceholderRig(name),
  svg: buildPlaceholderSvg(name),
});

const actionBeat = (text: string, stage: StageAction[], ms = 1000, over: object = {}) => ({
  kind: 'action' as const,
  text,
  ms,
  stage,
  unsupported: [],
  reactions: {},
  shot: 'WIDE' as const,
  focus: [],
  camera: 'HOLD' as const,
  ...over,
});

const pauseBeat = (ms = 500) => ({
  kind: 'pause' as const,
  ms,
  reactions: {},
  shot: 'WIDE' as const,
  focus: [],
  camera: 'HOLD' as const,
});

function actorAt(scene: CompiledScene, ms: number, actor = 'alice') {
  const frame = Math.min(
    scene.ir.frames.length - 1,
    Math.floor((ms / 1000) * scene.ir.meta.fps),
  );
  return scene.ir.frames[frame]!.actors[actor]!;
}

describe('stable beat identity and legacy defaults', () => {
  const legacy = {
    scene: 'stable-staging',
    cards: false,
    cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER' as const }],
    beats: [pauseBeat(600), pauseBeat(900)],
  };

  it('backfills deterministic ids and backward-compatible initial stage state', () => {
    const first = ShotList.parse(legacy);
    const second = ShotList.parse(legacy);

    expect(first.beats.map((beat) => beat.id)).toEqual(second.beats.map((beat) => beat.id));
    expect(new Set(first.beats.map((beat) => beat.id)).size).toBe(first.beats.length);
    expect(first.cast[0]).toMatchObject({
      visible: true,
      position: null,
      depth: 0,
      pose: 'IDLE',
    });
  });

  it('does not rename existing beats when an unrelated beat is inserted above them', () => {
    const before = ShotList.parse(legacy);
    const after = ShotList.parse({
      ...legacy,
      beats: [pauseBeat(321), ...legacy.beats],
    });

    expect(after.beats.slice(1).map((beat) => beat.id)).toEqual(
      before.beats.map((beat) => beat.id),
    );
  });

  it('preserves an explicitly authored id', () => {
    const shots = ShotList.parse({
      ...legacy,
      beats: [{ ...pauseBeat(600), id: 'hand-locked-opening' }],
    });
    expect(shots.beats[0]!.id).toBe('hand-locked-opening');
  });
});

describe('screenplay action directing', () => {
  it('lowers obvious blocking into ordered actions and derives entrance visibility', () => {
    const screenplay = parseScript(`# BLOCKING

INT. OFFICE - DAY

Alice enters.

ALICE
Hello.

Alice walks to center and sits down on the floor.

ALICE
Settled.

Alice stands up, looks at Bob, and turns right.

BOB
I saw that.

Alice exits.
`);
    const rigs = testRigs(['alice', 'bob']);
    const shots = autoDirect(screenplay, rigs, { scene: 'blocking' });
    const types = shots.beats.flatMap((beat) =>
      beat.kind === 'action' ? beat.stage.map((action) => action.type) : [],
    );

    expect(types).toEqual(['enter', 'move', 'sit', 'stand', 'look', 'turn', 'exit']);
    expect(shots.cast.find((member) => member.id === 'alice')?.visible).toBe(false);
    expect(new Set(shots.beats.map((beat) => beat.id)).size).toBe(shots.beats.length);
    expect(validateShotList(shots, buildCapabilityManifest(rigs))).toEqual([]);
  });

  it('lowers understood prop work into the renderable capability vocabulary', () => {
    const screenplay = parseScript(`ALICE
Ready.

Alice picks up the mug.

Alice puts down the mug on the desk.
`);
    const rigs = testRigs(['alice']);
    const shots = autoDirect(screenplay, rigs, { scene: 'prop-work' });
    const actions = shots.beats.flatMap((beat) => beat.kind === 'action' ? beat.stage : []);

    expect(actions[0]?.type).toBe('pick_up');
    expect(actions[1]).toMatchObject({ type: 'put_down', prop: 'mug', target: 'desk' });
    expect(validateShotList(shots, buildCapabilityManifest(rigs))).toEqual([]);

    const exact = autoDirect(parseScript(`ALICE\nReady.\n\nAlice puts down the mug at (535, 470).\n`), rigs, {
      scene: 'exact-prop-work',
    });
    const putDown = exact.beats.flatMap((beat) => beat.kind === 'action' ? beat.stage : [])[0];
    expect(putDown).toMatchObject({ type: 'put_down', prop: 'mug', to: { x: 535, y: 470 } });
  });

  it('preserves explicit seat references and never invents a chair from a desk reference', () => {
    const rigs = testRigs(['vern']);
    const explicit = autoDirect(parseScript(`VERN\nReady.\n\nVern sits in chair-host at the desk.\n`), rigs, {
      scene: 'explicit-seat',
    });
    const atDesk = autoDirect(parseScript(`VERN\nReady.\n\nVern sits at the desk.\n`), rigs, {
      scene: 'desk-seat',
    });
    const explicitSit = explicit.beats.flatMap((beat) => beat.kind === 'action' ? beat.stage : [])
      .find((action) => action.type === 'sit');
    const deskSit = atDesk.beats.flatMap((beat) => beat.kind === 'action' ? beat.stage : [])
      .find((action) => action.type === 'sit');

    expect(explicitSit).toMatchObject({ type: 'sit', actor: 'vern', seat: 'chair-host' });
    expect(deskSit).toMatchObject({ type: 'sit', actor: 'vern', seat: 'desk' });
  });

  it('preserves explicit screenplay coordinates for creator-directed blocking', () => {
    const shots = autoDirect(parseScript(`ALICE\nReady.\n\nAlice moves to x 760, y 572, depth -1.\n`), testRigs(['alice']), {
      scene: 'coordinate-blocking',
    });
    const move = shots.beats.flatMap((beat) => beat.kind === 'action' ? beat.stage : [])
      .find((action) => action.type === 'move');
    expect(move).toMatchObject({ type: 'move', actor: 'alice', to: { x: 760, y: 572, depth: -1 } });
  });

  it('does not direct reactions or pause coverage at an actor who has exited', () => {
    const shots = autoDirect(parseScript(`MEL\nLeaving.\n\nMel exits.\n\nVERN\nStill here.\n\n[BEAT 900]\n`), testRigs(['mel', 'vern']), {
      scene: 'exit-reactions',
    });
    const line = shots.beats.find((beat) => beat.kind === 'line' && beat.speaker === 'vern');
    const pause = shots.beats.find((beat) => beat.kind === 'pause');
    expect(line?.reactions).not.toHaveProperty('mel');
    expect(pause?.focus).toEqual(['vern']);
  });

  it('surfaces prose it cannot confidently structure', () => {
    const screenplay = parseScript(`ALICE
Ready.

Alice cartwheels.
`);
    const rigs = testRigs(['alice']);
    const shots = autoDirect(screenplay, rigs, { scene: 'unknown-work' });
    const action = shots.beats.find((beat) => beat.kind === 'action');

    expect(action?.kind === 'action' ? action.unsupported : []).toEqual(['Alice cartwheels.']);
    expect(validateShotList(shots, buildCapabilityManifest(rigs)).join('\n')).toMatch(
      /unsupported action.*cartwheels/i,
    );
  });
});

describe('compiled persistent staging', () => {
  const rigs = new Map([
    ['alice', rigFor('alice')],
    ['bob', rigFor('bob')],
  ]);

  it('renders entrance, movement, depth, sitting, standing, gaze, turn, and exit as persistent state', () => {
    const shots = ShotList.parse({
      scene: 'stage-state',
      cards: false,
      fps: 24,
      characterFps: 12,
      cast: [
        { id: 'alice', rig: 'alice', mark: 'SL', visible: false, resting: 'NEUTRAL' },
        { id: 'bob', rig: 'bob', mark: 'FAR_R', resting: 'NEUTRAL' },
      ],
      beats: [
        actionBeat('Alice enters.', [{ type: 'enter', actor: 'alice', to: { mark: 'SL' } }]),
        actionBeat(
          'Alice crosses downstage.',
          [{ type: 'move', actor: 'alice', to: { mark: 'SR', y: 650, depth: 1 } }],
          1000,
          { shot: 'MID', focus: ['alice'] },
        ),
        actionBeat('Alice sits.', [{ type: 'sit', actor: 'alice', floor: true }]),
        pauseBeat(),
        actionBeat('Alice stands.', [{ type: 'stand', actor: 'alice' }]),
        actionBeat('Alice looks at Bob.', [{ type: 'look', actor: 'alice', target: 'bob' }]),
        pauseBeat(),
        actionBeat('Alice turns left.', [{ type: 'turn', actor: 'alice', direction: 'left' }]),
        pauseBeat(),
        actionBeat('Alice exits.', [{ type: 'exit', actor: 'alice' }]),
        pauseBeat(),
      ],
    });

    const scene = compileShotList(shots, rigs, new Map());
    const hidden = actorAt(scene, 0);
    const entering = actorAt(scene, 500);
    const onMark = actorAt(scene, 1000);
    const moving = actorAt(scene, 1500);
    const moved = actorAt(scene, 2100);
    const seated = actorAt(scene, 3200);
    const standing = actorAt(scene, 4600);
    const looking = actorAt(scene, 5600);
    const turned = actorAt(scene, 7100);
    const exited = actorAt(scene, 8600);

    expect(hidden.visible).toBe(false);
    expect(entering.visible).toBe(true);
    expect(entering.x).toBeLessThan(onMark.x);
    expect(moving.x).toBeGreaterThan(onMark.x);
    expect(moving.x).toBeLessThan(moved.x);
    expect(moved.x).toBeCloseTo(1280 * 0.69, 5);
    expect(moved.y).toBe(650);
    expect(moved.scale).toBeCloseTo(1.25 * 1.14, 5);

    expect(seated.parts.torso?.[2]).toBeGreaterThan((standing.parts.torso?.[2] ?? 0) + 40);
    expect(Math.abs(looking.parts.head?.[0] ?? 0)).toBeGreaterThan(2);
    expect(['eyes_side', 'eyes_closed']).toContain(looking.swaps.eyes);
    expect(turned.flip).toBe(true);
    expect(exited.visible).toBe(false);

    const earlyMoveCamera = scene.ir.frames[Math.floor(1.1 * shots.fps)]!.camera;
    const lateMoveCamera = scene.ir.frames[Math.floor(1.9 * shots.fps)]!.camera;
    expect(lateMoveCamera.x + lateMoveCamera.w / 2).toBeGreaterThan(
      earlyMoveCamera.x + earlyMoveCamera.w / 2,
    );
  });

  it('keeps a seated base pose underneath dialogue gestures', () => {
    const shots = ShotList.parse({
      scene: 'seated-line',
      cards: false,
      cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER', resting: 'NEUTRAL' }],
      beats: [
        actionBeat('Alice sits.', [{ type: 'sit', actor: 'alice', floor: true }]),
        {
          kind: 'line',
          speaker: 'alice',
          text: 'This meeting could have been an email.',
          expression: 'NEUTRAL',
          gesture: 'TALK',
          reactions: {},
          shot: 'MID',
          focus: ['alice'],
          camera: 'HOLD',
        },
      ],
    });
    const timings = new Map<number, LineTiming>([
      [1, { audio: '', durationMs: 1000, cues: [{ ms: 0, shape: 'C' }] }],
    ]);
    const scene = compileShotList(shots, rigs, timings);
    const speaking = actorAt(scene, 1200);

    expect(speaking.parts.torso?.[2]).toBeGreaterThan(40);
    expect(speaking.parts.arm_L_upper).toBeDefined();
  });

  it('requires loaded set context before compiling a prop action', () => {
    const shots = ShotList.parse({
      scene: 'prop-preflight',
      cards: false,
      cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER' }],
      beats: [actionBeat('Alice picks up the mug.', [
        { type: 'pick_up', actor: 'alice', prop: 'mug' },
      ])],
    });

    expect(() => compileShotList(shots, rigs, new Map())).toThrow(/PICK_UP.*active set descriptor/i);
  });
});

describe('targeted seating', () => {
  const rigs = new Map([['alice', rigFor('alice')], ['bob', rigFor('bob')]]);

  const seatSet = (
    items: Array<Record<string, unknown>> = [
      { id: 'chair-host', prop: 'chair', x: 845, y: 566, params: { height: 90 } },
    ],
    layer: 'mid' | 'fore' = 'mid',
  ): SetDescriptorType => SetDescriptor.parse({
    name: 'seat-stage',
    layout: { walkable: { x: 120, y: 590, width: 1040, height: 130 } },
    layers: { back: [], mid: layer === 'mid' ? items : [], fore: layer === 'fore' ? items : [] },
  });

  const seatingShots = (stage: StageAction[], cast: Array<Record<string, unknown>> = [{
    id: 'alice', rig: 'alice', mark: 'SR', position: { x: 845, y: 605.5 },
  }]) => ShotList.parse({
    scene: 'targeted-seating',
    set: 'seat-stage',
    cards: false,
    fps: 24,
    characterFps: 12,
    cast,
    beats: stage.length ? [actionBeat('Seat work.', stage), pauseBeat(500)] : [pauseBeat(1_000)],
  });

  it('aligns a readable chair pose and stands at the chair before later movement', () => {
    const shots = ShotList.parse({
      ...seatingShots([]),
      beats: [
        actionBeat('Alice sits in chair-host.', [{ type: 'sit', actor: 'alice', seat: 'chair-host' }]),
        pauseBeat(500),
        actionBeat('Alice stands.', [{ type: 'stand', actor: 'alice' }]),
        pauseBeat(500),
      ],
    });
    const scene = compileShotList(shots, rigs, new Map(), null, seatSet());
    const sit = scene.stageActions[0]!;
    const stand = scene.stageActions[1]!;
    const rig = rigs.get('alice')!.rig;
    const torso = rig.parts.find((part) => part.id === 'torso')!;
    const expectedSeatY = 566 - 90 - 6;
    const expectedRootY = expectedSeatY - (torso.pivot[1] + 62 - rig.anchor[1]) * 1.25;

    expect(sit.after).toMatchObject({ pose: 'SIT', seatedOn: 'chair-host', x: 845 });
    expect(sit.after.y).toBeCloseTo(expectedRootY, 5);
    const seated = actorAt(scene, 1_200);
    expect(seated.x).toBeCloseTo(845, 5);
    expect(seated.y).toBeCloseTo(expectedRootY, 5);
    expect(seated.parts['leg_L']).toMatchObject([8, 0, 0, 0.58]);
    expect(seated.parts['leg_R']).toMatchObject([-8, 0, 0, 0.58]);
    expect(stand.after).toMatchObject({ pose: 'IDLE', seatedOn: null, x: 845, y: expectedRootY });
    expect(actorAt(scene, 2_700).y).toBeCloseTo(expectedRootY, 5);
  });

  it('rejects an untargeted sit, a non-seat target, and ambiguous chair prose', () => {
    expect(() => compileShotList(
      seatingShots([{ type: 'sit', actor: 'alice' }]), rigs, new Map(), null, seatSet(),
    )).toThrow(/explicit seat target or floor=true/i);

    const withDesk = seatSet([
      { id: 'chair-host', prop: 'chair', x: 845, y: 566 },
      { id: 'desk-main', prop: 'desk', x: 640, y: 566 },
    ]);
    expect(() => compileShotList(
      seatingShots([{ type: 'sit', actor: 'alice', seat: 'desk-main' }]), rigs, new Map(), null, withDesk,
    )).toThrow(/no seat handle/i);

    const twoChairs = seatSet([
      { id: 'chair-host', prop: 'chair', x: 845, y: 566 },
      { id: 'chair-guest', prop: 'chair', x: 650, y: 566 },
    ]);
    expect(() => compileShotList(
      seatingShots([{ type: 'sit', actor: 'alice', seat: 'chair' }]), rigs, new Map(), null, twoChairs,
    )).toThrow(/ambiguous.*chair-host, chair-guest/i);

    expect(() => compileShotList(
      seatingShots(
        [{ type: 'sit', actor: 'alice', seat: 'chair-host' }],
        [{ id: 'alice', rig: 'alice', mark: 'SR', position: { x: 883, y: 698 } }],
      ),
      rigs,
      new Map(),
      null,
      seatSet(),
    )).toThrow(/MOVE closer first/i);
  });

  it('rejects foreground seats, occupied seats, and moving before standing', () => {
    expect(() => compileShotList(
      seatingShots([{ type: 'sit', actor: 'alice', seat: 'chair-host' }]),
      rigs, new Map(), null, seatSet(undefined, 'fore'),
    )).toThrow(/foreground seat/i);

    const occupied = seatingShots(
      [
        { type: 'sit', actor: 'alice', seat: 'chair-host' },
        { type: 'sit', actor: 'bob', seat: 'chair-host' },
      ],
      [
        { id: 'alice', rig: 'alice', mark: 'SR', position: { x: 845, y: 605.5 } },
        { id: 'bob', rig: 'bob', mark: 'SR', position: { x: 845, y: 605.5 } },
      ],
    );
    expect(() => compileShotList(occupied, rigs, new Map(), null, seatSet())).toThrow(/already occupied/i);

    const slides = seatingShots([
      { type: 'sit', actor: 'alice', seat: 'chair-host' },
      { type: 'move', actor: 'alice', to: { mark: 'CENTER' } },
    ]);
    expect(() => compileShotList(slides, rigs, new Map(), null, seatSet())).toThrow(/add STAND first/i);
  });

  it('binds an initially seated actor and requires a stable initial target', () => {
    const shots = seatingShots([], [{
      id: 'alice', rig: 'alice', mark: 'SR', position: { x: 883, y: 698 }, pose: 'SIT', seat: 'chair-host',
    }]);
    const scene = compileShotList(shots, rigs, new Map(), null, seatSet());
    expect(actorAt(scene, 100)).toMatchObject({ x: 845 });

    const invalid = ShotList.parse({
      ...shots,
      cast: [{ ...shots.cast[0], seat: null }],
    });
    expect(() => compileShotList(invalid, rigs, new Map(), null, seatSet())).toThrow(/initial SIT.*seat target/i);
  });
});
