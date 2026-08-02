/**
 * Visual style.
 *
 * Flat fills and perfectly straight outlines are the default output of every
 * vector tool, which is exactly why they read as clipart rather than as a show.
 * This descriptor governs the qualities that make artwork look *drawn*: line
 * wobble, weight variation, fill misregistration, and grain.
 *
 * Everything here is applied at SVG-generation time and is deterministic —
 * a shape's wobble is seeded from its own geometry, so it is identical on every
 * render and, critically, identical between frames. Wobble that varies per frame
 * gives you boiling lines, which is a different aesthetic and not this one.
 */

export interface Style {
  name: string;

  /** Base outline weight, in puppet/set units. */
  lineWidth: number;
  /** How much weight varies shape to shape, 0-1. Uneven weight reads as hand-drawn. */
  lineWidthJitter: number;

  /** Perpendicular displacement of an outline, in units. 0 disables wobble. */
  wobble: number;
  /** Subdivisions per edge. More segments means finer, more nervous wiggle. */
  wobbleSegments: number;

  /**
   * Fill offset from its outline, simulating bad print registration.
   *
   * This is the detail that does the most work: a fill that peeks out on one
   * side and falls short on the other reads instantly as cheaply reproduced,
   * rather than as a shape a computer filled in perfectly.
   */
  fillOffset: [number, number];

  /** Paper grain over the whole frame, 0-1. */
  grain: number;
}

export const STYLES: Record<string, Style> = {
  /**
   * The house style: marker outlines, misregistered fills, light grain.
   * Early-2000s cheap-TV animation, where the roughness is the point.
   */
  marker: {
    name: 'marker',
    lineWidth: 4.4,
    lineWidthJitter: 0.32,
    // Calibrated against a puppet 400 units tall shown ~500px high, i.e. a bit
    // over one screen pixel per unit. Below about 2 the treatment is technically
    // present and visually absent — it needs to survive being looked at, not
    // just survive a diff.
    wobble: 2.6,
    wobbleSegments: 3,
    fillOffset: [2.6, -1.9],
    grain: 0.05,
  },

  /** No treatment at all. Kept so the effect can be diffed against a baseline. */
  clean: {
    name: 'clean',
    lineWidth: 3,
    lineWidthJitter: 0,
    wobble: 0,
    wobbleSegments: 1,
    fillOffset: [0, 0],
    grain: 0,
  },
};

export const STYLE_NAMES = Object.keys(STYLES);

/** Overridable so a render can be diffed against the untreated baseline. */
export function activeStyle(): Style {
  const name = process.env['ANIM_STYLE'] ?? 'marker';
  return STYLES[name] ?? STYLES['marker']!;
}

export function getStyle(name: string): Style {
  const style = STYLES[name];
  if (!style) throw new Error(`unknown style "${name}". Options: ${STYLE_NAMES.join(', ')}`);
  return style;
}
