import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../core/paths.ts';
import { MODELS_ROOT, HF_CACHE, OLLAMA_MODELS, strayCacheLocations, systemDriveRoot } from '../core/models.ts';
import { ffmpegVersion, ffmpegPath } from '../render/encode.ts';
import { findRhubarb } from '../voice/rhubarb.ts';
import { ENGINE_NAMES, getEngine } from '../voice/index.ts';
import { asrAvailable } from '../voice/qa.ts';
import { listRigs } from '../cast/store.ts';
import { Ollama } from '../llm/ollama.ts';
import { findBlender, blenderAvailable, blenderVersion } from '../render/blender.ts';
import { BAKED_ERRORS } from '../sets/props/baked.ts';
import { listBakedProps } from './propbake.ts';

/**
 * The toolchain, checked end to end and returned as data.
 *
 * Shared by `anim doctor` and the editor's System report, so the two can never
 * disagree about what is installed. Everything here is a probe, not a cache —
 * the caller decides how often the answer is worth refreshing.
 */

export interface DoctorEngineStatus {
  name: string;
  ok: boolean;
  reason: string | null;
  /** Set when the caller's probe had not finished; the verdict is provisional. */
  checking?: boolean;
}

export interface DoctorReport {
  ffmpeg: { version: string | null; path: string; old: boolean };
  chromium: { ok: boolean; version: string | null; error: string | null };
  rhubarb: { ok: boolean; path: string | null };
  models: {
    root: string;
    /** Model weights are gigabytes; landing them on the system drive is the failure to see early. */
    onSystemDrive: boolean;
    caches: Array<{ name: string; dir: string; bytes: number }>;
    strays: Array<{ label: string; dir: string; bytes: number; fix: string }>;
  };
  llm: { ok: boolean; models: string[]; reason: string | null };
  engines: DoctorEngineStatus[];
  asr: { ok: boolean; reason: string | null };
  cast: string[];
  /**
   * The prop foundry. Optional in the strongest sense: baked geometry is
   * committed, so a checkout without Blender renders every prop in the
   * catalogue and merely cannot produce new ones.
   */
  blender: { ok: boolean; version: string | null; path: string | null; reason: string | null };
  bakedProps: {
    count: number;
    shapes: number;
    points: number;
    /** Bakes whose source has changed since they were written. */
    stale: string[];
    errors: Array<{ file: string; error: string }>;
  };
}

export interface DoctorOptions {
  /**
   * Probe override for voice engines. The server injects its memoized probe so
   * an explicit report does not spawn Python and import torch on every click;
   * the CLI probes inline, which is what `anim doctor` always did.
   */
  probeEngine?: (name: string) => Promise<{ ok: boolean; reason?: string; checking?: boolean }>;
}

/** Bytes under a directory tree; 0 when it does not exist or cannot be read. */
export async function dirSize(dir: string): Promise<number> {
  let size = 0;
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) size += (await fs.stat(full)).size;
    }
  };
  try {
    await walk(dir);
  } catch {
    return 0;
  }
  return size;
}

/** A stray cache smaller than this is scaffolding, not a disk problem. */
export const STRAY_CACHE_REPORT_BYTES = 64 * 1024 * 1024;

async function probeChromium(): Promise<DoctorReport['chromium']> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const version = browser.version();
    await browser.close();
    return { ok: true, version, error: null };
  } catch (err) {
    return { ok: false, version: null, error: (err as Error).message.split('\n')[0] ?? 'launch failed' };
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const ff = await ffmpegVersion();
  const chromiumStatus = await probeChromium();
  const rhubarb = await findRhubarb();

  const caches: DoctorReport['models']['caches'] = [];
  for (const [name, dir] of [['huggingface', HF_CACHE], ['ollama', OLLAMA_MODELS]] as const) {
    caches.push({ name, dir, bytes: await dirSize(dir) });
  }

  // Anything that slipped onto the system drive. Ollama is the one that can do
  // this behind our back: it is a separate daemon, so we cannot set its
  // environment — if it was launched without OLLAMA_MODELS it writes here, and
  // the first symptom is a full disk.
  const strays: DoctorReport['models']['strays'] = [];
  for (const stray of strayCacheLocations()) {
    const bytes = await dirSize(stray.dir);
    if (bytes > STRAY_CACHE_REPORT_BYTES) strays.push({ ...stray, bytes });
  }

  const llm = await new Ollama().available();

  const probe: NonNullable<DoctorOptions['probeEngine']> = opts.probeEngine
    ?? (async (name) => {
      const status = await getEngine(name).available();
      return status.ok ? { ok: true } : { ok: false, reason: status.reason };
    });
  const engines: DoctorEngineStatus[] = [];
  for (const name of ENGINE_NAMES) {
    const status = await probe(name);
    engines.push({
      name,
      ok: status.ok,
      reason: status.ok ? null : status.reason ?? 'unavailable',
      ...(status.checking ? { checking: true } : {}),
    });
  }

  const asr = await asrAvailable();

  const blenderExe = await findBlender().catch(() => null);
  const blenderStatus = await blenderAvailable();
  const blenderVer = blenderExe ? await blenderVersion(blenderExe) : null;
  const baked = await listBakedProps();

  return {
    ffmpeg: {
      version: ff,
      path: ffmpegPath(),
      old: Boolean(ff && /^[0-4]\./.test(ff)),
    },
    chromium: chromiumStatus,
    rhubarb: { ok: Boolean(rhubarb), path: rhubarb ? path.relative(ROOT, rhubarb) : null },
    models: {
      root: MODELS_ROOT,
      onSystemDrive: MODELS_ROOT.toLowerCase().startsWith(systemDriveRoot().toLowerCase()),
      caches,
      strays,
    },
    llm: llm.ok
      ? { ok: true, models: llm.models.map((m) => m.name), reason: null }
      : { ok: false, models: [], reason: llm.reason },
    engines,
    asr: asr.ok ? { ok: true, reason: null } : { ok: false, reason: asr.reason },
    cast: await listRigs(),
    blender: {
      ok: blenderStatus.ok,
      version: blenderVer?.raw ?? null,
      path: blenderExe ? path.relative(ROOT, blenderExe) : null,
      reason: blenderStatus.ok ? null : blenderStatus.reason,
    },
    bakedProps: {
      count: baked.filter((p) => !p.error).length,
      shapes: baked.reduce((sum, p) => sum + p.shapes, 0),
      points: baked.reduce((sum, p) => sum + p.points, 0),
      stale: baked.filter((p) => p.stale).map((p) => p.key),
      errors: [
        ...BAKED_ERRORS,
        ...baked.filter((p) => p.error).map((p) => ({ file: `${p.key}/`, error: p.error! })),
      ],
    },
  };
}
