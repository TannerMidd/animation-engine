import { useEffect, useRef, useState } from 'react';
import type { SetFit, SetSummary } from '../types.ts';
import { Dot } from './chrome.tsx';

/**
 * Changing the set, from wherever you happen to be standing.
 *
 * The set used to be reachable only from a `<select>` three levels down the
 * inspector, which is why people concluded the editor could not change it at
 * all. This is the one control behind every entrance — stage toolbar, sidebar,
 * designer, command palette — so they cannot disagree about what a set costs.
 *
 * Each row prices itself before it is chosen. A set that cannot host the
 * scene's staging says so here rather than blanking the stage afterwards.
 */

/** One line of plain English for what a set will do to this scene. */
export function fitSummary(fit: SetFit | undefined): { text: string; tone: 'good' | 'warn' | 'none' } {
  if (!fit) return { text: '', tone: 'none' };
  if (!fit.issues.length) {
    return fit.references
      ? { text: `stages all ${fit.references} prop ${fit.references === 1 ? 'move' : 'moves'}`, tone: 'good' }
      : { text: '', tone: 'none' };
  }
  const beats = new Set(fit.issues.map((issue) => issue.beatIndex ?? `actor:${issue.actorId}`)).size;
  return { text: `${beats} ${beats === 1 ? 'beat' : 'beats'} won't stage`, tone: 'warn' };
}

/** The bare stage breaks exactly what the scene asks of any set. */
export function bareStageFit(sets: SetSummary[]): SetFit | undefined {
  const known = sets.find((item) => item.fit);
  if (!known?.fit) return undefined;
  return { references: known.fit.references, issues: [] };
}

export function SetPicker({
  sets, current, onChoose, onOpenDesigner, onDescribe, align = 'left', className = '',
}: {
  sets: SetSummary[];
  /** The set the scene is on, without its extension. Null is the bare stage. */
  current: string | null;
  onChoose: (name: string | null) => void;
  onOpenDesigner: (name: string | null) => void;
  onDescribe?: () => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const pick = (go: () => void) => {
    setOpen(false);
    go();
  };

  const bare = bareStageFit(sets);
  const bareCost = bare?.references
    ? `${bare.references} prop ${bare.references === 1 ? 'move' : 'moves'} won't stage`
    : 'nothing but the characters';

  return (
    <div ref={host} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="The room this scene stages in. Changing it redraws the preview."
        className="h-5 px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] inline-flex items-center gap-1 whitespace-nowrap cursor-pointer hover:text-ink hover:bg-edge"
      >
        <span className="text-accent">▦</span>
        <span className="text-ink">{current ?? 'bare stage'}</span>
        <span className="text-ink-faint text-[9px]">▾</span>
      </button>

      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-[24px] w-[292px] bg-panel border border-edge-2 rounded-[4px] shadow-[0_18px_50px_-14px_rgba(0,0,0,.8)] z-40 overflow-hidden`}
        >
          <div className="h-[26px] flex items-center px-2.5 border-b border-edge text-[10px] tracking-[.07em] uppercase text-ink-faint">
            Set for this scene
          </div>

          <div className="max-h-[290px] overflow-y-auto">
            {sets.map((item) => {
              const on = item.name === current;
              const fit = fitSummary(item.fit);
              return (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => pick(() => onChoose(item.name))}
                  title={item.fit?.issues.length
                    ? item.fit.issues.map((issue) => `${issue.detail} — "${issue.label}"`).join('\n')
                    : `Stage this scene in ${item.name}`}
                  className="w-full text-left px-2.5 py-1.5 border-b border-[#2a2f36] flex gap-2 items-center cursor-pointer hover:bg-[#2b3138]"
                  style={{ background: on ? 'rgba(200,131,74,.10)' : 'transparent' }}
                >
                  <span className="w-3 shrink-0 text-accent text-[11px]">{on ? '✓' : ''}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[11.5px] text-ink truncate">{item.name}</span>
                    <span className="block text-[9.5px] text-ink-faint truncate">
                      {item.palette} · {item.propCount} props{item.builtin ? ' · builtin' : ''}
                    </span>
                  </span>
                  {fit.tone !== 'none' && (
                    <span className="flex items-center gap-1 shrink-0">
                      <Dot color={fit.tone === 'good' ? '#6f9b5a' : '#c8834a'} />
                      <span
                        className="text-[9.5px]"
                        style={{ color: fit.tone === 'good' ? '#6f9b5a' : '#c8834a' }}
                      >
                        {fit.text}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => pick(() => onChoose(null))}
              title="Play the scene against an empty stage."
              className="w-full text-left px-2.5 py-1.5 border-b border-[#2a2f36] flex gap-2 items-center cursor-pointer hover:bg-[#2b3138]"
              style={{ background: current === null ? 'rgba(200,131,74,.10)' : 'transparent' }}
            >
              <span className="w-3 shrink-0 text-accent text-[11px]">{current === null ? '✓' : ''}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[11.5px] text-ink-dim truncate">no set — bare stage</span>
                <span className="block text-[9.5px] text-ink-faint truncate">{bareCost}</span>
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => pick(() => onOpenDesigner(current))}
            className="w-full h-[26px] px-2.5 flex items-center gap-2 text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink cursor-pointer border-t border-edge"
          >
            <span className="w-3 text-center">▦</span>
            {current ? `Edit "${current}" in the set designer…` : 'Open the set designer…'}
          </button>
          {onDescribe && (
            <button
              type="button"
              onClick={() => pick(onDescribe)}
              className="w-full h-[26px] px-2.5 flex items-center gap-2 text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink cursor-pointer"
            >
              <span className="w-3 text-center">✎</span>
              Describe a new set…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
