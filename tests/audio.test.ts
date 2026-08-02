import { describe, it, expect } from 'vitest';
import {
  BUS_RATE, assembleMaster, masterToWav, stemToWav, resampleLinear, toBusSamples, fadeEdges, rmsDb, db,
  integratedLoudnessLufs, measureProgramme, truePeakDbtp,
} from '../src/audio/bus.ts';
import { renderAmbience, acousticProfileFor, ACOUSTIC_PROFILES } from '../src/audio/ambience.ts';
import { titleSting, endSting } from '../src/audio/stings.ts';
import { deliveryFor, NEUTRAL_PERSONA } from '../src/voice/index.ts';
import { encodeWav, decodeWav } from '../src/voice/wav.ts';
import { assessProgrammeQuality, levelDialogueBySpeaker } from '../src/audio/quality.ts';

const sine = (freq: number, ms: number, level = 0.5): Float64Array => {
  const out = new Float64Array(Math.round((ms / 1000) * BUS_RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / BUS_RATE) * level;
  return out;
};

describe('the master bus', () => {
  it('writes a centred 48 kHz stereo production master', () => {
    const wav = decodeWav(masterToWav([{ samples: sine(220, 100), startMs: 0 }], { durationMs: 100 }));
    expect(wav.sampleRate).toBe(48_000);
    expect(wav.channels).toBe(2);
  });

  it('keeps stem gain independent of programme loudness normalisation', () => {
    const source = sine(220, 500, 0.01);
    const stem = toBusSamples(decodeWav(stemToWav(
      [{ samples: source, startMs: 0 }],
      { durationMs: 500 },
    )), 'stem');
    const master = toBusSamples(decodeWav(masterToWav(
      [{ samples: source, startMs: 0 }],
      { durationMs: 500, targetRmsDb: -20 },
    )), 'master');
    expect(rmsDb(stem)).toBeLessThan(-40);
    expect(rmsDb(master) - rmsDb(stem)).toBeGreaterThan(11);
  });

  it('assembles deterministically', () => {
    const clips = () => [
      { samples: sine(220, 400), startMs: 100 },
      { samples: sine(330, 300, 0.4), startMs: 350 },
    ];
    expect(assembleMaster(clips(), { durationMs: 1000 })).toEqual(assembleMaster(clips(), { durationMs: 1000 }));
  });

  it('never clips, even when hot sources stack', () => {
    // Three full-scale sines summed would be +9.5dB over; the limiter must hold
    // the ceiling rather than letting the int16 conversion wrap.
    const loud = [
      { samples: sine(220, 500, 1) as Float64Array, startMs: 0 },
      { samples: sine(221, 500, 1), startMs: 0 },
      { samples: sine(219, 500, 1), startMs: 0 },
    ];
    const out = assembleMaster(loud, { durationMs: 500, ceilingDb: -1 });
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak / 32767).toBeLessThanOrEqual(db(-1) * 1.02);
    expect(peak).toBeGreaterThan(0);
  });

  it('normalises quiet material up to the target without dragging silence', () => {
    const quiet = [{ samples: sine(220, 800, 0.02), startMs: 100 }];
    const out = assembleMaster(quiet, { durationMs: 1000, targetRmsDb: -20 });
    const f = new Float64Array(out.length);
    for (let i = 0; i < out.length; i++) f[i] = out[i]! / 32768;
    // The voiced part should have been lifted well above its raw -34dB RMS.
    expect(rmsDb(f)).toBeGreaterThan(-30);
  });

  it('measures deterministic gated integrated loudness on the centred stereo programme', () => {
    const tone = sine(1_000, 1_200, db(-20));
    const first = integratedLoudnessLufs(tone);
    const second = integratedLoudnessLufs(tone);
    expect(first).toBe(second);
    // A -20 dBFS-peak 1 kHz sine duplicated to stereo is approximately -20 LUFS.
    expect(first).toBeGreaterThan(-20.6);
    expect(first).toBeLessThan(-19.4);
    expect(integratedLoudnessLufs(new Float64Array(BUS_RATE))).toBe(-Infinity);
  });

  it('measures and enforces inter-sample true peak rather than only sample peak', () => {
    const intersample = new Float64Array([0, 0.8, 0.8, 0, -0.8, -0.8, 0]);
    const samplePeakDb = 20 * Math.log10(0.8);
    expect(truePeakDbtp(intersample)).toBeGreaterThan(samplePeakDb);

    const mastered = assembleMaster([
      { samples: sine(9_973, 800, 1), startMs: 0 },
    ], { durationMs: 800, targetIntegratedLufs: -10, ceilingDb: -2 });
    const floats = Float64Array.from(mastered, (sample) => sample / 32768);
    const metrics = measureProgramme(floats);
    expect(metrics.integratedLufs).not.toBeNull();
    expect(metrics.truePeakDbtp).toBeLessThanOrEqual(-1.95);
    expect(metrics.truePeakDbtp!).toBeGreaterThanOrEqual(metrics.samplePeakDbfs!);
  });

  it('levels cast members modestly without flattening any performance', () => {
    const quiet = sine(220, 600, 0.05);
    const loud = sine(220, 600, 0.1);
    const result = levelDialogueBySpeaker([
      { speaker: 'alice', clip: { samples: quiet, startMs: 0 } },
      { speaker: 'bob', clip: { samples: loud, startMs: 700 } },
    ]);
    expect(result.adjustments.map((item) => item.speaker)).toEqual(['alice', 'bob']);
    expect(result.adjustments[0]!.adjustmentDb).toBe(3);
    expect(result.adjustments[1]!.adjustmentDb).toBe(-3);
    // One static gain per speaker: samples and their internal dynamics are not rewritten.
    expect(result.entries[0]!.clip.samples).toBe(quiet);
    expect(result.entries[1]!.clip.samples).toBe(loud);
  });

  it('makes LUFS and dBTP the release gate while allowing intentional silence', () => {
    const pass = assessProgrammeQuality({
      integratedLufs: -16.4, truePeakDbtp: -1.02, samplePeakDbfs: -1.3,
    }, -16, -1);
    expect(pass.passed).toBe(true);
    expect(assessProgrammeQuality({
      integratedLufs: -20, truePeakDbtp: -0.3, samplePeakDbfs: -1,
    }, -16, -1).passed).toBe(false);
    expect(assessProgrammeQuality({
      integratedLufs: null, truePeakDbtp: null, samplePeakDbfs: null,
    }, -16, -1)).toMatchObject({ passed: true, intentionalSilence: true });
  });

  it('resamples 22050 -> 24000 with the right length and no invented energy', () => {
    const input = sine(440, 1000);
    const from = new Float64Array(Math.round(22050));
    from.set(input.subarray(0, 22050));
    const out = resampleLinear(from, 22050, 24000);
    expect(out.length).toBe(24000);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.51);
  });

  it('folds stereo to mono through the WAV path', () => {
    // L = 0.5, R = -0.5 constant: the average is silence, a dropped channel isn't.
    const samples = new Int16Array(200);
    for (let i = 0; i < 100; i++) {
      samples[i * 2] = 16000;
      samples[i * 2 + 1] = -16000;
    }
    const wav = decodeWav(encodeWav(samples, BUS_RATE, 2));
    const mono = toBusSamples(wav, 'test');
    expect(Math.max(...mono.map(Math.abs))).toBe(0);
  });

  it('fades edges to zero', () => {
    const faded = fadeEdges(sine(220, 100, 1), 5);
    expect(Math.abs(faded[0]!)).toBe(0);
    expect(Math.abs(faded[faded.length - 1]!)).toBeLessThan(0.05);
  });
});

describe('ambience', () => {
  it('is byte-identical for a seed', () => {
    expect(renderAmbience('office-day', 7, 2000)).toEqual(renderAmbience('office-day', 7, 2000));
  });

  it('differs between seeds and between profiles', () => {
    expect(renderAmbience('office-day', 7, 500)).not.toEqual(renderAmbience('office-day', 8, 500));
    expect(renderAmbience('office-day', 7, 500)).not.toEqual(renderAmbience('bar', 7, 500));
  });

  it('renders every profile without NaN and at a sane level', () => {
    for (const profile of ACOUSTIC_PROFILES) {
      const bed = renderAmbience(profile, 3, 1200);
      let peak = 0;
      for (const v of bed) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      if (profile !== 'silence') expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThan(1);
    }
  });

  it('maps palettes to acoustics with silence as the unknown fallback', () => {
    expect(acousticProfileFor('office-fluorescent')).toBe('office-day');
    expect(acousticProfileFor('bar-night')).toBe('bar');
    expect(acousticProfileFor('never-heard-of-it')).toBe('silence');
    expect(acousticProfileFor(null)).toBe('silence');
  });
});

describe('stings', () => {
  it('are stable per seed and different between shows', () => {
    expect(titleSting(101)).toEqual(titleSting(101));
    expect(titleSting(101)).not.toEqual(titleSting(909));
    expect(endSting(101)).not.toEqual(titleSting(101).subarray(0, endSting(101).length));
  });
});

describe('vocal persona', () => {
  it('leaves delivery untouched at neutral', () => {
    expect(deliveryFor('ANGRY', NEUTRAL_PERSONA)).toEqual(deliveryFor('ANGRY'));
  });

  it('scales monotonically with energy', () => {
    const low = deliveryFor('ANGRY', { energy: 0.8, pace: 1 });
    const high = deliveryFor('ANGRY', { energy: 1.2, pace: 1 });
    expect(high.exaggeration).toBeGreaterThan(low.exaggeration);
    expect(high.cfg).toBe(low.cfg);
  });

  it('never turns deadpan into enthusiasm', () => {
    const excitable = deliveryFor('DEADPAN', { energy: 1.5, pace: 1.5 });
    expect(excitable.exaggeration).toBeLessThan(deliveryFor('NEUTRAL').exaggeration);
  });

  it('stays inside the engine range at the extremes', () => {
    const d = deliveryFor('SHOCKED', { energy: 1.5, pace: 1.5 });
    expect(d.exaggeration).toBeLessThanOrEqual(1);
    expect(d.cfg).toBeLessThanOrEqual(1);
    const q = deliveryFor('DEADPAN', { energy: 0.5, pace: 0.5 });
    expect(q.exaggeration).toBeGreaterThanOrEqual(0.1);
  });
});
