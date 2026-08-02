import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * PNG sequence -> MP4.
 *
 * Deliberately uses the plain numbered-image-sequence input rather than a
 * concat list with per-frame durations. The capture stage already materialises
 * every frame (held frames are cheap file copies), so ffmpeg never has to do
 * timestamp arithmetic — which is where image-sequence encodes usually go
 * wrong.
 */

export function ffmpegPath(): string {
  return process.env['FFMPEG'] ?? 'ffmpeg';
}

export interface EncodeOptions {
  framesDir: string;
  fps: number;
  out: string;
  /** Optional dialogue track. Video is trimmed to the shorter of the two. */
  audio?: string | null;
  /** Constant Rate Factor. Lower is better quality; 18 is visually lossless-ish. */
  crf?: number;
}

export async function encodeMp4(opts: EncodeOptions): Promise<string> {
  const { framesDir, fps, out } = opts;
  await fs.mkdir(path.dirname(out), { recursive: true });

  const args = ['-y', '-framerate', String(fps), '-i', path.join(framesDir, '%06d.png')];

  if (opts.audio) args.push('-i', opts.audio);

  args.push(
    '-c:v', 'libx264',
    '-crf', String(opts.crf ?? 18),
    '-preset', 'medium',
    // Flat vector art has hard edges and large uniform areas; yuv420p is what
    // every player expects, at the cost of some chroma detail on thin lines.
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
  );

  if (opts.audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');

  args.push(out);

  await runFfmpeg(args);
  return out;
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => {
      reject(
        new Error(
          `Could not run ffmpeg (${ffmpegPath()}): ${err.message}\n` +
            `Install a recent static build and put it on PATH, or set the FFMPEG env var.`,
        ),
      );
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      // ffmpeg is chatty on success too, so only the tail is useful on failure.
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split('\n').slice(-25).join('\n')}`));
    });
  });
}

/**
 * ffmpeg argv for the identity comparison reel: the same script rendered under
 * two identities, stacked top over bottom. Audio comes from the top input
 * alone — both halves speak the same lines, so mixing them is mush rather
 * than comparison.
 *
 * Every labelled filter output must be consumed by another filter or a -map;
 * ffmpeg rejects the whole graph over one dangling label.
 */
export function stackArgs(top: string, bottom: string, out: string): string[] {
  return [
    '-y', '-i', top, '-i', bottom,
    '-filter_complex',
    // Scaling both halves to one even-dimensioned size keeps vstack and
    // yuv420p happy no matter what frame size the identities rendered at.
    '[0:v]scale=1280:720[top];[1:v]scale=1280:720[bottom];[top][bottom]vstack=inputs=2[v]',
    '-map', '[v]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    out,
  ];
}

/** Reported for diagnostics — old builds work, but are worth flagging. */
export async function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += String(d)));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = out.match(/ffmpeg version (\S+)/);
      resolve(m ? m[1]! : null);
    });
  });
}
