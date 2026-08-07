import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRig, listRigs } from '../../cast/store.ts';
import { sceneDir } from '../../core/paths.ts';
import { freeVramForRender } from '../../llm/ollama.ts';
import { readDialogueDocument } from '../../pipeline/dialogue.ts';
import { outputPath, readShotList } from '../../pipeline/scene.ts';
import { parseStemId, readSceneSound, sceneStemPath } from '../../pipeline/sound.ts';
import {
  dialogueGuideIsCurrent,
  dialogueGuidePath,
  soundtrackEngine,
  soundtrackIsCurrent,
} from '../../pipeline/voices.ts';
import { ensureVoiceRefs } from '../../voice/casting.ts';
import { HttpError, json, readJson, sendFile, type Router } from '../http.ts';
import { jobSummary, startJob } from '../jobs.ts';
import { requireShotList, rigsFor } from '../state.ts';
import { requestedEngine, startSoundtrackJob } from './scene-soundtrack.ts';

/** Sound, video, caption, export, and thumbnail delivery for a scene. */
export function registerSceneMediaRoutes(router: Router): void {
  router.get('/api/scenes/:name/audio', async ({ res, params, req }) => {
    const scene = params['name']!;
    const shots = await readShotList(scene).catch(() => null);
    if (shots) {
      const rigs = await rigsFor(shots);
      if (!(await soundtrackIsCurrent(scene, shots, rigs))) {
        throw new HttpError(
          409,
          'the rendered audio is stale — the scene, a voice, or the show identity changed since. Run Voices again.',
        );
      }
    }
    return sendFile(res, path.join(sceneDir(scene), 'dialogue.wav'), req);
  });

  router.get('/api/scenes/:name/sound', async ({ res, params }) => {
    const scene = params['name']!;
    const shots = await requireShotList(scene);
    const rigs = await rigsFor(shots);
    json(res, await readSceneSound(scene, shots, rigs));
  });

  router.get('/api/scenes/:name/stems/:stem', async ({ res, params, req }) => {
    const scene = params['name']!;
    let stem;
    try {
      stem = parseStemId(params['stem']!);
    } catch (error) {
      throw new HttpError(404, (error as Error).message);
    }
    const shots = await readShotList(scene).catch(() => null);
    if (shots) {
      const rigs = await rigsFor(shots);
      if (!(await soundtrackIsCurrent(scene, shots, rigs))) {
        throw new HttpError(
          409,
          'the stems are stale — the scene, a voice, or the show identity changed since. Rebuild stems.',
        );
      }
    }
    return sendFile(res, sceneStemPath(scene, stem), req);
  });

  router.post('/api/scenes/:name/sound/rebuild', async ({ req, res, params }) => {
    const scene = params['name']!;
    const body = await readJson<{ engine?: string }>(req);
    const shots = await requireShotList(scene);
    const rigs = await rigsFor(shots);
    const engine = requestedEngine(body.engine, await soundtrackEngine(scene));
    json(res, jobSummary(startSoundtrackJob('sound', scene, shots, rigs, engine)));
  });

  router.get('/api/scenes/:name/dialogue/guide/:speaker', async ({ res, params, req }) => {
    const scene = params['name']!;
    const shots = await readShotList(scene).catch(() => null);
    if (!shots) throw new HttpError(404, 'the scene has not been directed');
    if (!shots.cast.some((member) => member.id === params['speaker'])) {
      throw new HttpError(404, `no cast member "${params['speaker']}"`);
    }
    const rigs = await rigsFor(shots);
    if (!(await soundtrackIsCurrent(scene, shots, rigs))) {
      throw new HttpError(409, 'the Scene Run guide is stale — run Voices again');
    }
    const dialogue = await readDialogueDocument(scene);
    const mutedCueIds = (dialogue?.cues ?? [])
      .filter((cue) => cue.speaker === params['speaker'] && !cue.locked)
      .map((cue) => cue.id);
    if (!(await dialogueGuideIsCurrent(scene, params['speaker']!, mutedCueIds))) {
      throw new HttpError(
        409,
        'the Scene Run guide context changed after a cue was locked or unlocked; run Voices again',
      );
    }
    return sendFile(res, dialogueGuidePath(scene, params['speaker']!), req);
  });

  router.post('/api/scenes/:name/voices/prepare', async ({ res, params }) => {
    const scene = params['name']!;
    const shots = await requireShotList(scene);
    const onDisk = new Set(await listRigs());
    const job = startJob('prepare-voices', scene, async (handle) => {
      const evicted = await freeVramForRender();
      if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);
      const candidates = [];
      for (const member of shots.cast) {
        if (!onDisk.has(member.rig)) continue;
        const { rig } = await loadRig(member.rig);
        candidates.push({ name: member.rig, charId: rig.charId, voiceRef: rig.voiceRef });
      }
      const minted = await ensureVoiceRefs(candidates, (done, total, name) =>
        handle.progress({ stage: 'casting', done, total, message: name }),
      );
      return { minted };
    });
    json(res, jobSummary(job));
  });

  router.get('/api/scenes/:name/video', ({ res, params, req }) =>
    sendFile(res, outputPath(params['name']!), req),
  );
  router.get('/api/scenes/:name/video/vertical', ({ res, params, req }) => {
    const scene = params['name']!;
    return sendFile(res, path.join(sceneDir(scene), `${scene}.vertical.mp4`), req);
  });
  router.get('/api/scenes/:name/export', async ({ res, params }) => {
    const scene = params['name']!;
    json(res, JSON.parse(await fs.readFile(path.join(sceneDir(scene), `${scene}.export.json`), 'utf8')));
  });
  router.get('/api/scenes/:name/captions.vtt', ({ res, params, req }) => {
    const scene = params['name']!;
    return sendFile(res, path.join(sceneDir(scene), `${scene}.captions.vtt`), req);
  });
  router.get('/api/scenes/:name/captions.srt', ({ res, params, req }) => {
    const scene = params['name']!;
    return sendFile(res, path.join(sceneDir(scene), `${scene}.captions.srt`), req);
  });
  router.get('/api/scenes/:name/thumbnail/:index', async ({ res, params, req }) => {
    const scene = params['name']!;
    const index = Number(params['index']);
    if (!Number.isInteger(index) || index < 0)
      throw new HttpError(400, 'thumbnail index must be a non-negative integer');
    const manifest = JSON.parse(
      await fs.readFile(path.join(sceneDir(scene), `${scene}.export.json`), 'utf8'),
    ) as { thumbnails?: Array<{ file?: string }> };
    const relative = manifest.thumbnails?.[index]?.file;
    if (!relative || path.basename(relative) !== relative) throw new HttpError(404, 'no such thumbnail');
    return sendFile(res, path.join(sceneDir(scene), relative), req);
  });
}
