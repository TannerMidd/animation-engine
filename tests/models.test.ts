import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { MODELS_ROOT, HF_CACHE, OLLAMA_MODELS, modelEnv, systemDriveRoot, strayCacheLocations } from '../src/core/models.ts';
import { ROOT } from '../src/core/paths.ts';

/**
 * Model weights must not land on the system drive.
 *
 * This is a hard constraint on this machine, and it has been violated twice by
 * assuming an environment variable took effect instead of checking. These tests
 * pin the parts that are checkable in process; the parts that aren't — a
 * separate daemon's storage path — are what `strayCacheLocations` exists to
 * detect after the fact.
 */

describe('model storage', () => {
  it('roots caches on the same drive as the checkout', () => {
    expect(path.parse(MODELS_ROOT).root).toBe(path.parse(ROOT).root);
  });

  it('keeps the models root off the system drive', () => {
    expect(MODELS_ROOT.toLowerCase().startsWith(systemDriveRoot().toLowerCase())).toBe(false);
  });

  it('puts every cache under the models root', () => {
    for (const dir of [HF_CACHE, OLLAMA_MODELS]) {
      expect(dir.startsWith(MODELS_ROOT)).toBe(true);
    }
  });

  it('sets every library cache variable that would otherwise default to the user profile', () => {
    // Each of these has burned someone by silently writing gigabytes to $HOME.
    const env = modelEnv();
    expect(Object.keys(env).sort()).toEqual(
      ['HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'TORCH_HOME', 'TRANSFORMERS_CACHE'].sort(),
    );
    for (const value of Object.values(env)) {
      expect(value.startsWith(MODELS_ROOT)).toBe(true);
    }
  });

  it('watches the default locations these tools fall back to', () => {
    const labels = strayCacheLocations().map((s) => s.label).sort();
    expect(labels).toEqual(['huggingface', 'ollama', 'torch']);
  });

  it('gives an actionable fix for each stray location', () => {
    for (const stray of strayCacheLocations()) {
      expect(stray.fix.length, stray.label).toBeGreaterThan(10);
      // The fix must name where the data should go, not just say "move it".
      expect(stray.fix, stray.label).toContain(MODELS_ROOT.split(path.sep)[0]!);
    }
  });
});
