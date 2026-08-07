/**
 * How a puppet walks, as numbers.
 *
 * A character can be sent across the stage two ways — the director stages
 * "he crosses to the window", or a creator drags them there — and the two used
 * to disagree about both how often the feet cycle and how fast the ground goes
 * by. Staged moves stepped exactly twice per transition however far they went,
 * while dragged ones stepped per stride of ground; and a drag's duration came
 * from how quickly the mouse moved, which produced 191 px/s one time and
 * 1071 px/s the next for the same puppet.
 *
 * Both are the same event and must look the same, so the vocabulary lives here
 * rather than in either caller: `src/compile/scene.ts` poses the legs with it
 * and `src/compile/animation.ts` paces the phrase with it.
 */

/** One full leg cycle — two steps — per this much ground covered. */
export const WALK_CYCLE_PX = 190;

/** Under this, a move is an adjustment onto a mark rather than a journey. */
export const WALK_MIN_TRAVEL_PX = 24;

/**
 * The pace an authored walk is normalised to — one full stride per second.
 *
 * Ground speed is a property of walking, not of the gesture that asked for it,
 * so the compiler sets it rather than trusting the duration a drag happened to
 * be committed with. Equal to `WALK_CYCLE_PX` by construction, which is what
 * lets the rule be stated as "one leg cycle per second" — about two steps a
 * second, an ordinary walking pace.
 */
export const WALK_SPEED_PX_PER_S = WALK_CYCLE_PX;

/**
 * Whole leg cycles for a journey of this length.
 *
 * The one cadence rule, shared by both routes into a walk. Feet read as walking
 * when they cycle over *ground covered* rather than over elapsed time — that is
 * what stops them skating when a move eases in and out. Whole cycles because a
 * walk that ended mid-swing would snap the feet together.
 */
export function walkCycles(distancePx: number): number {
  return Math.max(1, Math.round(distancePx / WALK_CYCLE_PX));
}

/** Milliseconds of one complete leg cycle at the walking pace. */
const cycleMs = (WALK_CYCLE_PX / WALK_SPEED_PX_PER_S) * 1000;

/**
 * How long covering this much ground should take at a walk.
 *
 * Floored at a single stride so a move someone insisted on walking still shows
 * one deliberate step instead of a twitch.
 */
export function walkDurationMs(distancePx: number): number {
  return Math.max(cycleMs, (distancePx / WALK_SPEED_PX_PER_S) * 1000);
}

/** Whether a root-position phrase of this length puts the feet down. */
export function walks(gait: 'auto' | 'walk' | 'none', distancePx: number): boolean {
  if (gait === 'none') return false;
  if (gait === 'walk') return true;
  return distancePx >= WALK_MIN_TRAVEL_PX;
}
