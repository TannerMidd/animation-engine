import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { atomicWriteFile } from '../core/files.ts';
import { OUT_DIR } from '../core/paths.ts';
import {
  DIALOGUE_SCHEMA_VERSION,
  DialogueDocument,
  type DialogueDocument as DialogueDocumentType,
  type DialogueCue,
  CaptureQuality,
  type CaptureQuality as CaptureQualityType,
  type RecordedTake,
  type VoiceConsentRecord,
  type VoiceRender,
} from '../schema/dialogue.ts';
import type { ShotList } from '../schema/script.ts';

/** Dialogue editorial state lives beside the shot list and rendered assets. */
export function dialoguePath(scene: string, outDir = OUT_DIR): string {
  if (!scene || /[/\\]/.test(scene)) throw new Error('scene may not contain path separators');
  return path.join(outDir, scene, 'dialogue.json');
}

/** Resolve a document-owned relative audio path without permitting traversal. */
export function dialogueAssetPath(scene: string, file: string, outDir = OUT_DIR): string {
  if (path.isAbsolute(file)) return file;
  const sceneRoot = path.resolve(outDir, scene);
  const resolved = path.resolve(sceneRoot, file);
  const relative = path.relative(sceneRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`dialogue audio path escapes scene directory: ${file}`);
  }
  return resolved;
}

/** Does this cue opt into authored timing rather than the legacy 160ms tail? */
export function cueUsesEditorialTiming(cue: DialogueCue): boolean {
  return (
    cue.selectedTakeId !== null ||
    cue.selectedRenderId !== null ||
    cue.trim !== null ||
    cue.pickupMs !== 0 ||
    cue.turnGapMs !== 0 ||
    cue.pauseAfterMs !== 0 ||
    cue.overlap !== null ||
    cue.startFrame !== 0 ||
    cue.durationFrames !== null ||
    cue.durationPolicy.mode !== 'follow-performance' ||
    cue.lockedFields.includes('timing') ||
    cue.lockedFields.includes('duration-policy')
  );
}

/** Stable fingerprint of every cue field that can change audio or its placement. */
export function dialogueCueTimingKey(cue: DialogueCue): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({
      id: cue.id,
      spokenText: cue.spokenText,
      selectedTakeId: cue.selectedTakeId,
      selectedRenderId: cue.selectedRenderId,
      seed: cue.seed,
      trim: cue.trim,
      startFrame: cue.startFrame,
      durationFrames: cue.durationFrames,
      pickupMs: cue.pickupMs,
      turnGapMs: cue.turnGapMs,
      pauseAfterMs: cue.pauseAfterMs,
      overlap: cue.overlap,
      durationPolicy: cue.durationPolicy,
      approval: cue.approval.state,
      locked: cue.locked,
      lockedFields: cue.lockedFields,
    }))
    .digest('hex');
}

export function createDialogueDocument(scene: string, fps = 24): DialogueDocumentType {
  return DialogueDocument.parse({
    schemaVersion: DIALOGUE_SCHEMA_VERSION,
    scene,
    revision: 1,
    fps,
    recordedTakes: [],
    voiceRenders: [],
    cues: [],
  });
}

function parseDocument(raw: unknown, file: string): DialogueDocumentType {
  const version = raw && typeof raw === 'object'
    ? (raw as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (version !== DIALOGUE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported dialogue schema version ${String(version)} in ${file}; expected ${DIALOGUE_SCHEMA_VERSION}`,
    );
  }
  return DialogueDocument.parse(raw);
}

export async function readDialogueDocument(
  scene: string,
  outDir = OUT_DIR,
): Promise<DialogueDocumentType | null> {
  const file = dialoguePath(scene, outDir);
  let source: string;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseDocument(JSON.parse(source) as unknown, file);
  if (parsed.scene !== scene) {
    throw new Error(`dialogue document at ${file} belongs to scene "${parsed.scene}", not "${scene}"`);
  }
  return parsed;
}

/**
 * Raw take rows are immutable and append-only.
 *
 * This protects metadata as well as bytes: replacing a checksum, capture time,
 * performer, latency correction, or transcript under an accepted take ID
 * would make every derivative's provenance a lie. Record a new take instead.
 */
export function assertRecordedTakesImmutable(
  before: readonly RecordedTake[],
  after: readonly RecordedTake[],
  allowedRevocation?: { id: string; revokedAt: string },
): void {
  const next = new Map(after.map((take) => [take.id, take]));
  for (const take of before) {
    const candidate = next.get(take.id);
    if (!candidate) {
      throw new Error(`immutable recorded take "${take.id}" cannot be removed; add a new take or revoke it separately`);
    }
    if (isDeepStrictEqual(take, candidate)) continue;

    const isAllowedRevocation =
      allowedRevocation?.id === take.id &&
      take.revokedAt === null &&
      candidate.revokedAt === allowedRevocation.revokedAt &&
      isDeepStrictEqual(candidate, { ...take, revokedAt: allowedRevocation.revokedAt });
    if (!isAllowedRevocation) {
      throw new Error(
        `immutable recorded take "${take.id}" cannot be changed; revoke it through the dedicated revocation operation`,
      );
    }
  }
}

/** Existing rights records are audit evidence: edits and deletion are forbidden. */
export function assertVoiceConsentsImmutable(
  before: readonly VoiceConsentRecord[],
  after: readonly VoiceConsentRecord[],
  allowedRevocation?: { id: string; revokedAt: string },
): void {
  const next = new Map(after.map((consent) => [consent.id, consent]));
  for (const consent of before) {
    const candidate = next.get(consent.id);
    if (!candidate) {
      throw new Error(`immutable consent record "${consent.id}" cannot be removed`);
    }
    if (isDeepStrictEqual(consent, candidate)) continue;

    const isAllowedRevocation =
      allowedRevocation?.id === consent.id &&
      consent.revokedAt === null &&
      candidate.revokedAt === allowedRevocation.revokedAt &&
      isDeepStrictEqual(candidate, { ...consent, revokedAt: allowedRevocation.revokedAt });
    if (!isAllowedRevocation) {
      throw new Error(
        `immutable consent record "${consent.id}" cannot be changed; revoke it through the dedicated revocation operation`,
      );
    }
  }
}

/** Existing derivatives remain reproducible audit records; rerenders append a new ID. */
export function assertVoiceRendersImmutable(
  before: readonly VoiceRender[],
  after: readonly VoiceRender[],
): void {
  const next = new Map(after.map((render) => [render.id, render]));
  for (const render of before) {
    const candidate = next.get(render.id);
    if (!candidate) {
      throw new Error(`immutable voice render "${render.id}" cannot be removed`);
    }
    if (!isDeepStrictEqual(render, candidate)) {
      throw new Error(`immutable voice render "${render.id}" cannot be changed; append a new render ID`);
    }
  }
}

/**
 * Measure one exact Scene Run slice from decoded interleaved PCM.
 *
 * The thresholds intentionally match line-booth capture QC. This is a signal
 * integrity check, not transcript recognition; creators still audition takes.
 */
export function assessSceneRunSegment(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  inMs: number,
  outMs: number,
): CaptureQualityType {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('sample rate must be a positive integer');
  if (!Number.isInteger(channels) || channels <= 0) throw new Error('channels must be a positive integer');
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || inMs < 0 || outMs <= inMs) {
    throw new Error('Scene Run segment bounds are invalid');
  }

  const totalFrames = Math.floor(samples.length / channels);
  const startFrame = Math.max(0, Math.min(totalFrames, Math.round((inMs / 1000) * sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.round((outMs / 1000) * sampleRate)));
  const activeFloor = 32767 * Math.pow(10, -42 / 20);
  let peak = 0;
  let sumSq = 0;
  let sampleCount = 0;
  let activeFrames = 0;

  for (let frame = startFrame; frame < endFrame; frame++) {
    let frameActive = false;
    for (let channel = 0; channel < channels; channel++) {
      const sample = samples[frame * channels + channel] ?? 0;
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSq += sample * sample;
      sampleCount++;
      if (absolute >= activeFloor) frameActive = true;
    }
    if (frameActive) activeFrames++;
  }

  const frameCount = Math.max(0, endFrame - startFrame);
  const durationMs = (frameCount / sampleRate) * 1000;
  const speechRatio = activeFrames / Math.max(1, frameCount);
  const peakDb = peak > 0 ? 20 * Math.log10(peak / 32767) : null;
  const rms = sampleCount ? Math.sqrt(sumSq / sampleCount) / 32767 : 0;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : null;
  const flags: string[] = [];
  let rejected = false;

  if (durationMs < 180) {
    flags.push('the Scene Run segment is too short to contain a reliable performed utterance');
    rejected = true;
  }
  if (speechRatio < 0.02) {
    flags.push('the Scene Run segment contains no reliable detected speech');
    rejected = true;
  } else if (speechRatio < 0.08) {
    flags.push('very little speech was detected in this Scene Run segment');
  }
  if (peakDb !== null && peakDb > -0.05) {
    flags.push('the Scene Run segment contains clipped or full-scale samples');
    rejected = true;
  } else if (peakDb !== null && peakDb > -0.3) {
    flags.push('the Scene Run segment is at or near clipping');
  }
  if (rmsDb === null || rmsDb < -38) {
    flags.push('the Scene Run segment is very quiet');
  }

  return CaptureQuality.parse({
    verdict: rejected ? 'reject' : flags.length ? 'warn' : 'pass',
    peakDb,
    rmsDb,
    speechRatio,
    flags,
  });
}

function lockedFieldValue(cue: DialogueCue, field: DialogueCue['lockedFields'][number]): unknown {
  switch (field) {
    case 'selection':
      return { selectedTakeId: cue.selectedTakeId, selectedRenderId: cue.selectedRenderId };
    case 'text':
      return { displayText: cue.displayText, spokenText: cue.spokenText };
    case 'delivery':
      return cue.delivery;
    case 'trim':
      return cue.trim;
    case 'timing':
      return {
        startFrame: cue.startFrame,
        durationFrames: cue.durationFrames,
        pickupMs: cue.pickupMs,
        turnGapMs: cue.turnGapMs,
        pauseAfterMs: cue.pauseAfterMs,
        overlap: cue.overlap,
      };
    case 'duration-policy':
      return cue.durationPolicy;
  }
}

/**
 * Enforce two-step unlocking at the persistence boundary.
 *
 * A full lock can only transition to the exact same cue with `locked: false`.
 * A selectively locked field also cannot change in the same save that removes
 * its lock; remove the field lock first, then edit in a subsequent revision.
 *
 * `beatIndex` is exempt: it is derived from the shot list rather than authored,
 * so inserting or removing an earlier beat shifts it on every later cue. See
 * the note in the locked branch for why freezing it is not an option.
 */
export function assertDialogueCueLocks(
  before: readonly DialogueCue[],
  after: readonly DialogueCue[],
): void {
  const next = new Map(after.map((cue) => [cue.id, cue]));
  for (const cue of before) {
    const candidate = next.get(cue.id);
    if (!candidate) {
      if (cue.locked || cue.lockedFields.length) {
        throw new Error(`locked dialogue cue "${cue.id}" cannot be removed; unlock it in a separate save`);
      }
      continue;
    }

    if (cue.locked) {
      // A lock protects what the creator authored, not where the beat happens
      // to sit. `beatIndex` tracks the shot list, and deleting or inserting an
      // earlier beat renumbers every cue after it — so treating it as locked
      // content made the scene reject its own re-sync forever: the index that
      // drives audition seeds, overlap ordering and VO paths could never be
      // corrected without first unlocking approved work.
      const rebased = { ...cue, beatIndex: candidate.beatIndex };
      const onlyUnlocked = { ...rebased, locked: false };
      if (!isDeepStrictEqual(candidate, rebased) && !isDeepStrictEqual(candidate, onlyUnlocked)) {
        throw new Error(`locked dialogue cue "${cue.id}" may only be unlocked in a separate save`);
      }
      continue;
    }

    for (const field of cue.lockedFields) {
      if (!isDeepStrictEqual(lockedFieldValue(cue, field), lockedFieldValue(candidate, field))) {
        throw new Error(
          `dialogue cue "${cue.id}" field "${field}" is locked; remove the field lock in a separate save`,
        );
      }
    }
  }
}

async function persistDialogueDocument(
  scene: string,
  document: DialogueDocumentType,
  outDir: string,
  allowedRevocation?: { id: string; revokedAt: string },
  allowedTakeRevocation?: { id: string; revokedAt: string },
): Promise<string> {
  const parsed = DialogueDocument.parse(document);
  if (parsed.scene !== scene) {
    throw new Error(`cannot write scene "${parsed.scene}" as dialogue for "${scene}"`);
  }

  const existing = await readDialogueDocument(scene, outDir);
  if (existing) {
    assertRecordedTakesImmutable(existing.recordedTakes, parsed.recordedTakes, allowedTakeRevocation);
    // Scene Run segment audit rows live inside RecordedTake provenance, so the
    // raw-take check above also makes every accepted segment and QC report immutable.
    assertVoiceConsentsImmutable(existing.consents, parsed.consents, allowedRevocation);
    assertVoiceRendersImmutable(existing.voiceRenders, parsed.voiceRenders);
    assertDialogueCueLocks(existing.cues, parsed.cues);
  }

  const file = dialoguePath(scene, outDir);
  await atomicWriteFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return file;
}

export async function writeDialogueDocument(
  scene: string,
  document: DialogueDocumentType,
  outDir = OUT_DIR,
): Promise<string> {
  return persistDialogueDocument(scene, document, outDir);
}

/**
 * One-way, idempotent consent revocation. No other field can change through
 * this path, and a recorded revocation timestamp can never be rewritten.
 */
export async function revokeVoiceConsent(
  scene: string,
  consentId: string,
  revokedAt = new Date().toISOString(),
  outDir = OUT_DIR,
): Promise<DialogueDocumentType> {
  const parsedTimestamp = new Date(revokedAt);
  if (!Number.isFinite(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== revokedAt) {
    throw new Error('revokedAt must be a canonical ISO timestamp');
  }
  const current = await readDialogueDocument(scene, outDir);
  if (!current) throw new Error(`no dialogue document for scene "${scene}"`);
  const consent = current.consents.find((item) => item.id === consentId);
  if (!consent) throw new Error(`no consent record "${consentId}"`);
  if (consent.revokedAt) return current;
  if (parsedTimestamp.getTime() < Date.parse(consent.createdAt)) {
    throw new Error('consent cannot be revoked before it was created');
  }

  const next = DialogueDocument.parse({
    ...current,
    revision: current.revision + 1,
    consents: current.consents.map((item) => item.id === consentId
      ? { ...item, revokedAt }
      : item),
  });
  await persistDialogueDocument(scene, next, outDir, { id: consentId, revokedAt });
  return next;
}

/**
 * One-way, idempotent take revocation — the "discard" a creator reaches for
 * after recording onto the wrong line.
 *
 * The row itself is untouched audit evidence (bytes, checksums, QC,
 * provenance); only `revokedAt` is stamped. Everything *working* on top of it
 * is cleared in the same revision: cue selections, trims, selections of
 * renders derived from it, and any approval that stood on those. Locked cues
 * refuse the cleanup rather than being silently edited.
 */
export async function revokeRecordedTake(
  scene: string,
  takeId: string,
  revokedAt = new Date().toISOString(),
  outDir = OUT_DIR,
): Promise<DialogueDocumentType> {
  const parsedTimestamp = new Date(revokedAt);
  if (!Number.isFinite(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== revokedAt) {
    throw new Error('revokedAt must be a canonical ISO timestamp');
  }
  const current = await readDialogueDocument(scene, outDir);
  if (!current) throw new Error(`no dialogue document for scene "${scene}"`);
  const take = current.recordedTakes.find((item) => item.id === takeId);
  if (!take) throw new Error(`no recorded take "${takeId}"`);
  if (take.revokedAt) return current;
  if (parsedTimestamp.getTime() < Date.parse(take.capture.recordedAt)) {
    throw new Error('a take cannot be revoked before it was recorded');
  }

  const derivedRenderIds = new Set(
    current.voiceRenders
      .filter((render) => render.source.kind !== 'draft-tts' && render.source.takeId === takeId)
      .map((render) => render.id),
  );
  const affected = current.cues.filter((cue) =>
    cue.selectedTakeId === takeId ||
    (cue.selectedRenderId !== null && derivedRenderIds.has(cue.selectedRenderId)));
  const lockedAffected = affected.filter((cue) => cue.locked || cue.lockedFields.length > 0);
  if (lockedAffected.length) {
    throw new Error(
      `locked dialogue cue${lockedAffected.length === 1 ? '' : 's'} ` +
      `${lockedAffected.map((cue) => `"${cue.id}"`).join(', ')} reference${lockedAffected.length === 1 ? 's' : ''} ` +
      `take "${takeId}"; unlock before revoking`,
    );
  }

  const next = DialogueDocument.parse({
    ...current,
    revision: current.revision + 1,
    recordedTakes: current.recordedTakes.map((item) => item.id === takeId
      ? { ...item, revokedAt }
      : item),
    cues: current.cues.map((cue) => {
      const lostTake = cue.selectedTakeId === takeId;
      const lostRender = cue.selectedRenderId !== null && derivedRenderIds.has(cue.selectedRenderId);
      if (!lostTake && !lostRender) return cue;
      return {
        ...cue,
        selectedTakeId: lostTake ? null : cue.selectedTakeId,
        selectedRenderId: lostRender ? null : cue.selectedRenderId,
        trim: lostTake ? null : cue.trim,
        approval: cue.approval.state === 'approved'
          ? {
              ...cue.approval,
              state: 'draft' as const,
              by: null,
              at: null,
              notes: [...cue.approval.notes, `approval withdrawn: take ${takeId} was revoked`],
            }
          : cue.approval,
      };
    }),
  });
  await persistDialogueDocument(scene, next, outDir, undefined, { id: takeId, revokedAt });
  return next;
}

/** Read-modify-write helper that advances the editorial revision explicitly. */
export async function updateDialogueDocument(
  scene: string,
  update: (current: DialogueDocumentType) => DialogueDocumentType,
  outDir = OUT_DIR,
): Promise<DialogueDocumentType> {
  const current = (await readDialogueDocument(scene, outDir)) ?? createDialogueDocument(scene);
  const proposed = update(current);
  const next = DialogueDocument.parse({ ...proposed, revision: current.revision + 1 });
  await writeDialogueDocument(scene, next, outDir);
  return next;
}

/** Script-facing fingerprint used to invalidate incompatible recorded takes. */
export function dialogueScriptHash(shots: ShotList): string {
  return crypto
    .createHash('sha256')
    .update(shots.beats
      .filter((beat) => beat.kind === 'line')
      .map((beat) => `${beat.id}\0${beat.speaker}\0${beat.text}`)
      .join('\n'))
    .digest('hex');
}

/**
 * Ensure every line has a stable editorial cue without disturbing authored work.
 *
 * Newly directed lines get draft cues. Existing spoken text, selections,
 * approval and locks survive; only their array locator is refreshed. A frame
 * rate change marks selected work stale because its exact frame contract has
 * changed, but never deletes the take or render.
 */
export async function syncDialogueDocument(
  scene: string,
  shots: ShotList,
  outDir = OUT_DIR,
): Promise<DialogueDocumentType> {
  const previous = await readDialogueDocument(scene, outDir);
  const base = previous ?? createDialogueDocument(scene, shots.fps);
  const byId = new Map(base.cues.map((cue) => [cue.id, cue]));
  const activeIds = new Set<string>();
  const cues: DialogueCue[] = [];
  const fpsChanged = base.fps !== shots.fps;

  for (let beatIndex = 0; beatIndex < shots.beats.length; beatIndex++) {
    const beat = shots.beats[beatIndex]!;
    if (beat.kind !== 'line') continue;
    const id = beat.id;
    activeIds.add(id);
    const existing = byId.get(id);
    if (!existing) {
      cues.push({
        id,
        beatIndex,
        speaker: beat.speaker,
        displayText: beat.text,
        spokenText: beat.text,
        selectedTakeId: null,
        selectedRenderId: null,
        voiceSource: 'performance',
        seed: shots.seed * 1000 + beatIndex,
        delivery: {
          expression: beat.expression,
          intent: '',
          energy: 1,
          pace: 1,
          notes: [],
          emphasis: [],
          pronunciations: [],
        },
        trim: null,
        startFrame: 0,
        durationFrames: null,
        pickupMs: 0,
        turnGapMs: 220,
        pauseAfterMs: 0,
        overlap: null,
        durationPolicy: {
          mode: 'follow-performance',
          targetFrames: null,
          warnVoicedStretchRatio: 0.03,
          maxVoicedStretchRatio: 0.05,
          downstream: 'ripple',
        },
        approval: { state: 'draft', by: null, at: null, notes: [] },
        locked: false,
        lockedFields: [],
        provenance: {
          origin: 'generated',
          revision: 1,
          createdBy: null,
          createdAt: null,
          derivedFromRevision: null,
        },
      });
      continue;
    }

    const selectionIsNowStale = fpsChanged && (
      existing.selectedTakeId !== null || existing.selectedRenderId !== null
    );
    cues.push({
      ...existing,
      beatIndex,
      approval: selectionIsNowStale
        ? { ...existing.approval, state: 'stale' }
        : existing.approval,
      // Draft generated delivery follows a new directing expression. Accepted
      // or hand-authored delivery remains exactly what the creator approved.
      delivery:
        !existing.locked &&
        !existing.lockedFields.includes('delivery') &&
        existing.approval.state === 'draft' &&
        existing.selectedTakeId === null &&
        existing.selectedRenderId === null
          ? { ...existing.delivery, expression: beat.expression }
          : existing.delivery,
    });
  }

  // Orphaned cues retain their takes and edits for undo/re-linking, but are no
  // longer part of resolution because no current beat names their stable ID.
  cues.push(...base.cues.filter((cue) => !activeIds.has(cue.id)));

  const candidate = DialogueDocument.parse({
    ...base,
    revision: previous ? previous.revision + 1 : 1,
    fps: shots.fps,
    scriptHash: dialogueScriptHash(shots),
    identity: shots.identity ?? base.identity,
    cues,
  });

  if (!previous || !isDeepStrictEqual(previous, { ...candidate, revision: previous.revision })) {
    await writeDialogueDocument(scene, candidate, outDir);
    return candidate;
  }
  return previous;
}
