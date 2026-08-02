import {
  db,
  integratedLoudnessLufs,
  type BusClip,
  type LoudnessMetrics,
} from './bus.ts';

export interface SpeakerLevelAdjustment {
  speaker: string;
  measuredLufs: number;
  adjustmentDb: number;
  levelledLufs: number;
}

export interface ProgrammeQualityGate {
  standard: 'ITU-R-BS.1770-style';
  targetIntegratedLufs: number;
  loudnessToleranceLu: number;
  truePeakCeilingDbtp: number;
  metrics: LoudnessMetrics;
  loudnessPassed: boolean;
  truePeakPassed: boolean;
  intentionalSilence: boolean;
  passed: boolean;
}

interface SpeakerClip {
  clip: BusClip;
  speaker: string | null;
}

function concatenate(clips: readonly BusClip[]): Float64Array {
  const length = clips.reduce((sum, clip) => sum + clip.samples.length, 0);
  const output = new Float64Array(length);
  let offset = 0;
  for (const clip of clips) {
    const gain = clip.gain ?? 1;
    if (gain === 1) output.set(clip.samples, offset);
    else {
      for (let i = 0; i < clip.samples.length; i++) output[offset + i] = clip.samples[i]! * gain;
    }
    offset += clip.samples.length;
  }
  return output;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/**
 * Apply one restrained trim per speaker, preserving dynamics inside every
 * performance. The median cast level is the reference and no actor moves by
 * more than three dB, so this is levelling rather than synthetic compression.
 */
export function levelDialogueBySpeaker(
  entries: readonly SpeakerClip[],
  maxAdjustmentDb = 3,
): { entries: SpeakerClip[]; adjustments: SpeakerLevelAdjustment[] } {
  const speakers = [...new Set(entries.flatMap((entry) => entry.speaker ? [entry.speaker] : []))].sort();
  const measured = speakers.flatMap((speaker) => {
    const clips = entries.filter((entry) => entry.speaker === speaker).map((entry) => entry.clip);
    const lufs = integratedLoudnessLufs(concatenate(clips));
    return Number.isFinite(lufs) ? [{ speaker, lufs }] : [];
  });
  if (!measured.length) return { entries: entries.map((entry) => ({ ...entry })), adjustments: [] };

  const reference = median(measured.map((item) => item.lufs));
  const gains = new Map(measured.map((item) => [
    item.speaker,
    Math.max(-maxAdjustmentDb, Math.min(maxAdjustmentDb, reference - item.lufs)),
  ]));
  const levelled = entries.map((entry) => {
    const adjustment = entry.speaker ? gains.get(entry.speaker) ?? 0 : 0;
    return {
      ...entry,
      clip: {
        ...entry.clip,
        gain: (entry.clip.gain ?? 1) * db(adjustment),
      },
    };
  });
  return {
    entries: levelled,
    adjustments: measured.map((item) => {
      const adjustmentDb = gains.get(item.speaker) ?? 0;
      return {
        speaker: item.speaker,
        measuredLufs: Math.round(item.lufs * 100) / 100,
        adjustmentDb: Math.round(adjustmentDb * 100) / 100,
        levelledLufs: Math.round((item.lufs + adjustmentDb) * 100) / 100,
      };
    }),
  };
}

/** Release gate for the selected social-master target and inter-sample ceiling. */
export function assessProgrammeQuality(
  metrics: LoudnessMetrics,
  targetIntegratedLufs: number,
  truePeakCeilingDbtp: number,
  loudnessToleranceLu = 1.5,
): ProgrammeQualityGate {
  const intentionalSilence = metrics.integratedLufs === null && metrics.truePeakDbtp === null;
  const loudnessPassed = intentionalSilence || (
    metrics.integratedLufs !== null &&
    Math.abs(metrics.integratedLufs - targetIntegratedLufs) <= loudnessToleranceLu
  );
  const truePeakPassed = intentionalSilence || (
    metrics.truePeakDbtp !== null && metrics.truePeakDbtp <= truePeakCeilingDbtp + 0.05
  );
  return {
    standard: 'ITU-R-BS.1770-style',
    targetIntegratedLufs,
    loudnessToleranceLu,
    truePeakCeilingDbtp,
    metrics,
    loudnessPassed,
    truePeakPassed,
    intentionalSilence,
    passed: loudnessPassed && truePeakPassed,
  };
}
