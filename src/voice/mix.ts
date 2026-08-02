import fs from 'node:fs/promises';
import path from 'node:path';
import { readWav, encodeWav, toInt16 } from './wav.ts';
import type { AudioPlacement } from '../compile/scene.ts';

/**
 * Assemble the dialogue track by placing each line at its beat offset.
 *
 * The offsets come from the same timeline the animation was compiled against,
 * so picture and sound cannot drift apart — they are generated from one source
 * of truth.
 *
 * Done natively rather than through ffmpeg's amix. Lines never overlap, so this
 * is sample placement rather than mixing, and it sidesteps amix's automatic
 * renormalisation as inputs drop out (which would make later lines creep
 * louder) along with the fact that its `normalize` option doesn't exist before
 * ffmpeg 4.4.
 */
export async function mixDialogue(
  placements: AudioPlacement[],
  durationMs: number,
  out: string,
): Promise<string> {
  await fs.mkdir(path.dirname(out), { recursive: true });

  // Nothing to place: still emit a silent track, so the mux has something to
  // hang the video's duration on.
  if (!placements.length) {
    const sampleRate = 22050;
    const silence = new Int16Array(Math.round((durationMs / 1000) * sampleRate));
    await fs.writeFile(out, encodeWav(silence, sampleRate, 1));
    return out;
  }

  const first = await readWav(placements[0]!.file);
  const { sampleRate, channels } = first;

  const total = Math.ceil((durationMs / 1000) * sampleRate) * channels;
  const mix = new Int16Array(total);

  for (const placement of placements) {
    const wav =
      placement.file === placements[0]!.file && placement === placements[0]
        ? first
        : await readWav(placement.file);

    if (wav.sampleRate !== sampleRate || wav.channels !== channels) {
      throw new Error(
        `${placement.file}: is ${wav.sampleRate}Hz/${wav.channels}ch but the track is ` +
          `${sampleRate}Hz/${channels}ch. Convert it first:\n` +
          `  ffmpeg -i "${placement.file}" -ar ${sampleRate} -ac ${channels} fixed.wav`,
      );
    }

    const samples = toInt16(wav, placement.file);
    const offset = Math.round((placement.startMs / 1000) * sampleRate) * channels;

    for (let i = 0; i < samples.length; i++) {
      const at = offset + i;
      if (at >= total) break;
      // Sum with a clamp. Lines shouldn't overlap, but a hand-edited shot list
      // can shorten a beat below its line's length, and clipping is a much
      // better failure than integer wraparound.
      const v = mix[at]! + samples[i]!;
      mix[at] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  }

  await fs.writeFile(out, encodeWav(mix, sampleRate, channels));
  return out;
}
