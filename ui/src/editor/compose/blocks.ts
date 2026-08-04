/**
 * The script, seen as blocks you can edit one at a time.
 *
 * The composer's problem is that a card is a lie: the file is the truth, and a
 * card is only a view of some lines in it. So this module never generates a
 * script. It labels every line of the real source, hands the composer blocks to
 * draw cards from, and turns each edit into a splice of the exact line range
 * that changed. Everything the composer doesn't understand — comments, blank
 * rhythm, a line whose classification it never guessed at — survives untouched,
 * because it is never rewritten.
 *
 * The classifier below mirrors src/parse/index.ts branch for branch. That
 * duplication is deliberate (the ui does not import from the engine) and is
 * pinned by tests/compose_blocks.test.ts, which runs both over the same corpus
 * and requires identical elements.
 */

/** A half-open line range, [fromLine, toLine). */
export interface Span {
  fromLine: number;
  toLine: number;
}

export interface DialogueBlock {
  kind: 'dialogue';
  span: Span;
  cueLine: number;
  /** The cue with any "(CONT'D)"-style suffix stripped, as the parser reads it. */
  speaker: string;
  /** The cue line verbatim, so anything but a speaker edit leaves it alone. */
  cueRaw: string;
  parenLine: number | null;
  parenthetical: string | null;
  /** Where the spoken lines live. Empty (from === to) for a cue awaiting text. */
  textSpan: Span;
  /** The raw text lines joined with newlines — byte-exact, so typing round-trips. */
  text: string;
  /** Comment lines inside this block; the parser skips them, so we carry them. */
  interiorNoteLines: number[];
  /** Nothing speakable in the text: the engine plays this as a pause instead. */
  playsAsBeat: boolean;
  /** Which directed beat this becomes, or null when it produces no element. */
  beatIndex: number | null;
}

export interface BeatBlock {
  kind: 'beat';
  span: Span;
  ms: number;
  raw: string;
  beatIndex: number;
}

export interface ActionBlock {
  kind: 'action';
  span: Span;
  text: string;
  beatIndex: number;
}

export interface HeadingBlock {
  kind: 'heading';
  span: Span;
  text: string;
}

/** A '# Title' line. It titles the piece; it is not part of the performance. */
export interface SectionBlock {
  kind: 'section';
  span: Span;
  text: string;
}

/** A top-level '//' comment: a note to yourself, invisible to the engine. */
export interface NoteBlock {
  kind: 'note';
  span: Span;
  text: string;
}

export interface BlankBlock {
  kind: 'blank';
  span: Span;
}

export type Block =
  | DialogueBlock | BeatBlock | ActionBlock | HeadingBlock | SectionBlock | NoteBlock | BlankBlock;

export interface BlockDoc {
  source: string;
  /** Terminator-free, one entry per line — the same array parseScript walks. */
  lines: string[];
  /** Per-line '\n' | '\r\n' | '' — kept apart so mixed endings round-trip. */
  terminators: string[];
  /** What to end an inserted line with. */
  eol: string;
  /** Tiles [0, lines.length) exactly once, in order. */
  blocks: Block[];
  characters: string[];
  title: string;
}

// The parser's rules, verbatim from src/parse/index.ts:18-26.
const HEADING = /^(INT|EXT|EST|I\/E|INT\.?\/EXT)[.\s]/i;
const BEAT = /^\[\s*BEAT(?:\s+(\d+))?\s*(?:ms)?\s*\]$/i;
const PARENTHETICAL = /^\((.+)\)$/;
const SECTION = /^#+\s*(.*)$/;
const COMMENT = /^\/\//;
const DEFAULT_BEAT_MS = 800;
const WORDLESS_BEAT_MS = 900;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** A cue is an all-caps line with at least one letter and no lowercase. */
function isCharacterCue(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;
  return !HEADING.test(t) && !BEAT.test(t);
}

/** The next line that isn't a comment, or '' if there isn't one. */
function nextMeaningful(lines: string[], from: number): string {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (COMMENT.test(line)) continue;
    return line;
  }
  return '';
}

/**
 * Split keeping each line's own terminator.
 *
 * Produces the same array as `source.split(/\r?\n/)` — including the empty
 * final entry when the source ends with a newline — so line indexes here and
 * in the engine parser refer to the same lines.
 */
function splitLines(source: string): { lines: string[]; terminators: string[] } {
  const lines: string[] = [];
  const terminators: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\n') continue;
    const crlf = i > start && source[i - 1] === '\r';
    lines.push(source.slice(start, crlf ? i - 1 : i));
    terminators.push(crlf ? '\r\n' : '\n');
    start = i + 1;
  }
  lines.push(source.slice(start));
  terminators.push('');
  return { lines, terminators };
}

function dominantEol(terminators: string[]): string {
  let crlf = 0;
  let lf = 0;
  for (const t of terminators) {
    if (t === '\r\n') crlf++;
    else if (t === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Collapse dialogue lines the way the parser does before it stores the text. */
function joinDialogue(lines: string[], indexes: number[]): string {
  return indexes.map((i) => lines[i]!.trim()).join(' ').replace(/\s+/g, ' ').trim();
}

export function parseBlocks(source: string, fallbackTitle = 'untitled'): BlockDoc {
  const { lines, terminators } = splitLines(source);
  const blocks: Block[] = [];
  const characters: string[] = [];
  let title = fallbackTitle;
  // Counts only what autoDirect turns into a beat: every element except
  // headings, which stay in the screenplay but produce no beat.
  let beatIndex = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();

    if (COMMENT.test(line)) {
      blocks.push({ kind: 'note', span: { fromLine: i, toLine: i + 1 }, text: line });
      i++;
      continue;
    }
    if (!line) {
      blocks.push({ kind: 'blank', span: { fromLine: i, toLine: i + 1 } });
      i++;
      continue;
    }
    const section = SECTION.exec(line);
    if (section) {
      if (title === fallbackTitle && section[1]?.trim()) title = section[1].trim();
      blocks.push({ kind: 'section', span: { fromLine: i, toLine: i + 1 }, text: line });
      i++;
      continue;
    }
    const beat = BEAT.exec(line);
    if (beat) {
      blocks.push({
        kind: 'beat',
        span: { fromLine: i, toLine: i + 1 },
        ms: beat[1] ? Number(beat[1]) : DEFAULT_BEAT_MS,
        raw: line,
        beatIndex: beatIndex++,
      });
      i++;
      continue;
    }
    if (HEADING.test(line)) {
      // No beatIndex: headings are the one element autoDirect steps over.
      blocks.push({ kind: 'heading', span: { fromLine: i, toLine: i + 1 }, text: line });
      i++;
      continue;
    }

    if (isCharacterCue(line) && nextMeaningful(lines, i)) {
      const cueLine = i;
      const interiorNoteLines: number[] = [];
      const textLines: number[] = [];
      let parenLine: number | null = null;
      let j = i + 1;

      while (j < lines.length) {
        const t = lines[j]!.trim();
        // Comments are skipped mid-dialogue rather than ending it.
        if (COMMENT.test(t)) {
          interiorNoteLines.push(j);
          j++;
          continue;
        }
        // Everything the parser handles before it looks at `speaker` ends the block.
        if (!t || SECTION.test(t) || BEAT.test(t) || HEADING.test(t)) break;
        // A parenthetical only counts before any text — and a second one
        // overwrites the first, so the last one standing wins.
        if (PARENTHETICAL.test(t) && !textLines.length) {
          parenLine = j;
          j++;
          continue;
        }
        textLines.push(j);
        j++;
      }

      const speaker = lines[cueLine]!.trim().replace(/\s*\(.*\)$/, '').trim();
      if (!characters.includes(speaker)) characters.push(speaker);

      const spoken = joinDialogue(lines, textLines);
      const playsAsBeat = textLines.length > 0 && !SPEAKABLE.test(spoken);

      blocks.push({
        kind: 'dialogue',
        span: { fromLine: cueLine, toLine: j },
        cueLine,
        speaker,
        cueRaw: lines[cueLine]!,
        parenLine,
        parenthetical: parenLine === null ? null : PARENTHETICAL.exec(lines[parenLine]!.trim())![1]!.trim(),
        textSpan: textLines.length
          ? { fromLine: textLines[0]!, toLine: textLines[textLines.length - 1]! + 1 }
          : { fromLine: j, toLine: j },
        text: textLines.map((n) => lines[n]!).join('\n'),
        interiorNoteLines,
        playsAsBeat,
        // A cue with no text at all flushes to nothing, so it has no beat.
        beatIndex: textLines.length ? beatIndex++ : null,
      });
      i = j;
      continue;
    }

    blocks.push({ kind: 'action', span: { fromLine: i, toLine: i + 1 }, text: line, beatIndex: beatIndex++ });
    i++;
  }

  return { source, lines, terminators, eol: dominantEol(terminators), blocks, characters, title };
}

/** The source, back byte-for-byte. */
export function reassemble(doc: BlockDoc): string {
  let out = '';
  for (let i = 0; i < doc.lines.length; i++) out += doc.lines[i]! + (doc.terminators[i] ?? '');
  return out;
}

// --- edits -------------------------------------------------------------------

/** Replace the lines in [fromLine, toLine) with these. */
export interface LineSplice {
  fromLine: number;
  toLine: number;
  withLines: string[];
}

/** Apply a splice and return the new source. Bytes outside the range are untouched. */
export function applySplice(doc: BlockDoc, splice: LineSplice): string {
  const lines = [...doc.lines];
  const terminators = [...doc.terminators];
  const count = splice.toLine - splice.fromLine;
  // Rewritten lines keep the ending they already had, so writing a card back
  // unchanged is byte-identical even in a file with mixed endings. Only lines
  // that didn't exist before get the file's prevailing one.
  const replaced = doc.terminators.slice(splice.fromLine, splice.toLine);
  lines.splice(splice.fromLine, count, ...splice.withLines);
  terminators.splice(splice.fromLine, count, ...splice.withLines.map((_, i) => replaced[i] ?? doc.eol));

  // Only the final entry is unterminated; a splice at the end can disturb that.
  for (let i = 0; i < terminators.length - 1; i++) {
    if (!terminators[i]) terminators[i] = doc.eol;
  }
  if (terminators.length) terminators[terminators.length - 1] = '';

  let out = '';
  for (let i = 0; i < lines.length; i++) out += lines[i]! + terminators[i]!;
  return out;
}

/** The whitespace a line starts with, so rewrites keep the file's shape. */
function indentOf(line: string): string {
  return /^\s*/.exec(line)![0];
}

function blockAt(doc: BlockDoc, index: number): Block {
  const block = doc.blocks[index];
  if (!block) throw new Error(`no block at index ${index}`);
  return block;
}

function dialogueAt(doc: BlockDoc, index: number): DialogueBlock {
  const block = blockAt(doc, index);
  if (block.kind !== 'dialogue') throw new Error(`block ${index} is a ${block.kind}, not dialogue`);
  return block;
}

/**
 * Replace what a character says.
 *
 * Blank and whitespace-only lines are dropped: in this format they end the
 * block, so letting one through would split the card mid-keystroke. Comments
 * interleaved with the text keep their place — the new lines are woven back
 * through the gaps between them, which also makes writing a card back
 * unchanged a genuine no-op rather than a reshuffle on the first keystroke.
 */
export function setDialogueText(doc: BlockDoc, index: number, text: string): LineSplice {
  const block = dialogueAt(doc, index);
  const { fromLine, toLine } = block.textSpan;
  const notes = new Set(block.interiorNoteLines);
  const body = text.split('\n').filter((line) => line.trim() !== '');

  const woven: string[] = [];
  let next = 0;
  for (let line = fromLine; line < toLine; line++) {
    if (notes.has(line)) woven.push(doc.lines[line]!);
    else if (next < body.length) woven.push(body[next++]!);
  }
  while (next < body.length) woven.push(body[next++]!);

  return { fromLine, toLine, withLines: woven };
}

/** Rewrite the cue. Any "(CONT'D)"-style suffix on it does not survive. */
export function setDialogueSpeaker(doc: BlockDoc, index: number, speaker: string): LineSplice {
  const block = dialogueAt(doc, index);
  const name = speaker.trim().toUpperCase();
  return {
    fromLine: block.cueLine,
    toLine: block.cueLine + 1,
    withLines: [indentOf(block.cueRaw) + name],
  };
}

/** Set, replace, or (with null) remove the parenthetical under a cue. */
export function setParenthetical(doc: BlockDoc, index: number, keyword: string | null): LineSplice {
  const block = dialogueAt(doc, index);
  const word = keyword?.trim();

  if (!word) {
    if (block.parenLine === null) return { fromLine: block.cueLine, toLine: block.cueLine, withLines: [] };
    return { fromLine: block.parenLine, toLine: block.parenLine + 1, withLines: [] };
  }
  if (block.parenLine !== null) {
    return {
      fromLine: block.parenLine,
      toLine: block.parenLine + 1,
      withLines: [indentOf(doc.lines[block.parenLine]!) + `(${word})`],
    };
  }
  // Straight after the cue: always ahead of any text, which is the only place
  // the parser will read it.
  return {
    fromLine: block.cueLine + 1,
    toLine: block.cueLine + 1,
    withLines: [indentOf(block.cueRaw) + `(${word})`],
  };
}

export function setBeatMs(doc: BlockDoc, index: number, ms: number): LineSplice {
  const block = blockAt(doc, index);
  if (block.kind !== 'beat') throw new Error(`block ${index} is a ${block.kind}, not a beat`);
  const raw = doc.lines[block.span.fromLine]!;
  return {
    fromLine: block.span.fromLine,
    toLine: block.span.toLine,
    withLines: [indentOf(raw) + `[BEAT ${Math.round(ms)}]`],
  };
}

/** Replace the single line behind an action, heading, section, or note card. */
export function setLineText(doc: BlockDoc, index: number, text: string): LineSplice {
  const block = blockAt(doc, index);
  if (block.kind === 'dialogue' || block.kind === 'blank' || block.kind === 'beat') {
    throw new Error(`block ${index} is a ${block.kind}; use its own setter`);
  }
  const raw = doc.lines[block.span.fromLine]!;
  const body = text.replace(/[\r\n]+/g, ' ').trim();
  const written = block.kind === 'note' && !COMMENT.test(body) ? `// ${body}` : body;
  return { fromLine: block.span.fromLine, toLine: block.span.toLine, withLines: [indentOf(raw) + written] };
}

/** Remove a card, taking one adjacent blank with it so no gap doubles up. */
export function removeBlock(doc: BlockDoc, index: number): LineSplice {
  const { fromLine, toLine } = blockAt(doc, index).span;
  const followingBlank = toLine < doc.lines.length && doc.lines[toLine]!.trim() === '';
  const precedingBlank = fromLine > 0 && doc.lines[fromLine - 1]!.trim() === '';
  if (followingBlank) return { fromLine, toLine: toLine + 1, withLines: [] };
  if (precedingBlank) return { fromLine: fromLine - 1, toLine, withLines: [] };
  return { fromLine, toLine, withLines: [] };
}

export type NewCard =
  | { kind: 'dialogue'; speaker: string; parenthetical?: string | null; text: string }
  | { kind: 'beat'; ms?: number }
  | { kind: 'action' | 'heading' | 'note'; text: string };

function renderCard(card: NewCard): string[] {
  if (card.kind === 'dialogue') {
    const body = card.text.split('\n').filter((line) => line.trim() !== '');
    return [
      card.speaker.trim().toUpperCase(),
      ...(card.parenthetical?.trim() ? [`(${card.parenthetical.trim()})`] : []),
      ...body,
    ];
  }
  if (card.kind === 'beat') return [`[BEAT ${Math.round(card.ms ?? DEFAULT_BEAT_MS)}]`];
  const body = card.text.replace(/[\r\n]+/g, ' ').trim();
  if (card.kind === 'note') return [COMMENT.test(body) ? body : `// ${body}`];
  return [body];
}

/**
 * Insert a card after the given block, or at the top when null.
 *
 * Adds a blank line on either side only where one isn't already there, so
 * inserting never introduces a double gap and never runs two cards together.
 */
export function insertCard(doc: BlockDoc, afterBlockIdx: number | null, card: NewCard): LineSplice {
  const at = afterBlockIdx === null ? 0 : blockAt(doc, afterBlockIdx).span.toLine;
  const body = renderCard(card);
  const needsBefore = at > 0 && doc.lines[at - 1]!.trim() !== '';
  const needsAfter = at < doc.lines.length && doc.lines[at]!.trim() !== '';
  return {
    fromLine: at,
    toLine: at,
    withLines: [...(needsBefore ? [''] : []), ...body, ...(needsAfter ? [''] : [])],
  };
}

// --- projections -------------------------------------------------------------

/** The shape src/parse/index.ts produces, for the equivalence test. */
export type ScreenplayElementLike =
  | { kind: 'heading'; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'dialogue'; speaker: string; parenthetical: string | null; text: string }
  | { kind: 'beat'; ms: number };

/**
 * What the engine parser would make of this source.
 *
 * Exists to be compared against the real thing in tests — if the two ever
 * disagree, the composer is drawing cards that don't match what renders.
 */
export function stripToElements(doc: BlockDoc): ScreenplayElementLike[] {
  const elements: ScreenplayElementLike[] = [];
  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'heading':
        elements.push({ kind: 'heading', text: block.text });
        break;
      case 'action':
        elements.push({ kind: 'action', text: block.text });
        break;
      case 'beat':
        elements.push({ kind: 'beat', ms: block.ms });
        break;
      case 'dialogue': {
        if (block.textSpan.fromLine === block.textSpan.toLine && !block.text) break;
        if (block.playsAsBeat) {
          elements.push({ kind: 'beat', ms: WORDLESS_BEAT_MS });
          break;
        }
        elements.push({
          kind: 'dialogue',
          speaker: block.speaker,
          parenthetical: block.parenthetical,
          text: block.text.split('\n').map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim(),
        });
        break;
      }
      default:
        break;
    }
  }
  return elements;
}

export interface MappedErrors {
  /** Block index -> the errors that belong to it. */
  byBlock: Map<number, string[]>;
  /** Everything that names no beat, or names one we can't place. */
  scene: string[];
}

/**
 * Attach check errors to the cards they came from.
 *
 * Two forms are in play — validateShotList says `beat 3 (line) …` while the
 * staging compiler says `beat "line-1a8mznz" …` — and anything that matches
 * neither is scene-level. Nothing is dropped: an error we can't place shows at
 * the top rather than disappearing.
 */
export function mapCheckErrors(
  errors: readonly string[],
  checkBeats: ReadonlyArray<{ id?: string }>,
  doc: BlockDoc,
): MappedErrors {
  const byBeat = new Map<number, number>();
  doc.blocks.forEach((block, index) => {
    if (block.kind === 'dialogue' || block.kind === 'action' || block.kind === 'beat') {
      if (block.beatIndex !== null) byBeat.set(block.beatIndex, index);
    }
  });

  const byBlock = new Map<number, string[]>();
  const scene: string[] = [];

  for (const error of errors) {
    let beatIndex: number | null = null;

    const numbered = /^beat (\d+)\b/.exec(error);
    if (numbered) beatIndex = Number(numbered[1]);

    if (beatIndex === null) {
      const named = /beat "([^"]+)"/.exec(error);
      if (named) {
        const found = checkBeats.findIndex((beat) => beat.id === named[1]);
        if (found >= 0) beatIndex = found;
      }
    }

    const block = beatIndex === null ? undefined : byBeat.get(beatIndex);
    if (block === undefined) {
      scene.push(error);
      continue;
    }
    const list = byBlock.get(block);
    if (list) list.push(error);
    else byBlock.set(block, [error]);
  }

  return { byBlock, scene };
}
