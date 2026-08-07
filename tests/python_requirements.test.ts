import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/core/paths.ts';

function requirementNames(contents: string): Set<string> {
  const names = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
    .map((line) => line.match(/^([A-Za-z0-9_.-]+)/)?.[1] ?? '')
    .map((name) => name.toLowerCase().replace(/_/g, '-'));
  return new Set(names);
}

describe('Python dependency bootstrap', () => {
  it('keeps the Blackwell runtime resolver-consistent before the intentional Chatterbox overlay', async () => {
    const base = await fs.readFile(path.join(ROOT, 'requirements-python.lock.txt'), 'utf8');
    const overlay = await fs.readFile(path.join(ROOT, 'requirements-chatterbox.lock.txt'), 'utf8');
    const names = requirementNames(base);

    expect(names.has('chatterbox-tts')).toBe(false);
    expect(overlay.match(/^chatterbox-tts==0\.1\.7$/m)).not.toBeNull();
    expect(base.match(/^torch==(\S+)$/m)?.[1]).toBe('2.11.0+cu128');
    expect(base.match(/^torchaudio==(\S+)$/m)?.[1]).toBe('2.11.0+cu128');

    for (const dependency of [
      'conformer',
      'diffusers',
      'gradio',
      'librosa',
      'numpy',
      'omegaconf',
      'pykakasi',
      'pyloudnorm',
      'resemble-perth',
      's3tokenizer',
      'safetensors',
      'spacy-pkuseg',
      'transformers',
    ]) {
      expect(names.has(dependency), `${dependency} must stay locked in the base environment`).toBe(true);
    }
  });
});
