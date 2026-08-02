import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../core/paths.ts';
import type { MouthCue } from './visemes.ts';
import type { MouthShape } from '../schema/index.ts';

/**
 * Rhubarb Lip Sync adapter.
 *
 * Rhubarb analyses the audio itself, so unlike SAPI's synthesis-time viseme
 * events it works on anything — a neural TTS render, or a line you recorded
 * yourself. It emits exactly the A-X alphabet the rigs already speak, which is
 * why the mouth vocabulary was built around Rhubarb's set from the start rather
 * than around SAPI's.
 *
 * Passing the dialogue text as a hint measurably improves recognition, and we
 * always know exactly what was said — we wrote it.
 */

const CACHE_DIR = path.join(ROOT, '.cache', 'lipsync');

/** Bump when anything affecting cue output changes. */
const CACHE_VERSION = 1;

let cachedExe: string | null | undefined;

/** Locate rhubarb.exe: the RHUBARB env var, then the bundled tools folder. */
export async function findRhubarb(): Promise<string | null> {
  if (cachedExe !== undefined) return cachedExe;

  const fromEnv = process.env['RHUBARB'];
  if (fromEnv) {
    try {
      await fs.access(fromEnv);
      cachedExe = fromEnv;
      return cachedExe;
    } catch {
      throw new Error(`RHUBARB is set to "${fromEnv}" but nothing is there`);
    }
  }

  const toolsDir = path.join(ROOT, 'tools');
  try {
    for (const entry of await fs.readdir(toolsDir)) {
      const candidate = path.join(toolsDir, entry, 'rhubarb.exe');
      try {
        await fs.access(candidate);
        cachedExe = candidate;
        return cachedExe;
      } catch {
        // Keep looking.
      }
    }
  } catch {
    // No tools directory at all.
  }

  cachedExe = null;
  return null;
}

const VALID = new Set<string>(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X']);

interface RhubarbJson {
  metadata?: { duration?: number };
  mouthCues?: Array<{ start: number; end: number; value: string }>;
}

/**
 * Run Rhubarb over a WAV and return mouth cues in milliseconds.
 *
 * Cached by audio content plus dialogue text — Rhubarb takes a second or two
 * per line, which is fine once and irritating on every re-render.
 */
export async function rhubarbCues(wav: string, text: string): Promise<{ cues: MouthCue[]; durationMs: number }> {
  const exe = await findRhubarb();
  if (!exe) {
    throw new Error(
      'Rhubarb not found. Put rhubarb.exe under tools/, or set the RHUBARB env var.\n' +
        'Download: https://github.com/DanielSWolf/rhubarb-lip-sync/releases',
    );
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const audio = await fs.readFile(wav);
  const key = crypto
    .createHash('sha1')
    .update(String(CACHE_VERSION))
    .update(audio)
    .update(text)
    .digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  let raw: string;
  try {
    raw = await fs.readFile(cacheFile, 'utf8');
  } catch {
    const dialogFile = path.join(CACHE_DIR, `${key}.txt`);
    await fs.writeFile(dialogFile, text, 'utf8');

    await run(exe, ['-f', 'json', '-o', cacheFile, '-d', dialogFile, '--machineReadable', wav]);
    raw = await fs.readFile(cacheFile, 'utf8');
  }

  const parsed = JSON.parse(raw) as RhubarbJson;
  const cues: MouthCue[] = [];

  for (const cue of parsed.mouthCues ?? []) {
    const shape = VALID.has(cue.value) ? (cue.value as MouthShape) : 'X';
    const prev = cues[cues.length - 1];
    if (prev && prev.shape === shape) continue;
    cues.push({ ms: Math.round(cue.start * 1000), shape });
  }

  if (!cues.length || cues[0]!.ms > 0) cues.unshift({ ms: 0, shape: 'X' });

  return { cues, durationMs: Math.round((parsed.metadata?.duration ?? 0) * 1000) };
}

function run(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => reject(new Error(`could not run rhubarb: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      // Rhubarb logs progress to stderr even on success, so only the tail matters.
      else reject(new Error(`rhubarb exited ${code}:\n${stderr.split('\n').slice(-12).join('\n')}`));
    });
  });
}
