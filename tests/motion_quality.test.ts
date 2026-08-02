import { describe, expect, it } from 'vitest';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import { autoDirect } from '../src/direct/index.ts';
import {
  evaluateProductionPreflight,
  type ProductionPreflightInput,
} from '../src/pipeline/preflight.ts';
import { parseScript } from '../src/parse/index.ts';
import { AnimationDocument } from '../src/schema/animation.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { ShotList, type ShotList as ShotListType } from '../src/schema/script.ts';
import { SetDescriptor } from '../src/sets/schema.ts';

function loaded(name: string, gestureBias = 1, fidgetAmp = 2): LoadedRig {
  const rig = buildPlaceholderRig(name);
  rig.acting = { reactionMs: 280, gestureBias, fidgetAmp };
  return { rig, svg: buildPlaceholderSvg(name) };
}

function preflightInput(
  shots: ShotListType,
  animation: ProductionPreflightInput['animation'] = null,
  setDescriptor: ProductionPreflightInput['setDescriptor'] = null,
): ProductionPreflightInput {
  return {
    scene: shots.scene,
    shots,
    identity: DEFAULT_IDENTITY,
    rigs: new Map([['alice', loaded('alice')]]),
    knownSets: new Set(setDescriptor ? [setDescriptor.name] : []),
    setDescriptor,
    dialogue: null,
    animation,
    soundtrack: 'current',
  };
}

function pauseScene(set: string | null = null): ShotListType {
  return ShotList.parse({
    scene: 'motion-quality',
    cards: false,
    set,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER' }],
    beats: [{ kind: 'pause', id: 'pause-1', ms: 8_000 }],
  });
}

describe('generated motion quality', () => {
  it('uses per-character gesture history and acting profiles deterministically', () => {
    const dialogue = Array.from({ length: 18 }, (_, index) => (
      `ALICE\nThis ordinary procedural sentence number ${index + 1} has enough words to carry a gesture.`
    )).join('\n\n');
    const screenplay = parseScript(`# Gesture history\n\nINT. OFFICE - DAY\n\n${dialogue}\n`, 'gesture-history');
    const directWith = (gestureBias: number, fidgetAmp: number) => autoDirect(
      screenplay,
      new Map([['alice', loaded('alice', gestureBias, fidgetAmp)]]),
      { scene: 'gesture-history', seed: 77 },
    ).beats.flatMap((beat) => beat.kind === 'line' ? [beat.gesture] : []);

    const restrained = directWith(0.5, 0);
    const active = directWith(1.6, 6);

    expect(directWith(1.6, 6)).toEqual(active);
    expect(active.some((gesture) => gesture !== 'TALK' && gesture !== 'NONE')).toBe(true);
    expect(active.slice(1).every((gesture, index) => gesture !== active[index])).toBe(true);
    expect(active.filter((gesture) => gesture !== 'NONE').length)
      .toBeGreaterThan(restrained.filter((gesture) => gesture !== 'NONE').length);
  });

  it('warns when an edited shot list repeats a pose or generic talk motion excessively', () => {
    const beats = [
      ...Array.from({ length: 3 }, (_, index) => ({
        kind: 'line' as const,
        id: `point-${index}`,
        speaker: 'alice',
        text: `Point line ${index}.`,
        expression: 'NEUTRAL',
        gesture: 'POINT',
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        kind: 'line' as const,
        id: `talk-${index}`,
        speaker: 'alice',
        text: `Talk line ${index}.`,
        expression: 'NEUTRAL',
        gesture: index % 2 === 0 ? 'TALK_A' : 'TALK_B',
      })),
    ];
    const shots = ShotList.parse({
      scene: 'repetition-lint', cards: false,
      cast: [{ id: 'alice', rig: 'alice', mark: 'CENTER' }],
      beats,
    });
    const report = evaluateProductionPreflight(preflightInput(shots));
    const codes = new Set(report.notes.map((item) => item.code));

    expect(codes.has('motion-gesture-repetition')).toBe(true);
    expect(codes.has('motion-generic-repetition')).toBe(true);
    expect(report.notes.find((item) => item.code === 'motion-generic-repetition')?.level).toBe('warn');
  });
});

describe('walkable and interaction preflight', () => {
  const boundedSet = () => SetDescriptor.parse({
    name: 'bounded',
    layout: {
      walkable: { x: 200, y: 600, width: 600, height: 120 },
    },
    layers: {
      mid: [{ id: 'hero-mug', prop: 'mug', x: 500, y: 650 }],
    },
  });

  it('rejects invalid authored walkable rectangles', () => {
    expect(() => SetDescriptor.parse({
      name: 'bad-floor',
      layout: { walkable: { x: 1200, y: 600, width: 200, height: 120 } },
    })).toThrow(/walkable area must stay inside/i);
  });

  it('blocks root paths outside the set floor and warns on long accidental part holds', () => {
    const shots = pauseScene('bounded');
    const animation = AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      tracks: [
        {
          id: 'root-outside', layerId: 'manual', actorId: 'alice', channel: 'root.position',
          keys: [{ id: 'root-key', time: { kind: 'absolute', ms: 0 }, value: [900, 650] }],
        },
        {
          id: 'held-head', layerId: 'manual', actorId: 'alice', channel: 'part.transform', partId: 'head',
          keys: [
            { id: 'head-a', time: { kind: 'absolute', ms: 0 }, value: { rot: 4, x: 0, y: 0, scale: 1 }, interpolation: 'hold' },
            { id: 'head-b', time: { kind: 'absolute', ms: 4_500 }, value: { rot: 0, x: 0, y: 0, scale: 1 } },
          ],
        },
      ],
    });
    const report = evaluateProductionPreflight(preflightInput(shots, animation, boundedSet()));

    expect(report.notes.some((item) => item.code === 'animation-outside-walkable' && item.blocking)).toBe(true);
    expect(report.notes.some((item) => item.code === 'animation-long-pose-hold' && item.level === 'warn')).toBe(true);
  });

  it('validates animation contacts against declared set-instance handles', () => {
    const shots = pauseScene('bounded');
    const makeAnimation = (targetHandleId: string) => AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      events: [{
        id: 'mug-contact', layerId: 'manual', kind: 'contact',
        actorId: 'alice', handleId: 'wrist_R', targetId: 'hero-mug', targetHandleId,
        at: { kind: 'absolute', ms: 1_000 },
      }],
    });

    const invalid = evaluateProductionPreflight(preflightInput(shots, makeAnimation('missing'), boundedSet()));
    expect(invalid.notes.some((item) => item.code === 'animation-contact-invalid' && item.blocking)).toBe(true);

    const valid = evaluateProductionPreflight(preflightInput(shots, makeAnimation('rim'), boundedSet()));
    expect(valid.notes.some((item) => item.code === 'animation-contact-invalid')).toBe(false);
  });
});
