import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovedModelManifest, readModelManifest, verifyModelManifest } from '../src/core/model-manifest.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'animation-model-manifest-'));
  tempDirs.push(root);
  const modelsRoot = path.join(root, 'models');
  await fs.mkdir(modelsRoot);
  const bytes = Buffer.from('approved test weights');
  await fs.writeFile(path.join(modelsRoot, 'weights.bin'), bytes);
  const manifestPath = path.join(root, 'models.json');
  const manifest = {
    schemaVersion: 1,
    approvedAt: '2026-08-07',
    models: [
      {
        id: 'fixture',
        kind: 'file',
        revision: 'fixture-v1',
        license: 'MIT',
        purpose: 'test fixture',
        files: { 'weights.bin': createHash('sha256').update(bytes).digest('hex') },
      },
    ],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { manifestPath, modelsRoot };
}

describe('approved model manifest', () => {
  it('verifies independent file hashes', async () => {
    const paths = await fixture();
    const report = await verifyModelManifest({ ...paths, hashes: true });
    expect(report.ok).toBe(true);
    expect(report.checkedHashes).toBe(true);
    expect(report.models[0]).toMatchObject({ id: 'fixture', ok: true, missing: [], mismatched: [] });
    expect((await readModelManifest(paths.manifestPath)).schemaVersion).toBe(1);
  });

  it('distinguishes missing files from checksum mismatches', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.modelsRoot, 'weights.bin'), 'changed');
    const mismatch = await verifyModelManifest({ ...paths, hashes: true });
    expect(mismatch.models[0]?.mismatched).toEqual(['weights.bin']);

    await fs.rm(path.join(paths.modelsRoot, 'weights.bin'));
    const missing = await verifyModelManifest({ ...paths, hashes: true });
    expect(missing.models[0]?.missing).toEqual(['weights.bin']);
  });

  it('requires repositories for Hugging Face entries', () => {
    expect(() =>
      ApprovedModelManifest.parse({
        schemaVersion: 1,
        approvedAt: '2026-08-07',
        models: [
          {
            id: 'bad',
            kind: 'huggingface',
            revision: 'abc',
            license: 'MIT',
            purpose: 'test',
            files: {},
          },
        ],
      }),
    ).toThrow(/repository/);
  });
});
