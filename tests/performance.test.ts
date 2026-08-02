import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { setActiveIdentity } from '../src/show/context.ts';
import {
  expressionSegments, valueAt, fidgetSchedule, fidgetAt, gazeTowardSpeaker, quantizeMs,
  type Timed,
} from '../src/compile/performance.ts';
import { compileShotList } from '../src/compile/scene.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import { ShotList } from '../src/schema/script.ts';
import type { LineTiming } from '../src/voice/index.ts';
import type { LoadedRig } from '../src/cast/store.ts';

afterEach(() => setActiveIdentity(DEFAULT_IDENTITY));

const CHAR_FPS = 12;
const acting = { reactionMs: 250, gestureBias: 1, fidgetAmp: 2 };

const line = (speaker: string, ms: number, startMs: number, index: number, over: object = {}): Timed => ({
  beat: {
    kind: 'line', speaker, text: 'words', expression: 'ANGRY', gesture: 'TALK',
    reactions: {}, shot: 'MID', focus: [speaker], camera: 'HOLD', ...over,
  } as Timed['beat'],
  index, startMs, endMs: startMs + ms,
});

describe('listener reaction latency', () => {
  it('lands the reaction after the character\'s personal delay, on the grid', () => {
    const timeline = [line('alice', 2000, 0, 0, { reactions: { bob: 'SHOCKED' } })];
    const segments = expressionSegments(timeline, 'bob', 'DEADPAN', acting, CHAR_FPS);

    expect(valueAt(segments, 0)).toBe('DEADPAN');
    expect(valueAt(segments, 100)).toBe('DEADPAN');
    expect(valueAt(segments, 400)).toBe('SHOCKED');
    // The change lands exactly on a character frame.
    const change = segments.find((s) => s.value === 'SHOCKED')!;
    expect(change.fromMs).toBe(quantizeMs(change.fromMs, CHAR_FPS));
  });

  it('changes the speaker on the boundary — their line is the reaction', () => {
    const timeline = [line('alice', 2000, 0, 0)];
    const segments = expressionSegments(timeline, 'alice', 'DEADPAN', acting, CHAR_FPS);
    expect(valueAt(segments, 0)).toBe('ANGRY');
  });

  it('drops a reaction that cannot land before the beat ends', () => {
    const timeline = [
      line('alice', 120, 0, 0, { reactions: { bob: 'SHOCKED' } }),
      line('alice', 2000, 120, 1, {}),
    ];
    const segments = expressionSegments(timeline, 'bob', 'DEADPAN', acting, CHAR_FPS);
    expect(segments.every((s) => s.value !== 'SHOCKED')).toBe(true);
  });
});

describe('fidget schedule', () => {
  it('is deterministic and grid-aligned', () => {
    const a = fidgetSchedule(7, 'steve', 20_000, acting, CHAR_FPS);
    const b = fidgetSchedule(7, 'steve', 20_000, acting, CHAR_FPS);
    expect(a).toEqual(b);
    for (const s of a) expect(s.fromMs).toBe(quantizeMs(s.fromMs, CHAR_FPS));
  });

  it('shifts within the character\'s amplitude and holds between changes', () => {
    const shifts = fidgetSchedule(7, 'steve', 30_000, acting, CHAR_FPS);
    expect(shifts.length).toBeGreaterThan(3);
    for (const s of shifts) expect(Math.abs(s.dx)).toBeLessThanOrEqual(acting.fidgetAmp);
    // Sampling between two changes returns the same held value.
    const [first, second] = [shifts[1]!, shifts[2]!];
    expect(fidgetAt(shifts, first.fromMs + 1)).toBe(first.dx);
    expect(fidgetAt(shifts, second.fromMs - 1)).toBe(first.dx);
  });

  it('is flat for a character with no fidget', () => {
    const shifts = fidgetSchedule(7, 'x', 30_000, { ...acting, fidgetAmp: 0 }, CHAR_FPS);
    expect(shifts).toEqual([{ fromMs: 0, dx: 0 }]);
  });
});

describe('gaze geometry', () => {
  it('only cuts eyes when the side variant points at the speaker', () => {
    // Unflipped side-eyes look stage-right (+x).
    expect(gazeTowardSpeaker({ x: 400, flip: false }, 880)).toBe(true);
    expect(gazeTowardSpeaker({ x: 880, flip: false }, 400)).toBe(false);
    // Flipped puppets mirror, so their side-eyes look stage-left.
    expect(gazeTowardSpeaker({ x: 880, flip: true }, 400)).toBe(true);
    expect(gazeTowardSpeaker({ x: 400, flip: true }, 880)).toBe(false);
  });
});

describe('compiled performance', () => {
  const rigFor = (name: string): LoadedRig => ({
    rig: buildPlaceholderRig(name),
    svg: buildPlaceholderSvg(name),
  });

  const shotsFor = (over: object = {}) =>
    ShotList.parse({
      scene: 'perf-test',
      // These tests pin the scene body; the card packaging has its own suite.
      cards: false,
      cast: [
        { id: 'alice', rig: 'alice', mark: 'SL', flip: false, scale: 1.25, resting: 'DEADPAN' },
        { id: 'bob', rig: 'bob', mark: 'SR', flip: true, scale: 1.25, resting: 'DEADPAN' },
      ],
      beats: [
        {
          kind: 'line', speaker: 'alice', text: 'You need to listen to me right now.',
          expression: 'ANGRY', gesture: 'POINT', reactions: { bob: 'SHOCKED' },
          shot: 'MID', focus: ['alice'], camera: 'HOLD',
        },
        { kind: 'pause', ms: 1500, reactions: {}, shot: 'CU', focus: ['bob'], camera: 'HOLD' },
      ],
      ...over,
    });

  const timings = new Map<number, LineTiming>([
    [0, { audio: '', durationMs: 3000, cues: [{ ms: 0, shape: 'C' }] }],
  ]);

  const rigs = new Map([
    ['alice', rigFor('alice')],
    ['bob', rigFor('bob')],
  ]);

  it('compiles identically twice', () => {
    const a = compileShotList(shotsFor(), rigs, timings);
    const b = compileShotList(shotsFor(), rigs, timings);
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
  });

  it('shows the listener reacting during the speaker\'s line, late', () => {
    const { ir } = compileShotList(shotsFor(), rigs, timings);
    const fps = ir.meta.fps;

    // At the first frame, bob still wears his resting face; later in the line
    // his reaction has landed. That gap IS the performance.
    const early = ir.frames[1]!.actors['bob']!;
    const later = ir.frames[Math.floor(fps * 1.5)]!.actors['bob']!;
    expect(early.swaps['brows']).toBe('brows_flat'); // DEADPAN
    expect(later.swaps['brows']).toBe('brows_raised'); // SHOCKED
  });

  it('releases a held gesture back into talking on a long line', () => {
    const { ir } = compileShotList(shotsFor(), rigs, timings);
    const fps = ir.meta.fps;

    const pointing = (f: number) => {
      const arm = ir.frames[f]!.actors['alice']!.parts['arm_R_upper'];
      // POINT rotates the right upper arm to -68; talking poses use small angles.
      return !!arm && arm[0] < -50;
    };
    expect(pointing(Math.floor(fps * 0.5))).toBe(true);
    expect(pointing(Math.floor(fps * 2.6))).toBe(false);
  });

  it('accents selected words and recovers instead of alternating talk poses on a timer', () => {
    const shots = shotsFor({
      beats: [{
        kind: 'line', speaker: 'alice', text: 'Please listen carefully right now!',
        expression: 'ANGRY', gesture: 'TALK', reactions: { bob: 'SHOCKED' },
        shot: 'MID', focus: ['alice'], camera: 'HOLD',
      }],
    });
    const aligned = new Map<number, LineTiming>([[0, {
      audio: '', durationMs: 3000, cues: [{ ms: 0, shape: 'C' }],
      speechOnsetMs: 100, speechEndMs: 2800,
      words: [
        { id: 'w000-please', text: 'Please', startMs: 200, endMs: 450 },
        { id: 'w001-listen', text: 'listen', startMs: 850, endMs: 1100 },
        { id: 'w002-carefully', text: 'carefully', startMs: 1450, endMs: 1750 },
        { id: 'w003-right', text: 'right', startMs: 2050, endMs: 2250 },
        { id: 'w004-now', text: 'now!', startMs: 2400, endMs: 2650 },
      ],
    }]]);
    const { ir } = compileShotList(shots, rigs, aligned);
    const at = (ms: number) => ir.frames[Math.round((ms / 1000) * ir.meta.fps)]!.actors.alice!;
    const arms = (ms: number) => JSON.stringify({
      lu: at(ms).parts.arm_L_upper,
      lf: at(ms).parts.arm_L_fore,
      ru: at(ms).parts.arm_R_upper,
      rf: at(ms).parts.arm_R_fore,
    });

    expect(arms(1600)).not.toBe(arms(100));
    expect(arms(2100)).toBe(arms(100));
    expect(arms(2500)).not.toBe(arms(2100));
  });

  it('preserves explicit pause durations exactly', () => {
    const { ir, durationMs } = compileShotList(shotsFor(), rigs, timings);
    // 3000ms line (timing) + 160ms tail + 1500ms pause.
    expect(durationMs).toBe(3000 + 160 + 1500);
    expect(ir.frames.length).toBe(Math.round(((3000 + 160 + 1500) / 1000) * ir.meta.fps));
  });

  it('keeps held-frame economics intact', () => {
    const { ir } = compileShotList(shotsFor(), rigs, timings);
    const unique = new Set(ir.frames.map((f) => JSON.stringify(f.actors))).size;
    // Characters sample on the 12fps grid inside a 24fps scene: at most half
    // the frames can be unique, and holds should push it well below that.
    expect(unique / ir.frames.length).toBeLessThanOrEqual(0.5);
  });

  it('cuts the listener\'s eyes toward the speaker when geometry allows', () => {
    const { ir } = compileShotList(shotsFor(), rigs, timings);
    const fps = ir.meta.fps;
    // bob stands at SR flipped, alice at SL: flipped side-eyes look stage-left,
    // toward her. Once his SHOCKED reaction lands, its wide eyes own the slot —
    // so look just before the reaction, where he is still DEADPAN (eyes_half).
    const before = ir.frames[Math.floor(fps * 0.2)]!.actors['bob']!;
    expect(['eyes_side', 'eyes_closed']).toContain(before.swaps['eyes']);
  });
});
