import { describe, it, expect } from 'vitest';
import { deliveryFor, estimateMouthCues, getEngine, ENGINE_NAMES } from '../src/voice/index.ts';

describe('delivery mapping', () => {
  it('delivers a deadpan line flatter than an angry one', () => {
    // The point of driving the engine from the director's expression: a DEADPAN
    // line should be performed deadpan, not merely drawn that way.
    expect(deliveryFor('DEADPAN').exaggeration).toBeLessThan(deliveryFor('ANGRY').exaggeration);
  });

  it('slows a deadpan line down', () => {
    // Lower guidance weight reads as more deliberate — the comic pause built in.
    expect(deliveryFor('DEADPAN').cfg).toBeLessThan(deliveryFor('SHOCKED').cfg);
  });

  it('falls back to neutral for an unknown expression', () => {
    expect(deliveryFor('BEWILDERED')).toEqual(deliveryFor('NEUTRAL'));
  });

  it('keeps every expression in range for the engine', () => {
    for (const name of ['DEADPAN', 'SAD', 'CONFUSED', 'NEUTRAL', 'SMUG', 'ANGRY', 'SHOCKED']) {
      const d = deliveryFor(name);
      expect(d.exaggeration, name).toBeGreaterThan(0);
      expect(d.exaggeration, name).toBeLessThanOrEqual(1);
      expect(d.cfg, name).toBeGreaterThan(0);
      expect(d.cfg, name).toBeLessThanOrEqual(1);
    }
  });
});

describe('engine registry', () => {
  it('constructs every advertised engine', () => {
    for (const name of ENGINE_NAMES) expect(getEngine(name).name).toBe(name);
  });

  it('rejects an unknown engine by name, listing the options', () => {
    expect(() => getEngine('elevenlabs')).toThrow(/chatterbox/);
  });
});

describe('estimateMouthCues', () => {
  it('starts closed and never repeats a shape back to back', () => {
    const cues = estimateMouthCues('Morning, Paul.', 1200);
    expect(cues[0]).toEqual({ ms: 0, shape: 'X' });
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.shape).not.toBe(cues[i - 1]!.shape);
    }
  });

  it('stays within the line duration', () => {
    const cues = estimateMouthCues('Since when.', 800);
    expect(Math.max(...cues.map((c) => c.ms))).toBeLessThanOrEqual(800);
  });

  it('survives text with no letters in it', () => {
    expect(estimateMouthCues('...', 500)).toEqual([{ ms: 0, shape: 'X' }]);
  });
});
