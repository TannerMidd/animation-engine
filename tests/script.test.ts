import { describe, it, expect } from 'vitest';
import { parseScript } from '../src/parse/index.ts';
import { autoDirect, buildCapabilityManifest, validateShotList } from '../src/direct/index.ts';
import { parseSapiOutput, sapiVisemeToMouth, mouthAt } from '../src/voice/visemes.ts';
import { baseFrame } from '../src/render/framing.ts';
import { testRigs } from './helpers.ts';

const SCRIPT = `# THE TEMPLATE

INT. OPEN PLAN OFFICE - MORNING

Brent approaches the desk.

BRENT
(deadpan)
Morning, Paul.

PAUL
Morning.

[BEAT 1200]

BRENT
So if you could go ahead and send it again,
that'd be terrific.
`;

describe('parseScript', () => {
  const sp = parseScript(SCRIPT);

  it('takes its title from the first section heading', () => {
    expect(sp.title).toBe('THE TEMPLATE');
  });

  it('collects characters in order of first appearance', () => {
    expect(sp.characters).toEqual(['BRENT', 'PAUL']);
  });

  it('classifies each element', () => {
    expect(sp.elements.map((e) => e.kind)).toEqual([
      'heading', 'action', 'dialogue', 'dialogue', 'beat', 'dialogue',
    ]);
  });

  it('reads parentheticals as emotion hints, not as dialogue', () => {
    const first = sp.elements.find((e) => e.kind === 'dialogue');
    expect(first).toMatchObject({ speaker: 'BRENT', parenthetical: 'deadpan', text: 'Morning, Paul.' });
  });

  it('joins dialogue that wraps across lines', () => {
    const last = sp.elements.at(-1);
    expect(last).toMatchObject({ text: "So if you could go ahead and send it again, that'd be terrific." });
  });

  it('reads explicit beat durations', () => {
    expect(sp.elements.find((e) => e.kind === 'beat')).toMatchObject({ ms: 1200 });
  });

  it('treats an all-caps line with nothing after it as action', () => {
    // A cue with no dialogue under it is shouting, not a character heading.
    const sp2 = parseScript('SOMEWHERE, A PHONE RINGS');
    expect(sp2.elements[0]?.kind).toBe('action');
  });

  it('turns a wordless dialogue line into a beat', () => {
    // Generated scripts write silences as "..." under a cue. Sent to a TTS
    // engine that produces audio of unpredictable length and a mouth flapping
    // at nothing, so it becomes the pause it actually is.
    const sp2 = parseScript('BRENT\nMorning.\n\nPAUL\n…\n\nBRENT\nRight.\n');
    expect(sp2.elements.map((e) => e.kind)).toEqual(['dialogue', 'beat', 'dialogue']);
  });

  it.each(['...', '…', '—', '?!', '   .   '])('treats %j as a beat, not dialogue', (text) => {
    const sp2 = parseScript(`PAUL\n${text}\n`);
    expect(sp2.elements[0]?.kind).toBe('beat');
  });

  it('keeps a line that has any real content', () => {
    const sp2 = parseScript('PAUL\n...what.\n');
    expect(sp2.elements[0]).toMatchObject({ kind: 'dialogue', text: '...what.' });
  });

  it('ignores comments entirely', () => {
    const sp2 = parseScript('// a note\nBRENT\nMorning.\n');
    expect(sp2.elements.map((e) => e.kind)).toEqual(['dialogue']);
  });

  it('does not let a comment between a cue and its dialogue demote the cue', () => {
    // The "is there anything after this cue" lookahead has to skip comments,
    // or an innocuous note silently turns the cue into an action line.
    const sp2 = parseScript('BRENT\n// reminder: rewrite this\nMorning.\n');
    expect(sp2.elements[0]).toMatchObject({ kind: 'dialogue', speaker: 'BRENT', text: 'Morning.' });
  });

  it('keeps a commented-out line out of the dialogue', () => {
    const sp2 = parseScript('BRENT\nMorning.\n// Afternoon.\n');
    expect(sp2.elements[0]).toMatchObject({ text: 'Morning.' });
  });
});

describe('autoDirect', () => {
  const rigs = testRigs(['brent', 'paul']);
  const shots = autoDirect(parseScript(SCRIPT), rigs, { scene: 'test' });

  it('produces a shot list that validates against the cast', () => {
    expect(validateShotList(shots, buildCapabilityManifest(rigs))).toEqual([]);
  });

  it('stages two characters facing each other', () => {
    expect(shots.cast.map((c) => c.mark)).toEqual(['SL', 'SR']);
    expect(shots.cast.map((c) => c.flip)).toEqual([false, true]);
  });

  it('cuts to the listener on a pause', () => {
    // The reaction shot: a silence only plays if you can see it land.
    const pause = shots.beats.find((b) => b.kind === 'pause');
    expect(pause?.focus).toEqual(['brent']);
  });

  it('cuts to the person being spoken to, not a bystander', () => {
    // With three in the room, "anyone who isn't talking" lands the reaction on
    // whoever happens to be first in the cast. The one being addressed is the
    // one who spoke before the current speaker.
    const sp = parseScript(
      'ALICE\nOne.\n\nBOB\nTwo.\n\nCAROL\nThree.\n\n[BEAT 1200]\n',
    );
    const three = autoDirect(sp, testRigs(['alice', 'bob', 'carol']), { scene: 'x' });
    const pause = three.beats.find((b) => b.kind === 'pause');
    expect(pause?.focus).toEqual(['bob']);
  });

  it('maps a parenthetical to an expression', () => {
    const line = shots.beats.find((b) => b.kind === 'line');
    expect(line).toMatchObject({ speaker: 'brent', expression: 'DEADPAN' });
  });

  it('is deterministic for a given seed', () => {
    const a = autoDirect(parseScript(SCRIPT), rigs, { scene: 'test', seed: 3 });
    const b = autoDirect(parseScript(SCRIPT), rigs, { scene: 'test', seed: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('refuses a character who has no rig, naming them', () => {
    const sp = parseScript('MILTON\nThey took my stapler.\n');
    expect(() => autoDirect(sp, testRigs(['brent']), { scene: 'x' })).toThrow(/milton/);
  });
});

describe('validateShotList', () => {
  const rigs = testRigs(['brent', 'paul']);
  const manifest = buildCapabilityManifest(rigs);

  it('rejects an expression the rig does not have', () => {
    // The guard that makes this stage safe to hand to an LLM later.
    const shots = autoDirect(parseScript(SCRIPT), rigs, { scene: 'test' });
    const line = shots.beats.find((b) => b.kind === 'line')!;
    if (line.kind === 'line') line.expression = 'ELATED';
    expect(validateShotList(shots, manifest).join('\n')).toMatch(/ELATED/);
  });

  it('rejects a gesture that is not a pose', () => {
    const shots = autoDirect(parseScript(SCRIPT), rigs, { scene: 'test' });
    const line = shots.beats.find((b) => b.kind === 'line')!;
    if (line.kind === 'line') line.gesture = 'BACKFLIP';
    expect(validateShotList(shots, manifest).join('\n')).toMatch(/BACKFLIP/);
  });
});

describe('visemes', () => {
  it('maps SAPI ids onto Rhubarb mouth shapes', () => {
    expect(sapiVisemeToMouth(0)).toBe('X'); // silence -> rest
    expect(sapiVisemeToMouth(21)).toBe('A'); // p/b/m  -> closed
    expect(sapiVisemeToMouth(2)).toBe('D'); // aa      -> wide open
    expect(sapiVisemeToMouth(18)).toBe('G'); // f/v    -> teeth on lip
    expect(sapiVisemeToMouth(99)).toBe('X'); // unknown -> rest
  });

  it('collapses runs of the same shape', () => {
    // s, z and t all resolve to B; holding the shape is what actually happens,
    // and collapsing keeps both the IR and the frame dedup tighter.
    const { cues } = parseSapiOutput('duration\t1000\n0\t15\n100\t15\n200\t19\n400\t2\n');
    expect(cues).toEqual([
      { ms: 0, shape: 'B' },
      { ms: 400, shape: 'D' },
    ]);
  });

  it('always starts from rest so a line cannot inherit the last mouth', () => {
    const { cues } = parseSapiOutput('duration\t500\n300\t2\n');
    expect(cues[0]).toEqual({ ms: 0, shape: 'X' });
  });

  it('holds a shape until the next cue', () => {
    const cues = [
      { ms: 0, shape: 'X' as const },
      { ms: 100, shape: 'D' as const },
      { ms: 200, shape: 'A' as const },
    ];
    expect(mouthAt(cues, 50)).toBe('X');
    expect(mouthAt(cues, 150)).toBe('D');
    expect(mouthAt(cues, 9999)).toBe('A');
  });
});

describe('framing', () => {
  const stage = { width: 1280, height: 720 };
  const actors = [
    { id: 'a', x: 400, y: 700, scale: 1.25, headX: 400, headY: 275, headR: 95 },
    { id: 'b', x: 880, y: 700, scale: 1.25, headX: 880, headY: 275, headR: 95 },
  ];

  it('frames WIDE on the whole stage', () => {
    expect(baseFrame('WIDE', [], actors, stage)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it('centres a close-up on its subject even at the edge of the stage', () => {
    // Clamping to the stage would shove the subject out of the middle of their
    // own shot, which is why sets are drawn wider than the frame.
    const cam = baseFrame('CU', ['b'], actors, stage);
    expect(cam.x + cam.w / 2).toBeCloseTo(880, 5);
  });

  it('keeps every shot at the output aspect ratio', () => {
    for (const shot of ['MID', 'CU', 'ECU', 'OTS', 'TWO_SHOT'] as const) {
      const cam = baseFrame(shot, ['a'], actors, stage);
      expect(cam.w / cam.h, shot).toBeCloseTo(1280 / 720, 5);
    }
  });

  it('widens a two-shot enough to contain both people', () => {
    const cam = baseFrame('TWO_SHOT', [], actors, stage);
    expect(cam.x).toBeLessThan(400);
    expect(cam.x + cam.w).toBeGreaterThan(880);
  });

  /**
   * A fixed close-up rectangle suited the average head and cropped the crown off
   * the big ones — which are now common, since build and a head slider both
   * scale it. Close-ups size themselves to the subject instead.
   */
  it('fits the whole head in a close-up, however big the head is', () => {
    for (const headR of [40, 70, 95, 130]) {
      const cam = baseFrame('CU', ['a'], [{ ...actors[0]!, headR }], stage);
      expect(cam.y, `headR ${headR}`).toBeLessThan(275 - headR);
      expect(cam.y + cam.h, `headR ${headR}`).toBeGreaterThan(275 + headR);
    }
  });

  it('grows the close-up frame as the head grows', () => {
    const small = baseFrame('CU', ['a'], [{ ...actors[0]!, headR: 50 }], stage);
    const large = baseFrame('CU', ['a'], [{ ...actors[0]!, headR: 100 }], stage);
    expect(large.w).toBeGreaterThan(small.w);
  });

  it('still reads as a close-up for an extreme head', () => {
    // Clamped at both ends, so a huge head does not quietly become a mid shot.
    const cam = baseFrame('CU', ['a'], [{ ...actors[0]!, headR: 400 }], stage);
    expect(cam.w).toBeLessThanOrEqual(stage.width * 0.52);
  });
});
