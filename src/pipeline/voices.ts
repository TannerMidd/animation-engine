import path from 'node:path';
import { CAST_DIR, sceneDir } from '../core/paths.ts';
import { synthesizeLines, loadRecordedVo, estimateMouthCues, type LineTiming, type VoiceLine } from '../voice/index.ts';
import { mixDialogue } from '../voice/mix.ts';
import { estimateLineMs } from '../compile/scene.ts';
import { exists, voPath } from './scene.ts';
import type { ShotList } from '../schema/script.ts';
import type { LoadedRig } from '../cast/store.ts';

/**
 * Turn a shot list's dialogue into audio and mouth timing.
 *
 * Every line is either a recorded VO override sitting in the scene's `vo/`
 * folder, or a synthesized take. Both come back as the same `LineTiming`, so
 * everything downstream is indifferent to which.
 */

export interface VoiceOptions {
  engine: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export async function resolveTimings(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  opts: VoiceOptions,
): Promise<Map<number, LineTiming>> {
  const timings = new Map<number, LineTiming>();
  const toSynth: VoiceLine[] = [];
  const beatOfLine = new Map<string, number>();

  for (let i = 0; i < shots.beats.length; i++) {
    const beat = shots.beats[i]!;
    if (beat.kind !== 'line') continue;

    const member = shots.cast.find((c) => c.id === beat.speaker);
    if (!member) throw new Error(`beat ${i} is spoken by "${beat.speaker}", who is not in the cast`);
    const rig = rigs.get(member.rig)?.rig;
    if (!rig) throw new Error(`no rig loaded for "${member.rig}"`);

    const vo = voPath(scene, i, beat.speaker);
    if (await exists(vo)) {
      timings.set(i, await loadRecordedVo(vo, beat.text));
      continue;
    }

    const id = `${scene}-${i}`;
    beatOfLine.set(id, i);
    toSynth.push({
      id,
      text: beat.text,
      expression: beat.expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null,
      // Derived from the scene seed, so a take is stable across re-renders but
      // differs line to line.
      seed: shots.seed * 1000 + i,
    });
  }

  if (toSynth.length) {
    const rendered = await synthesizeLines(toSynth, { engine: opts.engine, onProgress: opts.onProgress });
    for (const [id, timing] of rendered) timings.set(beatOfLine.get(id)!, timing);
  }

  return timings;
}

/**
 * Placeholder timings from word counts alone.
 *
 * Lets the editor scrub a scene the instant it is typed, before any TTS has
 * run. The mouth moves in roughly the right rhythm; it is not lipsync and does
 * not pretend to be. Real audio replaces it wholesale.
 */
export function estimateTimings(shots: ShotList): Map<number, LineTiming> {
  const timings = new Map<number, LineTiming>();
  shots.beats.forEach((beat, i) => {
    if (beat.kind !== 'line') return;
    // estimateLineMs includes the inter-line tail, which the compiler adds
    // again — subtract it so an estimated scene isn't systematically long.
    const durationMs = Math.max(400, estimateLineMs(beat.text) - 160);
    timings.set(i, { audio: '', durationMs, cues: estimateMouthCues(beat.text, durationMs) });
  });
  return timings;
}

/** Mix the dialogue track for a scene. Returns the WAV path. */
export async function mixSceneAudio(
  scene: string,
  placements: Array<{ file: string; startMs: number }>,
  durationMs: number,
): Promise<string> {
  return mixDialogue(placements, durationMs, path.join(sceneDir(scene), 'dialogue.wav'));
}
