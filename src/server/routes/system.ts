import { json, readJson, sendFile, HttpError, type Router } from '../http.ts';
import { getJob, subscribe, jobSummary, activeJob } from '../jobs.ts';
import { engineStatusOf, probeEngines, protectRunningRenderState, safeOutPath, type EngineStatus } from '../state.ts';
import { runDoctor } from '../../pipeline/doctor.ts';
import { listVoices, ENGINE_NAMES } from '../../voice/index.ts';
import { voiceConversionRuntimeProvenance } from '../../voice/conversion.ts';
import { findRhubarb } from '../../voice/rhubarb.ts';
import { ffmpegVersion } from '../../render/encode.ts';
import { listSets } from '../../sets/index.ts';
import { BUILTIN_SET_NAMES } from '../../sets/builtins.ts';
import { listRigs } from '../../cast/store.ts';
import { Ollama, pickModel, SUGGESTED_MODELS } from '../../llm/ollama.ts';
import { generateScript } from '../../llm/script.ts';
import { generateSet } from '../../llm/set.ts';
import { activeIdentity } from '../../show/context.ts';
import { planMigration, applyMigration } from '../../show/migrate.ts';
import { stampOf } from '../../schema/identity.ts';
import { SHOTS, SHOT_PURPOSES, CAMERA_MOVES, MARKS } from '../../schema/script.ts';
import { EMOTION_WORDS, CANONICAL_EMOTION_KEYWORDS, EXPRESSION_FALLBACKS } from '../../direct/emotions.ts';
import {
  ACTION_TEMPLATES, MARK_PHRASES, DIRECTION_PHRASES, COUNT_PHRASES,
} from '../../direct/action-canon.ts';
import { PALETTE_NAMES } from '../../sets/palettes.ts';
import { LOOK_CHOICES, LOOK_SWATCHES, LOOK_SLIDERS, OUTFIT_CHOICES, ACCENTS } from '../../schema/index.ts';
import { AUDITION_LINES } from '../../pipeline/audition.ts';
import { IDEAL_SECONDS } from '../../voice/reference.ts';
import { ROOT } from '../../core/paths.ts';
import path from 'node:path';

export function registerSystemRoutes(router: Router): void {
  router.get('/api/health', async ({ res }) => {
    // Re-kick any probe whose memoized result is a failure. Still async: this
    // request reports the stale status, the next one reports the healed one.
    probeEngines();

    const [ff, rhubarb, voices, sets, cast] = await Promise.all([
      ffmpegVersion(),
      findRhubarb(),
      listVoices(),
      listSets(),
      listRigs(),
    ]);

    const engines: Record<string, EngineStatus> = {};
    for (const name of ENGINE_NAMES) engines[name] = engineStatusOf(name);
    engines['chatterbox-vc'] = engineStatusOf('chatterbox-vc');

    // Cheap: /api/tags is a local HTTP call with a short timeout, unlike the
    // Python engine probes.
    const llm = await new Ollama().available();
    // Identity of the conversion runtime as it stands now. Renders carry the
    // fingerprint they were made with, so a client can tell which of its
    // conversions this build would still produce.
    const voiceConversion = await voiceConversionRuntimeProvenance();

    json(res, {
      ffmpeg: ff,
      rhubarb: rhubarb ? path.relative(ROOT, rhubarb) : null,
      engines,
      voiceConversion,
      llm: llm.ok
        ? { ok: true, models: llm.models.map((m) => m.name), recommended: pickModel(llm.models) }
        : { ok: false, reason: llm.reason, models: [], recommended: null },
      sapiVoices: voices,
      sets: [...new Set([...sets, ...BUILTIN_SET_NAMES])].sort(),
      cast,
      activeJob: activeJob() ? jobSummary(activeJob()!) : null,
    });
  });

  /**
   * The full toolchain report — `anim doctor`, served.
   *
   * Engine verdicts come from the server's memoized probes rather than a fresh
   * torch import per click; everything else (ffmpeg, chromium, caches, strays,
   * ASR) is probed fresh, because the whole point of opening the report is
   * asking what is true now.
   */
  router.get('/api/doctor', async ({ res }) => {
    probeEngines();
    const report = await runDoctor({
      probeEngine: async (name) => engineStatusOf(name),
    });
    json(res, report);
  });

  router.get('/api/vocab', ({ res }) => {
    json(res, {
      shots: SHOTS,
      shotPurposes: SHOT_PURPOSES,
      cameraMoves: CAMERA_MOVES,
      marks: Object.keys(MARKS),
      // TALK and NONE are compiler concepts rather than rig poses, so they are
      // always offered even though no rig declares them.
      gestures: ['NONE', 'TALK', 'POINT', 'SHRUG', 'ARMS_UP', 'LEAN_IN'],
      // The parenthetical vocabulary, shipped as data so the composer can offer
      // it and replay the resolution rule rather than keep its own copy. Order
      // matters — the client tests patterns in this sequence and takes the
      // first hit, exactly as expressionFor does.
      emotions: {
        words: EMOTION_WORDS.map(([re, expression]) => ({ pattern: re.source, expression })),
        canonical: CANONICAL_EMOTION_KEYWORDS,
        fallbacks: EXPRESSION_FALLBACKS,
      },
      // Wordings the director is known to read back, so the composer can offer
      // staging as a choice instead of leaving it to be guessed at in prose.
      actions: {
        templates: ACTION_TEMPLATES,
        marks: MARK_PHRASES,
        directions: DIRECTION_PHRASES,
        counts: COUNT_PHRASES,
      },
      palettes: PALETTE_NAMES,
      engines: ENGINE_NAMES,
      // The appearance editor builds its controls from these rather than
      // hardcoding option lists, so adding a hairstyle needs no UI change.
      look: { choices: LOOK_CHOICES, swatches: LOOK_SWATCHES, sliders: LOOK_SLIDERS },
      outfit: {
        choices: OUTFIT_CHOICES,
        accents: activeIdentity().visual.accents.length ? activeIdentity().visual.accents : ACCENTS,
      },
      auditionLines: AUDITION_LINES,
      referenceSeconds: IDEAL_SECONDS,
    });
  });

  // --- project migration ---

  /** The migration plan, dry. Nothing is written by looking. */
  router.get('/api/migrate', async ({ res }) => {
    const plan = await planMigration();
    json(res, {
      identity: { ...stampOf(plan.identity), name: plan.identity.name },
      createProfile: plan.createProfile,
      changes: plan.changes,
    });
  });

  /** Apply the migration. Replans server-side so the writes match disk, not a stale client. */
  router.post('/api/migrate', async ({ res }) => {
    protectRunningRenderState('the project migration');
    const plan = await planMigration();
    if (plan.changes.length) await applyMigration(plan);
    json(res, {
      ok: true,
      applied: plan.changes.length,
      changes: plan.changes,
    });
  });

  // --- jobs ---

  router.get('/api/jobs/:id', ({ res, params }) => {
    const job = getJob(params['id']!);
    if (!job) throw new HttpError(404, 'no such job');
    json(res, jobSummary(job));
  });

  router.get('/api/jobs/:id/events', ({ res, params }) => {
    const job = getJob(params['id']!);
    if (!job) throw new HttpError(404, 'no such job');
    subscribe(job, res);
  });

  // --- artifacts under out/ ---

  // Sheets, stills, reels and idle clips land under out/ as plain files; these
  // two routes are how the editor shows them. Depth is capped at two segments
  // and everything resolves inside out/ or is refused.
  router.get('/api/out/:file', ({ res, params, req }) =>
    sendFile(res, safeOutPath(params['file']!), req));

  router.get('/api/out/:dir/:file', ({ res, params, req }) =>
    sendFile(res, safeOutPath(params['dir']!, params['file']!), req));

  // --- local LLM ---

  router.get('/api/llm', async ({ res }) => {
    const status = await new Ollama().available();
    json(res, {
      ok: status.ok,
      reason: status.ok ? null : status.reason,
      models: status.ok ? status.models : [],
      suggested: SUGGESTED_MODELS,
      recommended: status.ok ? pickModel(status.models) : null,
    });
  });

  router.post('/api/llm/script', async ({ req, res }) => {
    const body = await readJson<{ premise: string; model?: string; characters?: number; targetSeconds?: number }>(req);
    if (!body.premise?.trim()) throw new HttpError(400, 'expected { premise }');

    const status = await new Ollama().available();
    if (!status.ok) throw new HttpError(503, status.reason);

    const model = pickModel(status.models, body.model);
    if (!model) throw new HttpError(503, 'no Ollama model installed');

    const result = await generateScript({
      premise: body.premise,
      model,
      characters: body.characters,
      targetSeconds: body.targetSeconds,
    });
    json(res, { ...result, model });
  });

  router.post('/api/llm/set', async ({ req, res }) => {
    const body = await readJson<{ description: string; name: string; model?: string }>(req);
    if (!body.description?.trim()) throw new HttpError(400, 'expected { description }');
    if (!body.name?.trim()) throw new HttpError(400, 'expected { name }');

    const status = await new Ollama().available();
    if (!status.ok) throw new HttpError(503, status.reason);

    const model = pickModel(status.models, body.model);
    if (!model) throw new HttpError(503, 'no Ollama model installed');

    const result = await generateSet({
      description: body.description,
      name: body.name.trim().toLowerCase().replace(/[^\w-]/g, '-'),
      model,
    });
    json(res, { ...result, model });
  });
}
