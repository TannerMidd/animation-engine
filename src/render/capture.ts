import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import type { SceneIR } from '../schema/index.ts';
import type { LoadedRig } from '../cast/store.ts';
import { buildPage } from './page.ts';
import { loadSet, renderSet } from '../sets/index.ts';

const RUNTIME_PATH = new URL('./runtime.js', import.meta.url);

/**
 * Chromium flags chosen for reproducibility rather than speed.
 *
 * GPU rasterisation is the main source of cross-run pixel drift, so we stay on
 * the software rasteriser: a scene must render identically on every run for the
 * determinism test to mean anything.
 */
const DETERMINISTIC_FLAGS = [
  '--disable-gpu',
  '--force-color-profile=srgb',
  '--disable-font-subpixel-positioning',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--disable-background-timer-throttling',
  '--disable-partial-raster',
  '--disable-skia-runtime-opts',
];

export interface RenderOptions {
  ir: SceneIR;
  rigs: Map<string, LoadedRig>;
  /** Scene working directory. Frames land in <dir>/frames, page in <dir>/page.html. */
  dir: string;
  background?: string;
  onProgress?: (done: number, total: number, captured: number) => void;
}

export interface RenderResult {
  framesDir: string;
  total: number;
  /** Frames actually screenshotted. The rest were copies of a held frame. */
  captured: number;
  pagePath: string;
}

/** Stable hash of one frame's visual state — the dedup key. */
function frameHash(frame: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(frame)).digest('hex');
}

/**
 * Render a scene to a PNG sequence.
 *
 * Held poses are the norm in limited animation, so identical frames are
 * screenshotted once and copied. Copying a PNG costs a fraction of a
 * millisecond against roughly 10-30ms for a screenshot, and it keeps the
 * ffmpeg side trivial: a plain numbered image sequence, no concat lists, no
 * timestamp arithmetic.
 */
export async function renderFrames(opts: RenderOptions): Promise<RenderResult> {
  const { ir, rigs, dir } = opts;
  const framesDir = path.join(dir, 'frames');

  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const runtime = await fs.readFile(RUNTIME_PATH, 'utf8');
  const set = ir.meta.set ? renderSet(await loadSet(ir.meta.set)) : null;
  const html = await buildPage({ ir, rigs, runtime, set, background: opts.background });
  const pagePath = path.join(dir, 'page.html');
  await fs.writeFile(pagePath, html, 'utf8');

  const total = ir.frames.length;
  if (total === 0) throw new Error('renderFrames: scene has no frames');

  let browser: Browser | undefined;
  let captured = 0;

  try {
    browser = await chromium.launch({ headless: true, args: DETERMINISTIC_FLAGS });
    const page = await browser.newPage({
      viewport: { width: ir.meta.width, height: ir.meta.height },
      deviceScaleFactor: 1,
    });

    // Surface runtime errors as harness failures instead of silently black frames.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(pagePath.startsWith('file:') ? pagePath : `file://${pagePath.replace(/\\/g, '/')}`);
    await page.waitForFunction('window.__ready === true', undefined, { timeout: 30_000 });
    if (pageErrors.length) throw new Error(`render runtime failed: ${pageErrors[0]}`);

    const seen = new Map<string, string>();

    for (let i = 0; i < total; i++) {
      const file = path.join(framesDir, `${String(i).padStart(6, '0')}.png`);
      const hash = frameHash(ir.frames[i]);
      const existing = seen.get(hash);

      if (existing) {
        await fs.copyFile(existing, file);
      } else {
        await page.evaluate((n) => (window as never as { __seek(n: number): number }).__seek(n), i);
        await page.screenshot({ path: file, type: 'png' });
        seen.set(hash, file);
        captured++;
      }

      if (pageErrors.length) throw new Error(`render runtime failed at frame ${i}: ${pageErrors[0]}`);
      opts.onProgress?.(i + 1, total, captured);
    }
  } finally {
    await browser?.close();
  }

  return { framesDir, total, captured, pagePath };
}
