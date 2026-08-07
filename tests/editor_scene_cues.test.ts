import { describe, expect, it } from 'vitest';
import type { Beat, DialogueCue, DialogueDocument, ShotList } from '../ui/src/types.ts';
import { orphanedCues, sceneCues } from '../ui/src/editor/lib.ts';

function cue(id: string, speaker: string, text: string, beatIndex: number): DialogueCue {
  return {
    id,
    beatIndex,
    speaker,
    displayText: text,
    spokenText: text,
    selectedTakeId: null,
    selectedRenderId: null,
    voiceSource: 'performance',
    seed: 1,
    delivery: { expression: 'NEUTRAL', intent: '', energy: 1, pace: 1, notes: [], emphasis: [], pronunciations: [] },
    trim: null,
    startFrame: 0,
    durationFrames: null,
    pickupMs: 0,
    turnGapMs: 220,
    pauseAfterMs: 0,
    overlap: null,
    durationPolicy: {
      mode: 'follow-performance',
      targetFrames: null,
      warnVoicedStretchRatio: 0.03,
      maxVoicedStretchRatio: 0.05,
      downstream: 'ripple',
    },
    approval: { state: 'draft', by: null, at: null, notes: [] },
    locked: false,
    lockedFields: [],
    provenance: { origin: 'generated', revision: 1, createdBy: null, createdAt: null, derivedFromRevision: null },
  } as unknown as DialogueCue;
}

function line(id: string, speaker: string, text: string): Beat {
  return {
    id, kind: 'line', speaker, text, expression: 'NEUTRAL', gesture: 'TALK',
    purpose: 'coverage', shot: 'MID', focus: [], camera: 'HOLD', reactions: {}, locked: false,
  } as Beat;
}

const shots = {
  scene: 'cue-test',
  beats: [
    line('line-a', 'brent', 'Morning, Paul. Quick one.'),
    { id: 'pause-1', kind: 'pause', ms: 900, purpose: 'coverage', shot: 'MID', focus: [], camera: 'HOLD', reactions: {} },
    line('line-b', 'paul', 'Morning.'),
  ],
} as unknown as ShotList;

/** Two live lines, plus three cues left over from an entirely different script. */
const dialogue = {
  cues: [
    cue('line-b', 'paul', 'Morning.', 2),
    cue('ghost-1', 'megan', 'Polaris. BRAD (calm) It is the north star.', 2),
    cue('line-a', 'brent', 'Morning, Paul. Quick one.', 0),
    cue('ghost-2', 'brad', 'Bring a telescope.', 25),
    cue('ghost-3', 'karen', 'This is… fine.', 30),
  ],
} as unknown as DialogueDocument;

describe('sceneCues', () => {
  it('keeps only the lines this script has, in beat order', () => {
    expect(sceneCues(dialogue, shots).map((c) => c.id)).toEqual(['line-a', 'line-b']);
  });

  it('lists what the script left behind so it can be shown apart and discarded', () => {
    expect(orphanedCues(dialogue, shots).map((c) => c.id)).toEqual(['ghost-1', 'ghost-2', 'ghost-3']);
  });

  it('shows everything when there is no shot list to resolve against', () => {
    // Before a scene is directed there is nothing to be orphaned *from*, and
    // hiding the document's own cues would claim the scene had none.
    expect(sceneCues(dialogue, null)).toHaveLength(5);
    expect(orphanedCues(dialogue, null)).toEqual([]);
  });

  it('is empty without a dialogue document rather than throwing', () => {
    expect(sceneCues(null, shots)).toEqual([]);
    expect(orphanedCues(null, shots)).toEqual([]);
  });
});
