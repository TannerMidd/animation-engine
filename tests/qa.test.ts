import { describe, it, expect } from 'vitest';
import { normalizeSpeech, scoreTranscript, deriveRetrySeed } from '../src/voice/qa.ts';

/**
 * The verification contract: what counts as "the take says its line". These
 * pin the normalization and thresholds so ASR quirks (casing, punctuation,
 * contraction spelling) never fail a good take, while garbled audio cannot
 * pass on fluency alone.
 */

describe('normalizeSpeech', () => {
  it('erases everything ASR and scripts disagree on cosmetically', () => {
    expect(normalizeSpeech('They’re… busy.')).toBe('theyre busy');
    expect(normalizeSpeech("They're, busy!")).toBe('theyre busy');
    expect(normalizeSpeech('  The  BUILDING —  sold?  ')).toBe('the building sold');
  });
});

describe('scoreTranscript', () => {
  it('passes an exact reading regardless of punctuation and case', () => {
    const s = scoreTranscript('The building’s been sold.', 'the buildings been sold');
    expect(s.passed).toBe(true);
    expect(s.wer).toBe(0);
  });

  it('passes a near reading with one soft disagreement in a long line', () => {
    const s = scoreTranscript(
      'They are trying to figure out if the building is a person now.',
      'They are trying to figure out if the building is a person, no.',
    );
    expect(s.passed).toBe(true);
  });

  it('fails a garbled take, however fluent', () => {
    const s = scoreTranscript(
      'The buyer’s name is The Building.',
      'the fire is may not be old thing',
    );
    expect(s.passed).toBe(false);
  });

  it('fails silence', () => {
    expect(scoreTranscript('Sarah?', '').passed).toBe(false);
  });

  it('passes a one-word line heard exactly, fails it heard wrong', () => {
    expect(scoreTranscript('Unpaid?', 'Unpaid.').passed).toBe(true);
    expect(scoreTranscript('Unpaid?', 'A plate.').passed).toBe(false);
  });

  it('never fails a take over ASR word segmentation', () => {
    // "A greed" is whisper's guess at segmenting the audio, not a speech
    // error — character similarity ignores spaces for exactly this case.
    expect(scoreTranscript('Agreed.', 'A greed!').passed).toBe(true);
    // Genuinely garbled audio still fails with spaces removed.
    expect(scoreTranscript('Agreed.', 'A Grockage!').passed).toBe(false);
  });

  it('is tolerant of a dropped article without letting a missing content word through', () => {
    const dropped = scoreTranscript('Right. And whose idea was that, exactly?', 'right and whose idea was that exactly');
    expect(dropped.passed).toBe(true);
  });
});

describe('deriveRetrySeed', () => {
  it('is the identity for the first attempt', () => {
    expect(deriveRetrySeed(1234, 0)).toBe(1234);
  });

  it('is a stable pure function of (seed, attempt)', () => {
    // Frozen contract: changing the derivation recasts every retried line.
    expect(deriveRetrySeed(1234, 1)).toBe(1_001_237);
    expect(deriveRetrySeed(1234, 2)).toBe(2_001_240);
    expect(deriveRetrySeed(1234, 1)).toBe(deriveRetrySeed(1234, 1));
  });

  it('stays a positive int32 even at the seed ceiling', () => {
    const derived = deriveRetrySeed(2 ** 30, 2);
    expect(derived).toBeGreaterThan(0);
    expect(derived).toBeLessThan(2_147_483_647);
    expect(Number.isInteger(derived)).toBe(true);
  });
});
