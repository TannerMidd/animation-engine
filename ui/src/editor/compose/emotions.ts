import type { EmotionVocab } from '../../types.ts';

/**
 * The parenthetical rule, replayed on what the server sent.
 *
 * Nothing here knows any words: the patterns and their order arrive from
 * /api/vocab, which serializes the director's own table. That is the whole
 * point — a chip in the composer and a word in a script resolve through the
 * same list, so the editor can promise what a line will play as.
 */

/** What a parenthetical resolves to, or null when nothing in the table claims it. */
export function resolveExpression(
  parenthetical: string | null,
  vocab: EmotionVocab | undefined,
): string | null {
  if (!parenthetical || !vocab) return null;
  const p = parenthetical.toLowerCase();
  for (const { pattern, expression } of vocab.words) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      continue;
    }
    if (re.test(p)) return expression;
  }
  return null;
}

export interface PlayedExpression {
  /** What actually reaches the screen, or null when it lands on the resting face. */
  plays: string | null;
  /** True when the rig couldn't do what was asked and something else stood in. */
  degraded: boolean;
}

/**
 * Narrow a wanted expression to what a rig can actually pull.
 *
 * Mirrors supportable() in src/direct/emotions.ts. `supported` is null for a
 * character with no rig on disk yet — they get a placeholder with the full set,
 * so there is nothing to warn about.
 */
export function playedExpression(
  want: string | null,
  supported: readonly string[] | null,
  fallbacks: Record<string, string[]> | undefined,
): PlayedExpression {
  if (!want) return { plays: null, degraded: false };
  if (!supported) return { plays: want, degraded: false };
  if (supported.includes(want)) return { plays: want, degraded: false };
  for (const alt of fallbacks?.[want] ?? []) {
    if (supported.includes(alt)) return { plays: alt, degraded: true };
  }
  return { plays: null, degraded: true };
}

/** "brent has no JOY — plays SMUG instead", or null when nothing is wrong. */
export function degradedReason(
  speaker: string,
  want: string,
  supported: readonly string[] | null,
  fallbacks: Record<string, string[]> | undefined,
): string | null {
  const { plays, degraded } = playedExpression(want, supported, fallbacks);
  if (!degraded) return null;
  const who = speaker.toLowerCase();
  return plays
    ? `${who} has no ${want} — plays ${plays} instead`
    : `${who} has no ${want} — plays their resting face`;
}
