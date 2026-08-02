import { z } from 'zod';
import { IdentityStamp } from '../schema/identity.ts';

/**
 * Set descriptors.
 *
 * A set is data, not code: a palette, a layout, and props placed across three
 * depth layers. That makes any environment describable by hand, by the designer
 * UI, or by a model emitting JSON against this schema — and it means the engine
 * only ever has to know how to draw props, never how to draw "an office".
 */

/**
 * Depth layers.
 *
 * Characters render between `mid` and `fore`, which is the whole point: it lets
 * someone stand behind a bar and in front of a wall. Before this, the set drew
 * as one slab underneath everybody and every scene read as a cardboard
 * cut-out line-up.
 */
export const LAYERS = ['back', 'mid', 'fore'] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

/** A prop's tunable value. Declared once; the designer UI builds controls from it. */
export const ParamValue = z.union([z.number(), z.string(), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;

export const PropInstance = z.object({
  /** Key into the prop registry. */
  prop: z.string().min(1),
  /**
   * Horizontal position in set coordinates. Omitted means the prop places
   * itself — walls and floors span the whole set and ignore x.
   */
  x: z.number().optional(),
  /**
   * Vertical position. Omitted means "stand on the floor", which is what you
   * want for almost everything.
   */
  y: z.number().optional(),
  scale: z.number().positive().default(1),
  flip: z.boolean().default(false),
  params: z.record(z.string(), ParamValue).default({}),
});
export type PropInstance = z.infer<typeof PropInstance>;

/**
 * Where the room's horizon and ceiling sit, and how far the artwork extends
 * past the 1280x720 stage.
 *
 * The margin is not decoration. Close-ups and pans move the camera off the
 * middle of the set, and `baseFrame` deliberately does not clamp to the stage —
 * so the art has to keep going or the frame runs off the edge of the world.
 */
export const SetLayout = z.object({
  /** Where wall meets floor. Characters stand at y ~698. */
  horizonY: z.number().default(566),
  ceilingY: z.number().default(92),
  marginX: z.number().default(420),
  marginY: z.number().default(220),
});
export type SetLayout = z.infer<typeof SetLayout>;

export const SetDescriptor = z.object({
  name: z.string().min(1),
  /** Stable id, independent of the name. Assigned at creation or by migrate. */
  setId: z.string().optional(),
  /** Which identity profile last wrote this set, for drift detection. */
  identity: IdentityStamp.optional(),
  /** Named palette. Retinting the whole set is a one-word change. */
  palette: z.string().default('office-fluorescent'),
  layout: SetLayout.default({}),
  layers: z
    .object({
      back: z.array(PropInstance).default([]),
      mid: z.array(PropInstance).default([]),
      fore: z.array(PropInstance).default([]),
    })
    .default({}),
});
export type SetDescriptor = z.infer<typeof SetDescriptor>;

/** Stage bounds. Matches the compiler's default scene size. */
export const STAGE = { width: 1280, height: 720 } as const;

/** Resolved geometry handed to every prop, so none of them recompute it. */
export interface SetGeometry {
  /** Full artwork bounds, including margin. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  horizonY: number;
  ceilingY: number;
  stageWidth: number;
  stageHeight: number;
}

export function geometryFor(layout: SetLayout): SetGeometry {
  return {
    x0: -layout.marginX,
    y0: -layout.marginY,
    width: STAGE.width + layout.marginX * 2,
    height: STAGE.height + layout.marginY * 2,
    horizonY: layout.horizonY,
    ceilingY: layout.ceilingY,
    stageWidth: STAGE.width,
    stageHeight: STAGE.height,
  };
}
