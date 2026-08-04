import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProductionPreflightReport, ShowInfo } from '../types.ts';
import { Btn, Dot, Kbd, Mono, Spinner } from './chrome.tsx';
import { MODE_BLURBS, MODE_DEFS, identitySwatches, type Mode } from './lib.ts';

export interface EngineOption {
  name: string;
  ok: boolean;
  checking?: boolean;
  reason?: string;
}

/**
 * The voice-engine chip: the same class of decision as the quality chip beside
 * it — "how is this machine going to make sound". An unusable engine explains
 * itself here, in the menu, instead of erroring minutes into a Voices run.
 */
function EngineChip({
  engine, engines, onEngine,
}: {
  engine: string;
  engines: EngineOption[];
  onEngine: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const current = engines.find((e) => e.name === engine);
  const dot = current ? (current.checking ? '#6b737d' : current.ok ? '#6f9b5a' : '#c8595a') : '#6b737d';

  return (
    <div ref={host} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Which engine synthesizes dialogue. Voices and Render both use this choice; sapi needs no Python or GPU."
        className="h-[22px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink text-[11px] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer hover:bg-edge"
      >
        <Dot color={dot} pulse={current?.checking} />
        <span className="font-mono text-[10px]">{engine}</span>
        <span className="text-ink-faint text-[9px]">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-[26px] w-[300px] bg-panel border border-edge-2 rounded-[4px] shadow-[0_18px_50px_-14px_rgba(0,0,0,.8)] z-40 overflow-hidden">
          <div className="h-[26px] flex items-center px-2.5 border-b border-edge text-[10px] tracking-[.07em] uppercase text-ink-faint">
            Voice engine
          </div>
          {engines.map((option) => {
            const usable = option.ok && !option.checking;
            const on = option.name === engine;
            return (
              <button
                key={option.name}
                type="button"
                disabled={!usable}
                onClick={() => {
                  onEngine(option.name);
                  setOpen(false);
                }}
                className={`w-full text-left px-2.5 py-1.5 border-b border-[#2a2f36] flex gap-2 items-start ${
                  usable ? 'cursor-pointer hover:bg-[#2b3138]' : 'cursor-not-allowed opacity-75'
                }`}
                style={{ background: on ? 'rgba(200,131,74,.10)' : 'transparent' }}
              >
                <Dot
                  color={option.checking ? '#6b737d' : option.ok ? '#6f9b5a' : '#c8595a'}
                  pulse={option.checking}
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px]" style={{ color: on ? '#e6e3dc' : '#9aa1ab' }}>{option.name}</span>
                    {on && <span className="text-[8.5px] tracking-[.06em] uppercase text-accent">in use</span>}
                  </span>
                  <span className="block text-[10px] text-ink-faint leading-[1.4] mt-[2px]">
                    {option.checking
                      ? 'probing…'
                      : option.ok
                        ? option.name === 'sapi'
                          ? 'Windows voices — no Python or GPU needed'
                          : 'neural cloning — voices follow each character’s reference'
                        : option.reason?.split('\n')[0] ?? 'unavailable'}
                  </span>
                </span>
              </button>
            );
          })}
          <div className="px-2.5 py-1.5 text-[9.5px] text-ink-ghost leading-[1.4]">
            The soundtrack remembers which engine built it; switching marks the mix stale until Voices runs again.
          </div>
        </div>
      )}
    </div>
  );
}

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

/**
 * The shot list has fallen behind the script.
 *
 * Directing is deliberately propose-then-apply, which means the script can sit
 * ahead of everything downstream of it — timeline, dialogue, animation,
 * preview, render — with no other symptom than being wrong. This is the only
 * place that says so, and it lives above the mode switcher because the modes
 * that show the stale material are exactly the ones you would be looking at.
 */
export function StaleBar({
  beats, scriptBeats, shotBeats, busy, onApply,
}: {
  beats: number;
  scriptBeats: number;
  shotBeats: number;
  busy: boolean;
  onApply: () => void;
}) {
  return (
    <div className="h-[26px] shrink-0 flex items-center gap-2 px-2.5 bg-accent/12 border-b border-accent/40">
      <Dot color="#c8834a" />
      <span className="text-[11px] text-[#e0b489] whitespace-nowrap">
        Script has changed.
      </span>
      <span className="text-[11px] text-ink-dim whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
        The shot list, timeline, voices, animation and preview still show the previous direction.
      </span>
      <Mono
        className="text-ink-faint whitespace-nowrap shrink-0"
        title={`${beats} beat${beats === 1 ? '' : 's'} differ between the script and the applied shot list`}
      >
        {shotBeats} → {scriptBeats} beats
      </Mono>
      <div className="flex-1" />
      <Btn primary onClick={onApply} title="Direct the current script and apply it. You confirm the diff first; locked beats survive." className="shrink-0">
        {busy ? <Spinner /> : null}
        Apply direction
      </Btn>
    </div>
  );
}

/**
 * The identity chip: no longer a blind cycle. The menu names every profile,
 * switches by choice, and carries the two whole-show tools — comparison and
 * the identity reel.
 */
function IdentityChip({
  show, onSwitch, onCompare, onReel,
}: {
  show: ShowInfo | null;
  onSwitch: (id: string) => void;
  onCompare: () => void;
  onReel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (go: () => void) => {
    setOpen(false);
    go();
  };

  return (
    <div ref={host} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Show identity governs line treatment, register, wardrobe, acting envelope and cutting rhythm. Every render is stamped with it."
        className="h-[22px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink text-[11px] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer hover:bg-edge"
      >
        <span className="flex gap-[2px] shrink-0">
          {identitySwatches(show?.active.hash ?? '').map((c, i) => (
            <span key={i} className="w-[5px] h-[11px] rounded-px" style={{ background: c }} />
          ))}
        </span>
        {show ? show.active.name : '…'}
        <span className="text-ink-faint text-[9px]">▾</span>
      </button>
      {open && show && (
        <div className="absolute right-0 top-[26px] w-[300px] bg-panel border border-edge-2 rounded-[4px] shadow-[0_18px_50px_-14px_rgba(0,0,0,.8)] z-40 overflow-hidden">
          <div className="h-[26px] flex items-center px-2.5 border-b border-edge text-[10px] tracking-[.07em] uppercase text-ink-faint">
            Show identity
          </div>
          {show.profiles.map((profile) => {
            const active = profile.id === show.active.id;
            return (
              <button
                key={profile.id}
                type="button"
                disabled={active}
                onClick={() => pick(() => onSwitch(profile.id))}
                title={active ? 'The active identity' : `Switch the show to ${profile.name}. Everything downstream re-derives, so the app reloads.`}
                className={`w-full text-left px-2.5 py-1.5 border-b border-[#2a2f36] flex gap-2 items-center ${
                  active ? 'cursor-default' : 'cursor-pointer hover:bg-[#2b3138]'
                }`}
                style={{ background: active ? 'rgba(200,131,74,.10)' : 'transparent' }}
              >
                <span className="flex gap-[2px] shrink-0">
                  {identitySwatches(profile.hash).map((c, i) => (
                    <span key={i} className="w-[4px] h-[10px] rounded-px" style={{ background: c }} />
                  ))}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] truncate" style={{ color: active ? '#e6e3dc' : '#9aa1ab' }}>{profile.name}</span>
                  <Mono className="text-ink-ghost">{profile.id} · v{profile.version}</Mono>
                </span>
                {active && <span className="text-[8.5px] tracking-[.06em] uppercase text-accent shrink-0">active</span>}
              </button>
            );
          })}
          {show.profiles.length < 2 && (
            <div className="px-2.5 py-1.5 text-[10px] text-ink-ghost leading-[1.4] border-b border-[#2a2f36]">
              One profile on disk. The System report's migration step creates the project profile.
            </div>
          )}
          <button
            type="button"
            onClick={() => pick(onCompare)}
            className="w-full text-left px-2.5 py-1.5 border-b border-[#2a2f36] text-[11px] text-ink-dim cursor-pointer hover:bg-[#2b3138] hover:text-ink"
          >
            Compare two profiles…
          </button>
          <button
            type="button"
            onClick={() => pick(onReel)}
            title="The same script rendered under two identities, stacked into one video. Two full renders — minutes."
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-ink-dim cursor-pointer hover:bg-[#2b3138] hover:text-ink"
          >
            Render identity reel…
          </button>
        </div>
      )}
    </div>
  );
}

/** Top chrome: identity of the work, then the modes that act on it. */
export function AppBar({
  sceneTitle, sceneMeta, sceneMetaStale, save, mode, onMode, tools, show,
  onSwitchIdentity, onCompareIdentity, onRenderReel,
  quality, onCycleQuality, engine, engines, onEngine, preflight, preflightBusy, onTogglePreflight, onRender, onCmd,
}: {
  sceneTitle: string;
  sceneMeta: string;
  /** Tints the meta when the counts describe a shot list the script has outgrown. */
  sceneMetaStale?: boolean;
  save: SaveState;
  mode: Mode;
  onMode: (mode: Mode) => void;
  tools: ContextTool[];
  show: ShowInfo | null;
  onSwitchIdentity: (id: string) => void;
  onCompareIdentity: () => void;
  onRenderReel: () => void;
  quality: string;
  onCycleQuality: () => void;
  engine: string;
  engines: EngineOption[];
  onEngine: (name: string) => void;
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
          <span
            title={sceneMetaStale ? 'Counted from the applied shot list, which the script has moved ahead of' : undefined}
            className={`font-mono text-[10px] whitespace-nowrap ${sceneMetaStale ? 'text-accent' : 'text-ink-faint'}`}
          >
            {sceneMeta}
          </span>
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

        <IdentityChip
          show={show}
          onSwitch={onSwitchIdentity}
          onCompare={onCompareIdentity}
          onReel={onRenderReel}
        />

        <button
          type="button"
          onClick={onCycleQuality}
          title="Preview fidelity: Draft uses word-count estimates; Accurate uses rendered audio and Rhubarb cues; Final matches the capture path exactly."
          className="h-[22px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink text-[11px] inline-flex items-center gap-[5px] whitespace-nowrap shrink-0 cursor-pointer hover:bg-edge"
        >
          {quality}
          <span className="text-ink-faint text-[9px]">▾</span>
        </button>

        <EngineChip engine={engine} engines={engines} onEngine={onEngine} />

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
