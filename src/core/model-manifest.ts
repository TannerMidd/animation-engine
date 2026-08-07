import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MODELS_ROOT } from './models.ts';
import { ROOT } from './paths.ts';
import { resolveWithin } from './project.ts';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ModelFileMap = z.record(Sha256).superRefine((files, ctx) => {
  for (const relative of Object.keys(files)) {
    const parts = relative.split('/');
    if (
      !relative ||
      relative.includes('\\') ||
      path.isAbsolute(relative) ||
      parts.some((part) => !part || part === '.' || part === '..')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [relative],
        message: 'model files must be portable relative paths',
      });
    }
  }
});
const ModelEntry = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['huggingface', 'file']),
    repository: z.string().min(1).optional(),
    revision: z.string().min(1),
    license: z.string().min(1),
    purpose: z.string().min(1),
    files: ModelFileMap,
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

export const ApprovedModelManifest = z
  .object({
    schemaVersion: z.literal(1),
    approvedAt: z.string().date(),
    models: z.array(ModelEntry).min(1),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of manifest.models.entries()) {
      if (seen.has(model.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'id'],
          message: `duplicate model id "${model.id}"`,
        });
      }
      seen.add(model.id);
    }
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

/** A concrete, approved local model tree suitable for passing to a worker. */
export interface ApprovedModelRuntime {
  id: string;
  kind: 'huggingface' | 'file';
  repository?: string;
  revision: string;
  root: string;
  /** Manifest-relative name to absolute local file path. */
  files: Record<string, string>;
}

export async function readModelManifest(file = MODEL_MANIFEST_PATH): Promise<ApprovedModelManifest> {
  return ApprovedModelManifest.parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

function entryRoot(entry: ApprovedModelManifest['models'][number], modelsRoot: string): string {
  if (entry.kind === 'file') return path.resolve(modelsRoot);
  const repository = entry.repository!;
  return resolveWithin(
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

async function verifyEntryFiles(
  entry: ApprovedModelManifest['models'][number],
  modelsRoot: string,
  hashes: boolean,
): Promise<{ base: string; files: Record<string, string>; missing: string[]; mismatched: string[] }> {
  const base = entryRoot(entry, modelsRoot);
  const files: Record<string, string> = {};
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [relative, expected] of Object.entries(entry.files)) {
    const file = resolveWithin(base, ...relative.split('/'));
    files[relative] = file;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) missing.push(relative);
      else if (hashes && (await fileSha256(file)) !== expected) mismatched.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  return { base, files, missing, mismatched };
}

/**
 * Resolve one manifest entry to the exact local snapshot workers must load.
 *
 * This deliberately does not follow Hugging Face `refs/main`: the approved
 * revision is content-addressed in the manifest, so a later prefetch cannot
 * silently change the model used by a render.
 */
export async function resolveApprovedModel(
  id: string,
  opts: {
    manifestPath?: string;
    modelsRoot?: string;
    hashes?: boolean;
  } = {},
): Promise<ApprovedModelRuntime> {
  const manifest = await readModelManifest(opts.manifestPath ?? MODEL_MANIFEST_PATH);
  const entry = manifest.models.find((model) => model.id === id);
  if (!entry) throw new Error(`model "${id}" is not in the approved manifest`);

  const checked = await verifyEntryFiles(entry, opts.modelsRoot ?? MODELS_ROOT, opts.hashes ?? false);
  if (checked.missing.length || checked.mismatched.length) {
    const details = [
      checked.missing.length ? `missing: ${checked.missing.join(', ')}` : '',
      checked.mismatched.length ? `checksum mismatch: ${checked.mismatched.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`approved model "${id}" is unavailable (${details})`);
  }

  return {
    id: entry.id,
    kind: entry.kind,
    repository: entry.repository,
    revision: entry.revision,
    root: checked.base,
    files: checked.files,
  };
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
    const { missing, mismatched } = await verifyEntryFiles(entry, modelsRoot, opts.hashes ?? false);
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
