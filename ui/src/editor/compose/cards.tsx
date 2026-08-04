import { useEffect, useRef, useState } from 'react';
import type { ActionField, ActionVocab, EmotionVocab } from '../../types.ts';
import { FieldLabel, OptionChips, Tag } from '../chrome.tsx';
import { speakerColour } from '../lib.ts';
import { degradedReason, resolveExpression } from './emotions.ts';
import type { ActionBlock, BeatBlock, DialogueBlock, HeadingBlock, NoteBlock } from './blocks.ts';

/**
 * The cards.
 *
 * Every control here writes words a writer could have typed themselves — the
 * point is not to hide the format but to stop it being something you have to
 * remember. Nothing holds state: each card is drawn from the block behind it,
 * and every edit goes straight back to the source.
 */

const BEAT_PRESETS = [600, 800, 1200, 1600, 2000];

const TIMES = ['DAY', 'NIGHT', 'MORNING', 'AFTERNOON', 'EVENING', 'LATER', 'CONTINUOUS'];

const PREFIXES = ['INT', 'EXT', 'EST', 'INT./EXT'];

export const cardShell =
  'rounded-[3px] border border-[#2f353d] bg-[#22262c] px-2 py-[7px] flex flex-col gap-[6px]';

const inputClass =
  'w-full h-[23px] border border-edge bg-panel-2 rounded-[3px] px-1.5 text-[11px] text-[#c9ccd1] outline-none focus:border-accent/60';

const selectClass =
  'h-[23px] border border-edge bg-panel-2 rounded-[3px] px-1 text-[10.5px] text-[#c9ccd1] outline-none cursor-pointer focus:border-accent/60';

/** A row of errors the checker attached to this card. */
export function CardErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div className="flex flex-col gap-[3px]">
      {errors.map((error) => (
        <div key={error} className="text-[10px] text-[#d6c3c3] leading-[1.4] border-l-2 border-bad/60 pl-1.5">
          {error}
        </div>
      ))}
    </div>
  );
}

function CardHead({ label, colour, children }: { label: string; colour?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 min-h-[15px]">
      <span
        className="text-[9px] tracking-[.09em] uppercase"
        style={{ color: colour ?? '#6b737d' }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/** Grows with its content so a long speech isn't read through a slot. */
function AutoTextarea({
  value, onChange, onKeyDown, placeholder, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      rows={1}
      className="w-full resize-none border border-edge bg-panel-2 rounded-[3px] px-1.5 py-1 text-[12px] leading-[1.45] text-[#e6e3dc] outline-none focus:border-accent/60 overflow-hidden"
    />
  );
}

export interface DialogueCardProps {
  block: DialogueBlock;
  speakers: string[];
  castIds: string[];
  /** The rig's expressions, or null when no rig exists for them yet. */
  supported: readonly string[] | null;
  emotions: EmotionVocab | undefined;
  isNew: boolean;
  errors: string[];
  onSpeaker: (speaker: string) => void;
  onParenthetical: (keyword: string | null) => void;
  onText: (text: string) => void;
  onEnter?: () => void;
}

export function DialogueCard({
  block, speakers, castIds, supported, emotions, isNew, errors,
  onSpeaker, onParenthetical, onText, onEnter,
}: DialogueCardProps) {
  const resolved = resolveExpression(block.parenthetical, emotions);
  const colour = speakerColour(castIds, block.speaker.toLowerCase());
  const suffix = /\(.*\)\s*$/.exec(block.cueRaw.trim())?.[0];

  const options = emotions ? Object.keys(emotions.canonical) : [];
  const invalid: Record<string, string> = {};
  for (const expression of options) {
    const reason = degradedReason(block.speaker, expression, supported, emotions?.fallbacks);
    if (reason) invalid[expression] = reason;
  }

  return (
    <div className={cardShell} style={{ borderLeft: `2px solid ${colour}` }}>
      <div className="flex items-center gap-1.5">
        <SpeakerSelect value={block.speaker} speakers={speakers} colour={colour} onPick={onSpeaker} />
        {suffix && <Tag color="#6b737d">{suffix}</Tag>}
        {isNew && <Tag color="#6f9b5a">new — a puppet is made when you direct</Tag>}
        {block.playsAsBeat && <Tag color="#c8834a">plays as a pause</Tag>}
      </div>

      {emotions && (
        <div>
          <FieldLabel
            label="Feeling"
            value={resolved}
            hint={block.parenthetical ? undefined : 'optional'}
          />
          <OptionChips
            options={options}
            value={resolved}
            invalid={invalid}
            onPick={(expression) => onParenthetical(
              expression === resolved ? null : emotions.canonical[expression] ?? expression.toLowerCase(),
            )}
          />
          {block.parenthetical && (
            <div className="text-[10px] text-ink-ghost mt-1 leading-[1.4]">
              Written as <span className="font-mono text-ink-faint">({block.parenthetical})</span>
              {resolved
                ? <> — plays <span className="text-ink-dim">{resolved}</span>{invalid[resolved] ? `, but ${invalid[resolved]}` : ''}.</>
                : <> — no feeling in it, so this plays the resting face.</>}
            </div>
          )}
        </div>
      )}

      <AutoTextarea
        value={block.text}
        onChange={onText}
        autoFocus={isNew && !block.text}
        placeholder="What they say"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <CardErrors errors={errors} />
    </div>
  );
}

/** Never a valid cue, so it cannot collide with a real character. */
const NEW_SPEAKER = "+ new";

function SpeakerSelect({
  value, speakers, colour, onPick,
}: {
  value: string;
  speakers: string[];
  colour: string;
  onPick: (speaker: string) => void;
}) {
  const options = speakers.includes(value) ? speakers : [value, ...speakers];
  return (
    <select
      value={value}
      style={{ color: colour }}
      onChange={(e) => {
        if (e.target.value !== NEW_SPEAKER) return onPick(e.target.value);
        const name = window.prompt('Character name');
        if (name?.trim()) onPick(name.trim());
      }}
      className={`${selectClass} font-medium tracking-[.04em]`}
    >
      {options.map((name) => <option key={name} value={name}>{name}</option>)}
      <option value={NEW_SPEAKER}>＋ new character…</option>
    </select>
  );
}

export function BeatCard({ block, onMs }: { block: BeatBlock; onMs: (ms: number) => void }) {
  return (
    <div className={cardShell}>
      <CardHead label="pause">
        <span className="font-mono text-[9px] text-ink-ghost">{(block.ms / 1000).toFixed(1)}s</span>
      </CardHead>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="flex h-[23px] w-[86px] border border-edge bg-panel-2 rounded-[3px] overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => onMs(Math.max(100, block.ms - 100))}
            className="w-[20px] text-ink-faint hover:bg-edge hover:text-ink cursor-pointer"
          >
            −
          </button>
          <span className="flex-1 flex items-center justify-center font-mono text-[10.5px] text-ink">{block.ms}</span>
          <button
            type="button"
            onClick={() => onMs(block.ms + 100)}
            className="w-[20px] text-ink-faint hover:bg-edge hover:text-ink cursor-pointer"
          >
            +
          </button>
        </span>
        <OptionChips
          options={BEAT_PRESETS.map(String)}
          value={String(block.ms)}
          onPick={(ms) => onMs(Number(ms))}
        />
      </div>
      <div className="text-[10px] text-ink-ghost leading-[1.4]">The pause is the joke; its length is a writing decision.</div>
    </div>
  );
}

export function ActionCard({
  block, errors, actions, speakers, unstaged, onText,
}: {
  block: ActionBlock;
  errors: string[];
  actions: ActionVocab | undefined;
  speakers: string[];
  /** True when the director read this line but couldn't stage anything from it. */
  unstaged: boolean;
  onText: (text: string) => void;
}) {
  const [building, setBuilding] = useState(false);

  return (
    <div className={`${cardShell} ${unstaged ? 'border-bad/45' : ''}`}>
      <CardHead label="action">
        {actions && (
          <button
            type="button"
            onClick={() => setBuilding((on) => !on)}
            className="ml-auto text-[9.5px] text-ink-faint hover:text-ink cursor-pointer"
          >
            {building ? 'close' : 'build…'}
          </button>
        )}
      </CardHead>
      <AutoTextarea value={block.text} onChange={onText} placeholder="What happens" />

      {unstaged && !building && (
        <div className="p-1.5 border border-bad/45 bg-bad/10 rounded-[3px]">
          <div className="text-[10.5px] text-[#d6c3c3] leading-[1.45] mb-1">
            The director can't stage this, so the preview and the export block on it.
          </div>
          {actions && (
            <button
              type="button"
              onClick={() => setBuilding(true)}
              className="h-[19px] px-2 rounded-[3px] border border-good bg-good/15 text-[#8fbd76] text-[10px] cursor-pointer"
            >
              Build it from a phrasing that works
            </button>
          )}
        </div>
      )}

      {building && actions && (
        <ActionBuilder
          actions={actions}
          speakers={speakers}
          onWrite={(text) => { onText(text); setBuilding(false); }}
        />
      )}
      <CardErrors errors={errors} />
    </div>
  );
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, field: string) => values[field]?.trim() || whole);
}

/** Pick a verb, fill the blanks, and see the sentence before you commit it. */
function ActionBuilder({
  actions, speakers, onWrite,
}: {
  actions: ActionVocab;
  speakers: string[];
  onWrite: (text: string) => void;
}) {
  const [id, setId] = useState(actions.templates[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const template = actions.templates.find((t) => t.id === id) ?? actions.templates[0];
  if (!template) return null;

  const names = speakers.map((s) => s.charAt(0) + s.slice(1).toLowerCase());
  const optionsFor = (field: ActionField): string[] | null => {
    if (field === 'actor' || field === 'targetActor') return names;
    if (field === 'mark') return Object.values(actions.marks);
    if (field === 'direction') return Object.values(actions.directions);
    if (field === 'count') return actions.counts;
    return null;
  };
  const placeholderFor = (field: ActionField) =>
    field === 'seat' ? 'chair' : field === 'target' ? 'desk' : 'mug';

  // Every blank has a value so the preview is a real sentence from the start.
  const filled: Record<string, string> = {};
  for (const field of template.fields) {
    filled[field] = values[field] || optionsFor(field)?.[0] || placeholderFor(field);
  }
  const sentence = fillTemplate(template.template, filled);

  return (
    <div className="p-1.5 border border-edge bg-panel-2/60 rounded-[3px] flex flex-col gap-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        <select
          value={template.id}
          onChange={(e) => { setId(e.target.value); setValues({}); }}
          className={selectClass}
        >
          {actions.templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {template.fields.map((field) => {
          const options = optionsFor(field);
          return options ? (
            <select
              key={field}
              value={filled[field]}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
              className={selectClass}
            >
              {options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input
              key={field}
              value={values[field] ?? ''}
              placeholder={placeholderFor(field)}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
              className={`${inputClass} w-[84px]`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="flex-1 min-w-0 text-[10.5px] text-ink-dim italic truncate" title={sentence}>{sentence}</span>
        <button
          type="button"
          onClick={() => onWrite(sentence)}
          className="h-[19px] px-2 shrink-0 rounded-[3px] border border-accent bg-accent/20 text-[10px] text-ink cursor-pointer hover:bg-accent/30"
        >
          Use this
        </button>
      </div>
    </div>
  );
}

/** Break a heading into its parts, or give up honestly and edit it as text. */
function decomposeHeading(text: string): { prefix: string; location: string; time: string } | null {
  const m = /^(INT\.?\/EXT|INT|EXT|EST|I\/E)\.?\s+(.*)$/i.exec(text.trim());
  if (!m) return null;
  const rest = m[2]!.trim();
  const dash = rest.lastIndexOf(' - ');
  return {
    prefix: m[1]!.toUpperCase(),
    location: dash >= 0 ? rest.slice(0, dash).trim() : rest,
    time: dash >= 0 ? rest.slice(dash + 3).trim() : '',
  };
}

function composeHeading(prefix: string, location: string, time: string): string {
  return `${prefix}. ${location.trim()}${time.trim() ? ` - ${time.trim()}` : ''}`;
}

export function HeadingCard({ block, onText }: { block: HeadingBlock; onText: (text: string) => void }) {
  const parts = decomposeHeading(block.text);
  const times = parts && parts.time && !TIMES.includes(parts.time) ? [parts.time, ...TIMES] : TIMES;

  return (
    <div className={cardShell}>
      <CardHead label="scene" />
      {parts ? (
        <div className="flex items-center gap-1.5">
          <select
            value={parts.prefix}
            onChange={(e) => onText(composeHeading(e.target.value, parts.location, parts.time))}
            className={`${selectClass} shrink-0`}
          >
            {(PREFIXES.includes(parts.prefix) ? PREFIXES : [parts.prefix, ...PREFIXES]).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            value={parts.location}
            placeholder="WHERE"
            onChange={(e) => onText(composeHeading(parts.prefix, e.target.value, parts.time))}
            className={`${inputClass} flex-1 min-w-0 uppercase`}
          />
          <select
            value={parts.time}
            onChange={(e) => onText(composeHeading(parts.prefix, parts.location, e.target.value))}
            className={`${selectClass} shrink-0`}
          >
            <option value="">—</option>
            {times.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      ) : (
        <input value={block.text} onChange={(e) => onText(e.target.value)} className={inputClass} />
      )}
    </div>
  );
}

export function NoteCard({ block, onText }: { block: NoteBlock; onText: (text: string) => void }) {
  return (
    <div className="rounded-[3px] border border-dashed border-[#2f353d] bg-transparent px-2 py-[5px] flex items-center gap-1.5">
      <span className="font-mono text-[10px] text-ink-ghost shrink-0">//</span>
      <input
        value={block.text.replace(/^\/\/\s?/, '')}
        onChange={(e) => onText(e.target.value)}
        placeholder="a note to yourself"
        className="flex-1 min-w-0 bg-transparent border-0 text-[11px] italic text-ink-faint outline-none"
      />
    </div>
  );
}
