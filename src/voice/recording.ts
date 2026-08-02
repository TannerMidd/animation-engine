import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sceneDir } from '../core/paths.ts';
import { ffmpegPath } from '../render/encode.ts';
import { encodeWav, readWav, toInt16, wavDurationMs } from './wav.ts';
import type { AudioAsset } from '../schema/dialogue.ts';

const ARCHIVE_RATE = 48_000;

export interface PerformanceCaptureInfo {
  takeId: string;
  rawAsset: string;
  normalizedAsset: string;
  rawHash: string;
  durationMs: number;
  sampleRate: number;
  peakDb: number;
  rmsDb: number;
  speechRatio: number;
  warnings: string[];
}

function safeId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dot, dash, or underscore`);
  }
  return value;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => reject(new Error(`could not run ffmpeg: ${err.message}`)));
    proc.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited ${code}:\n${stderr.split(/\r?\n/).slice(-10).join('\n')}`)));
  });
}

function dbfs(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

/**
 * Store an immutable browser/file recording and a deterministic 48 kHz PCM
 * derivative. No loudness normalization is applied: cadence and dynamics are
 * part of the creator's performance and final leveling happens later.
 */
export async function savePerformanceRecording(
  scene: string,
  lineId: string,
  takeId: string,
  data: Buffer,
  originalName: string,
): Promise<PerformanceCaptureInfo> {
  if (!data.length) throw new Error('the recording is empty');
  safeId(lineId, 'line id');
  safeId(takeId, 'take id');

  const rawHash = crypto.createHash('sha256').update(data).digest('hex');
  const dir = path.join(sceneDir(scene), 'dialogue', 'takes', lineId, takeId);
  await fs.mkdir(dir, { recursive: true });

  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const raw = path.join(dir, `raw-${rawHash.slice(0, 12)}${ext}`);
  const normalized = path.join(dir, 'performance.wav');

  // The hash-named raw file is immutable. Re-uploading identical bytes is a
  // no-op; changing the take creates a different take id at the API layer.
  try {
    await fs.access(raw);
  } catch {
    await fs.writeFile(raw, data, { flag: 'wx' });
  }

  const staging = path.join(dir, `.decode-${rawHash.slice(0, 12)}${ext}`);
  await fs.writeFile(staging, data);
  try {
    await runFfmpeg([
      '-y', '-i', staging,
      '-vn', '-ac', '1', '-ar', String(ARCHIVE_RATE), '-c:a', 'pcm_s16le',
      normalized,
    ]);
  } finally {
    await fs.rm(staging, { force: true });
  }

  const wav = await readWav(normalized);
  const samples = toInt16(wav, normalized);
  const durationMs = wavDurationMs(wav);
  let sumSq = 0;
  let peak = 0;
  let active = 0;
  // -42 dBFS is deliberately conservative: this is a capture warning, not a
  // VAD trim decision, and quiet consonants must not be called silence.
  const activeFloor = 32767 * Math.pow(10, -42 / 20);
  for (const sample of samples) {
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSq += sample * sample;
    if (abs >= activeFloor) active++;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length)) / 32767;
  const peakDb = dbfs(peak / 32767);
  const rmsDb = dbfs(rms);
  const speechRatio = active / Math.max(1, samples.length);

  const warnings: string[] = [];
  if (durationMs < 180) warnings.push('the take is too short to contain a reliable performed utterance');
  if (durationMs > 120_000) warnings.push('the take is over two minutes; use Scene Run segmentation or record a shorter pass');
  if (peakDb > -0.3) warnings.push('the input is at or near clipping');
  if (rmsDb < -38) warnings.push('the recording is very quiet');
  if (speechRatio < 0.08) warnings.push('very little speech was detected in this take');

  const relative = (file: string) => path.relative(sceneDir(scene), file).replace(/\\/g, '/');
  return {
    takeId,
    rawAsset: relative(raw),
    normalizedAsset: relative(normalized),
    rawHash,
    durationMs,
    sampleRate: wav.sampleRate,
    peakDb,
    rmsDb,
    speechRatio,
    warnings,
  };
}

export function performanceAssetPath(scene: string, relativeAsset: string): string {
  const root = path.resolve(sceneDir(scene));
  const resolved = path.resolve(root, relativeAsset);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('performance asset escapes the scene directory');
  }
  return resolved;
}

/** Decode and fingerprint a scene-local WAV for DialogueDocument provenance. */
export async function audioAssetForSceneFile(scene: string, relativeAsset: string): Promise<AudioAsset> {
  const file = performanceAssetPath(scene, relativeAsset);
  const [bytes, wav] = await Promise.all([fs.readFile(file), readWav(file)]);
  const bytesPerFrame = Math.max(1, (wav.bitsPerSample / 8) * wav.channels);
  return {
    file: relativeAsset.replace(/\\/g, '/'),
    checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    mediaType: 'audio/wav',
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    sampleCount: Math.round(wav.pcm.length / bytesPerFrame),
    durationMs: wavDurationMs(wav),
  };
}

/**
 * Materialise an exact, immutable slice of a longer performance recording.
 *
 * Scene Run keeps one raw take and points several cues into it. Voice
 * conversion must receive only the selected cue, however, so this creates a
 * content-addressed PCM derivative without changing the raw recording.
 */
export async function extractPerformanceSegment(
  scene: string,
  takeId: string,
  cueId: string,
  sourceAsset: string,
  inMs: number,
  outMs: number,
): Promise<string> {
  safeId(takeId, 'take id');
  safeId(cueId, 'cue id');
  const source = performanceAssetPath(scene, sourceAsset);
  const wav = await readWav(source);
  const samples = toInt16(wav, source);
  const totalFrames = Math.floor(samples.length / wav.channels);
  const startFrame = Math.max(0, Math.min(totalFrames - 1, Math.round((inMs / 1000) * wav.sampleRate)));
  const endFrame = Math.max(startFrame + 1, Math.min(totalFrames, Math.round((outMs / 1000) * wav.sampleRate)));
  const segment = samples.slice(startFrame * wav.channels, endFrame * wav.channels);
  const encoded = encodeWav(segment, wav.sampleRate, wav.channels);
  const digest = crypto.createHash('sha256').update(encoded).digest('hex');
  const relative = `dialogue/segments/${takeId}-${cueId}-${digest.slice(0, 16)}.wav`;
  const destination = performanceAssetPath(scene, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(destination, encoded, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return relative;
}
