import { z } from 'zod';

/**
 * Scene IR — the fully-baked, per-frame description of a scene.
 *
 * This is the boundary between "figuring out what happens" and "drawing it".
 * Everything upstream (script parsing, LLM direction, TTS, lipsync) has been
 * resolved by the time we get here; the renderer does no interpretation and no
 * interpolation, it just applies frame N verbatim. That is what makes rendering
 * deterministic, resumable, and parallelisable.
 */

/**
 * Compact part transform: [rot, x, y, scale].
 *
 * A tuple rather than an object because this is the bulk of the file — a
 * two-minute scene is tens of thousands of these — and the array form roughly
 * halves the JSON.
 */
export const IRTransform = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type IRTransform = z.infer<typeof IRTransform>;

/** Camera as an SVG viewBox over the set's coordinate space. */
export const IRCamera = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type IRCamera = z.infer<typeof IRCamera>;

/** One actor's complete state for one frame. */
export const IRActor = z.object({
  visible: z.boolean(),
  /** Position of the rig's anchor point in set coordinates. */
  x: z.number(),
  y: z.number(),
  scale: z.number(),
  /** Horizontal mirror, for a character facing the other way. */
  flip: z.boolean(),
  /** Part id -> transform. Omitted parts are at rest. */
  parts: z.record(z.string(), IRTransform),
  /** Swap slot -> visible variant element id. */
  swaps: z.record(z.string(), z.string()),
});
export type IRActor = z.infer<typeof IRActor>;

/** One addressable set prop that can leave its authored set placement. */
export const IRProp = z.object({
  /** Stable set-local id (or a deterministic legacy fallback). */
  id: z.string().min(1),
  /** Prop registry key, e.g. "mug" or "laptop". */
  prop: z.string().min(1),
});
export type IRProp = z.infer<typeof IRProp>;

/** Fully baked placement for one dynamic prop on one frame. */
export const IRPropState = z.object({
  visible: z.boolean(),
  /**
   * `set` shows the authored set instance. `world` hides that instance and
   * shows the movable duplicate at the coordinates below.
   */
  mode: z.enum(['set', 'world']),
  /** Position of the prop's local origin in set coordinates. */
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
  flip: z.boolean(),
  rotation: z.number(),
  /** Informational continuity metadata; placement is already fully baked. */
  heldBy: z.string().min(1).nullable(),
});
export type IRPropState = z.infer<typeof IRPropState>;

export const IRFrame = z.object({
  camera: IRCamera,
  /** Actor id -> state. */
  actors: z.record(z.string(), IRActor),
  /** Dynamic prop id -> complete state. Absent on legacy IR. */
  props: z.record(z.string(), IRPropState).optional(),
  /**
   * Which card this frame shows instead of the stage. A key into the card art
   * in `meta.cards` rather than inline SVG, so forty held title frames cost
   * forty short strings, not forty copies of the artwork.
   */
  card: z.enum(['title', 'end']).optional(),
});
export type IRFrame = z.infer<typeof IRFrame>;

/** An actor is one instance of a rig placed in a scene. */
export const IRCastMember = z.object({
  /** Scene-unique id, e.g. "steve". Usually the character name lowercased. */
  id: z.string().min(1),
  /** Rig name to load. Multiple actors may share one rig. */
  rig: z.string().min(1),
});
export type IRCastMember = z.infer<typeof IRCastMember>;

export const IRMeta = z.object({
  scene: z.string().min(1),
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** RNG seed. Same seed + same inputs => identical output, always. */
  seed: z.number().int(),
  /** Path to the muxed dialogue track, relative to the scene directory. */
  audio: z.string().nullable().default(null),
  /** Background SVG path, relative to the sets directory. */
  set: z.string().nullable().default(null),
  /** Card artwork, referenced by frames via their `card` key. */
  cards: z
    .object({
      titleSvg: z.string().optional(),
      endSvg: z.string().optional(),
    })
    .optional(),
});
export type IRMeta = z.infer<typeof IRMeta>;

export const SceneIR = z.object({
  meta: IRMeta,
  cast: z.array(IRCastMember),
  /** Addressable props used by this scene. Absent on legacy IR. */
  props: z.array(IRProp).optional(),
  frames: z.array(IRFrame),
});
export type SceneIR = z.infer<typeof SceneIR>;

/** Identity transform, used wherever a part is at rest. */
export const REST: IRTransform = [0, 0, 0, 1];
