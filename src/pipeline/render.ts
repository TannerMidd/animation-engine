import fs from 'node:fs/promises';
import path from 'node:path';
import { sceneDir } from '../core/paths.ts';
import { compileShotList } from '../compile/scene.ts';
import { renderFrames } from '../render/capture.ts';
import { encodeMp4 } from '../render/encode.ts';
import { resolveTimings, mixSceneAudio, type VoiceOptions } from './voices.ts';
import { outputPath } from './scene.ts';
import type { ShotList } from '../schema/script.ts';
import type { LoadedRig } from '../cast/store.ts';

/**
 * Full render: shot list -> MP4.
 *
 * Progress is reported per stage rather than as one opaque bar, because the
 * stages have wildly different costs — synthesis is GPU-bound, lipsync is
 * CPU-bound, frame capture is neither — and "it's been quiet for 90 seconds"
 * should never be ambiguous.
 */

export type RenderStage = 'voice' | 'lipsync' | 'compile' | 'audio' | 'frames' | 'encode';

export interface RenderProgress {
  stage: RenderStage;
  done: number;
  total: number;
  message?: string;
}

export interface RenderOptions extends VoiceOptions {
  scene: string;
  onStage?: (p: RenderProgress) => void;
}

export interface RenderResult {
  mp4: string;
  durationMs: number;
  frames: number;
  captured: number;
}

export async function renderScene(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  opts: RenderOptions,
): Promise<RenderResult> {
  const { scene } = opts;
  const dir = sceneDir(scene);
  await fs.mkdir(dir, { recursive: true });

  const report = opts.onStage ?? (() => {});

  const timings = await resolveTimings(scene, shots, rigs, {
    engine: opts.engine,
    onProgress: (stage, done, total) =>
      report({ stage: stage === 'lipsync' ? 'lipsync' : 'voice', done, total }),
  });

  report({ stage: 'compile', done: 0, total: 1 });
  const compiled = compileShotList(shots, rigs, timings);
  await fs.writeFile(path.join(dir, 'scene.ir.json'), JSON.stringify(compiled.ir, null, 2), 'utf8');
  report({ stage: 'compile', done: 1, total: 1, message: `${compiled.ir.frames.length} frames` });

  report({ stage: 'audio', done: 0, total: 1 });
  const dialogue = await mixSceneAudio(scene, compiled.audio, compiled.durationMs);
  report({ stage: 'audio', done: 1, total: 1 });

  const result = await renderFrames({
    ir: compiled.ir,
    rigs,
    dir,
    background: '#2b2f36',
    onProgress: (done, total) => report({ stage: 'frames', done, total }),
  });

  report({ stage: 'encode', done: 0, total: 1 });
  const mp4 = outputPath(scene);
  await encodeMp4({ framesDir: result.framesDir, fps: shots.fps, out: mp4, audio: dialogue });
  report({ stage: 'encode', done: 1, total: 1 });

  return {
    mp4,
    durationMs: compiled.durationMs,
    frames: result.total,
    captured: result.captured,
  };
}
