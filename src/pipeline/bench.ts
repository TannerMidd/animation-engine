import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR, OUT_DIR } from '../core/paths.ts';
import { listRigs, loadRig, type LoadedRig } from '../cast/store.ts';
import { AUDITION_LINES } from './audition.ts';
import {
  getEngine, synthesizeLines, readCachedLineMeta, type VoiceLine,
} from '../voice/index.ts';
import {
  chatterboxVcAvailable, checkConversionIdentity, convertPerformances,
} from '../voice/conversion.ts';

/**
 * Cast-wide voice quality, measured rather than assumed.
 *
 * The bench renders every referenced character through the real synthesis path
 * across the expression spread; the conversion check runs one performance into
 * every cast voice and scores what came back. Shared by `anim voices bench` /
 * `anim voices check` and the editor's Audition overlay.
 */

/** An engine (or the conversion runtime) declined to run; the reason is the message. */
export class EngineUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export const BENCH_EXPRESSIONS = ['DEADPAN', 'SUSPICIOUS', 'ANGRY', 'JOY'] as const;

export interface BenchLine {
  expression: string;
  text: string;
  /** Filename inside the character's bench folder. */
  file: string;
  qa: { passed: boolean; wer: number; transcript: string } | null;
}

export interface BenchCharacter {
  name: string;
  /** Provenance badge: "minted · <bank voice>", "recorded", "uploaded" or "unknown". */
  badge: string;
  refFile: string;
  lines: BenchLine[];
}

export interface BenchResult {
  engine: string;
  dir: string;
  htmlFile: string;
  characters: BenchCharacter[];
  renderedAt: string;
}

function benchDir(): string {
  return path.join(OUT_DIR, 'bench');
}

export function benchDataPath(): string {
  return path.join(benchDir(), 'bench.json');
}

/** The last bench run, if one exists on disk. */
export async function readBenchResult(): Promise<BenchResult | null> {
  try {
    return JSON.parse(await fs.readFile(benchDataPath(), 'utf8')) as BenchResult;
  } catch {
    return null;
  }
}

async function referencedTargets(only?: string[]): Promise<Array<{ name: string; ref: string; rig: LoadedRig['rig'] }>> {
  const filter = only?.length ? new Set(only) : null;
  const targets: Array<{ name: string; ref: string; rig: LoadedRig['rig'] }> = [];
  for (const name of (await listRigs()).filter((n) => !filter || filter.has(n))) {
    const { rig } = await loadRig(name);
    if (rig.voiceRef && path.basename(rig.voiceRef) === rig.voiceRef) {
      targets.push({ name, ref: path.join(CAST_DIR, rig.voiceRef), rig });
    }
  }
  return targets;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The standalone listening sheet, generated from the same data the editor renders. */
export function benchHtml(characters: BenchCharacter[]): string {
  const sections: string[] = [];
  for (const character of characters) {
    const rows = [
      `<div class="row"><span class="label">reference</span>` +
      `<audio controls preload="none" src="${esc(character.name)}/ref.wav"></audio><span class="text">what the engine clones</span></div>`,
    ];
    for (const line of character.lines) {
      const verdict = line.qa
        ? line.qa.passed
          ? ` · verified (wer ${line.qa.wer.toFixed(2)})`
          : ` · FAILED VERIFICATION (heard: ${line.qa.transcript || 'nothing'})`
        : '';
      rows.push(
        `<div class="row"><span class="label">${line.expression}</span>` +
        `<audio controls preload="none" src="${esc(character.name)}/${line.file}"></audio>` +
        `<span class="text">“${esc(line.text)}”${esc(verdict)}</span></div>`,
      );
    }
    sections.push(`<section><h2>${esc(character.name)} <small>${esc(character.badge)}</small></h2>${rows.join('')}</section>`);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>voice bench</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin: 1.6rem 0 .4rem; }
  h2 small { font-weight: normal; color: #777; font-size: .8rem; }
  .row { display: flex; align-items: center; gap: .8rem; margin: .3rem 0; }
  .label { width: 7rem; color: #555; font-size: .8rem; text-transform: lowercase; }
  .text { color: #999; font-size: .8rem; font-style: italic; }
  audio { height: 2rem; }
</style></head>
<body>
<h1>voice bench</h1>
<p>Every referenced character through the real synthesis path. Listen for: distinct registers across
the cast, no synthetic buzz or shifted formants against the reference, DEADPAN reading flat,
ANGRY reading hot without racing. Conversion is scored separately: <code>anim voices check --source &lt;wav&gt;</code>.</p>
${sections.join('\n')}
</body></html>
`;
}

export interface BenchOptions {
  only?: string[];
  engine?: string;
  /** Fires once the line list is known, before synthesis starts. */
  onStart?: (lines: number, characters: number) => void;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/**
 * Render the whole cast into one listening sheet.
 *
 * Reference quality is only auditable by ear, and per-character auditioning
 * hides cast-wide problems — two voices drifting into the same register, one
 * that races when it gets an ANGRY line. Fixed seeds: the bench compares
 * voices, not takes — and identical inputs mean a re-run after nothing changed
 * is all cache hits.
 */
export async function runVoicesBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const engine = opts.engine ?? 'chatterbox';
  const availability = await getEngine(engine).available();
  if (!availability.ok) throw new EngineUnavailableError(availability.reason.split('\n')[0]!);

  const targets = await referencedTargets(opts.only);
  if (!targets.length) {
    throw new Error('No cast member has a voice reference yet. Render once, or roll voices in the cast editor.');
  }

  const lines: VoiceLine[] = targets.flatMap(({ name, ref, rig }) =>
    BENCH_EXPRESSIONS.map((expression, i) => ({
      id: `${name}:${expression}`,
      text: AUDITION_LINES[i]!,
      expression,
      voice: rig.voice,
      rate: rig.voiceRate,
      ref,
      persona: rig.voicePersona,
      seed: i + 1,
    })));

  opts.onStart?.(lines.length, targets.length);
  const timings = await synthesizeLines(lines, { engine, onProgress: opts.onProgress });

  const dir = benchDir();
  const characters: BenchCharacter[] = [];
  for (const { name, ref, rig } of targets) {
    const characterDir = path.join(dir, name);
    await fs.mkdir(characterDir, { recursive: true });
    await fs.copyFile(ref, path.join(characterDir, 'ref.wav'));

    const rendered: BenchLine[] = [];
    for (let i = 0; i < BENCH_EXPRESSIONS.length; i++) {
      const expression = BENCH_EXPRESSIONS[i]!;
      const timing = timings.get(`${name}:${expression}`);
      if (!timing) continue;
      const file = `${expression}.wav`;
      await fs.copyFile(timing.audio, path.join(characterDir, file));
      const line = lines.find((l) => l.id === `${name}:${expression}`)!;
      const qa = (await readCachedLineMeta(engine, line))?.qa;
      rendered.push({
        expression,
        text: AUDITION_LINES[i]!,
        file,
        qa: qa ? { passed: qa.passed, wer: qa.wer, transcript: qa.transcript } : null,
      });
    }

    const provenance = rig.voiceProvenance;
    const badge = provenance?.source === 'minted'
      ? `minted · ${provenance.bankVoice ?? 'unknown base'}`
      : provenance?.source ?? 'unknown';
    characters.push({ name, badge, refFile: 'ref.wav', lines: rendered });
  }

  const htmlFile = path.join(dir, 'index.html');
  await fs.writeFile(htmlFile, benchHtml(characters), 'utf8');
  const result: BenchResult = {
    engine,
    dir,
    htmlFile,
    characters,
    renderedAt: new Date().toISOString(),
  };
  await fs.writeFile(benchDataPath(), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

export interface ConversionCheckRow {
  name: string;
  ok: boolean;
  /** The conversion returned nothing at all for this character. */
  missing: boolean;
  failures: string[];
  targetMedianPitchHz: number | null;
  conditioningLiftSemitones: number | null;
  outputMedianPitchHz: number | null;
  voicedRetention: number | null;
  pitchErrorSemitones: number | null;
  /** Filename inside copyDir when one was given; the conversion audio to audition. */
  file: string | null;
}

export interface ConversionCheckResult {
  source: string;
  rows: ConversionCheckRow[];
  failures: number;
  checkedAt: string;
}

export interface ConversionCheckOptions {
  /** A spoken performance; a few seconds of normal delivery is plenty. */
  source: string;
  only?: string[];
  /** When set, each conversion is copied here so it can be served and auditioned. */
  copyDir?: string;
  /** Fires once the target list is known, before conversion starts. */
  onStart?: (targets: number) => void;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Convert one performance into every cast voice and score the results.
 *
 * Aligning a performance to a character voice is the feature everything else
 * leans on, and whether it works is a property of each reference rather than
 * of the code — a voice the speaker encoder cannot read produces confident
 * noise. This runs the real conversion path per character and reports what
 * came back, so the answer is measured rather than assumed.
 */
export async function runVoicesCheck(opts: ConversionCheckOptions): Promise<ConversionCheckResult> {
  const available = await chatterboxVcAvailable();
  if (!available.ok) throw new EngineUnavailableError(available.reason.split('\n')[0]!);

  await fs.access(opts.source);

  const targets = await referencedTargets(opts.only);
  if (!targets.length) throw new Error('No cast member has a voice reference yet.');

  opts.onStart?.(targets.length);
  const results = await convertPerformances(
    targets.map((t) => ({
      id: t.name,
      source: opts.source,
      targetRef: t.ref,
      seed: 0,
      registerPolicy: 'adapt-to-character' as const,
    })),
    opts.onProgress,
  );

  if (opts.copyDir) await fs.mkdir(opts.copyDir, { recursive: true });

  const rows: ConversionCheckRow[] = [];
  let failures = 0;
  for (const { name } of targets) {
    const result = results.get(name);
    if (!result) {
      failures++;
      rows.push({
        name,
        ok: false,
        missing: true,
        failures: ['conversion returned no result'],
        targetMedianPitchHz: null,
        conditioningLiftSemitones: null,
        outputMedianPitchHz: null,
        voicedRetention: null,
        pitchErrorSemitones: null,
        file: null,
      });
      continue;
    }
    const check = checkConversionIdentity(result);
    if (check.failures.length) failures++;
    let file: string | null = null;
    if (opts.copyDir) {
      file = `${name}.wav`;
      await fs.copyFile(result.audio, path.join(opts.copyDir, file));
    }
    rows.push({
      name,
      ok: !check.failures.length,
      missing: false,
      failures: check.failures,
      targetMedianPitchHz: result.targetMedianPitchHz,
      conditioningLiftSemitones: result.conditioningLiftSemitones,
      outputMedianPitchHz: result.outputMedianPitchHz,
      voicedRetention: check.voicedRetention,
      pitchErrorSemitones: check.pitchErrorSemitones,
      file,
    });
  }

  return {
    source: opts.source,
    rows,
    failures,
    checkedAt: new Date().toISOString(),
  };
}
