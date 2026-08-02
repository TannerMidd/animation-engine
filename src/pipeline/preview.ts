import fs from 'node:fs/promises';
import { compileShotList } from '../compile/scene.ts';
import { buildPage } from '../render/page.ts';
import { loadSet, renderSet } from '../sets/index.ts';
import { estimateTimings } from './voices.ts';
import { readAnimation } from './animation.ts';
import type { ShotList } from '../schema/script.ts';
import type { SceneIR } from '../schema/index.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import type { LoadedRig } from '../cast/store.ts';
import type { LineTiming } from '../voice/index.ts';
import { reframeScenePortrait, PORTRAIT_MASTER } from './reframe.ts';
import { activeIdentity } from '../show/context.ts';
import { endCardSvg, titleCardSvg } from '../render/cards.ts';

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

export type PreviewLayout = 'horizontal' | 'vertical';

export async function buildPreview(
  shots: ShotList,
  rigs: Map<string, LoadedRig>,
  timings: Map<number, LineTiming> | null,
  animation: AnimationDocument | null | undefined = undefined,
  layout: PreviewLayout = 'horizontal',
): Promise<PreviewResult> {
  const estimated = timings === null;
  const resolved = timings ?? estimateTimings(shots);
  const authored = animation === undefined ? await readAnimation(shots.scene) : animation;
  const setDescriptor = shots.set ? await loadSet(shots.set) : null;

  const compiled = compileShotList(shots, rigs, resolved, authored, setDescriptor);
  const identity = activeIdentity();
  const portraitCards = shots.cards ? {
    titleSvg: titleCardSvg(
      identity,
      shots.title ?? shots.scene.replace(/-/g, ' '),
      shots.subtitle ?? undefined,
      PORTRAIT_MASTER,
    ),
    endSvg: endCardSvg(identity, PORTRAIT_MASTER),
  } : undefined;
  const ir = layout === 'vertical'
    ? reframeScenePortrait(compiled.ir, { cards: portraitCards })
    : compiled.ir;
  const runtime = await fs.readFile(RUNTIME_PATH, 'utf8');
  const set = setDescriptor ? renderSet(setDescriptor) : null;

  const html = await buildPage({
    ir,
    rigs,
    runtime,
    set,
    background: '#2b2f36',
  });

  // Canonical beat starts come from the compiler — one timeline computation,
  // card offsets included, so a timeline click lands on exactly the frame the
  // compiler put that beat at. The old duplicate arithmetic here is what the
  // roadmap calls a preview that lies.
  return { ir, html, durationMs: compiled.durationMs, beatStarts: compiled.beatStarts, estimated };
}
