import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, CAST_DIR, sceneDir } from '../core/paths.ts';
import { Router, json, text, readJson, sendFile, HttpError, type Ctx } from './http.ts';
import { startJob, getJob, subscribe, jobSummary, activeJob } from './jobs.ts';
import {
  listScenes, readScript, writeScript, readShotList, writeShotList,
  exists, outputPath, scriptPath,
} from '../pipeline/scene.ts';
import { checkScript, summarise, loadRigsForShotList } from '../pipeline/check.ts';
import { buildPreview } from '../pipeline/preview.ts';
import { renderScene } from '../pipeline/render.ts';
import { resolveTimings, mixSceneAudio } from '../pipeline/voices.ts';
import { compileShotList } from '../compile/scene.ts';
import { listRigs, loadRig, saveRig, validateRig, type LoadedRig } from '../cast/store.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { createRig, regenerateRig, lookOf } from '../cast/authoring.ts';
import { facePlates } from '../cast/sheet.ts';
import { rollLook } from '../cast/look.ts';
import { Rig, Look, LOOK_CHOICES, LOOK_SWATCHES, LOOK_SLIDERS } from '../schema/index.ts';
import { saveReference, clearReference, referencePath, IDEAL_SECONDS } from '../voice/reference.ts';
import { auditionVoice, AUDITION_LINES } from '../pipeline/audition.ts';
import { ShotList, SHOTS, CAMERA_MOVES, MARKS } from '../schema/script.ts';
import { listSets, loadSet, saveSet, validateSet, lintSet, tidySet, setPath } from '../sets/index.ts';
import { SetDescriptor } from '../sets/schema.ts';
import { BUILTIN_SETS, BUILTIN_SET_NAMES } from '../sets/builtins.ts';
import { propManifest, propTags } from '../sets/props/index.ts';
import { PALETTES, PALETTE_NAMES } from '../sets/palettes.ts';
import { ENGINE_NAMES, getEngine, listVoices } from '../voice/index.ts';
import { findRhubarb } from '../voice/rhubarb.ts';
import { ffmpegVersion } from '../render/encode.ts';
import { compileScene, DEFAULT_PLAN } from '../compile/index.ts';
import { Ollama, freeVramForRender, pickModel, SUGGESTED_MODELS } from '../llm/ollama.ts';
import { generateScript } from '../llm/script.ts';
import { generateSet } from '../llm/set.ts';

const UI_DIST = path.join(ROOT, 'ui', 'dist');
const STAGE = { w: 1280, h: 720, ground: 700 };

/**
 * Built preview pages, held in memory and served to the iframe.
 *
 * Previews are cheap to rebuild and meaningless once superseded, so they never
 * touch disk. Capped so a long editing session can't grow without bound.
 */
const previews = new Map<string, { html: string; createdAt: number }>();
const PREVIEW_CAP = 24;

/**
 * The most recent audition take per character.
 *
 * Points into the content-addressed voice cache, so it survives a restart of
 * nothing at all — which is correct. An audition is a thing you just asked for.
 */
const auditions = new Map<string, string>();

function storePreview(html: string): string {
  const id = randomUUID();
  previews.set(id, { html, createdAt: Date.now() });
  while (previews.size > PREVIEW_CAP) {
    const oldest = [...previews.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    previews.delete(oldest[0]);
  }
  return id;
}

// --- helpers --------------------------------------------------------------

async function requireShotList(scene: string): Promise<ShotList> {
  const shots = await readShotList(scene);
  if (!shots) throw new HttpError(409, `scene "${scene}" has not been directed yet`);
  return shots;
}

/** Rigs for a shot list, standing in placeholders for any not yet on disk. */
async function rigsFor(shots: ShotList): Promise<Map<string, LoadedRig>> {
  const onDisk = new Set(await listRigs());
  const rigs = new Map<string, LoadedRig>();
  for (const member of shots.cast) {
    if (rigs.has(member.rig)) continue;
    rigs.set(
      member.rig,
      onDisk.has(member.rig)
        ? await loadRig(member.rig)
        : { rig: buildPlaceholderRig(member.rig), svg: buildPlaceholderSvg(member.rig) },
    );
  }
  return rigs;
}

// --- routes ---------------------------------------------------------------

const router = new Router();

/**
 * Engine availability, probed in the background.
 *
 * Checking Chatterbox means spawning Python and importing torch, which takes
 * tens of seconds. Doing that inline made /api/health hang long enough to look
 * like the server was dead. It is probed once at startup and the result cached
 * for the process lifetime — it cannot change while we are running.
 */
type EngineStatus = { ok: boolean; reason?: string; checking?: boolean };
const engineStatus = new Map<string, EngineStatus>();

function probeEngines(): void {
  for (const name of ENGINE_NAMES) {
    if (engineStatus.has(name)) continue;
    engineStatus.set(name, { ok: false, checking: true });
    void getEngine(name)
      .available()
      .then((s) => engineStatus.set(name, s.ok ? { ok: true } : { ok: false, reason: s.reason }))
      .catch((err: unknown) =>
        engineStatus.set(name, { ok: false, reason: err instanceof Error ? err.message : String(err) }),
      );
  }
}

router.get('/api/health', async ({ res }) => {
  const [ff, rhubarb, voices, sets, cast] = await Promise.all([
    ffmpegVersion(),
    findRhubarb(),
    listVoices(),
    listSets(),
    listRigs(),
  ]);

  const engines: Record<string, EngineStatus> = {};
  for (const name of ENGINE_NAMES) engines[name] = engineStatus.get(name) ?? { ok: false, checking: true };

  // Cheap: /api/tags is a local HTTP call with a short timeout, unlike the
  // Python engine probes.
  const llm = await new Ollama().available();

  json(res, {
    ffmpeg: ff,
    rhubarb: rhubarb ? path.relative(ROOT, rhubarb) : null,
    engines,
    llm: llm.ok
      ? { ok: true, models: llm.models.map((m) => m.name), recommended: pickModel(llm.models) }
      : { ok: false, reason: llm.reason, models: [], recommended: null },
    sapiVoices: voices,
    sets: [...new Set([...sets, ...BUILTIN_SET_NAMES])].sort(),
    cast,
    activeJob: activeJob() ? jobSummary(activeJob()!) : null,
  });
});

router.get('/api/vocab', ({ res }) => {
  json(res, {
    shots: SHOTS,
    cameraMoves: CAMERA_MOVES,
    marks: Object.keys(MARKS),
    // TALK and NONE are compiler concepts rather than rig poses, so they are
    // always offered even though no rig declares them.
    gestures: ['NONE', 'TALK', 'POINT', 'SHRUG', 'ARMS_UP', 'LEAN_IN'],
    palettes: PALETTE_NAMES,
    engines: ENGINE_NAMES,
    // The appearance editor builds its controls from these rather than
    // hardcoding option lists, so adding a hairstyle needs no UI change.
    look: { choices: LOOK_CHOICES, swatches: LOOK_SWATCHES, sliders: LOOK_SLIDERS },
    auditionLines: AUDITION_LINES,
    referenceSeconds: IDEAL_SECONDS,
  });
});

// --- scenes ---

router.get('/api/scenes', async ({ res }) => {
  const names = await listScenes();
  const scenes = [];
  for (const name of names) {
    const shots = await readShotList(name).catch(() => null);
    scenes.push({
      name,
      directed: !!shots,
      beats: shots?.beats.length ?? 0,
      set: shots?.set ?? null,
      hasVideo: await exists(outputPath(name)),
    });
  }
  json(res, scenes);
});

router.get('/api/scenes/:name', async ({ res, params }) => {
  const scene = params['name']!;
  if (!(await exists(scriptPath(scene)))) throw new HttpError(404, `no scene "${scene}"`);

  const source = await readScript(scene);
  const shots = await readShotList(scene).catch(() => null);
  json(res, {
    name: scene,
    source,
    shots,
    summary: shots ? summarise(shots) : null,
    hasAudio: await exists(path.join(sceneDir(scene), 'dialogue.wav')),
    hasVideo: await exists(outputPath(scene)),
  });
});

router.put('/api/scenes/:name', async ({ req, res, params }) => {
  const { source } = await readJson<{ source: string }>(req);
  if (typeof source !== 'string') throw new HttpError(400, 'expected { source }');
  await writeScript(params['name']!, source);
  json(res, { ok: true });
});

router.post('/api/scenes/:name/check', async ({ req, res, params }) => {
  const body = await readJson<{ source?: string; seed?: number; resting?: string; set?: string | null }>(req);
  const scene = params['name']!;
  const source = body.source ?? (await readScript(scene));

  const result = await checkScript(source, {
    scene,
    seed: body.seed,
    resting: body.resting,
    set: body.set ?? null,
  });

  json(res, {
    characters: result.screenplay.characters,
    newCharacters: result.newCharacters,
    errors: result.errors,
    estimateMs: result.estimateMs,
    beatCounts: result.beatCounts,
    beats: result.shots?.beats ?? [],
    cast: result.shots?.cast ?? [],
  });
});

/** Re-run the director, replacing any hand edits to the shot list. */
router.post('/api/scenes/:name/direct', async ({ req, res, params }) => {
  const body = await readJson<{ source?: string; seed?: number; resting?: string; set?: string | null }>(req);
  const scene = params['name']!;
  const source = body.source ?? (await readScript(scene));

  const result = await checkScript(source, {
    scene,
    seed: body.seed,
    resting: body.resting,
    set: body.set ?? null,
    createMissingCast: true,
  });

  if (!result.shots) throw new HttpError(400, result.errors.join('; ') || 'could not direct this script');
  await writeShotList(scene, result.shots);
  json(res, { shots: result.shots, errors: result.errors, newCharacters: result.newCharacters });
});

router.put('/api/scenes/:name/shotlist', async ({ req, res, params }) => {
  const body = await readJson<{ shots: unknown }>(req);
  const shots = ShotList.parse(body.shots);
  await writeShotList(params['name']!, shots);
  json(res, { ok: true, summary: summarise(shots) });
});

router.post('/api/scenes/:name/preview', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ withAudio?: boolean }>(req);
  const shots = await requireShotList(scene);
  const rigs = await rigsFor(shots);

  // Real timings only when the audio has actually been rendered; otherwise the
  // preview would claim a precision it doesn't have.
  let timings = null;
  if (body.withAudio && (await exists(path.join(sceneDir(scene), 'dialogue.wav')))) {
    timings = await resolveTimings(scene, shots, rigs, { engine: 'chatterbox' });
  }

  const preview = await buildPreview(shots, rigs, timings);
  json(res, {
    previewId: storePreview(preview.html),
    durationMs: preview.durationMs,
    frameCount: preview.ir.frames.length,
    fps: preview.ir.meta.fps,
    beatStarts: preview.beatStarts,
    estimated: preview.estimated,
  });
});

router.post('/api/scenes/:name/voices', async ({ res, params }) => {
  const scene = params['name']!;
  const shots = await requireShotList(scene);
  const rigs = await rigsFor(shots);

  const job = startJob('voices', scene, async (handle) => {
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

    const timings = await resolveTimings(scene, shots, rigs, {
      engine: 'chatterbox',
      onProgress: (stage, done, total) => handle.progress({ stage, done, total }),
    });
    const compiled = compileShotList(shots, rigs, timings);
    handle.progress({ stage: 'audio', done: 0, total: 1 });
    await mixSceneAudio(scene, compiled.audio, compiled.durationMs);
    return { lines: timings.size, durationMs: compiled.durationMs };
  });

  json(res, jobSummary(job));
});

router.post('/api/scenes/:name/render', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ engine?: string }>(req);
  const shots = await requireShotList(scene);
  const rigs = await rigsFor(shots);

  const job = startJob('render', scene, async (handle) => {
    // Evict any resident LLM before the GPU work starts. Writing happens before
    // rendering, so they never genuinely need to coexist — and on a 16GB card,
    // a 14B model plus Chatterbox is where the machine starts thrashing.
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

    return renderScene(shots, rigs, {
      scene,
      engine: body.engine ?? 'chatterbox',
      onStage: (p) => handle.progress({ stage: p.stage, done: p.done, total: p.total, message: p.message }),
    });
  });

  json(res, jobSummary(job));
});

router.get('/api/scenes/:name/audio', ({ res, params, req }) =>
  sendFile(res, path.join(sceneDir(params['name']!), 'dialogue.wav'), req));

router.get('/api/scenes/:name/video', ({ res, params, req }) =>
  sendFile(res, outputPath(params['name']!), req));

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

// --- cast ---

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
  const body = await readJson<{ look?: unknown; reroll?: boolean }>(req);
  const { rig, svg } = await regenerateRig(params['name']!, {
    look: body.look ? Look.parse(body.look) : undefined,
    reroll: body.reroll,
  });
  json(res, { rig, svg, look: rig.look });
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
  const body = await readJson<{ look?: unknown }>(req);

  const onDisk = (await listRigs()).includes(name);
  let loaded: LoadedRig;

  if (body.look) {
    // Unsaved edits: draw from the descriptor in the request, never from disk.
    const look = Look.parse(body.look);
    loaded = { rig: buildPlaceholderRig(name, look), svg: buildPlaceholderSvg(name, look) };
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
router.post('/api/cast/:name/regenerate', async ({ res, params }) => {
  const { rig, svg } = await regenerateRig(params['name']!);
  json(res, { rig, svg, look: rig.look });
});

router.post('/api/cast/:name/preview', async ({ req, res, params }) => {
  const name = params['name']!;
  const body = await readJson<{ pose?: string; expression?: string; look?: unknown }>(req);

  const onDisk = new Set(await listRigs());
  // An unsaved look wins over whatever is on disk, so the preview follows the
  // sliders rather than the last save.
  const loaded = body.look
    ? (() => {
        const look = Look.parse(body.look);
        return { rig: buildPlaceholderRig(name, look), svg: buildPlaceholderSvg(name, look) };
      })()
    : onDisk.has(name)
      ? await loadRig(name)
      : { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) };

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
  const { buildPage } = await import('../render/page.ts');
  const runtime = await fs.readFile(new URL('../render/runtime.js', import.meta.url), 'utf8');
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
 * hang. Later takes are cached and come back immediately.
 */
router.post('/api/cast/:name/audition', async ({ req, res, params }) => {
  const name = params['name']!;
  const body = await readJson<{ text?: string; expression?: string; engine?: string; seed?: number }>(req);
  const { rig } = await loadRig(name);

  const job = startJob('audition', name, async (handle) => {
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

    handle.progress({ stage: 'synth', done: 0, total: 1 });
    const result = await auditionVoice(rig, body);
    handle.progress({ stage: 'synth', done: 1, total: 1 });
    // The take lands in the content-addressed voice cache; the UI fetches it
    // back through the route below rather than being handed a disk path.
    auditions.set(name, result.audio);
    return { durationMs: result.durationMs, text: result.text, cached: result.cached };
  });

  json(res, jobSummary(job));
});

router.get('/api/cast/:name/audition.wav', ({ res, params, req }) => {
  const file = auditions.get(params['name']!);
  if (!file) throw new HttpError(404, 'no audition rendered for this character yet');
  return sendFile(res, file, req);
});

// --- sets ---

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
  const { buildPage } = await import('../render/page.ts');
  const { renderSet } = await import('../sets/index.ts');
  const runtime = await fs.readFile(new URL('../render/runtime.js', import.meta.url), 'utf8');
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

router.get('/api/props', ({ res }) => json(res, { props: propManifest(), tags: propTags() }));
router.get('/api/palettes', ({ res }) => json(res, PALETTES));

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

// --- preview pages ---

router.get('/preview/:id', ({ res, params }) => {
  const entry = previews.get(params['id']!);
  if (!entry) throw new HttpError(404, 'preview expired — rebuild it');
  text(res, entry.html, 200, 'text/html');
});

// --- server ---------------------------------------------------------------

async function serveUi(ctx: Ctx): Promise<void> {
  const pathname = new URL(ctx.req.url ?? '/', 'http://localhost').pathname;
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Contain path traversal: everything must resolve inside the build folder.
  const file = path.resolve(UI_DIST, rel);
  if (!file.startsWith(path.resolve(UI_DIST))) throw new HttpError(403, 'forbidden');

  if (await exists(file)) return sendFile(ctx.res, file, ctx.req);

  const index = path.join(UI_DIST, 'index.html');
  if (await exists(index)) return sendFile(ctx.res, index, ctx.req);

  text(
    ctx.res,
    'The UI has not been built yet.\n\nRun:  npm run ui:build\nThen reload this page.\n',
    503,
  );
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = { req, res, params: {}, query: url.searchParams };

    try {
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (match) {
        ctx.params = match.params;
        await match.handler(ctx);
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/')) {
        throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
      }
      await serveUi(ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(`[server] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) json(res, { error: message }, status);
      else res.end();
    }
  });
}

export function startServer(port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      probeEngines();
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
