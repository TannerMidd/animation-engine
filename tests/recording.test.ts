import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { sceneDir } from '../src/core/paths.ts';
import { extractPerformanceSegment, performanceAssetPath } from '../src/voice/recording.ts';
import { encodeWav, readWav, toInt16, wavDurationMs } from '../src/voice/wav.ts';

describe('performance recording paths', () => {
  it('keeps approved assets inside the scene directory', () => {
    expect(performanceAssetPath('scene-a', 'dialogue/takes/line/take/performance.wav'))
      .toContain(path.join('out', 'scene-a', 'dialogue', 'takes'));
  });

  it('rejects traversal outside the scene', () => {
    expect(() => performanceAssetPath('scene-a', '../../cast/person.ref.wav')).toThrow(/escapes/);
  });

  it('extracts an exact immutable PCM segment for Scene Run conversion', async () => {
    const scene = `test-scene-run-${process.pid}-${Date.now()}`;
    const dir = sceneDir(scene);
    try {
      await fs.mkdir(dir, { recursive: true });
      const samples = Int16Array.from({ length: 48_000 }, (_, index) => (index % 20_000) - 10_000);
      await fs.writeFile(path.join(dir, 'run.wav'), encodeWav(samples, 48_000, 1));

      const relative = await extractPerformanceSegment(scene, 'take-1', 'cue-1', 'run.wav', 250, 750);
      const segment = await readWav(performanceAssetPath(scene, relative));
      const decoded = toInt16(segment);

      expect(wavDurationMs(segment)).toBe(500);
      expect(decoded.length).toBe(24_000);
      expect(decoded[0]).toBe(samples[12_000]);
      expect(relative).toMatch(/^dialogue\/segments\/take-1-cue-1-[a-f0-9]{16}\.wav$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
