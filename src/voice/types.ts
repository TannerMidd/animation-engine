import type { MouthCue } from './visemes.ts';

/** One line to synthesize. */
export interface SynthRequest {
  /** Stable id, used to match results back to requests. */
  id: string;
  /** Absolute path the engine must write the WAV to. The orchestrator owns caching. */
  out: string;
  text: string;
  /** Engine-specific voice selector. SAPI matches on substring; Chatterbox ignores it. */
  voice: string;
  /** SAPI speaking rate, -10..10. Ignored by neural engines. */
  rate: number;
  /**
   * Emotion intensity, 0..1. Mapped from the beat's expression, so a DEADPAN
   * line is actually delivered deadpan rather than just looking it.
   */
  exaggeration: number;
  /** Chatterbox classifier-free guidance. Lower is slower and more deliberate. */
  cfgWeight: number;
  /** Reference clip to clone the voice from, if the character has one. */
  ref: string | null;
  seed: number;
}

export interface SynthResult {
  /** Absolute path to the rendered WAV. */
  audio: string;
  durationMs: number;
  /**
   * Mouth timing, when the engine can supply it.
   *
   * SAPI reports viseme events during synthesis and so fills this in. Neural
   * engines return only audio, and the orchestrator sends those through Rhubarb
   * instead.
   */
  cues: MouthCue[] | null;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface TtsEngine {
  readonly name: string;
  /** Checked before use so a missing dependency is a clear message, not a stack trace. */
  available(): Promise<Availability>;
  /**
   * Synthesize a batch.
   *
   * Batched rather than per-line because loading a neural model costs seconds
   * and gigabytes; doing that per line would dominate the whole pipeline.
   */
  synth(requests: SynthRequest[], onProgress?: (done: number, total: number) => void): Promise<Map<string, SynthResult>>;
}
