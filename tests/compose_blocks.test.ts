import { describe, it, expect } from 'vitest';
import { parseScript } from '../src/parse/index.ts';
import { autoDirect } from '../src/direct/index.ts';
import {
  parseBlocks, reassemble, applySplice, stripToElements, mapCheckErrors,
  setDialogueText, setDialogueSpeaker, setParenthetical, setBeatMs, setLineText,
  removeBlock, insertCard,
  type BlockDoc, type DialogueBlock,
} from '../ui/src/editor/compose/blocks.ts';
import { testRigs } from './helpers.ts';

/**
 * The composer draws cards from these blocks and edits the file by splicing the
 * lines behind them. Two things therefore have to hold, or a card is lying: the
 * blocks must agree with the engine parser about what every line is, and an
 * edit must leave every byte it didn't mean to touch alone.
 */

const TEMPLATE = `# THE TEMPLATE

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

const STARTER = `# NEW SCENE

INT. SOMEWHERE - DAY

Someone approaches, holding something they will not explain.

ALICE
(deadpan)
Morning.

BOB
(flat)
Morning.

[BEAT 1200]

ALICE
So that'd be great.
`;

const AWKWARD = `// a note to myself before anything else
# THE AWKWARD ONE
// notes can stack

INT. BAR - NIGHT

MEL
(smug)
// a note between the parenthetical and the line
First.
// interleaved with the text
Second.

MEL (CONT'D)
...

VERN
(tired)
(actually, exhausted)
Only the last parenthetical counts.

[BEAT]

[beat 900 ms]

SHOUTING WITH NOTHING AFTER IT

She turns. He does not.



VERN
Trailing gap above.`;

const CORPUS: Array<[string, string]> = [
  ['the template fixture', TEMPLATE],
  ['the new-scene starter', STARTER],
  ['comments, cont\'d cues and doubled parentheticals', AWKWARD],
  ['crlf endings', TEMPLATE.replace(/\n/g, '\r\n')],
  ['mixed endings', TEMPLATE.split('\n').map((l, i) => l + (i % 2 ? '\r' : '')).join('\n')],
  ['no trailing newline', TEMPLATE.trimEnd()],
  ['empty', ''],
  ['blank lines only', '\n\n\n'],
  ['a single unterminated line', 'Just this.'],
];

describe('block parsing', () => {
  for (const [label, source] of CORPUS) {
    describe(label, () => {
      const doc = parseBlocks(source);

      it('puts the source back byte for byte', () => {
        expect(reassemble(doc)).toBe(source);
      });

      it('tiles every line exactly once, in order', () => {
        let at = 0;
        for (const block of doc.blocks) {
          expect(block.span.fromLine).toBe(at);
          expect(block.span.toLine).toBeGreaterThan(at);
          at = block.span.toLine;
        }
        expect(at).toBe(doc.lines.length);
      });

      it('sees the same elements the engine parser sees', () => {
        const screenplay = parseScript(source);
        expect(stripToElements(doc)).toEqual(screenplay.elements);
        expect(doc.characters).toEqual(screenplay.characters);
        expect(doc.title).toEqual(screenplay.title);
      });
    });
  }
});

describe('beat indexes', () => {
  it('line up with the beats the director actually produces', () => {
    const doc = parseBlocks(TEMPLATE);
    const shots = autoDirect(parseScript(TEMPLATE), testRigs(['brent', 'paul']), { scene: 'test' });

    const numbered = doc.blocks
      .filter((b) => (b.kind === 'dialogue' || b.kind === 'action' || b.kind === 'beat') && b.beatIndex !== null)
      .map((b) => ({ kind: b.kind, beatIndex: (b as { beatIndex: number }).beatIndex }));

    expect(numbered.map((n) => n.beatIndex)).toEqual(shots.beats.map((_, i) => i));
    for (const { kind, beatIndex } of numbered) {
      const beat = shots.beats[beatIndex]!;
      const expected = kind === 'dialogue' ? 'line' : kind === 'beat' ? 'pause' : 'action';
      expect(beat.kind, `block ${kind} at beat ${beatIndex}`).toBe(expected);
    }
  });

  it('skip headings, which stay in the screenplay but produce no beat', () => {
    const doc = parseBlocks(TEMPLATE);
    const heading = doc.blocks.find((b) => b.kind === 'heading');
    expect(heading).toBeDefined();
    expect(heading).not.toHaveProperty('beatIndex');
  });

  it('are absent for a cue that produces nothing', () => {
    // A cue and a parenthetical with no line under them flush to no element at
    // all — the case the composer's draft card exists to avoid writing.
    const doc = parseBlocks('BRENT\n(deadpan)\n\nPAUL\nHello.\n');
    const first = doc.blocks.find((b) => b.kind === 'dialogue') as DialogueBlock;
    expect(first.beatIndex).toBeNull();
    expect(stripToElements(doc)).toHaveLength(1);
  });
});

describe('reading a dialogue block', () => {
  const doc = parseBlocks(AWKWARD);
  const dialogue = doc.blocks.filter((b): b is DialogueBlock => b.kind === 'dialogue');

  it('strips a cue suffix from the speaker but keeps the raw cue', () => {
    const contd = dialogue.find((b) => b.cueRaw.includes("CONT'D"))!;
    expect(contd.speaker).toBe('MEL');
    expect(contd.cueRaw).toBe("MEL (CONT'D)");
  });

  it('lets the last parenthetical before the text win', () => {
    const vern = dialogue.find((b) => b.text.startsWith('Only the last'))!;
    expect(vern.parenthetical).toBe('actually, exhausted');
  });

  it('keeps comments inside the block instead of ending it', () => {
    const mel = dialogue[0]!;
    expect(mel.text).toBe('First.\nSecond.');
    expect(mel.interiorNoteLines).toHaveLength(2);
  });

  it('flags text with nothing speakable in it as a pause', () => {
    const contd = dialogue.find((b) => b.cueRaw.includes("CONT'D"))!;
    expect(contd.playsAsBeat).toBe(true);
    expect(stripToElements(doc)).toContainEqual({ kind: 'beat', ms: 900 });
  });
});

/** Everything outside the spliced range must come through untouched. */
function expectSurgical(doc: BlockDoc, next: string, span: { fromLine: number; toLine: number }): void {
  const before = reassemble({ ...doc, lines: doc.lines.slice(0, span.fromLine), terminators: doc.terminators.slice(0, span.fromLine) });
  expect(next.startsWith(before), 'bytes before the edit changed').toBe(true);

  const afterLines = doc.lines.slice(span.toLine);
  const tail = afterLines.length
    ? afterLines.map((line, i) => line + (doc.terminators[span.toLine + i] ?? '')).join('')
    : '';
  expect(next.endsWith(tail), 'bytes after the edit changed').toBe(true);
}

describe('editing through splices', () => {
  it('changes only the line a dialogue edit touches', () => {
    const doc = parseBlocks(AWKWARD);
    const index = doc.blocks.findIndex((b) => b.kind === 'dialogue');
    const block = doc.blocks[index] as DialogueBlock;
    const splice = setDialogueText(doc, index, 'Replaced.');
    const next = applySplice(doc, splice);

    expectSurgical(doc, next, block.textSpan);
    expect(next).toContain('Replaced.');
    expect(next).toContain('// a note to myself before anything else');
    expect(next).toContain('// a note between the parenthetical and the line');
    // A comment interleaved with the text keeps its place in the run.
    expect(next).toContain('Replaced.\n// interleaved with the text');
  });

  it('is a no-op when a card is written back unchanged', () => {
    for (const [label, source] of CORPUS) {
      const doc = parseBlocks(source);
      doc.blocks.forEach((block, index) => {
        if (block.kind !== 'dialogue' || !block.text) return;
        expect(applySplice(doc, setDialogueText(doc, index, block.text)), label).toBe(source);
      });
    }
  });

  it('preserves blank rhythm and comments across every card setter', () => {
    const doc = parseBlocks(AWKWARD);
    const dialogue = doc.blocks.findIndex((b) => b.kind === 'dialogue');
    const beat = doc.blocks.findIndex((b) => b.kind === 'beat');
    const action = doc.blocks.findIndex((b) => b.kind === 'action');
    const note = doc.blocks.findIndex((b) => b.kind === 'note');

    const edits = [
      setDialogueSpeaker(doc, dialogue, 'janice'),
      setParenthetical(doc, dialogue, 'furious'),
      setBeatMs(doc, beat, 1500),
      setLineText(doc, action, 'She leaves.'),
      setLineText(doc, note, 'a different note'),
    ];
    for (const splice of edits) {
      const next = applySplice(doc, splice);
      expectSurgical(doc, next, splice);
      expect(next.split('\n').length).toBe(doc.lines.length - (splice.toLine - splice.fromLine) + splice.withLines.length);
    }

    expect(applySplice(doc, edits[0]!)).toContain('JANICE');
    expect(applySplice(doc, edits[2]!)).toContain('[BEAT 1500]');
    expect(applySplice(doc, edits[4]!)).toContain('// a different note');
  });

  it('adds a parenthetical under the cue, and takes it away again', () => {
    const doc = parseBlocks('BRENT\nMorning.\n');
    const added = applySplice(doc, setParenthetical(doc, 0, 'deadpan'));
    expect(added).toBe('BRENT\n(deadpan)\nMorning.\n');

    const back = parseBlocks(added);
    expect(applySplice(back, setParenthetical(back, 0, null))).toBe('BRENT\nMorning.\n');
  });

  it('refuses to let a card split itself in two', () => {
    // Blank lines end a block in this format, so a pasted one would tear the
    // card apart mid-keystroke.
    const doc = parseBlocks('BRENT\nMorning.\n');
    const next = applySplice(doc, setDialogueText(doc, 0, 'One.\n\n   \nTwo.'));
    expect(next).toBe('BRENT\nOne.\nTwo.\n');
    expect(parseBlocks(next).blocks.filter((b) => b.kind === 'dialogue')).toHaveLength(1);
  });

  it('keeps the file\'s own line endings when it writes new lines', () => {
    const source = 'BRENT\r\nMorning.\r\n';
    const doc = parseBlocks(source);
    expect(applySplice(doc, setParenthetical(doc, 0, 'deadpan'))).toBe('BRENT\r\n(deadpan)\r\nMorning.\r\n');
  });
});

describe('inserting and removing cards', () => {
  it('separates an inserted card with exactly one blank line', () => {
    const doc = parseBlocks('BRENT\nMorning.\n\nPAUL\nMorning.\n');
    const next = applySplice(doc, insertCard(doc, 0, { kind: 'beat', ms: 1200 }));
    expect(next).toBe('BRENT\nMorning.\n\n[BEAT 1200]\n\nPAUL\nMorning.\n');
  });

  it('inserts at the top of a file without leading blank', () => {
    const doc = parseBlocks('BRENT\nMorning.\n');
    const next = applySplice(doc, insertCard(doc, null, { kind: 'heading', text: 'INT. BAR - NIGHT' }));
    expect(next).toBe('INT. BAR - NIGHT\n\nBRENT\nMorning.\n');
  });

  it('writes a whole dialogue card at once', () => {
    const doc = parseBlocks('INT. BAR - NIGHT\n');
    const next = applySplice(doc, insertCard(doc, 0, {
      kind: 'dialogue', speaker: 'mel', parenthetical: 'smug', text: 'Evening.',
    }));
    expect(next).toBe('INT. BAR - NIGHT\n\nMEL\n(smug)\nEvening.\n');
    expect(parseScript(next).elements.at(-1)).toMatchObject({ speaker: 'MEL', parenthetical: 'smug' });
  });

  it('appends to a file that does not end in a newline', () => {
    const doc = parseBlocks('BRENT\nMorning.');
    const next = applySplice(doc, insertCard(doc, 0, { kind: 'beat', ms: 800 }));
    expect(next).toBe('BRENT\nMorning.\n\n[BEAT 800]');
  });

  it('takes one adjacent blank with a removed card', () => {
    const doc = parseBlocks('BRENT\nMorning.\n\n[BEAT 1200]\n\nPAUL\nMorning.\n');
    const beat = doc.blocks.findIndex((b) => b.kind === 'beat');
    expect(applySplice(doc, removeBlock(doc, beat))).toBe('BRENT\nMorning.\n\nPAUL\nMorning.\n');
  });

  it('removes the first card without leaving a gap at the top', () => {
    const doc = parseBlocks('BRENT\nMorning.\n\nPAUL\nMorning.\n');
    expect(applySplice(doc, removeBlock(doc, 0))).toBe('PAUL\nMorning.\n');
  });
});

describe('mapping check errors onto cards', () => {
  const doc = parseBlocks(TEMPLATE);
  const beats = [
    { id: 'action-1' }, { id: 'line-aaa' }, { id: 'line-bbb' }, { id: 'pause-1' }, { id: 'line-ccc' },
  ];

  it('places a numbered error on the block that produced the beat', () => {
    const { byBlock, scene } = mapCheckErrors(['beat 2 (line) expression "JOY" does not exist'], beats, doc);
    expect(scene).toEqual([]);
    const [index] = [...byBlock.keys()];
    const block = doc.blocks[index!] as DialogueBlock;
    expect(block.kind).toBe('dialogue');
    expect(block.speaker).toBe('PAUL');
  });

  it('places an error that names a beat id', () => {
    const { byBlock, scene } = mapCheckErrors(['beat "pause-1" is too short'], beats, doc);
    expect(scene).toEqual([]);
    expect(doc.blocks[[...byBlock.keys()][0]!]!.kind).toBe('beat');
  });

  it('keeps what it cannot place rather than dropping it', () => {
    const { byBlock, scene } = mapCheckErrors(
      ['set "atrium" does not exist', 'beat 99 (line) off the end'],
      beats,
      doc,
    );
    expect(byBlock.size).toBe(0);
    expect(scene).toHaveLength(2);
  });
});
