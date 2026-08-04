import type { CompiledCaptionCue } from './scene.ts';

/**
 * Caption layout policy, and the split that makes a long line obey it.
 *
 * A caption cue has to fit inside a small, fixed budget on a phone. A line of
 * dialogue has no such obligation — so when a character says something long,
 * the answer is not to rewrite the dialogue, it is to show the caption as
 * several cues in sequence across the line's own speech window. That is what
 * captioning has always done; the two-line limit is per *displayed cue*, not
 * per line of script.
 *
 * Everything downstream reads `CompiledScene.captions`, so splitting once at
 * compile time gives the WebVTT, the SubRip, the export manifest, the safety
 * check and the editor overlay the same release-shaped cues.
 */

export const CAPTION_LINE_CHARACTERS = 32;
export const CAPTION_MAX_LINES = 2;

/**
 * The maximum reading rate a cue may demand, in characters per second.
 *
 * Deliberately not paired with a minimum on-screen duration: a short line is
 * on screen exactly as long as it is spoken, and there is nothing wrong with
 * that. What is worth flagging is text crammed into a window too brief to read
 * it — which is a thing splitting can produce, and a floor would not catch.
 */
export const CAPTION_MAX_CHARACTERS_PER_SECOND = 25;

/**
 * Wrap to the mobile caption width.
 *
 * A word longer than the whole line is broken across lines rather than
 * overflowing — the only case where the wrapper is allowed to split a word.
 */
export function wrapCaptionLines(text: string, maxCharacters = CAPTION_LINE_CHARACTERS): string[] {
  const words = text.replace(/[\r\n\0]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxCharacters) {
      if (current) lines.push(current);
      let rest = word;
      while (rest.length > maxCharacters) {
        lines.push(rest.slice(0, maxCharacters));
        rest = rest.slice(maxCharacters);
      }
      current = rest;
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharacters) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Rendered line count under the deterministic wrapping policy above. */
export function captionLineCount(text: string, maxCharacters = CAPTION_LINE_CHARACTERS): number {
  return wrapCaptionLines(text, maxCharacters).length;
}

/**
 * One cue in, one or more out — each within the line budget, tiling the
 * original window exactly.
 *
 * Chunks are given time in proportion to their length, so a long chunk is not
 * rushed to give a short one the same slice.
 *
 * Lines within a chunk are joined by a newline rather than a space: the break
 * is a decision this function has already made, and a space would invent a
 * character that was never in the dialogue when the wrapper had to break a
 * word too long to fit.
 */
export function splitCaptionCue(
  cue: CompiledCaptionCue,
  maxCharacters = CAPTION_LINE_CHARACTERS,
  maxLines = CAPTION_MAX_LINES,
): CompiledCaptionCue[] {
  const lines = wrapCaptionLines(cue.text, maxCharacters);
  if (lines.length <= maxLines) return [cue];

  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }

  const weights = chunks.map((chunk) => Math.max(1, chunk.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = cue.endMs - cue.startMs;

  const out: CompiledCaptionCue[] = [];
  let consumed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const startMs = cue.startMs + Math.round((span * consumed) / total);
    consumed += weights[i]!;
    // The last chunk lands on the original end rather than an accumulated
    // rounding of it, so the pieces tile the window with no gap or overhang.
    const endMs = i === chunks.length - 1
      ? cue.endMs
      : cue.startMs + Math.round((span * consumed) / total);
    out.push({
      ...cue,
      // A line that never splits keeps its beat id, so ids stay stable for
      // every scene this does not affect.
      id: i === 0 ? cue.id : `${cue.id}~${i + 1}`,
      text: chunks[i]!,
      startMs,
      endMs,
    });
  }
  return out;
}

/** Apply the split across a whole scene's captions, preserving order. */
export function splitCaptionCues(
  cues: readonly CompiledCaptionCue[],
  maxCharacters = CAPTION_LINE_CHARACTERS,
  maxLines = CAPTION_MAX_LINES,
): CompiledCaptionCue[] {
  return cues.flatMap((cue) => splitCaptionCue(cue, maxCharacters, maxLines));
}
