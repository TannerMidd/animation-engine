import type { AnimationDocument, Beat, DialogueCue, DialogueDocument, ShotList, TimeAnchor } from '../types.ts';

/** Editor modes, in the order they appear in the mode switcher. */
export type Mode = 'write' | 'direct' | 'animate' | 'perform' | 'sound' | 'publish';
export type InspectorTab = 'beat' | 'character' | 'motion' | 'rig' | 'camera' | 'prop' | 'voice' | 'scene';

/** Semantic palette (mirrors the CSS theme; used where styles are computed). */
export const C = {
  ink: '#e6e3dc',
  dim: '#9aa1ab',
  faint: '#6b737d',
  ghost: '#4c545e',
  edge: '#363d46',
  panel: '#252a31',
  p2: '#2b3138',
  well: '#141619',
  deep: '#1a1d21',
  accent: '#c8834a',
  good: '#6f9b5a',
  bad: '#c8595a',
  info: '#73a6c7',
  lock: '#a89050',
  gen: '#7a8fc0',
  mauve: '#b06a8f',
} as const;

/** Speaker identity colours, assigned by cast order (design-system rule). */
const SPEAKER_COLOURS = ['#c8834a', '#6f9b5a', '#7a8fc0', '#b06a8f', '#a89050', '#73a6c7', '#5e8f8a'];

export function speakerColour(castIds: string[], speaker: string): string {
  const i = castIds.indexOf(speaker);
  return i === -1 ? '#5f6772' : SPEAKER_COLOURS[i % SPEAKER_COLOURS.length]!;
}

/** Staging marks as fractions of stage width (mirrors src/schema/script.ts). */
export const MARK_X: Record<string, number> = {
  FAR_L: 0.16,
  SL: 0.31,
  CENTER: 0.5,
  SR: 0.69,
  FAR_R: 0.84,
};

/** `mm:ss.d`, the transport/status timecode format. */
export function fmtTimecode(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * Per-beat start times in ms.
 *
 * The preview's beatStarts are authoritative (they come from the same timing
 * the render uses). Before a preview exists, estimate from the shot list so
 * the timeline still has a shape: pauses and actions carry their own ms,
 * lines get a word-count estimate.
 */
export function beatStartsFor(shots: ShotList | null, previewStarts: number[] | undefined): number[] {
  if (previewStarts?.length) return previewStarts;
  if (!shots) return [];
  const out: number[] = [];
  let t = 0;
  for (const beat of shots.beats) {
    out.push(t);
    t += estimateBeatMs(beat);
  }
  return out;
}

export function estimateBeatMs(beat: Beat): number {
  if (beat.kind === 'pause') return beat.ms;
  if (beat.kind === 'action') return beat.ms || 2000;
  const words = beat.text.trim().split(/\s+/).filter(Boolean).length;
  return 400 + words * 280;
}

export function totalMsFor(shots: ShotList | null, starts: number[], previewDurationMs: number | undefined): number {
  if (previewDurationMs) return previewDurationMs;
  if (!shots || !starts.length) return 0;
  const last = shots.beats[shots.beats.length - 1];
  return (starts[starts.length - 1] ?? 0) + (last ? estimateBeatMs(last) : 0);
}

/** Resolve an animation time anchor to ms, given beat ids and starts. */
export function resolveAnchor(
  anchor: TimeAnchor,
  beats: Beat[],
  starts: number[],
  durations: (i: number) => number,
): number {
  if (anchor.kind === 'absolute') return anchor.ms;
  const i = beats.findIndex((b) => b.id === anchor.beatId);
  if (i === -1) return anchor.offsetMs;
  const base = anchor.edge === 'end' ? (starts[i] ?? 0) + durations(i) : starts[i] ?? 0;
  return base + anchor.offsetMs;
}

/** Voice state of a line beat, resolved through the dialogue document. */
export function cueApproval(cue: DialogueCue | undefined): 'approved' | 'generated' | 'candidate' | 'missing' {
  if (!cue) return 'missing';
  if (cue.voiceSource === 'generated' && cue.approval.state === 'approved') return 'generated';
  if (cue.approval.state === 'approved') return 'approved';
  if (cue.selectedTakeId || cue.selectedRenderId || cue.approval.state === 'candidate') return 'candidate';
  return 'missing';
}

/** True when the line still needs a creator decision (record, select, or choose generated). */
export function cueUndecided(cue: DialogueCue | undefined): boolean {
  const state = cueApproval(cue);
  return state === 'missing' || state === 'candidate';
}

export function cueForBeat(dialogue: DialogueDocument | null, beat: Beat | null): DialogueCue | null {
  if (!dialogue || !beat || beat.kind !== 'line') return null;
  return dialogue.cues.find((cue) => cue.id === beat.id) ?? null;
}

/** Why a timeline motion clip cannot currently be deleted, or null when safe. */
export function motionDeletionBlocker(document: AnimationDocument, segmentId: string): string | null {
  const segment = document.segments.find((item) => item.id === segmentId);
  if (!segment) return 'That motion no longer exists.';
  const layer = document.layers.find((item) => item.id === segment.layerId);
  if (layer?.locked) return `Unlock the ${layer.name} layer before deleting this motion.`;
  if (segment.locked) return 'Unlock this motion before deleting it.';
  const lockedControl = [segment.from, segment.to, ...segment.waypoints].find((control) => control.locked);
  if (lockedControl) return `Unlock motion control ${lockedControl.id} before deleting this motion.`;
  return null;
}

/** Remove exactly one unlocked motion segment while preserving every other animation item. */
export function withoutMotionSegment(document: AnimationDocument, segmentId: string): AnimationDocument {
  const blocker = motionDeletionBlocker(document, segmentId);
  if (blocker) throw new Error(blocker);
  return { ...document, segments: document.segments.filter((segment) => segment.id !== segmentId) };
}

/** Deterministic 4-swatch strip from an identity hash, for the app-bar chip. */
export function identitySwatches(hash: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const chunk = hash.slice(i * 3, i * 3 + 3) || 'abc';
    const n = parseInt(chunk, 16);
    const value = Number.isNaN(n) ? (chunk.charCodeAt(0) ?? 97) * 7 : n;
    out.push(`hsl(${value % 360} ${34 + (value % 22)}% ${44 + (value % 18)}%)`);
  }
  return out;
}

export const MODE_DEFS: Array<{ id: Mode; label: string; hint: string; planned?: boolean }> = [
  { id: 'write', label: 'Write', hint: 'Screenplay editing. Fountain subset — cues, parentheticals, [BEAT ms].' },
  { id: 'direct', label: 'Direct', hint: 'Shot proposal, beat direction, staging. Locked beats survive reruns.' },
  { id: 'animate', label: 'Animate', hint: 'Blocking, rig controls, Point A → Point B motion paths.' },
  { id: 'perform', label: 'Perform', hint: 'Line Booth and Scene Run capture, takes, trims, voice conversion.' },
  { id: 'sound', label: 'Sound', hint: 'Not in the engine yet — mix, stems and Foley are CLI-only today.', planned: true },
  { id: 'publish', label: 'Publish', hint: 'Production readiness, 16:9 / 9:16 masters, captions, export manifest.' },
];

export const MODE_BLURBS: Record<Mode, string> = {
  write: 'Script is the source of truth. Beats are explicit — the pause is the joke.',
  direct: 'Direction is propose-then-apply. Locked beats survive every rerun.',
  animate: 'Pause on a frame, drag a handle. Generated motion stays underneath.',
  perform: 'Follow Performance keeps your timing, pauses and cadence. Only identity converts.',
  sound: 'Designed ahead of the engine — 48 kHz stereo mix, stems and deterministic Foley.',
  publish: 'Production render is stricter than preview. Blockers are listed, not guessed at.',
};

/** The inspector tab each mode lands on. */
export function defaultTabFor(mode: Mode): InspectorTab {
  if (mode === 'animate') return 'motion';
  if (mode === 'perform') return 'voice';
  if (mode === 'publish' || mode === 'sound') return 'scene';
  return 'beat';
}
