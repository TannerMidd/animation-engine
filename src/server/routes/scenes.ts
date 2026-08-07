import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sceneDir } from '../../core/paths.ts';
import { json, readJson, sendFile, HttpError, type Router } from '../http.ts';
import { startJob, jobSummary } from '../jobs.ts';
import {
  requireShotList, rigsFor, captureProductionReviewSnapshot, dialogueFor, sceneAsset,
  castVoiceReference, storePreview,
} from '../state.ts';
import {
  listScenes, readScript, writeScript, readShotList, writeShotList,
  exists, outputPath, scriptPath,
} from '../../pipeline/scene.ts';
import { checkScript, summarise } from '../../pipeline/check.ts';
import { mergeShotLists, diffShotLists } from '../../pipeline/propose.ts';
import { buildPreview } from '../../pipeline/preview.ts';
import { renderScene } from '../../pipeline/render.ts';
import {
  approximateWordTimings,
  resolveTimings,
  soundtrackIsCurrent,
  soundtrackEngine,
} from '../../pipeline/voices.ts';
import { markExportManifestDraft } from '../../pipeline/draft.ts';
import { loadRig } from '../../cast/store.ts';
import { ShotList } from '../../schema/script.ts';
import { freeVramForRender } from '../../llm/ollama.ts';
import {
  readDialogueDocument, updateDialogueDocument, writeDialogueDocument,
  assessSceneRunSegment, revokeVoiceConsent, revokeRecordedTake,
} from '../../pipeline/dialogue.ts';
import {
  DialogueDocument, DialogueCue, VoiceConsentRecord,
  type CaptureMode, type RegisterPolicy,
} from '../../schema/dialogue.ts';
import {
  savePerformanceRecording, audioAssetForSceneFile, performanceAssetPath, extractPerformanceSegment,
} from '../../voice/recording.ts';
import { readWav, toInt16 } from '../../voice/wav.ts';
import {
  compareConversionAudio, convertPerformances, checkConversionIdentity,
} from '../../voice/conversion.ts';
import {
  readAnimationOrDefault,
  retimeAnimationForDialogue,
  writeAnimation,
} from '../../pipeline/animation.ts';
import { AnimationDocument } from '../../schema/animation.ts';
import { estimatedAnimationTimeline, runProductionPreflight, type SoundtrackState } from '../../pipeline/preflight.ts';
import {
  appendPreflightWarningReview,
  latestPreflightWarningReview,
  productionReviewSnapshotDigest,
  warningAcknowledgementIsCurrent,
} from '../../pipeline/preflight-review.ts';
import { registerSceneMediaRoutes } from './scene-media.ts';
import { requestedEngine, startSoundtrackJob } from './scene-soundtrack.ts';

export function registerSceneRoutes(router: Router): void {
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
    if (shots.scene !== params['name']) throw new HttpError(400, 'shot-list scene must match the URL');
    await writeShotList(params['name']!, shots);
    json(res, { ok: true, summary: summarise(shots) });
  });

  router.put('/api/scenes/:name/shotlist', async ({ req, res, params }) => {
    const body = await readJson<{ shots: unknown }>(req);
    const shots = ShotList.parse(body.shots);
    if (shots.scene !== params['name']) throw new HttpError(400, 'shot-list scene must match the URL');
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
    if (document.scene !== scene) throw new HttpError(400, 'dialogue scene must match the URL');
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
      revokedAt: null,
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
      revokedAt: null,
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

  /**
   * The creator's "discard": the take row stays as immutable audit evidence,
   * but it leaves every working surface — selections, trims and approvals that
   * stood on it are cleared in the same revision.
   */
  router.post('/api/scenes/:name/dialogue/takes/:take/revoke', async ({ res, params }) => {
    const scene = params['name']!;
    const takeId = params['take']!;
    const document = await dialogueFor(scene);
    if (!document.recordedTakes.some((item) => item.id === takeId)) {
      throw new HttpError(404, `no recorded take "${takeId}"`);
    }
    const next = await revokeRecordedTake(scene, takeId);
    const revokedAt = next.recordedTakes.find((item) => item.id === takeId)!.revokedAt;
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

      // The cache key already identifies the source audio, target reference,
      // policy, seed, runtime, and worker. Re-clicking the same rejected result
      // is not a new attempt and should not add another identical blocker card.
      const duplicate = document.voiceRenders.find((render) =>
        render.source.kind === 'voice-conversion' &&
        render.source.sourceCueId === cue.id &&
        render.source.takeId === take.id &&
        render.model.settings['cacheKey'] === converted.cacheKey,
      );
      if (duplicate) {
        return {
          renderId: duplicate.id,
          state: duplicate.state,
          verdict: duplicate.quality.verdict,
          durationMs: duplicate.audio?.durationMs ?? 0,
          revision: document.revision,
          reused: true,
        };
      }

      // A conversion attempt is immutable audit evidence. Even when model output
      // comes from the deterministic cache, a genuinely different attempt
      // appends a new record/file instead of rewriting a prior VoiceRender.
      const renderId = `vc-${converted.cacheKey.slice(0, 20)}-${randomUUID().slice(0, 8)}`;
      const relative = `dialogue/renders/${renderId}.wav`;
      const destination = sceneAsset(scene, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(converted.audio, destination);
      const audio = await audioAssetForSceneFile(scene, relative);
      const acoustic = await compareConversionAudio(source, destination);
      // Loudness and envelope alone cannot tell a character voice from a
      // pitch-mangled one, so identity is checked on its own terms: voicing kept,
      // and where the result landed against the character's register.
      const identity = checkConversionIdentity(converted);
      const deltaRatio = Math.abs(converted.durationDeltaMs) / Math.max(1, converted.sourceDurationMs);
      const frameMs = 1000 / shots.fps;
      const severeQualityFailure = (
        deltaRatio > cue.durationPolicy.maxVoicedStretchRatio ||
        acoustic.outputSpeechRatio < 0.04 ||
        acoustic.clippedSampleRatio > 0.01 ||
        acoustic.cadenceSimilarity < 0.45 ||
        identity.failures.length > 0
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
      for (const failure of identity.failures) {
        qualityFlags.unshift(
          `${failure}. Give ${member.rig} a recorded voice reference, or reroll the minted one, and convert again.`,
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
            outputMedianPitchHz: converted.outputMedianPitchHz,
            conditioningLiftSemitones: converted.conditioningLiftSemitones,
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
          voicedRetention: identity.voicedRetention,
          pitchErrorSemitones: identity.pitchErrorSemitones,
          flags: qualityFlags,
        },
        failure: state === 'rejected'
          ? (identity.failures[0] ?? 'conversion failed duration/cadence/signal quality checks')
          : null,
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
    if (document.scene !== scene) throw new HttpError(400, 'animation scene must match the URL');
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

    // Real timings only when the audio has actually been rendered *for this
    // scene as it stands*. A mix left over from an earlier direction is a file
    // on disk, not a soundtrack: GET /audio refuses to serve it, so claiming
    // accurate timing off it leaves the editor promising sound it cannot play.
    const soundtrack: SoundtrackState = (await exists(path.join(sceneDir(scene), 'dialogue.wav')))
      ? (await soundtrackIsCurrent(scene, shots, rigs) ? 'current' : 'stale')
      : 'missing';

    let timings = null;
    if (body.withAudio && soundtrack === 'current') {
      // Replay whichever engine built the current mix; a preview must never
      // trigger synthesis on an engine nobody chose.
      timings = await resolveTimings(scene, shots, rigs, { engine: await soundtrackEngine(scene) });
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
      soundtrack,
    });
  });

  router.post('/api/scenes/:name/voices', async ({ req, res, params }) => {
    const scene = params['name']!;
    const body = await readJson<{ engine?: string }>(req);
    const engine = requestedEngine(body.engine, 'chatterbox');
    const shots = await requireShotList(scene);
    const rigs = await rigsFor(shots);
    json(res, jobSummary(startSoundtrackJob('voices', scene, shots, rigs, engine)));
  });

  router.post('/api/scenes/:name/render', async ({ req, res, params }) => {
    const scene = params['name']!;
    const body = await readJson<{ engine?: string; draft?: boolean }>(req);
    const engine = requestedEngine(body.engine, 'chatterbox');
    const draft = body.draft === true;
    const shots = await requireShotList(scene);
    const snapshot = await captureProductionReviewSnapshot(scene, shots);
    const preflight = await runProductionPreflight(scene, shots);
    if (preflight.renderEndpointBlocked && !draft) {
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
    // A draft bypasses the review gate the same way --draft always has: the
    // bundle is labelled non-production instead of being blocked.
    if (!draft && !warningAcknowledgementIsCurrent(preflight, snapshot, warningReview)) {
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

      const result = await renderScene(shots, rigSnapshot, {
        scene,
        engine,
        dialogue: dialogueSnapshot,
        animation: animationSnapshot,
        setDescriptor: setSnapshot,
        identity: identitySnapshot,
        warningAcknowledgement: draft ? null : (warnings.length ? warningReview : null),
        onStage: (p) => handle.progress({ stage: p.stage, done: p.done, total: p.total, message: p.message }),
      });
      if (draft) {
        await markExportManifestDraft(result.exportManifest, preflight);
        handle.log('export manifest labelled draft — not approved for production distribution');
      }
      return { ...result, draft };
    });

    json(res, jobSummary(job));
  });

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

  registerSceneMediaRoutes(router);
}
