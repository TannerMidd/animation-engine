import fs from 'node:fs/promises';
import path from 'node:path';
import { sceneDir } from '../core/paths.ts';
import { compileShotList } from '../compile/scene.ts';
import { renderFrames } from '../render/capture.ts';
import { encodeMp4 } from '../render/encode.ts';
import {
  resolveTimings,
  mixProductionAudio,
  type ProductionAudioBundle,
  type VoiceOptions,
} from './voices.ts';
import { outputPath } from './scene.ts';
import { readAnimation } from './animation.ts';
import { writePublishingBundle } from './publish.ts';
import { readDialogueDocument } from './dialogue.ts';
import { reframeScenePortrait, PORTRAIT_MASTER } from './reframe.ts';
import { activeIdentity } from '../show/context.ts';
import type { ShowIdentity } from '../schema/identity.ts';
import { endCardSvg, titleCardSvg } from '../render/cards.ts';
import { loadSet } from '../sets/index.ts';
import type { SetDescriptor } from '../sets/schema.ts';
import type { ShotList } from '../schema/script.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { PreflightWarningAcknowledgement } from './preflight-review.ts';

/**
 * Full render: shot list -> MP4.
 *
 * Progress is reported per stage rather than as one opaque bar, because the
 * stages have wildly different costs — synthesis is GPU-bound, lipsync is
 * CPU-bound, frame capture is neither — and "it's been quiet for 90 seconds"
 * should never be ambiguous.
 */

export type RenderStage = 'voice' | 'lipsync' | 'compile' | 'audio' | 'frames' | 'encode' | 'publish';

export interface RenderProgress {
  stage: RenderStage;
  done: number;
  total: number;
  message?: string;
}

export interface RenderOptions extends VoiceOptions {
  scene: string;
  /** Undefined loads the scene's saved animation; null explicitly disables it. */
  animation?: AnimationDocument | null;
  /** Undefined loads the referenced set; null explicitly renders without one. */
  setDescriptor?: SetDescriptor | null;
  /** Immutable show identity inspected by the production gate. */
  identity?: ShowIdentity;
  /** Human review evidence for the exact warning-bearing production snapshot. */
  warningAcknowledgement?: PreflightWarningAcknowledgement | null;
  onStage?: (p: RenderProgress) => void;
}

export interface RenderResult {
  mp4: string;
  verticalMp4: string;
  exportManifest: string;
  captions: { vtt: string; srt: string };
  thumbnails: string[];
  audio: ProductionAudioBundle;
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
  // Snapshot authored picture state before voice work begins. A render can
  // spend minutes synthesising; an editor save during that time belongs to the
  // next render, not half of this one.
  const animation = opts.animation === undefined ? await readAnimation(scene) : opts.animation;
  const identity = opts.identity ?? activeIdentity();

  const timings = await resolveTimings(scene, shots, rigs, {
    engine: opts.engine,
    dialogue: opts.dialogue,
    onProgress: (stage, done, total) =>
      report({ stage: stage === 'lipsync' ? 'lipsync' : 'voice', done, total }),
  });
  // resolveTimings synchronizes the editorial document before selecting audio;
  // retain that reviewed state in the release provenance beside the render.
  const dialogue = opts.dialogue ?? await readDialogueDocument(scene);

  report({ stage: 'compile', done: 0, total: 1 });
  const setDescriptor = opts.setDescriptor === undefined
    ? (shots.set ? await loadSet(shots.set) : null)
    : opts.setDescriptor;
  const compiled = compileShotList(shots, rigs, timings, animation, setDescriptor);
  await fs.writeFile(path.join(dir, 'scene.ir.json'), JSON.stringify(compiled.ir, null, 2), 'utf8');
  report({ stage: 'compile', done: 1, total: 1, message: `${compiled.ir.frames.length} frames` });

  report({ stage: 'audio', done: 0, total: 1 });
  const audio = await mixProductionAudio(scene, shots, compiled.audio, compiled.durationMs, {
    stageActions: compiled.stageActions,
    guideMuteCueIds: Object.fromEntries(shots.cast.map((member) => [
      member.id,
      (dialogue?.cues ?? []).filter((cue) => cue.speaker === member.id && !cue.locked).map((cue) => cue.id),
    ])),
  });
  report({ stage: 'audio', done: 1, total: 1 });

  const result = await renderFrames({
    ir: compiled.ir,
    rigs,
    dir,
    background: '#2b2f36',
    onProgress: (done, total) => report({ stage: 'frames', done, total: total * 2, message: 'horizontal master' }),
  });

  const portraitCards = shots.cards ? {
    titleSvg: titleCardSvg(
      identity,
      shots.title ?? shots.scene.replace(/-/g, ' '),
      shots.subtitle ?? undefined,
      PORTRAIT_MASTER,
    ),
    endSvg: endCardSvg(identity, PORTRAIT_MASTER),
  } : undefined;
  const portraitIr = reframeScenePortrait(compiled.ir, { cards: portraitCards });
  await fs.writeFile(path.join(dir, 'scene.portrait.ir.json'), JSON.stringify(portraitIr, null, 2), 'utf8');
  const portraitResult = await renderFrames({
    ir: portraitIr,
    rigs,
    dir: path.join(dir, 'portrait'),
    background: '#2b2f36',
    onProgress: (done, total) => report({
      stage: 'frames',
      done: result.total + done,
      total: result.total + total,
      message: 'actor-aware vertical master',
    }),
  });

  report({ stage: 'encode', done: 0, total: 2 });
  const mp4 = outputPath(scene);
  await encodeMp4({ framesDir: result.framesDir, fps: shots.fps, out: mp4, audio: audio.master });
  report({ stage: 'encode', done: 1, total: 2, message: 'horizontal master' });
  const verticalMp4 = path.join(dir, `${scene}.vertical.mp4`);
  await encodeMp4({ framesDir: portraitResult.framesDir, fps: shots.fps, out: verticalMp4, audio: audio.master });
  report({ stage: 'encode', done: 2, total: 2, message: 'vertical master' });

  report({ stage: 'publish', done: 0, total: 1 });
  const publishing = await writePublishingBundle({
    scene,
    dir,
    compiled,
    framesDir: result.framesDir,
    mp4,
    verticalMp4,
    audio,
    portraitIr,
    identity,
    dialogue,
    animation,
    warningAcknowledgement: opts.warningAcknowledgement ?? null,
  });
  report({ stage: 'publish', done: 1, total: 1, message: `${publishing.thumbnails.length} thumbnail candidates` });

  return {
    mp4,
    verticalMp4,
    exportManifest: publishing.manifest,
    captions: publishing.captions,
    thumbnails: publishing.thumbnails,
    audio,
    durationMs: compiled.durationMs,
    frames: result.total + portraitResult.total,
    captured: result.captured + portraitResult.captured,
  };
}
