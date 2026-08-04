import fs from 'node:fs/promises';
import path from 'node:path';
import { OUT_DIR, SCRIPTS_DIR } from '../core/paths.ts';
import { listProfiles, loadProfile } from '../show/store.ts';
import { activeIdentity, setActiveIdentity } from '../show/context.ts';
import { checkScript, loadRigsForShotList } from './check.ts';
import { writeScript, writeShotList } from './scene.ts';
import { renderScene, type RenderProgress } from './render.ts';
import { runFfmpeg, stackArgs } from '../render/encode.ts';

/**
 * Identity-profile tooling: validation and the comparison reel.
 *
 * Shared by `anim show validate` / `anim reel` and the editor's identity
 * picker, so the evaluation workflow and the UI run the same code.
 */

export interface ProfileValidation {
  id: string;
  ok: boolean;
  version: string | null;
  hash: string | null;
  error: string | null;
}

/**
 * Load every profile the listing found.
 *
 * listProfiles already drops anything that fails to parse; loading each one
 * again surfaces the errors it swallowed.
 */
export async function validateProfiles(): Promise<{ ok: boolean; results: ProfileValidation[] }> {
  const profiles = await listProfiles();
  const results: ProfileValidation[] = [];
  for (const p of profiles) {
    try {
      await loadProfile(p.id);
      results.push({ id: p.id, ok: true, version: p.version, hash: p.hash, error: null });
    } catch (err) {
      results.push({ id: p.id, ok: false, version: null, hash: null, error: (err as Error).message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export interface ReelOptions {
  /** Script file; defaults to the identity evaluation script. */
  script?: string;
  a?: string;
  b?: string;
  engine?: string;
  onStage?: (profileId: string, progress: RenderProgress) => void;
  /** Fires as each half begins and lands, so a caller can narrate the two renders. */
  onProfileStart?: (profileId: string) => void;
  onProfileDone?: (profileId: string, mp4: string, durationMs: number) => void;
}

export interface ReelResult {
  /** The stacked comparison, out/identity-reel.mp4. */
  file: string;
  a: string;
  b: string;
  /** The two per-profile masters, in [a, b] order. */
  parts: [string, string];
}

/**
 * The identity comparison reel: the same script rendered under two identity
 * profiles, stacked into one video. The whole Phase-3 claim in one file — if
 * the two halves don't read as two different shows, the system isn't done.
 *
 * The active identity is restored afterwards: unlike the CLI process, a server
 * outlives this call, and leaving the second reel profile active would quietly
 * re-style every scene that renders after it.
 */
export async function renderIdentityReel(opts: ReelOptions = {}): Promise<ReelResult> {
  const script = opts.script ?? path.join(SCRIPTS_DIR, 'eval-identity.md');
  const a = opts.a ?? 'fixtures/dry-institutional';
  const b = opts.b ?? 'fixtures/loud-cartoon';

  const restore = activeIdentity();
  const outputs: string[] = [];
  try {
    for (const profileId of [a, b]) {
      setActiveIdentity(await loadProfile(profileId));
      opts.onProfileStart?.(profileId);
      const slug = profileId.replace(/[^\w-]/g, '-');
      const sceneName = `reel-${slug}`;

      const source = await fs.readFile(path.resolve(script), 'utf8');
      await writeScript(sceneName, source);

      const result = await checkScript(source, { scene: sceneName, createMissingCast: true });
      if (!result.shots) throw new Error(`direct failed under ${profileId}: ${result.errors.join('; ')}`);
      await writeShotList(sceneName, result.shots);

      const rigs = await loadRigsForShotList(result.shots);
      const rendered = await renderScene(result.shots, rigs, {
        scene: sceneName,
        engine: opts.engine ?? 'chatterbox',
        onStage: (p) => opts.onStage?.(profileId, p),
      });
      opts.onProfileDone?.(profileId, rendered.mp4, rendered.durationMs);
      outputs.push(rendered.mp4);
    }
  } finally {
    setActiveIdentity(restore);
  }

  const out = path.join(OUT_DIR, 'identity-reel.mp4');
  await runFfmpeg(stackArgs(outputs[0]!, outputs[1]!, out));
  return { file: out, a, b, parts: [outputs[0]!, outputs[1]!] };
}
