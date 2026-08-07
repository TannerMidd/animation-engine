import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readModelManifest, resolveApprovedModel } from '../core/model-manifest.ts';
import { ROOT } from '../core/paths.ts';
import { modelEnv } from '../core/models.ts';
import { pythonPath } from './engines/chatterbox.ts';
import { readWav, toInt16, wavDurationMs } from './wav.ts';
import type { RegisterPolicy } from '../schema/dialogue.ts';

const SCRIPT = path.join(ROOT, 'src', 'voice', 'engines', 'chatterbox_vc_worker.py');
const CACHE_DIR = path.join(ROOT, '.cache', 'voice-conversion');
// 4: the register policy corrects the conversion's residual against the target
// instead of re-applying the source-to-target interval to an already-converted
// signal. Cached output from 3 and earlier is over-shifted and must not be reused.
// 5: references below the speaker encoder's floor are lifted into range for
// conditioning, which is the difference between a character voice and noise for
// every low-pitched member of a cast.
// 6: external silence is removed while the model runs and restored afterwards;
// short lines otherwise collapse even when the same target converts long lines.
const CACHE_VERSION = 6;

export interface VoiceConversionRuntimeProvenance {
  /** Hash of the worker, package RECORDs, and content-addressed model snapshot. */
  fingerprint: string;
  /** Installed Python distributions which can materially change conversion. */
  packageRevision: string;
  /** Hugging Face snapshot commit, or an explicit unavailable marker. */
  modelRevision: string;
}

export interface VoiceConversionRequest {
  id: string;
  source: string;
  targetRef: string;
  seed?: number;
  registerPolicy: RegisterPolicy;
}

export interface VoiceConversionResult {
  id: string;
  audio: string;
  durationMs: number;
  sampleRate: number;
  samples: number;
  sourceDurationMs: number;
  durationDeltaMs: number;
  cacheKey: string;
  registerPolicy: RegisterPolicy;
  registerShiftSemitones: number;
  /**
   * Semitones the target reference was lifted before conditioning. Non-zero
   * only for voices under the encoder's floor; the output still lands in the
   * character's own register.
   */
  conditioningLiftSemitones: number;
  sourceMedianPitchHz: number | null;
  targetMedianPitchHz: number | null;
  /** Where the conversion actually landed, after any register correction. */
  outputMedianPitchHz: number | null;
  /** Share of frames carrying detectable pitch, in the source and the output. */
  sourceVoicedRatio: number | null;
  outputVoicedRatio: number | null;
  warnings: string[];
  runtime: VoiceConversionRuntimeProvenance;
}

export interface ConversionAcousticQuality {
  sourceSpeechRatio: number;
  outputSpeechRatio: number;
  clippedSampleRatio: number;
  cadenceSimilarity: number;
  flags: string[];
}

interface WorkerEvent {
  event: 'loading' | 'loaded' | 'item' | 'error' | 'fatal' | 'warn' | 'done';
  id?: string;
  out?: string;
  durationMs?: number;
  sampleRate?: number;
  samples?: number;
  error?: string;
  message?: string;
  registerPolicy?: RegisterPolicy;
  registerShiftSemitones?: number;
  conditioningLiftSemitones?: number;
  sourceMedianPitchHz?: number | null;
  targetMedianPitchHz?: number | null;
  outputMedianPitchHz?: number | null;
  sourceVoicedRatio?: number | null;
  outputVoicedRatio?: number | null;
  warnings?: string[];
}

async function fileHash(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

let runtimeProvenance: Promise<VoiceConversionRuntimeProvenance> | null = null;

async function installedPackageRevision(): Promise<string> {
  const code = [
    'import hashlib, importlib.metadata as m, json',
    "names=['chatterbox-tts','torch','transformers','huggingface-hub','librosa']",
    'out={}',
    'for name in names:',
    '  try:',
    '    dist=m.distribution(name)',
    "    record=dist.read_text('RECORD') or ''",
    "    out[name]={'version':dist.version,'recordSha256':hashlib.sha256(record.encode()).hexdigest()}",
    '  except Exception as exc:',
    "    out[name]={'unavailable':type(exc).__name__}",
    "print(json.dumps(out,sort_keys=True,separators=(',',':')))",
  ].join('\n');
  return new Promise((resolve) => {
    const proc = spawn(pythonPath(), ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...modelEnv() },
      cwd: os.tmpdir(),
    });
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += String(chunk)));
    proc.on('error', () => resolve('python-runtime-unavailable'));
    proc.on('close', (exitCode) => resolve(
      exitCode === 0 && stdout.trim() ? stdout.trim() : 'python-runtime-unavailable',
    ));
  });
}

async function installedModelRevision(): Promise<string> {
  try {
    const manifest = await readModelManifest();
    const model = manifest.models.find((entry) => entry.id === 'chatterbox');
    return model?.repository
      ? `${model.repository}@${model.revision}`
      : 'approved-model-unavailable';
  } catch {
    return 'approved-model-unavailable';
  }
}

/** Exact local runtime identity used by both cache keys and release records. */
export function voiceConversionRuntimeProvenance(): Promise<VoiceConversionRuntimeProvenance> {
  runtimeProvenance ??= (async () => {
    const [packageRevision, modelRevision, workerHash] = await Promise.all([
      installedPackageRevision(),
      installedModelRevision(),
      fileHash(SCRIPT).catch(() => 'worker-unavailable'),
    ]);
    const fingerprint = crypto.createHash('sha256')
      .update([CACHE_VERSION, packageRevision, modelRevision, workerHash].join('\0'))
      .digest('hex');
    return { fingerprint, packageRevision, modelRevision };
  })();
  return runtimeProvenance;
}

function monoSamples(file: string, wav: Awaited<ReturnType<typeof readWav>>): Float64Array {
  const pcm = toInt16(wav, file);
  const frames = Math.floor(pcm.length / wav.channels);
  const out = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      sum += pcm[frame * wav.channels + channel] ?? 0;
    }
    out[frame] = sum / Math.max(1, wav.channels) / 32768;
  }
  return out;
}

function energyEnvelope(samples: Float64Array, sampleRate: number): number[] {
  const window = Math.max(1, Math.round(sampleRate * 0.02));
  const envelope: number[] = [];
  for (let start = 0; start < samples.length; start += window) {
    let sum = 0;
    const end = Math.min(samples.length, start + window);
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    envelope.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const peak = Math.max(1e-7, ...envelope);
  return envelope.map((value) => {
    const dbBelowPeak = 20 * Math.log10(Math.max(1e-7, value) / peak);
    return Math.max(0, Math.min(1, (dbBelowPeak + 48) / 48));
  });
}

function sampleEnvelope(values: number[], count: number): number[] {
  if (!values.length) return Array.from({ length: count }, () => 0);
  if (values.length === 1) return Array.from({ length: count }, () => values[0]!);
  return Array.from({ length: count }, (_, index) => {
    const at = (index / Math.max(1, count - 1)) * (values.length - 1);
    const lo = Math.floor(at);
    const hi = Math.min(values.length - 1, lo + 1);
    const mix = at - lo;
    return values[lo]! * (1 - mix) + values[hi]! * mix;
  });
}

/**
 * Cheap local QA that does not pretend to be speech recognition.
 *
 * It catches clipping, missing voiced regions, and collapsed/repeated pause
 * structure by comparing normalized 20 ms energy envelopes. Transcript
 * verification remains an explicit human/optional-ASR review item.
 */
export async function compareConversionAudio(
  sourceFile: string,
  outputFile: string,
): Promise<ConversionAcousticQuality> {
  const [sourceWav, outputWav] = await Promise.all([readWav(sourceFile), readWav(outputFile)]);
  const source = monoSamples(sourceFile, sourceWav);
  const output = monoSamples(outputFile, outputWav);
  const active = (samples: Float64Array) => {
    const threshold = Math.pow(10, -42 / 20);
    let count = 0;
    for (const value of samples) if (Math.abs(value) >= threshold) count++;
    return count / Math.max(1, samples.length);
  };
  let clipped = 0;
  for (const value of output) if (Math.abs(value) >= 0.999) clipped++;

  const points = 120;
  const sourceEnvelope = sampleEnvelope(energyEnvelope(source, sourceWav.sampleRate), points);
  const outputEnvelope = sampleEnvelope(energyEnvelope(output, outputWav.sampleRate), points);
  const cadenceSimilarity = Math.max(0, Math.min(1,
    1 - sourceEnvelope.reduce((sum, value, index) => sum + Math.abs(value - outputEnvelope[index]!), 0) / points,
  ));
  const sourceSpeechRatio = active(source);
  const outputSpeechRatio = active(output);
  const clippedSampleRatio = clipped / Math.max(1, output.length);
  const flags: string[] = [];
  if (outputSpeechRatio < 0.04) flags.push('converted output contains too little detected speech');
  if (sourceSpeechRatio > 0.08 && outputSpeechRatio < sourceSpeechRatio * 0.45) {
    flags.push('converted output appears to have lost voiced material');
  }
  if (clippedSampleRatio > 0.001) flags.push(`${(clippedSampleRatio * 100).toFixed(2)}% of converted samples are clipped`);
  if (cadenceSimilarity < 0.55) flags.push('converted pause/energy contour differs strongly from the performance');

  return { sourceSpeechRatio, outputSpeechRatio, clippedSampleRatio, cadenceSimilarity, flags };
}

/**
 * A conversion that kept less than this share of the source's voiced frames
 * has stopped being speech in the target voice. Measured on this engine, good
 * conversions retain 0.9-1.3 and collapsed ones sit at 0.2-0.5.
 */
export const CONVERSION_VOICED_RETENTION_FLOOR = 0.65;

/**
 * How far the conversion may land from the character's own register. The model
 * normally lands within a semitone; several semitones off means it did not
 * take the target speaker, whatever it did take.
 */
export const CONVERSION_PITCH_ERROR_CEILING_SEMITONES = 4;

export interface ConversionIdentityCheck {
  /** Output voiced-frame share over the source's. Null when unmeasurable. */
  voicedRetention: number | null;
  /** Distance from the target voice's register, in semitones. */
  pitchErrorSemitones: number | null;
  /** Human-readable reasons the conversion is not usable. Empty means usable. */
  failures: string[];
}

/**
 * Did the conversion actually become the character?
 *
 * Loudness and envelope checks cannot answer this: a collapsed conversion is
 * still loud and still follows the performance's energy contour. What it loses
 * is voicing, and where it lands in register.
 */
export function checkConversionIdentity(result: {
  sourceVoicedRatio: number | null;
  outputVoicedRatio: number | null;
  outputMedianPitchHz: number | null;
  targetMedianPitchHz: number | null;
}): ConversionIdentityCheck {
  const failures: string[] = [];
  const voicedRetention = result.sourceVoicedRatio && result.outputVoicedRatio !== null
      ? result.outputVoicedRatio / result.sourceVoicedRatio
      : null;
  const pitchErrorSemitones = result.outputMedianPitchHz && result.targetMedianPitchHz
      ? 12 * Math.log2(result.outputMedianPitchHz / result.targetMedianPitchHz)
      : null;

  if (voicedRetention !== null && voicedRetention < CONVERSION_VOICED_RETENTION_FLOOR) {
    failures.push(
      `the conversion lost ${Math.round((1 - voicedRetention) * 100)}% of the performance's voiced speech; ` +
        'it came out as noise rather than the character',
    );
  }
  if (pitchErrorSemitones !== null && Math.abs(pitchErrorSemitones) > CONVERSION_PITCH_ERROR_CEILING_SEMITONES) {
    failures.push(
      `the conversion landed ${Math.abs(pitchErrorSemitones).toFixed(1)} semitones from the character's own register; ` +
        'the target voice reference is likely outside what conversion can reproduce',
    );
  }
  return { voicedRetention, pitchErrorSemitones, failures };
}

/** Content key for a derived voice render. Paths never define identity. */
export async function voiceConversionCacheKey(request: VoiceConversionRequest): Promise<string> {
  const runtime = await voiceConversionRuntimeProvenance();
  return crypto
    .createHash('sha256')
    .update([
      CACHE_VERSION,
      await fileHash(request.source),
      await fileHash(request.targetRef),
      request.seed ?? 0,
      request.registerPolicy,
      runtime.fingerprint,
    ].join('\0'))
    .digest('hex');
}

export async function chatterboxVcAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await fs.access(pythonPath());
    await fs.access(SCRIPT);
  } catch {
    return { ok: false, reason: `voice-conversion runtime is missing (${pythonPath()})` };
  }

  try {
    await resolveApprovedModel('chatterbox');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return new Promise((resolve) => {
    const cacheProbe = ['from chatterbox.vc import ChatterboxVC', 'print("ok")'].join('\n');
    const proc = spawn(pythonPath(), ['-c', cacheProbe], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...modelEnv() },
      cwd: os.tmpdir(),
    });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => resolve({ ok: false, reason: err.message }));
    proc.on('close', (code) => resolve(
      code === 0
        ? { ok: true }
        : {
            ok: false,
            reason:
              'ChatterboxVC or its explicitly cached ResembleAI/chatterbox weights are unavailable; ' +
              (stderr.split(/\r?\n/).slice(-4).join('\n') || `probe exited ${code}`),
          },
    ));
  });
}

/**
 * Convert creator performances to character timbres in one model load.
 *
 * The operation is explicit and content-addressed. A failed conversion never
 * falls back to TTS or another character voice.
 */
export async function convertPerformances(
  requests: VoiceConversionRequest[],
  onProgress?: (done: number, total: number, message?: string) => void,
): Promise<Map<string, VoiceConversionResult>> {
  const out = new Map<string, VoiceConversionResult>();
  if (!requests.length) return out;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const runtime = await voiceConversionRuntimeProvenance();

  const misses: Array<VoiceConversionRequest & { cacheKey: string; output: string; sourceDurationMs: number }> = [];
  for (const request of requests) {
    await fs.access(request.source);
    await fs.access(request.targetRef);
    const cacheKey = await voiceConversionCacheKey(request);
    const output = path.join(CACHE_DIR, `${cacheKey}.wav`);
    const sourceDurationMs = wavDurationMs(await readWav(request.source));
    try {
      const wav = await readWav(output);
      const metadata = JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${cacheKey}.json`), 'utf8')) as {
        registerPolicy: RegisterPolicy;
        registerShiftSemitones: number;
        conditioningLiftSemitones: number;
        sourceMedianPitchHz: number | null;
        targetMedianPitchHz: number | null;
        outputMedianPitchHz: number | null;
        sourceVoicedRatio: number | null;
        outputVoicedRatio: number | null;
        warnings: string[];
        runtime: VoiceConversionRuntimeProvenance;
      };
      const durationMs = wavDurationMs(wav);
      const samples = Math.round(wav.pcm.length / Math.max(1, (wav.bitsPerSample / 8) * wav.channels));
      out.set(request.id, {
        id: request.id,
        audio: output,
        durationMs,
        sampleRate: wav.sampleRate,
        samples,
        sourceDurationMs,
        durationDeltaMs: durationMs - sourceDurationMs,
        cacheKey,
        ...metadata,
        runtime: metadata.runtime ?? runtime,
      });
    } catch {
      misses.push({ ...request, cacheKey, output, sourceDurationMs });
    }
  }

  if (!misses.length) return out;
  const availability = await chatterboxVcAvailable();
  if (!availability.ok) throw new Error(`Chatterbox voice conversion is unavailable: ${availability.reason}`);
  const model = await resolveApprovedModel('chatterbox');

  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-vc-'));
  const jobFile = path.join(jobDir, 'job.json');
  await fs.writeFile(jobFile, JSON.stringify({
    device: 'cuda',
    model_dir: model.root,
    items: misses.map((m) => ({
      id: m.id,
      source: m.source,
      target: m.targetRef,
      out: m.output,
      seed: m.seed ?? 0,
      registerPolicy: m.registerPolicy,
    })),
  }, null, 2), 'utf8');

  let fatal: string | null = null;
  let stderr = '';
  let buffer = '';
  let done = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonPath(), [SCRIPT, jobFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...modelEnv() },
        cwd: os.tmpdir(),
      });
      proc.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: WorkerEvent;
          try {
            event = JSON.parse(line) as WorkerEvent;
          } catch {
            continue;
          }
          if (event.event === 'item' && event.id && event.out) {
            const miss = misses.find((m) => m.id === event.id);
            if (!miss) continue;
            const durationMs = event.durationMs ?? 0;
            out.set(event.id, {
              id: event.id,
              audio: event.out,
              durationMs,
              sampleRate: event.sampleRate ?? 24_000,
              samples: event.samples ?? 0,
              sourceDurationMs: miss.sourceDurationMs,
              durationDeltaMs: durationMs - miss.sourceDurationMs,
              cacheKey: miss.cacheKey,
              registerPolicy: event.registerPolicy ?? miss.registerPolicy,
              registerShiftSemitones: event.registerShiftSemitones ?? 0,
              conditioningLiftSemitones: event.conditioningLiftSemitones ?? 0,
              sourceMedianPitchHz: event.sourceMedianPitchHz ?? null,
              targetMedianPitchHz: event.targetMedianPitchHz ?? null,
              outputMedianPitchHz: event.outputMedianPitchHz ?? null,
              sourceVoicedRatio: event.sourceVoicedRatio ?? null,
              outputVoicedRatio: event.outputVoicedRatio ?? null,
              warnings: event.warnings ?? [],
              runtime,
            });
            onProgress?.(++done, misses.length);
          } else if (event.event === 'warn') {
            onProgress?.(done, misses.length, event.message);
          } else if (event.event === 'fatal' || event.event === 'error') {
            fatal = event.error ?? 'unknown conversion error';
          }
        }
      });
      proc.stderr.on('data', (d) => (stderr += String(d)));
      proc.on('error', (err) => reject(new Error(`could not run voice conversion: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`voice conversion failed: ${fatal ?? stderr.split(/\r?\n/).slice(-8).join('\n')}`));
      });
    });
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }

  for (const miss of misses) {
    const result = out.get(miss.id);
    if (!result) throw new Error(`voice conversion returned no result for "${miss.id}"`);
    await fs.writeFile(path.join(CACHE_DIR, `${miss.cacheKey}.json`), JSON.stringify({
      registerPolicy: result.registerPolicy,
      registerShiftSemitones: result.registerShiftSemitones,
      conditioningLiftSemitones: result.conditioningLiftSemitones,
      sourceMedianPitchHz: result.sourceMedianPitchHz,
      targetMedianPitchHz: result.targetMedianPitchHz,
      outputMedianPitchHz: result.outputMedianPitchHz,
      sourceVoicedRatio: result.sourceVoicedRatio,
      outputVoicedRatio: result.outputVoicedRatio,
      warnings: result.warnings,
      runtime: result.runtime,
    }, null, 2), 'utf8');
  }
  return out;
}
