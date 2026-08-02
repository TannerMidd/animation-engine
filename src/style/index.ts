import { activeIdentity } from '../show/context.ts';
import type { StyleTreatment } from '../schema/identity.ts';

/**
 * Visual style.
 *
 * Flat fills and perfectly straight outlines are the default output of every
 * vector tool, which is exactly why they read as clipart rather than as a show.
 * This descriptor governs the qualities that make artwork look *drawn*: line
 * wobble, weight variation, fill misregistration, and grain.
 *
 * The treatment is owned by the show's identity profile — it is the visual
 * bible's line-and-print section, not an engine preference. `ANIM_STYLE=clean`
 * survives as a development override for diffing against an untreated
 * baseline; it is not how a show chooses its look.
 *
 * Everything here is applied at SVG-generation time and is deterministic —
 * a shape's wobble is seeded from its own geometry, so it is identical on every
 * render and, critically, identical between frames. Wobble that varies per frame
 * gives you boiling lines, which is a different aesthetic and not this one.
 */

export interface Style extends StyleTreatment {
  name: string;
}

/** No treatment at all. Kept so any profile's effect can be diffed against a baseline. */
export const CLEAN: Style = {
  name: 'clean',
  lineWidth: 3,
  lineWidthJitter: 0,
  wobble: 0,
  wobbleSegments: 1,
  fillOffset: [0, 0],
  grain: 0,
};

/** The active show's line treatment. */
export function activeStyle(): Style {
  if (process.env['ANIM_STYLE'] === 'clean') return CLEAN;
  const identity = activeIdentity();
  return { name: identity.id, ...identity.visual.style };
}
