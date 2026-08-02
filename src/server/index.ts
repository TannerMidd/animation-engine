import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, CAST_DIR, sceneDir } from '../core/paths.ts';
import { Router, json, text, readJson, sendFile, HttpError, type Ctx } from './http.ts';
import { startJob, getJob, subscribe, jobSummary, activeJob } from './jobs.ts';
import {
  listScenes, readScript, writeScript, readShotList, writeShotList,
  exists, outputPath, scriptPath,
} from '../pipeline/scene.ts';
import { checkScript, summarise, loadRigsForShotList, applySceneOutfits } from '../pipeline/check.ts';
import { mergeShotLists, diffShotLists } from '../pipeline/propose.ts';
import { buildPreview } from '../pipeline/preview.ts';
import { renderScene } from '../pipeline/render.ts';
import {
  approximateWordTimings,
  dialogueGuideIsCurrent,
  dialogueGuidePath,
  resolveTimings,
  mixSceneAudio,
} from '../pipeline/voices.ts';
import { compileShotList } from '../compile/scene.ts';
import { listRigs, loadRig, saveRig, validateRig, type LoadedRig } from '../cast/store.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { createRig, regenerateRig, lookOf } from '../cast/authoring.ts';
import { facePlates } from '../cast/sheet.ts';
import { rollLook } from '../cast/look.ts';
import { Rig, Look, Outfit, LOOK_CHOICES, LOOK_SWATCHES, LOOK_SLIDERS, OUTFIT_CHOICES, ACCENTS } from '../schema/index.ts';
import { saveReference, clearReference, referencePath, IDEAL_SECONDS } from '../voice/reference.ts';
import { mintCandidates, commitCandidate, discardCandidates, candidatePath, ensureVoiceRefs } from '../voice/casting.ts';
import { soundtrackIsCurrent, soundtrackManifestPath } from '../pipeline/voices.ts';
import { auditionVoice, AUDITION_LINES } from '../pipeline/audition.ts';
import { ShotList, SHOTS, SHOT_PURPOSES, CAMERA_MOVES, MARKS } from '../schema/script.ts';
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
import { initShow, listProfiles, loadProfile, activeProfileId, setActiveProfileId, compareProfiles } from '../show/store.ts';
import { setActiveIdentity, activeIdentity } from '../show/context.ts';
import { ShowIdentity, identityHash, stampOf } from '../schema/identity.ts';
import { generateScript } from '../llm/script.ts';
import { generateSet } from '../llm/set.ts';
import {
  syncDialogueDocument, readDialogueDocument, updateDialogueDocument, writeDialogueDocument,
  assessSceneRunSegment, revokeVoiceConsent,
} from '../pipeline/dialogue.ts';
import {
  DialogueDocument, DialogueCue, VoiceConsentRecord,
  type CaptureMode, type RegisterPolicy,
} from '../schema/dialogue.ts';
import {
  savePerformanceRecording, audioAssetForSceneFile, performanceAssetPath, extractPerformanceSegment,
} from '../voice/recording.ts';
import { readWav, toInt16 } from '../voice/wav.ts';
import { compareConversionAudio, convertPerformances, chatterboxVcAvailable } from '../voice/conversion.ts';
import { readAnimationOrDefault, retimeAnimationForDialogue, writeAnimation } from '../pipeline/animation.ts';
import { AnimationDocument } from '../schema/animation.ts';
import { estimatedAnimationTimeline, runProductionPreflight } from '../pipeline/preflight.ts';
import {
  appendPreflightWarningReview,
  latestPreflightWarningReview,
  productionReviewSnapshotDigest,
  warningAcknowledgementIsCurrent,
  type ProductionReviewSnapshot,
} from '../pipeline/preflight-review.ts';

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
  return applySceneOutfits(shots, rigs);
}

async function currentSoundtrackManifest(scene: string): Promise<string | null> {
  try {
    return await fs.readFile(soundtrackManifestPath(scene), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function captureProductionReviewSnapshot(
  scene: string,
  suppliedShots?: ShotList,
): Promise<ProductionReviewSnapshot> {
  const shots = suppliedShots ?? await requireShotList(scene);
  const [dialogue, animation, setDescriptor, rigs, soundtrackManifest] = await Promise.all([
    readDialogueDocument(scene),
    readAnimationOrDefault(scene),
    shots.set ? loadSet(shots.set) : Promise.resolve(null),
    rigsFor(shots),
    currentSoundtrackManifest(scene),
  ]);
  return {
    shots,
    dialogue,
    animation,
    setDescriptor,
    rigs,
    soundtrackManifest,
    identity: ShowIdentity.parse(structuredClone(activeIdentity())),
  };
}

/** Current screenplay lines projected into the editable production document. */
async function dialogueFor(scene: string, shots?: ShotList) {
  const resolved = shots ?? await requireShotList(scene);
  return syncDialogueDocument(scene, resolved);
}

function sceneAsset(scene: string, file: string): string {
  return performanceAssetPath(scene, file);
}

/** Voice references are deliberately confined to cast/ even if a rig was hand-edited. */
function castVoiceReference(file: string): string {
  if (!file || path.basename(file) !== file) {
    throw new HttpError(409, `voice reference "${file}" must be a file inside cast/`);
  }
  return path.join(CAST_DIR, file);
}

function protectRunningRenderState(label: string): void {
  const running = activeJob();
  if (running?.kind === 'render') {
    throw new HttpError(
      409,
      `${label} cannot change while production render ${running.id} is running; the save belongs to the next render`,
    );
  }
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
  if (!engineStatus.has('chatterbox-vc')) {
    engineStatus.set('chatterbox-vc', { ok: false, checking: true });
    void chatterboxVcAvailable()
      .then((status) => engineStatus.set(
        'chatterbox-vc',
        status.ok ? { ok: true } : { ok: false, reason: status.reason },
      ))
      .catch((err: unknown) => engineStatus.set('chatterbox-vc', {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
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
  engines['chatterbox-vc'] = engineStatus.get('chatterbox-vc') ?? { ok: false, checking: true };

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

// --- show identity ---

router.get('/api/show', async ({ res }) => {
  const identity = activeIdentity();
  json(res, {
    active: { ...stampOf(identity), name: identity.name },
    profiles: await listProfiles(),
  });
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

  const { saveProfile } = await import('../show/store.ts');
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

router.get('/api/vocab', ({ res }) => {
  json(res, {
    shots: SHOTS,
    shotPurposes: SHOT_PURPOSES,
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
    outfit: {
      choices: OUTFIT_CHOICES,
      accents: activeIdentity().visual.accents.length ? activeIdentity().visual.accents : ACCENTS,
    },
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
    hasVertical: await exists(path.join(sceneDir(scene), `${scene}.vertical.mp4`)),
    hasExport: await exists(path.join(sceneDir(scene), `${scene}.export.json`)),
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

/**
 * Run the director — as a proposal, never a replacement.
 *
 * Nothing is written. The response carries the proposed shot list, a beat
 * diff against what exists, and the merge preview (how many locked beats
 * survive). Applying is a second, explicit call.
 */
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

  const current = await readShotList(scene).catch(() => null);
  const { merged, droppedLocked, keptLocked } = mergeShotLists(current, result.shots);

  json(res, {
    proposed: merged,
    diff: diffShotLists(current, merged),
    keptLocked,
    droppedLocked: droppedLocked.length,
    errors: result.errors,
    newCharacters: result.newCharacters,
  });
});

/** Write an accepted proposal. The body is what /direct returned as `proposed`. */
router.post('/api/scenes/:name/direct/apply', async ({ req, res, params }) => {
  const body = await readJson<{ shots: unknown }>(req);
  const shots = ShotList.parse(body.shots);
  await writeShotList(params['name']!, shots);
  json(res, { ok: true, summary: summarise(shots) });
});

router.put('/api/scenes/:name/shotlist', async ({ req, res, params }) => {
  const body = await readJson<{ shots: unknown }>(req);
  const shots = ShotList.parse(body.shots);
  await writeShotList(params['name']!, shots);
  json(res, { ok: true, summary: summarise(shots) });
});

// --- creator dialogue performances ---------------------------------------

router.get('/api/scenes/:name/dialogue', async ({ res, params }) => {
  const scene = params['name']!;
  json(res, await dialogueFor(scene));
});

router.put('/api/scenes/:name/dialogue', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ document: unknown }>(req);
  const document = DialogueDocument.parse(body.document);
  const current = await dialogueFor(scene);
  if (document.revision !== current.revision) {
    throw new HttpError(409, `dialogue revision ${document.revision} does not match current revision ${current.revision}`);
  }
  const next = DialogueDocument.parse({ ...document, revision: current.revision + 1 });
  await writeDialogueDocument(scene, next);
  json(res, { ok: true, revision: next.revision });
});

router.put('/api/scenes/:name/dialogue/cues/:cue', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ cue: unknown; expectedRevision?: number }>(req);
  const cue = DialogueCue.parse(body.cue);
  if (cue.id !== params['cue']) throw new HttpError(400, 'cue id in the body must match the URL');
  const current = await dialogueFor(scene);
  if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) {
    throw new HttpError(409, `dialogue revision ${body.expectedRevision} does not match current revision ${current.revision}`);
  }
  const previousCue = current.cues.find((item) => item.id === cue.id);
  if (!previousCue) throw new HttpError(404, `no dialogue cue "${cue.id}"`);
  const next = DialogueDocument.parse({
    ...current,
    revision: current.revision + 1,
    cues: current.cues.map((item) => item.id === cue.id ? cue : item),
  });

  const timingDecisionChanged = JSON.stringify({
    selectedTakeId: previousCue.selectedTakeId,
    selectedRenderId: previousCue.selectedRenderId,
    trim: previousCue.trim,
    startFrame: previousCue.startFrame,
    durationFrames: previousCue.durationFrames,
    pickupMs: previousCue.pickupMs,
    turnGapMs: previousCue.turnGapMs,
    pauseAfterMs: previousCue.pauseAfterMs,
    overlap: previousCue.overlap,
    durationPolicy: { ...previousCue.durationPolicy, downstream: undefined },
  }) !== JSON.stringify({
    selectedTakeId: cue.selectedTakeId,
    selectedRenderId: cue.selectedRenderId,
    trim: cue.trim,
    startFrame: cue.startFrame,
    durationFrames: cue.durationFrames,
    pickupMs: cue.pickupMs,
    turnGapMs: cue.turnGapMs,
    pauseAfterMs: cue.pauseAfterMs,
    overlap: cue.overlap,
    durationPolicy: { ...cue.durationPolicy, downstream: undefined },
  });

  let animationRevision: number | null = null;
  let nextAnimation = null;
  if (timingDecisionChanged && cue.durationPolicy.downstream !== 'ripple') {
    const shots = await requireShotList(scene);
    const currentAnimation = await readAnimationOrDefault(scene);
    const retimed = retimeAnimationForDialogue(
      currentAnimation,
      cue.id,
      estimatedAnimationTimeline(shots, current),
      estimatedAnimationTimeline(shots, next),
      cue.durationPolicy.downstream,
    );
    if (JSON.stringify(retimed) !== JSON.stringify(currentAnimation)) {
      nextAnimation = AnimationDocument.parse({ ...retimed, revision: currentAnimation.revision + 1 });
      animationRevision = nextAnimation.revision;
    }
  }

  await writeDialogueDocument(scene, next);
  if (nextAnimation) await writeAnimation(scene, nextAnimation);
  json(res, {
    ok: true,
    revision: next.revision,
    cue,
    animationRevision,
    downstream: cue.durationPolicy.downstream,
  });
});

router.post('/api/scenes/:name/dialogue/:cue/takes', async ({ req, res, params }) => {
  const scene = params['name']!;
  const cueId = params['cue']!;
  const body = await readJson<{
    dataBase64: string;
    filename?: string;
    takeId?: string;
    mode?: CaptureMode;
    performerId?: string | null;
    consentId?: string | null;
    inputDevice?: string | null;
    latencyCompensationMs?: number;
    countInMs?: number;
    createdBy?: string | null;
  }>(req);
  if (!body.dataBase64) throw new HttpError(400, 'expected a recorded audio payload');

  const document = await dialogueFor(scene);
  const cue = document.cues.find((item) => item.id === cueId);
  if (!cue) throw new HttpError(404, `no dialogue cue "${cueId}"`);
  const takeId = body.takeId ?? `take-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  let captured;
  try {
    captured = await savePerformanceRecording(
      scene,
      cueId,
      takeId,
      Buffer.from(body.dataBase64, 'base64'),
      body.filename ?? 'recording.webm',
    );
  } catch (err) {
    throw new HttpError(400, `could not use that performance: ${(err as Error).message}`);
  }
  const audio = await audioAssetForSceneFile(scene, captured.normalizedAsset);
  const captureRejected = captured.durationMs < 180 || captured.speechRatio < 0.02 || captured.peakDb > -0.05;
  const captureWarned = captured.warnings.length > 0;
  const take = {
    id: takeId,
    cueId,
    speaker: cue.speaker,
    displayText: cue.displayText,
    spokenText: cue.spokenText,
    scriptTextHash: createHash('sha256').update(cue.spokenText).digest('hex'),
    audio,
    quality: {
      verdict: captureRejected ? 'reject' as const : captureWarned ? 'warn' as const : 'pass' as const,
      peakDb: Number.isFinite(captured.peakDb) ? captured.peakDb : null,
      rmsDb: Number.isFinite(captured.rmsDb) ? captured.rmsDb : null,
      speechRatio: captured.speechRatio,
      flags: captured.warnings,
    },
    capture: {
      mode: body.mode ?? 'line-booth',
      recordedAt: new Date().toISOString(),
      performerId: body.performerId ?? null,
      inputDevice: body.inputDevice ?? null,
      latencyCompensationMs: Math.round(body.latencyCompensationMs ?? 0),
      countInMs: Math.max(0, Math.round(body.countInMs ?? 0)),
      sourceFileName: body.filename ?? 'recording.webm',
      consentId: body.consentId ?? null,
    },
    provenance: { createdBy: body.createdBy ?? null, notes: captured.warnings, sceneRunSegments: [] },
  };

  const next = await updateDialogueDocument(scene, (current) => ({
    ...current,
    recordedTakes: [...current.recordedTakes, take],
    cues: current.cues.map((item) => item.id === cueId
      ? {
          ...item,
          selectedTakeId: takeId,
          selectedRenderId: null,
          trim: {
            inMs: 0,
            outMs: audio.durationMs,
            speechOnsetMs: 0,
            speechEndMs: audio.durationMs,
          },
          durationFrames: Math.max(1, Math.round((audio.durationMs / 1000) * current.fps)),
          approval: { ...item.approval, state: 'candidate' as const, at: null },
          provenance: { ...item.provenance, origin: 'recorded' as const, revision: item.provenance.revision + 1 },
        }
      : item),
  }));
  json(res, { ok: true, revision: next.revision, take, capture: captured });
});

/**
 * Store one continuous performance for a character and non-destructively map
 * its authored timeline regions onto that character's unlocked cues.
 * The shared raw take stays immutable; each cue owns only trim decisions.
 */
router.post('/api/scenes/:name/dialogue/scene-runs', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{
    dataBase64: string;
    filename?: string;
    speaker: string;
    segments: Array<{ cueId: string; inMs: number; outMs: number; speechOnsetMs?: number; speechEndMs?: number }>;
    performerId?: string | null;
    consentId?: string | null;
    inputDevice?: string | null;
    latencyCompensationMs?: number;
    countInMs?: number;
    createdBy?: string | null;
  }>(req);
  if (!body.dataBase64) throw new HttpError(400, 'expected a recorded Scene Run audio payload');
  if (!body.speaker) throw new HttpError(400, 'a Scene Run needs a speaker');
  if (!Array.isArray(body.segments) || !body.segments.length) {
    throw new HttpError(400, 'a Scene Run needs at least one cue segment');
  }

  const document = await dialogueFor(scene);
  const cueById = new Map(document.cues.map((cue) => [cue.id, cue]));
  const seen = new Set<string>();
  for (const segment of body.segments) {
    if (seen.has(segment.cueId)) throw new HttpError(400, `duplicate Scene Run segment for "${segment.cueId}"`);
    seen.add(segment.cueId);
    const cue = cueById.get(segment.cueId);
    if (!cue) throw new HttpError(404, `no dialogue cue "${segment.cueId}"`);
    if (cue.speaker !== body.speaker) throw new HttpError(400, `cue "${segment.cueId}" belongs to ${cue.speaker}, not ${body.speaker}`);
    if (cue.locked) throw new HttpError(409, `cue "${segment.cueId}" is locked; unlock it before replacing it from a Scene Run`);
    if (!Number.isFinite(segment.inMs) || !Number.isFinite(segment.outMs) || segment.inMs < 0 || segment.outMs <= segment.inMs) {
      throw new HttpError(400, `Scene Run segment for "${segment.cueId}" has invalid bounds`);
    }
  }

  const takeId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  let captured;
  try {
    captured = await savePerformanceRecording(
      scene,
      'scene-run',
      takeId,
      Buffer.from(body.dataBase64, 'base64'),
      body.filename ?? 'scene-run.webm',
    );
  } catch (err) {
    throw new HttpError(400, `could not use that Scene Run: ${(err as Error).message}`);
  }
  const audio = await audioAssetForSceneFile(scene, captured.normalizedAsset);
  const normalizedWav = await readWav(performanceAssetPath(scene, captured.normalizedAsset));
  const normalizedSamples = toInt16(normalizedWav, captured.normalizedAsset);
  const captureRejected = captured.durationMs < 180 || captured.speechRatio < 0.02 || captured.peakDb > -0.05;
  const captureWarned = captured.warnings.length > 0;
  const captureOffsetMs = Math.round(body.latencyCompensationMs ?? 0);
  const normalizedSegments = body.segments.map((segment) => {
    const inMs = Math.max(0, Math.round(segment.inMs + captureOffsetMs));
    const outMs = Math.min(audio.durationMs, Math.round(segment.outMs + captureOffsetMs));
    if (inMs >= audio.durationMs || outMs <= inMs) {
      throw new HttpError(400, `Scene Run ended before cue "${segment.cueId}" was captured`);
    }
    const speechOnsetMs = Math.max(inMs, Math.min(
      outMs,
      Math.round((segment.speechOnsetMs ?? segment.inMs) + captureOffsetMs),
    ));
    const speechEndMs = Math.max(speechOnsetMs, Math.min(
      outMs,
      Math.round((segment.speechEndMs ?? segment.outMs) + captureOffsetMs),
    ));
    return {
      cueId: segment.cueId,
      inMs,
      outMs,
      speechOnsetMs,
      speechEndMs,
      quality: assessSceneRunSegment(
        normalizedSamples,
        normalizedWav.sampleRate,
        normalizedWav.channels,
        inMs,
        outMs,
      ),
    };
  });
  const runCues = normalizedSegments.map((segment) => cueById.get(segment.cueId)!);
  const spokenText = runCues.map((cue) => cue.spokenText).join('\n');
  const displayText = runCues.map((cue) => cue.displayText).join('\n');
  const take = {
    id: takeId,
    cueId: null,
    speaker: body.speaker,
    displayText,
    spokenText,
    scriptTextHash: createHash('sha256').update(spokenText).digest('hex'),
    audio,
    quality: {
      verdict: captureRejected ? 'reject' as const : captureWarned ? 'warn' as const : 'pass' as const,
      peakDb: Number.isFinite(captured.peakDb) ? captured.peakDb : null,
      rmsDb: Number.isFinite(captured.rmsDb) ? captured.rmsDb : null,
      speechRatio: captured.speechRatio,
      flags: captured.warnings,
    },
    capture: {
      mode: 'scene-run' as const,
      recordedAt: new Date().toISOString(),
      performerId: body.performerId ?? null,
      inputDevice: body.inputDevice ?? null,
      latencyCompensationMs: captureOffsetMs,
      countInMs: Math.max(0, Math.round(body.countInMs ?? 0)),
      sourceFileName: body.filename ?? 'scene-run.webm',
      consentId: body.consentId ?? null,
    },
    provenance: {
      createdBy: body.createdBy ?? null,
      notes: [...captured.warnings, `Scene Run mapped to ${normalizedSegments.length} cue${normalizedSegments.length === 1 ? '' : 's'}`],
      sceneRunSegments: normalizedSegments.map((segment) => {
        const cue = cueById.get(segment.cueId)!;
        return {
          cueId: segment.cueId,
          scriptTextHash: createHash('sha256').update(cue.spokenText).digest('hex'),
          inMs: segment.inMs,
          outMs: segment.outMs,
          speechOnsetMs: segment.speechOnsetMs,
          speechEndMs: segment.speechEndMs,
          quality: segment.quality,
        };
      }),
    },
  };
  const segmentByCue = new Map(normalizedSegments.map((segment) => [segment.cueId, segment]));
  const next = await updateDialogueDocument(scene, (current) => ({
    ...current,
    recordedTakes: [...current.recordedTakes, take],
    cues: current.cues.map((item) => {
      const segment = segmentByCue.get(item.id);
      if (!segment) return item;
      return {
        ...item,
        selectedTakeId: takeId,
        selectedRenderId: null,
        trim: {
          inMs: segment.inMs,
          outMs: segment.outMs,
          speechOnsetMs: segment.speechOnsetMs,
          speechEndMs: segment.speechEndMs,
        },
        durationFrames: Math.max(1, Math.round(((segment.outMs - segment.inMs) / 1000) * current.fps)),
        approval: { ...item.approval, state: 'candidate' as const, at: null },
        provenance: { ...item.provenance, origin: 'recorded' as const, revision: item.provenance.revision + 1 },
      };
    }),
  }));
  json(res, { ok: true, revision: next.revision, take, capture: captured, segments: normalizedSegments });
});

router.get('/api/scenes/:name/dialogue/takes/:take/audio', async ({ res, params, req }) => {
  const scene = params['name']!;
  const document = await readDialogueDocument(scene);
  const take = document?.recordedTakes.find((item) => item.id === params['take']);
  if (!take) throw new HttpError(404, 'no such recorded take');
  return sendFile(res, sceneAsset(scene, take.audio.file), req);
});

router.get('/api/scenes/:name/dialogue/renders/:render/audio', async ({ res, params, req }) => {
  const scene = params['name']!;
  const document = await readDialogueDocument(scene);
  const render = document?.voiceRenders.find((item) => item.id === params['render']);
  if (!render?.audio) throw new HttpError(404, 'no such voice render');
  return sendFile(res, sceneAsset(scene, render.audio.file), req);
});

router.post('/api/scenes/:name/dialogue/:cue/consents', async ({ req, res, params }) => {
  const scene = params['name']!;
  const cueId = params['cue']!;
  const body = await readJson<{
    id?: string;
    subject?: string;
    basis?: 'self-owned' | 'written-license' | 'performer-contract' | 'synthetic-owned';
    scope?: 'target-voice' | 'performance' | 'both';
    distribution?: boolean;
    training?: boolean;
    expiresAt?: string | null;
    notes?: string[];
    confirmed?: boolean;
  }>(req);
  if (!body.confirmed) throw new HttpError(400, 'confirm that you own or have permission to use the selected voice/performance rights');
  const shots = await requireShotList(scene);
  const document = await dialogueFor(scene, shots);
  const cue = document.cues.find((item) => item.id === cueId);
  if (!cue) throw new HttpError(404, `no dialogue cue "${cueId}"`);
  const member = shots.cast.find((item) => item.id === cue.speaker);
  if (!member) throw new HttpError(409, `speaker "${cue.speaker}" is not in the cast`);
  const scope = body.scope ?? 'target-voice';
  let referenceChecksum: string | null = null;
  if (scope === 'target-voice' || scope === 'both') {
    const { rig } = await loadRig(member.rig);
    if (!rig.voiceRef) throw new HttpError(409, `character "${member.rig}" needs a target voice reference`);
    const target = castVoiceReference(rig.voiceRef);
    referenceChecksum = createHash('sha256').update(await fs.readFile(target)).digest('hex');
  }
  const consent = VoiceConsentRecord.parse({
    id: body.id,
    subject: body.subject,
    basis: body.basis,
    scope,
    referenceChecksum,
    permits: {
      voiceConversion: true,
      distribution: body.distribution ?? true,
      training: body.training ?? false,
    },
    createdAt: new Date().toISOString(),
    expiresAt: body.expiresAt ?? null,
    revokedAt: null,
    notes: body.notes ?? [],
  });
  if (document.consents.some((item) => item.id === consent.id)) {
    throw new HttpError(409, `consent record "${consent.id}" already exists; create a new record or revoke the old one`);
  }
  const next = await updateDialogueDocument(scene, (current) => ({
    ...current,
    consents: [...current.consents, consent],
  }));
  json(res, { ok: true, revision: next.revision, consent });
});

router.post('/api/scenes/:name/dialogue/consents/:consent/revoke', async ({ res, params }) => {
  const scene = params['name']!;
  const consentId = params['consent']!;
  const document = await dialogueFor(scene);
  if (!document.consents.some((item) => item.id === consentId)) {
    throw new HttpError(404, `no consent record "${consentId}"`);
  }
  const next = await revokeVoiceConsent(scene, consentId);
  const revokedAt = next.consents.find((item) => item.id === consentId)!.revokedAt;
  json(res, { ok: true, revision: next.revision, revokedAt });
});

router.post('/api/scenes/:name/dialogue/:cue/convert', async ({ req, res, params }) => {
  const scene = params['name']!;
  const cueId = params['cue']!;
  const body = await readJson<{
    takeId?: string;
    consentId?: string;
    registerPolicy?: RegisterPolicy;
    seed?: number;
  }>(req);
  if (!body.consentId) throw new HttpError(400, 'voice conversion requires an explicit consent record id');

  const shots = await requireShotList(scene);
  const document = await dialogueFor(scene, shots);
  const cue = document.cues.find((item) => item.id === cueId);
  if (!cue) throw new HttpError(404, `no dialogue cue "${cueId}"`);
  const takeId = body.takeId ?? cue.selectedTakeId;
  const take = document.recordedTakes.find((item) => item.id === takeId);
  if (!take) throw new HttpError(400, 'select a recorded performance before converting it');
  const member = shots.cast.find((item) => item.id === cue.speaker);
  if (!member) throw new HttpError(409, `speaker "${cue.speaker}" is not in the cast`);
  const { rig } = await loadRig(member.rig);
  if (!rig.voiceRef) throw new HttpError(409, `character "${member.rig}" needs an approved target voice reference`);

  const selectedRender = cue.selectedRenderId
    ? document.voiceRenders.find((item) => item.id === cue.selectedRenderId)
    : null;
  const previousSource = selectedRender?.source.kind === 'voice-conversion' && selectedRender.source.takeId === take.id
    ? selectedRender.source
    : null;
  const runSegment = take.provenance.sceneRunSegments.find((item) => item.cueId === cue.id);
  const resolvedSourceTrim = previousSource?.sourceTrim ?? runSegment ?? (
    cue.selectedTakeId === take.id && cue.selectedRenderId === null ? cue.trim : null
  ) ?? {
    inMs: 0,
    outMs: take.audio.durationMs,
    speechOnsetMs: 0,
    speechEndMs: take.audio.durationMs,
  };
  const sourceTrim = {
    inMs: resolvedSourceTrim.inMs,
    outMs: resolvedSourceTrim.outMs,
    speechOnsetMs: resolvedSourceTrim.speechOnsetMs,
    speechEndMs: resolvedSourceTrim.speechEndMs,
  };
  if (
    sourceTrim.inMs < 0 || sourceTrim.outMs > take.audio.durationMs + 2 ||
    sourceTrim.outMs <= sourceTrim.inMs || sourceTrim.speechOnsetMs < sourceTrim.inMs ||
    sourceTrim.speechEndMs < sourceTrim.speechOnsetMs || sourceTrim.speechEndMs > sourceTrim.outMs
  ) {
    throw new HttpError(409, `source trim for take "${take.id}" is no longer valid; reselect the raw take segment`);
  }
  let sourceAsset = take.audio.file;
  let sourceDurationMs = take.audio.durationMs;
  if (sourceTrim.inMs > 0 || sourceTrim.outMs < take.audio.durationMs) {
    sourceAsset = await extractPerformanceSegment(
      scene,
      take.id,
      cue.id,
      take.audio.file,
      sourceTrim.inMs,
      sourceTrim.outMs,
    );
    sourceDurationMs = sourceTrim.outMs - sourceTrim.inMs;
  }
  const source = sceneAsset(scene, sourceAsset);
  const target = castVoiceReference(rig.voiceRef);
  const targetChecksum = createHash('sha256').update(await fs.readFile(target)).digest('hex');
  const consent = document.consents.find((item) => item.id === body.consentId);
  if (!consent) throw new HttpError(409, `consent record "${body.consentId}" does not exist for this scene`);
  if (consent.revokedAt) throw new HttpError(409, `consent record "${consent.id}" was revoked at ${consent.revokedAt}`);
  if (consent.expiresAt && Date.parse(consent.expiresAt) <= Date.now()) {
    throw new HttpError(409, `consent record "${consent.id}" expired at ${consent.expiresAt}`);
  }
  if (!consent.permits.voiceConversion || !consent.permits.distribution) {
    throw new HttpError(409, `consent record "${consent.id}" does not permit conversion and distribution`);
  }
  if (consent.scope !== 'target-voice' && consent.scope !== 'both') {
    throw new HttpError(409, `consent record "${consent.id}" does not cover a target voice`);
  }
  if (consent.referenceChecksum !== targetChecksum) {
    throw new HttpError(409, `target voice reference changed after consent "${consent.id}" was recorded; register permission for the current reference`);
  }
  const registerPolicy = body.registerPolicy ?? 'adapt-to-character';
  const seed = body.seed ?? shots.seed * 1000 + cue.beatIndex;

  const job = startJob('voice-convert', scene, async (handle) => {
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);
    handle.progress({ stage: 'voice-conversion', done: 0, total: 1 });
    const converted = (await convertPerformances(
      [{ id: cueId, source, targetRef: target, seed, registerPolicy }],
      (done, total, message) => handle.progress({ stage: 'voice-conversion', done, total, message }),
    )).get(cueId)!;

    // A conversion attempt is immutable audit evidence. Even when model output
    // comes from the deterministic cache, rerunning appends a new record/file
    // instead of rewriting a prior VoiceRender under the same ID.
    const renderId = `vc-${converted.cacheKey.slice(0, 20)}-${randomUUID().slice(0, 8)}`;
    const relative = `dialogue/renders/${renderId}.wav`;
    const destination = sceneAsset(scene, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(converted.audio, destination);
    const audio = await audioAssetForSceneFile(scene, relative);
    const acoustic = await compareConversionAudio(source, destination);
    const deltaRatio = Math.abs(converted.durationDeltaMs) / Math.max(1, converted.sourceDurationMs);
    const frameMs = 1000 / shots.fps;
    const severeQualityFailure = (
      deltaRatio > cue.durationPolicy.maxVoicedStretchRatio ||
      acoustic.outputSpeechRatio < 0.04 ||
      acoustic.clippedSampleRatio > 0.01 ||
      acoustic.cadenceSimilarity < 0.45
    );
    const state = severeQualityFailure ? 'rejected' as const : 'ready' as const;
    // Without a local ASR verifier we do not call a conversion an automatic
    // pass. The cadence metrics reject structural failures; transcript review
    // remains visible and human-owned before approval.
    const verdict = state === 'rejected' ? 'reject' as const : 'warn' as const;
    const timingRatio = audio.durationMs / Math.max(1, sourceDurationMs);
    const speechStartMs = Math.max(0, sourceTrim.speechOnsetMs - sourceTrim.inMs);
    const speechEndMs = Math.max(speechStartMs, sourceTrim.speechEndMs - sourceTrim.inMs);
    const outputSpeechStartMs = Math.max(0, Math.min(audio.durationMs, Math.round(speechStartMs * timingRatio)));
    const outputSpeechEndMs = Math.max(
      outputSpeechStartMs,
      Math.min(audio.durationMs, Math.round(speechEndMs * timingRatio)),
    );
    const alignedWords = approximateWordTimings(
      cue.spokenText,
      outputSpeechStartMs,
      outputSpeechEndMs,
    ).map(({ text, startMs, endMs, confidence }) => ({ text, startMs, endMs, confidence: confidence ?? null }));
    const qualityFlags = [
      ...converted.warnings,
      ...acoustic.flags,
      ...(Math.abs(converted.durationDeltaMs) > frameMs
        ? [`duration differs by ${Math.round(converted.durationDeltaMs)} ms; review sync before approval`]
        : []),
      'transcript identity is not machine-verified; audition the source and conversion before approval',
    ];
    if (state === 'rejected' && deltaRatio > cue.durationPolicy.maxVoicedStretchRatio) {
      qualityFlags.unshift(
        `duration changed by ${(deltaRatio * 100).toFixed(1)}%; re-record or use the original take`,
      );
    }
    const voiceRender = {
      id: renderId,
      source: {
        kind: 'voice-conversion' as const,
        takeId: take.id,
        targetVoiceId: rig.charId ?? member.rig,
        targetReferenceChecksum: targetChecksum,
        consentId: body.consentId!,
        registerPolicy,
        sourceCueId: cue.id,
        sourceAudioChecksum: take.audio.checksum,
        sourceTrim,
      },
      state,
      audio,
      model: {
        engine: 'chatterbox-vc',
        model: 'ResembleAI/chatterbox:ChatterboxVC',
        revision: converted.runtime.modelRevision,
        settings: {
          seed,
          registerPolicy,
          registerShiftSemitones: converted.registerShiftSemitones,
          sourceMedianPitchHz: converted.sourceMedianPitchHz,
          targetMedianPitchHz: converted.targetMedianPitchHz,
          cacheKey: converted.cacheKey,
          runtimeFingerprint: converted.runtime.fingerprint,
          packageRevision: converted.runtime.packageRevision,
        },
        generatedAt: new Date().toISOString(),
      },
      durationPolicy: cue.durationPolicy,
      alignment: {
        sourceToOutput: [
          { sourceMs: 0, outputMs: 0 },
          { sourceMs: speechStartMs, outputMs: outputSpeechStartMs },
          { sourceMs: speechEndMs, outputMs: outputSpeechEndMs },
          { sourceMs: sourceDurationMs, outputMs: audio.durationMs },
        ],
        words: alignedWords,
        phonemes: [],
      },
      quality: {
        verdict,
        transcriptMatch: null,
        speechRatio: acoustic.outputSpeechRatio,
        clippedSampleRatio: acoustic.clippedSampleRatio,
        stretchRatio: audio.durationMs / sourceDurationMs,
        speakerSimilarity: null,
        cadenceSimilarity: acoustic.cadenceSimilarity,
        flags: qualityFlags,
      },
      failure: state === 'rejected' ? 'conversion failed duration/cadence/signal quality checks' : null,
    };

    const next = await updateDialogueDocument(scene, (current) => {
      return {
        ...current,
        voiceRenders: [...current.voiceRenders, voiceRender],
        cues: current.cues.map((item) => item.id === cueId && state === 'ready'
          ? {
              ...item,
              selectedTakeId: take.id,
              selectedRenderId: renderId,
              trim: {
                inMs: 0,
                outMs: audio.durationMs,
                speechOnsetMs: outputSpeechStartMs,
                speechEndMs: outputSpeechEndMs,
              },
              durationFrames: Math.max(1, Math.round((audio.durationMs / 1000) * current.fps)),
              approval: { ...item.approval, state: 'candidate' as const, at: null },
              provenance: { ...item.provenance, origin: 'recorded' as const, revision: item.provenance.revision + 1 },
            }
          : item),
      };
    });
    return { renderId, state, verdict, durationMs: audio.durationMs, revision: next.revision };
  });
  json(res, jobSummary(job));
});

// --- editable animation ---------------------------------------------------

router.get('/api/scenes/:name/animation', async ({ res, params }) => {
  await requireShotList(params['name']!);
  json(res, await readAnimationOrDefault(params['name']!));
});

router.put('/api/scenes/:name/animation', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ document: unknown }>(req);
  const document = AnimationDocument.parse(body.document);
  const current = await readAnimationOrDefault(scene);
  if (document.revision !== current.revision) {
    throw new HttpError(409, `animation revision ${document.revision} does not match current revision ${current.revision}`);
  }
  const next = AnimationDocument.parse({ ...document, revision: current.revision + 1 });
  await writeAnimation(scene, next);
  json(res, { ok: true, revision: next.revision, document: next });
});

router.post('/api/scenes/:name/preview', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ withAudio?: boolean; layout?: 'horizontal' | 'vertical' }>(req);
  const shots = await requireShotList(scene);
  const rigs = await rigsFor(shots);

  // Real timings only when the audio has actually been rendered; otherwise the
  // preview would claim a precision it doesn't have.
  let timings = null;
  if (body.withAudio && (await exists(path.join(sceneDir(scene), 'dialogue.wav')))) {
    timings = await resolveTimings(scene, shots, rigs, { engine: 'chatterbox' });
  }

  const preview = await buildPreview(shots, rigs, timings, undefined, body.layout ?? 'horizontal');
  json(res, {
    previewId: storePreview(preview.html),
    durationMs: preview.durationMs,
    frameCount: preview.ir.frames.length,
    fps: preview.ir.meta.fps,
    width: preview.ir.meta.width,
    height: preview.ir.meta.height,
    layout: body.layout ?? 'horizontal',
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
    const setDescriptor = shots.set ? await loadSet(shots.set) : null;
    const compiled = compileShotList(shots, rigs, timings, null, setDescriptor);
    const dialogue = await readDialogueDocument(scene);
    handle.progress({ stage: 'audio', done: 0, total: 1 });
    await mixSceneAudio(scene, shots, compiled.audio, compiled.durationMs, {
      stageActions: compiled.stageActions,
      guideMuteCueIds: dialogue ? Object.fromEntries(shots.cast.map((member) => [
        member.id,
        dialogue.cues.filter((cue) => cue.speaker === member.id && !cue.locked).map((cue) => cue.id),
      ])) : undefined,
    });
    return { lines: timings.size, durationMs: compiled.durationMs };
  });

  json(res, jobSummary(job));
});

router.post('/api/scenes/:name/render', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ engine?: string }>(req);
  const shots = await requireShotList(scene);
  const snapshot = await captureProductionReviewSnapshot(scene, shots);
  const preflight = await runProductionPreflight(scene, shots);
  if (preflight.renderEndpointBlocked) {
    const blockers = preflight.notes.filter((note) => note.blocking).map((note) => note.message);
    const summary = blockers.slice(0, 5).join('; ');
    const remainder = blockers.length > 5 ? `; plus ${blockers.length - 5} more blocker${blockers.length - 5 === 1 ? '' : 's'}` : '';
    throw new HttpError(409, `production preflight failed: ${summary}${remainder}`);
  }
  // The gate and the renderer must consume one immutable creative snapshot.
  // A concurrent editor save belongs to the next render, never half of this one.
  const currentSnapshot = await captureProductionReviewSnapshot(scene);
  if (productionReviewSnapshotDigest(currentSnapshot) !== productionReviewSnapshotDigest(snapshot)) {
    throw new HttpError(409, 'the scene changed during production preflight; run Preflight again');
  }
  const warnings = preflight.notes.filter((note) => note.level === 'warn');
  const warningReview = await latestPreflightWarningReview(scene);
  if (!warningAcknowledgementIsCurrent(preflight, snapshot, warningReview)) {
    throw new HttpError(
      409,
      `production preflight has ${warnings.length} review warning${warnings.length === 1 ? '' : 's'}; review and acknowledge the current warnings before rendering`,
    );
  }
  const {
    dialogue: dialogueSnapshot,
    animation: animationSnapshot,
    setDescriptor: setSnapshot,
    identity: identitySnapshot,
    rigs: rigSnapshot,
  } = snapshot;
  if (!dialogueSnapshot) throw new HttpError(409, 'production dialogue disappeared during preflight');
  const job = startJob('render', scene, async (handle) => {
    // Evict any resident LLM before the GPU work starts. Writing happens before
    // rendering, so they never genuinely need to coexist — and on a 16GB card,
    // a 14B model plus Chatterbox is where the machine starts thrashing.
    const evicted = await freeVramForRender();
    if (evicted.length) handle.log(`unloaded ${evicted.join(', ')} to free VRAM`);

    return renderScene(shots, rigSnapshot, {
      scene,
      engine: body.engine ?? 'chatterbox',
      dialogue: dialogueSnapshot,
      animation: animationSnapshot,
      setDescriptor: setSnapshot,
      identity: identitySnapshot,
      warningAcknowledgement: warnings.length ? warningReview : null,
      onStage: (p) => handle.progress({ stage: p.stage, done: p.done, total: p.total, message: p.message }),
    });
  });

  json(res, jobSummary(job));
});

/**
 * Serve the scene's soundtrack — but never a stale one.
 *
 * The manifest records what the track was built from; if the shot list, a
 * voice reference, the identity profile, or the ambience settings have moved
 * since, playing the old audio against the new edit would be quietly wrong in
 * the way nobody catches. A 409 with "run Voices again" is the honest answer.
 */
/**
 * Everything that would go wrong with a long job, found before it starts.
 *
 * A render is minutes; every item here is milliseconds. The notes are levelled
 * so the UI can distinguish "this will fail" from "this will be prepared
 * automatically" from "worth knowing".
 */
router.get('/api/scenes/:name/preflight', async ({ res, params }) => {
  const scene = params['name']!;
  const report = await runProductionPreflight(scene);
  if (report.productionBlocked) {
    json(res, { ...report, warningReview: { required: false, current: false, acknowledgement: null } });
    return;
  }
  const snapshot = await captureProductionReviewSnapshot(scene);
  const acknowledgement = await latestPreflightWarningReview(scene);
  json(res, {
    ...report,
    warningReview: {
      required: report.notes.some((note) => note.level === 'warn'),
      current: warningAcknowledgementIsCurrent(report, snapshot, acknowledgement),
      acknowledgement,
    },
  });
});

router.post('/api/scenes/:name/preflight/acknowledge', async ({ req, res, params }) => {
  const scene = params['name']!;
  const body = await readJson<{ acknowledgedBy?: string }>(req);
  const first = await captureProductionReviewSnapshot(scene);
  const report = await runProductionPreflight(scene, first.shots);
  if (report.productionBlocked) {
    throw new HttpError(409, 'resolve production preflight blockers before acknowledging review warnings');
  }
  const current = await captureProductionReviewSnapshot(scene);
  if (productionReviewSnapshotDigest(first) !== productionReviewSnapshotDigest(current)) {
    throw new HttpError(409, 'the scene changed during warning review; run Preflight again');
  }
  if (!report.notes.some((note) => note.level === 'warn')) {
    json(res, { ...report, warningReview: { required: false, current: true, acknowledgement: null } });
    return;
  }
  const acknowledgement = await appendPreflightWarningReview(
    scene,
    report,
    first,
    body.acknowledgedBy ?? 'local-creator',
  );
  json(res, {
    ...report,
    warningReview: { required: true, current: true, acknowledgement },
  });
});

router.get('/api/scenes/:name/audio', async ({ res, params, req }) => {
  const scene = params['name']!;
  const shots = await readShotList(scene).catch(() => null);
  if (shots) {
    const rigs = await rigsFor(shots);
    if (!(await soundtrackIsCurrent(scene, shots, rigs))) {
      throw new HttpError(409, 'the rendered audio is stale — the scene, a voice, or the show identity changed since. Run Voices again.');
    }
  }
  return sendFile(res, path.join(sceneDir(scene), 'dialogue.wav'), req);
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
    throw new HttpError(409, 'the Scene Run guide context changed after a cue was locked or unlocked; run Voices again');
  }
  return sendFile(res, dialogueGuidePath(scene, params['speaker']!), req);
});

/**
 * Voice casting preflight, as an explicit job.
 *
 * The same idempotent step a render runs — minting default voices for cast
 * members that have none — invocable on its own so voices can be settled and
 * auditioned before committing to a full render.
 */
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
      handle.progress({ stage: 'casting', done, total, message: name }));
    return { minted };
  });

  json(res, jobSummary(job));
});

router.get('/api/scenes/:name/video', ({ res, params, req }) =>
  sendFile(res, outputPath(params['name']!), req));

router.get('/api/scenes/:name/video/vertical', ({ res, params, req }) => {
  const scene = params['name']!;
  return sendFile(res, path.join(sceneDir(scene), `${scene}.vertical.mp4`), req);
});

router.get('/api/scenes/:name/export', async ({ res, params }) => {
  const scene = params['name']!;
  const file = path.join(sceneDir(scene), `${scene}.export.json`);
  json(res, JSON.parse(await fs.readFile(file, 'utf8')));
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
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'thumbnail index must be a non-negative integer');
  const manifest = JSON.parse(
    await fs.readFile(path.join(sceneDir(scene), `${scene}.export.json`), 'utf8'),
  ) as { thumbnails?: Array<{ file?: string }> };
  const relative = manifest.thumbnails?.[index]?.file;
  if (!relative || path.basename(relative) !== relative) throw new HttpError(404, 'no such thumbnail');
  return sendFile(res, path.join(sceneDir(scene), relative), req);
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
router.post('/api/cast/:name/regenerate', async ({ res, params }) => {
  const { rig, svg } = await regenerateRig(params['name']!);
  json(res, { rig, svg, look: rig.look });
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
 * A job — each candidate is a Chatterbox synthesis plus an ffmpeg transform.
 * Candidates sit in cast/.candidates until one is committed; the character's
 * current voice is untouched until then, and cancelling costs nothing.
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
    return { candidates: candidates.map((c) => ({ salt: c.salt, semitones: c.params.semitones, tempo: c.params.tempo })) };
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

export async function startServer(port: number): Promise<{ port: number; close: () => void }> {
  // The active identity governs style, prompts and directing defaults for every
  // request, so it loads before the first one can arrive.
  await initShow();

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
