import { describe, it, expect } from 'vitest';
import {
  EMOTION_WORDS,
  CANONICAL_EMOTION_KEYWORDS,
  EXPRESSION_FALLBACKS,
  expressionFor,
  supportable,
} from '../src/direct/emotions.ts';

/**
 * The parenthetical table is served to the editor as data. These tests hold the
 * two things that would quietly break if it were reordered or reworded: the
 * words the UI writes must still mean what the UI said they meant, and the
 * serialized form must resolve identically to the real function.
 */

const EXPRESSIONS = [...new Set(EMOTION_WORDS.map(([, expression]) => expression))];

describe('the parenthetical vocabulary', () => {
  it('offers a canonical word for every expression it can resolve', () => {
    expect(Object.keys(CANONICAL_EMOTION_KEYWORDS).sort()).toEqual([...EXPRESSIONS].sort());
  });

  it('resolves each canonical word to its own expression', () => {
    // Stricter than "matches its own pattern": an earlier pattern must not
    // claim it first. "happy" would have been fine here, "warm" would not.
    for (const [expression, keyword] of Object.entries(CANONICAL_EMOTION_KEYWORDS)) {
      expect(expressionFor(keyword, 'NEUTRAL'), `${keyword} -> ${expression}`).toBe(expression);
    }
  });

  it('resolves the canonical word inside a longer note', () => {
    expect(expressionFor('(deadpan, barely looking up)', 'NEUTRAL')).toBe('DEADPAN');
  });

  it('takes the first match in order, not the longest', () => {
    // Documented behaviour, and the reason the editor shows what a hand-typed
    // parenthetical resolved to: "not angry" is read as ANGRY.
    expect(expressionFor('not angry', 'NEUTRAL')).toBe('ANGRY');
    expect(expressionFor('quiet', 'NEUTRAL')).toBe('SAD');
  });

  it('falls back when nothing matches', () => {
    expect(expressionFor('doing a little dance', 'DEADPAN')).toBe('DEADPAN');
    expect(expressionFor(null, 'DEADPAN')).toBe('DEADPAN');
  });
});

describe('the serialized table', () => {
  // What GET /api/vocab ships, and what the composer replays.
  const wire = EMOTION_WORDS.map(([re, expression]) => ({ pattern: re.source, expression }));

  const UNMATCHED = 'NOTHING_MATCHED';

  function replay(parenthetical: string): string {
    const p = parenthetical.toLowerCase();
    for (const { pattern, expression } of wire) {
      if (new RegExp(pattern).test(p)) return expression;
    }
    return UNMATCHED;
  }

  it('resolves identically to expressionFor', () => {
    const samples = [
      ...Object.values(CANONICAL_EMOTION_KEYWORDS),
      'absolutely furious', 'side-eye', 'worn out', 'beyond caring', 'no emotion',
      'beat', 'a bit unsure', 'grinning', 'not angry', 'quiet', 'doing a little dance',
    ];
    for (const sample of samples) {
      expect(replay(sample), sample).toBe(expressionFor(sample, UNMATCHED));
    }
  });

  it('survives the round trip through a regex source string', () => {
    for (const [re, expression] of EMOTION_WORDS) {
      const rebuilt = new RegExp(re.source);
      expect(rebuilt.source).toBe(re.source);
      expect(rebuilt.test(CANONICAL_EMOTION_KEYWORDS[expression]!.toLowerCase())).toBe(true);
    }
  });
});

describe('expression fallbacks', () => {
  it('only name expressions the table can produce', () => {
    for (const [want, chain] of Object.entries(EXPRESSION_FALLBACKS)) {
      expect(EXPRESSIONS, want).toContain(want);
      for (const alt of chain) expect(EXPRESSIONS, `${want} -> ${alt}`).toContain(alt);
    }
  });

  it('terminate at an expression with no fallback of its own', () => {
    for (const start of Object.keys(EXPRESSION_FALLBACKS)) {
      const seen = new Set<string>([start]);
      let current = EXPRESSION_FALLBACKS[start]!.at(-1)!;
      while (EXPRESSION_FALLBACKS[current]) {
        expect(seen, `cycle through ${current}`).not.toContain(current);
        seen.add(current);
        current = EXPRESSION_FALLBACKS[current]!.at(-1)!;
      }
      expect(current).toBe('NEUTRAL');
    }
  });

  it('narrows to what a small rig can actually pull', () => {
    const small = new Set(['NEUTRAL', 'DEADPAN', 'SMUG']);
    expect(supportable('JOY', small, 'NEUTRAL')).toBe('SMUG');
    expect(supportable('EXHAUSTED', small, 'NEUTRAL')).toBe('DEADPAN');
    expect(supportable('SMUG', small, 'NEUTRAL')).toBe('SMUG');
  });

  it('lands on the resting face when the chain runs out', () => {
    const tiny = new Set(['DEADPAN']);
    expect(supportable('ANGRY', tiny, 'DEADPAN')).toBe('DEADPAN');
  });
});
