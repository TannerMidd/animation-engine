import { parseScript } from '../parse/index.ts';
import { autoDirect, buildCapabilityManifest, validateShotList } from '../direct/index.ts';
import { compileShotList, estimateLineMs, LINE_TAIL_MS } from '../compile/scene.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { createRig } from '../cast/authoring.ts';
import { loadRig, listRigs, type LoadedRig } from '../cast/store.ts';
import type { Screenplay, ShotList } from '../schema/script.ts';
import { loadSet } from '../sets/index.ts';
import type { LineTiming } from '../voice/index.ts';

/**
 * Parse, direct and validate — without rendering anything.
 *
 * Fast enough (well under a second) to run on every keystroke in the editor,
 * which is the whole point: format mistakes and pacing problems surface while
 * you are still typing rather than three minutes into a render.
 */

export interface CheckOptions {
  scene: string;
  seed?: number;
  resting?: string;
  set?: string | null;
  fps?: number;
  characterFps?: number;
  /**
   * Write placeholder rigs for characters that don't have one.
   *
   * The editor's live check leaves this off so that typing a name mid-sentence
   * doesn't litter the cast folder; rendering turns it on.
   */
  createMissingCast?: boolean;
}

export interface CheckResult {
  screenplay: Screenplay;
  /** Null when the script has no characters, or directing failed. */
  shots: ShotList | null;
  rigs: Map<string, LoadedRig>;
  /** Characters with no rig on disk. */
  newCharacters: string[];
  /** Blocking problems. Non-empty means it will not render. */
  errors: string[];
  /** Estimated runtime from word counts. The real clock is always the audio. */
  estimateMs: number;
  beatCounts: { line: number; pause: number; action: number };
}

export async function checkScript(source: string, opts: CheckOptions): Promise<CheckResult> {
  const screenplay = parseScript(source, opts.scene);
  const names = screenplay.characters.map((c) => c.toLowerCase());

  const empty: CheckResult = {
    screenplay,
    shots: null,
    rigs: new Map(),
    newCharacters: [],
    errors: [],
    estimateMs: 0,
    beatCounts: { line: 0, pause: 0, action: 0 },
  };

  if (!names.length) {
    return {
      ...empty,
      errors: ['No characters found. A cue must be ALL CAPS alone on its line, with dialogue under it.'],
    };
  }

  const onDisk = new Set(await listRigs());
  const newCharacters = names.filter((n) => !onDisk.has(n));

  // Stand in for missing characters so a check never has a side effect unless
  // asked. Both branches draw the same face for a given name — persisting only
  // adds the stable id and identity stamp — so the puppet someone previewed is
  // the puppet that gets cast.
  const rigs = new Map<string, LoadedRig>();
  for (const name of names) {
    if (onDisk.has(name)) {
      rigs.set(name, await loadRig(name));
    } else if (opts.createMissingCast) {
      rigs.set(name, await createRig(name));
    } else {
      rigs.set(name, { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) });
    }
  }

  let shots: ShotList;
  try {
    shots = autoDirect(screenplay, rigs, {
      scene: opts.scene,
      seed: opts.seed ?? 7,
      fps: opts.fps ?? 24,
      characterFps: opts.characterFps ?? 12,
      // Undefined falls through to the identity profile's resting expression.
      resting: opts.resting,
      set: opts.set ?? null,
    });
  } catch (err) {
    return { ...empty, newCharacters, rigs, errors: [(err as Error).message] };
  }

  const errors = validateShotList(shots, buildCapabilityManifest(rigs));
  if (!errors.length) errors.push(...await validateCompiledStaging(shots, rigs));
  return {
    ...empty,
    shots,
    rigs,
    newCharacters,
    errors,
    ...summarise(shots),
  };
}

/** Run the real staging compiler with cheap estimated speech clocks. */
export async function validateCompiledStaging(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
): Promise<string[]> {
  let set = null;
  if (shots.set) {
    try {
      set = await loadSet(shots.set);
    } catch (error) {
      return [(error as Error).message];
    }
  }
  const timings = new Map<number, LineTiming>();
  shots.beats.forEach((beat, index) => {
    if (beat.kind !== 'line') return;
    timings.set(index, {
      audio: '',
      durationMs: Math.max(1, estimateLineMs(beat.text) - LINE_TAIL_MS),
      cues: [],
    });
  });
  try {
    compileShotList(shots, rigs, timings, null, set);
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}

/** Beat counts and an estimated runtime, for a shot list from any source. */
export function summarise(shots: ShotList): { estimateMs: number; beatCounts: CheckResult['beatCounts'] } {
  const beatCounts = { line: 0, pause: 0, action: 0 };
  let estimateMs = 0;
  for (const beat of shots.beats) {
    beatCounts[beat.kind]++;
    estimateMs += beat.kind === 'line' ? estimateLineMs(beat.text) : beat.ms;
  }
  return { estimateMs, beatCounts };
}

/** Load the rigs a shot list needs, without re-deriving them from a script. */
export async function loadRigsForShotList(shots: ShotList): Promise<Map<string, LoadedRig>> {
  const rigs = new Map<string, LoadedRig>();
  for (const member of shots.cast) {
    if (!rigs.has(member.rig)) rigs.set(member.rig, await loadRig(member.rig));
  }
  return applySceneOutfits(shots, rigs);
}

/**
 * Apply per-scene costume overrides by redrawing the puppet in that outfit.
 *
 * Only generator-drawn puppets can change clothes — their SVG is a function of
 * (look, outfit) — so a hand-drawn rig with a scene outfit is left as drawn.
 * The redraw is scene-local: nothing on disk changes, which is exactly what
 * "costume continuity by default, override per scene" means.
 */
export function applySceneOutfits(shots: ShotList, rigs: Map<string, LoadedRig>): Map<string, LoadedRig> {
  for (const member of shots.cast) {
    if (!member.outfit) continue;
    const loaded = rigs.get(member.rig);
    if (!loaded?.rig.look) continue;
    rigs.set(member.rig, {
      rig: { ...loaded.rig, outfit: member.outfit },
      svg: buildPlaceholderSvg(loaded.rig.name, loaded.rig.look, member.outfit),
    });
  }
  return rigs;
}
