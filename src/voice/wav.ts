import fs from 'node:fs/promises';

/**
 * Minimal PCM WAV reader and writer.
 *
 * The dialogue track is assembled here rather than in ffmpeg because the mix is
 * genuinely trivial — lines never overlap, so it is sample placement, not
 * mixing — and doing it natively gives sample-accurate offsets with no
 * dependency on which ffmpeg filters a given build happens to ship.
 */

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Raw PCM payload. */
  pcm: Buffer;
}

export function decodeWav(buf: Buffer, label = 'wav'): WavData {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label}: not a RIFF/WAVE file`);
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Buffer | null = null;

  // Walk the chunk list rather than assuming a 44-byte header — real recorders
  // routinely insert LIST or fact chunks before the data.
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      pcm = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    off = body + size + (size % 2);
  }

  if (!pcm || !sampleRate || !channels) throw new Error(`${label}: missing fmt or data chunk`);
  return { sampleRate, channels, bitsPerSample, pcm };
}

export async function readWav(file: string): Promise<WavData> {
  return decodeWav(await fs.readFile(file), file);
}

export function wavDurationMs(w: WavData): number {
  const bytesPerFrame = (w.bitsPerSample / 8) * w.channels;
  return Math.round((w.pcm.length / bytesPerFrame / w.sampleRate) * 1000);
}

export function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');

  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);

  return buf;
}

/** 16-bit PCM as signed samples. */
export function toInt16(w: WavData, label = 'wav'): Int16Array {
  if (w.bitsPerSample !== 16) {
    throw new Error(`${label}: expected 16-bit PCM, got ${w.bitsPerSample}-bit`);
  }
  const out = new Int16Array(w.pcm.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = w.pcm.readInt16LE(i * 2);
  return out;
}
