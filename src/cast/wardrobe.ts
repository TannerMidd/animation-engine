import { activeStyle } from '../style/index.ts';
import { drawShape, drawStroke, rectPoints, ellipsePoints, type Point } from '../style/wobble.ts';
import type { Look } from '../schema/look.ts';
import type { Outfit } from '../schema/outfit.ts';

/**
 * Drawing what a character wears.
 *
 * All wardrobe pieces attach to the same measured geometry the body is drawn
 * from — collar widths come from the torso, hats sit on the measured crown —
 * so a costume fits every build and head shape without per-combination art.
 * Everything routes through the style helpers and inherits the show's line
 * treatment.
 */

/** The slice of puppet geometry wardrobe needs. Provided by the generator. */
export interface WardrobeGeometry {
  look: Look;
  outfit: Outfit;
  headCx: number;
  headCy: number;
  headR: number;
  halfH: number;
  neckTop: number;
  bodyTop: number;
  bodyBottom: number;
  bodyHalfW: number;
  hipY: number;
  legLen: number;
  limbW: number;
  /** The brow line. Nothing worn on the head may reach it. */
  browY: number;
  /** Torso silhouette points, for clipping patterns inside the shirt. */
  torso: Point[];
  /** Top of the skull outline at a given x — the hair helper, reused for hats. */
  crownAt: (x: number) => number;
}

const W = 200;

// --- torso layers ---------------------------------------------------------

/**
 * Pattern pass, clipped inside the torso silhouette.
 *
 * A separate clipped group between the shirt fill and the outline, so stripes
 * can never leak past the misregistered edge — the fill may misprint, the
 * pattern stays inside the garment. The clip id is namespaced per actor later
 * by the page builder, which already rewrites url() references.
 */
export function torsoPattern(g: WardrobeGeometry): string {
  const style = activeStyle();
  const { outfit, torso } = g;
  if (outfit.pattern === 'solid') return '';

  const clipId = 'clip_torso';
  const clipPath = torso.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ' Z';

  let inner = '';
  if (outfit.pattern === 'stripes') {
    // Horizontal stripes in the accent, drawn as strokes so they wobble.
    const gap = Math.max(16, (g.bodyBottom - g.bodyTop) / 6);
    for (let y = g.bodyTop + gap; y < g.bodyBottom - 4; y += gap) {
      inner += drawStroke(
        [
          [W / 2 - g.bodyHalfW - 4, y],
          [W / 2 + g.bodyHalfW + 4, y],
        ],
        style,
        g.outfit.accent,
        5,
      );
    }
  } else if (outfit.pattern === 'pocket') {
    const px = W / 2 - g.bodyHalfW * 0.45;
    const py = g.bodyTop + (g.bodyBottom - g.bodyTop) * 0.28;
    inner =
      drawShape(rectPoints(px - 9, py, 18, 20, 3), style, null, g.look.line, { widthScale: 0.6 }) +
      drawStroke([[px - 9, py + 6], [px + 9, py + 6]], style, g.look.line, 2);
  }

  if (!inner) return '';
  return (
    `<clipPath id="${clipId}"><path d="${clipPath}"/></clipPath>` +
    `<g clip-path="url(#${clipId})">${inner}</g>`
  );
}

/** Collar, seated on the torso's shoulder line around the neck. */
export function collar(g: WardrobeGeometry): string {
  const style = activeStyle();
  const { outfit, look } = g;
  if (outfit.collar === 'none') return '';

  const cx = W / 2;
  const y = g.bodyTop;
  const w = g.limbW * 1.35;

  switch (outfit.collar) {
    case 'flat':
      return drawShape(
        [
          [cx - w, y + 2],
          [cx + w, y + 2],
          [cx + w * 0.7, y + 14],
          [cx - w * 0.7, y + 14],
        ],
        style, look.shirt, look.line, { widthScale: 0.7 },
      );
    case 'pointed': {
      const wing = (sx: number): Point[] => [
        [cx + sx * 3, y + 1],
        [cx + sx * w, y + 3],
        [cx + sx * w * 0.55, y + 17],
      ];
      return (
        drawShape(wing(-1), style, '#f2ede4', look.line, { widthScale: 0.7 }) +
        drawShape(wing(1), style, '#f2ede4', look.line, { widthScale: 0.7 })
      );
    }
    case 'turtleneck':
      return drawShape(
        rectPoints(cx - g.limbW * 0.78, g.neckTop - 2, g.limbW * 1.56, g.bodyTop - g.neckTop + 8, 4),
        style, look.shirt, look.line, { widthScale: 0.8 },
      );
  }
}

/** Tie, bowtie, or lanyard, hung from the collar point. */
export function neckwear(g: WardrobeGeometry): string {
  const style = activeStyle();
  const { outfit, look } = g;
  if (outfit.neckwear === 'none') return '';

  const cx = W / 2;
  const top = g.bodyTop + 6;
  const accent = outfit.accent;

  switch (outfit.neckwear) {
    case 'tie': {
      const len = (g.bodyBottom - g.bodyTop) * 0.52;
      return (
        drawShape(
          [
            [cx - 7, top], [cx + 7, top],
            [cx + 9, top + len], [cx, top + len + 12], [cx - 9, top + len],
          ],
          style, accent, look.line, { widthScale: 0.7 },
        ) +
        drawShape(rectPoints(cx - 8, top - 4, 16, 9, 2), style, accent, look.line, { widthScale: 0.7 })
      );
    }
    case 'bowtie': {
      const wing = (sx: number): Point[] => [
        [cx + sx * 2, top + 4],
        [cx + sx * 16, top - 3],
        [cx + sx * 16, top + 11],
      ];
      return (
        drawShape(wing(-1), style, accent, look.line, { widthScale: 0.7 }) +
        drawShape(wing(1), style, accent, look.line, { widthScale: 0.7 }) +
        drawShape(ellipsePoints(cx, top + 4, 4, 4, 8), style, accent, look.line, { widthScale: 0.7 })
      );
    }
    case 'lanyard': {
      const drop = (g.bodyBottom - g.bodyTop) * 0.42;
      const cord = (sx: number) =>
        drawStroke([[cx + sx * g.limbW * 0.9, top - 2], [cx + sx * 3, top + drop]], style, accent, 3);
      return (
        cord(-1) + cord(1) +
        drawShape(rectPoints(cx - 10, top + drop, 20, 26, 2), style, '#f2ede4', look.line, { widthScale: 0.7 }) +
        drawStroke([[cx - 6, top + drop + 8], [cx + 6, top + drop + 8]], style, look.line, 2)
      );
    }
  }
}

// --- head layers ----------------------------------------------------------

/**
 * Hat, seated on the measured crown.
 *
 * Drawn above the hair cap. Hats never reach the brow line — the same
 * invariant the hair honours, for the same reason: a brim that lands on the
 * brows deletes every expression.
 */
export function hat(g: WardrobeGeometry): string {
  const style = activeStyle();
  const { outfit, look } = g;
  if (outfit.hat === 'none') return '';

  const cx = g.headCx;
  const r = g.headR;
  const accent = outfit.accent;
  const crownY = g.crownAt(cx);
  // Wide enough to cover the hair beneath; the hair generator collapses its
  // crown decorations when a hat is worn, so nothing pokes out around this.
  const halfW = r * 0.94;
  /**
   * Nothing on the head reaches the brows — the same invariant the hair
   * enforces, because a band across the brow line deletes every expression.
   * All the "how far down does this piece come" arithmetic clamps here.
   */
  const lowest = g.browY - r * 0.2;
  const down = (y: number) => Math.min(y, lowest);

  switch (outfit.hat) {
    case 'cap': {
      const dome: Point[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI - (i / 10) * Math.PI;
        dome.push([cx + Math.cos(a) * halfW, down(crownY + 10) - Math.sin(a) * r * 0.42]);
      }
      return (
        drawShape(dome, style, accent, look.line, { widthScale: 0.9 }) +
        // The peak, off to one side — a centred peak reads as a helmet.
        drawShape(
          [
            [cx + halfW * 0.5, down(crownY + 6)],
            [cx + halfW * 1.55, down(crownY + 2)],
            [cx + halfW * 1.5, down(crownY + 12)],
            [cx + halfW * 0.5, down(crownY + 13)],
          ],
          style, accent, look.line, { widthScale: 0.8 },
        )
      );
    }
    case 'beanie': {
      const dome: Point[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI - (i / 10) * Math.PI;
        dome.push([cx + Math.cos(a) * halfW, down(crownY + 14) - Math.sin(a) * r * 0.5]);
      }
      return (
        drawShape(dome, style, accent, look.line, { widthScale: 0.9 }) +
        drawShape(rectPoints(cx - halfW, down(crownY + 4), halfW * 2, Math.max(6, down(crownY + 15) - down(crownY + 4)), 3), style, accent, look.line, { widthScale: 0.8 })
      );
    }
    case 'brim': {
      const domeH = r * 0.55;
      return (
        // Flat crown …
        drawShape(rectPoints(cx - halfW * 0.78, down(crownY + 7) - domeH, halfW * 1.56, domeH, 4), style, accent, look.line, { widthScale: 0.9 }) +
        // … over a full-width brim.
        drawShape(ellipsePoints(cx, down(crownY + 7), halfW * 1.35, r * 0.13, 14), style, accent, look.line, { widthScale: 0.8 }) +
        drawStroke([[cx - halfW * 0.78, down(crownY + 7) - domeH * 0.35], [cx + halfW * 0.78, down(crownY + 7) - domeH * 0.35]], style, look.line, 2.5)
      );
    }
  }
}

/** How much headroom above the measured crown a hat needs, for face cropping. */
export function hatHeadroom(outfit: Outfit, headR: number): number {
  switch (outfit.hat) {
    case 'brim':
      return headR * 0.62;
    case 'beanie':
      return headR * 0.56;
    case 'cap':
      return headR * 0.48;
    default:
      return 0;
  }
}

// --- feet -----------------------------------------------------------------

/** Footwear at the end of a leg. Replaces the fixed ellipse foot. */
export function shoe(g: WardrobeGeometry, x: number): string {
  const style = activeStyle();
  const { outfit, look } = g;
  const y = g.hipY + g.legLen;
  const lw = g.limbW;

  switch (outfit.shoes) {
    case 'flat':
      return drawShape(
        [
          [x - lw * 0.5, y - lw * 0.18],
          [x + lw * 0.95, y - lw * 0.18],
          [x + lw * 1.05, y + lw * 0.22],
          [x - lw * 0.5, y + lw * 0.22],
        ],
        style, '#2b2f38', look.line,
      );
    case 'boot':
      return (
        drawShape(
          [
            [x - lw * 0.5, y - lw * 0.75],
            [x + lw * 0.45, y - lw * 0.75],
            [x + lw * 1.0, y - lw * 0.05],
            [x + lw * 1.05, y + lw * 0.3],
            [x - lw * 0.5, y + lw * 0.3],
          ],
          style, '#3f362c', look.line,
        ) + drawStroke([[x - lw * 0.4, y - lw * 0.4], [x + lw * 0.35, y - lw * 0.4]], style, look.line, 2)
      );
    case 'round':
    default:
      return drawShape(ellipsePoints(x + lw * 0.28, y, lw * 0.82, lw * 0.42, 10), style, '#2b2f38', look.line);
  }
}
