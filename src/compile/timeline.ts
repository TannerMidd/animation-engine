import type { ShotBeat, ShotList } from '../schema/script.ts';
import type { LineTiming, WordTiming } from '../voice/visemes.ts';
import { activeIdentity } from '../show/context.ts';
import { gestureReleaseMs } from './performance.ts';
import { alignedWordAnchorId, canonicalWordAnchorId, type AnimationTimeline } from './animation.ts';

/** Breathing room after each line so dialogue does not butt end-to-end. */
export const LINE_TAIL_MS = 160;
const WORDS_PER_SECOND = 2.7;

export function estimateLineMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(700, Math.round((words / WORDS_PER_SECOND) * 1000)) + LINE_TAIL_MS;
}

export function cardTiming(shots: Pick<ShotList, 'cards' | 'fps'>): {
  titleMs: number;
  endMs: number;
  titleFrames: number;
  endFrames: number;
} {
  if (!shots.cards) return { titleMs: 0, endMs: 0, titleFrames: 0, endFrames: 0 };
  const cards = activeIdentity().visual.cards;
  return {
    titleFrames: cards.titleFrames,
    endFrames: cards.endFrames,
    titleMs: (cards.titleFrames / shots.fps) * 1000,
    endMs: (cards.endFrames / shots.fps) * 1000,
  };
}

export interface TimedBeat {
  beat: ShotBeat;
  index: number;
  startMs: number;
  endMs: number;
  timing?: LineTiming;
  /** When a held gesture on this beat drops back into talking. */
  releaseMs: number;
}

export function buildTimeline(shots: ShotList, timings: Map<number, LineTiming>): TimedBeat[] {
  const out: TimedBeat[] = [];
  let cursor = 0;
  let previousSpeechEndMs: number | null = null;

  shots.beats.forEach((beat, index) => {
    let timing: LineTiming | undefined;
    if (beat.kind === 'line') {
      timing = timings.get(index);
      if (!timing) throw new Error(`beat ${index} is a line but has no audio timing`);
      if (!timing.editorialTiming) {
        const startMs = cursor;
        const endMs = startMs + timing.durationMs + LINE_TAIL_MS;
        out.push({ beat, index, startMs, endMs, timing, releaseMs: 0 });
        previousSpeechEndMs = startMs + (timing.speechEndMs ?? timing.durationMs);
        cursor = endMs;
        return;
      }

      const speechOnsetMs = timing.speechOnsetMs ?? timing.speechStartMs ?? 0;
      const neutralSpeechStart =
        previousSpeechEndMs === null
          ? cursor + speechOnsetMs
          : Math.max(cursor, previousSpeechEndMs + (timing.turnGapMs ?? 0));
      let requestedStart =
        neutralSpeechStart - speechOnsetMs - (timing.pickupMs ?? 0) - (timing.overlapMs ?? 0);

      if (timing.absoluteStartMs !== undefined) {
        if (timing.overlapWithCueId) {
          throw new Error(
            `dialogue cue "${timing.cueId ?? index}" cannot combine an absolute start with an overlap target`,
          );
        }
        requestedStart = timing.absoluteStartMs;
      }

      if (timing.overlapWithCueId) {
        const overlapWithCueId = timing.overlapWithCueId;
        const target = [...out].reverse().find((candidate) => candidate.beat.id === overlapWithCueId);
        const previousLine = [...out].reverse().find((candidate) => candidate.beat.kind === 'line');
        if (!target || target.beat.kind !== 'line' || !target.timing) {
          throw new Error(
            `dialogue cue "${timing.cueId ?? index}" overlaps unavailable cue "${overlapWithCueId}"`,
          );
        }
        if (target !== previousLine || target !== out[out.length - 1]) {
          throw new Error(
            `dialogue cue "${timing.cueId ?? index}" may only overlap the immediately preceding dialogue cue`,
          );
        }
        if (
          timing.overlapMode === 'interruption' &&
          timing.interruptAtMs !== null &&
          timing.interruptAtMs !== undefined
        ) {
          const cutLocalMs = timing.interruptAtMs;
          if (cutLocalMs <= 0 || cutLocalMs >= target.timing.durationMs) {
            throw new Error(
              `dialogue cue "${timing.cueId ?? index}" interruption point ${cutLocalMs}ms is outside ` +
                `"${overlapWithCueId}" (${Math.round(target.timing.durationMs)}ms)`,
            );
          }
          const cutMs = target.startMs + cutLocalMs;
          const cropTokens = <T extends { startMs: number; endMs: number }>(
            tokens: readonly T[] | undefined,
          ): T[] | undefined =>
            tokens?.flatMap((token) =>
              token.startMs >= cutLocalMs ? [] : [{ ...token, endMs: Math.min(token.endMs, cutLocalMs) }],
            );
          target.timing = {
            ...target.timing,
            durationMs: cutLocalMs,
            playbackDurationMs: Math.min(target.timing.playbackDurationMs ?? cutLocalMs, cutLocalMs),
            speechStartMs: Math.min(target.timing.speechStartMs ?? cutLocalMs, cutLocalMs),
            speechOnsetMs: Math.min(target.timing.speechOnsetMs ?? cutLocalMs, cutLocalMs),
            speechEndMs: Math.min(target.timing.speechEndMs ?? cutLocalMs, cutLocalMs),
            cues: target.timing.cues.filter((cue) => cue.ms < cutLocalMs),
            words: cropTokens(target.timing.words),
            alignment: target.timing.alignment
              ? {
                  ...target.timing.alignment,
                  words: cropTokens(target.timing.alignment.words) ?? [],
                }
              : undefined,
          };
          target.endMs = cutMs;
          cursor = cutMs;
          previousSpeechEndMs = cutMs;
          requestedStart = cutMs - speechOnsetMs;
        }
      }

      const previousStart = out[out.length - 1]?.startMs ?? 0;
      if (timing.absoluteStartMs !== undefined && requestedStart < previousStart - 1e-6) {
        throw new Error(
          `dialogue cue "${timing.cueId ?? index}" absolute start ${Math.round(requestedStart)}ms ` +
            `precedes the previous beat start ${Math.round(previousStart)}ms`,
        );
      }
      const startMs = Math.max(0, previousStart, requestedStart);
      const endMs = startMs + timing.durationMs + (timing.pauseAfterMs ?? 0);
      out.push({ beat, index, startMs, endMs, timing, releaseMs: 0 });
      previousSpeechEndMs = startMs + (timing.speechEndMs ?? timing.durationMs);
      cursor = Math.max(cursor, endMs);
      return;
    }

    out.push({ beat, index, startMs: cursor, endMs: cursor + beat.ms, releaseMs: 0 });
    cursor += beat.ms;
  });

  for (const timed of out) timed.releaseMs = gestureReleaseMs(timed, shots.characterFps);
  return out;
}

const VALID_ANIMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function estimatedWordTimings(text: string, startMs: number, endMs: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const span = (endMs - startMs) / words.length;
  return words.map((word, index) => ({
    text: word,
    startMs: startMs + span * index,
    endMs: startMs + span * (index + 1),
  }));
}

function animationWords(words: WordTiming[], lineStartMs: number) {
  return words.flatMap((word, index) => {
    const canonical = canonicalWordAnchorId(index);
    const supplied = word.id ?? alignedWordAnchorId(index, word.text);
    const item = {
      id: canonical,
      text: word.text,
      startMs: lineStartMs + word.startMs,
      endMs: lineStartMs + word.endMs,
    };
    return VALID_ANIMATION_ID.test(supplied) && supplied !== canonical
      ? [item, { ...item, id: supplied }]
      : [item];
  });
}

export function buildAnimationTimeline(
  timeline: TimedBeat[],
  titleMs: number,
  endMs: number,
): AnimationTimeline {
  const bodyDurationMs = timeline.reduce((max, timed) => Math.max(max, timed.endMs), 0);
  return {
    durationMs: titleMs + bodyDurationMs + endMs,
    beats: timeline.map((timed) => {
      const beatId = timed.beat.id;
      if (!beatId) throw new Error(`beat ${timed.index} has no stable id for animation anchors`);
      const startMs = titleMs + timed.startMs;
      const endMs = titleMs + timed.endMs;
      if (timed.beat.kind !== 'line' || !timed.timing) return { id: beatId, startMs, endMs };

      const timing = timed.timing;
      const declaredSpeechStart = timing.speechStartMs ?? timing.speechOnsetMs ?? 0;
      const declaredSpeechEnd = timing.speechEndMs ?? timing.durationMs;
      const providedWords = timing.words ?? timing.alignment?.words ?? [];
      const rawWords = providedWords.length
        ? providedWords
        : estimatedWordTimings(timed.beat.text, declaredSpeechStart, declaredSpeechEnd);
      const words = animationWords(rawWords, startMs);
      const firstWord = rawWords.length ? Math.min(...rawWords.map((word) => word.startMs)) : Infinity;
      const lastWord = rawWords.length ? Math.max(...rawWords.map((word) => word.endMs)) : -Infinity;
      const localSpeechStart = Math.min(declaredSpeechStart, firstWord);
      const localSpeechEnd = Math.max(declaredSpeechEnd, lastWord);
      if (
        !Number.isFinite(localSpeechStart) ||
        !Number.isFinite(localSpeechEnd) ||
        localSpeechStart < 0 ||
        localSpeechEnd < localSpeechStart ||
        localSpeechEnd > timing.durationMs
      ) {
        throw new Error(`line beat "${beatId}" has invalid semantic speech timing`);
      }
      return {
        id: beatId,
        startMs,
        endMs,
        speech: {
          startMs: startMs + localSpeechStart,
          endMs: startMs + localSpeechEnd,
          words,
        },
      };
    }),
  };
}

export function animationTimelineForTimings(
  shots: ShotList,
  timings: Map<number, LineTiming>,
): AnimationTimeline {
  const timeline = buildTimeline(shots, timings);
  const cards = cardTiming(shots);
  return buildAnimationTimeline(timeline, cards.titleMs, cards.endMs);
}
