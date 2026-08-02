import type { ShotBeat, ShotList } from '../schema/script.ts';

/**
 * Non-destructive directing.
 *
 * The director's output is a proposal; applying it merges rather than
 * replaces. Locked beats — the ones whose timing or staging someone fixed by
 * hand — survive the merge verbatim, matched to their counterpart in the
 * proposal by content, not index, so inserting a line above a locked beat
 * doesn't unlock it by shifting it.
 */

/** What a beat is "about", for matching a locked beat to its proposed self. */
function matchKey(beat: ShotBeat): string {
  switch (beat.kind) {
    case 'line':
      return `line:${beat.speaker}:${beat.text}`;
    case 'action':
      return `action:${beat.text}`;
    case 'pause':
      // Pauses have no text; the script position (relative order among pauses)
      // is the only identity they have, which `consumed` handles below.
      return 'pause';
  }
}

export interface MergeResult {
  merged: ShotList;
  /** Locked beats that no proposed beat matched — kept nowhere, reported. */
  droppedLocked: ShotBeat[];
  /** How many proposed beats were replaced by locked originals. */
  keptLocked: number;
}

export function mergeShotLists(current: ShotList | null, proposed: ShotList): MergeResult {
  if (!current) return { merged: proposed, droppedLocked: [], keptLocked: 0 };

  const locked = current.beats.filter((b) => b.locked);
  if (!locked.length) return { merged: proposed, droppedLocked: [], keptLocked: 0 };

  // Each locked beat consumes the first unconsumed proposed beat with the same
  // key, in order — so two identical short lines lock independently.
  const consumed = new Set<number>();
  const beats = [...proposed.beats];
  const droppedLocked: ShotBeat[] = [];
  let keptLocked = 0;

  for (const lockedBeat of locked) {
    const key = matchKey(lockedBeat);
    const at = beats.findIndex((b, i) => !consumed.has(i) && matchKey(b) === key);
    if (at === -1) {
      droppedLocked.push(lockedBeat);
      continue;
    }
    consumed.add(at);
    beats[at] = lockedBeat;
    keptLocked++;
  }

  return { merged: { ...proposed, beats }, droppedLocked, keptLocked };
}

export interface BeatDiff {
  index: number;
  kind: string;
  change: 'added' | 'removed' | 'changed' | 'kept-locked';
  summary: string;
}

/** A human-scale summary of what applying a proposal would do. */
export function diffShotLists(current: ShotList | null, proposed: ShotList): BeatDiff[] {
  if (!current) {
    return proposed.beats.map((b, index) => ({
      index,
      kind: b.kind,
      change: 'added' as const,
      summary: beatSummary(b),
    }));
  }

  const diffs: BeatDiff[] = [];
  const max = Math.max(current.beats.length, proposed.beats.length);
  for (let i = 0; i < max; i++) {
    const before = current.beats[i];
    const after = proposed.beats[i];
    if (!before && after) diffs.push({ index: i, kind: after.kind, change: 'added', summary: beatSummary(after) });
    else if (before && !after) diffs.push({ index: i, kind: before.kind, change: 'removed', summary: beatSummary(before) });
    else if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
      diffs.push({
        index: i,
        kind: after.kind,
        change: before.locked ? 'kept-locked' : 'changed',
        summary: beatSummary(after),
      });
    }
  }
  return diffs;
}

function beatSummary(beat: ShotBeat): string {
  switch (beat.kind) {
    case 'line':
      return `${beat.speaker}: "${beat.text.slice(0, 40)}${beat.text.length > 40 ? '…' : ''}" [${beat.shot}/${beat.camera}]`;
    case 'pause':
      return `pause ${beat.ms}ms [${beat.shot}]`;
    case 'action':
      return `action "${beat.text.slice(0, 40)}" [${beat.shot}]`;
  }
}
