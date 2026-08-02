import fs from 'node:fs/promises';
import { compileShotList } from '../compile/scene.ts';
import { buildPage } from '../render/page.ts';
import { loadSet, renderSet } from '../sets/index.ts';
import { estimateTimings } from './voices.ts';
import type { ShotList } from '../schema/script.ts';
import type { SceneIR } from '../schema/index.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { LineTiming } from '../voice/index.ts';

const RUNTIME_PATH = new URL('../render/runtime.js', import.meta.url);

/**
 * Build the page the preview iframe loads.
 *
 * This is deliberately the *same* `buildPage` the renderer uses. Preview and
 * final output are one code path differing only in what calls `__seek` — a
 * browser rAF loop here, Playwright screenshots there — so they cannot drift
 * apart. Any other approach eventually produces a preview that lies.
 */

export interface PreviewResult {
  ir: SceneIR;
  html: string;
  durationMs: number;
  /** Millisecond start time of each beat, for timeline markers and seeking. */
  beatStarts: number[];
  /** True when built from word-count estimates rather than rendered audio. */
  estimated: boolean;
}

export async function buildPreview(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  timings: Map<number, LineTiming> | null,
): Promise<PreviewResult> {
  const estimated = timings === null;
  const resolved = timings ?? estimateTimings(shots);

  const compiled = compileShotList(shots, rigs, resolved);
  const runtime = await fs.readFile(RUNTIME_PATH, 'utf8');
  const set = shots.set ? renderSet(await loadSet(shots.set)) : null;

  const html = await buildPage({
    ir: compiled.ir,
    rigs,
    runtime,
    set,
    background: '#2b2f36',
  });

  // Recompute beat starts the same way the compiler does, so a timeline click
  // lands on exactly the frame the compiler put that beat at.
  const beatStarts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < shots.beats.length; i++) {
    beatStarts.push(cursor);
    const beat = shots.beats[i]!;
    cursor += beat.kind === 'line' ? (resolved.get(i)?.durationMs ?? 0) + 160 : beat.ms;
  }

  return { ir: compiled.ir, html, durationMs: compiled.durationMs, beatStarts, estimated };
}
