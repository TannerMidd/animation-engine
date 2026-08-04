import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CastSummary, CheckResult, Vocab } from '../../types.ts';
import { Tag } from '../chrome.tsx';
import {
  parseBlocks, applySplice, mapCheckErrors,
  setDialogueText, setDialogueSpeaker, setParenthetical, setBeatMs, setLineText,
  removeBlock, insertCard,
  type Block, type BlockDoc, type DialogueBlock, type LineSplice, type NewCard,
} from './blocks.ts';
import { ActionCard, BeatCard, DialogueCard, HeadingCard, NoteCard } from './cards.tsx';

/**
 * Writing a script without having to remember how one is written.
 *
 * The cards are a view of the file, not a replacement for it: every control
 * writes the words a writer would have typed, and the Source tab beside this
 * one shows exactly that. Nothing here holds a copy of the script — the source
 * arrives as a prop, is parsed into blocks on each render, and every edit goes
 * straight back out as a splice. The one exception is the draft card below,
 * which exists because a half-written line cannot be represented in the file.
 */

export interface ScriptComposerProps {
  source: string;
  onChange: (source: string) => void;
  vocab: Vocab | null;
  cast: CastSummary[];
  check: CheckResult | null;
  /** The source `check` was computed from; anything else means it's stale. */
  checkedSource: string | null;
  compact?: boolean;
}

interface Draft {
  after: number | null;
  speaker: string;
  parenthetical: string | null;
}

interface CardKind {
  label: string;
  /** Dialogue has nowhere to live until it has words, so it starts as a draft. */
  drafts?: boolean;
  make?: () => NewCard;
}

const KINDS: CardKind[] = [
  { label: 'line', drafts: true },
  { label: 'pause', make: () => ({ kind: 'beat', ms: 1200 }) },
  { label: 'action', make: () => ({ kind: 'action', text: 'Something happens.' }) },
  { label: 'scene', make: () => ({ kind: 'heading', text: 'INT. SOMEWHERE - DAY' }) },
  { label: 'note', make: () => ({ kind: 'note', text: 'a note to yourself' }) },
];

/** Who probably speaks next: the other one. */
function suggestSpeaker(doc: BlockDoc, after: number | null, speakers: string[]): string {
  const recent: string[] = [];
  for (let i = after ?? -1; i >= 0 && recent.length < 2; i--) {
    const block = doc.blocks[i];
    if (block?.kind === 'dialogue' && !recent.includes(block.speaker)) recent.push(block.speaker);
  }
  if (recent.length >= 2) return recent[1]!;
  if (recent.length === 1) return speakers.find((s) => s !== recent[0]) ?? recent[0]!;
  return speakers[0] ?? 'ALICE';
}

export function ScriptComposer({
  source, onChange, vocab, cast, check, checkedSource, compact,
}: ScriptComposerProps) {
  const doc = useMemo(() => parseBlocks(source), [source]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const host = useRef<HTMLDivElement>(null);
  /** A line to put the cursor on once the source has come back around. */
  const pendingFocus = useRef<number | null>(null);

  const speakers = useMemo(() => {
    const out = [...doc.characters];
    for (const member of cast) {
      const name = member.name.toUpperCase();
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }, [doc.characters, cast]);

  // Only speak for the checker when it has seen this exact source; otherwise a
  // stale error lands on whichever card happens to hold that beat index now.
  const fresh = checkedSource === source ? check : null;
  const mapped = useMemo(
    () => (fresh ? mapCheckErrors(fresh.errors, fresh.beats, doc) : null),
    [fresh, doc],
  );
  const newCharacters = useMemo(
    () => new Set((fresh?.newCharacters ?? []).map((name) => name.toLowerCase())),
    [fresh],
  );
  /** Beats whose prose the director read but could stage nothing from. */
  const unstaged = useMemo(() => {
    const out = new Set<number>();
    (fresh?.beats ?? []).forEach((beat, index) => {
      if (beat.kind !== 'action') return;
      if (beat.unsupported?.length || !beat.stage?.length) out.add(index);
    });
    return out;
  }, [fresh]);

  const edit = (splice: LineSplice) => onChange(applySplice(doc, splice));

  const insert = (after: number | null, card: NewCard) => {
    const splice = insertCard(doc, after, card);
    const offset = splice.withLines.findIndex((line) => line.trim() !== '');
    pendingFocus.current = splice.fromLine + Math.max(0, offset);
    setDraft(null);
    edit(splice);
  };

  /** Turn the draft into real lines the moment there is something to say. */
  const materialize = (text: string) => {
    if (!draft) return;
    insert(draft.after, {
      kind: 'dialogue', speaker: draft.speaker, parenthetical: draft.parenthetical, text,
    });
  };

  const add = (kind: CardKind, after: number | null) => {
    if (kind.drafts || !kind.make) {
      setDraft({ after, speaker: suggestSpeaker(doc, after, speakers), parenthetical: null });
      return;
    }
    insert(after, kind.make());
  };

  // Move the caret onto whatever was just created, once it exists in the DOM.
  useLayoutEffect(() => {
    const line = pendingFocus.current;
    if (line === null || !host.current) return;
    pendingFocus.current = null;
    const index = doc.blocks.findIndex((b) => b.span.fromLine <= line && line < b.span.toLine);
    if (index < 0) return;
    const field = host.current.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      `[data-card="${index}"] textarea, [data-card="${index}"] input`,
    );
    if (!field) return;
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [doc]);

  const visible = doc.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind !== 'blank');

  const renderDraft = () => draft && (
    <>
      <div className="h-1.5" />
      <DraftCard
        draft={draft}
        speakers={speakers}
        cast={cast}
        emotions={vocab?.emotions}
        onSpeaker={(speaker) => setDraft({ ...draft, speaker })}
        onParenthetical={(parenthetical) => setDraft({ ...draft, parenthetical })}
        onText={materialize}
        onCancel={() => setDraft(null)}
      />
    </>
  );

  const renderCard = (block: Block, index: number) => {
    const errors = mapped?.byBlock.get(index) ?? [];
    switch (block.kind) {
      case 'dialogue':
        return (
          <DialogueCard
            block={block}
            speakers={speakers}
            castIds={cast.map((c) => c.name)}
            supported={cast.find((c) => c.name === block.speaker.toLowerCase())?.expressions ?? null}
            emotions={vocab?.emotions}
            isNew={newCharacters.has(block.speaker.toLowerCase())}
            errors={errors}
            onSpeaker={(speaker) => edit(setDialogueSpeaker(doc, index, speaker))}
            onParenthetical={(keyword) => edit(setParenthetical(doc, index, keyword))}
            onText={(text) => edit(setDialogueText(doc, index, text))}
            onEnter={() => setDraft({
              after: index,
              speaker: suggestSpeaker(doc, index, speakers),
              parenthetical: null,
            })}
          />
        );
      case 'beat':
        return <BeatCard block={block} onMs={(ms) => edit(setBeatMs(doc, index, ms))} />;
      case 'action':
        return (
          <ActionCard
            block={block}
            errors={errors}
            actions={vocab?.actions}
            speakers={speakers}
            unstaged={unstaged.has(block.beatIndex)}
            onText={(text) => edit(setLineText(doc, index, text))}
          />
        );
      case 'heading':
        return <HeadingCard block={block} onText={(text) => edit(setLineText(doc, index, text))} />;
      case 'note':
        return <NoteCard block={block} onText={(text) => edit(setLineText(doc, index, text))} />;
      case 'section':
        return (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] tracking-[.1em] uppercase text-ink-dim">{block.text.replace(/^#+\s*/, '')}</span>
            <span className="flex-1 h-px bg-[#2f353d]" />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div ref={host} className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 pb-8 flex flex-col">
      {mapped?.scene.length ? (
        <div className="mb-2 p-2 border border-bad/45 bg-bad/10 rounded-[3px]">
          <div className="flex items-center gap-1.5 mb-1">
            <Tag color="#c8595a">scene</Tag>
          </div>
          {mapped.scene.map((error) => (
            <div key={error} className="text-[10.5px] text-[#d6c3c3] leading-[1.45]">{error}</div>
          ))}
        </div>
      ) : null}

      {draft?.after === null && renderDraft()}

      {visible.map(({ block, index }, n) => (
        <Fragment key={index}>
          <InsertRow
            compact={compact}
            onInsert={(kind) => add(kind, n === 0 ? null : visible[n - 1]!.index)}
          />
          <div data-card={index} className="relative group/card">
            {renderCard(block, index)}
            <button
              type="button"
              title="Remove"
              onClick={() => edit(removeBlock(doc, index))}
              className="absolute -right-1 top-1 w-[18px] h-[18px] rounded-[3px] text-ink-ghost opacity-0 group-hover/card:opacity-100 hover:text-bad hover:bg-panel-2 cursor-pointer text-[12px] leading-none"
            >
              ×
            </button>
          </div>
          {draft?.after === index && (
            renderDraft()
          )}
        </Fragment>
      ))}

      <InsertRow
        compact={compact}
        always={!visible.length}
        onInsert={(kind) => add(kind, visible.length ? visible[visible.length - 1]!.index : null)}
      />
    </div>
  );
}

/** The hover strip between cards: the only way to add anything. */
function InsertRow({
  onInsert, compact, always,
}: {
  onInsert: (kind: CardKind) => void;
  compact?: boolean;
  always?: boolean;
}) {
  return (
    <div className={`group/ins flex items-center gap-1 ${always ? 'py-1' : 'h-[13px] hover:h-auto py-0.5'}`}>
      <span className={`flex gap-1 flex-wrap ${always ? '' : 'opacity-0 group-hover/ins:opacity-100'} transition-opacity`}>
        {KINDS.map((kind) => (
          <button
            key={kind.label}
            type="button"
            onClick={() => onInsert(kind)}
            className="h-[17px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-[9.5px] text-ink-faint hover:text-ink hover:border-accent/50 cursor-pointer"
          >
            + {kind.label}
          </button>
        ))}
      </span>
      {!compact && (
        <span className={`flex-1 h-px bg-[#2f353d] ${always ? '' : 'opacity-0 group-hover/ins:opacity-100'}`} />
      )}
    </div>
  );
}

/**
 * A line that isn't in the file yet.
 *
 * A cue with nothing under it parses as shouted action, and a cue with only a
 * parenthetical parses as nothing at all — so an empty card cannot be written
 * down without corrupting the meaning of the script. It lives here until it has
 * something to say, and evaporates if it never does.
 */
function DraftCard({
  draft, speakers, cast, emotions, onSpeaker, onParenthetical, onText, onCancel,
}: {
  draft: Draft;
  speakers: string[];
  cast: CastSummary[];
  emotions: Vocab['emotions'];
  onSpeaker: (speaker: string) => void;
  onParenthetical: (keyword: string | null) => void;
  onText: (text: string) => void;
  onCancel: () => void;
}) {
  const block: DialogueBlock = {
    kind: 'dialogue',
    span: { fromLine: 0, toLine: 0 },
    cueLine: 0,
    speaker: draft.speaker,
    cueRaw: draft.speaker,
    parenLine: draft.parenthetical ? 0 : null,
    parenthetical: draft.parenthetical,
    textSpan: { fromLine: 0, toLine: 0 },
    text: '',
    interiorNoteLines: [],
    playsAsBeat: false,
    beatIndex: null,
  };

  return (
    <div onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <DialogueCard
        block={block}
        speakers={speakers}
        castIds={cast.map((c) => c.name)}
        supported={cast.find((c) => c.name === draft.speaker.toLowerCase())?.expressions ?? null}
        emotions={emotions}
        isNew={false}
        errors={[]}
        onSpeaker={onSpeaker}
        onParenthetical={onParenthetical}
        onText={onText}
      />
    </div>
  );
}
