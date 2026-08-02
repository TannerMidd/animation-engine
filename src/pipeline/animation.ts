import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sceneDir } from '../core/paths.ts';
import {
  ANIMATION_SCHEMA_VERSION,
  AnimationDocument,
  type AnimationDocument as AnimationDocumentType,
  type TimeAnchor,
} from '../schema/animation.ts';
import type { DownstreamRetime } from '../schema/dialogue.ts';
import { resolveTimeAnchor, type AnimationTimeline } from '../compile/animation.ts';
export { reducePuppeteeringSamples, type PuppeteeringSample } from '../animation/recording.ts';

function timelineBeat(timeline: AnimationTimeline, beatId: string) {
  const beat = timeline.beats.find((item) => item.id === beatId);
  if (!beat) throw new Error(`animation retime cannot find dialogue beat "${beatId}"`);
  return beat;
}

function anchorAttachedToBeat(anchor: TimeAnchor, beatId: string, oldTimeline: AnimationTimeline): boolean {
  if (anchor.kind !== 'absolute') return anchor.beatId === beatId;
  const beat = timelineBeat(oldTimeline, beatId);
  return anchor.ms >= beat.startMs - 1e-6 && anchor.ms <= beat.endMs + 1e-6;
}

function proportionalMs(ms: number, beatId: string, oldTimeline: AnimationTimeline, nextTimeline: AnimationTimeline): number {
  const before = timelineBeat(oldTimeline, beatId);
  const after = timelineBeat(nextTimeline, beatId);
  const span = Math.max(1e-6, before.endMs - before.startMs);
  const at = Math.max(0, Math.min(1, (ms - before.startMs) / span));
  return after.startMs + at * (after.endMs - after.startMs);
}

function retimedAnchor(
  anchor: TimeAnchor,
  beatId: string,
  oldTimeline: AnimationTimeline,
  nextTimeline: AnimationTimeline,
  policy: Exclude<DownstreamRetime, 'ripple'>,
): TimeAnchor {
  if (!anchorAttachedToBeat(anchor, beatId, oldTimeline)) return anchor;
  const oldMs = resolveTimeAnchor(anchor, oldTimeline);
  if (policy === 'preserve-absolute') return { kind: 'absolute', ms: oldMs };
  const mapped = proportionalMs(oldMs, beatId, oldTimeline, nextTimeline);
  if (anchor.kind === 'absolute') return { kind: 'absolute', ms: mapped };
  try {
    const base = resolveTimeAnchor({ ...anchor, offsetMs: 0 }, nextTimeline);
    return { ...anchor, offsetMs: mapped - base };
  } catch {
    // A changed transcript may remove a word anchor. Preserve the selected
    // proportional picture timing explicitly instead of silently dropping it.
    return { kind: 'absolute', ms: mapped };
  }
}

/** Apply the creator's explicit animation response to a changed dialogue cue. */
export function retimeAnimationForDialogue(
  input: AnimationDocumentType,
  beatId: string,
  oldTimeline: AnimationTimeline,
  nextTimeline: AnimationTimeline,
  policy: DownstreamRetime,
): AnimationDocumentType {
  if (policy === 'ripple') return input;
  const layers = new Map(input.layers.map((layer) => [layer.id, layer]));
  const locked = (layerId: string, ownLocked: boolean) => Boolean(layers.get(layerId)?.locked || ownLocked);
  const rewrite = (anchor: TimeAnchor) => retimedAnchor(anchor, beatId, oldTimeline, nextTimeline, policy);
  const changes = (before: TimeAnchor, after: TimeAnchor) => JSON.stringify(before) !== JSON.stringify(after);

  const tracks = input.tracks.map((track) => {
    const keys = track.keys.map((key) => {
      const time = rewrite(key.time);
      if (changes(key.time, time) && (locked(track.layerId, track.locked) || key.locked)) {
        throw new Error(`locked animation key "${key.id}" must be unlocked before dialogue retiming`);
      }
      return { ...key, time };
    });
    return { ...track, keys };
  });
  const segments = input.segments.map((segment) => {
    const fromTime = rewrite(segment.from.time);
    const toTime = rewrite(segment.to.time);
    if (
      (changes(segment.from.time, fromTime) || changes(segment.to.time, toTime)) &&
      (locked(segment.layerId, segment.locked) || segment.from.locked || segment.to.locked)
    ) {
      throw new Error(`locked motion segment "${segment.id}" must be unlocked before dialogue retiming`);
    }
    return {
      ...segment,
      from: { ...segment.from, time: fromTime },
      to: { ...segment.to, time: toTime },
    };
  });
  const events = input.events.map((event) => {
    const at = rewrite(event.at);
    if (changes(event.at, at) && (locked(event.layerId, event.locked))) {
      throw new Error(`locked animation event "${event.id}" must be unlocked before dialogue retiming`);
    }
    return { ...event, at };
  });

  return AnimationDocument.parse({ ...input, tracks, segments, events });
}

/** The editable animation source beside a scene's generated ShotList and IR. */
export function animationPath(scene: string): string {
  if (!scene || /[/\\]/.test(scene)) throw new Error('scene may not contain path separators');
  return path.join(sceneDir(scene), 'animation.json');
}

/**
 * Every scene begins with separate proposal and human-owned layers. Their ids
 * are stable API: the editor can add keys immediately without inventing layer
 * structure, and a director rerun only needs to replace `generated`.
 */
export function defaultAnimation(scene: string): AnimationDocumentType {
  return AnimationDocument.parse({
    schemaVersion: ANIMATION_SCHEMA_VERSION,
    scene,
    revision: 0,
    layers: [
      {
        id: 'generated',
        name: 'Generated direction',
        ownership: 'generated',
        priority: 0,
        enabled: true,
        locked: false,
      },
      {
        id: 'manual',
        name: 'Manual animation',
        ownership: 'manual',
        priority: 0,
        enabled: true,
        locked: false,
      },
    ],
    tracks: [],
    segments: [],
    events: [],
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Missing animation is a normal state for scenes created before this layer. */
export async function readAnimation(scene: string): Promise<AnimationDocumentType | null> {
  const file = animationPath(scene);
  if (!(await fileExists(file))) return null;
  const document = AnimationDocument.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  if (document.scene !== scene) {
    throw new Error(`animation file for "${scene}" declares scene "${document.scene}"`);
  }
  return document;
}

export async function readAnimationOrDefault(scene: string): Promise<AnimationDocumentType> {
  return (await readAnimation(scene)) ?? defaultAnimation(scene);
}

function unchangedExceptUnlock<T extends { locked: boolean }>(before: T, after: T): boolean {
  return isDeepStrictEqual(before, { ...after, locked: before.locked });
}

/** Locked creator work can only be explicitly unlocked; it cannot be edited in the same save. */
export function assertAnimationLocks(
  before: AnimationDocumentType,
  after: AnimationDocumentType,
): void {
  const layers = new Map(after.layers.map((item) => [item.id, item]));
  const tracks = new Map(after.tracks.map((item) => [item.id, item]));
  const segments = new Map(after.segments.map((item) => [item.id, item]));
  const events = new Map(after.events.map((item) => [item.id, item]));

  for (const layer of before.layers) {
    if (!layer.locked) continue;
    const candidate = layers.get(layer.id);
    if (!candidate) throw new Error(`locked animation layer "${layer.id}" cannot be removed`);
    const beforeTracks = before.tracks.filter((item) => item.layerId === layer.id);
    const afterTracks = after.tracks.filter((item) => item.layerId === layer.id);
    const beforeSegments = before.segments.filter((item) => item.layerId === layer.id);
    const afterSegments = after.segments.filter((item) => item.layerId === layer.id);
    const beforeEvents = before.events.filter((item) => item.layerId === layer.id);
    const afterEvents = after.events.filter((item) => item.layerId === layer.id);
    if (
      !unchangedExceptUnlock(layer, candidate) ||
      !isDeepStrictEqual(beforeTracks, afterTracks) ||
      !isDeepStrictEqual(beforeSegments, afterSegments) ||
      !isDeepStrictEqual(beforeEvents, afterEvents)
    ) {
      throw new Error(`locked animation layer "${layer.id}" must be unlocked before editing`);
    }
  }

  for (const segment of before.segments) {
    const candidate = segments.get(segment.id);
    if (segment.locked) {
      if (!candidate) throw new Error(`locked motion segment "${segment.id}" cannot be removed`);
      if (!unchangedExceptUnlock(segment, candidate)) {
        throw new Error(`locked motion segment "${segment.id}" must be unlocked before editing`);
      }
      continue;
    }
    const controls = [segment.from, segment.to, ...segment.waypoints];
    if (!candidate) {
      const locked = controls.find((control) => control.locked);
      if (locked) throw new Error(`locked motion control "${locked.id}" cannot be removed`);
      continue;
    }
    const nextControls = new Map([
      candidate.from,
      candidate.to,
      ...candidate.waypoints,
    ].map((control) => [control.id, control]));
    for (const control of controls) {
      if (!control.locked) continue;
      const next = nextControls.get(control.id);
      if (!next) throw new Error(`locked motion control "${control.id}" cannot be removed`);
      if (!unchangedExceptUnlock(control, next)) {
        throw new Error(`locked motion control "${control.id}" must be unlocked before editing`);
      }
    }
  }

  for (const track of before.tracks) {
    if (!track.locked) continue;
    const candidate = tracks.get(track.id);
    if (!candidate) throw new Error(`locked animation track "${track.id}" cannot be removed`);
    if (!unchangedExceptUnlock(track, candidate)) {
      throw new Error(`locked animation track "${track.id}" must be unlocked before editing`);
    }
  }

  for (const track of before.tracks) {
    const candidate = tracks.get(track.id);
    if (!candidate) continue;
    const nextKeys = new Map(candidate.keys.map((item) => [item.id, item]));
    for (const key of track.keys) {
      if (!key.locked) continue;
      const next = nextKeys.get(key.id);
      if (!next) throw new Error(`locked animation key "${key.id}" cannot be removed`);
      if (!unchangedExceptUnlock(key, next)) {
        throw new Error(`locked animation key "${key.id}" must be unlocked before editing`);
      }
    }
  }

  for (const event of before.events) {
    if (!event.locked) continue;
    const candidate = events.get(event.id);
    if (!candidate) throw new Error(`locked animation event "${event.id}" cannot be removed`);
    if (!unchangedExceptUnlock(event, candidate)) {
      throw new Error(`locked animation event "${event.id}" must be unlocked before editing`);
    }
  }
}

function shiftedAnchor(anchor: TimeAnchor, deltaMs: number): TimeAnchor {
  if (!Number.isFinite(deltaMs)) throw new Error('motion retime delta must be finite');
  if (anchor.kind === 'absolute') {
    const ms = anchor.ms + deltaMs;
    if (ms < 0) throw new Error('motion retime would move an endpoint before the scene');
    return { ...anchor, ms };
  }
  return { ...anchor, offsetMs: anchor.offsetMs + deltaMs };
}

/** Retime one endpoint without baking a semantic anchor into absolute time. */
export function retimeMotionEndpoint(
  input: AnimationDocumentType,
  segmentId: string,
  edge: 'from' | 'to',
  time: TimeAnchor,
): AnimationDocumentType {
  const segment = input.segments.find((item) => item.id === segmentId);
  if (!segment) throw new Error(`unknown motion segment "${segmentId}"`);
  if (segment.locked || segment[edge].locked) {
    throw new Error(`motion segment "${segmentId}" ${edge} endpoint is locked`);
  }
  return AnimationDocument.parse({
    ...input,
    segments: input.segments.map((item) => item.id === segmentId
      ? { ...item, [edge]: { ...item[edge], time } }
      : item),
  });
}

/** Shift both endpoints by the same amount, preserving duration and anchor kind. */
export function retimeMotionSegment(
  input: AnimationDocumentType,
  segmentId: string,
  deltaMs: number,
): AnimationDocumentType {
  const segment = input.segments.find((item) => item.id === segmentId);
  if (!segment) throw new Error(`unknown motion segment "${segmentId}"`);
  if (segment.locked || segment.from.locked || segment.to.locked) {
    throw new Error(`motion segment "${segmentId}" endpoints are locked`);
  }
  return AnimationDocument.parse({
    ...input,
    segments: input.segments.map((item) => item.id === segmentId
      ? {
          ...item,
          from: { ...item.from, time: shiftedAnchor(item.from.time, deltaMs) },
          to: { ...item.to, time: shiftedAnchor(item.to.time, deltaMs) },
        }
      : item),
  });
}

/** Validate before touching disk, then write the same plain JSON the UI edits. */
export async function writeAnimation(scene: string, input: AnimationDocumentType): Promise<void> {
  const document = AnimationDocument.parse(input);
  if (document.scene !== scene) {
    throw new Error(`cannot save scene "${document.scene}" as animation for "${scene}"`);
  }
  const file = animationPath(scene);
  const existing = await readAnimation(scene);
  if (existing) assertAnimationLocks(existing, document);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
