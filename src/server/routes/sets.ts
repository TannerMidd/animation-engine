import fs from 'node:fs/promises';
import path from 'node:path';
import { json, readJson, HttpError, type Router } from '../http.ts';
import { STAGE, storePreview, protectRunningRenderState } from '../state.ts';
import { listSets, loadSet, saveSet, validateSet, lintSet, tidySet, setPath, renderSet } from '../../sets/index.ts';
import { SetDescriptor } from '../../sets/schema.ts';
import { BUILTIN_SETS, BUILTIN_SET_NAMES } from '../../sets/builtins.ts';
import { listRigs, loadRig, type LoadedRig } from '../../cast/store.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../../cast/placeholder.ts';
import { compileScene, DEFAULT_PLAN } from '../../compile/index.ts';
import { ROOT } from '../../core/paths.ts';

export function registerSetRoutes(router: Router): void {
  router.get('/api/sets', async ({ res }) => {
    const onDisk = await listSets();
    const names = [...new Set([...onDisk, ...BUILTIN_SET_NAMES])].sort();
    const out = [];
    for (const name of names) {
      const desc = onDisk.includes(name) ? await loadSet(name) : BUILTIN_SETS[name]!;
      out.push({
        name,
        palette: desc.palette,
        builtin: !onDisk.includes(name),
        propCount: desc.layers.back.length + desc.layers.mid.length + desc.layers.fore.length,
      });
    }
    json(res, out);
  });

  router.get('/api/sets/:name', async ({ res, params }) => {
    const name = params['name']!;
    const onDisk = await listSets();
    const desc = onDisk.includes(name) ? await loadSet(name) : BUILTIN_SETS[name];
    if (!desc) throw new HttpError(404, `no set "${name}"`);
    json(res, desc);
  });

  router.put('/api/sets/:name', async ({ req, res, params }) => {
    protectRunningRenderState('sets');
    const body = await readJson<{ set: unknown }>(req);
    const desc = SetDescriptor.parse(body.set);
    desc.name = params['name']!;

    const errors = validateSet(desc);
    if (errors.length) throw new HttpError(400, errors.join('; '));

    await saveSet(desc);
    json(res, { ok: true, path: path.relative(ROOT, setPath(desc.name)) });
  });

  /**
   * Preview a set, optionally with characters staged in it.
   *
   * Takes the descriptor in the request body rather than reading from disk, so
   * the designer can preview unsaved edits.
   */
  router.post('/api/sets/:name/preview', async ({ req, res, params }) => {
    const body = await readJson<{ set?: unknown; cast?: string[] }>(req);
    const name = params['name']!;

    const desc = body.set
      ? SetDescriptor.parse(body.set)
      : ((await listSets()).includes(name) ? await loadSet(name) : BUILTIN_SETS[name]);
    if (!desc) throw new HttpError(404, `no set "${name}"`);

    const errors = validateSet(desc);
    if (errors.length) throw new HttpError(400, errors.join('; '));

    const onDisk = await listRigs();
    const staged = (body.cast?.length ? body.cast : onDisk.slice(0, 2)).filter(Boolean);
    const names = staged.length ? staged : ['previewA', 'previewB'];

    const rigs = new Map<string, LoadedRig>();
    for (const n of names) {
      rigs.set(
        n,
        onDisk.includes(n) ? await loadRig(n) : { rig: buildPlaceholderRig(n), svg: buildPlaceholderSvg(n) },
      );
    }

    const plan = {
      scene: `set-${name}`,
      fps: DEFAULT_PLAN.fps,
      characterFps: DEFAULT_PLAN.characterFps,
      width: STAGE.w,
      height: STAGE.h,
      seed: 1,
      durationSec: 1 / DEFAULT_PLAN.fps,
      camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
      set: null,
      audio: null,
      actors: names.map((n, i) => ({
        id: n,
        rig: n,
        x: (STAGE.w * (i + 1)) / (names.length + 1),
        y: STAGE.ground,
        scale: 1.25,
        flip: (STAGE.w * (i + 1)) / (names.length + 1) > STAGE.w / 2,
        pose: 'IDLE',
        expression: 'NEUTRAL',
      })),
    };

    const ir = compileScene(plan, rigs);
    const { buildPage } = await import('../../render/page.ts');
    const runtime = await fs.readFile(new URL('../../render/runtime.js', import.meta.url), 'utf8');
    const html = await buildPage({ ir, rigs, runtime, set: renderSet(desc), background: '#2b2f36' });

    // Composition notes ride along with the preview so the designer can show what
    // is awkward about a set at the moment you look at it, rather than only when
    // a model happens to be generating one.
    json(res, {
      previewId: storePreview(html),
      frameCount: 1,
      notes: lintSet(desc).map((n) => n.message),
    });
  });

  /** Apply the deterministic composition repairs to a descriptor, without saving. */
  router.post('/api/sets/:name/tidy', async ({ req, res, params }) => {
    const body = await readJson<{ set: unknown }>(req);
    const desc = SetDescriptor.parse(body.set);
    desc.name = params['name']!;
    const tidied = tidySet(desc);
    json(res, { set: tidied, notes: lintSet(tidied).map((n) => n.message) });
  });

}
