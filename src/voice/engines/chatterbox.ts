import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../../core/paths.ts';
import { modelEnv } from '../../core/models.ts';
import type { TtsEngine, SynthRequest, SynthResult, Availability } from '../types.ts';

// Deliberately not named chatterbox.py: Python puts a script's own directory
// first on sys.path, so a worker called chatterbox.py shadows the installed
// chatterbox package and makes its own import fail.
const SCRIPT = path.join(ROOT, 'src', 'voice', 'engines', 'chatterbox_worker.py');
const CACHE_PROBE = [
  'import torch',
  'from chatterbox.tts import ChatterboxTTS',
  'from huggingface_hub import hf_hub_download',
  "files=['ve.safetensors','t3_cfg.safetensors','s3gen.safetensors','tokenizer.json','conds.pt']",
  "for name in files: hf_hub_download(repo_id='ResembleAI/chatterbox', filename=name, local_files_only=True)",
  'print(torch.cuda.is_available())',
].join('\n');

/** The project venv, unless overridden. */
export function pythonPath(): string {
  return process.env['ANIM_PYTHON'] ?? path.join(ROOT, '.venv', 'Scripts', 'python.exe');
}

/** Model-cache routing shared by probes and real synthesis workers. */
export function chatterboxProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Project routing wins over an ambient cache variable. A stale HF_HOME is
  // otherwise enough for a real synthesis job to put gigabytes on C: even
  // though the availability probe used the correct location.
  return { ...base, ...modelEnv() };
}

interface PyEvent {
  event: 'loading' | 'loaded' | 'item' | 'error' | 'fatal' | 'warn' | 'done';
  id?: string;
  out?: string;
  durationMs?: number;
  error?: string;
  message?: string;
  device?: string;
  rendered?: number;
}

/**
 * Chatterbox TTS (Resemble AI), driven through a batched Python worker.
 *
 * Chosen over lighter engines for two properties this project actually uses:
 * an emotion-exaggeration control, which the compiler drives from each beat's
 * expression so a DEADPAN line is delivered deadpan; and zero-shot voice
 * cloning, so a character can be given a reference clip and sound like a
 * specific person rather than like a TTS preset.
 *
 * Returns audio only — no phoneme timing — so the orchestrator runs the result
 * through Rhubarb for lipsync.
 */
export class ChatterboxEngine implements TtsEngine {
  readonly name = 'chatterbox';

  async available(): Promise<Availability> {
    const py = pythonPath();
    try {
      await fs.access(py);
    } catch {
      return { ok: false, reason: `no Python at ${py}. Create it with: python -m venv .venv` };
    }

    const probe = await this.runPython(['-c', CACHE_PROBE]);
    if (probe.code !== 0) {
      return {
        ok: false,
        reason:
          `chatterbox or its explicitly cached model is unavailable in ${py}. ` +
          `Install/prefetch ResembleAI/chatterbox before rendering:\n${probe.stderr.split('\n').slice(-4).join('\n')}`,
      };
    }
    return { ok: true };
  }

  async synth(
    requests: SynthRequest[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, SynthResult>> {
    const results = new Map<string, SynthResult>();
    if (!requests.length) return results;

    const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-cb-'));
    const jobFile = path.join(jobDir, 'job.json');

    const items = requests.map((r) => ({
      id: r.id,
      // The engine writes straight to the cache location the orchestrator chose.
      out: r.out,
      text: r.text,
      exaggeration: r.exaggeration,
      cfg_weight: r.cfgWeight,
      ref: r.ref,
      seed: r.seed,
    }));

    await fs.writeFile(jobFile, JSON.stringify({ device: 'cuda', items }, null, 2), 'utf8');

    let done = 0;
    let fatal: string | null = null;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonPath(), [SCRIPT, jobFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: chatterboxProcessEnv(),
      });
      let buffer = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        // The worker emits one JSON object per line and flushes, so progress
        // arrives live instead of all at once when it exits.
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
            results.set(ev.id, { audio: ev.out, durationMs: ev.durationMs ?? 0, cues: null });
            onProgress?.(++done, requests.length);
          } else if (ev.event === 'fatal' || ev.event === 'error') {
            fatal = ev.error ?? 'unknown error';
          }
        }
      });

      proc.stderr.on('data', (d) => (stderr += String(d)));
      proc.on('error', (err) => reject(new Error(`could not run python: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`chatterbox failed: ${fatal ?? stderr.split('\n').slice(-6).join('\n')}`));
      });
    }).finally(() => fs.rm(jobDir, { recursive: true, force: true }).catch(() => {}));

    return results;
  }

  private runPython(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(pythonPath(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Keep model weights off the system drive; see src/core/models.ts.
        env: chatterboxProcessEnv(),
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += String(d)));
      proc.stderr.on('data', (d) => (stderr += String(d)));
      proc.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}
