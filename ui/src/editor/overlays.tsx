import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionPreflightNote, ProductionPreflightReport } from '../types.ts';
import { Kbd, Mono, Spinner } from './chrome.tsx';
import { ReadinessGroupCard, groupPreflight } from './panes.tsx';

export interface Command {
  icon: string;
  label: string;
  group: string;
  key?: string;
  keywords?: string;
  run: () => void;
}

/** ⌘K palette. Everything the chrome can do, reachable by typing. */
export function CommandPalette({
  commands, onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 9);
    return commands
      .filter((c) => `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(q))
      .slice(0, 9);
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 bg-[rgba(12,13,15,.55)] z-40 flex justify-center pt-24"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] h-fit bg-panel border border-edge-2 rounded-[5px] overflow-hidden shadow-[0_28px_70px_-18px_rgba(0,0,0,.85)]"
      >
        <div className="h-10 flex items-center gap-[9px] px-3 border-b border-edge">
          <span className="text-ink-faint text-[13px]">⌕</span>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              if (e.key === 'Enter') run(results[cursor]);
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Type a command or a beat…"
            className="flex-1 bg-transparent border-0 outline-none text-[13px] text-ink placeholder:text-ink-ghost caret-accent"
          />
          <Kbd>esc</Kbd>
        </div>
        {results.map((command, i) => (
          <button
            key={`${command.group}-${command.label}`}
            type="button"
            onMouseEnter={() => setCursor(i)}
            onClick={() => run(command)}
            className="w-full flex items-center gap-2.5 h-[34px] px-3 border-b border-[#2a2f36] cursor-pointer text-left"
            style={{ background: i === cursor ? '#2b3138' : 'transparent' }}
          >
            <span className="w-3.5 text-center text-[10px]" style={{ color: i === cursor ? '#c8834a' : '#9aa1ab' }}>{command.icon}</span>
            <span className="flex-1 text-[12px] truncate" style={{ color: i === cursor ? '#e6e3dc' : '#8b939d' }}>{command.label}</span>
            <span className="text-[10px] text-[#5d656e]">{command.group}</span>
            {i === cursor && <Kbd>↵</Kbd>}
          </button>
        ))}
        {!results.length && (
          <div className="h-[34px] px-3 flex items-center text-[12px] text-ink-ghost">No matching command.</div>
        )}
        <div className="h-[26px] flex items-center gap-3 px-3 bg-[#21252b] text-[10px] text-[#5d656e]">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
        </div>
      </div>
    </div>
  );
}

/** The full production-readiness report, anchored under the app-bar chip. */
export function PreflightPopover({
  report, busy, checkedAgoS, onClose, onAcknowledge, onJump, onRender,
}: {
  report: ProductionPreflightReport | null;
  busy: boolean;
  /**
   * Seconds since this verdict was computed, or null before the first run.
   *
   * Without it a cached report is indistinguishable from a live one — which is
   * how a soundtrack rebuilt two runs ago keeps reading as stale.
   */
  checkedAgoS: number | null;
  onClose: () => void;
  onAcknowledge: () => void;
  onJump: (note: ProductionPreflightNote) => void;
  onRender: () => void;
}) {
  const groups = groupPreflight(report, onJump);
  const blockers = report?.notes.filter((n) => n.level === 'error').length ?? 0;
  const warnings = report?.notes.filter((n) => n.level === 'warn').length ?? 0;
  const reviewPending = Boolean(report && !report.productionBlocked && report.warningReview.required && !report.warningReview.current);
  const dot = !report ? '#6b737d' : blockers ? '#c8595a' : reviewPending ? '#c8834a' : '#6f9b5a';
  const ack = report?.warningReview.acknowledgement ?? null;

  return (
    <div className="absolute right-2.5 top-[78px] w-[456px] max-h-[calc(100%-120px)] bg-panel border border-edge-2 rounded-[5px] shadow-[0_24px_60px_-18px_rgba(0,0,0,.8)] z-[35] flex flex-col overflow-hidden">
      <div className="h-[34px] shrink-0 flex items-center gap-2 px-[11px] border-b border-edge bg-[#282d34]">
        <span className="w-[7px] h-[7px] rounded-full" style={{ background: dot }} />
        <span className="text-[11px] tracking-[.07em] uppercase text-ink">Production readiness</span>
        <Mono className="text-ink-faint">policy production-v1</Mono>
        <div className="flex-1" />
        <span
          title="This report is re-run when you open it and whenever Voices or a render finishes."
          className="inline-flex items-center gap-1.5 text-[10px] text-ink-faint whitespace-nowrap"
        >
          {busy ? <Spinner /> : null}
          {busy
            ? 'checking…'
            : checkedAgoS === null
              ? 'not checked yet'
              : checkedAgoS < 3 ? 'checked just now' : `checked ${checkedAgoS}s ago`}
        </span>
        <button type="button" onClick={onClose} className="w-5 h-5 text-ink-faint text-[12px] cursor-pointer hover:text-ink">×</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-[11px] py-[9px] pb-3 flex flex-col gap-2 select-text">
        <div className="text-[11px] text-ink-dim leading-[1.5]">
          Production render is stricter than preview. Errors block export. Warnings do not, but need a review
          acknowledgement bound to these exact inputs — any relevant edit makes it stale.
        </div>
        {ack && report?.warningReview.current && (
          <div className="text-[10px] text-ink-faint leading-snug border border-[#2f353d] rounded-[3px] px-2 py-1.5 bg-stage">
            Reviewed by {ack.acknowledgedBy} · {new Date(ack.acknowledgedAt).toLocaleString()} · bound to these inputs
          </div>
        )}
        {groups.map((group) => <ReadinessGroupCard key={group.name} group={group} dark />)}
        {!report && !busy && (
          <div className="py-6 text-center text-[11px] text-ink-ghost">Preflight has not run yet.</div>
        )}
      </div>
      <div className="shrink-0 px-[11px] py-[9px] border-t border-edge bg-[#22262c] flex gap-[7px] items-center">
        <span className="flex-1 text-[10px] text-ink-faint leading-[1.4]">Reviewed by you · never auto-dismissed</span>
        {reviewPending && (
          <button
            type="button"
            onClick={onAcknowledge}
            title="Append a review record bound to these exact warnings and creative inputs. Any edit makes it stale."
            className="h-[26px] px-2.5 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[11px] cursor-pointer hover:text-ink"
          >
            I reviewed the {warnings} warning{warnings === 1 ? '' : 's'}
          </button>
        )}
        <button
          type="button"
          onClick={onRender}
          disabled={blockers > 0 || reviewPending}
          className={`h-[26px] px-[11px] rounded-[3px] border text-[11px] font-semibold ${
            blockers || reviewPending
              ? 'border-bad/50 bg-bad/10 text-bad cursor-not-allowed'
              : 'border-good bg-good/20 text-[#8fbd76] cursor-pointer hover:bg-good/30'
          }`}
        >
          {blockers ? 'Render blocked' : reviewPending ? 'Review required' : 'Render master'}
        </button>
      </div>
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  body: string;
  list?: Array<{ tag: string; fg: string; text: string }>;
  ok: string;
  okTone: 'accent' | 'bad' | 'good';
  onOk: () => void;
  /** A second, quieter path — "render a draft anyway" beside "review readiness". */
  alt?: { label: string; onPick: () => void };
}

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const tone = spec.okTone === 'accent'
    ? 'bg-accent border-accent text-stage'
    : spec.okTone === 'good'
      ? 'bg-good/20 border-good text-[#8fbd76]'
      : 'bg-bad/15 border-bad/50 text-bad';
  return (
    <div className="absolute inset-0 bg-[rgba(12,13,15,.6)] z-[45] grid place-items-center">
      <div className="w-[430px] bg-panel border border-edge-2 rounded-[5px] shadow-[0_28px_70px_-18px_rgba(0,0,0,.85)] overflow-hidden">
        <div className="px-4 pt-3.5 pb-3 select-text">
          <div className="font-serif text-[17px] text-ink mb-[7px]">{spec.title}</div>
          <div className="text-[11.5px] text-ink-dim leading-[1.55]">{spec.body}</div>
          {spec.list && (
            <div className="mt-2.5 border border-[#2f353d] rounded-[3px] bg-stage px-[9px] py-[7px] flex flex-col gap-1">
              {spec.list.map((item, i) => (
                <div key={i} className="flex gap-[7px] items-baseline text-[10.5px]">
                  <span className="font-mono" style={{ color: item.fg }}>{item.tag}</span>
                  <span className="text-ink-dim flex-1">{item.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-[7px] px-4 py-2.5 bg-[#22262c] border-t border-edge">
          {spec.alt && (
            <button
              type="button"
              onClick={() => {
                onClose();
                spec.alt!.onPick();
              }}
              className="h-[27px] px-3 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[11px] cursor-pointer hover:text-ink"
            >
              {spec.alt.label}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-[27px] px-3 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[11px] cursor-pointer hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              spec.onOk();
            }}
            className={`h-[27px] px-3 rounded-[3px] border text-[11px] font-semibold cursor-pointer ${tone}`}
          >
            {spec.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
