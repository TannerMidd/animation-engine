import path from 'node:path';
import { json, readJson, HttpError, type Router } from '../http.ts';
import { startJob, jobSummary } from '../jobs.ts';
import { protectRunningRenderState, outFileUrl } from '../state.ts';
import {
  listProfiles, loadProfile, activeProfileId, setActiveProfileId, compareProfiles,
} from '../../show/store.ts';
import { setActiveIdentity, activeIdentity } from '../../show/context.ts';
import { ShowIdentity } from '../../schema/identity.ts';
import { identityHash, stampOf } from '../../show/identity.ts';
import { validateProfiles, renderIdentityReel } from '../../pipeline/identity-tools.ts';
import { ROOT } from '../../core/paths.ts';

export function registerShowRoutes(router: Router): void {
  router.get('/api/show', async ({ res }) => {
    const identity = activeIdentity();
    json(res, {
      active: { ...stampOf(identity), name: identity.name },
      profiles: await listProfiles(),
    });
  });

  /**
   * Load every profile the listing found — `anim show validate`, served.
   * listProfiles silently drops what fails to parse; this names it instead.
   */
  router.get('/api/show/validate', async ({ res }) => {
    json(res, await validateProfiles());
  });

  router.get('/api/show/profile/:id', async ({ res, params }) => {
    json(res, await loadProfile(params['id']!));
  });

  router.put('/api/show/active', async ({ req, res }) => {
    protectRunningRenderState('the active show identity');
    const body = await readJson<{ id: string }>(req);
    if (!body.id) throw new HttpError(400, 'expected { id }');
    await setActiveProfileId(body.id);
    setActiveIdentity(await loadProfile(body.id));
    json(res, { ok: true, active: stampOf(activeIdentity()) });
  });

  router.put('/api/show/profile/:id', async ({ req, res, params }) => {
    protectRunningRenderState('show identity profiles');
    const body = await readJson<{ identity: unknown }>(req);
    const identity = ShowIdentity.parse(body.identity);
    if (identity.id !== params['id']) throw new HttpError(400, 'profile id in body must match the URL');

    const { saveProfile } = await import('../../show/store.ts');
    await saveProfile(identity);
    // Editing the active profile takes effect immediately — previews after a
    // save must render with what was saved, not with a stale copy.
    if ((await activeProfileId()) === identity.id) setActiveIdentity(identity);
    json(res, { ok: true, hash: identityHash(identity) });
  });

  router.post('/api/show/compare', async ({ req, res }) => {
    const body = await readJson<{ a: string; b: string }>(req);
    if (!body.a || !body.b) throw new HttpError(400, 'expected { a, b }');
    json(res, { diffs: compareProfiles(await loadProfile(body.a), await loadProfile(body.b)) });
  });

  /**
   * The identity comparison reel as a job — two full renders stacked into one
   * video, minutes of work, streamed like any other render.
   */
  router.post('/api/show/reel', async ({ req, res }) => {
    const body = await readJson<{ script?: string; a?: string; b?: string; engine?: string }>(req);
    // The evaluation script is addressed relative to the project; anything
    // outside it has no business in a reel.
    if (body.script && path.isAbsolute(body.script)) {
      throw new HttpError(400, 'reel scripts are project-relative paths');
    }

    const job = startJob('reel', 'show', async (handle) => {
      const result = await renderIdentityReel({
        script: body.script ? path.join(ROOT, body.script) : undefined,
        a: body.a,
        b: body.b,
        engine: body.engine,
        onProfileStart: (profileId) => handle.log(`rendering under ${profileId}`),
        onStage: (profileId, p) =>
          handle.progress({ stage: p.stage, done: p.done, total: p.total, message: profileId }),
        onProfileDone: (profileId, mp4) => handle.log(`${profileId} → ${path.relative(ROOT, mp4)}`),
      });
      return { ...result, url: outFileUrl(result.file) };
    });
    json(res, jobSummary(job));
  });
}
