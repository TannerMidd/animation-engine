import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tempDir } from './helpers.ts';
import { ShotList } from '../src/schema/script.ts';
import { syncDialogueDocument, writeDialogueDocument } from '../src/pipeline/dialogue.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

const shots = () => ShotList.parse({
  scene: 'sync-test',
  cards: false,
  cast: [{ id: 'mel', rig: 'mel', mark: 'CENTER', resting: 'DEADPAN' }],
  beats: [{
    kind: 'line', speaker: 'mel', text: 'What is item four?', expression: 'CONFUSED', gesture: 'NONE',
    reactions: {}, shot: 'CU', focus: ['mel'], camera: 'HOLD',
  }],
});

describe('dialogue cue synchronization', () => {
  it('creates stable line cues with synthesis text independent of display text', async () => {
    const out = await tempDir('dialogue-sync');
    dirs.push(out);
    const first = await syncDialogueDocument('sync-test', shots(), out);
    expect(first.cues).toHaveLength(1);
    expect(first.cues[0]!.id).toBe(shots().beats[0]!.id);

    const edited = {
      ...first,
      cues: first.cues.map((cue) => ({ ...cue, spokenText: 'What is item four?' })),
    };
    await writeDialogueDocument('sync-test', edited, out);
    const again = await syncDialogueDocument('sync-test', shots(), out);
    expect(again.cues[0]!.spokenText).toBe('What is item four?');
    expect(again.cues[0]!.id).toBe(first.cues[0]!.id);
  });
});
