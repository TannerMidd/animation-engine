/**
 * The parenthetical vocabulary.
 *
 * Its own module because two very different callers need it: the director,
 * which resolves what a writer typed, and the editor, which has to *offer* the
 * vocabulary rather than expect it to be memorised. Serving the same table to
 * both is the only way a chip in the UI and a word in a script can't disagree.
 */

/**
 * Parenthetical keywords to expressions.
 *
 * First match in this order wins — checked as a substring against the whole
 * parenthetical, lowercased. Order is therefore load-bearing: DEADPAN sits
 * first because "flat" and "beat" read as deadpan even inside a longer note,
 * and NEUTRAL sits last as the mildest reading. There is no negation, so
 * "(not angry)" resolves to ANGRY; the editor shows the resolved expression
 * next to the text so that surprise is visible rather than discovered at
 * render.
 */
export const EMOTION_WORDS: Array<[RegExp, string]> = [
  [/dead ?pan|flat|monotone|blank|no ?emotion|beat\b/, 'DEADPAN'],
  [/angry|annoyed|irritat|snap|furious|shout|yell|mad\b/, 'ANGRY'],
  [/shock|surpris|alarm|startl|horrifi|panic/, 'SHOCKED'],
  [/suspic|sceptic|skeptic|doubt|wary|dubious|unconvinced|side-?eye/, 'SUSPICIOUS'],
  [/smug|pleased|satisfi|smir|superior|proud/, 'SMUG'],
  [/exhaust|weary|drain|worn ?out|tired|hollow|beyond caring/, 'EXHAUSTED'],
  [/sad|defeat|deflat|quiet|small|resign|defl|miserab|glum/, 'SAD'],
  [/confus|puzzl|uncertain|lost|baffl|unsure/, 'CONFUSED'],
  [/delight|thrill|beam|grin|laugh|joy|gleeful|cheer|bright|happy|excited/, 'JOY'],
  [/warm|friendly|calm|even/, 'NEUTRAL'],
];

/**
 * The word to write when the choice was made by picking, not typing.
 *
 * Each one must resolve to its own expression under the first-match rule
 * above — which is stricter than "matches its own pattern", since an earlier
 * pattern could claim it first. "joyful" rather than "happy" and "calm" rather
 * than "warm" are the two that needed care. A test pins this.
 */
export const CANONICAL_EMOTION_KEYWORDS: Record<string, string> = {
  DEADPAN: 'deadpan',
  ANGRY: 'angry',
  SHOCKED: 'shocked',
  SUSPICIOUS: 'suspicious',
  SMUG: 'smug',
  EXHAUSTED: 'exhausted',
  SAD: 'sad',
  CONFUSED: 'confused',
  JOY: 'joyful',
  NEUTRAL: 'calm',
};

/**
 * Where to go when a rig lacks the expression a line asked for.
 *
 * A puppet drawn before an expression existed — or a hand-drawn one with a
 * deliberately small face set — should still get something in the spirit of the
 * line. Without this the compiler throws on a rig it has every right to accept,
 * which turns "I added a new expression" into "everyone's old characters are
 * broken".
 */
export const EXPRESSION_FALLBACKS: Record<string, string[]> = {
  JOY: ['SMUG', 'NEUTRAL'],
  SUSPICIOUS: ['SMUG', 'CONFUSED', 'DEADPAN'],
  EXHAUSTED: ['SAD', 'DEADPAN'],
  SHOCKED: ['CONFUSED', 'NEUTRAL'],
  SMUG: ['NEUTRAL'],
  ANGRY: ['NEUTRAL'],
  SAD: ['DEADPAN', 'NEUTRAL'],
  CONFUSED: ['NEUTRAL'],
  DEADPAN: ['NEUTRAL'],
};

export function expressionFor(parenthetical: string | null, fallback: string): string {
  if (!parenthetical) return fallback;
  const p = parenthetical.toLowerCase();
  for (const [re, expr] of EMOTION_WORDS) {
    if (re.test(p)) return expr;
  }
  return fallback;
}

/** Narrow a wanted expression to one the character can actually pull. */
export function supportable(want: string, available: Set<string>, resting: string): string {
  if (available.has(want)) return want;
  for (const alt of EXPRESSION_FALLBACKS[want] ?? []) {
    if (available.has(alt)) return alt;
  }
  if (available.has(resting)) return resting;
  return [...available][0] ?? want;
}
