import type { Beat, PropReferenceIssue, SetFit, ShotList, StageAction } from '../types.ts';

/**
 * Repairing a scene that its new set cannot host.
 *
 * The engine is right to refuse to guess which prop an authored reference meant
 * — a set edit that silently re-aimed a tap would break continuity quietly. But
 * refusing at compile time, after the switch, is what made the editor look
 * broken: the stage went blank and quoted an exception.
 *
 * So the guess moves forward in time and out into the open. Where the new set
 * offers exactly one thing that can take the reference, that is a repair the
 * editor can apply on request, named in full before anything is written.
 *
 * Retargeting is the *only* repair on offer, deliberately. Dropping the
 * business instead is not a smaller change, it is an invalid one: an action
 * beat carrying prose with nothing staged fails to compile in its own right
 * ("has prose but no structured stage action"), so a scene repaired that way
 * would still not play. Everything else — rewriting the beat, cutting it,
 * choosing between several candidate props — is the creator's call, and the
 * editor's job is to say so precisely rather than decide for them.
 */

export interface SetRepair {
  issue: PropReferenceIssue;
  /** The reference written in place of the one the set cannot resolve. */
  to: string;
  /** One line for the confirm list, phrased as what will happen. */
  text: string;
}

/** Substitutes that can actually be written back into the shot list. */
export function usableSubstitutes(issue: PropReferenceIssue) {
  return issue.substitutes.filter((option) => option.reference);
}

/**
 * The repairs a set change can make by itself: one candidate, one answer.
 *
 * An issue with several candidates is left out — choosing between a desk and a
 * monitor is a staging decision, and the blocked stage offers them as buttons
 * rather than picking one here.
 */
export function planSetRepairs(fit: SetFit | undefined): SetRepair[] {
  if (!fit) return [];
  const out: SetRepair[] = [];
  for (const issue of fit.issues) {
    const usable = usableSubstitutes(issue);
    if (usable.length !== 1) continue;
    const only = usable[0]!;
    out.push({
      issue,
      to: only.reference!,
      text: `${issue.verb} the ${only.label.toLowerCase()} instead of the ${issue.reference}`,
    });
  }
  return out;
}

/** Problems the editor cannot settle on its own, and why. */
export function unresolvedIssues(fit: SetFit | undefined): PropReferenceIssue[] {
  if (!fit) return [];
  return fit.issues.filter((issue) => usableSubstitutes(issue).length !== 1);
}

/** How to say what is left for the creator to decide. */
export function unresolvedText(issue: PropReferenceIssue): string {
  const usable = usableSubstitutes(issue);
  return usable.length
    ? `${usable.length} props here could take it — choose one`
    : `nothing here to ${issue.verb} — rewrite the beat, or stage the scene elsewhere`;
}

function repairBeat(beat: Beat, repairs: SetRepair[]): Beat {
  if (beat.kind !== 'action') return beat;
  const stage = (beat.stage ?? []) as StageAction[];
  return {
    ...beat,
    stage: stage.map((action, index) => {
      const mine = repairs.filter((repair) => repair.issue.actionIndex === index);
      return mine.reduce<StageAction>(
        (patched, repair) => ({ ...patched, [repair.issue.field]: repair.to }) as StageAction,
        action,
      );
    }),
  };
}

/**
 * Apply repairs to a shot list, leaving everything they do not name untouched.
 *
 * Nothing is removed and no beat changes kind, so this stays an ordinary
 * shot-list edit: the script still says exactly what it said, and directing
 * again restores whatever the original staging was.
 */
export function applySetRepairs(shots: ShotList, repairs: SetRepair[]): ShotList {
  if (!repairs.length) return shots;

  const byBeat = new Map<number, SetRepair[]>();
  const byActor = new Map<string, SetRepair[]>();
  for (const repair of repairs) {
    const { beatIndex, actorId } = repair.issue;
    if (beatIndex !== null) byBeat.set(beatIndex, [...(byBeat.get(beatIndex) ?? []), repair]);
    else if (actorId) byActor.set(actorId, [...(byActor.get(actorId) ?? []), repair]);
  }

  return {
    ...shots,
    cast: shots.cast.map((member) => {
      const mine = byActor.get(member.id);
      if (!mine?.length) return member;
      return mine.reduce(
        (next, repair) => ({ ...next, [repair.issue.field]: repair.to }),
        member,
      );
    }),
    beats: shots.beats.map((beat, index) => {
      const mine = byBeat.get(index);
      return mine?.length ? repairBeat(beat, mine) : beat;
    }),
  };
}

/** Point one authored reference at one prop — the per-issue form of the same edit. */
export function retargetOne(shots: ShotList, issue: PropReferenceIssue, to: string): ShotList {
  return applySetRepairs(shots, [{ issue, to, text: '' }]);
}
