import type { ShotList as ShotListContract } from '../schema/script.ts';

/**
 * Browser-safe type surface for authored domain documents.
 *
 * Runtime schemas remain in their domain modules; this module is deliberately
 * type-only so clients can share the exact inferred contracts without pulling
 * filesystem or rendering code into their bundle.
 */
export type { CameraMove, Mark, Shot, ShotList, ShotPurpose, StageAction } from '../schema/script.ts';

/** Fully parsed beats and cast members have defaults and stable beat ids. */
export type Beat = ShotListContract['beats'][number];
export type CastMember = ShotListContract['cast'][number];

export type { DialogueCue, DialogueDocument, RecordedTake, VoiceRender } from '../schema/dialogue.ts';

export type {
  AnimationDocument,
  AnimationKey,
  AnimationTrack,
  MotionSegment,
  MotionValue,
  TimeAnchor,
} from '../schema/animation.ts';

export type { Layer as LayerName, ParamValue, PropInstance, SetDescriptor } from '../sets/schema.ts';

export type { PropReferenceIssue, PropSubstitute, SetFit } from '../sets/interaction.ts';
