import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProductionReviewSnapshot } from '../src/pipeline/preflight-review.ts';
import {
  appendPreflightWarningReview,
  latestPreflightWarningReview,
  preflightWarningFingerprint,
  readPreflightWarningReviews,
  warningAcknowledgementIsCurrent,
} from '../src/pipeline/preflight-review.ts';
import { PRODUCTION_PREFLIGHT_POLICY, type ProductionPreflightReport } from '../src/pipeline/preflight.ts';
import { sceneDir } from '../src/core/paths.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';

const scenes: string[] = [];
afterAll(async () => {
  for (const scene of scenes) await fs.rm(sceneDir(scene), { recursive: true, force: true });
});

function report(message = 'audition this conversion'): ProductionPreflightReport {
  return {
    ok: true,
    productionBlocked: false,
    renderEndpointBlocked: false,
    policy: PRODUCTION_PREFLIGHT_POLICY,
    notes: [{ code: 'voice-review', level: 'warn', blocking: false, message }],
  };
}

function snapshot(scene: string): ProductionReviewSnapshot {
  return {
    shots: {
      scene, seed: 1, fps: 24, characterFps: 12, width: 1280, height: 720,
      set: null, cards: false, title: null, subtitle: null, cast: [], beats: [],
    },
    dialogue: null,
    animation: { schemaVersion: 1, scene, revision: 1, layers: [], tracks: [], segments: [], events: [] },
    setDescriptor: null,
    identity: DEFAULT_IDENTITY,
    rigs: new Map(),
    soundtrackManifest: null,
  } as ProductionReviewSnapshot;
}

describe('preflight warning review evidence', () => {
  it('is content-bound, append-only, and becomes stale after a creative change', async () => {
    const scene = `test-preflight-review-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    scenes.push(scene);
    const current = snapshot(scene);
    const first = await appendPreflightWarningReview(scene, report(), current, 'creator');
    expect(warningAcknowledgementIsCurrent(report(), current, first)).toBe(true);
    expect(await appendPreflightWarningReview(scene, report(), current, 'creator')).toEqual(first);
    expect(await readPreflightWarningReviews(scene)).toHaveLength(1);
    expect((await latestPreflightWarningReview(scene))?.id).toBe(first.id);

    const changed = structuredClone(current) as ProductionReviewSnapshot;
    changed.shots.seed = 2;
    expect(preflightWarningFingerprint(report(), changed)).not.toBe(first.fingerprint);
    expect(warningAcknowledgementIsCurrent(report(), changed, first)).toBe(false);
    const second = await appendPreflightWarningReview(scene, report(), changed, 'creator');
    expect(second.id).not.toBe(first.id);
    expect(await readPreflightWarningReviews(scene)).toHaveLength(2);
    expect(path.basename(sceneDir(scene))).toBe(scene);
  });
});
