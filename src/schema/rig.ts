import { z } from 'zod';
import { Look } from './look.ts';
import { IdentityStamp } from './identity.ts';

/**
 * Rhubarb Lip Sync's mouth shape alphabet.
 *
 * A-F are the basic shapes, G/H/X the extended ones. X is the rest position
 * used for silence — it is not the same as A (closed, for M/B/P), which is an
 * active articulation. Every rig must supply all nine so any Rhubarb output
 * can be rendered without a fallback.
 */
export const MOUTH_SHAPES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'] as const;
export const MouthShape = z.enum(MOUTH_SHAPES);
export type MouthShape = z.infer<typeof MouthShape>;

/** A 2D point in the puppet's local coordinate space. */
export const Point = z.tuple([z.number(), z.number()]);
export type Point = z.infer<typeof Point>;

/**
 * One addressable piece of a puppet, corresponding 1:1 with an SVG element id.
 *
 * Parts form a tree via `parent`: rotating an upper arm carries the forearm and
 * hand with it. `pivot` is the rotation origin in puppet-local coordinates,
 * which is what lets us drive a rig without knowing anything about the artwork
 * inside the element.
 */
export const Part = z.object({
  id: z.string().min(1),
  parent: z.string().nullable().default(null),
  pivot: Point,
  /** Draw order, ascending. Ties broken by declaration order. */
  z: z.number().int().default(0),
});
export type Part = z.infer<typeof Part>;

/**
 * A set of mutually-exclusive artwork variants for one slot — mouth shapes,
 * eye states, brow positions. Exactly one variant is visible at a time; the
 * renderer hides the rest.
 */
export const SwapSet = z.object({
  slot: z.string().min(1),
  /** SVG element ids. Must all exist in the puppet SVG. */
  variants: z.array(z.string().min(1)).min(1),
  default: z.string().min(1),
});
export type SwapSet = z.infer<typeof SwapSet>;

/** A transform applied to one part, relative to its rest state. */
export const PartTransform = z.object({
  /** Degrees, clockwise, about the part's pivot. */
  rot: z.number().default(0),
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().default(1),
});
export type PartTransform = z.infer<typeof PartTransform>;

/** A named whole-body pose: a sparse map of part id to transform. */
export const Pose = z.object({
  name: z.string().min(1),
  parts: z.record(z.string(), PartTransform).default({}),
});
export type Pose = z.infer<typeof Pose>;

/**
 * A named face state. Expressions drive swap slots (and optionally small part
 * transforms, e.g. a tilted head for CONFUSED) but never the body pose — those
 * compose independently so the director can pick them separately.
 */
export const Expression = z.object({
  name: z.string().min(1),
  swaps: z.record(z.string(), z.string()).default({}),
  parts: z.record(z.string(), PartTransform).default({}),
  /** Suppress the blink scheduler while this expression is held (e.g. SHOCKED). */
  suppressBlink: z.boolean().default(false),
});
export type Expression = z.infer<typeof Expression>;

/** Per-character idle motion tuning. Small differences here read as personality. */
export const IdleConfig = z.object({
  /** Vertical breathing travel in puppet units. Keep it small — 2-4 is plenty. */
  breathAmplitude: z.number().default(3),
  /** Seconds per breath cycle. */
  breathPeriod: z.number().default(4),
  /**
   * Mean blinks per second. A relaxed human sits around 0.3, but cartoons blink
   * noticeably more often than life because it is one of the few cheap signals
   * that a held pose is still alive.
   */
  blinkRateHz: z.number().default(0.45),
  /** Blink duration in seconds. */
  blinkDuration: z.number().default(0.12),
});
export type IdleConfig = z.infer<typeof IdleConfig>;

/**
 * The complete contract between artwork and engine.
 *
 * A placeholder puppet and a hand-drawn one are interchangeable as long as both
 * satisfy this manifest with the same part ids — that is the whole reason the
 * "crude shapes now, real art later" path costs nothing to take.
 */
const RigShape = z.object({
  name: z.string().min(1),
  /**
   * Stable identity, independent of the name.
   *
   * Every seeded stream that concerns this character — look rolls, voice
   * minting, acting profile, per-scene blink phases — keys off this, so
   * renaming a character changes their label and nothing else. Absent only on
   * rigs that predate identity profiles; `anim migrate` assigns one.
   */
  charId: z.string().optional(),
  /**
   * Frozen properties, as dotted paths ("look.hair", "voice"). A locked path
   * survives every regeneration: rerolls, migrations, and model proposals all
   * copy the locked value forward instead of replacing it.
   */
  locks: z.array(z.string()).default([]),
  /** Which identity profile last wrote this rig, for drift detection. */
  identity: IdentityStamp.optional(),
  /** Puppet-local drawing box. Staging scales from this. */
  canvas: z.object({ width: z.number().positive(), height: z.number().positive() }),
  /** Origin point for staging — normally between the feet. */
  anchor: Point,
  /**
   * The face, in puppet-local coordinates. Close-ups frame on this point, so a
   * rig with a head somewhere unusual still gets framed correctly without the
   * camera code knowing anything about the artwork.
   *
   * Optional on disk: rigs written before this field existed still load, with
   * a head-height guess filled in below. A schema addition should never make
   * someone's saved characters unopenable.
   */
  focus: Point.optional(),
  /**
   * How the placeholder generator drew this character.
   *
   * Absent on hand-drawn puppets, which is the honest representation: a look
   * describes how art was *generated*, and once someone supplies their own SVG
   * there is nothing for it to describe. Readers that need one fall back to
   * rolling it from the name.
   */
  look: Look.optional(),
  parts: z.array(Part).min(1),
  swapSets: z.array(SwapSet).default([]),
  poses: z.array(Pose).default([]),
  expressions: z.array(Expression).default([]),
  idle: IdleConfig.default({}),
  /** Substring match against an installed SAPI voice name, e.g. "David". */
  voice: z.string().default('David'),
  /** SAPI speaking rate, -10 (slow) to 10 (fast). Slower reads as more deadpan. */
  voiceRate: z.number().int().min(-10).max(10).default(0),
  /**
   * Reference clip to clone this character's voice from, relative to cast/.
   *
   * Roughly 5-10 seconds of clean speech is enough for Chatterbox. This is how
   * a character stops sounding like a TTS preset and starts sounding like a
   * specific person. Ignored by engines that cannot clone.
   */
  voiceRef: z.string().nullable().default(null),
  /** Relative path to the puppet SVG, resolved against the rig file. */
  svg: z.string().min(1),
});

/**
 * Parsed rig, with fields added since a file was written filled in.
 *
 * Keeping the migration here rather than at each call site means every reader —
 * CLI, server, tests — sees a complete rig and nothing has to handle the
 * optional case.
 */
export const Rig = RigShape.transform((rig) => ({
  ...rig,
  // Roughly where a head sits on a full-body puppet, if the file predates the
  // field. Only affects close-up framing, and is close enough to be usable.
  focus: rig.focus ?? ([rig.canvas.width / 2, rig.canvas.height * 0.16] as Point),
}));
export type Rig = z.infer<typeof Rig>;

/** The slot name the lipsync stage drives. Rigs must declare a swap set with this name. */
export const MOUTH_SLOT = 'mouth';
/** The slot name the blink scheduler drives. */
export const EYES_SLOT = 'eyes';
/** Variant key within the eyes slot that the blink scheduler switches to. */
export const EYES_CLOSED = 'closed';
