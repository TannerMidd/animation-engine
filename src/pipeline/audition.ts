import path from 'node:path';
import { CAST_DIR } from '../core/paths.ts';
import { synthesizeLines, type LineTiming } from '../voice/index.ts';
import type { Rig } from '../schema/index.ts';

/**
 * Hear a character before committing to them.
 *
 * Voice cloning is the one part of the pipeline where you cannot tell whether it
 * worked by looking. Without this the loop is "upload a clip, render a whole
 * scene, listen, adjust" — minutes per attempt, for a decision that should take
 * seconds. Auditioning runs exactly the synthesis path a render would, on one
 * line, so what you hear is what you will get.
 */

/**
 * Lines that expose a voice quickly.
 *
 * Chosen for coverage rather than content: plosives, sibilants, a long vowel and
 * a question, in a sentence short enough to synthesize fast. Deadpan delivery is
 * hardest to fake and is the house register anyway.
 */
export const AUDITION_LINES = [
  "I'm going to need you to come in on Saturday.",
  'So that just happened, and nobody is going to talk about it.',
  'Right. And whose idea was that, exactly?',
  'Fine. Perfect. Absolutely no notes.',
];

export interface AuditionOptions {
  text?: string;
  expression?: string;
  engine?: string;
  /** Changes the take without changing the text — the "say it again" button. */
  seed?: number;
  /**
   * Audition with this reference instead of the character's committed one.
   * How voice candidates are heard before any of them is accepted.
   */
  refOverride?: string;
}

export interface AuditionResult {
  audio: string;
  durationMs: number;
  text: string;
  /** Whether this take came back from the cache rather than the engine. */
  cached: boolean;
}

export async function auditionVoice(rig: Rig, opts: AuditionOptions = {}): Promise<AuditionResult> {
  const text = (opts.text ?? AUDITION_LINES[0]!).trim();
  if (!text) throw new Error('an audition needs something to say');

  const before = Date.now();
  const timings: Map<string, LineTiming> = await synthesizeLines(
    [{
      id: 'audition',
      text,
      expression: opts.expression ?? 'DEADPAN',
      voice: rig.voice,
      rate: rig.voiceRate,
      ref: opts.refOverride ?? (rig.voiceRef ? path.join(CAST_DIR, rig.voiceRef) : null),
      persona: rig.voicePersona,
      seed: opts.seed ?? 1,
    }],
    { engine: opts.engine ?? 'chatterbox' },
  );

  const timing = timings.get('audition');
  if (!timing) throw new Error('the voice engine returned no audio for the audition line');

  return {
    audio: timing.audio,
    durationMs: timing.durationMs,
    text,
    // A cache hit is effectively instant; anything slower actually ran the model.
    cached: Date.now() - before < 500,
  };
}
