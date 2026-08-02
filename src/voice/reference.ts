import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR } from '../core/paths.ts';
import { ffmpegPath } from '../render/encode.ts';
import { readWav, wavDurationMs } from './wav.ts';

/**
 * Voice-cloning reference clips.
 *
 * A reference is whatever the user gave us — a WAV off disk, or a WebM/Opus
 * blob straight out of the browser's MediaRecorder. Chatterbox wants neither of
 * those in the general case, so everything is normalised on arrival rather than
 * at synthesis time: one conversion, at upload, instead of a surprise failure
 * three minutes into a render.
 */

/** What Chatterbox is happiest with, and what the mixer already assumes. */
const TARGET_RATE = 24_000;

/** Long enough to carry a voice, short enough not to wander. */
export const IDEAL_SECONDS = { min: 4, max: 15 };

export interface ReferenceInfo {
  /** Filename relative to cast/, which is what the rig stores. */
  file: string;
  durationMs: number;
  /** Things that will make the clone worse, in plain language. Never fatal. */
  warnings: string[];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) =>
      reject(new Error(`could not run ffmpeg (${ffmpegPath()}): ${err.message}`)));
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr.split('\n').slice(-12).join('\n')}`)));
  });
}

/** Filename a character's reference clip always lives at. */
export function referencePath(character: string): string {
  return path.join(CAST_DIR, `${character}.ref.wav`);
}

/**
 * Normalise an uploaded clip into the character's reference slot.
 *
 * Always transcodes, even for a WAV that looks right: a 48kHz stereo float WAV
 * is still a WAV, and the failure mode of accepting it is a clone that sounds
 * subtly wrong rather than an error anyone can act on. Loudness is normalised
 * too, because a quiet reference produces a timid clone.
 */
export async function saveReference(
  character: string,
  data: Buffer,
  originalName: string,
): Promise<ReferenceInfo> {
  if (!data.length) throw new Error('the uploaded clip is empty');

  await fs.mkdir(CAST_DIR, { recursive: true });
  const out = referencePath(character);
  // ffmpeg cannot read and write the same path, and the source container is
  // whatever the browser felt like producing, so it lands beside the target
  // under its own extension first.
  const ext = path.extname(originalName).toLowerCase() || '.bin';
  const staging = path.join(CAST_DIR, `.${character}.upload${ext}`);

  await fs.writeFile(staging, data);
  try {
    await runFfmpeg([
      '-y', '-i', staging,
      '-ac', '1',
      '-ar', String(TARGET_RATE),
      '-c:a', 'pcm_s16le',
      // Broadcast loudness normalisation. A reference recorded at arm's length
      // from a laptop mic is otherwise far quieter than one recorded close.
      '-af', 'loudnorm=I=-18:TP=-2:LRA=11',
      out,
    ]);
  } finally {
    await fs.rm(staging, { force: true });
  }

  const durationMs = wavDurationMs(await readWav(out));
  return { file: path.basename(out), durationMs, warnings: referenceWarnings(durationMs) };
}

/**
 * What is wrong with a clip, in terms someone can act on.
 *
 * Advisory only. A three-second reference still clones, just worse, and refusing
 * it outright would be the tool deciding it knows better than the person who
 * recorded it.
 */
export function referenceWarnings(durationMs: number): string[] {
  const seconds = durationMs / 1000;

  if (seconds < IDEAL_SECONDS.min) {
    return [
      `only ${seconds.toFixed(1)}s of audio — ${IDEAL_SECONDS.min}-${IDEAL_SECONDS.max}s gives the ` +
        'cloner enough to work with, and shorter clips tend to come back flat',
    ];
  }
  if (seconds > IDEAL_SECONDS.max * 2) {
    return [
      `${seconds.toFixed(0)}s is longer than needed; the first ${IDEAL_SECONDS.max}s or so is what ` +
        'carries the voice, and a long clip mostly just slows synthesis',
    ];
  }
  return [];
}

export async function clearReference(character: string): Promise<void> {
  await fs.rm(referencePath(character), { force: true });
}
