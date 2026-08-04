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

/**
 * Stable ids for addressable pieces of a set.
 *
 * They intentionally use the same pleasant-to-hand-edit character set as the
 * animation document. Existing descriptors do not have to be migrated before
 * they can load: prop instance ids remain optional until an editor or migration
 * assigns them.
 */
export const SetEntityId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must start with a letter or number and use only letters, numbers, . _ : or -');
export type SetEntityId = z.infer<typeof SetEntityId>;

/**
 * How strongly something tracks the camera, per axis.
 *
 * 1 moves with the camera exactly — no parallax, and the behaviour every set had
 * before this existed. Below 1 lags behind it and reads as further away; above 1
 * leads it and reads as nearer. Bounded rather than free so that a slipped
 * decimal point (85 for 0.85) is a validation error instead of a set that
 * teleports on the first close-up.
 */
export const ParallaxFactor = z.object({
  x: z.number().finite().min(0).max(2).default(1),
  y: z.number().finite().min(0).max(2).default(1),
});
export type ParallaxFactor = z.infer<typeof ParallaxFactor>;

export const PropInstance = z.object({
  /** Stable, set-local identity used by staging, attachment and contact events. */
  id: SetEntityId.optional(),
  /** Key into the prop registry. */
  prop: z.string().min(1),
  /**
   * Tracking factor for this instance, overriding its layer's.
   *
   * The case this exists for: a room's far shell and its floor sit in the same
   * layer, but the floor is the surface the characters stand on. Parallaxing the
   * shell is depth; parallaxing the ground plane slides it out from under
   * everyone's feet. Rather than force the two into separate layers — which
   * would change draw order for reasons that have nothing to do with draw order —
   * a single prop can opt out.
   */
  parallax: ParallaxFactor.optional(),
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
/**
 * The part of the stage where an actor's root may be blocked.
 *
 * This is intentionally set-authored rather than inferred from the canvas.
 * A rooftop, a narrow hallway and an office all use the same 1280x720 render
 * contract, but they do not have the same safe floor. Entrances and exits may
 * still use explicit offstage positions; this area governs visible blocking
 * and direct-manipulation root motion.
 */
export const DEFAULT_WALKABLE_AREA = {
  x: 64,
  y: 540,
  width: 1152,
  height: 180,
} as const;

export const WalkableArea = z.object({
  x: z.number().finite().default(DEFAULT_WALKABLE_AREA.x),
  y: z.number().finite().default(DEFAULT_WALKABLE_AREA.y),
  width: z.number().finite().positive().default(DEFAULT_WALKABLE_AREA.width),
  height: z.number().finite().positive().default(DEFAULT_WALKABLE_AREA.height),
}).default(DEFAULT_WALKABLE_AREA);
export type WalkableArea = z.infer<typeof WalkableArea>;

export const SetLayout = z.object({
  /** Where wall meets floor. Characters stand at y ~698. */
  horizonY: z.number().default(566),
  ceilingY: z.number().default(92),
  marginX: z.number().default(420),
  marginY: z.number().default(220),
  /** Valid actor-root blocking area in stage coordinates. */
  walkable: WalkableArea,
  /**
   * How each depth layer tracks the camera.
   *
   * Everything defaults to 1, so a set that says nothing renders exactly as it
   * did before parallax existed — that equivalence is worth more than a
   * pleasant default, because it means turning this on is a per-set decision
   * rather than a silent change to every scene ever made.
   *
   * Two defaults are deliberate rather than merely conservative. `y` stays at 1
   * even on sets that lag `x`: sliding a layer vertically moves the horizon line
   * relative to the characters standing on it, and horizontal-only is how cutout
   * parallax is normally done anyway. And `fore` stays at 1 because a leading
   * layer reaches its own edge sooner than a lagging one — the clamp keeps it
   * safe, but a foreground that quietly stops tracking during the tightest shot
   * is worse than one that never started.
   */
  parallax: z
    .object({
      back: ParallaxFactor.default({}),
      mid: ParallaxFactor.default({}),
      fore: ParallaxFactor.default({}),
    })
    .default({}),
}).superRefine((layout, ctx) => {
  const { x, y, width, height } = layout.walkable;
  if (x < 0 || y < 0 || x + width > STAGE.width || y + height > STAGE.height) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['walkable'],
      message: `walkable area must stay inside the ${STAGE.width}x${STAGE.height} stage`,
    });
  }
});
export type SetLayout = z.infer<typeof SetLayout>;

/**
 * Every layer tracking the camera exactly — what a set did before parallax.
 *
 * A function rather than a shared constant so callers cannot accidentally alias
 * one another's depth settings through a nested object.
 */
export function defaultParallax(): SetLayout['parallax'] {
  return { back: { x: 1, y: 1 }, mid: { x: 1, y: 1 }, fore: { x: 1, y: 1 } };
}

export const SetDescriptor = z
  .object({
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
  })
  .superRefine((set, ctx) => {
    // Animation events address props by id without carrying a layer, so an id
    // must identify exactly one instance across the entire descriptor.
    const seen = new Map<string, { layer: Layer; index: number }>();
    for (const layer of LAYERS) {
      set.layers[layer].forEach((instance, index) => {
        if (!instance.id) return;
        const first = seen.get(instance.id);
        if (first) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['layers', layer, index, 'id'],
            message: `duplicate prop instance id "${instance.id}" (first used at ${first.layer}[${first.index}])`,
          });
          return;
        }
        seen.set(instance.id, { layer, index });
      });
    }
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

export function geometryFor(
  layout: Pick<SetLayout, 'marginX' | 'marginY' | 'horizonY' | 'ceilingY'>,
): SetGeometry {
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
