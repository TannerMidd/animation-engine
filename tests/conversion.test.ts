import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers.ts';
import {
  compareConversionAudio,
  voiceConversionCacheKey,
  voiceConversionRuntimeProvenance,
} from '../src/voice/conversion.ts';
import { encodeWav } from '../src/voice/wav.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

describe('voice conversion cache identity', () => {
  it('records the local package and model snapshot in a stable runtime fingerprint', async () => {
    const first = await voiceConversionRuntimeProvenance();
    const second = await voiceConversionRuntimeProvenance();
    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.packageRevision.length).toBeGreaterThan(0);
    expect(first.modelRevision.length).toBeGreaterThan(0);
  });

  it('is stable and follows source/target bytes rather than their paths', async () => {
    const dir = await tempDir('vc-key');
    dirs.push(dir);
    const sourceA = path.join(dir, 'source-a.wav');
    const sourceB = path.join(dir, 'source-b.wav');
    const target = path.join(dir, 'target.wav');
    await fs.writeFile(sourceA, 'same performance');
    await fs.writeFile(sourceB, 'same performance');
    await fs.writeFile(target, 'character voice');

    const a = await voiceConversionCacheKey({ id: 'a', source: sourceA, targetRef: target, seed: 4, registerPolicy: 'adapt-to-character' });
    const b = await voiceConversionCacheKey({ id: 'b', source: sourceB, targetRef: target, seed: 4, registerPolicy: 'adapt-to-character' });
    expect(a).toBe(b);

    await fs.writeFile(sourceB, 'different performance');
    const changed = await voiceConversionCacheKey({ id: 'b', source: sourceB, targetRef: target, seed: 4, registerPolicy: 'adapt-to-character' });
    expect(changed).not.toBe(a);
  });

  it('changes when the target voice or seed changes', async () => {
    const dir = await tempDir('vc-target');
    dirs.push(dir);
    const source = path.join(dir, 'source.wav');
    const targetA = path.join(dir, 'target-a.wav');
    const targetB = path.join(dir, 'target-b.wav');
    await fs.writeFile(source, 'performance');
    await fs.writeFile(targetA, 'voice a');
    await fs.writeFile(targetB, 'voice b');

    const base = await voiceConversionCacheKey({ id: 'x', source, targetRef: targetA, seed: 1, registerPolicy: 'adapt-to-character' });
    expect(await voiceConversionCacheKey({ id: 'x', source, targetRef: targetB, seed: 1, registerPolicy: 'adapt-to-character' })).not.toBe(base);
    expect(await voiceConversionCacheKey({ id: 'x', source, targetRef: targetA, seed: 2, registerPolicy: 'adapt-to-character' })).not.toBe(base);
    expect(await voiceConversionCacheKey({ id: 'x', source, targetRef: targetA, seed: 1, registerPolicy: 'preserve-performer' })).not.toBe(base);
  });
});

describe('voice conversion acoustic QA', () => {
  it('scores preserved pause/cadence structure and flags collapsed speech', async () => {
    const dir = await tempDir('vc-quality');
    dirs.push(dir);
    const rate = 24_000;
    const sourceSamples = new Int16Array(rate);
    for (let i = 0; i < sourceSamples.length; i++) {
      const active = (i >= 2_400 && i < 8_400) || (i >= 13_200 && i < 21_600);
      if (active) sourceSamples[i] = Math.round(Math.sin(2 * Math.PI * 180 * i / rate) * 8_000);
    }
    const preserved = Int16Array.from(sourceSamples, (sample) => Math.round(sample * 0.7));
    const collapsed = new Int16Array(rate);
    const source = path.join(dir, 'source.wav');
    const good = path.join(dir, 'good.wav');
    const bad = path.join(dir, 'bad.wav');
    await Promise.all([
      fs.writeFile(source, encodeWav(sourceSamples, rate, 1)),
      fs.writeFile(good, encodeWav(preserved, rate, 1)),
      fs.writeFile(bad, encodeWav(collapsed, rate, 1)),
    ]);

    const goodReport = await compareConversionAudio(source, good);
    expect(goodReport.cadenceSimilarity).toBeGreaterThan(0.98);
    expect(goodReport.flags).toEqual([]);
    const badReport = await compareConversionAudio(source, bad);
    expect(badReport.cadenceSimilarity).toBeLessThan(0.8);
    expect(badReport.flags.join(' ')).toMatch(/too little detected speech|lost voiced material/);
  });
});
