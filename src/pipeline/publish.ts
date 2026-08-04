import crypto, { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SceneIR } from '../schema/ir.ts';
import type { CompiledCaptionCue, CompiledScene } from '../compile/scene.ts';
import {
  CAPTION_LINE_CHARACTERS,
  CAPTION_MAX_CHARACTERS_PER_SECOND,
  CAPTION_MAX_LINES,
  wrapCaptionLines,
} from '../compile/captions.ts';
import { stampOf, type ShowIdentity } from '../schema/identity.ts';
import type { DialogueDocument } from '../schema/dialogue.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import { activeIdentity } from '../show/context.ts';
import {
  FOLEY_EVENT_VERSION,
  type FoleyEvent,
  type FoleySourceProvenance,
} from '../audio/foley.ts';
import type { ProductionAudioBundle } from './voices.ts';
import type { PreflightWarningAcknowledgement } from './preflight-review.ts';

export const EXPORT_MANIFEST_VERSION = 2 as const;

function captionText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function captionTime(ms: number, decimal: '.' | ','): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid caption time ${ms}ms`);
  const rounded = Math.round(ms);
  const hours = Math.floor(rounded / 3_600_000);
  const minutes = Math.floor((rounded % 3_600_000) / 60_000);
  const seconds = Math.floor((rounded % 60_000) / 1_000);
  const millis = rounded % 1_000;
  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}${decimal}${String(millis).padStart(3, '0')}`
  );
}

function orderedCaptions(cues: readonly CompiledCaptionCue[]): CompiledCaptionCue[] {
  return cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => cue.endMs > cue.startMs)
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.index - b.index)
    .map(({ cue }) => cue);
}

/** WebVTT sidecar using the exact audible line bounds resolved by the compiler. */
export function webVtt(cues: readonly CompiledCaptionCue[]): string {
  const body = orderedCaptions(cues).map((cue) => (
    `${captionTime(cue.startMs, '.')} --> ${captionTime(cue.endMs, '.')}\n${captionText(cue.text)}`
  ));
  return `WEBVTT\n\n${body.join('\n\n')}${body.length ? '\n' : ''}`;
}

/** SubRip sidecar. Cue numbers follow scheduled order, including overlaps. */
export function subRip(cues: readonly CompiledCaptionCue[]): string {
  const body = orderedCaptions(cues).map((cue, index) => (
    `${index + 1}\n` +
    `${captionTime(cue.startMs, ',')} --> ${captionTime(cue.endMs, ',')}\n` +
    captionText(cue.text)
  ));
  return body.length ? `${body.join('\n\n')}\n` : '';
}

export interface ThumbnailCandidate {
  frame: number;
  timeMs: number;
  score: number;
}

export interface CaptionSafeAreaViolation {
  cueId: string;
  speaker: string;
  /**
   * `too-many-lines` is a hard layout failure and blocks. After the compiler's
   * split it can only be reached by a single word longer than a whole caption
   * line, which no amount of re-cueing can fix.
   *
   * `too-fast` is a readability judgement — the cue fits, but demands more
   * reading than its window allows — so it advises rather than blocks.
   */
  reason: 'too-many-lines' | 'too-fast';
  estimatedLines: number;
  /** Longest rendered line under the deterministic mobile wrapping policy. */
  longestLineCharacters: number;
  /** Reading rate the cue demands, characters per second, to 1dp. */
  charactersPerSecond: number;
}

export interface PortraitSafeAreaViolation {
  frame: number;
  actor: string | null;
  reason: 'subject-outside-action-safe' | 'camera-aspect-mismatch';
  xFraction?: number;
}

export interface PublishingSafetyReport {
  ok: boolean;
  captions: {
    /** False only for blocking violations; a `too-fast` cue still reads ok. */
    ok: boolean;
    maxCharactersPerLine: number;
    maxLines: number;
    maxCharactersPerSecond: number;
    violations: CaptionSafeAreaViolation[];
  };
  portrait: {
    status: 'pass' | 'fail' | 'not-evaluated';
    actionSafeInset: number;
    checkedFrames: number;
    violations: PortraitSafeAreaViolation[];
  };
}

const PORTRAIT_ACTION_SAFE_INSET = 0.08;

export interface PublishingSafetyOptions {
  /**
   * Whether the cue windows are real programme timing.
   *
   * Preflight falls back to cues stamped with their beat index when the scene
   * will not compile — an ordering, not a clock. Reading rate is meaningless
   * against those, and measuring it anyway reports every line as impossibly
   * fast, so the check is skipped rather than run on made-up numbers.
   */
  timings?: 'real' | 'placeholder';
}

/** Deterministic release check for mobile caption wrapping and portrait action-safe composition. */
export function evaluatePublishingSafety(
  cues: readonly CompiledCaptionCue[],
  portraitIr?: SceneIR | null,
  options: PublishingSafetyOptions = {},
): PublishingSafetyReport {
  const timed = (options.timings ?? 'real') === 'real';
  const captionViolations = orderedCaptions(cues).flatMap((cue): CaptionSafeAreaViolation[] => {
    const lines = wrapCaptionLines(cue.text, CAPTION_LINE_CHARACTERS);
    const seconds = Math.max(0.001, (cue.endMs - cue.startMs) / 1_000);
    const rate = Math.round((cue.text.trim().length / seconds) * 10) / 10;
    const base = {
      cueId: cue.id,
      speaker: cue.speaker,
      estimatedLines: lines.length,
      longestLineCharacters: Math.max(0, ...lines.map((line) => line.length)),
      charactersPerSecond: rate,
    };
    // Over the line budget is a layout failure; the compiler's split has
    // already had its chance, so what is left cannot be re-cued away.
    if (lines.length > CAPTION_MAX_LINES) return [{ ...base, reason: 'too-many-lines' }];
    if (timed && rate > CAPTION_MAX_CHARACTERS_PER_SECOND) return [{ ...base, reason: 'too-fast' }];
    return [];
  });
  const blockingCaptions = captionViolations.filter((item) => item.reason === 'too-many-lines');

  const portraitViolations: PortraitSafeAreaViolation[] = [];
  let checkedFrames = 0;
  if (portraitIr) {
    const expectedAspect = portraitIr.meta.width / portraitIr.meta.height;
    const seen = new Set<string>();
    portraitIr.frames.forEach((frame, frameIndex) => {
      if (frame.card) return;
      checkedFrames++;
      const cameraAspect = frame.camera.w / frame.camera.h;
      if (Math.abs(cameraAspect - expectedAspect) > 0.001) {
        const key = 'camera-aspect-mismatch';
        if (!seen.has(key)) {
          seen.add(key);
          portraitViolations.push({ frame: frameIndex, actor: null, reason: 'camera-aspect-mismatch' });
        }
      }
      for (const [actorId, actor] of Object.entries(frame.actors)) {
        if (!actor.visible) continue;
        const xFraction = (actor.x - frame.camera.x) / frame.camera.w;
        if (xFraction >= PORTRAIT_ACTION_SAFE_INSET && xFraction <= 1 - PORTRAIT_ACTION_SAFE_INSET) continue;
        const key = `${actorId}:subject-outside-action-safe`;
        if (seen.has(key)) continue;
        seen.add(key);
        portraitViolations.push({
          frame: frameIndex,
          actor: actorId,
          reason: 'subject-outside-action-safe',
          xFraction: Math.round(xFraction * 1_000) / 1_000,
        });
      }
    });
  }

  const portraitStatus = !portraitIr
    ? 'not-evaluated' as const
    : portraitViolations.length ? 'fail' as const : 'pass' as const;
  return {
    ok: blockingCaptions.length === 0 && portraitStatus !== 'fail',
    captions: {
      ok: blockingCaptions.length === 0,
      maxCharactersPerLine: CAPTION_LINE_CHARACTERS,
      maxLines: CAPTION_MAX_LINES,
      maxCharactersPerSecond: CAPTION_MAX_CHARACTERS_PER_SECOND,
      violations: captionViolations,
    },
    portrait: {
      status: portraitStatus,
      actionSafeInset: PORTRAIT_ACTION_SAFE_INSET,
      checkedFrames,
      violations: portraitViolations,
    },
  };
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function objectSha256(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export interface ExportApprovalProvenance {
  identity: ReturnType<typeof stampOf> & { profileSha256: string };
  dialogue: null | {
    revision: number;
    scriptHash: string | null;
    documentSha256: string;
    approvalStateSha256: string;
    cueCount: number;
    approvedCueCount: number;
    lockedCueCount: number;
  };
  animation: null | {
    revision: number;
    documentSha256: string;
    lockStateSha256: string;
    manualWorkSha256: string;
    manualItemCount: number;
    lockedManualItemCount: number;
  };
}

/** Hash the exact human decisions that made this export, not only its rendered bytes. */
export function buildExportApprovalProvenance(
  identity: ShowIdentity,
  dialogue: DialogueDocument | null,
  animation: AnimationDocument | null,
): ExportApprovalProvenance {
  const identityStamp = stampOf(identity);
  const dialogueApproval = dialogue?.cues.map((cue) => ({
    id: cue.id,
    selectedTakeId: cue.selectedTakeId,
    selectedRenderId: cue.selectedRenderId,
    approval: cue.approval,
    locked: cue.locked,
    lockedFields: cue.lockedFields,
    provenance: cue.provenance,
  })) ?? [];
  const layerOwnership = new Map(animation?.layers.map((layer) => [layer.id, layer.ownership]) ?? []);
  const layerLocks = new Map(animation?.layers.map((layer) => [layer.id, layer.locked]) ?? []);
  const manualItems = animation ? [
    ...animation.tracks.filter((item) => layerOwnership.get(item.layerId) === 'manual'),
    ...animation.segments.filter((item) => layerOwnership.get(item.layerId) === 'manual'),
    ...animation.events.filter((item) => layerOwnership.get(item.layerId) === 'manual'),
  ] : [];
  const lockedManualItemCount = manualItems.filter((item) => item.locked || layerLocks.get(item.layerId)).length;

  return {
    identity: { ...identityStamp, profileSha256: objectSha256(identity) },
    dialogue: dialogue ? {
      revision: dialogue.revision,
      scriptHash: dialogue.scriptHash ?? null,
      documentSha256: objectSha256(dialogue),
      approvalStateSha256: objectSha256(dialogueApproval),
      cueCount: dialogue.cues.length,
      approvedCueCount: dialogue.cues.filter((cue) => cue.approval.state === 'approved').length,
      lockedCueCount: dialogue.cues.filter((cue) => cue.locked).length,
    } : null,
    animation: animation ? {
      revision: animation.revision,
      documentSha256: objectSha256(animation),
      lockStateSha256: objectSha256({
        layers: animation.layers.map(({ id, enabled, locked, ownership }) => ({ id, enabled, locked, ownership })),
        tracks: animation.tracks.map(({ id, layerId, enabled, locked, keys }) => ({
          id, layerId, enabled, locked, keys: keys.map((key) => ({ id: key.id, locked: key.locked })),
        })),
        segments: animation.segments.map(({ id, layerId, enabled, locked }) => ({ id, layerId, enabled, locked })),
        events: animation.events.map(({ id, layerId, locked }) => ({ id, layerId, locked })),
      }),
      manualWorkSha256: objectSha256(manualItems),
      manualItemCount: manualItems.length,
      lockedManualItemCount,
    } : null,
  };
}

function thumbnailScore(ir: SceneIR, frameIndex: number): number {
  const frame = ir.frames[frameIndex]!;
  if (frame.card) return Number.NEGATIVE_INFINITY;
  const actors = Object.values(frame.actors).filter((actor) => actor.visible);
  if (!actors.length) return Number.NEGATIVE_INFINITY;

  // Prefer a readable character composition over an empty wide or an extreme
  // close-up, then reward an actual performed pose and open articulation.
  const ensemble = actors.length === 2 ? 30 : actors.length === 1 ? 25 : Math.max(12, 28 - actors.length * 2);
  const zoom = ir.meta.width / frame.camera.w;
  const framing = Math.max(0, 18 - Math.abs(zoom - 1.8) * 9);
  const posedParts = actors.reduce((sum, actor) => sum + Object.keys(actor.parts).length, 0);
  const articulation = actors.reduce((sum, actor) => {
    const mouth = actor.swaps['mouth'];
    const eyes = actor.swaps['eyes'];
    return sum + (mouth && mouth !== 'mouth_X' ? 3 : 0) + (eyes && eyes !== 'eyes_closed' ? 1 : 0);
  }, 0);
  const progress = ir.frames.length > 1 ? frameIndex / (ir.frames.length - 1) : 0.5;
  const awayFromEdges = 6 * (1 - Math.abs(progress * 2 - 1));
  return ensemble + framing + Math.min(18, posedParts * 1.5) + articulation + awayFromEdges;
}

function frameSignature(ir: SceneIR, frame: number): string {
  return crypto.createHash('sha1').update(JSON.stringify(ir.frames[frame])).digest('hex');
}

/**
 * Choose ranked, visually distinct frames without image-analysis randomness.
 *
 * The score only uses baked IR, so selection is identical before and after a
 * machine move. A two-second separation pass avoids returning three adjacent
 * mouth shapes; a relaxed pass fills short clips when necessary.
 */
export function selectThumbnailCandidates(ir: SceneIR, count = 3): ThumbnailCandidate[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('thumbnail count must be a positive integer');
  const ranked = ir.frames
    .map((_, frame) => ({ frame, score: thumbnailScore(ir, frame) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.frame - b.frame);

  // A card-only diagnostic still deserves a deterministic image rather than a
  // crash, but normal scenes only rank frames containing a visible actor.
  if (!ranked.length && ir.frames.length) ranked.push({ frame: 0, score: 0 });

  const selected: Array<{ frame: number; score: number }> = [];
  const signatures = new Set<string>();
  const separation = Math.max(1, Math.round(ir.meta.fps * 2));
  const add = (candidate: { frame: number; score: number }, enforceSeparation: boolean) => {
    const signature = frameSignature(ir, candidate.frame);
    if (signatures.has(signature)) return;
    if (enforceSeparation && selected.some((item) => Math.abs(item.frame - candidate.frame) < separation)) return;
    signatures.add(signature);
    selected.push(candidate);
  };

  for (const candidate of ranked) {
    add(candidate, true);
    if (selected.length === count) break;
  }
  if (selected.length < count) {
    for (const candidate of ranked) {
      add(candidate, false);
      if (selected.length === count) break;
    }
  }

  return selected.map((candidate) => ({
    ...candidate,
    timeMs: (candidate.frame / ir.meta.fps) * 1_000,
  }));
}

interface FileAsset {
  file: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface ExportVideoAsset extends FileAsset {
  role: 'horizontal-master' | 'vertical-master';
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface ExportCaptionAsset extends FileAsset {
  format: 'webvtt' | 'srt';
  cues: number;
}

export interface ExportThumbnailAsset extends FileAsset {
  frame: number;
  timeMs: number;
  width: number;
  height: number;
  primary: boolean;
}

export type ExportAudioRole = 'programme-master' | 'dialogue' | 'ambience' | 'foley' | 'stings';

export interface ExportAudioAsset extends FileAsset {
  role: ExportAudioRole;
  sampleRate: 48_000;
  channels: 2;
  bitsPerSample: 16;
  durationMs: number;
}

export interface ExportFoleyEvent {
  id: string;
  type: FoleyEvent['type'];
  actor: string;
  beatId: string;
  transitionStartMs: number;
  transitionEndMs: number;
  placementMs: number;
  contact?: FoleyEvent['contact'];
  eventSha256: string;
  source: FoleySourceProvenance;
}

export interface ExportFoleyEventsAsset extends FileAsset {
  schemaVersion: number;
  count: number;
  events: ExportFoleyEvent[];
}

export interface ExportProductionAudio {
  master: ExportAudioAsset;
  stems: ExportAudioAsset[];
  foleyEvents: ExportFoleyEventsAsset;
  /** Present on current production mixes; optional keeps older bundle readers valid. */
  quality?: ProductionAudioBundle['quality'];
}

export interface ExportManifest {
  schemaVersion: typeof EXPORT_MANIFEST_VERSION;
  scene: string;
  durationMs: number;
  horizontalMaster: ExportVideoAsset;
  verticalMaster?: ExportVideoAsset;
  captions: ExportCaptionAsset[];
  thumbnails: ExportThumbnailAsset[];
  audio?: ExportProductionAudio;
  safety: PublishingSafetyReport;
  approvals: ExportApprovalProvenance;
  /** Present when non-blocking production warnings required explicit human review. */
  warningAcknowledgement?: PreflightWarningAcknowledgement;
}

export interface PublishingBundle {
  manifest: string;
  captions: { vtt: string; srt: string };
  thumbnails: string[];
}

export interface PublishingOptions {
  scene: string;
  dir: string;
  compiled: CompiledScene;
  framesDir: string;
  mp4: string;
  verticalMp4?: string;
  audio?: ProductionAudioBundle;
  /** Exact portrait IR captured for the vertical master. */
  portraitIr?: SceneIR | null;
  /** Render-start snapshots; omitted callers receive the active identity and null edit docs. */
  identity?: ShowIdentity;
  dialogue?: DialogueDocument | null;
  animation?: AnimationDocument | null;
  warningAcknowledgement?: PreflightWarningAcknowledgement | null;
  thumbnailCount?: number;
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function asset(file: string, root: string, mediaType: string): Promise<FileAsset> {
  const stat = await fs.stat(file);
  return {
    file: path.relative(root, file).replace(/\\/g, '/'),
    mediaType,
    bytes: stat.size,
    sha256: await sha256(file),
  };
}

async function audioAsset(
  file: string,
  root: string,
  role: ExportAudioRole,
  durationMs: number,
): Promise<ExportAudioAsset> {
  return {
    ...await asset(file, root, 'audio/wav'),
    role,
    sampleRate: 48_000,
    channels: 2,
    bitsPerSample: 16,
    durationMs,
  };
}

async function atomicText(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function safeStem(scene: string): string {
  if (!scene || /[/\\]/.test(scene)) throw new Error('scene may not contain path separators');
  return scene;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Materialise the M27 bundle beside the horizontal MP4. When provided, the
 * vertical master has already been captured from a second actor-aware camera
 * plan; this layer inventories it and never manufactures a pixel crop.
 */
export async function writePublishingBundle(opts: PublishingOptions): Promise<PublishingBundle> {
  const stem = safeStem(opts.scene);
  const vtt = path.join(opts.dir, `${stem}.captions.vtt`);
  const srt = path.join(opts.dir, `${stem}.captions.srt`);
  await Promise.all([
    atomicText(vtt, webVtt(opts.compiled.captions)),
    atomicText(srt, subRip(opts.compiled.captions)),
  ]);

  const selected = selectThumbnailCandidates(opts.compiled.ir, opts.thumbnailCount ?? 3);
  const thumbnailFiles: string[] = [];
  for (let index = 0; index < selected.length; index++) {
    const choice = selected[index]!;
    const source = path.join(opts.framesDir, `${String(choice.frame).padStart(6, '0')}.png`);
    const destination = path.join(
      opts.dir,
      `${stem}.thumbnail-${String(index + 1).padStart(2, '0')}-f${String(choice.frame).padStart(6, '0')}.png`,
    );
    await fs.copyFile(source, destination);
    thumbnailFiles.push(destination);
  }

  const horizontal = await asset(opts.mp4, opts.dir, 'video/mp4');
  const vertical = opts.verticalMp4
    ? await asset(opts.verticalMp4, opts.dir, 'video/mp4')
    : null;
  const captionAssets = await Promise.all([
    asset(vtt, opts.dir, 'text/vtt'),
    asset(srt, opts.dir, 'application/x-subrip'),
  ]);
  const thumbnailAssets = await Promise.all(thumbnailFiles.map((file) => asset(file, opts.dir, 'image/png')));
  let productionAudio: ExportProductionAudio | undefined;
  if (opts.audio) {
    const [master, dialogue, ambience, foley, stings, eventsAsset] = await Promise.all([
      audioAsset(opts.audio.master, opts.dir, 'programme-master', opts.audio.durationMs),
      audioAsset(opts.audio.stems.dialogue, opts.dir, 'dialogue', opts.audio.durationMs),
      audioAsset(opts.audio.stems.ambience, opts.dir, 'ambience', opts.audio.durationMs),
      audioAsset(opts.audio.stems.foley, opts.dir, 'foley', opts.audio.durationMs),
      audioAsset(opts.audio.stems.stings, opts.dir, 'stings', opts.audio.durationMs),
      asset(opts.audio.foleyEvents.file, opts.dir, 'application/json'),
    ]);
    productionAudio = {
      master,
      stems: [dialogue, ambience, foley, stings],
      foleyEvents: {
        ...eventsAsset,
        schemaVersion: FOLEY_EVENT_VERSION,
        count: opts.audio.foleyEvents.events.length,
        events: opts.audio.foleyEvents.events.map((event) => ({
          id: event.id,
          type: event.type,
          actor: event.actor,
          beatId: event.beatId,
          transitionStartMs: event.transitionStartMs,
          transitionEndMs: event.transitionEndMs,
          placementMs: event.placementMs,
          ...(event.contact ? { contact: event.contact } : {}),
          eventSha256: event.eventSha256,
          source: event.source,
        })),
      },
      ...(opts.audio.quality ? { quality: opts.audio.quality } : {}),
    };
  }

  const safety = evaluatePublishingSafety(opts.compiled.captions, opts.portraitIr);
  const approvals = buildExportApprovalProvenance(
    opts.identity ?? activeIdentity(),
    opts.dialogue ?? null,
    opts.animation ?? null,
  );

  const manifest: ExportManifest = {
    schemaVersion: EXPORT_MANIFEST_VERSION,
    scene: opts.scene,
    durationMs: opts.compiled.durationMs,
    horizontalMaster: {
      ...horizontal,
      role: 'horizontal-master',
      width: opts.compiled.ir.meta.width,
      height: opts.compiled.ir.meta.height,
      fps: opts.compiled.ir.meta.fps,
      durationMs: opts.compiled.durationMs,
    },
    ...(vertical ? {
      verticalMaster: {
        ...vertical,
        role: 'vertical-master' as const,
        width: 720,
        height: 1280,
        fps: opts.compiled.ir.meta.fps,
        durationMs: opts.compiled.durationMs,
      },
    } : {}),
    captions: captionAssets.map((item, index) => ({
      ...item,
      format: index === 0 ? 'webvtt' : 'srt',
      cues: opts.compiled.captions.length,
    })),
    thumbnails: thumbnailAssets.map((item, index) => ({
      ...item,
      frame: selected[index]!.frame,
      timeMs: selected[index]!.timeMs,
      width: opts.compiled.ir.meta.width,
      height: opts.compiled.ir.meta.height,
      primary: index === 0,
    })),
    ...(productionAudio ? { audio: productionAudio } : {}),
    safety,
    approvals,
    ...(opts.warningAcknowledgement ? { warningAcknowledgement: opts.warningAcknowledgement } : {}),
  };

  const manifestFile = path.join(opts.dir, `${stem}.export.json`);
  await atomicText(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  // Only after the new manifest is durable may old generated candidates go.
  // A failed publish therefore never leaves the previous manifest dangling.
  const currentThumbnails = new Set(thumbnailFiles.map((file) => path.basename(file)));
  const oldThumbnail = new RegExp(`^${regexEscape(stem)}\\.thumbnail-\\d{2}-f\\d{6}\\.png$`);
  for (const name of await fs.readdir(opts.dir)) {
    if (oldThumbnail.test(name) && !currentThumbnails.has(name)) {
      await fs.rm(path.join(opts.dir, name), { force: true });
    }
  }
  return { manifest: manifestFile, captions: { vtt, srt }, thumbnails: thumbnailFiles };
}
