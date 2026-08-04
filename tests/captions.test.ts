import { describe, expect, it } from 'vitest';
import type { CompiledCaptionCue } from '../src/compile/scene.ts';
import {
  CAPTION_LINE_CHARACTERS,
  splitCaptionCue,
  splitCaptionCues,
  wrapCaptionLines,
} from '../src/compile/captions.ts';
import { evaluatePublishingSafety, subRip, webVtt } from '../src/pipeline/publish.ts';
import { PREFLIGHT_CODES } from '../src/pipeline/preflight.ts';
import { humanHint } from '../ui/src/editor/lib.ts';

/** The line that blocked production on the `test` scene: 76 characters, 3 lines. */
const LONG = 'The buyer’s name is “The Building.” The address is the same as the building.';

function cue(text: string, startMs = 1_000, endMs = 7_580): CompiledCaptionCue {
  return { id: 'line-19293i4', speaker: 'sarah', text, startMs, endMs };
}

describe('caption wrapping', () => {
  it('never exceeds the line width, and breaks a word only when it cannot fit', () => {
    for (const line of wrapCaptionLines(LONG)) {
      expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_CHARACTERS);
    }
    expect(wrapCaptionLines(LONG)).toHaveLength(3);

    const monster = 'x'.repeat(40);
    const lines = wrapCaptionLines(`say ${monster} now`);
    expect(lines[1]).toHaveLength(CAPTION_LINE_CHARACTERS);
    expect(lines.join('').replace(/ /g, '')).toContain(monster);
  });

  it('leaves a line that already fits alone', () => {
    expect(wrapCaptionLines('Morning.')).toEqual(['Morning.']);
  });
});

describe('splitting a caption too long to display', () => {
  it('produces cues that each fit the two-line budget', () => {
    const parts = splitCaptionCue(cue(LONG));
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(wrapCaptionLines(part.text).length).toBeLessThanOrEqual(2);
    }
    // Every character survives; only spaces become the line breaks the split
    // decided on. Nothing is invented and nothing is dropped.
    expect(parts.map((part) => part.text).join('\n').replace(/\s+/g, ' ')).toBe(LONG.replace(/\s+/g, ' '));
  });

  it('tiles the original window exactly, with no gap and no overhang', () => {
    const original = cue(LONG);
    const parts = splitCaptionCue(original);

    expect(parts[0]!.startMs).toBe(original.startMs);
    expect(parts.at(-1)!.endMs).toBe(original.endMs);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.startMs).toBe(parts[i - 1]!.endMs);
    }
    for (const part of parts) expect(part.endMs).toBeGreaterThan(part.startMs);
  });

  it('gives each piece time in proportion to its length rather than an equal slice', () => {
    const parts = splitCaptionCue(cue(LONG));
    const rates = parts.map((part) => part.text.length / (part.endMs - part.startMs));
    // Same reading rate throughout is the point: no piece is rushed to pay for
    // another. Allow a millisecond of rounding.
    expect(rates[0]!).toBeCloseTo(rates[1]!, 2);
  });

  it('keeps the beat id when a line does not need splitting', () => {
    const short = cue('Morning.');
    expect(splitCaptionCue(short)).toEqual([short]);
  });

  it('suffixes only the pieces after the first, so existing ids stay stable', () => {
    expect(splitCaptionCue(cue(LONG)).map((part) => part.id))
      .toEqual(['line-19293i4', 'line-19293i4~2']);
  });

  it('carries the split through the sidecars in order', () => {
    const cues = splitCaptionCues([cue(LONG)]);
    const vtt = webVtt(cues);
    const srt = subRip(cues);
    expect(vtt.match(/-->/g)).toHaveLength(2);
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain('\n2\n');
    expect(vtt.indexOf('The buyer')).toBeLessThan(vtt.indexOf('same as the building'));
  });
});

describe('publishing safety after the split', () => {
  it('passes the line that used to block production', () => {
    const report = evaluatePublishingSafety(splitCaptionCues([cue(LONG)]));
    expect(report.captions.violations).toEqual([]);
    expect(report.captions.ok).toBe(true);
  });

  it('still blocks captions that reach the check unsplit', () => {
    // The compiler splits before anything sees these, but preflight also
    // measures a fallback cue list built straight from beats when compilation
    // fails. The layout rule has to keep biting there.
    const report = evaluatePublishingSafety([cue(LONG)]);
    expect(report.captions.ok).toBe(false);
    expect(report.captions.violations[0]!.reason).toBe('too-many-lines');
    expect(report.captions.violations[0]!.estimatedLines).toBe(3);
  });

  it('breaks a word longer than a whole line without inventing a space', () => {
    const monster = 'x'.repeat(80);
    const parts = splitCaptionCues([cue(monster)]);
    expect(parts.map((part) => part.text).join('').replace(/\n/g, '')).toBe(monster);
    for (const part of parts) {
      expect(wrapCaptionLines(part.text).length).toBeLessThanOrEqual(2);
    }
  });

  it('flags a cue too brief to read without blocking on it', () => {
    // Fits the layout, but 54 characters in 600 ms is 90 per second.
    const report = evaluatePublishingSafety([cue('The buyer’s name is the same as the building', 0, 600)]);
    expect(report.captions.violations[0]!.reason).toBe('too-fast');
    expect(report.captions.violations[0]!.charactersPerSecond).toBeGreaterThan(25);
    expect(report.captions.ok).toBe(true);
  });

  it('does not punish a short line for being short', () => {
    const report = evaluatePublishingSafety([cue('Yes?', 0, 400)]);
    expect(report.captions.violations).toEqual([]);
  });

  it('skips the reading rate entirely when the windows are placeholders', () => {
    // Preflight's fallback stamps cues with their beat index, so every line
    // looks like it flashes past in a millisecond. Measuring that reports
    // nonsense — "44000 characters per second" — for every line in the scene.
    const placeholder = [cue('The buyer’s name is the same', 3, 4)];
    expect(evaluatePublishingSafety(placeholder).captions.violations[0]!.reason).toBe('too-fast');
    expect(evaluatePublishingSafety(placeholder, null, { timings: 'placeholder' }).captions.violations)
      .toEqual([]);
  });
});

describe('readiness repair hints', () => {
  it('explains every code preflight can raise', () => {
    const unexplained = PREFLIGHT_CODES.filter((code) => !humanHint(code)?.trim());
    expect(unexplained).toEqual([]);
  });
});
