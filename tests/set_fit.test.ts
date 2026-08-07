import { describe, expect, it } from 'vitest';
import { loadSet } from '../src/sets/index.ts';
import { setFit } from '../src/sets/interaction.ts';
import { ShotList } from '../src/schema/script.ts';

/** A scene whose only demand on the set is that someone can tap a desk. */
function tapTheDesk(reference = 'desk') {
  return ShotList.parse({
    scene: 'fit-test',
    set: null,
    cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER' }],
    beats: [
      {
        kind: 'action',
        text: 'Brent taps the desk twice.',
        ms: 1300,
        stage: [{ type: 'tap', actor: 'brent', target: reference, count: 2 }],
      },
    ],
  });
}

describe('setFit', () => {
  it('passes a scene the set can host, and names the beat when it cannot', async () => {
    const shots = tapTheDesk();

    const office = setFit(shots, await loadSet('office'));
    expect(office.references).toBe(1);
    expect(office.issues).toEqual([]);

    const bar = setFit(shots, await loadSet('dive-bar'));
    expect(bar.references).toBe(1);
    expect(bar.issues).toHaveLength(1);
    expect(bar.issues[0]).toMatchObject({
      reference: 'desk',
      verb: 'tap',
      status: 'missing',
      beatIndex: 0,
      label: 'Brent taps the desk twice.',
    });
    expect(bar.issues[0]!.detail).toContain('dive-bar');
  });

  it('offers the props in the set that could take the reference instead', async () => {
    // Nothing in the office is called a whiteboard, but two things there can be touched.
    const office = setFit(tapTheDesk('whiteboard'), await loadSet('office'));
    const substitutes = office.issues[0]!.substitutes;
    expect(substitutes.map((option) => option.prop).sort()).toEqual(['desk', 'monitor']);

    // Every offer names itself the way the compiler will read it back.
    for (const option of substitutes) {
      expect(option.reference).toBeTruthy();
      expect(setFit(tapTheDesk(option.reference!), await loadSet('office')).issues).toEqual([]);
    }
  });

  it('offers nothing rather than a guess when the set has no surface to interact with', async () => {
    // dive-bar is furnished but none of its props declare interaction geometry,
    // so the honest answer is "this set cannot host that beat", not a substitute.
    const bar = setFit(tapTheDesk(), await loadSet('dive-bar'));
    expect(bar.issues[0]!.substitutes).toEqual([]);
  });

  it('keeps the table/desk alias working, so a fit answer matches what compiles', async () => {
    const office = await loadSet('office');
    expect(setFit(tapTheDesk('the table'), office).issues).toEqual([]);
    expect(setFit(tapTheDesk('the vending machine'), office).issues).toHaveLength(1);
  });

  it('reports every reference as missing on a bare stage rather than only the first', async () => {
    const shots = ShotList.parse({
      scene: 'fit-test',
      set: null,
      cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER' }],
      beats: [
        {
          kind: 'action',
          text: 'Brent taps the desk.',
          ms: 1300,
          stage: [{ type: 'tap', actor: 'brent', target: 'desk' }],
        },
        {
          kind: 'action',
          text: 'Brent sits.',
          ms: 1300,
          stage: [{ type: 'sit', actor: 'brent', seat: 'chair' }],
        },
      ],
    });

    const bare = setFit(shots, null);
    expect(bare.references).toBe(2);
    expect(bare.issues.map((issue) => issue.status)).toEqual(['missing', 'missing']);
    expect(bare.issues.every((issue) => issue.substitutes.length === 0)).toBe(true);
  });

  it('rejects a prop that resolves but cannot do the job the beat asks of it', async () => {
    const shots = ShotList.parse({
      scene: 'fit-test',
      set: null,
      cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER' }],
      beats: [
        {
          kind: 'action',
          text: 'Brent picks up the desk.',
          ms: 1300,
          stage: [{ type: 'pick_up', actor: 'brent', prop: 'desk' }],
        },
      ],
    });

    const issues = setFit(shots, await loadSet('office')).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ status: 'unusable', reference: 'desk' });
    expect(issues[0]!.detail).toMatch(/not portable/i);
  });

  it('holds initial staging to the stable-id rule the compiler enforces', async () => {
    const withKindReference = ShotList.parse({
      scene: 'fit-test',
      set: null,
      cast: [{ id: 'brent', rig: 'brent', mark: 'CENTER', pose: 'SIT', seat: 'stool' }],
      beats: [{ kind: 'pause', ms: 500 }],
    });

    // dive-bar has two stools: a kind reference cannot name one of them.
    const issues = setFit(withKindReference, await loadSet('dive-bar')).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ status: 'ambiguous', actorId: 'brent', beatIndex: null });
  });
});
