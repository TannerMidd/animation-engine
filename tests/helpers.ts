import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import { DEFAULT_PLAN, type ScenePlan } from '../src/compile/index.ts';

/**
 * Build rigs in memory rather than reading from cast/.
 *
 * Tests must not depend on which characters happen to exist on disk, or they
 * start passing and failing based on what someone was last experimenting with.
 */
export function testRigs(names: string[]): Map<string, LoadedRig> {
  const map = new Map<string, LoadedRig>();
  for (const name of names) {
    map.set(name, { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) });
  }
  return map;
}

export function testPlan(names: string[], overrides: Partial<ScenePlan> = {}): ScenePlan {
  return {
    scene: 'test',
    fps: DEFAULT_PLAN.fps,
    characterFps: DEFAULT_PLAN.characterFps,
    width: 640,
    height: 360,
    seed: 1,
    durationSec: 1,
    camera: { x: 0, y: 0, w: 1280, h: 720 },
    set: null,
    audio: null,
    actors: names.map((name, i) => ({
      id: name,
      rig: name,
      x: (1280 * (i + 1)) / (names.length + 1),
      y: 700,
      scale: 1.3,
      flip: false,
      pose: 'IDLE',
      expression: 'NEUTRAL',
    })),
    ...overrides,
  };
}

export async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `anim-${label}-`));
}

export function sha1(buf: Buffer | string): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Hash every PNG in a frames directory, in order. */
export async function hashFrames(dir: string): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const hashes: string[] = [];
  for (const f of files) hashes.push(sha1(await fs.readFile(path.join(dir, f))));
  return hashes;
}
