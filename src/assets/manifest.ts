import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ROOT } from '../core/paths.ts';

/**
 * The asset library's ledger.
 *
 * Every piece of source material that is not generated fresh by the engine —
 * traced art, a reference image an image model produced, a recorded clip —
 * gets an entry here before anything renders with it. The point is provenance:
 * a year from now, "where did this backdrop come from, under what licence, and
 * did anyone approve it" has an answer that isn't a shrug.
 *
 * Nothing in the render path reads this yet; it is the contract the Asset Lab
 * (image-model workflow) writes against, landed early so that workflow has a
 * ledger from its first output.
 */

export const AssetEntry = z.object({
  /** Stable id, independent of the file name. */
  assetId: z.string().min(1),
  /** Path relative to assets/. */
  file: z.string().min(1),
  /** sha1 of the file at approval time — a changed file is a different asset. */
  hash: z.string().min(1),
  kind: z.enum(['image', 'audio', 'svg', 'reference']),
  /** Where it came from: a tool, a model, a person. */
  source: z.string().min(1),
  /** Model provenance when a model made it. */
  model: z
    .object({
      repo: z.string(),
      revision: z.string(),
      prompt: z.string().default(''),
      seed: z.number().int().optional(),
    })
    .nullable()
    .default(null),
  licence: z.string().min(1),
  approved: z.boolean().default(false),
  notes: z.string().default(''),
});
export type AssetEntry = z.infer<typeof AssetEntry>;

export const AssetManifest = z.object({
  version: z.literal(1),
  assets: z.array(AssetEntry).default([]),
});
export type AssetManifest = z.infer<typeof AssetManifest>;

export const ASSETS_DIR = path.join(ROOT, 'assets');
const MANIFEST = path.join(ASSETS_DIR, 'manifest.json');

export async function loadManifest(): Promise<AssetManifest> {
  try {
    return AssetManifest.parse(JSON.parse(await fs.readFile(MANIFEST, 'utf8')));
  } catch {
    return { version: 1, assets: [] };
  }
}

export async function saveManifest(manifest: AssetManifest): Promise<void> {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(AssetManifest.parse(manifest), null, 2) + '\n', 'utf8');
}

/** Verify every approved asset still matches its recorded hash. */
export async function verifyAssets(): Promise<Array<{ assetId: string; problem: string }>> {
  const manifest = await loadManifest();
  const problems: Array<{ assetId: string; problem: string }> = [];

  for (const asset of manifest.assets) {
    const file = path.join(ASSETS_DIR, asset.file);
    try {
      const hash = crypto.createHash('sha1').update(await fs.readFile(file)).digest('hex');
      if (hash !== asset.hash) {
        problems.push({ assetId: asset.assetId, problem: `content changed since approval (${asset.file})` });
      }
    } catch {
      problems.push({ assetId: asset.assetId, problem: `file missing: ${asset.file}` });
    }
  }
  return problems;
}
