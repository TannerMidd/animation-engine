import { Rng, deriveSeed } from '../core/rng.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { Rig, Pose, Expression, SceneIR, IRFrame, IRActor, IRTransform } from '../schema/index.ts';
import { MARKS, type ShotList, type ShotBeat } from '../schema/script.ts';
import { baseFrame, applyMove, type ActorFrameInfo } from '../render/framing.ts';
import { faceBox } from '../cast/placeholder.ts';
import { mouthAt, type LineTiming } from '../voice/visemes.ts';
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

interface Timed {
  beat: ShotBeat;
  index: number;
  startMs: number;
  endMs: number;
  timing?: LineTiming;
}

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
  /** Previous character-frame's resolved parts, for the snap frame. */
  lastParts: Record<string, IRTransform>;
  lastPoseKey: string;
}

export interface AudioPlacement {
  file: string;
  startMs: number;
}

export interface CompiledScene {
  ir: SceneIR;
  audio: AudioPlacement[];
  durationMs: number;
}

function buildTimeline(shots: ShotList, timings: Map<number, LineTiming>): Timed[] {
  const out: Timed[] = [];
  let cursor = 0;

  shots.beats.forEach((beat, index) => {
    let ms: number;
    let timing: LineTiming | undefined;

    if (beat.kind === 'line') {
      timing = timings.get(index);
      if (!timing) throw new Error(`beat ${index} is a line but has no audio timing`);
      ms = timing.durationMs + LINE_TAIL_MS;
    } else {
      ms = beat.ms;
    }

    out.push({ beat, index, startMs: cursor, endMs: cursor + ms, timing });
    cursor += ms;
  });

  return out;
}

function prepareActor(shots: ShotList, member: ShotList['cast'][number], loaded: LoadedRig): ActorRt {
  const rig = loaded.rig;
  // Streams key off the rig's stable id when it has one, so renaming a
  // character — in the script and on disk — does not reshuffle their breathing
  // phase or anything else seeded here. The scene-local id is only the
  // fallback for ephemeral placeholders that were never saved.
  const rng = new Rng(deriveSeed(shots.seed, `actor:${rig.charId ?? member.id}`));

  const x = shots.width * MARKS[member.mark];
  const y = shots.height * 0.97;
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
    lastParts: {},
    lastPoseKey: '',
  };
}

/** Which pose a character holds this frame. */
function poseNameFor(actor: ActorRt, beat: ShotBeat, msIntoBeat: number): string {
  if (beat.kind !== 'line' || beat.speaker !== actor.id) return 'IDLE';
  if (beat.gesture === 'NONE') return 'IDLE';
  if (beat.gesture !== 'TALK') return beat.gesture;

  // Alternate hands while talking, offset per actor so two people gesturing at
  // once don't move in lockstep.
  const n = Math.floor((msIntoBeat + actor.talkPhase) / TALK_SWAP_MS);
  const name = n % 2 === 0 ? 'TALK_A' : 'TALK_B';
  return actor.poses.has(name) ? name : 'IDLE';
}

function expressionNameFor(actor: ActorRt, beat: ShotBeat): string {
  if (beat.kind === 'line' && beat.speaker === actor.id) return beat.expression;
  return beat.reactions[actor.id] ?? actor.resting;
}

export function compileShotList(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  timings: Map<number, LineTiming>,
): CompiledScene {
  if (shots.fps % shots.characterFps !== 0) {
    throw new Error(
      `characterFps (${shots.characterFps}) must divide fps (${shots.fps}) evenly, ` +
        `otherwise held frames land unevenly and the motion judders`,
    );
  }

  const timeline = buildTimeline(shots, timings);
  const durationMs = timeline[timeline.length - 1]?.endMs ?? 0;
  if (durationMs <= 0) throw new Error('scene has zero duration');

  const actors = shots.cast.map((member) => {
    const loaded = rigs.get(member.rig);
    if (!loaded) throw new Error(`cast member "${member.id}" needs rig "${member.rig}", which is not loaded`);
    return prepareActor(shots, member, loaded);
  });

  const durationSec = durationMs / 1000;
  for (const actor of actors) {
    const rng = new Rng(deriveSeed(shots.seed, `blink:${actor.rig.charId ?? actor.id}`));
    // A blink shorter than one character frame could fall between two samples
    // and silently never render, so clamp it to just over one.
    const blinkDur = Math.max(actor.rig.idle.blinkDuration, 1.001 / shots.characterFps);
    actor.blinks = scheduleBlinks(rng, durationSec, actor.rig.idle.blinkRateHz, blinkDur);
  }

  const frameInfo: ActorFrameInfo[] = actors.map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    scale: a.scale,
    headX: a.headX,
    headY: a.headY,
    headR: a.headR,
  }));
  const stage = { width: shots.width, height: shots.height };

  const frameCount = Math.max(1, Math.round(durationSec * shots.fps));
  const step = shots.fps / shots.characterFps;
  const frames: IRFrame[] = [];

  const beatAt = (ms: number): Timed => {
    for (const t of timeline) {
      if (ms < t.endMs) return t;
    }
    return timeline[timeline.length - 1]!;
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
      const intoBeat = charMs - active.startMs;

      cachedActors = {};
      for (const actor of actors) {
        const poseName = poseNameFor(actor, active.beat, intoBeat);
        const exprName = expressionNameFor(actor, active.beat);
        const poseKey = `${poseName}|${exprName}`;

        const pose = actor.poses.get(poseName);
        const expr = actor.expressions.get(exprName);
        if (!pose) throw new Error(`rig "${actor.rig.name}" has no pose "${poseName}"`);
        if (!expr) throw new Error(`rig "${actor.rig.name}" has no expression "${exprName}"`);

        const target: Record<string, IRTransform> = {};
        for (const [id, t] of Object.entries(pose.parts)) target[id] = add(IDENTITY, t);
        for (const [id, t] of Object.entries(expr.parts)) target[id] = add(target[id] ?? IDENTITY, t);

        // One intermediate frame on a pose change, so the snap reads as a snap
        // rather than a teleport.
        let parts = target;
        if (actor.lastPoseKey && actor.lastPoseKey !== poseKey) {
          parts = {};
          const keys = new Set([...Object.keys(target), ...Object.keys(actor.lastParts)]);
          for (const id of keys) {
            parts[id] = lerp(actor.lastParts[id] ?? IDENTITY, target[id] ?? IDENTITY, SNAP_BLEND);
          }
        }
        actor.lastPoseKey = poseKey;
        actor.lastParts = target;

        const swaps = { ...actor.defaultSwaps, ...expr.swaps };

        // Mouth, driven by the speaker's viseme track.
        let openness = 0;
        if (active.beat.kind === 'line' && active.beat.speaker === actor.id && active.timing) {
          const shape = mouthAt(active.timing.cues, intoBeat);
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

        if (actor.hasEyesClosed && !expr.suppressBlink && isBlinking(actor.blinks, charSec)) {
          swaps['eyes'] = 'eyes_closed';
        }

        cachedActors[actor.id] = {
          visible: true,
          x: actor.x,
          y: actor.y,
          scale: actor.scale,
          flip: actor.flip,
          parts: pruneRest(out),
          swaps,
        };
      }
    }

    const camBeat = beatAt(ms);
    const span = Math.max(1, camBeat.endMs - camBeat.startMs);
    const t = Math.min(1, (ms - camBeat.startMs) / span);
    const base = baseFrame(camBeat.beat.shot, camBeat.beat.focus, frameInfo, stage);
    const camera = applyMove(base, camBeat.beat.camera, t, f, stage);

    frames.push({ camera, actors: cachedActors });
  }

  const audio: AudioPlacement[] = timeline
    .filter((t) => t.timing)
    .map((t) => ({ file: t.timing!.audio, startMs: t.startMs }));

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
      },
      cast: shots.cast.map((c) => ({ id: c.id, rig: c.rig })),
      frames,
    },
    audio,
    durationMs,
  };
}
