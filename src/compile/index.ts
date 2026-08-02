import { Rng, deriveSeed } from '../core/rng.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { Rig } from '../schema/index.ts';
import type { SceneIR, IRFrame, IRActor, IRCamera, IRTransform } from '../schema/index.ts';
import { IDENTITY, add, pruneRest, scheduleBlinks, isBlinking, type BlinkWindow } from './layers.ts';

/**
 * The compiler: scene plan + rigs -> fully-baked per-frame IR.
 *
 * Everything here is deterministic. Every random choice draws from a seeded
 * RNG derived from the scene seed and a stable label, so adding a character to
 * a scene never reshuffles the blinks of the characters already in it.
 */

export interface ActorPlan {
  id: string;
  rig: string;
  /** Set coordinates for the rig's anchor point. */
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  pose: string;
  expression: string;
}

export interface ScenePlan {
  scene: string;
  fps: number;
  width: number;
  height: number;
  seed: number;
  durationSec: number;
  camera: IRCamera;
  set: string | null;
  audio: string | null;
  actors: ActorPlan[];
  /**
   * Frame rate the characters actually animate at, independent of render fps.
   *
   * This is the core limited-animation control. Television cartoons in this
   * style run bodies on twos or threes while the camera moves on ones; holding
   * a pose for two or three render frames is what makes the motion read as
   * cheap and snappy rather than smooth. It also makes dedup very effective,
   * since the held frames are byte-identical.
   */
  characterFps: number;
}

export const DEFAULT_PLAN = {
  fps: 24,
  characterFps: 12,
  width: 1280,
  height: 720,
  seed: 1,
} as const;

function findPose(rig: Rig, name: string) {
  return rig.poses.find((p) => p.name === name);
}

function findExpression(rig: Rig, name: string) {
  return rig.expressions.find((e) => e.name === name);
}

interface ActorRuntime {
  plan: ActorPlan;
  rig: Rig;
  /** Base pose + expression transforms, resolved once. */
  base: Map<string, IRTransform>;
  swaps: Record<string, string>;
  blinks: BlinkWindow[];
  suppressBlink: boolean;
  breathPhase: number;
  hasEyesClosed: boolean;
}

function prepareActor(plan: ActorPlan, rig: Rig, seed: number): ActorRuntime {
  const rng = new Rng(deriveSeed(seed, `actor:${plan.id}`));

  const base = new Map<string, IRTransform>();
  const pose = findPose(rig, plan.pose);
  if (!pose) {
    const names = rig.poses.map((p) => p.name).join(', ');
    throw new Error(`rig "${rig.name}" has no pose "${plan.pose}". Available: ${names || '(none)'}`);
  }
  for (const [id, t] of Object.entries(pose.parts)) {
    base.set(id, add(IDENTITY, t));
  }

  // Every slot starts at its declared default so nothing is ever unset.
  const swaps: Record<string, string> = {};
  for (const set of rig.swapSets) swaps[set.slot] = set.default;

  const expr = findExpression(rig, plan.expression);
  if (!expr) {
    const names = rig.expressions.map((e) => e.name).join(', ');
    throw new Error(`rig "${rig.name}" has no expression "${plan.expression}". Available: ${names || '(none)'}`);
  }
  Object.assign(swaps, expr.swaps);
  for (const [id, t] of Object.entries(expr.parts)) {
    base.set(id, add(base.get(id) ?? IDENTITY, t));
  }

  const eyeSet = rig.swapSets.find((s) => s.slot === 'eyes');

  return {
    plan,
    rig,
    base,
    swaps,
    blinks: [],
    suppressBlink: expr.suppressBlink,
    // Offsetting each character's breathing phase stops the cast pulsing in
    // unison, which is otherwise the most obvious tell that they are puppets.
    breathPhase: rng.range(0, Math.PI * 2),
    hasEyesClosed: eyeSet?.variants.includes('eyes_closed') ?? false,
  };
}

export function compileScene(plan: ScenePlan, rigs: Map<string, LoadedRig>): SceneIR {
  if (plan.fps % plan.characterFps !== 0) {
    throw new Error(
      `characterFps (${plan.characterFps}) must divide fps (${plan.fps}) evenly, ` +
        `otherwise held frames land unevenly and the motion judders`,
    );
  }

  const frameCount = Math.max(1, Math.round(plan.durationSec * plan.fps));
  const step = plan.fps / plan.characterFps;

  const actors = plan.actors.map((a) => {
    const loaded = rigs.get(a.rig);
    if (!loaded) throw new Error(`compileScene: actor "${a.id}" needs rig "${a.rig}", which is not loaded`);
    const rt = prepareActor(a, loaded.rig, plan.seed);
    const rng = new Rng(deriveSeed(plan.seed, `blink:${a.id}`));
    // Characters are sampled at characterFps, so a blink shorter than one
    // character frame can fall between two samples and silently never render.
    // Clamp it to just over one frame so every scheduled blink is always seen.
    const blinkDur = Math.max(loaded.rig.idle.blinkDuration, 1.001 / plan.characterFps);
    rt.blinks = rt.suppressBlink
      ? []
      : scheduleBlinks(rng, plan.durationSec, loaded.rig.idle.blinkRateHz, blinkDur);
    return rt;
  });

  const frames: IRFrame[] = [];

  for (let f = 0; f < frameCount; f++) {
    // Characters are sampled on the coarse grid; the camera stays on ones.
    const charFrame = Math.floor(f / step) * step;
    const charTime = charFrame / plan.fps;

    const frameActors: Record<string, IRActor> = {};

    for (const actor of actors) {
      const idle = actor.rig.idle;
      const parts: Record<string, IRTransform> = {};
      for (const [id, t] of actor.base) parts[id] = t;

      // Breathing: torso rises and falls, head counter-moves slightly so the
      // neck doesn't read as rigid.
      const breath = Math.sin((charTime / idle.breathPeriod) * Math.PI * 2 + actor.breathPhase);
      const lift = -breath * idle.breathAmplitude;
      parts['torso'] = add(parts['torso'] ?? IDENTITY, { y: lift });
      parts['head'] = add(parts['head'] ?? IDENTITY, { y: lift * -0.35, rot: breath * 0.6 });

      const swaps = { ...actor.swaps };
      if (actor.hasEyesClosed && isBlinking(actor.blinks, charTime)) {
        swaps['eyes'] = 'eyes_closed';
      }

      pruneRest(parts);

      frameActors[actor.plan.id] = {
        visible: true,
        x: actor.plan.x,
        y: actor.plan.y,
        scale: actor.plan.scale,
        flip: actor.plan.flip,
        parts,
        swaps,
      };
    }

    frames.push({ camera: { ...plan.camera }, actors: frameActors });
  }

  return {
    meta: {
      scene: plan.scene,
      fps: plan.fps,
      width: plan.width,
      height: plan.height,
      seed: plan.seed,
      audio: plan.audio,
      set: plan.set,
    },
    cast: plan.actors.map((a) => ({ id: a.id, rig: a.rig })),
    frames,
  };
}
