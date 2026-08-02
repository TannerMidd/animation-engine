import { describe, expect, it } from 'vitest';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import {
  autoDirect,
  SIGNATURE_MOVE_GLOBAL_COOLDOWN_BEATS,
} from '../src/direct/index.ts';
import { parseScript } from '../src/parse/index.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { ShotList } from '../src/schema/script.ts';

const rigFor = (name: string): LoadedRig => ({
  rig: buildPlaceholderRig(name),
  svg: buildPlaceholderSvg(name),
});
const rigs = new Map([['alice', rigFor('alice')], ['bob', rigFor('bob')]]);

function direct(source: string) {
  return autoDirect(parseScript(source, 'sequence'), rigs, { scene: 'sequence', seed: 31 });
}

function signature(beat: { shot: string; focus: string[] }): string {
  return `${beat.shot}|${[...beat.focus].sort().join(',')}`;
}

describe('sequence-level directing', () => {
  it('holds ordinary dialogue in planned coverage runs instead of recropping every line', () => {
    const lines = [
      ['ALICE', 'The inventory report is still missing.'],
      ['BOB', 'The loading dock has not replied.'],
      ['ALICE', 'The courier left without a signature.'],
      ['BOB', 'The office printer remains under review.'],
      ['ALICE', 'The replacement forms arrive next Thursday.'],
      ['BOB', 'The old forms expire before lunch.'],
      ['ALICE', 'The committee can discuss that tomorrow.'],
      ['BOB', 'The committee was dissolved this morning.'],
    ].map(([speaker, text]) => `${speaker}\n${text}`).join('\n\n');
    const source = `# Coverage\n\nINT. OFFICE - DAY\n\n${lines}\n`;
    const shots = direct(source);
    const dialogue = shots.beats.filter((beat) => beat.kind === 'line');
    const cuts = dialogue.slice(1).filter((beat, index) =>
      signature(beat) !== signature(dialogue[index]!));

    expect(dialogue[0]!.purpose).toBe('establishing');
    expect(dialogue.slice(1).every((beat) => beat.purpose === 'coverage')).toBe(true);
    expect(cuts.length).toBeLessThanOrEqual(2);
    expect(cuts.length).toBeLessThan(dialogue.length - 1);
    expect(dialogue.some((beat, index) => index > 0 && signature(beat) === signature(dialogue[index - 1]!))).toBe(true);
    expect(direct(source).beats.map(({ id, purpose, shot, focus, camera }) => ({ id, purpose, shot, focus, camera })))
      .toEqual(shots.beats.map(({ id, purpose, shot, focus, camera }) => ({ id, purpose, shot, focus, camera })));
  });

  it('cools down special shots and camera punctuation instead of repeating signatures', () => {
    const angry = Array.from({ length: 9 }, (_, index) =>
      `${index % 2 ? 'BOB' : 'ALICE'}\n(angry)\nEscalation number ${index + 1}!`).join('\n\n');
    const angryShots = direct(`# Escalation\n\nINT. OFFICE - DAY\n\n${angry}\n`).beats;
    const shakes = angryShots.flatMap((beat, index) => beat.camera === 'SHAKE' ? [index] : []);
    const extremeCloseups = angryShots.flatMap((beat, index) => beat.shot === 'ECU' ? [index] : []);

    expect(shakes).toHaveLength(1);
    expect(extremeCloseups.length).toBeLessThan(angryShots.length);
    expect(extremeCloseups.slice(1).every((at, index) => at - extremeCloseups[index]! >= 4)).toBe(true);

    const holds = Array.from({ length: 5 }, (_, index) =>
      `${index % 2 ? 'BOB' : 'ALICE'}\nThis procedural sentence has enough ordinary words.\n\n[BEAT 2000]`).join('\n\n');
    const heldShots = direct(`# Holds\n\nINT. OFFICE - DAY\n\n${holds}\n`).beats;
    const signatureMoves = heldShots.flatMap((beat, index) => beat.camera === 'HOLD'
      ? []
      : [{ index, camera: beat.camera, purpose: beat.purpose }]);
    const pushes = signatureMoves.filter((move) => move.camera === 'PUSH_IN');

    expect(pushes.length).toBeLessThanOrEqual(2);
    expect(pushes.slice(1).every((move, index) => move.index - pushes[index]!.index >= 5)).toBe(true);
    expect(signatureMoves.slice(1).every((move, index) =>
      move.index - signatureMoves[index]!.index >= SIGNATURE_MOVE_GLOBAL_COOLDOWN_BEATS)).toBe(true);
    expect(signatureMoves.every((move) => move.purpose === 'reaction' || move.purpose === 'emphasis')).toBe(true);

    const shocked = Array.from({ length: 9 }, (_, index) =>
      `ALICE\n(shocked)\nDiscovery number ${index + 1}?!`).join('\n\n');
    const snaps = direct(`# Discoveries\n\nINT. OFFICE - DAY\n\n${shocked}\n`).beats
      .flatMap((beat, index) => beat.camera === 'SNAP_IN' ? [index] : []);
    expect(snaps.length).toBe(DEFAULT_IDENTITY.editorial.snapIn.maxPerScene);
    expect(snaps.slice(1).every((at, index) =>
      at - snaps[index]! >= DEFAULT_IDENTITY.editorial.snapIn.cooldownBeats)).toBe(true);
  });

  it('covers spatial actions wide and contained acting on the performer', () => {
    const shots = direct(
      `# Action coverage\n\nINT. OFFICE - DAY\n\nALICE\nWe can begin the scheduled demonstration.\n\nBOB\nThe floor markings have been approved.\n\nAlice walks to stage right.\n\nAlice looks at Bob.\n`,
    );
    const actions = shots.beats.filter((beat) => beat.kind === 'action');

    expect(actions[0]).toMatchObject({
      purpose: 'action',
      shot: 'WIDE',
      focus: [],
      stage: [{ type: 'move', actor: 'alice' }],
    });
    expect(actions[1]).toMatchObject({
      purpose: 'action',
      shot: 'MID',
      focus: ['alice'],
      stage: [{ type: 'look', actor: 'alice', target: 'bob' }],
    });
  });

  it('backfills legacy beats with a coverage purpose', () => {
    const shots = ShotList.parse({
      scene: 'legacy-purpose',
      cards: false,
      cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER' }],
      beats: [{
        kind: 'line',
        speaker: 'alice',
        text: 'Legacy shot lists had no purpose.',
        expression: 'NEUTRAL',
        gesture: 'NONE',
      }],
    });

    expect(shots.beats[0]!.purpose).toBe('coverage');
  });
});
