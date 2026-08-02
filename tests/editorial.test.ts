import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { setActiveIdentity } from '../src/show/context.ts';
import { applyMove } from '../src/render/framing.ts';
import { autoDirect } from '../src/direct/index.ts';
import { parseScript } from '../src/parse/index.ts';
import { mergeShotLists, diffShotLists } from '../src/pipeline/propose.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import { ShotList } from '../src/schema/script.ts';
import type { LoadedRig } from '../src/cast/store.ts';

afterEach(() => setActiveIdentity(DEFAULT_IDENTITY));

const cam = { x: 100, y: 100, w: 600, h: 337.5 };
const stage = { width: 1280, height: 720 };

describe('SNAP_IN', () => {
  it('is stepped: distinct sizes with no easing between them', () => {
    const sizes = new Set<number>();
    for (let t = 0; t <= 1; t += 0.02) {
      sizes.add(Math.round(applyMove(cam, 'SNAP_IN', t, 0, stage).w * 100) / 100);
    }
    // Base + each step, and nothing else — an eased move would produce dozens.
    expect(sizes.size).toBe(DEFAULT_IDENTITY.editorial.snapIn.steps + 1);
  });

  it('tightens by the profile amount and stays centred', () => {
    const snapped = applyMove(cam, 'SNAP_IN', 0.9, 0, stage);
    const k = 1 - DEFAULT_IDENTITY.editorial.snapIn.amount;
    expect(snapped.w).toBeCloseTo(cam.w * k, 5);
    expect(snapped.x + snapped.w / 2).toBeCloseTo(cam.x + cam.w / 2, 5);
  });

  it('holds the base frame before the first step', () => {
    expect(applyMove(cam, 'SNAP_IN', 0.01, 0, stage)).toEqual(cam);
  });
});

describe('the director\'s editorial rules', () => {
  const rigFor = (name: string): LoadedRig => ({
    rig: buildPlaceholderRig(name),
    svg: buildPlaceholderSvg(name),
  });
  const rigs = new Map([['mel', rigFor('mel')], ['vern', rigFor('vern')]]);

  const directed = (source: string) =>
    autoDirect(parseScript(source, 'test'), rigs, { scene: 'test' });

  it('rations SNAP_IN by quota and cooldown', () => {
    // Nine shocked exclamations: enough beats for the cooldown to lapse once,
    // so the quota (2) binds — not the scene length.
    const lines = Array.from({ length: 9 }, (_, i) => `MEL\n(shocked)\nNumber ${i + 1} what!`).join('\n\n');
    const shots = directed(`# T\n\nINT. A - DAY\n\n${lines}\n`);
    const snaps = shots.beats
      .map((b, i) => ({ camera: b.camera, i }))
      .filter((b) => b.camera === 'SNAP_IN');
    expect(snaps.length).toBe(DEFAULT_IDENTITY.editorial.snapIn.maxPerScene);
    // And the two snaps are separated by at least the cooldown.
    expect(snaps[1]!.i - snaps[0]!.i).toBeGreaterThanOrEqual(
      DEFAULT_IDENTITY.editorial.snapIn.cooldownBeats,
    );
  });

  it('stretches the pause after a shout and lands it on the target', () => {
    const shots = directed(
      `# T\n\nINT. A - DAY\n\nVERN\nFine.\n\nMEL\n(angry)\nThis is not fine!\n\n[BEAT 1000]\n\nVERN\nOk.\n`,
    );
    const pause = shots.beats.find((b) => b.kind === 'pause')!;
    expect(pause.ms).toBe(Math.round(1000 * DEFAULT_IDENTITY.editorial.rhythm.aftershockBoost));
    expect(pause.shot).toBe('CU');
    expect(pause.focus).toEqual(['vern']);
  });

  it('cuts a run of terse lines as close-ups', () => {
    const shots = directed(
      `# T\n\nINT. A - DAY\n\nMEL\nWhich one.\n\nVERN\nThe first.\n\nMEL\nNo.\n\nVERN\nYes.\n`,
    );
    const lines = shots.beats.filter((b) => b.kind === 'line');
    // From the second short line on, everything is a CU rally.
    expect(lines.slice(1).every((b) => b.shot === 'CU')).toBe(true);
  });
});

describe('propose and merge', () => {
  const base = (beats: object[]) =>
    ShotList.parse({
      scene: 'merge-test',
      cards: false,
      cast: [{ id: 'mel', rig: 'mel', mark: 'CENTER', flip: false, scale: 1.25, resting: 'DEADPAN' }],
      beats,
    });

  const line = (text: string, over: object = {}) => ({
    kind: 'line', speaker: 'mel', text, expression: 'DEADPAN', gesture: 'NONE',
    reactions: {}, shot: 'MID', focus: ['mel'], camera: 'HOLD', ...over,
  });

  it('keeps locked beats verbatim through a rerun', () => {
    const current = base([
      line('Morning.', { locked: true, shot: 'ECU', camera: 'PUSH_IN' }),
      line('Nothing else.'),
    ]);
    const proposed = base([line('Morning.'), line('Nothing else.', { shot: 'CU' })]);

    const { merged, keptLocked, droppedLocked } = mergeShotLists(current, proposed);
    expect(keptLocked).toBe(1);
    expect(droppedLocked).toEqual([]);
    const kept = merged.beats[0]! as { shot: string; camera: string; locked: boolean };
    expect(kept.shot).toBe('ECU');
    expect(kept.camera).toBe('PUSH_IN');
    expect(kept.locked).toBe(true);
    // The unlocked beat takes the proposal.
    expect((merged.beats[1] as { shot: string }).shot).toBe('CU');
  });

  it('matches locked beats by content, not index', () => {
    const current = base([line('Morning.', { locked: true, shot: 'ECU' })]);
    // A new line inserted above shifts the index; the lock must follow the text.
    const proposed = base([line('One new thing first.'), line('Morning.')]);
    const { merged, keptLocked } = mergeShotLists(current, proposed);
    expect(keptLocked).toBe(1);
    expect((merged.beats[1] as { shot: string }).shot).toBe('ECU');
  });

  it('reports locked beats the new script no longer contains', () => {
    const current = base([line('This line got cut.', { locked: true })]);
    const proposed = base([line('A different line.')]);
    const { droppedLocked, merged } = mergeShotLists(current, proposed);
    expect(droppedLocked.length).toBe(1);
    expect(merged.beats.length).toBe(1);
  });

  it('diffs proposals into human-scale change notes', () => {
    const current = base([line('Same.'), line('Old.')]);
    const proposed = base([line('Same.'), line('Old.', { shot: 'CU' }), line('New.')]);
    const diff = diffShotLists(current, proposed);
    expect(diff.map((d) => d.change)).toEqual(['changed', 'added']);
  });
});
