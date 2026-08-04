import path from 'node:path';
import { json, readJson, sendFile, HttpError, type Router } from '../http.ts';
import { startJob, jobSummary } from '../jobs.ts';
import { sceneAsset, safeOutPath } from '../state.ts';
import { OUT_DIR } from '../../core/paths.ts';
import { freeVramForRender } from '../../llm/ollama.ts';
import { readDialogueDocument } from '../../pipeline/dialogue.ts';
import {
  readBenchResult, runVoicesBench, runVoicesCheck,
} from '../../pipeline/bench.ts';

/**
 * Cast-wide voice measurement — `anim voices bench` and `anim voices check`,
 * served. Both are jobs: the bench synthesizes dozens of lines, the check runs
 * the conversion model per character.
 */
export function registerVoiceRoutes(router: Router): void {
  /** The last bench run, straight off disk; null when none has run yet. */
  router.get('/api/voices/bench', async ({ res }) => {
    json(res, { result: await readBenchResult() });
  });

  router.post('/api/voices/bench', async ({ req, res }) => {
    const body = await readJson<{ only?: string[] }>(req);
    const job = startJob('bench', 'voices', async (handle) => {
      const evicted = await freeVramForRender();
      if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);
      return runVoicesBench({
        only: body.only,
        onStart: (lines, characters) => handle.log(`rendering ${lines} lines across ${characters} characters`),
        onProgress: (stage, done, total) => handle.progress({ stage, done, total }),
      });
    });
    json(res, jobSummary(job));
  });

  /** Bench audio: the copies the bench itself wrote under out/bench/<name>/. */
  router.get('/api/voices/bench/:name/:file', ({ res, params, req }) =>
    sendFile(res, safeOutPath('bench', params['name']!, params['file']!), req));

  /**
   * Score one performance against every cast voice.
   *
   * The source is either a recorded take (scene + takeId — the editor's path)
   * or a project-relative file path (the CLI's). Conversions are copied under
   * out/check/ so the rows can be auditioned, not just read.
   */
  router.post('/api/voices/check', async ({ req, res }) => {
    const body = await readJson<{ scene?: string; takeId?: string; source?: string; only?: string[] }>(req);

    let source: string;
    let label: string;
    if (body.scene && body.takeId) {
      const document = await readDialogueDocument(body.scene);
      const take = document?.recordedTakes.find((item) => item.id === body.takeId);
      if (!take) throw new HttpError(404, `no recorded take "${body.takeId}" in scene "${body.scene}"`);
      if (take.revokedAt) throw new HttpError(409, `take "${body.takeId}" was revoked and cannot be used as a source`);
      source = sceneAsset(body.scene, take.audio.file);
      label = body.scene;
    } else if (body.source) {
      if (path.isAbsolute(body.source) || body.source.includes('..')) {
        throw new HttpError(400, 'source must be a project-relative path');
      }
      source = path.resolve(process.cwd(), body.source);
      label = path.basename(body.source);
    } else {
      throw new HttpError(400, 'expected { scene, takeId } or { source }');
    }

    const job = startJob('voices-check', label, async (handle) => {
      const evicted = await freeVramForRender();
      if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);
      return runVoicesCheck({
        source,
        only: body.only,
        copyDir: path.join(OUT_DIR, 'check'),
        onStart: (targets) => handle.progress({ stage: 'convert', done: 0, total: targets }),
        onProgress: (done, total) => handle.progress({ stage: 'convert', done, total }),
      });
    });
    json(res, jobSummary(job));
  });

  /** Conversion audio the check copied under out/check/. */
  router.get('/api/voices/check/audio/:file', ({ res, params, req }) =>
    sendFile(res, safeOutPath('check', params['file']!), req));
}
