import { describe, it, expect } from 'vitest';
import {
  buildSynthRequest, deliveryFor, deliveryForLine, stabilizeRequest, estimateMouthCues,
  getEngine, ENGINE_NAMES, SAMPLING,
} from '../src/voice/index.ts';
import { chatterboxProcessEnv } from '../src/voice/engines/chatterbox.ts';
import { modelEnv } from '../src/core/models.ts';

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
      expect(d.temperature, name).toBeGreaterThanOrEqual(0.4);
      expect(d.temperature, name).toBeLessThanOrEqual(1);
    }
  });

  it('gives calm lines less sampling variance than hot ones', () => {
    // Low temperature keeps DEADPAN controlled; high lets SHOCKED actually move.
    expect(deliveryFor('DEADPAN').temperature).toBeLessThan(deliveryFor('SHOCKED').temperature);
  });

  it('propagates character persona into a cache-miss synthesis request', () => {
    const line = {
      id: 'line-1',
      text: 'This should sound like the character.',
      expression: 'JOY',
      voice: 'David',
      rate: 0,
      ref: null,
      persona: { energy: 0.6, pace: 1.4 },
      seed: 7,
    };

    const request = buildSynthRequest(line, 'take.wav');
    expect({ exaggeration: request.exaggeration, cfg: request.cfgWeight, temperature: request.temperature })
      .toEqual(deliveryFor(line.expression, line.persona));
    expect(request.exaggeration).not.toBe(deliveryFor(line.expression).exaggeration);
    expect(request.cfgWeight).not.toBe(deliveryFor(line.expression).cfg);
  });

  it('damps very short lines below the instability threshold', () => {
    // A one-word exclamation at full SHOCKED intensity garbles on every seed;
    // damped, it reads. The damp is part of the line's resolved delivery so
    // the cache key and the synthesis request cannot disagree about it.
    const short = { id: 'x', text: 'Unpaid?', expression: 'SHOCKED', voice: '', rate: 0, ref: null, seed: 1 };
    const d = deliveryForLine(short);
    expect(d.exaggeration).toBeLessThanOrEqual(0.55);
    expect(d.temperature).toBeLessThanOrEqual(0.7);
    expect(d.cfg).toBeGreaterThanOrEqual(0.4);

    const long = { ...short, text: 'This one has plenty of words to spread the energy across.' };
    expect(deliveryForLine(long)).toEqual(deliveryFor('SHOCKED'));
  });

  it('walks retries down the stability ladder, attempt 0 untouched', () => {
    const line = { id: 'x', text: 'The building has been sold to somebody.', expression: 'ANGRY', voice: '', rate: 0, ref: null, seed: 1 };
    const first = buildSynthRequest(line, 'take.wav');
    expect(stabilizeRequest(first, 0)).toBe(first);

    const second = stabilizeRequest(first, 1);
    const third = stabilizeRequest(first, 2);
    expect(second.exaggeration).toBeLessThan(first.exaggeration);
    expect(second.temperature).toBeLessThan(first.temperature);
    expect(third.exaggeration).toBeLessThanOrEqual(Math.min(second.exaggeration, 0.55));
    expect(third.temperature).toBe(0.6);
    expect(third.cfgWeight).toBe(0.45);
    // Text, voice and seed are the line's identity; the ladder never touches them.
    expect(third.text).toBe(first.text);
    expect(third.seed).toBe(first.seed);
  });

  it('pins the token-sampling knobs on every request', () => {
    // Pinned rather than defaulted: a chatterbox upgrade that moves its own
    // defaults must not change rendered audio while the cache claims currency.
    const request = buildSynthRequest(
      { id: 'x', text: 'hello', expression: 'NEUTRAL', voice: '', rate: 0, ref: null, seed: 1 },
      'take.wav',
    );
    expect(request).toMatchObject(SAMPLING);
  });
});

describe('Chatterbox process environment', () => {
  it('routes both probes and synthesis workers to the project model caches', () => {
    const env = chatterboxProcessEnv({ HF_HOME: 'C:\\wrong-cache', PATH: 'test-path' });
    expect(env).toMatchObject(modelEnv());
    expect(env['HF_HOME']).not.toBe('C:\\wrong-cache');
    expect(env['PATH']).toBe('test-path');
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
