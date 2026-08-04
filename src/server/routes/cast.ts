import fs from 'node:fs/promises';
import { json, readJson, sendFile, HttpError, type Router } from '../http.ts';
import { startJob, jobSummary } from '../jobs.ts';
import { STAGE, auditions, storePreview, outFileUrl } from '../state.ts';
import { listRigs, loadRig, saveRig, validateRig, type LoadedRig } from '../../cast/store.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../../cast/placeholder.ts';
import { createRig, regenerateRig, lookOf } from '../../cast/authoring.ts';
import { facePlates } from '../../cast/sheet.ts';
import { rollLook } from '../../cast/look.ts';
import { Rig, Look, Outfit } from '../../schema/index.ts';
import { saveReference, clearReference, referencePath } from '../../voice/reference.ts';
import { mintCandidates, commitCandidate, discardCandidates, candidatePath } from '../../voice/casting.ts';
import { auditionVoice } from '../../pipeline/audition.ts';
import { compileScene, DEFAULT_PLAN } from '../../compile/index.ts';
import { freeVramForRender } from '../../llm/ollama.ts';
import { checkRigs, renderCastSheet } from '../../pipeline/cast-tools.ts';
import { renderStill, renderIdle } from '../../pipeline/stills.ts';

export function registerCastRoutes(router: Router): void {
  router.get('/api/cast', async ({ res }) => {
    const names = await listRigs();
    const cast = [];
    for (const name of names) {
      const { rig } = await loadRig(name);
      cast.push({
        name,
        voice: rig.voice,
        voiceRate: rig.voiceRate,
        voiceRef: rig.voiceRef,
        look: lookOf(rig),
        expressions: rig.expressions.map((e) => e.name),
        poses: rig.poses.map((p) => p.name),
      });
    }
    json(res, cast);
  });

  /**
   * Validate every rig against its SVG — `anim cast check`, served.
   * Fast and pure, so it answers synchronously rather than as a job.
   */
  router.post('/api/cast/check', async ({ req, res }) => {
    const body = await readJson<{ names?: string[] }>(req);
    json(res, await checkRigs(body.names));
  });

  /**
   * Contact sheet as a job: one name gives every expression, no names give the
   * whole cast side by side. Playwright renders it, so it takes seconds.
   */
  router.post('/api/cast/sheet', async ({ req, res }) => {
    const body = await readJson<{ names?: string[]; expression?: string }>(req);
    const job = startJob('sheet', body.names?.length === 1 ? body.names[0]! : 'cast', async (handle) => {
      handle.progress({ stage: 'sheet', done: 0, total: 1 });
      const result = await renderCastSheet({ names: body.names, expression: body.expression });
      handle.progress({ stage: 'sheet', done: 1, total: 1 });
      return { ...result, url: outFileUrl(result.file) };
    });
    json(res, jobSummary(job));
  });

  router.get('/api/cast/:name', async ({ res, params }) => {
    const { rig, svg } = await loadRig(params['name']!);
    json(res, { rig, svg, look: lookOf(rig) });
  });

  /** Create a character the editor invented, rather than one a script named. */
  router.post('/api/cast', async ({ req, res }) => {
    const body = await readJson<{ name: string }>(req);
    const name = (body.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new HttpError(400, 'a character name must be letters, digits, dashes or underscores');
    }
    if ((await listRigs()).includes(name)) throw new HttpError(409, `"${name}" already exists`);

    const { rig } = await createRig(name);
    json(res, { name, look: rig.look });
  });

  /**
   * Change how a character looks.
   *
   * The look is the source and the SVG is the output, so this redraws rather than
   * patching artwork. Voice settings survive, because they are a different
   * decision that happens to live in the same file.
   */
  router.put('/api/cast/:name/look', async ({ req, res, params }) => {
    const body = await readJson<{ look?: unknown; outfit?: unknown; reroll?: boolean }>(req);
    const { rig, svg } = await regenerateRig(params['name']!, {
      look: body.look ? Look.parse(body.look) : undefined,
      outfit: body.outfit ? Outfit.parse(body.outfit) : undefined,
      reroll: body.reroll,
    });
    json(res, { rig, svg, look: rig.look, outfit: rig.outfit });
  });

  /** A look rolled from the name, without saving it. Feeds the "reroll" button. */
  router.get('/api/cast/:name/look/roll', ({ res, params, query }) => {
    // A different salt each press, so pressing it twice doesn't give the same face.
    const salt = query.get('salt') ?? '';
    json(res, { look: rollLook(params['name']! + salt) });
  });

  /**
   * Every expression at once, as SVG.
   *
   * Returned as markup rather than as a preview page: these are static plates with
   * nothing to drive, and putting ten iframes in a panel to show ten still faces
   * would be absurd.
   */
  router.post('/api/cast/:name/faces', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ look?: unknown; outfit?: unknown }>(req);

    const onDisk = (await listRigs()).includes(name);
    let loaded: LoadedRig;

    if (body.look || body.outfit) {
      // Unsaved edits: draw from the descriptors in the request, never from disk.
      const base = onDisk ? await loadRig(name) : null;
      const look = body.look ? Look.parse(body.look) : (base?.rig.look ?? undefined);
      const outfit = body.outfit ? Outfit.parse(body.outfit) : base?.rig.outfit;
      loaded = { rig: buildPlaceholderRig(name, look, outfit), svg: buildPlaceholderSvg(name, look, outfit) };
    } else {
      loaded = onDisk ? await loadRig(name) : { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) };
    }

    json(res, { plates: facePlates(loaded) });
  });

  router.put('/api/cast/:name', async ({ req, res, params }) => {
    const body = await readJson<{ rig: unknown; svg?: string }>(req);
    const rig = Rig.parse(body.rig);
    const svg = body.svg ?? (await loadRig(params['name']!)).svg;

    const errors = validateRig({ rig, svg });
    if (errors.length) throw new HttpError(400, errors.join('; '));

    await saveRig(rig, svg);
    json(res, { ok: true });
  });

  /** Redraw a character's art, picking up any generator changes. */
  router.post('/api/cast/:name/regenerate', async ({ req, res, params }) => {
    const body = await readJson<{ reroll?: boolean }>(req);
    const { rig, svg } = await regenerateRig(params['name']!, { reroll: body.reroll });
    json(res, { rig, svg, look: rig.look });
  });

  /** One frame of this character to a PNG — `anim still`, served. */
  router.post('/api/cast/:name/still', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ pose?: string; expression?: string; scale?: number; seed?: number }>(req);
    const job = startJob('still', name, async (handle) => {
      handle.progress({ stage: 'still', done: 0, total: 1 });
      const result = await renderStill({
        names: [name],
        pose: body.pose,
        expression: body.expression,
        scale: body.scale,
        seed: body.seed,
      });
      handle.progress({ stage: 'still', done: 1, total: 1 });
      return { ...result, url: outFileUrl(result.file) };
    });
    json(res, jobSummary(job));
  });

  /** A short idling MP4 — `anim idle`, served. */
  router.post('/api/cast/:name/idle', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{
      seconds?: number; fps?: number; characterFps?: number; scale?: number; seed?: number;
    }>(req);
    const job = startJob('idle', name, async (handle) => {
      const result = await renderIdle({
        names: [name],
        seconds: body.seconds,
        fps: body.fps,
        characterFps: body.characterFps,
        scale: body.scale,
        seed: body.seed,
        onProgress: (done, total) => handle.progress({ stage: 'frames', done, total }),
      });
      return { ...result, url: outFileUrl(result.file) };
    });
    json(res, jobSummary(job));
  });

  router.post('/api/cast/:name/preview', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ pose?: string; expression?: string; look?: unknown; outfit?: unknown }>(req);

    const onDisk = new Set(await listRigs());
    // Unsaved edits win over whatever is on disk, so the preview follows the
    // controls rather than the last save. Outfit and look are independent: an
    // outfit change alone re-dresses the saved look.
    let loaded: LoadedRig;
    if (body.look || body.outfit) {
      const base = onDisk.has(name) ? await loadRig(name) : null;
      const look = body.look ? Look.parse(body.look) : (base?.rig.look ?? undefined);
      const outfit = body.outfit ? Outfit.parse(body.outfit) : base?.rig.outfit;
      loaded = { rig: buildPlaceholderRig(name, look, outfit), svg: buildPlaceholderSvg(name, look, outfit) };
    } else {
      loaded = onDisk.has(name)
        ? await loadRig(name)
        : { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) };
    }

    // One character, one frame — reusing the same preview machinery as scenes so
    // the cast editor shows exactly what a render would.
    //
    // Framed head to toe rather than as a close-up: the editor changes build,
    // limb length and proportions as well as the face, and the face has its own
    // panel. A tight shot would hide most of what the controls do.
    const plan = {
      scene: `cast-${name}`,
      fps: DEFAULT_PLAN.fps,
      characterFps: DEFAULT_PLAN.characterFps,
      width: STAGE.w,
      height: STAGE.h,
      seed: 1,
      durationSec: 1 / DEFAULT_PLAN.fps,
      // Head to feet with a little air: the puppet stands at y=700 and is roughly
      // 520 tall at this scale, so the frame runs 120..730.
      camera: { x: 98, y: 120, w: 1084, h: 610 },
      set: null,
      audio: null,
      actors: [{
        id: name,
        rig: name,
        x: STAGE.w / 2,
        y: STAGE.ground,
        scale: 1.3,
        flip: false,
        pose: body.pose ?? 'IDLE',
        expression: body.expression ?? 'NEUTRAL',
      }],
    };

    const rigs = new Map([[name, loaded]]);
    const ir = compileScene(plan, rigs);
    const { buildPage } = await import('../../render/page.ts');
    const runtime = await fs.readFile(new URL('../../render/runtime.js', import.meta.url), 'utf8');
    const html = await buildPage({ ir, rigs, runtime, background: '#2b2f36' });

    json(res, { previewId: storePreview(html), frameCount: 1 });
  });

  // --- voice cloning ---

  /**
   * Attach a reference clip, from a file or from the browser's microphone.
   *
   * Both arrive here as base64 with whatever container the source produced;
   * normalisation into mono 24kHz PCM happens on the way in, so a bad recording
   * fails now, with a message, rather than three minutes into a render.
   */
  router.put('/api/cast/:name/ref', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ filename?: string; dataBase64: string }>(req);
    if (!body.dataBase64) throw new HttpError(400, 'expected { filename, dataBase64 }');

    let info;
    try {
      info = await saveReference(name, Buffer.from(body.dataBase64, 'base64'), body.filename ?? 'clip.webm');
    } catch (err) {
      throw new HttpError(400, `could not use that clip: ${(err as Error).message}`);
    }

    const { rig, svg } = await loadRig(name);
    await saveRig({ ...rig, voiceRef: info.file }, svg);
    json(res, { ok: true, voiceRef: info.file, durationMs: info.durationMs, warnings: info.warnings });
  });

  router.get('/api/cast/:name/ref', ({ res, params, req }) =>
    sendFile(res, referencePath(params['name']!), req));

  router.del('/api/cast/:name/ref', async ({ res, params }) => {
    const name = params['name']!;
    await clearReference(name);
    const { rig, svg } = await loadRig(name);
    await saveRig({ ...rig, voiceRef: null }, svg);
    json(res, { ok: true, voiceRef: null });
  });

  /**
   * Speak one line in this character's voice.
   *
   * Runs as a job because the first Chatterbox call loads a model into VRAM and
   * takes tens of seconds — long enough that a synchronous request looks like a
   * hang. Later takes are cached and come back immediately. Passing `candidate`
   * auditions an uncommitted minted voice instead of the character's current one.
   */
  router.post('/api/cast/:name/audition', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ text?: string; expression?: string; engine?: string; seed?: number; candidate?: string }>(req);
    const { rig } = await loadRig(name);

    const job = startJob('audition', name, async (handle) => {
      const evicted = await freeVramForRender();
      if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

      handle.progress({ stage: 'synth', done: 0, total: 1 });
      const result = await auditionVoice(rig, {
        ...body,
        refOverride: body.candidate !== undefined ? candidatePath(name, body.candidate) : undefined,
      });
      handle.progress({ stage: 'synth', done: 1, total: 1 });
      // The take lands in the content-addressed voice cache; the UI fetches it
      // back through the route below rather than being handed a disk path.
      auditions.set(name, result.audio);
      return { durationMs: result.durationMs, text: result.text, cached: result.cached };
    });

    json(res, jobSummary(job));
  });

  // --- voice minting ---

  /**
   * Mint candidate voices for a character.
   *
   * A job — each candidate is a bank voice reading the mint paragraph plus a
   * loudness pass. Candidates sit in cast/.candidates until one is committed;
   * the character's current voice is untouched until then, and cancelling costs
   * nothing.
   */
  router.post('/api/cast/:name/voices/mint', async ({ req, res, params }) => {
    const name = params['name']!;
    const body = await readJson<{ count?: number }>(req);
    const { rig } = await loadRig(name);

    const job = startJob('mint-voices', name, async (handle) => {
      const evicted = await freeVramForRender();
      if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

      handle.progress({ stage: 'minting', done: 0, total: body.count ?? 3 });
      const candidates = await mintCandidates(name, rig.charId ?? name, body.count ?? 3);
      handle.progress({ stage: 'minting', done: candidates.length, total: candidates.length });
      return { candidates: candidates.map((c) => ({ salt: c.salt, bankVoice: c.params.bankVoice, speed: c.params.speed })) };
    });

    json(res, jobSummary(job));
  });

  router.get('/api/cast/:name/candidate/:salt', ({ res, params, req }) =>
    sendFile(res, candidatePath(params['name']!, params['salt']!), req));

  router.post('/api/cast/:name/voices/commit', async ({ req, res, params }) => {
    const body = await readJson<{ salt: string }>(req);
    if (body.salt === undefined) throw new HttpError(400, 'expected { salt }');
    await commitCandidate(params['name']!, body.salt);
    const { rig } = await loadRig(params['name']!);
    json(res, { ok: true, voiceRef: rig.voiceRef, provenance: rig.voiceProvenance });
  });

  router.post('/api/cast/:name/voices/discard', async ({ res, params }) => {
    await discardCandidates(params['name']!);
    json(res, { ok: true });
  });

  router.get('/api/cast/:name/audition.wav', ({ res, params, req }) => {
    const file = auditions.get(params['name']!);
    if (!file) throw new HttpError(404, 'no audition rendered for this character yet');
    return sendFile(res, file, req);
  });
}
