import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAST_DIR, OUT_DIR } from '../core/paths.ts';
import { HttpError } from './http.ts';
import { activeJob } from './jobs.ts';
import { readShotList } from '../pipeline/scene.ts';
import { listRigs, loadRig, type LoadedRig } from '../cast/store.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { applySceneOutfits } from '../pipeline/check.ts';
import { readDialogueDocument, syncDialogueDocument } from '../pipeline/dialogue.ts';
import { readAnimationOrDefault } from '../pipeline/animation.ts';
import { soundtrackManifestPath } from '../pipeline/voices.ts';
import { loadSet } from '../sets/index.ts';
import { activeIdentity } from '../show/context.ts';
import { ShowIdentity } from '../schema/identity.ts';
import { ENGINE_NAMES, getEngine } from '../voice/index.ts';
import { chatterboxVcAvailable } from '../voice/conversion.ts';
import { performanceAssetPath } from '../voice/recording.ts';
import type { ShotList } from '../schema/script.ts';
import type { ProductionReviewSnapshot } from '../pipeline/preflight-review.ts';

/**
 * State and helpers shared across the route modules.
 *
 * Everything here used to live inline in one 2000-line server file; the routes
 * split apart, but previews, engine probes and the production-snapshot helpers
 * are genuinely singular, so they live here rather than in whichever route
 * file happened to need them first.
 */

export const STAGE = { w: 1280, h: 720, ground: 700 };

/**
 * Built preview pages, held in memory and served to the iframe.
 *
 * Previews are cheap to rebuild and meaningless once superseded, so they never
 * touch disk. Capped so a long editing session can't grow without bound.
 */
const previews = new Map<string, { html: string; createdAt: number }>();
const PREVIEW_CAP = 24;

export function storePreview(html: string): string {
  const id = randomUUID();
  previews.set(id, { html, createdAt: Date.now() });
  while (previews.size > PREVIEW_CAP) {
    const oldest = [...previews.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    previews.delete(oldest[0]);
  }
  return id;
}

export function getPreview(id: string): string | null {
  return previews.get(id)?.html ?? null;
}

/**
 * The most recent audition take per character.
 *
 * Points into the content-addressed voice cache, so it survives a restart of
 * nothing at all — which is correct. An audition is a thing you just asked for.
 */
export const auditions = new Map<string, string>();

/**
 * Engine availability, probed in the background.
 *
 * Checking Chatterbox means spawning Python and importing torch, which takes
 * tens of seconds. Doing that inline made /api/health hang long enough to look
 * like the server was dead. A success is cached for the process lifetime; a
 * *failure* is re-probed on the next health request — a probe that raced a
 * render for the GPU, or ran before weights were prefetched, must not report
 * the engine dead until restart.
 */
export type EngineStatus = { ok: boolean; reason?: string; checking?: boolean };
const engineStatus = new Map<string, EngineStatus>();

export function probeEngines(): void {
  const stale = (s: EngineStatus | undefined) => !s || (!s.ok && !s.checking);

  for (const name of ENGINE_NAMES) {
    if (!stale(engineStatus.get(name))) continue;
    engineStatus.set(name, { ok: false, checking: true });
    void getEngine(name)
      .available()
      .then((s) => engineStatus.set(name, s.ok ? { ok: true } : { ok: false, reason: s.reason }))
      .catch((err: unknown) =>
        engineStatus.set(name, { ok: false, reason: err instanceof Error ? err.message : String(err) }),
      );
  }
  if (stale(engineStatus.get('chatterbox-vc'))) {
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

export function engineStatusOf(name: string): EngineStatus {
  return engineStatus.get(name) ?? { ok: false, checking: true };
}

// --- helpers --------------------------------------------------------------

export async function requireShotList(scene: string): Promise<ShotList> {
  const shots = await readShotList(scene);
  if (!shots) throw new HttpError(409, `scene "${scene}" has not been directed yet`);
  return shots;
}

/** Rigs for a shot list, standing in placeholders for any not yet on disk. */
export async function rigsFor(shots: ShotList): Promise<Map<string, LoadedRig>> {
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

export async function currentSoundtrackManifest(scene: string): Promise<string | null> {
  try {
    return await fs.readFile(soundtrackManifestPath(scene), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function captureProductionReviewSnapshot(
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
export async function dialogueFor(scene: string, shots?: ShotList) {
  const resolved = shots ?? await requireShotList(scene);
  return syncDialogueDocument(scene, resolved);
}

export function sceneAsset(scene: string, file: string): string {
  return performanceAssetPath(scene, file);
}

/** Voice references are deliberately confined to cast/ even if a rig was hand-edited. */
export function castVoiceReference(file: string): string {
  if (!file || path.basename(file) !== file) {
    throw new HttpError(409, `voice reference "${file}" must be a file inside cast/`);
  }
  return path.join(CAST_DIR, file);
}

export function protectRunningRenderState(label: string): void {
  const running = activeJob();
  if (running?.kind === 'render') {
    throw new HttpError(
      409,
      `${label} cannot change while production render ${running.id} is running; the save belongs to the next render`,
    );
  }
}

/** Resolve a path under out/ or refuse — the only way route params reach the disk. */
export function safeOutPath(...parts: string[]): string {
  const file = path.resolve(OUT_DIR, ...parts);
  if (!file.startsWith(path.resolve(OUT_DIR) + path.sep)) throw new HttpError(403, 'forbidden');
  return file;
}

/** A served URL for a file under out/, matching the /api/out routes. */
export function outFileUrl(file: string): string {
  const rel = path.relative(OUT_DIR, file);
  if (rel.startsWith('..')) throw new Error(`${file} is not under out/`);
  return `/api/out/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}
