import { z } from 'zod';
import { IdentityStamp } from './identity.ts';
import { Outfit } from './outfit.ts';

/**
 * Screenplay and shot list schemas.
 *
 * The screenplay is what you wrote. The shot list is how it gets staged — and
 * it is deliberately a file on disk rather than an internal intermediate,
 * because directing is the one stage that gets things wrong in ways only a
 * human notices. When a joke lands flat you edit the shot list and re-render;
 * you do not rewrite a prompt and hope.
 */

// --- vocabulary -----------------------------------------------------------

/**
 * The shot vocabulary. Small on purpose: a director that can only ask for
 * things the rigs actually support cannot emit an unrenderable scene.
 */
export const SHOTS = ['WIDE', 'MID', 'CU', 'ECU', 'OTS', 'TWO_SHOT'] as const;
export const Shot = z.enum(SHOTS);
export type Shot = z.infer<typeof Shot>;

export const CAMERA_MOVES = ['HOLD', 'PUSH_IN', 'PULL_OUT', 'PAN_L', 'PAN_R', 'SHAKE', 'SNAP_IN'] as const;
export const CameraMove = z.enum(CAMERA_MOVES);
export type CameraMove = z.infer<typeof CameraMove>;

/**
 * Why a frame exists in the cut.
 *
 * This is editorial intent rather than rendering vocabulary: two beats may
 * use the same MID but serve very different jobs. Persisting the job lets a
 * later director revise coverage without mistaking a reaction or button for
 * an arbitrary crop. `coverage` is the legacy default.
 */
export const SHOT_PURPOSES = [
  'coverage',
  'establishing',
  'reaction',
  'action',
  'emphasis',
  'button',
] as const;
export const ShotPurpose = z.enum(SHOT_PURPOSES);
export type ShotPurpose = z.infer<typeof ShotPurpose>;

/** Staging marks as fractions of stage width. Named so scripts read like blocking notes. */
export const MARKS = {
  FAR_L: 0.16,
  SL: 0.31,
  CENTER: 0.5,
  SR: 0.69,
  FAR_R: 0.84,
} as const;
export const Mark = z.enum(['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R']);
export type Mark = z.infer<typeof Mark>;

// --- stage state ----------------------------------------------------------

/**
 * A position an actor can occupy during a scene.
 *
 * `mark` is the readable authoring form. Exact coordinates are available for
 * hand staging and for entrances that begin outside the frame. Omitted axes
 * preserve their current value, so a move can change only depth or only x.
 */
export const StagePosition = z
  .object({
    mark: Mark.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    depth: z.number().min(-1).max(1).optional(),
  })
  .refine((p) => p.mark !== undefined || p.x !== undefined || p.y !== undefined || p.depth !== undefined, {
    message: 'a stage position needs a mark, coordinate, or depth',
  });
export type StagePosition = z.infer<typeof StagePosition>;

export const LOOK_DIRECTIONS = ['left', 'right', 'front'] as const;
export const LookDirection = z.enum(LOOK_DIRECTIONS);
export type LookDirection = z.infer<typeof LookDirection>;

const ActorAction = {
  actor: z.string().min(1),
  /** Optional duration inside the containing beat; absent uses that beat's share. */
  durationFrames: z.number().int().positive().optional(),
};

const AttentionTarget = {
  /** A cast id. */
  target: z.string().min(1).optional(),
  direction: LookDirection.optional(),
};

/**
 * Structured actions the staging compiler can reason about.
 *
 * Every action in this contract has a deterministic compiler implementation.
 * Prop references may use a stable set-instance id, or a registry key when
 * exactly one matching instance exists in the active set.
 */
export const StageAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enter'), ...ActorAction, from: StagePosition.optional(), to: StagePosition.optional() }),
  z.object({ type: z.literal('exit'), ...ActorAction, to: StagePosition.optional() }),
  z.object({ type: z.literal('move'), ...ActorAction, to: StagePosition }),
  z.object({
    type: z.literal('sit'),
    ...ActorAction,
    /** Stable set-prop id (or unambiguous prop kind) that declares a seat handle. */
    seat: z.string().min(1).optional(),
    /** Explicitly preserve floor-seating when a furnished set also contains seats. */
    floor: z.boolean().optional(),
  }),
  z.object({ type: z.literal('stand'), ...ActorAction }),
  z.object({ type: z.literal('look'), ...ActorAction, ...AttentionTarget }),
  z.object({ type: z.literal('turn'), ...ActorAction, ...AttentionTarget }),
  z.object({ type: z.literal('reach'), ...ActorAction, target: z.string().min(1) }),
  z.object({ type: z.literal('pick_up'), ...ActorAction, prop: z.string().min(1) }),
  z.object({
    type: z.literal('put_down'),
    ...ActorAction,
    prop: z.string().min(1),
    /** Addressable set prop with a semantic placement handle (for example, a desk). */
    target: z.string().min(1).optional(),
    /** Optional authored placement; omitted uses a reachable point beside the actor. */
    to: StagePosition.optional(),
  }),
  z.object({ type: z.literal('tap'), ...ActorAction, target: z.string().min(1), count: z.number().int().positive().default(1) }),
]);
export type StageAction = z.infer<typeof StageAction>;

export const STAGE_ACTION_TYPES = [
  'enter', 'exit', 'move', 'sit', 'stand', 'look', 'turn', 'reach', 'pick_up', 'put_down', 'tap',
] as const;

/** Actions with a deterministic visual implementation in the current compiler. */
export const SUPPORTED_STAGE_ACTIONS = [
  'enter', 'exit', 'move', 'sit', 'stand', 'look', 'turn', 'reach', 'pick_up', 'put_down', 'tap',
] as const;

// --- screenplay -----------------------------------------------------------

export const ScreenplayElement = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('action'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('dialogue'),
    speaker: z.string().min(1),
    /** Parenthetical, e.g. "deadpan". The director reads this as an emotion hint. */
    parenthetical: z.string().nullable().default(null),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal('beat'),
    ms: z.number().int().positive(),
  }),
]);
export type ScreenplayElement = z.infer<typeof ScreenplayElement>;

export const Screenplay = z.object({
  title: z.string(),
  characters: z.array(z.string()),
  elements: z.array(ScreenplayElement),
});
export type Screenplay = z.infer<typeof Screenplay>;

// --- shot list ------------------------------------------------------------

export const ShotCastMember = z.object({
  id: z.string().min(1),
  rig: z.string().min(1),
  mark: Mark,
  flip: z.boolean().default(false),
  scale: z.number().positive().default(1.25),
  /** Initial state. Legacy shot lists retain their old on-mark, visible IDLE. */
  visible: z.boolean().default(true),
  /** Exact initial placement; null means derive x from `mark` and y from the stage floor. */
  position: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  /** -1 background, 0 stage plane, +1 foreground. Rendered as a bounded scale change. */
  depth: z.number().min(-1).max(1).default(0),
  /** Persistent base pose beneath speech gestures. */
  pose: z.string().min(1).default('IDLE'),
  /** Addressable seat occupied at frame zero; requires the virtual SIT pose. */
  seat: z.string().min(1).nullable().default(null),
  /** Optional portable set prop already carried when the scene begins or the actor enters. */
  heldProp: z.string().min(1).nullable().default(null),
  heldHand: z.enum(['left', 'right']).nullable().default(null),
  /** Expression this character returns to when not otherwise directed. */
  resting: z.string().default('NEUTRAL'),
  /**
   * Scene-specific costume, overriding the character's default outfit.
   * Continuity is the default — absent means "wear what you always wear".
   * Only works for generator-drawn puppets; hand-drawn art wears what was
   * drawn.
   */
  outfit: Outfit.optional(),
});
export type ShotCastMember = z.infer<typeof ShotCastMember>;

/** Framing shared by every beat kind. */
const Framing = {
  /** Stable across repeated directing/parsing of the same semantic beat. */
  id: z.string().min(1).optional(),
  /** The editorial job this beat's framing performs. */
  purpose: ShotPurpose.default('coverage'),
  shot: Shot.default('MID'),
  /** Who the shot is on. Empty means everyone. */
  focus: z.array(z.string()).default([]),
  camera: CameraMove.default('HOLD'),
  /**
   * A locked beat survives every director rerun exactly as it stands. This is
   * the difference between "the director proposes" and "the director owns your
   * edits" — set it on any beat whose timing or staging you fixed by hand.
   */
  locked: z.boolean().default(false),
};

export const ShotBeat = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('line'),
    speaker: z.string().min(1),
    text: z.string().min(1),
    expression: z.string().default('NEUTRAL'),
    gesture: z.string().default('TALK'),
    /**
     * Expressions for characters who are not speaking.
     *
     * A great deal of this genre's comedy is in the listener, so reactions are
     * first-class rather than something the director has to work around.
     */
    reactions: z.record(z.string(), z.string()).default({}),
    ...Framing,
  }),
  z.object({
    kind: z.literal('pause'),
    ms: z.number().int().positive(),
    reactions: z.record(z.string(), z.string()).default({}),
    ...Framing,
  }),
  z.object({
    kind: z.literal('action'),
    text: z.string(),
    ms: z.number().int().positive(),
    /** Ordered stage events executed during this beat. */
    stage: z.array(StageAction).default([]),
    /** Director/parser notes that preflight must surface rather than ignore. */
    unsupported: z.array(z.string().min(1)).default([]),
    reactions: z.record(z.string(), z.string()).default({}),
    ...Framing,
  }),
]);
export type ShotBeat = z.infer<typeof ShotBeat>;
/** Builder/JSON input keeps defaulted framing fields, including purpose, optional. */
export type ShotBeatInput = z.input<typeof ShotBeat>;

const ShotListShape = z.object({
  scene: z.string().min(1),
  /** Which identity profile directed this scene, for drift detection. */
  identity: IdentityStamp.optional(),
  /**
   * Title and end cards around the scene. On by default — the card rhythm is
   * part of the show. Frame counts and treatment come from the identity
   * profile; this is only the per-scene switch and wording.
   */
  cards: z.boolean().default(true),
  title: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  set: z.string().nullable().default(null),
  fps: z.number().int().positive().default(24),
  characterFps: z.number().int().positive().default(12),
  seed: z.number().int().default(7),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  cast: z.array(ShotCastMember).min(1),
  beats: z.array(ShotBeat).min(1),
});

/** Semantic key deliberately excludes framing/directing choices. */
function beatSemanticKey(beat: ShotBeat): string {
  switch (beat.kind) {
    case 'line':
      return `line:${beat.speaker}:${beat.text}`;
    case 'pause':
      return `pause:${beat.ms}`;
    case 'action':
      return `action:${beat.text}`;
  }
}

/** Small platform-independent FNV-1a hash; identity, not security. */
function beatHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stable id for legacy/machine-authored beats that omitted one. */
export function stableBeatId(scene: string, beat: ShotBeat, occurrence: number): string {
  return `${beat.kind}-${beatHash(`${scene}\0${beatSemanticKey(beat)}\0${occurrence}`)}`;
}

/**
 * Backfill stable beat ids at the shot-list boundary.
 *
 * The occurrence is among semantically identical beats, not the array index,
 * so inserting an unrelated beat does not rename every edit below it.
 */
export const ShotList = ShotListShape.superRefine((shots, ctx) => {
  shots.cast.forEach((member, index) => {
    if ((member.heldProp === null) !== (member.heldHand === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cast', index, member.heldProp === null ? 'heldProp' : 'heldHand'],
        message: 'initial heldProp and heldHand must be set together',
      });
    }
  });
}).transform((shots) => {
  const occurrences = new Map<string, number>();
  const used = new Set(shots.beats.flatMap((b) => (b.id ? [b.id] : [])));

  const beats = shots.beats.map((beat) => {
    if (beat.id) return { ...beat, id: beat.id };
    const key = beatSemanticKey(beat);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const base = stableBeatId(shots.scene, beat, occurrence);
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return { ...beat, id };
  });

  return { ...shots, beats };
});
export type ShotList = z.infer<typeof ShotList>;

// --- capability manifest --------------------------------------------------

/**
 * What the loaded cast can actually do.
 *
 * Handed to whatever is directing (heuristics today, an LLM later) and used to
 * validate its output, so a shot list can never reference a pose or expression
 * that does not exist on the puppet.
 */
export interface CapabilityManifest {
  shots: readonly string[];
  shotPurposes: readonly string[];
  cameraMoves: readonly string[];
  marks: readonly string[];
  stageActions: readonly string[];
  characters: Record<string, { expressions: string[]; poses: string[] }>;
}
