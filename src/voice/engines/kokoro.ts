import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveApprovedModel } from '../../core/model-manifest.ts';
import { ROOT } from '../../core/paths.ts';
import type { Availability } from '../types.ts';
import { pythonPath, chatterboxProcessEnv } from './chatterbox.ts';

/**
 * Kokoro-82M, used exclusively to mint character reference clips.
 *
 * Not a dialogue engine and deliberately not in ENGINE_NAMES: lines are still
 * synthesized by Chatterbox, which owns emotion control and cloning. Kokoro's
 * job is to hand Chatterbox a *natural human-sounding* voice to clone — its
 * curated voices replace the old SAPI/pitch-shift mint chain that was cloning
 * robotic prosody into every performance.
 */

// Not kokoro.py: a worker named after the package would shadow the installed
// package on sys.path and break its own import (same hazard as chatterbox).
const SCRIPT = path.join(ROOT, 'src', 'voice', 'engines', 'kokoro_mint_worker.py');

export interface KokoroMintItem {
  /** Stable id, used to match results back to requests. */
  id: string;
  /** Absolute path the worker must write the WAV to. */
  out: string;
  text: string;
  /** Bank voice name, e.g. "af_heart"; the first letter selects the language pipeline. */
  bankVoice: string;
  /** Kokoro's clean duration control, kept near 1. */
  speed: number;
  seed: number;
}

export interface KokoroMintResult {
  audio: string;
  durationMs: number;
}

interface PyEvent {
  event: 'loading' | 'loaded' | 'item' | 'error' | 'fatal' | 'warn' | 'done';
  id?: string;
  out?: string;
  durationMs?: number;
  error?: string;
  message?: string;
}

/**
 * Probe for the kokoro package and every voice the mint wants, offline.
 * Failure names the exact commands to run, because "unavailable" with no next
 * step is how model setups rot.
 */
export async function kokoroAvailable(voices: string[]): Promise<Availability> {
  const py = pythonPath();
  try {
    await fs.access(py);
  } catch {
    return { ok: false, reason: `no Python at ${py}. Create it with: python -m venv .venv` };
  }

  let model: Awaited<ReturnType<typeof resolveApprovedModel>>;
  try {
    model = await resolveApprovedModel('kokoro-82m');
    for (const voice of voices) {
      if (!model.files[`voices/${voice}.pt`]) {
        throw new Error(`voice "${voice}" is not in the approved kokoro-82m manifest`);
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const probe = ['from kokoro import KModel, KPipeline', 'print("ok")'].join('\n');

  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn(py, ['-c', probe], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Keep model weights off the system drive; see src/core/models.ts.
      env: chatterboxProcessEnv(),
      cwd: os.tmpdir(),
    });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => resolve({ code: 1, stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });

  if (result.code !== 0) {
    return {
      ok: false,
      reason:
        `kokoro or its cached voices are unavailable in ${py}. Install and prefetch first:\n` +
        `  .venv\\Scripts\\python -m pip install kokoro\n` +
        `  .venv\\Scripts\\python -c "from huggingface_hub import snapshot_download; ` +
        `snapshot_download(repo_id='hexgrad/Kokoro-82M', revision='${model.revision}', ` +
        `allow_patterns=['*.pth','config.json','voices/*.pt'])"\n` +
        result.stderr.split('\n').slice(-3).join('\n'),
    };
  }
  return { ok: true };
}

/** Render a batch of mint clips through the worker. One spawn per batch. */
export async function kokoroMint(
  items: KokoroMintItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, KokoroMintResult>> {
  const results = new Map<string, KokoroMintResult>();
  if (!items.length) return results;

  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-kokoro-'));
  const jobFile = path.join(jobDir, 'job.json');
  const model = await resolveApprovedModel('kokoro-82m');
  for (const item of items) {
    if (!model.files[`voices/${item.bankVoice}.pt`]) {
      throw new Error(`voice "${item.bankVoice}" is not in the approved kokoro-82m manifest`);
    }
  }
  await fs.writeFile(
    jobFile,
    JSON.stringify({ device: 'cpu', model_dir: model.root, items }, null, 2),
    'utf8',
  );

  let done = 0;
  let fatal: string | null = null;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pythonPath(), [SCRIPT, jobFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: chatterboxProcessEnv(),
      cwd: os.tmpdir(),
    });
    let buffer = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: PyEvent;
        try {
          ev = JSON.parse(line) as PyEvent;
        } catch {
          continue;
        }
        if (ev.event === 'item' && ev.id && ev.out) {
          results.set(ev.id, { audio: ev.out, durationMs: ev.durationMs ?? 0 });
          onProgress?.(++done, items.length);
        } else if (ev.event === 'fatal' || ev.event === 'error') {
          fatal = ev.error ?? 'unknown error';
        }
      }
    });

    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => reject(new Error(`could not run python: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`kokoro mint failed: ${fatal ?? stderr.split('\n').slice(-6).join('\n')}`));
    });
  }).finally(() => fs.rm(jobDir, { recursive: true, force: true }).catch(() => {}));

  return results;
}
