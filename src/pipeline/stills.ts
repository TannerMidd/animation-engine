import fs from 'node:fs/promises';
import path from 'node:path';
import { OUT_DIR, sceneDir } from '../core/paths.ts';
import { compileScene, DEFAULT_PLAN, type ActorPlan, type ScenePlan } from '../compile/index.ts';
import { loadRig, listRigs, type LoadedRig } from '../cast/store.ts';
import { renderFrames } from '../render/capture.ts';
import { encodeMp4 } from '../render/encode.ts';

/**
 * One-off character renders: a still frame, or a short idling clip.
 *
 * These answer "what does this puppet actually look like in motion" without
 * directing a scene, and they run through the same compile-and-capture path a
 * real render does — a still that lied about the renderer would be worse than
 * none.
 */

/** Default set coordinate space: 1:1 with a 720p frame, ground near the bottom. */
export const STAGE = { w: 1280, h: 720, ground: 700 };

/** Spread actors evenly across the frame, all facing centre. */
export function autoStage(names: string[], scale: number): ActorPlan[] {
  return names.map((name, i) => {
    const slot = (i + 1) / (names.length + 1);
    const x = STAGE.w * slot;
    return {
      id: name,
      rig: name,
      x,
      y: STAGE.ground,
      scale,
      flip: x > STAGE.w / 2,
      pose: 'IDLE',
      expression: 'NEUTRAL',
    };
  });
}

export async function loadRigsFor(names: string[]): Promise<Map<string, LoadedRig>> {
  const map = new Map<string, LoadedRig>();
  for (const n of new Set(names)) {
    if (!map.has(n)) map.set(n, await loadRig(n));
  }
  return map;
}

async function resolveNames(names: string[] | undefined): Promise<string[]> {
  const resolved = names?.length ? names : await listRigs();
  if (!resolved.length) throw new Error('no characters — run: anim cast new steve');
  return resolved;
}

export interface StillOptions {
  names?: string[];
  pose?: string;
  expression?: string;
  scale?: number;
  seed?: number;
}

export interface StillResult {
  /** PNG under out/, named still-<names>.png. */
  file: string;
  names: string[];
}

export async function renderStill(opts: StillOptions = {}): Promise<StillResult> {
  const names = await resolveNames(opts.names);
  const rigs = await loadRigsFor(names);
  const actors = autoStage(names, opts.scale ?? 1.3);

  const pose = opts.pose ?? 'IDLE';
  const expression = opts.expression ?? 'NEUTRAL';
  for (const a of actors) {
    a.pose = pose;
    a.expression = expression;
  }

  const plan: ScenePlan = {
    scene: `still-${names.join('-')}`,
    fps: DEFAULT_PLAN.fps,
    characterFps: DEFAULT_PLAN.characterFps,
    width: STAGE.w,
    height: STAGE.h,
    seed: opts.seed ?? DEFAULT_PLAN.seed,
    durationSec: 1 / DEFAULT_PLAN.fps,
    camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
    set: null,
    audio: null,
    actors,
  };

  const ir = compileScene(plan, rigs);
  const dir = sceneDir(plan.scene);
  await fs.mkdir(dir, { recursive: true });

  const result = await renderFrames({ ir, rigs, dir, background: '#2b2f36' });
  const out = path.join(OUT_DIR, `${plan.scene}.png`);
  await fs.copyFile(path.join(result.framesDir, '000000.png'), out);
  return { file: out, names };
}

export interface IdleOptions {
  names?: string[];
  seconds?: number;
  fps?: number;
  characterFps?: number;
  scale?: number;
  seed?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface IdleResult {
  /** MP4 under the clip's own scene dir, out/idle-<names>/. */
  file: string;
  names: string[];
  captured: number;
  total: number;
}

export async function renderIdle(opts: IdleOptions = {}): Promise<IdleResult> {
  const names = await resolveNames(opts.names);
  const rigs = await loadRigsFor(names);
  const seconds = opts.seconds ?? 6;
  const fps = opts.fps ?? DEFAULT_PLAN.fps;
  const characterFps = opts.characterFps ?? DEFAULT_PLAN.characterFps;

  const plan: ScenePlan = {
    scene: `idle-${names.join('-')}`,
    fps,
    characterFps,
    width: STAGE.w,
    height: STAGE.h,
    seed: opts.seed ?? DEFAULT_PLAN.seed,
    durationSec: seconds,
    camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
    set: null,
    audio: null,
    actors: autoStage(names, opts.scale ?? 1.3),
  };

  const ir = compileScene(plan, rigs);
  const dir = sceneDir(plan.scene);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.ir.json'), JSON.stringify(ir, null, 2), 'utf8');

  const result = await renderFrames({
    ir,
    rigs,
    dir,
    background: '#2b2f36',
    onProgress: opts.onProgress,
  });

  const out = path.join(dir, `${plan.scene}.mp4`);
  await encodeMp4({ framesDir: result.framesDir, fps, out });
  return { file: out, names, captured: result.captured, total: result.total };
}
