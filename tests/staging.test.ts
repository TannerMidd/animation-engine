import { describe, expect, it } from 'vitest';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import { compileShotList, type CompiledScene } from '../src/compile/scene.ts';
import { autoDirect, buildCapabilityManifest, validateShotList } from '../src/direct/index.ts';
import { parseScript } from '../src/parse/index.ts';
import { ShotList, type StageAction } from '../src/schema/script.ts';
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

Alice walks to center and sits down.

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
`);
    const rigs = testRigs(['alice']);
    const shots = autoDirect(screenplay, rigs, { scene: 'prop-work' });
    const action = shots.beats.find((beat) => beat.kind === 'action');

    expect(action?.kind === 'action' ? action.stage[0]?.type : null).toBe('pick_up');
    expect(validateShotList(shots, buildCapabilityManifest(rigs))).toEqual([]);
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
        actionBeat('Alice sits.', [{ type: 'sit', actor: 'alice' }]),
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
        actionBeat('Alice sits.', [{ type: 'sit', actor: 'alice' }]),
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
