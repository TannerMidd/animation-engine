import type { ReactNode } from 'react';
import type { ProductionPreflightReport, ShowInfo } from '../types.ts';
import { Btn, Dot, Kbd, Spinner } from './chrome.tsx';
import { MODE_BLURBS, MODE_DEFS, identitySwatches, type Mode } from './lib.ts';

export type SaveState = { state: 'dirty'; edits: number } | { state: 'saving' } | { state: 'saved'; agoS: number } | { state: 'failed'; reason: string };

export interface ContextTool {
  label: string;
  hint: string;
  primary?: boolean;
  on?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  go: () => void;
}

/** Top chrome: identity of the work, then the modes that act on it. */
export function AppBar({
  sceneTitle, sceneMeta, save, mode, onMode, tools, show, onCycleIdentity,
  quality, onCycleQuality, preflight, preflightBusy, onTogglePreflight, onRender, onCmd,
}: {
  sceneTitle: string;
  sceneMeta: string;
  save: SaveState;
  mode: Mode;
  onMode: (mode: Mode) => void;
  tools: ContextTool[];
  show: ShowInfo | null;
  onCycleIdentity: () => void;
  quality: string;
  onCycleQuality: () => void;
  preflight: ProductionPreflightReport | null;
  preflightBusy: boolean;
  onTogglePreflight: () => void;
  onRender: () => void;
  onCmd: () => void;
}) {
  const saveDot = save.state === 'saved' ? '#6f9b5a' : save.state === 'failed' ? '#c8595a' : '#c8834a';
  const saveLabel =
    save.state === 'dirty' ? `Unsaved · ${save.edits} edit${save.edits === 1 ? '' : 's'}`
    : save.state === 'saving' ? 'Saving…'
    : save.state === 'failed' ? 'Save failed'
    : save.agoS < 3 ? 'Saved just now' : `Saved ${save.agoS}s ago`;

  const blockers = preflight?.notes.filter((n) => n.level === 'error').length ?? 0;
  const warnings = preflight?.notes.filter((n) => n.level === 'warn').length ?? 0;
  const reviewPending = Boolean(preflight && !preflight.productionBlocked && preflight.warningReview.required && !preflight.warningReview.current);
  const ready = preflight ? !preflight.productionBlocked && !reviewPending : null;
  const readyFg = preflight === null ? '#6b737d' : blockers ? '#c8595a' : reviewPending ? '#c8834a' : '#6f9b5a';
  const readyLabel = preflight === null
    ? (preflightBusy ? 'checking…' : 'preflight')
    : blockers
      ? `${blockers} blocker${blockers === 1 ? '' : 's'}`
      : reviewPending
        ? `${warnings} warning${warnings === 1 ? '' : 's'} to review`
        : 'Production ready';

  return (
    <>
      {/* row 1 */}
      <div className="h-10 shrink-0 flex items-center gap-2 px-2.5 bg-panel border-b border-edge">
        <div className="flex items-center gap-[7px] pr-[9px] border-r border-edge h-[22px] shrink-0">
          <span className="relative w-3.5 h-3.5 rounded-[2px] border-[1.5px] border-accent shrink-0">
            <span className="absolute left-[2px] top-[2px] w-1.5 h-1.5 bg-accent" />
          </span>
          <span className="text-[11px] tracking-[.06em] uppercase text-ink-dim whitespace-nowrap">animation engine</span>
        </div>

        <div className="flex items-baseline gap-2 min-w-0 shrink-0">
          <span className="font-serif text-[16px] text-ink whitespace-nowrap">{sceneTitle}</span>
          <span className="font-mono text-[10px] text-ink-faint whitespace-nowrap">{sceneMeta}</span>
        </div>

        <button
          type="button"
          title={save.state === 'failed' ? (save as { reason: string }).reason : 'Autosave lands 500 ms after you stop typing'}
          className="h-[22px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-default"
        >
          <Dot color={saveDot} />
          {saveLabel}
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={onCmd}
          title="Command palette · ⌘K"
          className="h-6 w-[212px] px-2 rounded-[3px] border border-edge bg-stage text-ink-faint text-[11px] flex items-center gap-[7px] cursor-text text-left shrink-0 hover:border-edge-2 hover:text-ink-dim"
        >
          <span className="shrink-0">⌕</span>
          <span className="flex-1 whitespace-nowrap overflow-hidden">Search or run a command</span>
          <Kbd>⌘K</Kbd>
        </button>

        <button
          type="button"
          onClick={onCycleIdentity}
          title="Show identity governs line treatment, register, wardrobe, acting envelope and cutting rhythm. Every render is stamped with it."
          className="h-[22px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink text-[11px] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer hover:bg-edge"
        >
          <span className="flex gap-[2px] shrink-0">
            {identitySwatches(show?.active.hash ?? '').map((c, i) => (
              <span key={i} className="w-[5px] h-[11px] rounded-px" style={{ background: c }} />
            ))}
          </span>
          {show ? show.active.name : '…'}
          {show && show.profiles.length > 1 && <span className="text-ink-faint text-[9px]">▾</span>}
        </button>

        <button
          type="button"
          onClick={onCycleQuality}
          title="Preview fidelity: Draft uses word-count estimates; Accurate uses rendered audio and Rhubarb cues; Final matches the capture path exactly."
          className="h-[22px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink text-[11px] inline-flex items-center gap-[5px] whitespace-nowrap shrink-0 cursor-pointer hover:bg-edge"
        >
          {quality}
          <span className="text-ink-faint text-[9px]">▾</span>
        </button>

        <button
          type="button"
          onClick={onTogglePreflight}
          title={preflight
            ? `Production readiness — ${blockers} blocker${blockers === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}. Click to open the full report.`
            : 'Run production preflight and open the report.'}
          className="h-6 px-2 rounded-[3px] border text-[11px] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          style={{
            color: readyFg,
            borderColor: preflight === null ? '#363d46' : `${readyFg}73`,
            background: preflight === null ? '#2b3138' : `${readyFg}21`,
          }}
        >
          {preflightBusy ? <Spinner /> : <span className="w-[7px] h-[7px] rounded-full" style={{ background: readyFg }} />}
          {readyLabel}
          {ready === true ? null : null}
        </button>

        <Btn primary onClick={onRender} className="h-6 px-[11px] shrink-0">Render…</Btn>
      </div>

      {/* row 2: modes + contextual toolbar */}
      <div className="h-[34px] shrink-0 flex items-center gap-2.5 px-2.5 bg-[#21252b] border-b border-edge">
        <div className="flex gap-px bg-[#1a1d22] border border-edge rounded-[4px] p-[2px]">
          {MODE_DEFS.map((m) => {
            const onIt = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => onMode(m.id)}
                className={`h-[22px] px-2.5 rounded-[2px] text-[11px] tracking-[.03em] cursor-pointer inline-flex items-center gap-[5px] ${
                  onIt ? 'bg-accent text-stage font-semibold' : m.planned ? 'text-[#7f8892]' : 'text-ink-dim hover:text-ink'
                }`}
              >
                {m.label}
                {m.planned && (
                  <span
                    title="Not in the engine yet — designed ahead of implementation"
                    className={`text-[8px] tracking-[.08em] uppercase border rounded-[2px] px-[3px] leading-[11px] ${onIt ? 'border-stage text-stage' : 'border-gen text-gen'}`}
                  >
                    planned
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="w-px h-4 bg-edge shrink-0" />
        <div className="text-[11px] text-ink-faint tracking-[.02em] whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
          {MODE_BLURBS[mode]}
        </div>
        <div className="flex-1" />

        <div className="flex items-center gap-[5px] shrink-0">
          {tools.map((t) => (
            <Btn key={t.label} onClick={t.go} title={t.hint} primary={t.primary} on={t.on} danger={t.danger} disabled={t.disabled}>
              {t.busy ? <Spinner /> : null}
              {t.label}
            </Btn>
          ))}
        </div>
      </div>
    </>
  );
}

export function BarDivider({ children }: { children?: ReactNode }) {
  return <div className="w-px h-4 bg-edge shrink-0">{children}</div>;
}
