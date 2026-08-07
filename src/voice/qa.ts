import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveApprovedModel } from '../core/model-manifest.ts';
import { ROOT } from '../core/paths.ts';
import { WHISPER_CACHE } from '../core/models.ts';
import { pythonPath, chatterboxProcessEnv } from './engines/chatterbox.ts';

/**
 * Generated-line verification.
 *
 * A neural take is sampled, and sampling sometimes garbles: swallowed words,
 * repeated syllables, a fluent noise that says nothing. Deterministic seeds
 * make every such failure *permanent* — the same broken take re-renders
 * forever — and nothing else in the pipeline reads the audio back. This
 * module is the missing check: transcribe the take locally, score it against
 * the script line, and let the orchestrator retry a failed take on a derived
 * seed. Only takes that demonstrably say their line enter the cache.
 */

const WHISPER_MODEL = 'small.en';
const SCRIPT = path.join(ROOT, 'src', 'voice', 'engines', 'whisper_worker.py');

export interface LineQa {
  passed: boolean;
  /** Word error rate against the script line, after normalization. */
  wer: number;
  /** Character-level similarity, the fuzzy backstop for very short lines. */
  similarity: number;
  transcript: string;
  /** Which synthesis attempt produced the accepted take (0 = first). */
  attempt: number;
}

/**
 * Retry seeds are a pure function of the line seed, so a retried take is as
 * reproducible as a first take. The constant is arbitrary but frozen:
 * changing it recasts every retried line in every scene.
 */
export function deriveRetrySeed(seed: number, attempt: number): number {
  if (attempt === 0) return seed;
  return (seed + attempt * 1_000_003) % 2_147_483_647;
}

/**
 * Fold script text and ASR output onto common ground: lowercase, letters and
 * digits only, apostrophes dropped rather than split ("they're" -> "theyre"),
 * whitespace collapsed. Whisper's punctuation and casing choices must never
 * count as errors.
 */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Score a transcript against the expected line.
 *
 * Pass = WER within a third, or character similarity ≥ 0.8. Two measures
 * because they fail differently: WER is meaningless on a one-word line (one
 * disagreement is 100%), and character similarity alone is too forgiving on
 * long lines where a whole word can vanish inside a high ratio.
 */
export function scoreTranscript(expected: string, transcript: string): Omit<LineQa, 'attempt'> {
  const want = normalizeSpeech(expected);
  const got = normalizeSpeech(transcript);

  if (!want) return { passed: true, wer: 0, similarity: 1, transcript };
  if (!got) return { passed: false, wer: 1, similarity: 0, transcript };

  const wantWords = want.split(' ');
  const gotWords = got.split(' ');
  const wer = levenshtein(wantWords, gotWords) / wantWords.length;

  // Spaces are dropped for the character measure: ASR word segmentation is
  // its own guess ("Agreed." heard as "A greed"), and a segmentation
  // disagreement is not a speech error.
  const wantChars = [...want.replace(/ /g, '')];
  const gotChars = [...got.replace(/ /g, '')];
  const chars = levenshtein(wantChars, gotChars);
  const similarity = 1 - chars / Math.max(wantChars.length, gotChars.length);

  return { passed: wer <= 0.34 || similarity >= 0.8, wer, similarity, transcript };
}

interface PyEvent {
  event: 'loading' | 'loaded' | 'item' | 'error' | 'fatal' | 'warn' | 'done';
  id?: string;
  transcript?: string;
  error?: string;
}

let memoAvailable: { ok: true } | { ok: false; reason: string } | undefined;

/**
 * Whether verification can run: the whisper package and the local checkpoint.
 * Memoized per process — synthesis may consult this once per round.
 */
export async function asrAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (memoAvailable) return memoAvailable;

  try {
    const model = await resolveApprovedModel('whisper-small-en');
    if (!model.files[`whisper/${WHISPER_MODEL}.pt`]) {
      throw new Error(`approved whisper-small-en manifest has no ${WHISPER_MODEL}.pt`);
    }
  } catch (error) {
    memoAvailable = {
      ok: false,
      reason:
        `${error instanceof Error ? error.message : String(error)}. Install and prefetch:\n` +
        `  .venv\\Scripts\\python -m pip install openai-whisper\n` +
        `  .venv\\Scripts\\python -c "import whisper; whisper.load_model('${WHISPER_MODEL}', download_root='${WHISPER_CACHE.replace(/\\/g, '/')}')"`,
    };
    return memoAvailable;
  }

  const probe = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn(pythonPath(), ['-c', 'import whisper, librosa'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: chatterboxProcessEnv(),
      cwd: os.tmpdir(),
    });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', (err) => resolve({ code: 1, stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });

  memoAvailable =
    probe.code === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `whisper is not importable in ${pythonPath()}: ${probe.stderr.split('\n').slice(-2).join(' ')}`,
        };
  return memoAvailable;
}

/** Transcribe a batch of WAVs. One worker spawn, one model load. */
export async function transcribeBatch(
  items: Array<{ id: string; wav: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (!items.length) return results;

  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-asr-'));
  const jobFile = path.join(jobDir, 'job.json');
  const model = await resolveApprovedModel('whisper-small-en');
  const modelPath = model.files[`whisper/${WHISPER_MODEL}.pt`];
  if (!modelPath) throw new Error(`approved whisper-small-en manifest has no ${WHISPER_MODEL}.pt`);
  await fs.writeFile(
    jobFile,
    JSON.stringify({ device: 'cuda', model_path: modelPath, items }, null, 2),
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
        if (ev.event === 'item' && ev.id !== undefined) {
          results.set(ev.id, ev.transcript ?? '');
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
      reject(new Error(`whisper failed: ${fatal ?? stderr.split('\n').slice(-6).join('\n')}`));
    });
  }).finally(() => fs.rm(jobDir, { recursive: true, force: true }).catch(() => {}));

  return results;
}
