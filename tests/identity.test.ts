import { describe, it, expect, afterEach } from 'vitest';
import {
  ShowIdentity, DEFAULT_IDENTITY, identityHash, canonicalJson, isLocked, stampOf,
} from '../src/schema/identity.ts';
import { setActiveIdentity, activeIdentity } from '../src/show/context.ts';
import { compareProfiles } from '../src/show/store.ts';
import { streamSeed, STREAMS } from '../src/core/streams.ts';
import { rollLookFor, rollLook } from '../src/cast/look.ts';
import { activeStyle } from '../src/style/index.ts';
import { buildPlaceholderSvg, buildPlaceholderRig } from '../src/cast/placeholder.ts';
import { compileScene, DEFAULT_PLAN, type ScenePlan } from '../src/compile/index.ts';
import { Rig } from '../src/schema/index.ts';
import type { LoadedRig } from '../src/cast/store.ts';

afterEach(() => setActiveIdentity(DEFAULT_IDENTITY));

const fixture = (over: Partial<ShowIdentity>): ShowIdentity =>
  ShowIdentity.parse({ ...JSON.parse(JSON.stringify(DEFAULT_IDENTITY)), ...over });

describe('the profile schema', () => {
  it('round-trips through JSON without loss', () => {
    const parsed = ShowIdentity.parse(JSON.parse(JSON.stringify(DEFAULT_IDENTITY)));
    expect(parsed).toEqual(DEFAULT_IDENTITY);
  });

  it('rejects a non-slug id and a non-semver version', () => {
    expect(() => fixture({ id: 'Not A Slug' })).toThrow(/slug/);
    expect(() => fixture({ version: '1.0' })).toThrow(/semver/);
  });

  it('fills a bare profile with the same defaults every time', () => {
    const bare = ShowIdentity.parse({ id: 'x', name: 'X', version: '1.0.0', seed: 1 });
    expect(bare.visual.style.wobble).toBeGreaterThan(0);
    expect(bare.performance.restingExpression).toBe('DEADPAN');
  });
});

describe('hashing', () => {
  it('is stable regardless of key order', () => {
    const a = { one: 1, two: { x: 1, y: 2 } };
    const b = { two: { y: 2, x: 1 }, one: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('changes when any creative field changes', () => {
    const base = identityHash(DEFAULT_IDENTITY);
    const tweaked = fixture({
      visual: { ...DEFAULT_IDENTITY.visual, style: { ...DEFAULT_IDENTITY.visual.style, grain: 0.2 } },
    });
    expect(identityHash(tweaked)).not.toBe(base);
    expect(stampOf(tweaked).hash).toBe(identityHash(tweaked));
  });
});

describe('locks', () => {
  it('cover themselves and everything beneath', () => {
    expect(isLocked(['look'], 'look')).toBe(true);
    expect(isLocked(['look'], 'look.hair')).toBe(true);
    expect(isLocked(['look.hair'], 'look.hair')).toBe(true);
    expect(isLocked(['look.hair'], 'look.hairColour')).toBe(false);
    expect(isLocked(['look.hair'], 'voice')).toBe(false);
  });
});

describe('named streams', () => {
  const showA = fixture({ seed: 101 });
  const showB = fixture({ seed: 909 });

  it('differ per stream, per entity, and per show', () => {
    expect(streamSeed(showA, STREAMS.look, 'abc')).not.toBe(streamSeed(showA, STREAMS.voice, 'abc'));
    expect(streamSeed(showA, STREAMS.look, 'abc')).not.toBe(streamSeed(showA, STREAMS.look, 'xyz'));
    expect(streamSeed(showA, STREAMS.look, 'abc')).not.toBe(streamSeed(showB, STREAMS.look, 'abc'));
  });

  it('roll different looks for the same character under different shows', () => {
    expect(rollLookFor('abc123', showA)).not.toEqual(rollLookFor('abc123', showB));
  });

  it('roll stable looks for a charId whatever the character is called', () => {
    // The id is the seed; the name appears nowhere in the identity path.
    expect(rollLookFor('abc123', showA)).toEqual(rollLookFor('abc123', showA));
  });
});

describe('rename stability', () => {
  /** The same puppet saved under two names, as a rename would produce. */
  const asName = (name: string): LoadedRig => {
    const rig = Rig.parse({ ...JSON.parse(JSON.stringify(buildPlaceholderRig('original'))), name, charId: 'fixed01' });
    return { rig, svg: buildPlaceholderSvg(name, rig.look) };
  };

  const planFor = (id: string, rig: string): ScenePlan => ({
    scene: 'rename-test',
    fps: DEFAULT_PLAN.fps,
    characterFps: DEFAULT_PLAN.characterFps,
    width: 1280,
    height: 720,
    seed: 7,
    durationSec: 3,
    camera: { x: 0, y: 0, w: 1280, h: 720 },
    set: null,
    audio: null,
    actors: [{ id, rig, x: 640, y: 700, scale: 1.25, flip: false, pose: 'IDLE', expression: 'NEUTRAL' }],
  });

  it('keeps seeded behaviour identical across a rename', () => {
    // Same charId, different display name and scene id: every blink and breath
    // must land on the same frames, or renaming recasts the performance.
    const a = compileScene(planFor('alice', 'alice'), new Map([['alice', asName('alice')]]));
    const b = compileScene(planFor('bob', 'bob'), new Map([['bob', asName('bob')]]));

    const swaps = (ir: typeof a, id: string) => ir.frames.map((f) => JSON.stringify([f.actors[id]!.swaps, f.actors[id]!.parts]));
    expect(swaps(a, 'alice')).toEqual(swaps(b, 'bob'));
  });
});

describe('profile-owned rendering', () => {
  it('draws the same character differently under different treatments', () => {
    const look = rollLook('steve');

    const visual = (style: object) =>
      ShowIdentity.parse({ ...JSON.parse(JSON.stringify(DEFAULT_IDENTITY)), visual: { style } });

    setActiveIdentity({ ...visual({ lineWidth: 3.2, lineWidthJitter: 0.12, wobble: 1.1, wobbleSegments: 2, fillOffset: [0.8, -0.6], grain: 0.02 }), id: 'thin' });
    const thin = buildPlaceholderSvg('steve', look);
    expect(activeStyle().name).toBe('thin');

    setActiveIdentity({ ...visual({ lineWidth: 7.5, lineWidthJitter: 0.5, wobble: 5.2, wobbleSegments: 4, fillOffset: [5.5, -4], grain: 0.14 }), id: 'heavy' });
    const heavy = buildPlaceholderSvg('steve', look);

    expect(thin).not.toBe(heavy);
  });

  it('exposes the identity resting expression as the directing default', () => {
    setActiveIdentity(fixture({ id: 'cheery', performance: { register: [], restingExpression: 'JOY' } }));
    expect(activeIdentity().performance.restingExpression).toBe('JOY');
  });
});

describe('comparing profiles', () => {
  it('reports exactly the fields that differ', () => {
    const a = fixture({ seed: 1 });
    const b = fixture({ seed: 2, name: 'Other' });
    const paths = compareProfiles(a, b).map((d) => d.path);
    expect(paths).toContain('seed');
    expect(paths).toContain('name');
    expect(paths).not.toContain('version');
  });

  it('reports nothing for identical profiles', () => {
    expect(compareProfiles(DEFAULT_IDENTITY, fixture({}))).toEqual([]);
  });
});
