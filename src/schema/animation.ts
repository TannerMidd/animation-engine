import { z } from 'zod';
import { PartTransform, Point } from './rig.ts';

/**
 * Editable animation intent.
 *
 * SceneIR remains the baked, frame-by-frame render contract. This document is
 * the smaller authoring format that survives timing changes and director
 * reruns: keys point at stable beats and words, and layers say who owns an
 * edit. The compiler resolves it into frames later.
 */

export const ANIMATION_SCHEMA_VERSION = 1 as const;

/** Stable ids are deliberately plain so they are pleasant in hand-edited JSON. */
export const AnimationId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a stable id (letters, numbers, dot, underscore, colon or dash)');
export type AnimationId = z.infer<typeof AnimationId>;

const OffsetMs = z.number().finite().default(0);

/**
 * A time can be absolute, or attached to story/audio meaning.
 *
 * Semantic anchors are the important case: replacing a voice take may move a
 * word, but a nod attached to that word remains a nod on that word.
 */
export const TimeAnchor = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('absolute'),
    ms: z.number().finite().nonnegative(),
  }),
  z.object({
    kind: z.literal('beat'),
    beatId: AnimationId,
    edge: z.enum(['start', 'end']),
    offsetMs: OffsetMs,
  }),
  z.object({
    kind: z.literal('speech'),
    beatId: AnimationId,
    edge: z.enum(['start', 'end']),
    offsetMs: OffsetMs,
  }),
  z.object({
    kind: z.literal('word'),
    beatId: AnimationId,
    wordId: AnimationId,
    edge: z.enum(['start', 'end']),
    offsetMs: OffsetMs,
  }),
]);
export type TimeAnchor = z.infer<typeof TimeAnchor>;

export const Interpolation = z.enum(['hold', 'linear']);
export type Interpolation = z.infer<typeof Interpolation>;

export const Easing = z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']);
export type Easing = z.infer<typeof Easing>;

export const BlendMode = z.enum(['override', 'additive']);
export type BlendMode = z.infer<typeof BlendMode>;

/**
 * Ownership is stronger than numeric priority. Generated work is always the
 * proposal underneath a person's edits; system layers are reserved for hard
 * contracts such as attachment locks.
 */
export const LayerOwnership = z.enum(['generated', 'manual', 'system']);
export type LayerOwnership = z.infer<typeof LayerOwnership>;

export const AnimationLayer = z.object({
  id: AnimationId,
  name: z.string().trim().min(1),
  ownership: LayerOwnership,
  /** Ordering inside one ownership class. Higher layers are applied later. */
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
});
export type AnimationLayer = z.infer<typeof AnimationLayer>;

const NumericKeyFields = {
  id: AnimationId,
  time: TimeAnchor,
  interpolation: Interpolation.default('linear'),
  easing: Easing.default('linear'),
  locked: z.boolean().default(false),
};

const BooleanKeyFields = {
  id: AnimationId,
  time: TimeAnchor,
  /** Booleans have no meaningful in-between state. */
  interpolation: z.literal('hold').default('hold'),
  easing: z.literal('linear').default('linear'),
  locked: z.boolean().default(false),
};

export const PointAnimationKey = z.object({
  ...NumericKeyFields,
  value: Point,
});
export type PointAnimationKey = z.infer<typeof PointAnimationKey>;

export const NumberAnimationKey = z.object({
  ...NumericKeyFields,
  value: z.number().finite(),
});
export type NumberAnimationKey = z.infer<typeof NumberAnimationKey>;

export const BooleanAnimationKey = z.object({
  ...BooleanKeyFields,
  value: z.boolean(),
});
export type BooleanAnimationKey = z.infer<typeof BooleanAnimationKey>;

export const PartTransformAnimationKey = z.object({
  ...NumericKeyFields,
  value: PartTransform,
});
export type PartTransformAnimationKey = z.infer<typeof PartTransformAnimationKey>;

const TrackFields = {
  id: AnimationId,
  layerId: AnimationId,
  actorId: AnimationId,
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
};

/** Position of the actor's rig anchor, in set coordinates. */
export const RootPositionTrack = z.object({
  ...TrackFields,
  channel: z.literal('root.position'),
  blend: BlendMode.default('override'),
  keys: z.array(PointAnimationKey).min(1),
});

/** Uniform actor scale. Additive values are multiplicative factors. */
export const RootScaleTrack = z.object({
  ...TrackFields,
  channel: z.literal('root.scale'),
  blend: BlendMode.default('override'),
  keys: z.array(NumberAnimationKey).min(1),
});

export const RootFlipTrack = z.object({
  ...TrackFields,
  channel: z.literal('root.flip'),
  blend: z.literal('override').default('override'),
  keys: z.array(BooleanAnimationKey).min(1),
});

export const VisibilityTrack = z.object({
  ...TrackFields,
  channel: z.literal('visibility'),
  blend: z.literal('override').default('override'),
  keys: z.array(BooleanAnimationKey).min(1),
});

/** A part transform is relative to the rig's rest transform. */
export const PartTransformTrack = z.object({
  ...TrackFields,
  channel: z.literal('part.transform'),
  partId: AnimationId,
  blend: BlendMode.default('override'),
  keys: z.array(PartTransformAnimationKey).min(1),
});

export const AnimationTrack = z.discriminatedUnion('channel', [
  RootPositionTrack,
  RootScaleTrack,
  RootFlipTrack,
  VisibilityTrack,
  PartTransformTrack,
]);
export type AnimationTrack = z.infer<typeof AnimationTrack>;
export type AnimationTrackInput = z.input<typeof AnimationTrack>;
export type AnimationKey = AnimationTrack['keys'][number];

/**
 * A creator-owned motion phrase between two semantic endpoints.
 *
 * Tracks remain the low-level curve format. Motion segments add editable path
 * intent without baking assists into dozens of fragile keys: endpoint anchors
 * retime with dialogue, normalized waypoints retime with the segment, and the
 * compiler expands anticipation/overshoot deterministically at sample time.
 */
export const MotionPathShape = z.enum(['linear', 'smooth', 'arc']);
export type MotionPathShape = z.infer<typeof MotionPathShape>;

export const MotionPath = z.object({
  shape: MotionPathShape.default('smooth'),
  /** Signed bend, relative to the distance between each pair of path knots. */
  curvature: z.number().finite().min(-1).max(1).default(0.2),
});
export type MotionPath = z.infer<typeof MotionPath>;

export const MotionAssist = z.object({
  /** Opposite-direction travel as a fraction of endpoint delta. */
  anticipation: z.number().finite().min(0).max(0.5).default(0),
  /** Travel beyond the destination as a fraction of endpoint delta. */
  overshoot: z.number().finite().min(0).max(0.5).default(0),
  /** Normalized time held on the final destination. */
  hold: z.number().finite().min(0).max(0.8).default(0),
  /** Normalized time reserved to settle an overshoot. */
  recovery: z.number().finite().min(0).max(0.5).default(0.15),
}).superRefine((assist, ctx) => {
  if (assist.overshoot > 0 && assist.recovery <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recovery'],
      message: 'overshoot requires a positive recovery interval',
    });
  }
  if (assist.hold + (assist.overshoot > 0 ? assist.recovery : 0) > 0.8) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hold'],
      message: 'hold plus active recovery must leave at least 20% for the motion',
    });
  }
});
export type MotionAssist = z.infer<typeof MotionAssist>;

const MotionEndpointFields = {
  id: AnimationId,
  time: TimeAnchor,
  locked: z.boolean().default(false),
};

const MotionWaypointFields = {
  id: AnimationId,
  /** Position inside the segment; endpoint retiming leaves this normalized. */
  at: z.number().finite().gt(0).lt(1),
  locked: z.boolean().default(false),
};

const MotionSegmentFields = {
  id: AnimationId,
  layerId: AnimationId,
  actorId: AnimationId,
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  blend: BlendMode.default('override'),
  easing: Easing.default('ease-in-out'),
  path: MotionPath.default({}),
  assist: MotionAssist.default({}),
  source: z.enum(['drag', 'puppeteering', 'imported']).default('drag'),
};

const PointMotionEndpoint = z.object({ ...MotionEndpointFields, value: Point });
const PointMotionWaypoint = z.object({ ...MotionWaypointFields, value: Point });
const NumberMotionEndpoint = z.object({
  ...MotionEndpointFields,
  value: z.number().finite().positive(),
});
const NumberMotionWaypoint = z.object({
  ...MotionWaypointFields,
  value: z.number().finite().positive(),
});
const PartMotionEndpoint = z.object({ ...MotionEndpointFields, value: PartTransform });
const PartMotionWaypoint = z.object({ ...MotionWaypointFields, value: PartTransform });

const RootPositionMotionSegment = z.object({
  ...MotionSegmentFields,
  channel: z.literal('root.position'),
  /**
   * Whether the puppet walks the distance or is simply carried it.
   *
   * `auto` walks anything far enough to read as travel, which is what moving a
   * character across the stage means; `none` is for the times it does not — a
   * slide, a lift, a nudge onto a mark. Defaulted so existing documents gain
   * the gait rather than needing to be rewritten to ask for it.
   */
  gait: z.enum(['auto', 'walk', 'none']).default('auto'),
  from: PointMotionEndpoint,
  to: PointMotionEndpoint,
  waypoints: z.array(PointMotionWaypoint).default([]),
});

const RootScaleMotionSegment = z.object({
  ...MotionSegmentFields,
  channel: z.literal('root.scale'),
  from: NumberMotionEndpoint,
  to: NumberMotionEndpoint,
  waypoints: z.array(NumberMotionWaypoint).default([]),
});

const PartTransformMotionSegment = z.object({
  ...MotionSegmentFields,
  channel: z.literal('part.transform'),
  partId: AnimationId,
  from: PartMotionEndpoint,
  to: PartMotionEndpoint,
  waypoints: z.array(PartMotionWaypoint).default([]),
});

export const MotionSegment = z.discriminatedUnion('channel', [
  RootPositionMotionSegment,
  RootScaleMotionSegment,
  PartTransformMotionSegment,
]).superRefine((segment, ctx) => {
  const ordered = [...segment.waypoints].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (let index = 1; index < ordered.length; index++) {
    if (Math.abs(ordered[index]!.at - ordered[index - 1]!.at) < 1e-7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waypoints'],
        message: `waypoints "${ordered[index - 1]!.id}" and "${ordered[index]!.id}" share the same position`,
      });
    }
  }
});
export type MotionSegment = z.infer<typeof MotionSegment>;
export type MotionSegmentInput = z.input<typeof MotionSegment>;
export type MotionValue = MotionSegment['from']['value'];

const EventFields = {
  id: AnimationId,
  layerId: AnimationId,
  at: TimeAnchor,
  locked: z.boolean().default(false),
};

/** Semantic events are persisted now even though later compilers execute them. */
export const AnimationEvent = z.discriminatedUnion('kind', [
  z.object({
    ...EventFields,
    kind: z.literal('attach'),
    propId: AnimationId,
    actorId: AnimationId,
    socketId: AnimationId,
  }),
  z.object({
    ...EventFields,
    kind: z.literal('detach'),
    propId: AnimationId,
  }),
  z.object({
    ...EventFields,
    kind: z.literal('contact'),
    actorId: AnimationId,
    handleId: AnimationId,
    targetId: AnimationId,
    targetHandleId: AnimationId.optional(),
  }),
  z.object({
    ...EventFields,
    kind: z.literal('marker'),
    label: z.string().trim().min(1),
  }),
]);
export type AnimationEvent = z.infer<typeof AnimationEvent>;

function uniqueIds(
  values: Array<{ id: string }>,
  label: string,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate ${label} id "${value.id}"`,
        path: [...path, index, 'id'],
      });
    }
    seen.add(value.id);
  });
}

export const AnimationDocument = z
  .object({
    schemaVersion: z.literal(ANIMATION_SCHEMA_VERSION),
    scene: z.string().trim().min(1),
    revision: z.number().int().nonnegative().default(0),
    layers: z.array(AnimationLayer).min(1),
    tracks: z.array(AnimationTrack).default([]),
    segments: z.array(MotionSegment).default([]),
    events: z.array(AnimationEvent).default([]),
  })
  .superRefine((doc, ctx) => {
    uniqueIds(doc.layers, 'layer', ctx, ['layers']);
    uniqueIds(doc.tracks, 'track', ctx, ['tracks']);
    uniqueIds(doc.segments, 'motion segment', ctx, ['segments']);
    uniqueIds(doc.events, 'event', ctx, ['events']);

    const keyIds: Array<{ id: string }> = [];
    for (const track of doc.tracks) keyIds.push(...track.keys);
    for (const segment of doc.segments) {
      keyIds.push(segment.from, segment.to, ...segment.waypoints);
    }
    uniqueIds(keyIds, 'key', ctx, ['tracks']);

    const layers = new Set(doc.layers.map((layer) => layer.id));
    doc.tracks.forEach((track, index) => {
      if (!layers.has(track.layerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `track references missing layer "${track.layerId}"`,
          path: ['tracks', index, 'layerId'],
        });
      }
    });
    doc.segments.forEach((segment, index) => {
      if (!layers.has(segment.layerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `motion segment references missing layer "${segment.layerId}"`,
          path: ['segments', index, 'layerId'],
        });
      }
    });
    doc.events.forEach((event, index) => {
      if (!layers.has(event.layerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `event references missing layer "${event.layerId}"`,
          path: ['events', index, 'layerId'],
        });
      }
    });
  });
export type AnimationDocument = z.infer<typeof AnimationDocument>;
export type AnimationDocumentInput = z.input<typeof AnimationDocument>;
