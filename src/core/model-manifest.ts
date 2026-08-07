import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MODELS_ROOT } from './models.ts';
import { ROOT } from './paths.ts';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ModelEntry = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['huggingface', 'file']),
    repository: z.string().min(1).optional(),
    revision: z.string().min(1),
    license: z.string().min(1),
    purpose: z.string().min(1),
    files: z.record(Sha256),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === 'huggingface' && !entry.repository) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repository'],
        message: 'required for Hugging Face models',
      });
    }
  });

export const ApprovedModelManifest = z.object({
  schemaVersion: z.literal(1),
  approvedAt: z.string().date(),
  models: z.array(ModelEntry).min(1),
});

export type ApprovedModelManifest = z.infer<typeof ApprovedModelManifest>;
export const MODEL_MANIFEST_PATH = path.join(ROOT, 'config', 'models.manifest.json');

export interface ModelManifestStatus {
  path: string;
  ok: boolean;
  checkedHashes: boolean;
  models: Array<{
    id: string;
    revision: string;
    license: string;
    ok: boolean;
    missing: string[];
    mismatched: string[];
  }>;
}

export async function readModelManifest(file = MODEL_MANIFEST_PATH): Promise<ApprovedModelManifest> {
  return ApprovedModelManifest.parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

function entryRoot(entry: ApprovedModelManifest['models'][number], modelsRoot: string): string {
  if (entry.kind === 'file') return modelsRoot;
  const repository = entry.repository!;
  return path.join(
    modelsRoot,
    'huggingface',
    'hub',
    `models--${repository.replace('/', '--')}`,
    'snapshots',
    entry.revision,
  );
}

async function fileSha256(file: string): Promise<string> {
  const digest = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return digest.digest('hex');
}

export async function verifyModelManifest(
  opts: {
    manifestPath?: string;
    modelsRoot?: string;
    hashes?: boolean;
  } = {},
): Promise<ModelManifestStatus> {
  const manifestPath = opts.manifestPath ?? MODEL_MANIFEST_PATH;
  const modelsRoot = opts.modelsRoot ?? MODELS_ROOT;
  const manifest = await readModelManifest(manifestPath);
  const models: ModelManifestStatus['models'] = [];

  for (const entry of manifest.models) {
    const missing: string[] = [];
    const mismatched: string[] = [];
    const base = entryRoot(entry, modelsRoot);
    for (const [relative, expected] of Object.entries(entry.files)) {
      const file = path.join(base, ...relative.split('/'));
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) missing.push(relative);
        else if (opts.hashes && (await fileSha256(file)) !== expected) mismatched.push(relative);
      } catch {
        missing.push(relative);
      }
    }
    models.push({
      id: entry.id,
      revision: entry.revision,
      license: entry.license,
      ok: missing.length === 0 && mismatched.length === 0,
      missing,
      mismatched,
    });
  }

  return {
    path: path.relative(ROOT, manifestPath),
    ok: models.every((model) => model.ok),
    checkedHashes: opts.hashes ?? false,
    models,
  };
}
