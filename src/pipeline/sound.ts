import fs from 'node:fs/promises';
import { activeIdentity } from '../show/context.ts';
import type { ShotList } from '../schema/script.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { FoleyEvent, FoleyEventsDocument } from '../audio/foley.ts';
import {
  productionAudioPaths,
  resolveAcousticProfile,
  soundtrackIsCurrent,
  soundtrackManifestPath,
  type ProductionAudioStems,
} from './voices.ts';
import { exists } from './scene.ts';

/**
 * What the Sound mode reads: the production stems as they stand on disk.
 *
 * The mixer writes stems and the manifest in one pass; this module only ever
 * reports them. Rebuilding goes back through the same voices/mix path, so
 * there is exactly one code path that produces audio.
 */

export type StemId = keyof ProductionAudioStems;
export const STEM_IDS: StemId[] = ['dialogue', 'ambience', 'foley', 'stings'];

export interface SceneStemInfo {
  id: StemId;
  exists: boolean;
  bytes: number;
}

export interface SceneSoundInfo {
  /** A mixed master exists on disk. */
  available: boolean;
  /** The mix still matches the scene; false means "run Voices / Rebuild stems". */
  current: boolean;
  engine: string;
  durationMs: number | null;
  stems: SceneStemInfo[];
  foley: { count: number; events: FoleyEvent[] };
  /** The room-tone recipe the identity profile prescribes for this scene's set. */
  ambience: { enabled: boolean; profile: string; levelDb: number };
  quality: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    targetIntegratedLufs: number | null;
    truePeakCeilingDbtp: number | null;
    loudnessPassed: boolean;
    truePeakPassed: boolean;
    passed: boolean;
    speakerLeveling: Array<{ speaker: string; measuredLufs: number; adjustmentDb: number; levelledLufs: number }>;
  } | null;
  /** Cast members with a Scene Run guide track. */
  guides: string[];
}

export function sceneStemPath(scene: string, stem: StemId): string {
  return productionAudioPaths(scene)[stem];
}

interface StoredManifest {
  engine?: string;
  durationMs?: number;
  production?: {
    guides?: Record<string, string>;
    quality?: {
      targetIntegratedLufs?: number;
      truePeakCeilingDbtp?: number;
      metrics?: { integratedLufs?: number | null; truePeakDbtp?: number | null };
      loudnessPassed?: boolean;
      truePeakPassed?: boolean;
      passed?: boolean;
      speakerLeveling?: Array<{ speaker: string; measuredLufs: number; adjustmentDb: number; levelledLufs: number }>;
    };
  };
}

export async function readSceneSound(
  scene: string,
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
): Promise<SceneSoundInfo> {
  const paths = productionAudioPaths(scene);
  const identity = activeIdentity();

  let manifest: StoredManifest | null = null;
  try {
    manifest = JSON.parse(await fs.readFile(soundtrackManifestPath(scene), 'utf8')) as StoredManifest;
  } catch {
    manifest = null;
  }

  const stems: SceneStemInfo[] = [];
  for (const id of STEM_IDS) {
    const file = paths[id];
    let bytes = 0;
    let present = false;
    try {
      bytes = (await fs.stat(file)).size;
      present = true;
    } catch {
      // A missing stem is a fact worth reporting, not an error.
    }
    stems.push({ id, exists: present, bytes });
  }

  let events: FoleyEvent[] = [];
  try {
    const document = JSON.parse(await fs.readFile(paths.events, 'utf8')) as FoleyEventsDocument;
    events = document.events;
  } catch {
    events = [];
  }

  const available = await exists(paths.master);
  const current = available ? await soundtrackIsCurrent(scene, shots, rigs) : false;
  const quality = manifest?.production?.quality ?? null;

  return {
    available,
    current,
    engine: manifest?.engine ?? 'chatterbox',
    durationMs: manifest?.durationMs ?? null,
    stems,
    foley: { count: events.length, events },
    ambience: {
      enabled: identity.audio.ambience.enabled,
      profile: await resolveAcousticProfile(shots.set),
      levelDb: identity.audio.ambience.levelDb,
    },
    quality: quality
      ? {
          integratedLufs: quality.metrics?.integratedLufs ?? null,
          truePeakDbtp: quality.metrics?.truePeakDbtp ?? null,
          targetIntegratedLufs: quality.targetIntegratedLufs ?? null,
          truePeakCeilingDbtp: quality.truePeakCeilingDbtp ?? null,
          loudnessPassed: quality.loudnessPassed ?? false,
          truePeakPassed: quality.truePeakPassed ?? false,
          passed: quality.passed ?? false,
          speakerLeveling: quality.speakerLeveling ?? [],
        }
      : null,
    guides: Object.keys(manifest?.production?.guides ?? {}),
  };
}

/** Reject anything that is not one of the four stems before touching the filesystem. */
export function parseStemId(raw: string): StemId {
  if ((STEM_IDS as string[]).includes(raw)) return raw as StemId;
  throw new Error(`no stem "${raw}" — expected one of ${STEM_IDS.join(', ')}`);
}
