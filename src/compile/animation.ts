import {
  AnimationDocument,
  type AnimationEvent,
  type AnimationKey,
  type AnimationLayer,
  type AnimationTrack,
  type LayerOwnership,
  type MotionSegment,
  type MotionValue,
  type TimeAnchor,
} from '../schema/animation.ts';
import type { IRTransform } from '../schema/ir.ts';
import type { PartTransform, Point } from '../schema/rig.ts';
import { walkDurationMs, walks } from './walk.ts';

/** A word's measured placement on the final scene timeline. */
export interface AnimationTimelineWord {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
}

/** Speech is optional: action and pause beats have no spoken interval. */
export interface AnimationTimelineSpeech {
  startMs: number;
  endMs: number;
  words: AnimationTimelineWord[];
}

export interface AnimationTimelineBeat {
  id: string;
  startMs: number;
  endMs: number;
  speech?: AnimationTimelineSpeech;
}

/**
 * The compiler deliberately accepts a small timing interface rather than a
 * ShotList. Stable ids can be added to the director without coupling this
 * authoring layer to how dialogue duration is obtained.
 */
export interface AnimationTimeline {
  durationMs: number;
  beats: AnimationTimelineBeat[];
}

/**
 * Canonical authoring handle for a script word.
 *
 * The ordinal comes from screenplay order, so changing voice engines or
 * replacing a selected performance cannot invalidate an ordinary word
 * anchor. Measured/aligned word ids are exposed as additional aliases.
 */
export function canonicalWordAnchorId(index: number): string {
  return `word-${index}`;
}

/** Stable alias used by locally generated/aligned word timing metadata. */
export function alignedWordAnchorId(index: number, text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `w${String(index).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}

type AnimationValue = AnimationKey['value'];

export interface ResolvedAnimationKey {
  id: string;
  timeMs: number;
  value: AnimationValue;
  interpolation: 'hold' | 'linear';
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  locked: boolean;
}

export interface ResolvedAnimationTrack {
  track: AnimationTrack;
  layer: AnimationLayer;
  keys: ResolvedAnimationKey[];
}

export interface ResolvedMotionSegment {
  segment: MotionSegment;
  layer: AnimationLayer;
  startMs: number;
  endMs: number;
}

export interface ResolvedAnimationEvent {
  event: AnimationEvent;
  layer: AnimationLayer;
  timeMs: number;
}

export interface ResolvedAnimation {
  document: AnimationDocument;
  timeline: AnimationTimeline;
  /** Sorted in deterministic application order, low precedence first. */
  tracks: ResolvedAnimationTrack[];
  /** Editable motion phrases, sorted by layer precedence and start time. */
  segments: ResolvedMotionSegment[];
  /** Enabled events, sorted by resolved time and then stable id. */
  events: ResolvedAnimationEvent[];
}

interface TimelineIndex {
  timeline: AnimationTimeline;
  beats: Map<string, AnimationTimelineBeat>;
  words: Map<string, Map<string, AnimationTimelineWord>>;
}

function finiteMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite, non-negative millisecond value`);
}

function timelineIndex(timeline: AnimationTimeline): TimelineIndex {
  finiteMs(timeline.durationMs, 'animation timeline duration');
  if (timeline.durationMs <= 0) throw new Error('animation timeline duration must be greater than zero');

  const beats = new Map<string, AnimationTimelineBeat>();
  const words = new Map<string, Map<string, AnimationTimelineWord>>();

  for (const beat of timeline.beats) {
    if (!beat.id) throw new Error('animation timeline beat needs a stable id');
    if (beats.has(beat.id)) throw new Error(`duplicate animation timeline beat id "${beat.id}"`);
    finiteMs(beat.startMs, `beat "${beat.id}" start`);
    finiteMs(beat.endMs, `beat "${beat.id}" end`);
    if (beat.endMs < beat.startMs) throw new Error(`beat "${beat.id}" ends before it starts`);
    if (beat.endMs > timeline.durationMs) throw new Error(`beat "${beat.id}" ends after the animation timeline`);
    beats.set(beat.id, beat);

    const wordMap = new Map<string, AnimationTimelineWord>();
    words.set(beat.id, wordMap);
    if (!beat.speech) continue;

    finiteMs(beat.speech.startMs, `speech in beat "${beat.id}" start`);
    finiteMs(beat.speech.endMs, `speech in beat "${beat.id}" end`);
    if (beat.speech.endMs < beat.speech.startMs) throw new Error(`speech in beat "${beat.id}" ends before it starts`);
    if (beat.speech.startMs < beat.startMs || beat.speech.endMs > beat.endMs) {
      throw new Error(`speech in beat "${beat.id}" falls outside its beat`);
    }

    for (const word of beat.speech.words) {
      if (!word.id) throw new Error(`word in beat "${beat.id}" needs a stable id`);
      if (wordMap.has(word.id)) throw new Error(`duplicate word id "${word.id}" in beat "${beat.id}"`);
      finiteMs(word.startMs, `word "${word.id}" start`);
      finiteMs(word.endMs, `word "${word.id}" end`);
      if (word.endMs < word.startMs) throw new Error(`word "${word.id}" ends before it starts`);
      if (word.startMs < beat.speech.startMs || word.endMs > beat.speech.endMs) {
        throw new Error(`word "${word.id}" falls outside speech in beat "${beat.id}"`);
      }
      wordMap.set(word.id, word);
    }
  }

  return { timeline, beats, words };
}

function resolveAnchor(anchor: TimeAnchor, index: TimelineIndex): number {
  let ms: number;
  if (anchor.kind === 'absolute') {
    ms = anchor.ms;
  } else {
    const beat = index.beats.get(anchor.beatId);
    if (!beat) throw new Error(`animation anchor references missing beat "${anchor.beatId}"`);

    if (anchor.kind === 'beat') {
      ms = (anchor.edge === 'start' ? beat.startMs : beat.endMs) + anchor.offsetMs;
    } else if (anchor.kind === 'speech') {
      if (!beat.speech) throw new Error(`animation anchor references speech in silent beat "${anchor.beatId}"`);
      ms = (anchor.edge === 'start' ? beat.speech.startMs : beat.speech.endMs) + anchor.offsetMs;
    } else {
      const word = index.words.get(anchor.beatId)?.get(anchor.wordId);
      if (!word) {
        throw new Error(`animation anchor references missing word "${anchor.wordId}" in beat "${anchor.beatId}"`);
      }
      ms = (anchor.edge === 'start' ? word.startMs : word.endMs) + anchor.offsetMs;
    }
  }

  if (!Number.isFinite(ms) || ms < 0 || ms > index.timeline.durationMs) {
    throw new Error(`animation anchor resolves outside the scene at ${ms}ms`);
  }
  return ms;
}

/** Resolve one semantic anchor against measured beat/word timing. */
export function resolveTimeAnchor(anchor: TimeAnchor, timeline: AnimationTimeline): number {
  return resolveAnchor(anchor, timelineIndex(timeline));
}

const OWNERSHIP_ORDER: Record<LayerOwnership, number> = {
  generated: 0,
  manual: 1,
  system: 2,
};

function compareLayers(a: AnimationLayer, b: AnimationLayer): number {
  return (
    OWNERSHIP_ORDER[a.ownership] - OWNERSHIP_ORDER[b.ownership] ||
    a.priority - b.priority ||
    a.id.localeCompare(b.id)
  );
}

/** A channel's identity for conflict detection and deterministic composition. */
export function animationTargetKey(target: AnimationTrack | MotionSegment): string {
  return target.channel === 'part.transform'
    ? `${target.actorId}|${target.channel}|${target.partId}`
    : `${target.actorId}|${target.channel}`;
}

function validateTrackConflicts(tracks: ResolvedAnimationTrack[]): void {
  const perLayer = new Map<string, string>();
  for (const resolved of tracks) {
    if (!resolved.layer.enabled || !resolved.track.enabled) continue;
    const target = animationTargetKey(resolved.track);
    const key = `${resolved.layer.id}|${target}`;
    const previous = perLayer.get(key);
    if (previous) {
      throw new Error(
        `animation conflict: tracks "${previous}" and "${resolved.track.id}" both own ${target} in layer "${resolved.layer.id}"`,
      );
    }
    perLayer.set(key, resolved.track.id);
  }

  // Two same-rank override layers would otherwise be decided by their id, a
  // deterministic result but not an authored one. Additive-only peers commute.
  for (let i = 0; i < tracks.length; i++) {
    const a = tracks[i]!;
    if (!a.layer.enabled || !a.track.enabled) continue;
    for (let j = i + 1; j < tracks.length; j++) {
      const b = tracks[j]!;
      if (!b.layer.enabled || !b.track.enabled) continue;
      if (animationTargetKey(a.track) !== animationTargetKey(b.track)) continue;
      if (a.layer.ownership !== b.layer.ownership || a.layer.priority !== b.layer.priority) continue;
      if (a.track.blend === 'additive' && b.track.blend === 'additive') continue;
      throw new Error(
        `animation conflict: tracks "${a.track.id}" and "${b.track.id}" have ambiguous precedence on ${animationTargetKey(a.track)}`,
      );
    }
  }
}

/**
 * Give every authored walk the same ground speed.
 *
 * A drag is committed with the duration of the gesture that made it, so the
 * same puppet covering similar ground arrived at wildly different speeds
 * depending on how fast the mouse moved — 191 px/s one time, 1071 px/s the
 * next. Pace is a property of walking rather than of the gesture that asked for
 * it, so it is decided here from the distance. Phrases already on disk are
 * retimed without being rewritten: the document stays the authored record and
 * this is the compiler reading it.
 *
 * A walk is only ever stretched into room that is genuinely free — the next
 * phrase's start is the ceiling — so normalising the pace can never turn a
 * document that used to compile into an overlap conflict. `gait: 'none'` opts a
 * move out of walking, and thereby out of this.
 */
function paceAuthoredWalks(segments: ResolvedMotionSegment[], durationMs: number): void {
  const groups = new Map<string, ResolvedMotionSegment[]>();
  for (const resolved of segments) {
    if (!resolved.layer.enabled || !resolved.segment.enabled) continue;
    if (resolved.segment.channel !== 'root.position') continue;
    const key = `${resolved.layer.id}|${animationTargetKey(resolved.segment)}`;
    const group = groups.get(key) ?? [];
    group.push(resolved);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.startMs - b.startMs || a.segment.id.localeCompare(b.segment.id));
    group.forEach((resolved, position) => {
      const segment = resolved.segment as Extract<MotionSegment, { channel: 'root.position' }>;
      const [fromX, fromY] = segment.from.value;
      const [toX, toY] = segment.to.value;
      const distance = Math.hypot(toX - fromX, toY - fromY);
      if (!walks(segment.gait, distance)) return;

      // Slowing a walk down is the whole point; speeding one up is not. A
      // phrase already at or under walking pace is someone's deliberate amble,
      // and shrinking phrases would also quietly resolve an authored overlap
      // that the conflict check exists to report.
      const desired = walkDurationMs(distance);
      if (desired <= resolved.endMs - resolved.startMs) return;

      // Never stretch past the next phrase, and never past the end of the
      // scene unless this phrase already ran over it.
      const ceiling = Math.min(
        group[position + 1]?.startMs ?? Number.POSITIVE_INFINITY,
        Math.max(durationMs, resolved.endMs),
      );
      // All or nothing: a walk stretched into room too small to finish in
      // freezes mid-stride at the far end, which looks worse than a brisk one.
      if (desired > ceiling - resolved.startMs) return;
      resolved.endMs = resolved.startMs + desired;
    });
  }
}

function validateSegmentConflicts(segments: ResolvedMotionSegment[]): void {
  const groups = new Map<string, ResolvedMotionSegment[]>();
  for (const resolved of segments) {
    if (!resolved.layer.enabled || !resolved.segment.enabled) continue;
    const key = `${resolved.layer.id}|${animationTargetKey(resolved.segment)}`;
    const group = groups.get(key) ?? [];
    group.push(resolved);
    groups.set(key, group);
  }

  for (const [target, group] of groups) {
    group.sort((a, b) => a.startMs - b.startMs || a.segment.id.localeCompare(b.segment.id));
    for (let index = 1; index < group.length; index++) {
      const previous = group[index - 1]!;
      const current = group[index]!;
      if (current.startMs < previous.endMs - 1e-7) {
        throw new Error(
          `animation conflict: motion segments "${previous.segment.id}" and "${current.segment.id}" overlap on ${target}`,
        );
      }
    }
  }

  for (let index = 0; index < segments.length; index += 1) {
    const a = segments[index]!;
    if (!a.layer.enabled || !a.segment.enabled) continue;
    for (let peer = index + 1; peer < segments.length; peer += 1) {
      const b = segments[peer]!;
      if (!b.layer.enabled || !b.segment.enabled || a.layer.id === b.layer.id) continue;
      if (animationTargetKey(a.segment) !== animationTargetKey(b.segment)) continue;
      if (a.layer.ownership !== b.layer.ownership || a.layer.priority !== b.layer.priority) continue;
      if (a.segment.blend === 'additive' && b.segment.blend === 'additive') continue;
      throw new Error(
        `animation conflict: motion segments "${a.segment.id}" and "${b.segment.id}" have ambiguous precedence on ${animationTargetKey(a.segment)}`,
      );
    }
  }
}

function validateTrackSegmentConflicts(
  tracks: ResolvedAnimationTrack[],
  segments: ResolvedMotionSegment[],
): void {
  for (const track of tracks) {
    if (!track.layer.enabled || !track.track.enabled) continue;
    for (const segment of segments) {
      if (!segment.layer.enabled || !segment.segment.enabled || track.layer.id === segment.layer.id) continue;
      if (animationTargetKey(track.track) !== animationTargetKey(segment.segment)) continue;
      if (
        track.layer.ownership !== segment.layer.ownership ||
        track.layer.priority !== segment.layer.priority
      ) continue;
      if (track.track.blend === 'additive' && segment.segment.blend === 'additive') continue;
      throw new Error(
        `animation conflict: track "${track.track.id}" and motion segment "${segment.segment.id}" have ambiguous precedence on ${animationTargetKey(track.track)}`,
      );
    }
  }
}

function validateEventConflicts(events: ResolvedAnimationEvent[]): void {
  const propStateAt = new Map<string, string>();
  for (const resolved of events) {
    const event = resolved.event;
    if (event.kind !== 'attach' && event.kind !== 'detach') continue;
    const key = `${event.propId}|${resolved.timeMs}`;
    const previous = propStateAt.get(key);
    if (previous) {
      throw new Error(
        `animation conflict: prop "${event.propId}" has state events "${previous}" and "${event.id}" at ${resolved.timeMs}ms`,
      );
    }
    propStateAt.set(key, event.id);
  }
}

/**
 * Validate and resolve an AnimationDocument once. Sampling the result has no
 * lookups into story structure and no frame-to-frame state.
 */
export interface ResolveAnimationOptions {
  /**
   * Give authored walks the engine's walking pace.
   *
   * Off by default because resolving is about turning anchors into
   * milliseconds, and a caller asking where a phrase sits on the timeline
   * should get the answer the document gives. Rendering a scene is the case
   * that wants the paced view, since pace is the engine's to decide.
   */
  paceWalks?: boolean;
}

export function resolveAnimation(
  input: AnimationDocument,
  timeline: AnimationTimeline,
  options: ResolveAnimationOptions = {},
): ResolvedAnimation {
  // Public callers may construct a typed object without parsing it first.
  const document = AnimationDocument.parse(input);
  const index = timelineIndex(timeline);
  const layers = new Map(document.layers.map((layer) => [layer.id, layer]));

  const tracks: ResolvedAnimationTrack[] = document.tracks.map((track) => {
    const layer = layers.get(track.layerId);
    if (!layer) throw new Error(`animation track "${track.id}" references missing layer "${track.layerId}"`);

    const keys: ResolvedAnimationKey[] = track.keys
      .map((key) => ({
        id: key.id,
        timeMs: resolveAnchor(key.time, index),
        value: key.value,
        interpolation: key.interpolation,
        easing: key.easing,
        locked: key.locked,
      }))
      .sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));

    for (let i = 1; i < keys.length; i++) {
      if (Math.abs(keys[i]!.timeMs - keys[i - 1]!.timeMs) < 1e-7) {
        throw new Error(
          `animation track "${track.id}" has two keys resolving to ${keys[i]!.timeMs}ms`,
        );
      }
    }
    return { track, layer, keys };
  });

  tracks.sort((a, b) => compareLayers(a.layer, b.layer) || a.track.id.localeCompare(b.track.id));
  validateTrackConflicts(tracks);

  const segments: ResolvedMotionSegment[] = document.segments.map((segment) => {
    const layer = layers.get(segment.layerId);
    if (!layer) throw new Error(`motion segment "${segment.id}" references missing layer "${segment.layerId}"`);
    const startMs = resolveAnchor(segment.from.time, index);
    const endMs = resolveAnchor(segment.to.time, index);
    if (endMs <= startMs) {
      throw new Error(`motion segment "${segment.id}" must end after it starts`);
    }
    return { segment, layer, startMs, endMs };
  });
  segments.sort((a, b) => (
    compareLayers(a.layer, b.layer) ||
    a.startMs - b.startMs ||
    a.segment.id.localeCompare(b.segment.id)
  ));
  if (options.paceWalks) paceAuthoredWalks(segments, index.timeline.durationMs);
  validateSegmentConflicts(segments);
  validateTrackSegmentConflicts(tracks, segments);

  const events: ResolvedAnimationEvent[] = document.events
    .map((event) => {
      const layer = layers.get(event.layerId);
      if (!layer) throw new Error(`animation event "${event.id}" references missing layer "${event.layerId}"`);
      return { event, layer, timeMs: resolveAnchor(event.at, index) };
    })
    .filter((event) => event.layer.enabled)
    .sort((a, b) => a.timeMs - b.timeMs || compareLayers(a.layer, b.layer) || a.event.id.localeCompare(b.event.id));
  validateEventConflicts(events);

  return { document, timeline: index.timeline, tracks, segments, events };
}

function ease(t: number, easing: ResolvedAnimationKey['easing']): number {
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

function interpolatePart(a: PartTransform, b: PartTransform, t: number): PartTransform {
  return {
    rot: a.rot + (b.rot - a.rot) * t,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    scale: a.scale + (b.scale - a.scale) * t,
  };
}

function interpolateValue(track: AnimationTrack, a: AnimationValue, b: AnimationValue, t: number): AnimationValue {
  if (track.channel === 'root.position') {
    const from = a as Point;
    const to = b as Point;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  }
  if (track.channel === 'root.scale') return (a as number) + ((b as number) - (a as number)) * t;
  if (track.channel === 'part.transform') return interpolatePart(a as PartTransform, b as PartTransform, t);
  return a;
}

function motionComponents(segment: MotionSegment, value: MotionValue): number[] {
  if (segment.channel === 'root.position') return [...(value as Point)];
  if (segment.channel === 'root.scale') return [value as number];
  const transform = value as PartTransform;
  return [transform.rot, transform.x, transform.y, transform.scale];
}

function motionValue(segment: MotionSegment, components: number[]): MotionValue {
  if (segment.channel === 'root.position') return [components[0]!, components[1]!];
  if (segment.channel === 'root.scale') return Math.max(0.001, components[0]!);
  return {
    rot: components[0]!,
    x: components[1]!,
    y: components[2]!,
    scale: Math.max(0.001, components[3]!),
  };
}

function lerpMotion(segment: MotionSegment, a: MotionValue, b: MotionValue, t: number): MotionValue {
  const from = motionComponents(segment, a);
  const to = motionComponents(segment, b);
  return motionValue(segment, from.map((value, index) => value + (to[index]! - value) * t));
}

function extrapolateMotion(
  segment: MotionSegment,
  from: MotionValue,
  to: MotionValue,
  amount: number,
): MotionValue {
  const a = motionComponents(segment, from);
  const b = motionComponents(segment, to);
  return motionValue(segment, a.map((value, index) => value + (b[index]! - value) * amount));
}

function catmullRom(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b +
    (-a + c) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (-a + 3 * b - 3 * c + d) * t3
  );
}

function pathValueAt(segment: MotionSegment, progress: number): MotionValue {
  const knots = [
    { at: 0, value: segment.from.value as MotionValue },
    ...segment.waypoints
      .map((waypoint) => ({ at: waypoint.at, value: waypoint.value as MotionValue }))
      .sort((a, b) => a.at - b.at),
    { at: 1, value: segment.to.value as MotionValue },
  ];
  const p = Math.max(0, Math.min(1, progress));
  let rightIndex = 1;
  while (rightIndex < knots.length - 1 && p > knots[rightIndex]!.at) rightIndex++;
  const leftIndex = rightIndex - 1;
  const left = knots[leftIndex]!;
  const right = knots[rightIndex]!;
  const local = (p - left.at) / Math.max(1e-9, right.at - left.at);

  if (segment.path.shape === 'smooth') {
    const before = knots[Math.max(0, leftIndex - 1)]!;
    const after = knots[Math.min(knots.length - 1, rightIndex + 1)]!;
    const a = motionComponents(segment, before.value);
    const b = motionComponents(segment, left.value);
    const c = motionComponents(segment, right.value);
    const d = motionComponents(segment, after.value);
    return motionValue(segment, b.map((_, index) => catmullRom(
      a[index]!, b[index]!, c[index]!, d[index]!, local,
    )));
  }

  const value = lerpMotion(segment, left.value, right.value, local);
  if (segment.path.shape !== 'arc' || segment.path.curvature === 0) return value;

  const components = motionComponents(segment, value);
  const from = motionComponents(segment, left.value);
  const to = motionComponents(segment, right.value);
  const xIndex = segment.channel === 'root.position' ? 0 : segment.channel === 'part.transform' ? 1 : -1;
  const yIndex = segment.channel === 'root.position' ? 1 : segment.channel === 'part.transform' ? 2 : -1;
  if (xIndex < 0 || yIndex < 0) return value;
  const dx = to[xIndex]! - from[xIndex]!;
  const dy = to[yIndex]! - from[yIndex]!;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) return value;
  const bend = segment.path.curvature * distance * Math.sin(Math.PI * local);
  components[xIndex]! += (-dy / distance) * bend;
  components[yIndex]! += (dx / distance) * bend;
  return motionValue(segment, components);
}

/** Segment contribution: absent before start, persistent endpoint after end. */
function segmentValueAt(resolved: ResolvedMotionSegment, atMs: number): MotionValue | undefined {
  const { segment, startMs, endMs } = resolved;
  if (atMs < startMs) return undefined;
  if (atMs >= endMs) return segment.to.value as MotionValue;

  const raw = (atMs - startMs) / (endMs - startMs);
  const assist = segment.assist;
  const finalAt = 1 - assist.hold;
  const recovery = assist.overshoot > 0 ? assist.recovery : 0;
  const overshootAt = finalAt - recovery;
  const anticipationAt = assist.anticipation > 0 ? Math.min(0.125, overshootAt * 0.25) : 0;
  const from = segment.from.value as MotionValue;
  const to = segment.to.value as MotionValue;
  const anticipated = extrapolateMotion(segment, from, to, -assist.anticipation);
  const overshot = extrapolateMotion(segment, from, to, 1 + assist.overshoot);

  if (anticipationAt > 0 && raw <= anticipationAt) {
    return lerpMotion(segment, from, anticipated, ease(raw / anticipationAt, 'ease-out'));
  }
  if (raw < overshootAt) {
    const core = (raw - anticipationAt) / Math.max(1e-9, overshootAt - anticipationAt);
    let pathProgress = core;
    if (anticipationAt > 0) {
      const returnFraction = 0.2;
      if (core < returnFraction) {
        return lerpMotion(segment, anticipated, from, ease(core / returnFraction, 'ease-in-out'));
      }
      pathProgress = (core - returnFraction) / (1 - returnFraction);
    }
    const eased = ease(pathProgress, segment.easing);
    const base = pathValueAt(segment, eased);
    return assist.overshoot > 0
      ? lerpMotion(segment, base, overshot, eased * eased * eased)
      : base;
  }
  if (raw < finalAt && recovery > 0) {
    return lerpMotion(segment, overshot, to, ease((raw - overshootAt) / recovery, 'ease-out'));
  }
  return to;
}

/** Sample one resolved phrase for validation/authoring previews without layer composition. */
export function sampleMotionSegment(
  resolved: ResolvedMotionSegment,
  atMs: number,
): MotionValue | undefined {
  if (!Number.isFinite(atMs) || atMs < 0) {
    throw new Error('motion segment sample time must be finite and non-negative');
  }
  return segmentValueAt(resolved, atMs);
}

/** Tracks contribute nothing before their first key and hold after the last. */
function trackValueAt(resolved: ResolvedAnimationTrack, atMs: number): AnimationValue | undefined {
  const { keys, track } = resolved;
  if (atMs < keys[0]!.timeMs) return undefined;
  if (atMs >= keys[keys.length - 1]!.timeMs) return keys[keys.length - 1]!.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const left = keys[i]!;
    const right = keys[i + 1]!;
    if (atMs >= right.timeMs) continue;
    if (left.interpolation === 'hold') return left.value;
    const span = right.timeMs - left.timeMs;
    const t = ease((atMs - left.timeMs) / span, left.easing);
    return interpolateValue(track, left.value, right.value, t);
  }
  return keys[keys.length - 1]!.value;
}

export interface AnimationActorState {
  visible?: boolean;
  x?: number;
  y?: number;
  scale?: number;
  flip?: boolean;
  parts: Record<string, IRTransform>;
}

export type AnimationBaseActor = Omit<AnimationActorState, 'parts'> & {
  parts?: Record<string, IRTransform>;
};
export type AnimationBaseState = Record<string, AnimationBaseActor>;
export type AnimationSample = Record<string, AnimationActorState>;

const REST: IRTransform = [0, 0, 0, 1];

function cloneTransform(value: IRTransform): IRTransform {
  return [value[0], value[1], value[2], value[3]];
}

function toIR(value: PartTransform): IRTransform {
  return [value.rot, value.x, value.y, value.scale];
}

function addIR(a: IRTransform, b: PartTransform): IRTransform {
  return [a[0] + b.rot, a[1] + b.x, a[2] + b.y, a[3] * b.scale];
}

function initialSample(base: AnimationBaseState): AnimationSample {
  const out: AnimationSample = {};
  for (const [actorId, actor] of Object.entries(base)) {
    const parts: Record<string, IRTransform> = {};
    for (const [partId, transform] of Object.entries(actor.parts ?? {})) parts[partId] = cloneTransform(transform);
    out[actorId] = { ...actor, parts };
  }
  return out;
}

function actorIn(sample: AnimationSample, actorId: string): AnimationActorState {
  return (sample[actorId] ??= { parts: {} });
}

function applyAnimationValue(
  sample: AnimationSample,
  target: AnimationTrack | MotionSegment,
  value: AnimationValue | MotionValue,
): void {
  const actor = actorIn(sample, target.actorId);
  if (target.channel === 'root.position') {
    const point = value as Point;
    if (target.blend === 'override') {
      actor.x = point[0];
      actor.y = point[1];
    } else {
      actor.x = (actor.x ?? 0) + point[0];
      actor.y = (actor.y ?? 0) + point[1];
    }
  } else if (target.channel === 'root.scale') {
    const scale = value as number;
    actor.scale = target.blend === 'override' ? scale : (actor.scale ?? 1) * scale;
  } else if (target.channel === 'root.flip') {
    actor.flip = value as boolean;
  } else if (target.channel === 'visibility') {
    actor.visible = value as boolean;
  } else {
    const transform = value as PartTransform;
    actor.parts[target.partId] = target.blend === 'override'
      ? toIR(transform)
      : addIR(actor.parts[target.partId] ?? REST, transform);
  }
}

/**
 * Sample and combine every active track at one time.
 *
 * No previous-frame state is consulted. Frames may therefore be compiled in
 * any order and still compare byte-for-byte.
 */
export function sampleAnimation(
  animation: ResolvedAnimation,
  atMs: number,
  base: AnimationBaseState = {},
): AnimationSample {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > animation.timeline.durationMs) {
    throw new Error(`animation sample time ${atMs}ms is outside the scene`);
  }

  const sample = initialSample(base);
  const layers = [...animation.document.layers]
    .filter((layer) => layer.enabled)
    .sort(compareLayers);
  for (const layer of layers) {
    for (const resolved of animation.tracks) {
      if (resolved.layer.id !== layer.id || !resolved.track.enabled) continue;
      const value = trackValueAt(resolved, atMs);
      if (value !== undefined) applyAnimationValue(sample, resolved.track, value);
    }

    // One currently-relevant segment per target. The latest segment that has
    // started owns the target and holds its endpoint until the next starts.
    const active = new Map<string, ResolvedMotionSegment>();
    for (const resolved of animation.segments) {
      if (
        resolved.layer.id !== layer.id ||
        !resolved.segment.enabled ||
        atMs < resolved.startMs
      ) continue;
      active.set(animationTargetKey(resolved.segment), resolved);
    }
    for (const resolved of [...active.values()].sort((a, b) => a.segment.id.localeCompare(b.segment.id))) {
      const value = segmentValueAt(resolved, atMs);
      if (value !== undefined) applyAnimationValue(sample, resolved.segment, value);
    }
  }
  return sample;
}

/** A root-position phrase carrying one actor, and how far into it they are. */
export interface ActiveRootMotion {
  segment: Extract<MotionSegment, { channel: 'root.position' }>;
  /** Where the phrase starts, where it ends, and where it has reached now. */
  from: Point;
  to: Point;
  at: Point;
}

/**
 * The root-position phrase moving one actor at a moment, if any.
 *
 * Sampling the animation says where an actor *is*. This says whether something
 * is carrying them there and how much of the journey is behind them — which is
 * what a gait needs, because feet cycle over ground covered rather than over
 * time. Reading it from the phrase rather than from frame-to-frame differences
 * keeps the compiler's promise that any frame can be built in any order.
 *
 * Precedence follows `sampleAnimation` exactly: later layers win, and within a
 * layer the latest phrase to have started owns the actor's root.
 */
export function activeRootMotion(
  animation: ResolvedAnimation,
  actorId: string,
  atMs: number,
): ActiveRootMotion | null {
  const layers = [...animation.document.layers].filter((layer) => layer.enabled).sort(compareLayers);
  let owner: ResolvedMotionSegment | null = null;

  for (const layer of layers) {
    const active = new Map<string, ResolvedMotionSegment>();
    for (const resolved of animation.segments) {
      const segment = resolved.segment;
      if (
        resolved.layer.id !== layer.id ||
        !segment.enabled ||
        segment.channel !== 'root.position' ||
        segment.actorId !== actorId ||
        atMs < resolved.startMs
      ) continue;
      active.set(animationTargetKey(segment), resolved);
    }
    for (const resolved of [...active.values()].sort((a, b) => a.segment.id.localeCompare(b.segment.id))) {
      owner = resolved;
    }
  }

  if (!owner) return null;
  const at = sampleMotionSegment(owner, atMs) as Point | undefined;
  if (!at) return null;
  const segment = owner.segment as Extract<MotionSegment, { channel: 'root.position' }>;
  return { segment, from: segment.from.value, to: segment.to.value, at };
}

export type AnimationBaseSource =
  | AnimationBaseState
  | ((atMs: number, frame: number) => AnimationBaseState);

/** Sample the same times the renderer will use. */
export function sampleAnimationFrames(
  animation: ResolvedAnimation,
  fps: number,
  base: AnimationBaseSource = {},
): AnimationSample[] {
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('animation sample fps must be a positive integer');
  const count = Math.max(1, Math.round((animation.timeline.durationMs / 1000) * fps));
  const frames: AnimationSample[] = [];
  for (let frame = 0; frame < count; frame++) {
    const atMs = (frame / fps) * 1000;
    const state = typeof base === 'function' ? base(atMs, frame) : base;
    frames.push(sampleAnimation(animation, atMs, state));
  }
  return frames;
}

/** Convenience for callers that need events at an exact compiled frame/time. */
export function eventsAt(animation: ResolvedAnimation, atMs: number, epsilonMs = 1e-6): AnimationEvent[] {
  return animation.events
    .filter((resolved) => Math.abs(resolved.timeMs - atMs) <= epsilonMs)
    .map((resolved) => resolved.event);
}
