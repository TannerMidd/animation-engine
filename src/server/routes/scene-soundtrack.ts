import type { LoadedRig } from '../../cast/store.ts';
import { compileShotList } from '../../compile/scene.ts';
import { freeVramForRender } from '../../llm/ollama.ts';
import { readAnimation } from '../../pipeline/animation.ts';
import { readDialogueDocument } from '../../pipeline/dialogue.ts';
import { mixSceneAudio, resolveTimings } from '../../pipeline/voices.ts';
import type { ShotList } from '../../schema/script.ts';
import { loadSet } from '../../sets/index.ts';
import { ENGINE_NAMES } from '../../voice/index.ts';
import { HttpError } from '../http.ts';
import { startJob, type Job } from '../jobs.ts';

export function requestedEngine(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  if (!(ENGINE_NAMES as readonly string[]).includes(raw)) {
    throw new HttpError(400, `no voice engine "${raw}" — expected one of ${ENGINE_NAMES.join(', ')}`);
  }
  return raw;
}

/** Shared implementation behind both Voices and Rebuild stems. */
export function startSoundtrackJob(
  kind: 'voices' | 'sound',
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  engine: string,
): Job {
  return startJob(kind, scene, async (handle) => {
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);
    const timings = await resolveTimings(scene, shots, rigs, {
      engine,
      onProgress: (stage, done, total) => handle.progress({ stage, done, total }),
    });
    const setDescriptor = shots.set ? await loadSet(shots.set) : null;
    const animation = await readAnimation(scene);
    const compiled = compileShotList(shots, rigs, timings, animation, setDescriptor);
    const dialogue = await readDialogueDocument(scene);
    handle.progress({ stage: 'audio', done: 0, total: 1 });
    await mixSceneAudio(scene, shots, compiled.audio, compiled.durationMs, {
      stageActions: compiled.stageActions,
      engine,
      guideMuteCueIds: dialogue
        ? Object.fromEntries(
            shots.cast.map((member) => [
              member.id,
              dialogue.cues.filter((cue) => cue.speaker === member.id && !cue.locked).map((cue) => cue.id),
            ]),
          )
        : undefined,
    });
    return { lines: timings.size, durationMs: compiled.durationMs, engine };
  });
}
