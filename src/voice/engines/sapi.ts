import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../core/paths.ts';
import { parseSapiOutput } from '../visemes.ts';
import type { TtsEngine, SynthRequest, SynthResult, Availability } from '../types.ts';

const SAPI_SCRIPT = path.join(ROOT, 'src', 'voice', 'sapi.ps1');

/**
 * Windows SAPI.
 *
 * Kept as the zero-setup fallback: no downloads, no GPU, no Python, works on
 * any Windows box. It also reports viseme events during synthesis, so it is the
 * one engine that supplies its own mouth timing and never needs Rhubarb.
 *
 * The voices sound their age, which is exactly why it is the fallback and not
 * the default.
 */
export class SapiEngine implements TtsEngine {
  readonly name = 'sapi';

  async available(): Promise<Availability> {
    if (process.platform !== 'win32') return { ok: false, reason: 'SAPI is Windows-only' };
    try {
      await fs.access(SAPI_SCRIPT);
      return { ok: true };
    } catch {
      return { ok: false, reason: `missing ${SAPI_SCRIPT}` };
    }
  }

  async synth(
    requests: SynthRequest[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, SynthResult>> {
    const results = new Map<string, SynthResult>();
    let done = 0;

    // Serial rather than batched: SAPI is fast and has no model to load, so
    // there is nothing to amortise.
    for (const req of requests) {
      const textFile = `${req.out}.txt`;
      await fs.mkdir(path.dirname(req.out), { recursive: true });
      await fs.writeFile(textFile, req.text, 'utf8');

      const tsv = await this.run([
        '-TextFile', textFile,
        '-WavFile', req.out,
        '-Voice', req.voice,
        '-Rate', String(req.rate),
      ]);

      const parsed = parseSapiOutput(tsv);
      if (parsed.durationMs <= 0) {
        throw new Error(`SAPI produced no audio for "${req.id}". Text: ${JSON.stringify(req.text)}`);
      }

      await fs.writeFile(`${req.out}.tsv`, tsv, 'utf8');
      results.set(req.id, { audio: req.out, durationMs: parsed.durationMs, cues: parsed.cues });
      onProgress?.(++done, requests.length);
    }

    return results;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAPI_SCRIPT, ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.stderr.on('data', (d) => (err += String(d)));
      proc.on('error', (e) => reject(new Error(`could not run powershell: ${e.message}`)));
      proc.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`SAPI synthesis failed (exit ${code}):\n${err.trim() || out.trim()}`));
      });
    });
  }
}

/** List installed SAPI voice names. */
export async function listSapiVoices(): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Speech; ' +
          '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
          'ForEach-Object { $_.VoiceInfo.Name }',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += String(d)));
    proc.on('error', () => resolve([]));
    proc.on('close', () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}
