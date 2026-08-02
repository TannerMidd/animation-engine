import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../audio/files.ts';
import type { LoadedRig } from '../cast/store.ts';
import { sceneDir } from '../core/paths.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import type { DialogueDocument } from '../schema/dialogue.ts';
import { canonicalJson, type ShowIdentity } from '../schema/identity.ts';
import type { ShotList } from '../schema/script.ts';
import type { SetDescriptor } from '../sets/schema.ts';
import type { ProductionPreflightReport } from './preflight.ts';

const REVIEW_SCHEMA_VERSION = 1 as const;

export interface ProductionReviewSnapshot {
  shots: ShotList;
  dialogue: DialogueDocument | null;
  animation: AnimationDocument;
  setDescriptor: SetDescriptor | null;
  identity: ShowIdentity;
  rigs: Map<string, LoadedRig>;
  /** Raw current soundtrack manifest. Its own hashes bind the mixed inputs. */
  soundtrackManifest: string | null;
}

export interface PreflightWarningAcknowledgement {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  id: string;
  scene: string;
  policyId: string;
  fingerprint: string;
  warnings: Array<{ code: string; message: string }>;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

function reviewSnapshotPayload(snapshot: ProductionReviewSnapshot): unknown {
  const rigs = [...snapshot.rigs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, loaded]) => ({ id, rig: loaded.rig, svg: loaded.svg }));
  return {
    shots: snapshot.shots,
    dialogue: snapshot.dialogue,
    animation: snapshot.animation,
    setDescriptor: snapshot.setDescriptor,
    identity: snapshot.identity,
    rigs,
    soundtrackManifest: snapshot.soundtrackManifest,
  };
}

export function productionReviewSnapshotDigest(snapshot: ProductionReviewSnapshot): string {
  return crypto.createHash('sha256').update(canonicalJson(reviewSnapshotPayload(snapshot))).digest('hex');
}

interface PreflightWarningReviewLog {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  scene: string;
  acknowledgements: PreflightWarningAcknowledgement[];
}

export function preflightWarningFingerprint(
  report: ProductionPreflightReport,
  snapshot: ProductionReviewSnapshot,
): string {
  const warnings = report.notes
    .filter((note) => note.level === 'warn')
    .map(({ code, message }) => ({ code, message }))
    .sort((a, b) => `${a.code}\0${a.message}`.localeCompare(`${b.code}\0${b.message}`));
  return crypto.createHash('sha256').update(canonicalJson({
    policyId: report.policy.id,
    warnings,
    snapshot: reviewSnapshotPayload(snapshot),
  })).digest('hex');
}

export function warningAcknowledgementIsCurrent(
  report: ProductionPreflightReport,
  snapshot: ProductionReviewSnapshot,
  acknowledgement: PreflightWarningAcknowledgement | null,
): boolean {
  const warnings = report.notes.filter((note) => note.level === 'warn');
  if (!warnings.length) return true;
  return Boolean(
    acknowledgement &&
    acknowledgement.policyId === report.policy.id &&
    acknowledgement.fingerprint === preflightWarningFingerprint(report, snapshot),
  );
}

function reviewPath(scene: string): string {
  return path.join(sceneDir(scene), 'preflight-warning-reviews.json');
}

function parseLog(scene: string, value: unknown): PreflightWarningReviewLog {
  if (!value || typeof value !== 'object') throw new Error('preflight warning review log is not an object');
  const raw = value as Record<string, unknown>;
  if (raw['schemaVersion'] !== REVIEW_SCHEMA_VERSION || raw['scene'] !== scene || !Array.isArray(raw['acknowledgements'])) {
    throw new Error('preflight warning review log has an unsupported schema or scene');
  }
  const acknowledgements = raw['acknowledgements'].map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`preflight acknowledgement ${index} is invalid`);
    const record = item as Record<string, unknown>;
    if (
      record['schemaVersion'] !== REVIEW_SCHEMA_VERSION ||
      typeof record['id'] !== 'string' ||
      typeof record['scene'] !== 'string' ||
      typeof record['policyId'] !== 'string' ||
      typeof record['fingerprint'] !== 'string' || !/^[a-f0-9]{64}$/i.test(record['fingerprint']) ||
      !Array.isArray(record['warnings']) ||
      typeof record['acknowledgedAt'] !== 'string' ||
      typeof record['acknowledgedBy'] !== 'string'
    ) throw new Error(`preflight acknowledgement ${index} is invalid`);
    return item as PreflightWarningAcknowledgement;
  });
  return { schemaVersion: REVIEW_SCHEMA_VERSION, scene, acknowledgements };
}

export async function readPreflightWarningReviews(scene: string): Promise<PreflightWarningAcknowledgement[]> {
  try {
    const raw = JSON.parse(await fs.readFile(reviewPath(scene), 'utf8')) as unknown;
    return parseLog(scene, raw).acknowledgements;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function latestPreflightWarningReview(scene: string): Promise<PreflightWarningAcknowledgement | null> {
  const records = await readPreflightWarningReviews(scene);
  return records.at(-1) ?? null;
}

/** Append-only production review evidence. Existing acknowledgements are never rewritten. */
export async function appendPreflightWarningReview(
  scene: string,
  report: ProductionPreflightReport,
  snapshot: ProductionReviewSnapshot,
  acknowledgedBy: string,
): Promise<PreflightWarningAcknowledgement> {
  if (report.productionBlocked) throw new Error('blocked preflight cannot be acknowledged');
  const warnings = report.notes.filter((note) => note.level === 'warn');
  if (!warnings.length) throw new Error('preflight has no warnings to acknowledge');
  const existing = await readPreflightWarningReviews(scene);
  const fingerprint = preflightWarningFingerprint(report, snapshot);
  const duplicate = existing.find((record) => record.fingerprint === fingerprint);
  if (duplicate) return duplicate;
  const acknowledgedAt = new Date().toISOString();
  const record: PreflightWarningAcknowledgement = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    id: `review-${fingerprint.slice(0, 20)}`,
    scene,
    policyId: report.policy.id,
    fingerprint,
    warnings: warnings.map(({ code, message }) => ({ code, message })),
    acknowledgedAt,
    acknowledgedBy: acknowledgedBy.trim() || 'local-creator',
  };
  const log: PreflightWarningReviewLog = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    scene,
    acknowledgements: [...existing, record],
  };
  await fs.mkdir(sceneDir(scene), { recursive: true });
  await atomicWriteFile(reviewPath(scene), JSON.stringify(log, null, 2) + '\n');
  return record;
}
