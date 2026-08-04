import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PROPS_DIR, ROOT } from '../core/paths.ts';
import { findBlender, blenderAvailable, blenderProcessEnv } from '../render/blender.ts';
import { loadBakedProps, PALETTE_SLOTS, BAKE_BUDGET, PropDocument, countView } from '../sets/props/baked.ts';

/**
 * The prop foundry.
 *
 * Runs Blender headlessly to turn a procedural source file into the flat
 * polylines a prop is made of. This is an authoring step, not a render step: its
 * output is committed, so nothing here runs when a scene renders and a checkout
 * without Blender can still draw every prop in the catalogue.
 */

const WORKER = path.join(ROOT, 'src', 'render', 'prop_bake_worker.py');

export class BlenderUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Blender unavailable — ${reason}`);
    this.name = 'BlenderUnavailableError';
  }
}

export interface BakeSource {
  key: string;
  dir: string;
  build: string;
  config: string;
  out: string;
}

/** Hash of everything that determines the output, so a stale bake is visible. */
export async function sourceHash(source: BakeSource): Promise<string> {
  const hash = crypto.createHash('sha1');
  for (const file of [source.build, source.config]) {
    hash.update(await fs.readFile(file));
  }
  return `sha1:${hash.digest('hex')}`;
}

export async function listSources(dir: string = PROPS_DIR): Promise<BakeSource[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const out: BakeSource[] = [];
  for (const key of entries) {
    const propDir = path.join(dir, key);
    const build = path.join(propDir, 'build.py');
    const config = path.join(propDir, 'bake.json');
    try {
      await fs.access(build);
      await fs.access(config);
    } catch {
      // A directory with baked geometry but no source is fine — hand-authored
      // reference props live that way, and they simply cannot be re-baked.
      continue;
    }
    out.push({ key, dir: propDir, build, config, out: path.join(propDir, `${key}.geo.json`) });
  }
  return out;
}

export interface BakedPropSummary {
  key: string;
  label: string;
  shapes: number;
  points: number;
  views: string[];
  /** Null when there is no procedural source to compare against. */
  stale: boolean | null;
  error: string | null;
}

/**
 * What is on disk, and whether it still matches its source.
 *
 * Bakes are not reproducible across Blender versions — projection is float
 * arithmetic and the mesh operators are free to improve. That does not threaten
 * render determinism, because the geometry is committed, but it does mean
 * "re-bake and commit" is a decision rather than a no-op, so drift is surfaced
 * rather than hidden.
 */
export async function listBakedProps(dir: string = PROPS_DIR): Promise<BakedPropSummary[]> {
  const sources = new Map((await listSources(dir)).map((s) => [s.key, s]));
  const out: BakedPropSummary[] = [];

  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  for (const key of entries) {
    const file = path.join(dir, key, `${key}.geo.json`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      out.push({
        key, label: key, shapes: 0, points: 0, views: [], stale: null,
        error: 'no baked geometry — run `anim props bake ' + key + '`',
      });
      continue;
    }

    try {
      // Through the real schema rather than a hand-rolled shape: a document may
      // be format 1 shapes or format 2 primitives, and counting them is the
      // loader's job in both cases.
      const parsed = PropDocument.parse(JSON.parse(raw));
      // Declaration order, not sorted — the first view is the prop's normal
      // appearance, and sorting would make that an accident of naming.
      const views = Object.keys(parsed.views);
      let shapes = 0;
      let points = 0;
      for (const view of Object.values(parsed.views)) {
        const counted = countView(view);
        shapes += counted.shapes;
        points += counted.points;
      }
      const source = sources.get(key);
      const stale = source ? (await sourceHash(source)) !== parsed.provenance.source : null;
      out.push({ key, label: parsed.label, shapes, points, views, stale, error: null });
    } catch (err) {
      out.push({ key, label: key, shapes: 0, points: 0, views: [], stale: null, error: (err as Error).message });
    }
  }

  return out;
}

export interface BakeResult {
  key: string;
  out: string;
  views: Array<{ name: string; shapes: number; points: number }>;
  warnings: string[];
}

export interface BakeOptions {
  onProgress?: (done: number, total: number) => void;
  onLog?: (message: string) => void;
}

interface WorkerEvent {
  kind: string;
  message?: string;
  id?: string;
  shapes?: number;
  points?: number;
  total?: number;
  objects?: number;
  out?: string;
}

/**
 * Bake one prop.
 *
 * The job travels as a file and the worker answers with one JSON object per
 * line, the same protocol as the voice workers — a bake takes tens of seconds
 * and progress should arrive while it happens rather than all at once at the end.
 */
export async function bakeProp(source: BakeSource, opts: BakeOptions = {}): Promise<BakeResult> {
  const available = await blenderAvailable();
  if (!available.ok) throw new BlenderUnavailableError(available.reason);

  const exe = (await findBlender())!;
  const config = JSON.parse(await fs.readFile(source.config, 'utf8')) as Record<string, unknown>;

  const scratch = path.join(ROOT, '.cache', 'propbake');
  await fs.mkdir(scratch, { recursive: true });
  const jobDir = await fs.mkdtemp(path.join(scratch, 'job-'));
  const jobFile = path.join(jobDir, 'job.json');

  await fs.writeFile(jobFile, JSON.stringify({
    key: source.key,
    source: source.build,
    config,
    slots: PALETTE_SLOTS,
    budget: {
      warn_shapes: BAKE_BUDGET.warnShapes,
      max_shapes: BAKE_BUDGET.maxShapes,
      warn_points: BAKE_BUDGET.warnPoints,
      max_points: BAKE_BUDGET.maxPoints,
    },
    out: source.out,
    sourceHash: await sourceHash(source),
    bakedAt: new Date().toISOString().slice(0, 10),
  }, null, 2), 'utf8');

  const args = [
    '--background',
    // Without this the user's startup file, unit settings, colour management
    // and add-ons all leak into the geometry.
    '--factory-startup',
    // Without this Blender can exit 0 after the script raised, and a failed
    // bake would be reported as a success.
    '--python-exit-code', '1',
    '--python', WORKER,
    '--', '--job', jobFile,
  ];

  const views: BakeResult['views'] = [];
  const warnings: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: blenderProcessEnv(jobDir) });
      let buffer = '';
      let stderr = '';
      let fatal: string | null = null;
      let total = 0;

      proc.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          let event: WorkerEvent;
          try {
            event = JSON.parse(line) as WorkerEvent;
          } catch {
            // Blender is chatty on stdout; anything that is not our protocol
            // is not addressed to us.
            continue;
          }
          switch (event.kind) {
            case 'loading':
              total = event.total ?? 0;
              break;
            case 'item':
              views.push({ name: event.id!, shapes: event.shapes ?? 0, points: event.points ?? 0 });
              opts.onProgress?.(views.length, total);
              break;
            case 'warn':
              warnings.push(event.message ?? '');
              opts.onLog?.(event.message ?? '');
              break;
            case 'error':
            case 'fatal':
              fatal = event.message ?? fatal;
              break;
            default:
              break;
          }
        }
      });

      proc.stderr.on('data', (d) => (stderr += String(d)));
      proc.on('error', (err) => reject(new Error(`could not run Blender (${exe}): ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) return resolve();
        // Blender's own traceback is the useful part when the worker did not
        // get far enough to report anything itself.
        reject(new Error(fatal ?? `Blender exited ${code}:\n${stderr.split('\n').slice(-12).join('\n')}`));
      });
    });
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }

  // Prove the result actually loads as a prop rather than trusting the exit code.
  const loaded = loadBakedProps(path.dirname(source.dir));
  const failure = loaded.errors.find((e) => e.file.startsWith(`${source.key}/`));
  if (failure) throw new Error(`bake wrote ${source.key} but it does not load: ${failure.error}`);

  return { key: source.key, out: source.out, views, warnings };
}
