import { activeStyle } from '../style/index.ts';
import { grainOverlay } from '../style/wobble.ts';
import { renderText, measureText, supportedText } from './glyphs.ts';
import type { ShowIdentity } from '../schema/identity.ts';

/**
 * Title and end cards.
 *
 * The card is where a scene stops being a clip and starts being an episode of
 * something: name up front, hard cut to black at the end. Layout and colours
 * come from the identity's card template; the type is the engine's own glyph
 * alphabet, so the card carries the show's line treatment and depends on no
 * machine fonts.
 *
 * These render whole 1280x720 SVG documents. The compiler (M21) splices them
 * around the scene as frames; they are also directly previewable.
 */

const DEFAULT_CARD = { width: 1280, height: 720 } as const;
export interface CardDimensions { width: number; height: number }

/** Fit a size so the text spans at most `maxWidth`. */
function fitSize(text: string, ideal: number, maxWidth: number): number {
  const width = measureText(text, ideal);
  return width > maxWidth ? (ideal * maxWidth) / width : ideal;
}

function frame(identity: ShowIdentity, inner: string, width: number, height: number): string {
  const cards = identity.visual.cards;
  const style = activeStyle();
  const grain = style.grain > 0 ? grainOverlay({ ...style, grain: Math.max(style.grain, 0.06) }, 'card-grain', 0, 0, width, height) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${cards.paper}"/>
  ${inner}
  ${grain}
</svg>`;
}

/** The opening card: title over an accent rule, subtitle beneath. */
export function titleCardSvg(
  identity: ShowIdentity,
  title: string,
  sub?: string,
  dimensions: CardDimensions = DEFAULT_CARD,
): string {
  const { width: W, height: H } = dimensions;
  const cards = identity.visual.cards;
  const cleanTitle = supportedText(title).trim() || 'UNTITLED';
  const size = fitSize(cleanTitle, 96, W * 0.82);

  // Title bottom lands just above centre; the rule and subtitle stack below it
  // with real gaps, so nothing collides whatever size the fit chose.
  let inner = renderText(cleanTitle, {
    x: W / 2,
    y: H / 2 - 16 - size,
    size,
    colour: cards.ink,
    anchor: 'middle',
  });

  const ruleHalf = Math.min(measureText(cleanTitle, size) / 2 + 30, W * 0.42);
  inner += `<rect x="${W / 2 - ruleHalf}" y="${H / 2 + 4}" width="${ruleHalf * 2}" height="4" fill="${cards.accent}" opacity="0.85"/>`;

  if (sub) {
    const subClean = supportedText(sub).trim();
    if (subClean) {
      const subSize = fitSize(subClean, 30, W * 0.7);
      inner += renderText(subClean, {
        x: W / 2,
        y: H / 2 + 34,
        size: subSize,
        colour: cards.ink,
        anchor: 'middle',
        weight: 0.14,
      });
    }
  }

  return frame(identity, inner, W, H);
}

/** The end card. Abrupt by tradition. */
export function endCardSvg(identity: ShowIdentity, dimensions: CardDimensions = DEFAULT_CARD): string {
  const { width: W, height: H } = dimensions;
  const cards = identity.visual.cards;
  const text = supportedText(cards.endText).trim() || 'THE END';
  const size = fitSize(text, 72, W * 0.6);

  const inner = renderText(text, {
    x: W / 2,
    y: H / 2 - size / 2,
    size,
    colour: cards.ink,
    anchor: 'middle',
  });

  return frame(identity, inner, W, H);
}
