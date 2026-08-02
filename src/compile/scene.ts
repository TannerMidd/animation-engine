import { Rng, deriveSeed } from '../core/rng.ts';
import type { LoadedRig } from '../cast/store.ts';
import type {
  Rig,
  Pose,
  Expression,
  SceneIR,
  IRFrame,
  IRActor,
  IRTransform,
  IRPropState,
  PartTransform,
} from '../schema/index.ts';
import {
  MARKS,
  SUPPORTED_STAGE_ACTIONS,
  type ShotList,
  type ShotBeat,
  type StageAction,
  type StagePosition,
  type LookDirection,
} from '../schema/script.ts';
import { baseFrame, applyMove, type ActorFrameInfo } from '../render/framing.ts';
import { faceBox } from '../cast/placeholder.ts';
import { mouthAt, type LineTiming, type WordTiming } from '../voice/visemes.ts';
import {
  IDENTITY,
  add,
  lerp,
  pruneRest,
  scheduleBlinks,
  isBlinking,
  mouthOpenness,
  type BlinkWindow,
} from './layers.ts';
import {
  actingOf, expressionSegments, valueAt, gestureReleaseMs, fidgetSchedule, fidgetAt,
  gazeTowardSpeaker, type ActingResolved, type FidgetShift,
} from './performance.ts';
import { activeIdentity } from '../show/context.ts';
import { titleCardSvg, endCardSvg } from '../render/cards.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import {
  alignedWordAnchorId,
  canonicalWordAnchorId,
  resolveAnimation,
  sampleAnimation,
  sampleMotionSegment,
  type AnimationTimeline,
  type ResolvedAnimation,
} from './animation.ts';
import { geometryFor, type SetDescriptor } from '../sets/schema.ts';
import {
  interactionHandle,
  propHandlePoint,
  propHasReference,
  resolvePropReference,
  resolveSetProps,
  type ResolvedSetProp,
} from '../sets/interaction.ts';
import type { PropInteractionHandle } from '../sets/props/types.ts';

/**
 * Shot list + audio timing -> per-frame scene IR.
 *
 * Audio is the clock. Every beat's length comes from the dialogue it contains,
 * never from a guess, so the animation cannot drift out of sync with the voice
 * track — the two are generated from the same timeline.
 *
 * There is no AI in this file. All of the interpretation happened upstream in
 * the director; what remains is arithmetic, which is why it is reproducible.
 */

/** Breathing room after each line so dialogue doesn't butt end-to-end. */
export const LINE_TAIL_MS = 160;

/** Words per second, measured against Chatterbox output. Only for estimates. */
const WORDS_PER_SECOND = 2.7;

/**
 * Guess a line's length without synthesizing it.
 *
 * Used by `anim check` so you can sanity-check a script's pacing in under a
 * second. The real timeline always comes from the rendered audio — this is a
 * planning aid, never an input to the compiler.
 */
export function estimateLineMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(700, Math.round((words / WORDS_PER_SECOND) * 1000)) + LINE_TAIL_MS;
}

/** How long a hand pose holds before the other hand takes over, while talking. */
const TALK_SWAP_MS = 420;

/**
 * Fraction of the way to the new pose on the single transition frame.
 *
 * Limited animation snaps between held poses rather than easing between them,
 * but a truly instant jump reads as a teleport. One intermediate frame at 60%
 * is the classic two-step snap and costs one frame.
 */
const SNAP_BLEND = 0.6;

/**
 * How many milliseconds of card sit before and after the scene body.
 *
 * The one place this arithmetic lives: the compiler splices frames with it and
 * the soundtrack shifts placements with it, so picture and sound cannot
 * disagree about where the scene starts.
 */
export function cardTiming(shots: Pick<ShotList, 'cards' | 'fps'>): { titleMs: number; endMs: number; titleFrames: number; endFrames: number } {
  if (!shots.cards) return { titleMs: 0, endMs: 0, titleFrames: 0, endFrames: 0 };
  const cards = activeIdentity().visual.cards;
  return {
    titleFrames: cards.titleFrames,
    endFrames: cards.endFrames,
    titleMs: (cards.titleFrames / shots.fps) * 1000,
    endMs: (cards.endFrames / shots.fps) * 1000,
  };
}

interface Timed {
  beat: ShotBeat;
  index: number;
  startMs: number;
  endMs: number;
  timing?: LineTiming;
  /** When a held gesture on this beat drops back into talking. */
  releaseMs: number;
}
type TimedBeat = Timed;

interface ActorRt {
  id: string;
  rig: Rig;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  headX: number;
  headY: number;
  headR: number;
  resting: string;
  poses: Map<string, Pose>;
  expressions: Map<string, Expression>;
  defaultSwaps: Record<string, string>;
  blinks: BlinkWindow[];
  breathPhase: number;
  talkPhase: number;
  hasEyesClosed: boolean;
  hasEyesSide: boolean;
  acting: ActingResolved;
  /** Expression timeline with listener latency applied. Filled at compile. */
  exprSegments: Array<{ fromMs: number; value: string }>;
  /** Held weight-shift schedule. Filled at compile. */
  fidgets: FidgetShift[];
  /** Previous character-frame's resolved parts, for the snap frame. */
  lastParts: Record<string, IRTransform>;
  lastPoseKey: string;
  /** Stateful blocking compiled once from ordered stage actions. */
  initialStage: StageState;
  stageTransitions: StageTransition[];
}

export interface CompiledStageState {
  visible: boolean;
  x: number;
  y: number;
  depth: number;
  flip: boolean;
  pose: string;
  lookTarget: string | null;
  lookDirection: LookDirection | null;
  turnTarget: string | null;
  turnDirection: LookDirection | null;
  /** Stable seat id while physically bound to seat geometry. */
  seatedOn: string | null;
  /** One portable prop at a time in this milestone; null means both hands are free. */
  heldPropId: string | null;
  heldHand: 'left' | 'right' | null;
}

type StageState = CompiledStageState;

/** Canonical structured blocking transition on the final programme clock. */
export interface CompiledStageContact {
  id: string;
  kind: 'grasp' | 'release' | 'tap';
  actor: string;
  hand: 'left' | 'right';
  atMs: number;
  ordinal: number;
  total: number;
  target: {
    kind: 'prop';
    id: string;
    prop: string;
    handle: string;
  };
  /** Contact position in set coordinates, for later Foley/spatial consumers. */
  point: { x: number; y: number };
}

export interface CompiledStageAction {
  id: string;
  beatId: string;
  beatIndex: number;
  actionIndex: number;
  type: StageAction['type'];
  actor: string;
  startMs: number;
  endMs: number;
  before: CompiledStageState;
  after: CompiledStageState;
  /** Zero or more exact semantic contacts on the final programme clock. */
  contacts: CompiledStageContact[];
}

interface StageInteraction {
  prop: ResolvedSetProp;
  handle: PropInteractionHandle;
  hand: 'left' | 'right';
  point: { x: number; y: number };
  contactProgresses: number[];
  /** Final prop-origin placement for PUT_DOWN. */
  placement?: { x: number; y: number };
}

interface StageTransition {
  action: StageAction;
  type: StageAction['type'];
  startMs: number;
  endMs: number;
  before: StageState;
  after: StageState;
  stateChangeProgress: number;
  interaction?: StageInteraction;
}

type PropLocation = 'set' | 'world' | 'held';

interface PropContinuityState {
  location: PropLocation;
  x: number;
  y: number;
  holder: string | null;
}

interface PropTransition {
  type: 'pick_up' | 'put_down';
  actor: string;
  startMs: number;
  endMs: number;
  contactProgress: number;
  before: PropContinuityState;
  after: PropContinuityState;
  interaction: StageInteraction;
}

interface PropRt {
  prop: ResolvedSetProp;
  initial: PropContinuityState;
  transitions: PropTransition[];
}

const SUPPORTED_STAGE_ACTION_SET = new Set<string>(SUPPORTED_STAGE_ACTIONS);

/** Depth is intentionally subtle: blocking should read without changing scale class. */
const DEPTH_SCALE = 0.14;

/** A rig-independent seated fallback for puppets that predate a dedicated SIT pose. */
const CHAIR_SEATED_PARTS = {
  torso: { y: 62 },
  // Placeholder rigs only have one rigid segment per leg.  A wide rotation
  // therefore reads as a split, not a bent knee.  Short, nearly vertical legs
  // give the useful limited-animation silhouette instead: hips on the cushion,
  // shins hanging below it and shoes close to the floor.
  leg_L: { rot: 8, scale: 0.58 },
  leg_R: { rot: -8, scale: 0.58 },
} as const;

/** Explicit floor sitting keeps a broader silhouette than a chair sit. */
const FLOOR_SEATED_PARTS = {
  torso: { y: 62 },
  leg_L: { rot: 72 },
  leg_R: { rot: -72 },
} as const;

export interface AudioPlacement {
  file: string;
  startMs: number;
  /** Stable cast id, used to build performer Scene Run guide mixes. */
  speaker?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  playbackDurationMs?: number;
  speechOnsetMs?: number;
  speechEndMs?: number;
  turnGapMs?: number;
  pickupMs?: number;
  pauseAfterMs?: number;
  overlapMs?: number;
  overlapMode?: 'pickup' | 'overlap' | 'interruption';
  overlapWithCueId?: string;
  interruptAtMs?: number | null;
  editorialTiming?: boolean;
  cueId?: string;
  selectionKey?: string;
  timingKey?: string;
}

/** Display captions on the final programme clock, after card offset. */
export interface CompiledCaptionCue {
  id: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface CompiledScene {
  ir: SceneIR;
  audio: AudioPlacement[];
  captions: CompiledCaptionCue[];
  /** Validated action transitions, card-shifted onto the final programme clock. */
  stageActions: CompiledStageAction[];
  /** Full programme length, cards included. */
  durationMs: number;
  /** Millisecond start of each beat on the final timeline (card-shifted). */
  beatStarts: number[];
}

function buildTimeline(shots: ShotList, timings: Map<number, LineTiming>): Timed[] {
  const out: Timed[] = [];
  let cursor = 0;
  let previousSpeechEndMs: number | null = null;

  shots.beats.forEach((beat, index) => {
    let timing: LineTiming | undefined;

    if (beat.kind === 'line') {
      timing = timings.get(index);
      if (!timing) throw new Error(`beat ${index} is a line but has no audio timing`);
      if (!timing.editorialTiming) {
        const startMs = cursor;
        const endMs = startMs + timing.durationMs + LINE_TAIL_MS;
        out.push({ beat, index, startMs, endMs, timing, releaseMs: 0 });
        previousSpeechEndMs = startMs + (timing.speechEndMs ?? timing.durationMs);
        cursor = endMs;
        return;
      }

      const speechOnsetMs = timing.speechOnsetMs ?? timing.speechStartMs ?? 0;
      const neutralSpeechStart = previousSpeechEndMs === null
        ? cursor + speechOnsetMs
        : Math.max(cursor, previousSpeechEndMs + (timing.turnGapMs ?? 0));
      let requestedStart =
        neutralSpeechStart - speechOnsetMs - (timing.pickupMs ?? 0) - (timing.overlapMs ?? 0);

      if (timing.absoluteStartMs !== undefined) {
        if (timing.overlapWithCueId) {
          throw new Error(`dialogue cue "${timing.cueId ?? index}" cannot combine an absolute start with an overlap target`);
        }
        requestedStart = timing.absoluteStartMs;
      }

      if (timing.overlapWithCueId) {
        const overlapWithCueId = timing.overlapWithCueId;
        const target = [...out].reverse().find((candidate) => candidate.beat.id === overlapWithCueId);
        const previousLine = [...out].reverse().find((candidate) => candidate.beat.kind === 'line');
        if (!target || target.beat.kind !== 'line' || !target.timing) {
          throw new Error(`dialogue cue "${timing.cueId ?? index}" overlaps unavailable cue "${timing.overlapWithCueId}"`);
        }
        if (target !== previousLine || target !== out[out.length - 1]) {
          throw new Error(
            `dialogue cue "${timing.cueId ?? index}" may only overlap the immediately preceding dialogue cue`,
          );
        }
        if (timing.overlapMode === 'interruption' && timing.interruptAtMs !== null && timing.interruptAtMs !== undefined) {
          const cutLocalMs = timing.interruptAtMs;
          if (cutLocalMs <= 0 || cutLocalMs >= target.timing.durationMs) {
            throw new Error(
              `dialogue cue "${timing.cueId ?? index}" interruption point ${cutLocalMs}ms is outside ` +
              `"${timing.overlapWithCueId}" (${Math.round(target.timing.durationMs)}ms)`,
            );
          }
          const cutMs = target.startMs + cutLocalMs;
          const cropTokens = <T extends { startMs: number; endMs: number }>(tokens: readonly T[] | undefined): T[] | undefined => (
            tokens?.flatMap((token) => token.startMs >= cutLocalMs
              ? []
              : [{ ...token, endMs: Math.min(token.endMs, cutLocalMs) }])
          );
          target.timing = {
            ...target.timing,
            durationMs: cutLocalMs,
            playbackDurationMs: Math.min(target.timing.playbackDurationMs ?? cutLocalMs, cutLocalMs),
            speechStartMs: Math.min(target.timing.speechStartMs ?? cutLocalMs, cutLocalMs),
            speechOnsetMs: Math.min(target.timing.speechOnsetMs ?? cutLocalMs, cutLocalMs),
            speechEndMs: Math.min(target.timing.speechEndMs ?? cutLocalMs, cutLocalMs),
            cues: target.timing.cues.filter((cue) => cue.ms < cutLocalMs),
            words: cropTokens(target.timing.words),
            alignment: target.timing.alignment ? {
              ...target.timing.alignment,
              words: cropTokens(target.timing.alignment.words) ?? [],
            } : undefined,
          };
          target.endMs = cutMs;
          cursor = cutMs;
          previousSpeechEndMs = cutMs;
          requestedStart = cutMs - speechOnsetMs;
        }
      }
      // An overlap may reach into the preceding beat, but stable script order
      // still needs monotonic starts for stage actions, cameras and anchors.
      const previousStart = out[out.length - 1]?.startMs ?? 0;
      if (timing.absoluteStartMs !== undefined && requestedStart < previousStart - 1e-6) {
        throw new Error(
          `dialogue cue "${timing.cueId ?? index}" absolute start ${Math.round(requestedStart)}ms ` +
          `precedes the previous beat start ${Math.round(previousStart)}ms`,
        );
      }
      const startMs = Math.max(0, previousStart, requestedStart);
      const endMs = startMs + timing.durationMs + (timing.pauseAfterMs ?? 0);
      out.push({ beat, index, startMs, endMs, timing, releaseMs: 0 });
      previousSpeechEndMs = startMs + (timing.speechEndMs ?? timing.durationMs);
      cursor = Math.max(cursor, endMs);
      return;
    }

    out.push({ beat, index, startMs: cursor, endMs: cursor + beat.ms, releaseMs: 0 });
    cursor += beat.ms;
  });

  // Gesture release points, once the whole timeline is placed.
  for (const t of out) t.releaseMs = gestureReleaseMs(t, shots.characterFps);

  return out;
}

const VALID_ANIMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function estimatedWordTimings(text: string, startMs: number, endMs: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const span = (endMs - startMs) / words.length;
  return words.map((word, index) => ({
    text: word,
    startMs: startMs + span * index,
    endMs: startMs + span * (index + 1),
  }));
}

function animationWords(words: WordTiming[], lineStartMs: number) {
  return words.flatMap((word, index) => {
    // The index id is stable across voice takes because it comes from script
    // order, not an aligner's token id. Preserve a valid supplied id as an
    // alias so imported alignments can still carry their own stable handles.
    const canonical = canonicalWordAnchorId(index);
    const supplied = word.id ?? alignedWordAnchorId(index, word.text);
    const item = {
      id: canonical,
      text: word.text,
      startMs: lineStartMs + word.startMs,
      endMs: lineStartMs + word.endMs,
    };
    return VALID_ANIMATION_ID.test(supplied) && supplied !== canonical
      ? [item, { ...item, id: supplied }]
      : [item];
  });
}

/**
 * Put authoring anchors on the same final-programme clock as preview seeking.
 * LineTiming's speech and word coordinates are line-local; cards and beat
 * placement are added exactly once here.
 */
function buildAnimationTimeline(
  timeline: Timed[],
  titleMs: number,
  endMs: number,
): AnimationTimeline {
  const bodyDurationMs = timeline.reduce((max, timed) => Math.max(max, timed.endMs), 0);
  return {
    durationMs: titleMs + bodyDurationMs + endMs,
    beats: timeline.map((timed) => {
      const beatId = timed.beat.id;
      if (!beatId) throw new Error(`beat ${timed.index} has no stable id for animation anchors`);
      const startMs = titleMs + timed.startMs;
      const endMs = titleMs + timed.endMs;
      if (timed.beat.kind !== 'line' || !timed.timing) {
        return { id: beatId, startMs, endMs };
      }

      const timing = timed.timing;
      const declaredSpeechStart = timing.speechStartMs ?? timing.speechOnsetMs ?? 0;
      const declaredSpeechEnd = timing.speechEndMs ?? timing.durationMs;
      const providedWords = timing.words ?? timing.alignment?.words ?? [];
      const rawWords = providedWords.length
        ? providedWords
        : estimatedWordTimings(timed.beat.text, declaredSpeechStart, declaredSpeechEnd);
      const words = animationWords(rawWords, startMs);

      // A plain TTS timing still has useful audio bounds. Reviewed recordings
      // tighten these to actual speech, so semantic keys improve without a
      // migration or a different animation document.
      const firstWord = rawWords.length ? Math.min(...rawWords.map((word) => word.startMs)) : Infinity;
      const lastWord = rawWords.length ? Math.max(...rawWords.map((word) => word.endMs)) : -Infinity;
      const localSpeechStart = Math.min(
        declaredSpeechStart,
        firstWord,
      );
      const localSpeechEnd = Math.max(
        declaredSpeechEnd,
        lastWord,
      );
      if (
        !Number.isFinite(localSpeechStart) || !Number.isFinite(localSpeechEnd) ||
        localSpeechStart < 0 || localSpeechEnd < localSpeechStart || localSpeechEnd > timing.durationMs
      ) {
        throw new Error(`line beat "${beatId}" has invalid semantic speech timing`);
      }

      return {
        id: beatId,
        startMs,
        endMs,
        speech: {
          startMs: startMs + localSpeechStart,
          endMs: startMs + localSpeechEnd,
          words,
        },
      };
    }),
  };
}

/**
 * Resolve the exact semantic animation clock from already selected line
 * timings. This is shared by rendering, preflight, and dialogue-retiming so
 * those paths cannot drift into different editorial schedules.
 */
export function animationTimelineForTimings(
  shots: ShotList,
  timings: Map<number, LineTiming>,
): AnimationTimeline {
  const timeline = buildTimeline(shots, timings);
  const cards = cardTiming(shots);
  return buildAnimationTimeline(timeline, cards.titleMs, cards.endMs);
}

function validateAnimationTargets(animation: ResolvedAnimation, actors: ActorRt[], shots: ShotList): void {
  const cast = new Map(actors.map((actor) => [actor.id, actor]));
  for (const resolved of animation.tracks) {
    const track = resolved.track;
    const actor = cast.get(track.actorId);
    if (!actor) throw new Error(`animation track "${track.id}" references unknown actor "${track.actorId}"`);
    if (track.channel === 'part.transform' && !actor.rig.parts.some((part) => part.id === track.partId)) {
      throw new Error(
        `animation track "${track.id}" references missing part "${track.partId}" on actor "${track.actorId}"`,
      );
    }
  }
  for (const resolved of animation.segments) {
    const segment = resolved.segment;
    const actor = cast.get(segment.actorId);
    if (!actor) {
      throw new Error(`motion segment "${segment.id}" references unknown actor "${segment.actorId}"`);
    }
    const firstFrame = Math.max(0, Math.floor((resolved.startMs / 1_000) * shots.fps));
    const lastFrame = Math.min(
      Math.ceil((animation.timeline.durationMs / 1_000) * shots.fps),
      Math.ceil((resolved.endMs / 1_000) * shots.fps),
    );
    const sampleTimes = new Set<number>([resolved.startMs, resolved.endMs]);
    for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
      sampleTimes.add((frame / shots.fps) * 1_000);
    }
    if (segment.channel === 'root.position') {
      const controls = [segment.from, ...segment.waypoints, segment.to];
      for (const control of controls) {
        const [x, y] = control.value;
        if (x < 0 || x > shots.width || y < 0 || y > shots.height) {
          throw new Error(`motion segment "${segment.id}" leaves the authored stage at ${x},${y}`);
        }
      }
      for (const atMs of sampleTimes) {
        const value = sampleMotionSegment(resolved, atMs) as [number, number] | undefined;
        if (!value) continue;
        const [x, y] = value;
        if (x < 0 || x > shots.width || y < 0 || y > shots.height) {
          throw new Error(`motion segment "${segment.id}" leaves the authored stage at ${x},${y} (${atMs}ms)`);
        }
      }
    } else if (segment.channel === 'part.transform') {
      if (!actor.rig.parts.some((part) => part.id === segment.partId)) {
        throw new Error(
          `motion segment "${segment.id}" references missing part "${segment.partId}" on actor "${segment.actorId}"`,
        );
      }
      const reach = segment.partId === 'head' ? 48 : 120;
      const controls = [segment.from, ...segment.waypoints, segment.to];
      for (const control of controls) {
        if (Math.hypot(control.value.x, control.value.y) > reach + 1e-7) {
          throw new Error(`motion segment "${segment.id}" exceeds ${segment.partId} reach (${reach})`);
        }
      }
      for (const atMs of sampleTimes) {
        const value = sampleMotionSegment(resolved, atMs) as { x: number; y: number } | undefined;
        if (value && Math.hypot(value.x, value.y) > reach + 1e-7) {
          throw new Error(`motion segment "${segment.id}" exceeds ${segment.partId} reach (${reach}) at ${atMs}ms`);
        }
      }
    }
  }
  for (const resolved of animation.events) {
    const event = resolved.event;
    if ((event.kind === 'attach' || event.kind === 'contact') && !cast.has(event.actorId)) {
      throw new Error(`animation event "${event.id}" references unknown actor "${event.actorId}"`);
    }
  }
}

function applyAuthoredAnimation(
  animation: ResolvedAnimation,
  atMs: number,
  base: Record<string, IRActor>,
): Record<string, IRActor> {
  const sampled = sampleAnimation(
    animation,
    atMs,
    Object.fromEntries(Object.entries(base).map(([id, actor]) => [id, {
      visible: actor.visible,
      x: actor.x,
      y: actor.y,
      scale: actor.scale,
      flip: actor.flip,
      parts: actor.parts,
    }])),
  );

  const out: Record<string, IRActor> = {};
  for (const [id, actor] of Object.entries(base)) {
    const authored = sampled[id]!;
    if (authored.scale === undefined || !Number.isFinite(authored.scale) || authored.scale <= 0) {
      throw new Error(`animation produces invalid scale for actor "${id}" at ${atMs}ms`);
    }
    out[id] = {
      visible: authored.visible ?? actor.visible,
      x: authored.x ?? actor.x,
      y: authored.y ?? actor.y,
      scale: authored.scale,
      flip: authored.flip ?? actor.flip,
      parts: pruneRest(authored.parts),
      swaps: actor.swaps,
    };
  }
  return out;
}

function prepareActor(shots: ShotList, member: ShotList['cast'][number], loaded: LoadedRig): ActorRt {
  const rig = loaded.rig;
  // Streams key off the rig's stable id when it has one, so renaming a
  // character — in the script and on disk — does not reshuffle their breathing
  // phase or anything else seeded here. The scene-local id is only the
  // fallback for ephemeral placeholders that were never saved.
  const rng = new Rng(deriveSeed(shots.seed, `actor:${rig.charId ?? member.id}`));

  const x = member.position?.x ?? shots.width * MARKS[member.mark];
  const y = member.position?.y ?? shots.height * 0.97;
  const scale = member.scale;
  const dir = member.flip ? -1 : 1;

  const defaultSwaps: Record<string, string> = {};
  for (const set of rig.swapSets) defaultSwaps[set.slot] = set.default;

  return {
    id: member.id,
    rig,
    x,
    y,
    scale,
    flip: member.flip,
    headX: x + (rig.focus[0] - rig.anchor[0]) * scale * dir,
    headY: y - (rig.anchor[1] - rig.focus[1]) * scale,
    // The face crop box is already the "how big is this head" calculation, and
    // it knows about hair and ears; reusing it keeps one answer to that question.
    headR: (faceBox(rig).h / 2) * scale,
    resting: member.resting,
    poses: new Map(rig.poses.map((p) => [p.name, p])),
    expressions: new Map(rig.expressions.map((e) => [e.name, e])),
    defaultSwaps,
    blinks: [],
    breathPhase: rng.range(0, Math.PI * 2),
    talkPhase: rng.range(0, TALK_SWAP_MS),
    hasEyesClosed: rig.swapSets.some((s) => s.slot === 'eyes' && s.variants.includes('eyes_closed')),
    hasEyesSide: rig.swapSets.some((s) => s.slot === 'eyes' && s.variants.includes('eyes_side')),
    acting: actingOf(rig),
    exprSegments: [],
    fidgets: [],
    lastParts: {},
    lastPoseKey: '',
    initialStage: {
      visible: member.visible,
      x,
      y,
      depth: member.depth,
      flip: member.flip,
      pose: member.pose,
      lookTarget: null,
      lookDirection: null,
      turnTarget: null,
      turnDirection: null,
      seatedOn: member.seat,
      heldPropId: member.heldProp,
      heldHand: member.heldHand,
    },
    stageTransitions: [],
  };
}

function cloneStage(state: StageState): StageState {
  return { ...state };
}

function placeAt(state: StageState, position: StagePosition | undefined, shots: ShotList): StageState {
  if (!position) return cloneStage(state);
  return {
    ...state,
    x: position.x ?? (position.mark ? shots.width * MARKS[position.mark] : state.x),
    y: position.y ?? state.y,
    depth: position.depth ?? state.depth,
  };
}

function offstageState(
  actor: ActorRt,
  state: StageState,
  shots: ShotList,
  authored: StagePosition | undefined,
): StageState {
  if (authored) return placeAt(state, authored, shots);
  const scaledWidth = actor.rig.canvas.width * actor.scale * (1 + state.depth * DEPTH_SCALE);
  return {
    ...state,
    x: state.x <= shots.width / 2 ? -scaledWidth : shots.width + scaledWidth,
  };
}

function actionWindows(
  timed: TimedBeat,
  fps: number,
): Array<{ action: StageAction; actionIndex: number; startMs: number; endMs: number }> {
  if (timed.beat.kind !== 'action') return [];
  const actions = timed.beat.stage;
  const span = timed.endMs - timed.startMs;
  const explicitMs = actions.reduce(
    (sum, action) => sum + (action.durationFrames ? (action.durationFrames / fps) * 1000 : 0),
    0,
  );
  const implicitCount = actions.filter((action) => !action.durationFrames).length;
  if (explicitMs > span + 0.001) {
    throw new Error(
      `action beat "${timed.beat.id}" schedules ${Math.round(explicitMs)}ms inside a ${span}ms beat`,
    );
  }
  const implicitMs = implicitCount ? (span - explicitMs) / implicitCount : 0;
  if (implicitCount && implicitMs <= 0) {
    throw new Error(`action beat "${timed.beat.id}" leaves no time for ${implicitCount} action(s)`);
  }

  let cursor = timed.startMs;
  return actions.map((action, actionIndex) => {
    const duration = action.durationFrames ? (action.durationFrames / fps) * 1000 : implicitMs;
    const startMs = cursor;
    const endMs = Math.min(timed.endMs, cursor + duration);
    cursor = endMs;
    return { action, actionIndex, startMs, endMs };
  });
}

function clonePropState(state: PropContinuityState): PropContinuityState {
  return { ...state };
}

function propAtState(prop: ResolvedSetProp, state: PropContinuityState): ResolvedSetProp {
  return { ...prop, x: state.x, y: state.y };
}

function rigPointWorld(
  actor: ActorRt,
  state: StageState,
  point: readonly [number, number],
): { x: number; y: number } {
  const scale = scaledForDepth(actor, state);
  const direction = state.flip ? -1 : 1;
  return {
    x: state.x + (point[0] - actor.rig.anchor[0]) * scale * direction,
    y: state.y + (point[1] - actor.rig.anchor[1]) * scale,
  };
}

function armParts(actor: ActorRt, hand: 'left' | 'right', context: string) {
  const suffix = hand === 'right' ? 'R' : 'L';
  const upper = actor.rig.parts.find((part) => part.id === `arm_${suffix}_upper`);
  const fore = actor.rig.parts.find((part) => part.id === `arm_${suffix}_fore`);
  if (!upper || !fore) {
    throw new Error(
      `${context} needs ${hand} arm rig channels arm_${suffix}_upper and arm_${suffix}_fore on "${actor.id}"`,
    );
  }
  return { suffix, upper, fore };
}

function handForPoint(
  actor: ActorRt,
  state: StageState,
  point: { x: number; y: number },
): 'left' | 'right' {
  const scale = scaledForDepth(actor, state);
  const direction = state.flip ? -1 : 1;
  const localX = actor.rig.anchor[0] + ((point.x - state.x) / Math.max(0.001, scale)) * direction;
  return localX >= actor.rig.canvas.width / 2 ? 'right' : 'left';
}

function validateReach(
  actor: ActorRt,
  state: StageState,
  hand: 'left' | 'right',
  point: { x: number; y: number },
  radius: number,
  context: string,
): void {
  const { upper, fore } = armParts(actor, hand, context);
  const shoulder = rigPointWorld(actor, state, upper.pivot);
  const scale = scaledForDepth(actor, state);
  // Rigs do not yet declare wrist endpoints, so use the authored shoulder to
  // elbow length for both segments and allow bounded forearm extension.
  const upperLength = Math.max(1, Math.hypot(
    fore.pivot[0] - upper.pivot[0],
    fore.pivot[1] - upper.pivot[1],
  ));
  const maxReach = (upperLength + upperLength * 1.08 * 1.6 + radius) * scale;
  const distance = Math.hypot(point.x - shoulder.x, point.y - shoulder.y);
  if (distance > maxReach + 1e-6) {
    throw new Error(
      `${context} target is out of reach for "${actor.id}" (${Math.round(distance)} > ${Math.round(maxReach)} set units); move the actor or prop closer`,
    );
  }
}

function seatedRigAnchor(actor: ActorRt, context: string): { x: number; y: number } {
  const torso = actor.rig.parts.find((part) => part.id === 'torso');
  if (!torso) throw new Error(`${context} needs torso rig geometry to align the performer with a seat`);
  const authored = actor.poses.get('SIT')?.parts['torso'];
  const fallback: { x?: number; y?: number } = CHAIR_SEATED_PARTS.torso;
  return {
    x: torso.pivot[0] + (authored?.x ?? fallback.x ?? 0),
    y: torso.pivot[1] + (authored?.y ?? fallback.y ?? 0),
  };
}

/** Place the rig's seated hip anchor on the catalogue seat point. */
function stateAtSeat(
  actor: ActorRt,
  state: StageState,
  point: { x: number; y: number },
  set: SetDescriptor,
  context: string,
): StageState {
  const local = seatedRigAnchor(actor, context);
  const scale = scaledForDepth(actor, state);
  const direction = state.flip ? -1 : 1;
  const next = {
    ...state,
    x: point.x - (local.x - actor.rig.anchor[0]) * scale * direction,
    y: point.y - (local.y - actor.rig.anchor[1]) * scale,
    pose: 'SIT',
  };
  const area = set.layout.walkable;
  // The root is a foot anchor, while an upstage chair can sit just above the
  // authored walkable band.  Allow a small rig-relative perspective margin;
  // the seat handle itself has already been validated against set geometry.
  const tolerance = Math.max(2, actor.rig.canvas.height * scale * 0.06);
  if (
    next.x < area.x - tolerance || next.x > area.x + area.width + tolerance ||
    next.y < area.y - tolerance || next.y > area.y + area.height + tolerance
  ) {
    throw new Error(
      `${context} aligns "${actor.id}" outside the set walkable area at ` +
      `${Math.round(next.x)},${Math.round(next.y)}; move or rescale the seat`,
    );
  }
  return next;
}

function placementFor(
  action: Extract<StageAction, { type: 'put_down' }>,
  actor: ActorRt,
  state: StageState,
  shots: ShotList,
  set: SetDescriptor,
  resolvedProps: ResolvedSetProp[],
  context: string,
): { x: number; y: number } {
  if (action.target) {
    const surface = resolvePropReference(action.target, resolvedProps, context);
    if (surface.id === state.heldPropId) {
      throw new Error(`${context} cannot place "${surface.id}" on itself`);
    }
    const handle = interactionHandle(surface, 'placement', context);
    return propHandlePoint(surface, handle);
  }
  if (action.to?.depth !== undefined) {
    throw new Error(`${context} cannot use depth for prop placement; author x/y or a mark`);
  }
  const scale = scaledForDepth(actor, state);
  const side = state.heldHand === 'left' ? -1 : 1;
  const screenSide = state.flip ? -side : side;
  const fallbackX = state.x + screenSide * 68 * scale;
  const fallbackY = geometryFor(set.layout).horizonY;
  const x = action.to?.x ?? (action.to?.mark ? shots.width * MARKS[action.to.mark] : fallbackX);
  const y = action.to?.y ?? fallbackY;
  if (x < 0 || x > shots.width || y < 0 || y > shots.height) {
    throw new Error(`${context} placement ${Math.round(x)},${Math.round(y)} is outside the ${shots.width}x${shots.height} stage`);
  }
  return { x, y };
}

function contactKind(type: 'pick_up' | 'put_down' | 'tap'): CompiledStageContact['kind'] {
  if (type === 'pick_up') return 'grasp';
  if (type === 'put_down') return 'release';
  return 'tap';
}

interface StageBuild {
  actions: CompiledStageAction[];
  props: PropRt[];
}

/**
 * Resolve ordered action beats into persistent per-actor state changes once.
 *
 * The frame loop only samples these transitions; it never interprets prose or
 * mutates state by call order, which keeps seeking and parallel rendering safe.
 */
function buildStageTransitions(
  actors: ActorRt[],
  shots: ShotList,
  timeline: TimedBeat[],
  set: SetDescriptor | null,
): StageBuild {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const current = new Map(actors.map((actor) => [actor.id, cloneStage(actor.initialStage)]));
  const compiled: CompiledStageAction[] = [];
  const resolvedProps = set ? resolveSetProps(set) : [];
  const standingPlacements = new Map<string, Pick<StageState, 'y' | 'depth' | 'pose'>>();
  const seatOccupants = new Map<string, string>();
  const propCurrent = new Map<string, PropContinuityState>();
  const propRuntime = new Map<string, PropRt>();
  for (const prop of resolvedProps) {
    const initial = { location: 'set' as const, x: prop.x, y: prop.y, holder: null };
    propCurrent.set(prop.id, initial);
    propRuntime.set(prop.id, { prop, initial: clonePropState(initial), transitions: [] });
  }

  for (const actor of actors) {
    const reference = actor.initialStage.seatedOn;
    if (actor.initialStage.pose === 'SIT' && !reference) {
      throw new Error(`initial SIT pose for "${actor.id}" needs an initial seat target`);
    }
    if (actor.initialStage.pose !== 'SIT' && reference) {
      throw new Error(`initial seat "${reference}" for "${actor.id}" requires pose SIT`);
    }
    if (!reference) continue;
    if (!set) throw new Error(`initial seat "${reference}" for "${actor.id}" requires an active set descriptor`);
    const context = `initial seat for "${actor.id}"`;
    const seat = resolvePropReference(reference, resolvedProps, context);
    if (!seat.stableId) throw new Error(`${context} needs a stable set-instance id`);
    if (seat.layer === 'fore') {
      throw new Error(`${context} targets foreground seat "${seat.id}"; use a mid-layer seat so the actor is not occluded`);
    }
    const occupiedBy = seatOccupants.get(seat.id);
    if (occupiedBy) throw new Error(`${context} targets seat "${seat.id}" already occupied by "${occupiedBy}"`);
    const handle = interactionHandle(seat, 'seat', context);
    const point = propHandlePoint(seat, handle);
    standingPlacements.set(actor.id, {
      y: actor.initialStage.y,
      depth: actor.initialStage.depth,
      pose: 'IDLE',
    });
    actor.initialStage = {
      ...stateAtSeat(actor, actor.initialStage, point, set, context),
      seatedOn: seat.id,
    };
    current.set(actor.id, cloneStage(actor.initialStage));
    seatOccupants.set(seat.id, actor.id);
  }

  const initiallyHeld = new Set<string>();
  for (const actor of actors) {
    const reference = actor.initialStage.heldPropId;
    if (!reference) continue;
    if (!set) throw new Error(`initial held prop "${reference}" for "${actor.id}" requires an active set descriptor`);
    const prop = resolvePropReference(reference, resolvedProps, `initial held prop for "${actor.id}"`);
    if (!prop.stableId) {
      throw new Error(`initial held prop "${reference}" for "${actor.id}" needs a stable set-instance id`);
    }
    if (!prop.interaction?.portable) {
      throw new Error(`initial held prop "${prop.id}" (${prop.prop}) for "${actor.id}" is not portable`);
    }
    if (initiallyHeld.has(prop.id)) {
      throw new Error(`initial held prop "${prop.id}" is assigned to more than one actor`);
    }
    if (!actor.initialStage.heldHand) {
      throw new Error(`initial held prop "${prop.id}" for "${actor.id}" needs a hand`);
    }
    interactionHandle(prop, 'grip', `initial held prop for "${actor.id}"`);
    initiallyHeld.add(prop.id);
    actor.initialStage = { ...actor.initialStage, heldPropId: prop.id };
    current.set(actor.id, cloneStage(actor.initialStage));
    const initial: PropContinuityState = {
      location: 'held',
      x: prop.x,
      y: prop.y,
      holder: actor.id,
    };
    propCurrent.set(prop.id, initial);
    propRuntime.get(prop.id)!.initial = clonePropState(initial);
  }

  for (const actor of actors) {
    actor.stageTransitions = [];
    if (actor.initialStage.pose !== 'SIT' && !actor.poses.has(actor.initialStage.pose)) {
      throw new Error(`rig "${actor.rig.name}" has no initial pose "${actor.initialStage.pose}"`);
    }
  }

  for (const timed of timeline) {
    const beat = timed.beat;
    if (beat.kind === 'line') {
      if (current.get(beat.speaker)?.visible === false) {
        throw new Error(`beat "${beat.id}" is spoken by hidden actor "${beat.speaker}"`);
      }
      continue;
    }
    if (beat.kind !== 'action') continue;

    if (beat.unsupported.length) {
      throw new Error(
        `action beat "${beat.id}" is unsupported: ${beat.unsupported.join('; ')}`,
      );
    }
    if (!beat.stage.length) {
      throw new Error(
        `action beat "${beat.id}" has prose but no structured stage action: ${beat.text}`,
      );
    }

    for (const window of actionWindows(timed, shots.fps)) {
      const action = window.action;
      if (!SUPPORTED_STAGE_ACTION_SET.has(action.type)) {
        throw new Error(
          `action beat "${beat.id}" uses ${action.type.toUpperCase()}, which is understood but not renderable yet`,
        );
      }

      const actor = byId.get(action.actor);
      if (!actor) {
        throw new Error(`action beat "${beat.id}" references unknown actor "${action.actor}"`);
      }
      const state = current.get(actor.id)!;
      if (action.type === 'enter' && state.visible) {
        throw new Error(`action beat "${beat.id}" enters "${actor.id}" while already visible`);
      }
      if (action.type === 'exit' && !state.visible) {
        throw new Error(`action beat "${beat.id}" exits "${actor.id}" while already hidden`);
      }
      if (action.type !== 'enter' && !state.visible) {
        throw new Error(`action beat "${beat.id}" makes hidden actor "${actor.id}" perform ${action.type}`);
      }
      if ((action.type === 'look' || action.type === 'turn') && !action.target && !action.direction) {
        throw new Error(`action beat "${beat.id}" ${action.type.toUpperCase()} needs a target or direction`);
      }
      if ((action.type === 'look' || action.type === 'turn') && action.target && !byId.has(action.target)) {
        throw new Error(
          `action beat "${beat.id}" ${action.type.toUpperCase()} targets unknown actor "${action.target}"`,
        );
      }
      if ((action.type === 'move' || action.type === 'exit') && state.pose === 'SIT') {
        throw new Error(
          `action beat "${beat.id}" makes seated actor "${actor.id}" ${action.type}; add STAND first`,
        );
      }
      if (action.type === 'sit' && state.pose === 'SIT') {
        throw new Error(`action beat "${beat.id}" makes "${actor.id}" sit while already seated`);
      }
      if (action.type === 'stand' && state.pose !== 'SIT') {
        throw new Error(`action beat "${beat.id}" makes "${actor.id}" stand while not seated`);
      }

      let before = cloneStage(state);
      let after = cloneStage(state);
      let stateChangeProgress = 0.5;
      let interaction: StageInteraction | undefined;
      const context = `action beat "${beat.id}" ${action.type.toUpperCase()}`;
      switch (action.type) {
        case 'enter': {
          after = placeAt(after, action.to, shots);
          before = offstageState(actor, { ...after, visible: false }, shots, action.from);
          before.visible = false;
          after.visible = true;
          break;
        }
        case 'exit':
          after = offstageState(actor, after, shots, action.to);
          after.visible = false;
          break;
        case 'move':
          after = placeAt(after, action.to, shots);
          break;
        case 'sit': {
          if (action.seat && action.floor) {
            throw new Error(`${context} cannot target a seat and the floor at the same time`);
          }
          if (action.seat) {
            if (!set) throw new Error(`${context} targets seat "${action.seat}" but has no active set descriptor`);
            const seat = resolvePropReference(action.seat, resolvedProps, context);
            if (seat.layer === 'fore') {
              throw new Error(`${context} targets foreground seat "${seat.id}"; use a mid-layer seat so the actor is not occluded`);
            }
            const occupiedBy = seatOccupants.get(seat.id);
            if (occupiedBy) throw new Error(`${context} targets seat "${seat.id}" already occupied by "${occupiedBy}"`);
            const handle = interactionHandle(seat, 'seat', context);
            const point = propHandlePoint(seat, handle);
            const seated = stateAtSeat(actor, after, point, set, context);
            const maxApproach = actor.rig.canvas.width * scaledForDepth(actor, state) * 0.12;
            const approach = Math.hypot(seated.x - state.x, seated.y - state.y);
            if (approach > maxApproach) {
              throw new Error(
                `${context} seat "${seat.id}" is too far from "${actor.id}" ` +
                `(${Math.round(approach)} > ${Math.round(maxApproach)}); MOVE closer first`,
              );
            }
            standingPlacements.set(actor.id, { y: state.y, depth: state.depth, pose: state.pose });
            after = { ...seated, seatedOn: seat.id };
            seatOccupants.set(seat.id, actor.id);
            stateChangeProgress = 0.62;
            break;
          }
          const availableSeats = resolvedProps.filter((prop) =>
            prop.interaction?.handles.some((handle) => handle.kind === 'seat'),
          );
          if (!action.floor) {
            const candidates = availableSeats.length
              ? ` Available seats: ${availableSeats.map((prop) => prop.id).join(', ')}.`
              : '';
            throw new Error(
              `${context} needs an explicit seat target or floor=true for intentional floor-seating.${candidates}`,
            );
          }
          standingPlacements.set(actor.id, { y: state.y, depth: state.depth, pose: state.pose });
          after.pose = 'SIT';
          after.seatedOn = null;
          stateChangeProgress = 0.62;
          break;
        }
        case 'stand': {
          const standing = standingPlacements.get(actor.id);
          after.pose = standing?.pose ?? 'IDLE';
          // A performer standing from a real chair is now at the chair's stage
          // depth.  Restoring the pre-sit foreground Y made them pop downward
          // before every subsequent move.  Floor sits do restore their original
          // placement because they never changed physical location.
          if (standing && !state.seatedOn) {
            after.y = standing.y;
            after.depth = standing.depth;
          }
          standingPlacements.delete(actor.id);
          if (state.seatedOn) seatOccupants.delete(state.seatedOn);
          after.seatedOn = null;
          stateChangeProgress = 0.32;
          break;
        }
        case 'look':
          after.lookTarget = action.target ?? null;
          after.lookDirection = action.direction ?? null;
          break;
        case 'turn':
          after.turnTarget = action.target ?? null;
          after.turnDirection = action.direction ?? null;
          after.lookTarget = action.target ?? null;
          after.lookDirection = action.direction ?? null;
          if (action.direction === 'left') after.flip = true;
          if (action.direction === 'right' || action.direction === 'front') after.flip = false;
          break;
        case 'reach':
        case 'tap': {
          if (!set) throw new Error(`${context} requires an active set descriptor`);
          const prop = resolvePropReference(action.target, resolvedProps, context);
          const continuity = propCurrent.get(prop.id)!;
          if (continuity.location === 'held') {
            throw new Error(`${context} targets prop "${prop.id}" while it is held by "${continuity.holder}"`);
          }
          const handle = interactionHandle(prop, 'contact', context);
          const point = propHandlePoint(propAtState(prop, continuity), handle);
          let hand = handForPoint(actor, state, point);
          if (state.heldHand === hand) hand = hand === 'right' ? 'left' : 'right';
          validateReach(actor, state, hand, point, handle.radius, context);
          const count = action.type === 'tap' ? action.count : 1;
          const contactProgresses = action.type === 'tap'
            ? Array.from({ length: count }, (_, index) => (index + 0.5) / count)
            : [0.5];
          interaction = { prop, handle, hand, point, contactProgresses };
          break;
        }
        case 'pick_up': {
          if (!set) throw new Error(`${context} requires an active set descriptor`);
          if (state.heldPropId) {
            throw new Error(`${context} cannot pick up a second prop while "${actor.id}" holds "${state.heldPropId}"`);
          }
          const prop = resolvePropReference(action.prop, resolvedProps, context);
          if (!prop.interaction?.portable) {
            throw new Error(`${context} targets "${prop.id}" (${prop.prop}), which is not portable`);
          }
          const continuity = propCurrent.get(prop.id)!;
          if (continuity.location === 'held') {
            throw new Error(`${context} targets prop "${prop.id}" already held by "${continuity.holder}"`);
          }
          const handle = interactionHandle(prop, 'grip', context);
          const point = propHandlePoint(propAtState(prop, continuity), handle);
          const hand = handForPoint(actor, state, point);
          validateReach(actor, state, hand, point, handle.radius, context);
          stateChangeProgress = 0.55;
          interaction = { prop, handle, hand, point, contactProgresses: [stateChangeProgress] };
          after.heldPropId = prop.id;
          after.heldHand = hand;
          const propAfter: PropContinuityState = {
            location: 'held',
            x: continuity.x,
            y: continuity.y,
            holder: actor.id,
          };
          propRuntime.get(prop.id)!.transitions.push({
            type: 'pick_up',
            actor: actor.id,
            startMs: window.startMs,
            endMs: window.endMs,
            contactProgress: stateChangeProgress,
            before: clonePropState(continuity),
            after: clonePropState(propAfter),
            interaction,
          });
          propCurrent.set(prop.id, propAfter);
          break;
        }
        case 'put_down': {
          if (!set) throw new Error(`${context} requires an active set descriptor`);
          if (!state.heldPropId || !state.heldHand) {
            throw new Error(`${context} cannot put down "${action.prop}" because "${actor.id}" is not holding a prop`);
          }
          const held = resolvedProps.find((prop) => prop.id === state.heldPropId);
          if (!held) throw new Error(`${context} has invalid held-prop continuity for "${state.heldPropId}"`);
          if (!propHasReference(held, action.prop)) {
            throw new Error(
              `${context} names "${action.prop}", but "${actor.id}" is holding "${held.id}" (${held.prop})`,
            );
          }
          const continuity = propCurrent.get(held.id)!;
          if (continuity.location !== 'held' || continuity.holder !== actor.id) {
            throw new Error(`${context} has invalid pickup/putdown continuity for prop "${held.id}"`);
          }
          const placement = placementFor(action, actor, state, shots, set, resolvedProps, context);
          const handle = interactionHandle(held, 'grip', context);
          const placedProp = { ...held, x: placement.x, y: placement.y };
          const point = propHandlePoint(placedProp, handle);
          const hand = state.heldHand;
          validateReach(actor, state, hand, point, handle.radius, context);
          stateChangeProgress = 0.72;
          interaction = {
            prop: held,
            handle,
            hand,
            point,
            placement,
            contactProgresses: [stateChangeProgress],
          };
          after.heldPropId = null;
          after.heldHand = null;
          const propAfter: PropContinuityState = {
            location: 'world',
            x: placement.x,
            y: placement.y,
            holder: null,
          };
          propRuntime.get(held.id)!.transitions.push({
            type: 'put_down',
            actor: actor.id,
            startMs: window.startMs,
            endMs: window.endMs,
            contactProgress: stateChangeProgress,
            before: clonePropState(continuity),
            after: clonePropState(propAfter),
            interaction,
          });
          propCurrent.set(held.id, propAfter);
          break;
        }
        default:
          // The capability preflight above makes this branch unreachable, but
          // retaining it prevents a future schema action from becoming a hold.
          throw new Error('stage action has no compiler implementation');
      }

      actor.stageTransitions.push({
        action,
        type: action.type,
        startMs: window.startMs,
        endMs: window.endMs,
        before,
        after,
        stateChangeProgress,
        interaction,
      });
      const actionId = `${beat.id ?? `beat-${timed.index}`}:stage:${window.actionIndex}`;
      const contactSpan = window.endMs - window.startMs;
      const contactActionType = action.type === 'pick_up' || action.type === 'put_down' || action.type === 'tap'
        ? action.type
        : null;
      const contacts: CompiledStageContact[] = interaction && contactActionType
        ? interaction.contactProgresses.map((progress, index) => ({
            id: `${actionId}:contact:${index}`,
            kind: contactKind(contactActionType),
            actor: actor.id,
            hand: interaction.hand,
            atMs: window.startMs + contactSpan * progress,
            ordinal: index + 1,
            total: interaction.contactProgresses.length,
            target: {
              kind: 'prop' as const,
              id: interaction.prop.id,
              prop: interaction.prop.prop,
              handle: interaction.handle.id,
            },
            point: { ...interaction.point },
          }))
        : [];
      compiled.push({
        id: actionId,
        beatId: beat.id ?? `beat-${timed.index}`,
        beatIndex: timed.index,
        actionIndex: window.actionIndex,
        type: action.type,
        actor: actor.id,
        startMs: window.startMs,
        endMs: window.endMs,
        before: cloneStage(before),
        after: cloneStage(after),
        contacts,
      });
      current.set(actor.id, cloneStage(after));
    }
  }
  const used = new Set(compiled.flatMap((action) => action.contacts.map((contact) => contact.target.id)));
  return {
    actions: compiled,
    props: [...propRuntime.values()].filter((runtime) => used.has(runtime.prop.id)),
  };
}

function ease(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function stageStateAt(actor: ActorRt, ms: number): StageState {
  let state = cloneStage(actor.initialStage);
  for (const transition of actor.stageTransitions) {
    if (ms < transition.startMs) break;
    if (ms >= transition.endMs) {
      state = cloneStage(transition.after);
      continue;
    }

    const span = Math.max(0.001, transition.endMs - transition.startMs);
    const rawProgress = Math.max(0, Math.min(1, (ms - transition.startMs) / span));
    const progress = ease(rawProgress);
    if (transition.type === 'enter' || transition.type === 'exit' || transition.type === 'move') {
      return {
        ...transition.before,
        visible: transition.type === 'enter'
          ? progress > 0
          : transition.type === 'exit'
            ? progress < 1
            : transition.before.visible,
        x: transition.before.x + (transition.after.x - transition.before.x) * progress,
        y: transition.before.y + (transition.after.y - transition.before.y) * progress,
        depth: transition.before.depth + (transition.after.depth - transition.before.depth) * progress,
      };
    }
    if (transition.type === 'sit') {
      // Move to the chair during the preparation, then let the pose blend lower
      // the body onto the cushion.  Keeping these phases distinct avoids the
      // old single-frame root teleport and crossed-leg silhouette.
      const approach = ease(Math.min(1, rawProgress / 0.38));
      return {
        ...transition.before,
        x: transition.before.x + (transition.after.x - transition.before.x) * approach,
        y: transition.before.y + (transition.after.y - transition.before.y) * approach,
        depth: transition.before.depth + (transition.after.depth - transition.before.depth) * approach,
      };
    }
    if (transition.type === 'stand') {
      // The part-pose blend performs the rise.  Root placement remains fixed at
      // the chair until the actor is fully standing and a later MOVE begins.
      return cloneStage(transition.before);
    }
    return rawProgress < transition.stateChangeProgress
      ? cloneStage(transition.before)
      : cloneStage(transition.after);
  }
  return state;
}

interface ActorPlacement {
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  visible: boolean;
}

function pointFromPlacement(
  actor: ActorRt,
  placement: ActorPlacement,
  point: readonly [number, number],
): { x: number; y: number } {
  const direction = placement.flip ? -1 : 1;
  return {
    x: placement.x + (point[0] - actor.rig.anchor[0]) * placement.scale * direction,
    y: placement.y + (point[1] - actor.rig.anchor[1]) * placement.scale,
  };
}

function pointToRig(
  actor: ActorRt,
  placement: ActorPlacement,
  point: { x: number; y: number },
): { x: number; y: number } {
  const direction = placement.flip ? -1 : 1;
  return {
    x: actor.rig.anchor[0] + ((point.x - placement.x) / Math.max(0.001, placement.scale)) * direction,
    y: actor.rig.anchor[1] + (point.y - placement.y) / Math.max(0.001, placement.scale),
  };
}

function restHandLocal(actor: ActorRt, hand: 'left' | 'right'): [number, number] {
  const { upper, fore } = armParts(actor, hand, `actor "${actor.id}" interaction pose`);
  const dx = fore.pivot[0] - upper.pivot[0];
  const dy = fore.pivot[1] - upper.pivot[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  return [fore.pivot[0] + (dx / length) * length, fore.pivot[1] + (dy / length) * length];
}

function carryHandLocal(actor: ActorRt, hand: 'left' | 'right'): [number, number] {
  const side = hand === 'right' ? 1 : -1;
  return [
    actor.rig.anchor[0] + side * actor.rig.canvas.width * 0.24,
    actor.rig.anchor[1] - actor.rig.canvas.height * 0.39,
  ];
}

function restHandWorld(actor: ActorRt, placement: ActorPlacement, hand: 'left' | 'right') {
  return pointFromPlacement(actor, placement, restHandLocal(actor, hand));
}

function carryHandWorld(actor: ActorRt, placement: ActorPlacement, hand: 'left' | 'right') {
  return pointFromPlacement(actor, placement, carryHandLocal(actor, hand));
}

function lerpPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  amount: number,
): { x: number; y: number } {
  const t = ease(amount);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function actionHandWorld(
  actor: ActorRt,
  placement: ActorPlacement,
  transition: StageTransition,
  ms: number,
): { x: number; y: number } {
  const interaction = transition.interaction!;
  const span = Math.max(0.001, transition.endMs - transition.startMs);
  const progress = Math.max(0, Math.min(1, (ms - transition.startMs) / span));
  const rest = restHandWorld(actor, placement, interaction.hand);
  const carry = carryHandWorld(actor, placement, interaction.hand);
  const target = interaction.point;

  switch (transition.type) {
    case 'pick_up': {
      const contact = interaction.contactProgresses[0]!;
      return progress <= contact
        ? lerpPoint(rest, target, progress / contact)
        : lerpPoint(target, carry, (progress - contact) / (1 - contact));
    }
    case 'put_down': {
      const contact = interaction.contactProgresses[0]!;
      return progress <= contact
        ? lerpPoint(carry, target, progress / contact)
        : lerpPoint(target, rest, (progress - contact) / (1 - contact));
    }
    case 'tap': {
      const count = interaction.contactProgresses.length;
      const phase = (progress * count) % 1;
      const pulse = progress >= 1 ? 0 : 1 - Math.abs(phase * 2 - 1);
      return lerpPoint(rest, target, pulse);
    }
    case 'reach':
    default: {
      const pulse = 1 - Math.abs(progress * 2 - 1);
      return lerpPoint(rest, target, pulse);
    }
  }
}

function activeInteraction(actor: ActorRt, ms: number): StageTransition | null {
  return actor.stageTransitions.find((transition) => (
    transition.interaction && ms >= transition.startMs && ms < transition.endMs
  )) ?? null;
}

function posePartsFor(
  actor: ActorRt,
  poseName: string,
  seatedOn: string | null = null,
): Record<string, IRTransform> {
  const target: Record<string, IRTransform> = {};
  const pose = actor.poses.get(poseName);
  if (pose) {
    for (const [id, transform] of Object.entries(pose.parts)) {
      target[id] = add(IDENTITY, transform);
    }
    return target;
  }
  if (poseName !== 'SIT') {
    throw new Error(`rig "${actor.rig.name}" has no pose "${poseName}"`);
  }
  const idlePose = actor.poses.get('IDLE');
  if (!idlePose) throw new Error(`rig "${actor.rig.name}" needs IDLE for the SIT fallback`);
  for (const [id, transform] of Object.entries(idlePose.parts)) {
    target[id] = add(IDENTITY, transform);
  }
  const fallback = seatedOn ? CHAIR_SEATED_PARTS : FLOOR_SEATED_PARTS;
  for (const [id, transform] of Object.entries(fallback)) {
    target[id] = add(target[id] ?? IDENTITY, transform);
  }
  return target;
}

function activeSeatingPose(
  actor: ActorRt,
  ms: number,
): { parts: Record<string, IRTransform>; key: string } | null {
  const transition = actor.stageTransitions.find((candidate) => (
    (candidate.type === 'sit' || candidate.type === 'stand') &&
    ms >= candidate.startMs && ms < candidate.endMs
  ));
  if (!transition) return null;
  const span = Math.max(0.001, transition.endMs - transition.startMs);
  const raw = Math.max(0, Math.min(1, (ms - transition.startMs) / span));
  const blend = transition.type === 'sit'
    ? ease(Math.max(0, Math.min(1, (raw - 0.38) / 0.5)))
    : ease(Math.max(0, Math.min(1, raw / 0.58)));
  const from = posePartsFor(actor, transition.before.pose, transition.before.seatedOn);
  const to = posePartsFor(actor, transition.after.pose, transition.after.seatedOn);
  const parts: Record<string, IRTransform> = {};
  const ids = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const id of ids) parts[id] = lerp(from[id] ?? IDENTITY, to[id] ?? IDENTITY, blend);
  return { parts, key: `seat-${transition.type}` };
}

function locomotionPoseAt(
  actor: ActorRt,
  state: StageState,
  ms: number,
): { parts: Record<string, Partial<PartTransform>>; key: string } | null {
  const transition = actor.stageTransitions.find((candidate) => (
    ms >= candidate.startMs && ms < candidate.endMs &&
    (candidate.type === 'enter' || candidate.type === 'exit' || candidate.type === 'move' || candidate.type === 'sit')
  ));
  if (!transition) return null;
  const span = Math.max(0.001, transition.endMs - transition.startMs);
  const raw = Math.max(0, Math.min(1, (ms - transition.startMs) / span));
  const progress = transition.type === 'sit' ? raw / 0.38 : raw;
  if (progress < 0 || progress >= 1) return null;
  const dx = transition.after.x - transition.before.x;
  const dy = transition.after.y - transition.before.y;
  if (Math.hypot(dx, dy) < 0.5) return null;
  const wave = Math.sin(progress * Math.PI * 4);
  const stride = wave * 13;
  const localDirection = Math.sign(dx || 1) * (state.flip ? -1 : 1);
  return {
    key: `walk-${transition.type}`,
    parts: {
      torso: { rot: localDirection * 2.2, y: -Math.abs(wave) * 2.5, scale: 1 },
      leg_L: { rot: stride, scale: 1 },
      leg_R: { rot: -stride, scale: 1 },
      arm_L_upper: { rot: -stride * 0.45, scale: 1 },
      arm_R_upper: { rot: stride * 0.45, scale: 1 },
    },
  };
}

function normalizedDegrees(value: number): number {
  let out = value;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

function armTransformsForPoint(
  actor: ActorRt,
  placement: ActorPlacement,
  hand: 'left' | 'right',
  worldPoint: { x: number; y: number },
): Record<string, { rot: number; scale: number }> {
  const { upper, fore } = armParts(actor, hand, `actor "${actor.id}" interaction pose`);
  const target = pointToRig(actor, placement, worldPoint);
  const shoulder = { x: upper.pivot[0], y: upper.pivot[1] };
  const baseUpper = Math.atan2(fore.pivot[1] - shoulder.y, fore.pivot[0] - shoulder.x);
  const l1 = Math.max(1, Math.hypot(fore.pivot[0] - shoulder.x, fore.pivot[1] - shoulder.y));
  const l2 = l1 * 1.08;
  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  const requested = Math.max(0.001, Math.hypot(dx, dy));
  const stretch = Math.max(1, Math.min(1.6, (requested - l1) / l2));
  const effectiveL2 = l2 * stretch;
  const distance = Math.max(Math.abs(l1 - effectiveL2) + 0.001, Math.min(requested, l1 + effectiveL2 - 0.001));
  const targetAngle = Math.atan2(dy, dx);
  const shoulderOffset = Math.acos(Math.max(-1, Math.min(1,
    (l1 * l1 + distance * distance - effectiveL2 * effectiveL2) / (2 * l1 * distance),
  )));
  const bend = hand === 'right' ? -1 : 1;
  const upperAngle = targetAngle + bend * shoulderOffset;
  const elbow = {
    x: shoulder.x + Math.cos(upperAngle) * l1,
    y: shoulder.y + Math.sin(upperAngle) * l1,
  };
  const lowerAngle = Math.atan2(target.y - elbow.y, target.x - elbow.x);
  const upperRot = normalizedDegrees((upperAngle - baseUpper) * (180 / Math.PI));
  const foreRot = normalizedDegrees((lowerAngle - baseUpper) * (180 / Math.PI) - upperRot);
  return {
    [upper.id]: { rot: upperRot, scale: 1 },
    [fore.id]: { rot: foreRot, scale: stretch },
  };
}

function interactionPoseAt(
  actor: ActorRt,
  state: StageState,
  ms: number,
): { parts: Record<string, { rot: number; scale: number }>; key: string } | null {
  const placement: ActorPlacement = {
    visible: state.visible,
    x: state.x,
    y: state.y,
    scale: scaledForDepth(actor, state),
    flip: state.flip,
  };
  const transition = activeInteraction(actor, ms);
  const hand = transition?.interaction?.hand ?? state.heldHand;
  if (!hand) return null;
  const point = transition
    ? actionHandWorld(actor, placement, transition, ms)
    : carryHandWorld(actor, placement, hand);
  const parts = armTransformsForPoint(actor, placement, hand, point);
  const key = Object.entries(parts)
    .map(([id, transform]) => `${id}:${transform.rot.toFixed(2)}:${transform.scale.toFixed(3)}`)
    .join('|');
  return { parts, key };
}

function propOriginAtHand(
  runtime: PropRt,
  hand: { x: number; y: number },
  handle: PropInteractionHandle,
): { x: number; y: number } {
  const direction = runtime.prop.flip ? -1 : 1;
  return {
    x: hand.x - handle.x * runtime.prop.scale * direction,
    y: hand.y - handle.y * runtime.prop.scale,
  };
}

function applyPartPoint(
  point: { x: number; y: number },
  pivot: readonly [number, number],
  transform: IRTransform | undefined,
): { x: number; y: number } {
  if (!transform) return point;
  const [rotation, translateX, translateY, scale] = transform;
  let x = pivot[0] + (point.x - pivot[0]) * scale;
  let y = pivot[1] + (point.y - pivot[1]) * scale;
  if (rotation) {
    const radians = rotation * (Math.PI / 180);
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    x = pivot[0] + dx * Math.cos(radians) - dy * Math.sin(radians);
    y = pivot[1] + dx * Math.sin(radians) + dy * Math.cos(radians);
  }
  return { x: x + translateX, y: y + translateY };
}

/** Resolve the same nested rig transforms the browser applies for one rig-space point. */
function renderedPartPointWorld(
  actor: ActorRt,
  placement: IRActor,
  partId: string,
  localPoint: readonly [number, number],
): { x: number; y: number } {
  const start = actor.rig.parts.find((part) => part.id === partId);
  if (!start) throw new Error(`actor "${actor.id}" is missing rig part "${partId}"`);
  const byId = new Map(actor.rig.parts.map((part) => [part.id, part]));
  let point = { x: localPoint[0], y: localPoint[1] };
  let part: typeof start | undefined = start;
  while (part) {
    point = applyPartPoint(point, part.pivot, placement.parts[part.id]);
    part = part.parent ? byId.get(part.parent) : undefined;
  }
  return pointFromPlacement(actor, placement, [point.x, point.y]);
}

/** Resolve the same nested rig transforms the browser applies, then place the wrist in set space. */
function renderedHandWorld(
  actor: ActorRt,
  placement: IRActor,
  hand: 'left' | 'right',
): { x: number; y: number } {
  const suffix = hand === 'right' ? 'R' : 'L';
  return renderedPartPointWorld(
    actor,
    placement,
    `arm_${suffix}_fore`,
    restHandLocal(actor, hand),
  );
}

function propIrState(
  runtime: PropRt,
  continuity: PropContinuityState,
  placement?: { x: number; y: number },
): IRPropState {
  return {
    visible: true,
    mode: continuity.location === 'set' ? 'set' : 'world',
    x: placement?.x ?? continuity.x,
    y: placement?.y ?? continuity.y,
    scale: runtime.prop.scale,
    flip: runtime.prop.flip,
    rotation: 0,
    heldBy: continuity.holder,
  };
}

function propStateAt(
  runtime: PropRt,
  ms: number,
  actors: Map<string, ActorRt>,
  frameActors: Record<string, IRActor>,
): IRPropState {
  let continuity = clonePropState(runtime.initial);
  for (const transition of runtime.transitions) {
    if (ms < transition.startMs) break;
    if (ms >= transition.endMs) {
      continuity = clonePropState(transition.after);
      continue;
    }
    const span = Math.max(0.001, transition.endMs - transition.startMs);
    const progress = Math.max(0, Math.min(1, (ms - transition.startMs) / span));
    if (transition.type === 'pick_up' && progress < transition.contactProgress) {
      return propIrState(runtime, transition.before);
    }
    if (transition.type === 'put_down' && progress >= transition.contactProgress) {
      return propIrState(runtime, transition.after);
    }

    const actor = actors.get(transition.actor)!;
    const placement = frameActors[transition.actor];
    if (!placement?.visible) {
      return { ...propIrState(runtime, transition.before), visible: false };
    }
    const hand = renderedHandWorld(actor, placement, transition.interaction.hand);
    const origin = propOriginAtHand(runtime, hand, transition.interaction.handle);
    return propIrState(runtime, {
      location: 'held',
      x: origin.x,
      y: origin.y,
      holder: transition.actor,
    }, origin);
  }

  if (continuity.location !== 'held' || !continuity.holder) return propIrState(runtime, continuity);
  const actor = actors.get(continuity.holder);
  const placement = frameActors[continuity.holder];
  const stage = actor ? stageStateAt(actor, ms) : null;
  if (!actor || !placement?.visible || !stage?.heldHand) {
    return { ...propIrState(runtime, continuity), visible: false };
  }
  const hand = renderedHandWorld(actor, placement, stage.heldHand);
  const handle = interactionHandle(runtime.prop, 'grip', `held prop "${runtime.prop.id}"`);
  const origin = propOriginAtHand(runtime, hand, handle);
  return propIrState(runtime, continuity, origin);
}

function scaledForDepth(actor: ActorRt, state: StageState): number {
  return actor.scale * (1 + state.depth * DEPTH_SCALE);
}

function resolvedFlip(
  state: StageState,
  states: Map<string, StageState>,
): boolean {
  if (state.turnTarget) {
    const target = states.get(state.turnTarget);
    if (target && target.x !== state.x) return target.x < state.x;
  }
  if (state.turnDirection === 'left') return true;
  if (state.turnDirection === 'right' || state.turnDirection === 'front') return false;
  return state.flip;
}

/** -1 means screen-left, +1 screen-right, 0 front, null means no explicit cue. */
function attentionDirection(state: StageState, states: Map<string, StageState>): -1 | 0 | 1 | null {
  if (state.lookTarget) {
    const target = states.get(state.lookTarget);
    if (target && target.x !== state.x) return target.x < state.x ? -1 : 1;
    return 0;
  }
  if (state.lookDirection === 'left') return -1;
  if (state.lookDirection === 'right') return 1;
  if (state.lookDirection === 'front') return 0;
  return null;
}

function actorFrameInfo(actor: ActorRt, state: IRActor): ActorFrameInfo {
  const head = renderedPartPointWorld(actor, state, 'head', actor.rig.focus);
  return {
    id: actor.id,
    x: state.x,
    y: state.y,
    scale: state.scale,
    headX: head.x,
    headY: head.y,
    headR: (faceBox(actor.rig).h / 2) * state.scale,
  };
}

const UNSTRESSED_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'he', 'i', 'in', 'is',
  'it', 'of', 'on', 'or', 'she', 'so', 'that', 'the', 'their', 'they', 'this', 'to', 'was', 'we',
  'were', 'with', 'you', 'your',
]);

function wordAccentScore(word: WordTiming): number {
  const normalized = word.text.toLowerCase().replace(/[^a-z0-9']/g, '');
  return (
    Math.min(8, normalized.length) +
    (UNSTRESSED_WORDS.has(normalized) ? -6 : 0) +
    (/[!?]/.test(word.text) ? 8 : /[,;:]/.test(word.text) ? 2 : 0)
  );
}

/**
 * Select a few meaningful speech accents, never a metronomic pose toggle.
 *
 * Exact aligned words win when available; deterministic approximations feed
 * the same function in draft previews. The character's gesture bias changes
 * how many accents they use, while `talkPhase` only selects preferred hand.
 */
function talkAccents(actor: ActorRt, active: TimedBeat): Array<{ apexMs: number; pose: string }> {
  const timing = active.timing;
  if (!timing) return [];
  const speechStart = timing.speechOnsetMs ?? timing.speechStartMs ?? 0;
  const speechEnd = timing.speechEndMs ?? timing.durationMs;
  const speechSpan = Math.max(1, speechEnd - speechStart);
  let count = speechSpan >= 5_200 ? 3 : speechSpan >= 2_400 ? 2 : 1;
  if (actor.acting.gestureBias < 0.8) count = Math.max(1, count - 1);
  if (actor.acting.gestureBias > 1.25 && speechSpan >= 1_600) count = Math.min(3, count + 1);

  const words = timing.words ?? timing.alignment?.words ?? [];
  const candidates = words.length
    ? words.map((word, index) => ({
        index,
        apexMs: (word.startMs + word.endMs) / 2,
        score: wordAccentScore(word),
      }))
    : Array.from({ length: count }, (_, index) => ({
        index,
        apexMs: speechStart + speechSpan * ((index + 1) / (count + 1)),
        score: 1,
      }));

  const selected: typeof candidates = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (selected.some((item) => Math.abs(item.apexMs - candidate.apexMs) < 520)) continue;
    selected.push(candidate);
    if (selected.length >= count) break;
  }
  selected.sort((a, b) => a.apexMs - b.apexMs);
  const talkPoses = ['TALK_A', 'TALK_B'].filter((pose) => actor.poses.has(pose));
  if (!talkPoses.length) return selected.map((candidate) => ({ apexMs: candidate.apexMs, pose: 'IDLE' }));

  // Phrase-level seeded choices avoid the old A/B/A/B metronome. A character
  // may keep one hand through adjacent accents, then change on a later phrase;
  // their fidget profile affects how readily that hand changes. The seed uses
  // the semantic beat index, so sampling this pure function on every frame is
  // still deterministic.
  const phraseRng = new Rng(deriveSeed(
    active.index + Math.round(actor.talkPhase * 1000),
    `talk-phrase:${actor.rig.charId ?? actor.id}`,
  ));
  let pose = phraseRng.pick(talkPoses);
  const switchChance = Math.min(0.62, 0.2 + actor.acting.fidgetAmp * 0.07);
  return selected.map((candidate, index) => {
    if (index > 0 && talkPoses.length > 1 && phraseRng.chance(switchChance)) {
      pose = talkPoses.find((candidatePose) => candidatePose !== pose) ?? pose;
    }
    return { apexMs: candidate.apexMs, pose };
  });
}

/** A speech phrase prepares, accents selected words, then recovers to rest. */
function talkPose(actor: ActorRt, active: TimedBeat, charMs: number): string {
  const localMs = charMs - active.startMs;
  const timing = active.timing;
  const speechStart = timing?.speechOnsetMs ?? timing?.speechStartMs ?? 0;
  const speechEnd = timing?.speechEndMs ?? timing?.durationMs ?? (active.endMs - active.startMs);
  if (localMs < speechStart || localMs > speechEnd) return 'IDLE';

  for (const accent of talkAccents(actor, active)) {
    // A short preparation before the word and a slightly longer recovery make
    // the apex legible without holding an arm up for the whole sentence.
    if (localMs >= accent.apexMs - 150 && localMs <= accent.apexMs + 260) return accent.pose;
  }
  return 'IDLE';
}

/**
 * Which pose a character holds this frame.
 *
 * Gestures arc rather than switch: a POINT lands at the top of the line, holds
 * at least the show's minimum, then releases back into ordinary talk-motion
 * for the rest of the line. The release time is precomputed per beat and
 * grid-quantized, so it costs held frames nothing.
 */
function speechPoseNameFor(actor: ActorRt, active: TimedBeat, charMs: number): string | null {
  const beat = active.beat;
  if (beat.kind !== 'line' || beat.speaker !== actor.id) return null;
  if (beat.gesture === 'NONE') return null;

  if (beat.gesture === 'TALK') return talkPose(actor, active, charMs);

  if (!actor.poses.has(beat.gesture)) return talkPose(actor, active, charMs);
  const timing = active.timing;
  const speechStart = active.startMs + (timing?.speechOnsetMs ?? timing?.speechStartMs ?? 0);
  const speechSpan = Math.max(1, (timing?.speechEndMs ?? timing?.durationMs ?? (active.endMs - active.startMs)) -
    (timing?.speechOnsetMs ?? timing?.speechStartMs ?? 0));
  const onset = speechStart + Math.min(240, Math.max(80, speechSpan * 0.12));
  if (charMs < onset) return 'IDLE';
  return charMs < Math.max(onset, active.releaseMs) ? beat.gesture : talkPose(actor, active, charMs);
}

export function compileShotList(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  timings: Map<number, LineTiming>,
  animationDocument: AnimationDocument | null = null,
  /** Loaded descriptor for structured prop actions; null is valid for prop-free scenes. */
  setDescriptor: SetDescriptor | null = null,
): CompiledScene {
  if (shots.fps % shots.characterFps !== 0) {
    throw new Error(
      `characterFps (${shots.characterFps}) must divide fps (${shots.fps}) evenly, ` +
        `otherwise held frames land unevenly and the motion judders`,
    );
  }

  const timeline = buildTimeline(shots, timings);
  const durationMs = timeline.reduce((max, timed) => Math.max(max, timed.endMs), 0);
  if (durationMs <= 0) throw new Error('scene has zero duration');
  const cards = cardTiming(shots);

  const actors = shots.cast.map((member) => {
    const loaded = rigs.get(member.rig);
    if (!loaded) throw new Error(`cast member "${member.id}" needs rig "${member.rig}", which is not loaded`);
    return prepareActor(shots, member, loaded);
  });
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));

  const stageBuild = buildStageTransitions(actors, shots, timeline, setDescriptor);
  const bodyStageActions = stageBuild.actions;
  const propRuntimes = stageBuild.props;
  const stageActions = bodyStageActions.map((action) => ({
    ...action,
    startMs: action.startMs + cards.titleMs,
    endMs: action.endMs + cards.titleMs,
    contacts: action.contacts.map((contact) => ({
      ...contact,
      atMs: contact.atMs + cards.titleMs,
    })),
  }));

  let authoredAnimation: ResolvedAnimation | null = null;
  let hasAuthoredPictureTracks = false;
  if (animationDocument) {
    if (animationDocument.scene !== shots.scene) {
      throw new Error(
        `animation document belongs to scene "${animationDocument.scene}", not "${shots.scene}"`,
      );
    }
    authoredAnimation = resolveAnimation(
      animationDocument,
      buildAnimationTimeline(timeline, cards.titleMs, cards.endMs),
    );
    validateAnimationTargets(authoredAnimation, actors, shots);
    hasAuthoredPictureTracks = authoredAnimation.tracks.some(
      (resolved) => resolved.layer.enabled && resolved.track.enabled,
    ) || authoredAnimation.segments.some(
      (resolved) => resolved.layer.enabled && resolved.segment.enabled,
    );
  }

  const durationSec = durationMs / 1000;
  for (const actor of actors) {
    const rng = new Rng(deriveSeed(shots.seed, `blink:${actor.rig.charId ?? actor.id}`));
    // A blink shorter than one character frame could fall between two samples
    // and silently never render, so clamp it to just over one.
    const blinkDur = Math.max(actor.rig.idle.blinkDuration, 1.001 / shots.characterFps);
    actor.blinks = scheduleBlinks(rng, durationSec, actor.rig.idle.blinkRateHz, blinkDur);

    actor.exprSegments = expressionSegments(
      timeline, actor.id, actor.resting, actor.acting, shots.characterFps);
    actor.fidgets = fidgetSchedule(
      shots.seed, actor.rig.charId ?? actor.id, durationMs, actor.acting, shots.characterFps);
  }

  const stage = { width: shots.width, height: shots.height };

  const frameCount = Math.max(1, Math.round(durationSec * shots.fps));
  const step = shots.fps / shots.characterFps;
  const frames: IRFrame[] = [];

  const beatAt = (ms: number): Timed => {
    // Authored pickups can overlap the previous beat. The most recently
    // started beat owns camera/gesture intent while the earlier voice may
    // continue speaking underneath.
    for (let i = timeline.length - 1; i >= 0; i--) {
      const timed = timeline[i]!;
      if (ms >= timed.startMs) return timed;
    }
    return timeline[0]!;
  };

  const speakingLineAt = (actorId: string, ms: number): { timed: Timed; localMs: number } | null => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const timed = timeline[i]!;
      if (timed.beat.kind !== 'line' || timed.beat.speaker !== actorId || !timed.timing) continue;
      const localMs = ms - timed.startMs;
      const onsetMs = timed.timing.speechOnsetMs ?? timed.timing.speechStartMs ?? 0;
      const endMs = timed.timing.speechEndMs ?? timed.timing.durationMs;
      if (localMs >= onsetMs && localMs < endMs) return { timed, localMs };
    }
    return null;
  };

  let cachedCharFrame = -1;
  let cachedActors: Record<string, IRActor> = {};

  for (let f = 0; f < frameCount; f++) {
    const ms = (f / shots.fps) * 1000;

    // Characters sample on the coarse grid; the camera stays on ones.
    const charFrame = Math.floor(f / step) * step;
    if (charFrame !== cachedCharFrame) {
      cachedCharFrame = charFrame;
      const charMs = (charFrame / shots.fps) * 1000;
      const charSec = charMs / 1000;
      const active = beatAt(charMs);

      const stageStates = new Map(actors.map((actor) => [actor.id, stageStateAt(actor, charMs)]));
      const stageFlips = new Map(
        actors.map((actor) => [actor.id, resolvedFlip(stageStates.get(actor.id)!, stageStates)]),
      );

      cachedActors = {};
      for (const actor of actors) {
        const actorStage = stageStates.get(actor.id)!;
        const flip = stageFlips.get(actor.id)!;
        const speechPoseName = speechPoseNameFor(actor, active, charMs);
        const exprName = valueAt(actor.exprSegments, charMs);
        const attention = attentionDirection(actorStage, stageStates);
        const interactionPose = interactionPoseAt(actor, { ...actorStage, flip }, charMs);
        const poseKey =
          `${actorStage.pose}>${speechPoseName ?? '-'}|${exprName}|` +
          `${actorStage.lookTarget ?? actorStage.lookDirection ?? '-'}:${attention ?? '-'}|` +
          `${interactionPose?.key ?? '-'}`;

        const expr = actor.expressions.get(exprName);
        if (!expr) throw new Error(`rig "${actor.rig.name}" has no expression "${exprName}"`);

        const seatingPose = activeSeatingPose(actor, charMs);
        const target: Record<string, IRTransform> = seatingPose?.parts ?? posePartsFor(
          actor,
          actorStage.pose,
          actorStage.seatedOn,
        );

        if (speechPoseName) {
          const speechPose = actor.poses.get(speechPoseName);
          if (!speechPose) throw new Error(`rig "${actor.rig.name}" has no pose "${speechPoseName}"`);
          // Preserve the historical meaning of an ordinary IDLE actor's line
          // pose: it replaces the pose. A non-IDLE stage pose (notably SIT)
          // remains underneath, with only explicitly animated parts overlaid.
          if (actorStage.pose === 'IDLE') {
            for (const id of Object.keys(target)) delete target[id];
          }
          for (const [id, transform] of Object.entries(speechPose.parts)) {
            target[id] = add(IDENTITY, transform);
          }
        }
        for (const [id, t] of Object.entries(expr.parts)) target[id] = add(target[id] ?? IDENTITY, t);

        // Structured physical action owns the active hand after the base pose,
        // speech gesture and expression have composed. The other arm remains
        // available for ordinary acting.
        if (interactionPose) {
          for (const [id, transform] of Object.entries(interactionPose.parts)) {
            target[id] = add(IDENTITY, transform);
          }
        }

        const locomotionPose = locomotionPoseAt(actor, { ...actorStage, flip }, charMs);
        if (locomotionPose) {
          for (const [id, transform] of Object.entries(locomotionPose.parts)) {
            target[id] = add(target[id] ?? IDENTITY, transform);
          }
        }

        // The small held head cant makes LOOK legible even when the rig's
        // one side-eye swap points in the opposite local direction.
        if (attention) {
          target['head'] = add(target['head'] ?? IDENTITY, { rot: attention * (flip ? -3.5 : 3.5) });
        }

        // One intermediate frame on a pose change, so the snap reads as a snap
        // rather than a teleport.
        let parts = target;
        const resolvedPoseKey = `${poseKey}|${seatingPose?.key ?? '-'}|${locomotionPose?.key ?? '-'}`;
        if (actor.lastPoseKey && actor.lastPoseKey !== resolvedPoseKey && !seatingPose) {
          parts = {};
          const keys = new Set([...Object.keys(target), ...Object.keys(actor.lastParts)]);
          for (const id of keys) {
            parts[id] = lerp(actor.lastParts[id] ?? IDENTITY, target[id] ?? IDENTITY, SNAP_BLEND);
          }
        }
        actor.lastPoseKey = resolvedPoseKey;
        actor.lastParts = target;

        const swaps = { ...actor.defaultSwaps, ...expr.swaps };

        // Mouth, driven by every audibly active speaker's viseme track. This
        // remains independent of camera ownership during pickups/overlaps.
        let openness = 0;
        const speakingLine = speakingLineAt(actor.id, charMs);
        if (speakingLine?.timed.timing) {
          const shape = mouthAt(speakingLine.timed.timing.cues, speakingLine.localMs);
          swaps['mouth'] = `mouth_${shape}`;
          openness = mouthOpenness(shape);
        }

        const idle = actor.rig.idle;
        const breath = Math.sin((charSec / idle.breathPeriod) * Math.PI * 2 + actor.breathPhase);
        const lift = -breath * idle.breathAmplitude;

        const out = { ...parts };
        out['torso'] = add(out['torso'] ?? IDENTITY, { y: lift });
        // Head counter-moves against the breath, and dips slightly on open
        // vowels — small, but it stops a talking head reading as a mannequin.
        out['head'] = add(out['head'] ?? IDENTITY, {
          y: lift * -0.35 + openness * 1.6,
          rot: breath * 0.6 + openness * 1.1,
        });

        // Listeners look at whoever is talking — after their reaction has
        // landed, when their puppet has a side-eye variant, and only when the
        // side variant's direction actually points at the speaker. Expressions
        // that own the eyes (wide, squint) win over the glance.
        const isListener = active.beat.kind === 'line' && active.beat.speaker !== actor.id;
        const eyesNow = swaps['eyes'];
        const eyesAvailable = actor.hasEyesSide && (eyesNow === 'eyes_open' || eyesNow === 'eyes_half');
        if (attention !== null) {
          if (
            attention !== 0 &&
            eyesAvailable &&
            gazeTowardSpeaker({ x: actorStage.x, flip }, actorStage.x + attention)
          ) {
            swaps['eyes'] = 'eyes_side';
          }
        } else if (isListener && eyesAvailable) {
          const speaker = stageStates.get(active.beat.kind === 'line' ? active.beat.speaker : '');
          if (speaker && gazeTowardSpeaker({ x: actorStage.x, flip }, speaker.x)) {
            swaps['eyes'] = 'eyes_side';
          }
        }

        if (actor.hasEyesClosed && !expr.suppressBlink && isBlinking(actor.blinks, charSec)) {
          swaps['eyes'] = 'eyes_closed';
        }

        // Held weight shift while not speaking. A held offset is just a
        // different held frame, so deduplication is untouched.
        const speaking = speakingLine !== null;
        const shift = speaking ? 0 : fidgetAt(actor.fidgets, charMs);
        if (shift !== 0) out['torso'] = add(out['torso'] ?? IDENTITY, { x: shift });

        cachedActors[actor.id] = {
          visible: actorStage.visible,
          x: actorStage.x,
          y: actorStage.y,
          scale: scaledForDepth(actor, actorStage),
          flip,
          parts: pruneRest(out),
          swaps,
        };
      }
    }

    const frameActors = authoredAnimation && hasAuthoredPictureTracks
      ? applyAuthoredAnimation(authoredAnimation, ms + cards.titleMs, cachedActors)
      : cachedActors;

    const camBeat = beatAt(ms);
    const span = Math.max(1, camBeat.endMs - camBeat.startMs);
    const t = Math.min(1, (ms - camBeat.startMs) / span);
    const frameInfo = actors.flatMap((actor) => {
      const state = frameActors[actor.id];
      return state?.visible ? [actorFrameInfo(actor, state)] : [];
    });
    const base = baseFrame(camBeat.beat.shot, camBeat.beat.focus, frameInfo, stage);
    const camera = applyMove(base, camBeat.beat.camera, t, f, stage);

    const propSampleMs = (Math.floor(f / step) * step / shots.fps) * 1000;
    const frameProps = propRuntimes.length
      ? Object.fromEntries(propRuntimes.map((runtime) => [
          runtime.prop.id,
          propStateAt(runtime, propSampleMs, actorsById, frameActors),
        ]))
      : undefined;

    frames.push({ camera, actors: frameActors, ...(frameProps ? { props: frameProps } : {}) });
  }

  /**
   * Cards splice AROUND the finished body.
   *
   * The body frames above were computed with time starting at the first real
   * beat, so every blink, breath phase and reaction is byte-identical whether
   * cards are on or off — the cards are packaging, not time. Audio placements
   * shift by the same title duration from the same helper, so sync is
   * arithmetic, not luck.
   */
  const fullStage = { x: 0, y: 0, w: stage.width, h: stage.height };
  const identity = activeIdentity();

  const spliced: IRFrame[] = [];
  for (let i = 0; i < cards.titleFrames; i++) spliced.push({ camera: fullStage, actors: {}, card: 'title' });
  spliced.push(...frames);
  // The smash cut: the last body frame is a normal frame; the next is card.
  for (let i = 0; i < cards.endFrames; i++) spliced.push({ camera: fullStage, actors: {}, card: 'end' });

  const cardArt = cards.titleFrames || cards.endFrames
    ? {
        titleSvg: cards.titleFrames
          ? titleCardSvg(identity, shots.title ?? shots.scene.replace(/-/g, ' '), shots.subtitle ?? undefined)
          : undefined,
        endSvg: cards.endFrames ? endCardSvg(identity) : undefined,
      }
    : undefined;

  const audio: AudioPlacement[] = timeline
    .filter((t) => t.timing)
    .map((t) => ({
      file: t.timing!.audio,
      startMs: t.startMs + cards.titleMs,
      speaker: t.beat.kind === 'line' ? t.beat.speaker : undefined,
      sourceInMs: t.timing!.sourceInMs,
      sourceOutMs: t.timing!.sourceOutMs,
      playbackDurationMs: t.timing!.playbackDurationMs,
      speechOnsetMs: t.timing!.speechOnsetMs ?? t.timing!.speechStartMs,
      speechEndMs: t.timing!.speechEndMs,
      turnGapMs: t.timing!.turnGapMs,
      pickupMs: t.timing!.pickupMs,
      pauseAfterMs: t.timing!.pauseAfterMs,
      overlapMs: t.timing!.overlapMs,
      overlapMode: t.timing!.overlapMode,
      overlapWithCueId: t.timing!.overlapWithCueId,
      interruptAtMs: t.timing!.interruptAtMs,
      editorialTiming: t.timing!.editorialTiming,
      cueId: t.timing!.cueId,
      selectionKey: t.timing!.selectionKey,
      timingKey: t.timing!.timingKey,
    }));

  const captions: CompiledCaptionCue[] = timeline.flatMap((timed) => {
    if (timed.beat.kind !== 'line' || !timed.timing) return [];
    const onsetMs = timed.timing.speechOnsetMs ?? timed.timing.speechStartMs ?? 0;
    const speechEndMs = timed.timing.speechEndMs ?? timed.timing.durationMs;
    const startMs = timed.startMs + onsetMs + cards.titleMs;
    const endMs = timed.startMs + speechEndMs + cards.titleMs;
    if (endMs <= startMs) return [];
    return [{
      id: timed.beat.id ?? `line-${timed.index}`,
      speaker: timed.beat.speaker,
      text: timed.beat.text,
      startMs,
      endMs,
    }];
  });

  return {
    ir: {
      meta: {
        scene: shots.scene,
        fps: shots.fps,
        width: shots.width,
        height: shots.height,
        seed: shots.seed,
        audio: 'dialogue.wav',
        set: shots.set,
        cards: cardArt,
      },
      cast: shots.cast.map((c) => ({ id: c.id, rig: c.rig })),
      ...(propRuntimes.length
        ? { props: propRuntimes.map((runtime) => ({ id: runtime.prop.id, prop: runtime.prop.prop })) }
        : {}),
      frames: spliced,
    },
    audio,
    captions,
    stageActions,
    durationMs: durationMs + cards.titleMs + cards.endMs,
    beatStarts: timeline.map((t) => t.startMs + cards.titleMs),
  };
}
