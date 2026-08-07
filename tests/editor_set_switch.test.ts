import { describe, expect, it } from 'vitest';
import type { PropReferenceIssue, SetFit, ShotList } from '../ui/src/types.ts';
import {
  applySetRepairs, planSetRepairs, retargetOne, unresolvedIssues, unresolvedText,
} from '../ui/src/editor/setSwitch.ts';

function issue(over: Partial<PropReferenceIssue> = {}): PropReferenceIssue {
  return {
    reference: 'desk',
    verb: 'tap',
    beatIndex: 0,
    actionIndex: 0,
    actionType: 'tap',
    field: 'target',
    actorId: null,
    label: 'Brent taps the desk twice.',
    status: 'missing',
    detail: '"dive-bar" has no "desk"',
    substitutes: [],
    ...over,
  };
}

const shots = {
  scene: 'switch-test',
  set: 'office',
  cast: [
    { id: 'brent', rig: 'brent', mark: 'CENTER', flip: false, scale: 1.25, resting: 'NEUTRAL' },
    { id: 'paul', rig: 'paul', mark: 'LEFT', flip: false, scale: 1.25, resting: 'NEUTRAL', pose: 'SIT', seat: 'chair-left' },
  ],
  beats: [
    {
      id: 'action-1', kind: 'action', text: 'Brent taps the desk twice.', ms: 1300,
      stage: [
        { type: 'tap', actor: 'brent', target: 'desk', count: 2 },
        { type: 'look', actor: 'paul', direction: 'left' },
      ],
      purpose: 'action', shot: 'MID', focus: ['brent'], camera: 'HOLD', reactions: {},
    },
  ],
} as unknown as ShotList;

describe('planSetRepairs', () => {
  it('repoints a reference when the set offers exactly one stand-in', () => {
    const fit: SetFit = {
      references: 1,
      issues: [issue({ substitutes: [{ reference: 'bar-counter', label: 'Bar counter', prop: 'bar-counter' }] })],
    };
    expect(planSetRepairs(fit)).toMatchObject([{ to: 'bar-counter' }]);
    expect(unresolvedIssues(fit)).toEqual([]);
  });

  it('leaves a choice between several props to the creator', () => {
    const fit: SetFit = {
      references: 1,
      issues: [issue({
        substitutes: [
          { reference: 'desk', label: 'Desk', prop: 'desk' },
          { reference: 'monitor', label: 'Monitor', prop: 'monitor' },
        ],
      })],
    };
    expect(planSetRepairs(fit)).toEqual([]);
    expect(unresolvedIssues(fit)).toHaveLength(1);
    expect(unresolvedText(fit.issues[0]!)).toContain('choose one');
  });

  it('never invents a repair when nothing in the set can take the reference', () => {
    // Dropping the business instead would be an invalid shot list, not a smaller
    // change: an action beat with prose and nothing staged fails to compile.
    const fit: SetFit = { references: 1, issues: [issue()] };
    expect(planSetRepairs(fit)).toEqual([]);
    expect(unresolvedText(fit.issues[0]!)).toContain('rewrite the beat');
  });

  it('ignores a substitute that has no usable reference to write', () => {
    const fit: SetFit = {
      references: 1,
      issues: [issue({ substitutes: [{ reference: null, label: 'Stool', prop: 'stool' }] })],
    };
    expect(planSetRepairs(fit)).toEqual([]);
    expect(unresolvedIssues(fit)).toHaveLength(1);
  });
});

describe('applySetRepairs', () => {
  it('rewrites only the action it names, keeping the beat, its text and its neighbours', () => {
    const repairs = planSetRepairs({
      references: 1,
      issues: [issue({ substitutes: [{ reference: 'bar-counter', label: 'Bar counter', prop: 'bar-counter' }] })],
    });
    const beat = applySetRepairs(shots, repairs).beats[0]!;

    expect(beat.kind === 'action' && beat.text).toBe('Brent taps the desk twice.');
    expect(beat.kind === 'action' && beat.stage).toEqual([
      { type: 'tap', actor: 'brent', target: 'bar-counter', count: 2 },
      { type: 'look', actor: 'paul', direction: 'left' },
    ]);
    // The original is untouched — this is an ordinary shot-list edit.
    const originalAction = shots.beats[0]!.kind === 'action' ? shots.beats[0]!.stage![0] : null;
    expect(originalAction?.type === 'tap' ? originalAction.target : null).toBe('desk');
  });

  it('repoints a cast member\'s initial seat without touching anyone else', () => {
    const next = applySetRepairs(shots, [{
      issue: issue({
        reference: 'chair-left', verb: 'start the scene sitting on', field: 'seat',
        beatIndex: null, actionIndex: null, actionType: null, actorId: 'paul', label: 'paul',
      }),
      to: 'booth-left',
      text: '',
    }]);
    expect(next.cast[1]).toMatchObject({ id: 'paul', seat: 'booth-left', pose: 'SIT' });
    expect(next.cast[0]).toEqual(shots.cast[0]);
  });

  it('retargets one reference at a time for the per-issue buttons', () => {
    const next = retargetOne(shots, issue(), 'monitor');
    const repairedAction = next.beats[0]!.kind === 'action' ? next.beats[0]!.stage![0] : null;
    expect(repairedAction?.type === 'tap' ? repairedAction.target : null).toBe('monitor');
  });

  it('is a no-op with nothing to repair', () => {
    expect(applySetRepairs(shots, [])).toBe(shots);
  });
});
