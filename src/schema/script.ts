import { z } from 'zod';
import { IdentityStamp } from './identity.ts';

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

export const CAMERA_MOVES = ['HOLD', 'PUSH_IN', 'PULL_OUT', 'PAN_L', 'PAN_R', 'SHAKE'] as const;
export const CameraMove = z.enum(CAMERA_MOVES);
export type CameraMove = z.infer<typeof CameraMove>;

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
  /** Expression this character returns to when not otherwise directed. */
  resting: z.string().default('NEUTRAL'),
});
export type ShotCastMember = z.infer<typeof ShotCastMember>;

/** Framing shared by every beat kind. */
const Framing = {
  shot: Shot.default('MID'),
  /** Who the shot is on. Empty means everyone. */
  focus: z.array(z.string()).default([]),
  camera: CameraMove.default('HOLD'),
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
    reactions: z.record(z.string(), z.string()).default({}),
    ...Framing,
  }),
]);
export type ShotBeat = z.infer<typeof ShotBeat>;

export const ShotList = z.object({
  scene: z.string().min(1),
  /** Which identity profile directed this scene, for drift detection. */
  identity: IdentityStamp.optional(),
  set: z.string().nullable().default(null),
  fps: z.number().int().positive().default(24),
  characterFps: z.number().int().positive().default(12),
  seed: z.number().int().default(7),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  cast: z.array(ShotCastMember).min(1),
  beats: z.array(ShotBeat).min(1),
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
  cameraMoves: readonly string[];
  marks: readonly string[];
  characters: Record<string, { expressions: string[]; poses: string[] }>;
}
