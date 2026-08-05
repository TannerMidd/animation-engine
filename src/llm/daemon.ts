import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OLLAMA_MODELS } from '../core/models.ts';
import { Ollama, type LlmAvailability } from './ollama.ts';

/**
 * Starting the local model daemon, from inside the engine.
 *
 * Ollama is a separate process, which used to mean the engine could only ever
 * report that it was missing and leave somebody to go and start it. That is a
 * poor answer on its own, and it is a dangerous one here: the daemon decides
 * where model weights are written, from the environment *it* was launched with,
 * and a daemon started casually from a shortcut puts nine gigabytes on the
 * system drive. That has already happened on this machine, twice.
 *
 * So the engine starts it, and the reason to is precisely that it can set
 * `OLLAMA_MODELS` while doing so. A start button is not a convenience wrapped
 * around `ollama serve`; it is the only launch path that is guaranteed correct.
 */

/** Where an install puts the binary, if it is not on PATH. */
function candidates(): string[] {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  return [
    process.env['OLLAMA_BIN'] ?? '',
    ...(process.env['PATH'] ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, exe)),
    path.join(local, 'Programs', 'Ollama', exe),
    'C:\\Program Files\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
  ].filter(Boolean);
}

export function findOllama(): string | null {
  for (const candidate of candidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export interface DaemonStatus extends Record<string, unknown> {
  running: boolean;
  /** Present when it is not running but could be. */
  startable: boolean;
  binary: string | null;
  /** Where the daemon we start will keep weights. */
  modelsDir: string;
}

export async function daemonStatus(host?: string): Promise<DaemonStatus> {
  const running = (await new Ollama(host).available()).ok;
  const binary = findOllama();
  return { running, startable: !running && binary !== null, binary, modelsDir: OLLAMA_MODELS };
}

/** Poll until the daemon answers, or give up. */
async function waitForReady(host: string | undefined, timeoutMs: number): Promise<LlmAvailability> {
  const client = new Ollama(host);
  const deadline = Date.now() + timeoutMs;
  let last: LlmAvailability = { ok: false, reason: 'the daemon did not come up' };

  while (Date.now() < deadline) {
    last = await client.available();
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

export interface StartResult {
  ok: boolean;
  reason?: string;
  /** True when it was already up and nothing was launched. */
  alreadyRunning: boolean;
  modelsDir: string;
  models: string[];
}

/**
 * Start the daemon and wait for it to answer.
 *
 * Detached and with its output discarded, because it must outlive the request
 * that asked for it — this is a daemon, not a job. Already-running is a success
 * with nothing done rather than an error: the button means "I want this
 * available", and it already is.
 */
export async function startOllama(opts: { host?: string; timeoutMs?: number } = {}): Promise<StartResult> {
  const existing = await new Ollama(opts.host).available();
  if (existing.ok) {
    return {
      ok: true,
      alreadyRunning: true,
      modelsDir: OLLAMA_MODELS,
      models: existing.models.map((m) => m.name),
    };
  }

  const binary = findOllama();
  if (!binary) {
    return {
      ok: false,
      alreadyRunning: false,
      modelsDir: OLLAMA_MODELS,
      models: [],
      reason:
        'Ollama is not installed, or not where this can find it. Install it from https://ollama.com, ' +
        'or set OLLAMA_BIN to the executable.',
    };
  }

  await fs.promises.mkdir(OLLAMA_MODELS, { recursive: true });

  try {
    const child = spawn(binary, ['serve'], {
      // The whole point of starting it here. Without this the daemon falls back
      // to the user profile, which is the system drive on Windows.
      env: { ...process.env, OLLAMA_MODELS },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return {
      ok: false,
      alreadyRunning: false,
      modelsDir: OLLAMA_MODELS,
      models: [],
      reason: `could not start ${binary}: ${(err as Error).message}`,
    };
  }

  // Cold start loads no model, but the server still has to bind and read the
  // manifest directory, which is not instant on a store with several models.
  const ready = await waitForReady(opts.host, opts.timeoutMs ?? 20_000);
  if (!ready.ok) {
    return { ok: false, alreadyRunning: false, modelsDir: OLLAMA_MODELS, models: [], reason: ready.reason };
  }

  return {
    ok: true,
    alreadyRunning: false,
    modelsDir: OLLAMA_MODELS,
    models: ready.models.map((m) => m.name),
  };
}
