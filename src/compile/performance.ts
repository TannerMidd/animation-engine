import { Rng, deriveSeed } from '../core/rng.ts';
import { activeIdentity } from '../show/context.ts';
import type { Rig } from '../schema/index.ts';
import type { ShotBeat, ShotList } from '../schema/script.ts';

/**
 * Performance tracks: who is doing what with their face and body, and *when*,
 * at finer grain than the beat.
 *
 * The old model gave every beat one expression and one pose per character,
 * changing exactly on beat boundaries — which is why everyone reacted the
 * instant a line began (nobody does) and held a pointed finger for a whole
 * paragraph (nobody does that either). This layer resolves the shot list into
 * per-character timed segments before any frame is sampled:
 *
 *   - listeners react *after* a personal latency, so a cut to the listener
 *     catches the reaction landing rather than already installed;
 *   - gestures arc — land, hold, and release back into talking — instead of
 *     switching on for the duration of a beat;
 *   - idle characters shift their weight on a held schedule, aligned to the
 *     character frame grid so frame deduplication survives;
 *   - listeners look at whoever is talking, when their puppet can.
 *
 * Everything here is resolved once per compile from seeded streams; the frame
 * loop just reads segments. No per-frame randomness, no drift.
 */

export interface Timed {
  beat: ShotBeat;
  index: number;
  startMs: number;
  endMs: number;
}

interface Segment {
  fromMs: number;
  value: string;
}

export interface ActingResolved {
  reactionMs: number;
  gestureBias: number;
  fidgetAmp: number;
}

export function actingOf(rig: Rig): ActingResolved {
  const envelope = activeIdentity().performance.acting;
  const own = rig.acting;
  return {
    reactionMs: Math.min(
      envelope.reaction.maxMs,
      Math.max(envelope.reaction.minMs, own?.reactionMs ?? 280),
    ),
    gestureBias: own?.gestureBias ?? 1,
    fidgetAmp: own?.fidgetAmp ?? envelope.fidget.amp,
  };
}

/** Quantize a time to the character-frame grid, so changes land on held frames. */
export function quantizeMs(ms: number, characterFps: number): number {
  const frame = 1000 / characterFps;
  return Math.round(ms / frame) * frame;
}

/**
 * A character's expression timeline, with listener latency applied.
 *
 * Speakers change on the boundary — their line *is* the change. Listeners keep
 * wearing the previous face for their personal reaction time, quantized to the
 * character grid. A reaction that would land after the beat already ended is
 * dropped rather than flashing for a single frame.
 */
export function expressionSegments(
  timeline: Timed[],
  actorId: string,
  resting: string,
  acting: ActingResolved,
  characterFps: number,
): Segment[] {
  const segments: Segment[] = [{ fromMs: 0, value: resting }];
  const current = () => segments[segments.length - 1]!.value;

  for (const t of timeline) {
    const isSpeaker = t.beat.kind === 'line' && t.beat.speaker === actorId;
    const want = isSpeaker
      ? (t.beat as Extract<ShotBeat, { kind: 'line' }>).expression
      : (t.beat.reactions[actorId] ?? current());

    if (want === current()) continue;

    const at = isSpeaker ? t.startMs : quantizeMs(t.startMs + acting.reactionMs, characterFps);
    if (!isSpeaker && at >= t.endMs) continue;
    segments.push({ fromMs: at, value: want });
  }
  return segments;
}

export function valueAt(segments: Segment[], ms: number): string {
  let value = segments[0]!.value;
  for (const s of segments) {
    if (s.fromMs <= ms) value = s.value;
    else break;
  }
  return value;
}

/**
 * When a held gesture releases back into ordinary talking.
 *
 * A gesture beat (POINT, SHRUG…) lands at the top of the line, holds for at
 * least the show's minimum, and drops at the release fraction of the line —
 * so a long line ends with the speaker just talking again, which is what makes
 * the gesture read as punctuation instead of a costume.
 */
export function gestureReleaseMs(beat: Timed, characterFps: number): number {
  const acting = activeIdentity().performance.acting;
  const span = beat.endMs - beat.startMs;
  const release = Math.max(acting.gestureMinHoldMs, span * acting.gestureReleaseFraction);
  return quantizeMs(Math.min(beat.startMs + release, beat.endMs), characterFps);
}

export interface FidgetShift {
  fromMs: number;
  dx: number;
}

/**
 * A character's weight-shift schedule for the whole scene.
 *
 * Held offsets, changing every few seconds, quantized to the grid — never a
 * sway. A sway animates every frame and destroys the held-frame deduplication
 * that limited animation's economics (and look) depend on; a shift *is* a held
 * frame, just a different one.
 */
export function fidgetSchedule(
  seed: number,
  key: string,
  durationMs: number,
  acting: ActingResolved,
  characterFps: number,
): FidgetShift[] {
  if (acting.fidgetAmp <= 0) return [{ fromMs: 0, dx: 0 }];
  const envelope = activeIdentity().performance.acting.fidget;
  const rng = new Rng(deriveSeed(seed, `fidget:${key}`));

  const shifts: FidgetShift[] = [{ fromMs: 0, dx: 0 }];
  let at = rng.range(envelope.minMs, envelope.maxMs);
  let side = rng.chance(0.5) ? 1 : -1;
  while (at < durationMs) {
    // Alternate sides with occasional recentring, so it reads as weight moving
    // rather than as drifting off the mark.
    const dx = rng.chance(0.25) ? 0 : side * rng.range(acting.fidgetAmp * 0.5, acting.fidgetAmp);
    side = -side;
    shifts.push({ fromMs: quantizeMs(at, characterFps), dx: Math.round(dx * 10) / 10 });
    at += rng.range(envelope.minMs, envelope.maxMs);
  }
  return shifts;
}

export function fidgetAt(shifts: FidgetShift[], ms: number): number {
  let dx = 0;
  for (const s of shifts) {
    if (s.fromMs <= ms) dx = s.dx;
    else break;
  }
  return dx;
}

/**
 * Should this listener's eyes cut toward the speaker right now?
 *
 * Only when the geometry supports it: the side-eye variant shifts pupils
 * toward the puppet's local +x, so it reads as "toward the speaker" only when
 * that direction actually points at them after staging and flip. When it
 * doesn't, the character is already bodily facing the speaker and open eyes
 * read fine — a wrong-way glance is worse than none.
 */
export function gazeTowardSpeaker(
  listener: { x: number; flip: boolean },
  speakerX: number,
): boolean {
  if (!activeIdentity().performance.acting.gaze) return false;
  const localPlusXIsRight = !listener.flip;
  return localPlusXIsRight ? speakerX > listener.x : speakerX < listener.x;
}

/** The speaker's stage x for a line beat, if anyone is speaking. */
export function speakerXFor(beat: ShotBeat, shots: ShotList, xs: Map<string, number>): number | null {
  if (beat.kind !== 'line') return null;
  return xs.get(beat.speaker) ?? null;
}
