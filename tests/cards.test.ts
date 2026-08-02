import { describe, it, expect } from 'vitest';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { ShotList } from '../src/schema/script.ts';
import { compileShotList, cardTiming } from '../src/compile/scene.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LineTiming } from '../src/voice/index.ts';
import type { LoadedRig } from '../src/cast/store.ts';

/**
 * Cards are packaging, not time.
 *
 * The roadmap's exact acceptance criterion: removing the card frames from a
 * cards-on render must leave the same performance sequence a cards-off render
 * produces — byte for byte. Anything less means the title card is quietly
 * reaching into the acting.
 */

const rigFor = (name: string): LoadedRig => ({
  rig: buildPlaceholderRig(name),
  svg: buildPlaceholderSvg(name),
});

const shotsFor = (cards: boolean) =>
  ShotList.parse({
    scene: 'cards-test',
    cards,
    title: 'The Update',
    subtitle: 'INT. Room - Day',
    cast: [{ id: 'mel', rig: 'mel', mark: 'CENTER', flip: false, scale: 1.25, resting: 'DEADPAN' }],
    beats: [
      {
        kind: 'line', speaker: 'mel', text: 'It already has.', expression: 'DEADPAN',
        gesture: 'NONE', reactions: {}, shot: 'MID', focus: ['mel'], camera: 'HOLD',
      },
      { kind: 'pause', ms: 1200, reactions: {}, shot: 'CU', focus: ['mel'], camera: 'HOLD' },
    ],
  });

const timings = new Map<number, LineTiming>([
  [0, { audio: '', durationMs: 1400, cues: [{ ms: 0, shape: 'C' }] }],
]);

const rigs = new Map([['mel', rigFor('mel')]]);

describe('card splicing', () => {
  const withCards = compileShotList(shotsFor(true), rigs, timings);
  const without = compileShotList(shotsFor(false), rigs, timings);
  const timing = cardTiming({ cards: true, fps: 24 });

  it('prepends and appends exactly the profile\'s card frames', () => {
    expect(withCards.ir.frames.length).toBe(
      without.ir.frames.length + timing.titleFrames + timing.endFrames,
    );
    expect(withCards.ir.frames[0]!.card).toBe('title');
    expect(withCards.ir.frames[withCards.ir.frames.length - 1]!.card).toBe('end');
  });

  it('leaves the performance byte-identical: cards-on minus cards === cards-off', () => {
    const body = withCards.ir.frames.slice(
      timing.titleFrames,
      withCards.ir.frames.length - timing.endFrames,
    );
    expect(JSON.stringify(body)).toBe(JSON.stringify(without.ir.frames));
  });

  it('cuts hard — the frame before the end card is a full scene frame', () => {
    const lastBody = withCards.ir.frames[withCards.ir.frames.length - timing.endFrames - 1]!;
    expect(lastBody.card).toBeUndefined();
    expect(Object.keys(lastBody.actors)).toContain('mel');
  });

  it('shifts audio placements by exactly the title duration', () => {
    expect(withCards.audio[0]!.startMs).toBe(without.audio[0]!.startMs + timing.titleMs);
    expect(withCards.durationMs).toBe(without.durationMs + timing.titleMs + timing.endMs);
  });

  it('shifts beat starts the same way, for the timeline UI', () => {
    expect(withCards.beatStarts[0]).toBe(timing.titleMs);
    expect(without.beatStarts[0]).toBe(0);
  });

  it('embeds the card art once in meta, not per frame', () => {
    expect(withCards.ir.meta.cards?.titleSvg).toContain('viewBox="0 0 1280 720"');
    expect(withCards.ir.meta.cards?.endSvg).toContain(DEFAULT_IDENTITY.visual.cards.paper);
    const asJson = JSON.stringify(withCards.ir.frames);
    expect(asJson).not.toContain('viewBox="0 0 1280 720'.slice(0, 12));
  });

  it('card frames show no actors and a full-stage camera', () => {
    const title = withCards.ir.frames[0]!;
    expect(title.actors).toEqual({});
    expect(title.camera).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
});
