import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Kbd } from './chrome.tsx';
import { placeMenu } from './lib.ts';

/**
 * What was right-clicked.
 *
 * Surfaces report *what* was under the pointer and nothing else; EditorApp
 * turns that into items. Keeping the decision in one place is what stops nine
 * components each needing a dozen callbacks drilled into them, and it keeps
 * every destructive action on the one path that raises a confirm dialog.
 */
export type MenuTarget =
  | { kind: 'beat'; index: number }
  | { kind: 'dialogue'; index: number }
  | { kind: 'motion'; segmentId: string }
  | { kind: 'track'; trackId: string }
  | { kind: 'ruler'; ms: number }
  | { kind: 'lane'; trackId: string; ms: number }
  | { kind: 'actor'; actorId: string }
  | { kind: 'prop'; propId: string }
  | { kind: 'stage' }
  | { kind: 'scene'; name: string }
  | { kind: 'cast'; name: string }
  | { kind: 'set'; name: string }
  | { kind: 'sceneFile'; file: 'script' | 'shotlist' | 'dialogue' | 'animation' | 'video' }
  | { kind: 'chrome' };

export interface MenuAction {
  label: string;
  hint?: string;
  /** Checkable row — renders a ✓ in the leading column. */
  on?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Why the row is greyed. A disabled item that cannot explain itself is a dead end. */
  disabledReason?: string;
  /** Shortcut hint, right-aligned. */
  keys?: string;
  go: () => void;
}

export type MenuItem =
  | { kind: 'separator' }
  | { kind: 'section'; label: string }
  | ({ kind: 'action' } & MenuAction);

export const sep: MenuItem = { kind: 'separator' };
export const section = (label: string): MenuItem => ({ kind: 'section', label });
export const act = (action: MenuAction): MenuItem => ({ kind: 'action', ...action });

/**
 * Opening is one call, and it does the preventing and the stopping itself so
 * no call site can forget either.
 *
 * The event is structurally typed rather than `React.MouseEvent` because the
 * stage's menu comes from a listener inside the preview iframe, where there is
 * no synthetic event to hand over.
 */
export type OpenMenu = (
  event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  target: MenuTarget,
) => void;

const isRunnable = (item: MenuItem): boolean => item.kind === 'action' && !item.disabled;

/**
 * The app's context menu.
 *
 * Fixed rather than absolute: it has to escape the `overflow-hidden` on the
 * editor root and on the timeline's scroller, and client coordinates are
 * already in the space `fixed` uses.
 */
export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [cursor, setCursor] = useState(-1);

  // Measure, then place. Reading the rendered box beats guessing from the item
  // count, and useLayoutEffect commits the correction before paint so nothing
  // is ever seen at the unplaced position.
  useLayoutEffect(() => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace(placeMenu(
      { x, y },
      { w: rect.width, h: rect.height },
      { w: window.innerWidth, h: window.innerHeight },
    ));
  }, [x, y, items]);

  useEffect(() => {
    host.current?.focus({ preventScroll: true });
  }, []);

  const run = (item: MenuItem | undefined) => {
    if (!item || item.kind !== 'action' || item.disabled) return;
    // Close first: several actions raise a confirm dialog, and closing after
    // would fight its lifecycle.
    onClose();
    item.go();
  };

  useEffect(() => {
    const step = (from: number, delta: number) => {
      for (let i = from + delta; i >= 0 && i < items.length; i += delta) {
        if (isRunnable(items[i]!)) return i;
      }
      // Wrap, so ↑ from the first row lands on the last.
      for (let i = delta > 0 ? 0 : items.length - 1; i >= 0 && i < items.length; i += delta) {
        if (isRunnable(items[i]!)) return i;
      }
      return from;
    };
    const edge = (delta: number) => step(delta > 0 ? -1 : items.length, delta);

    const onKey = (e: KeyboardEvent) => {
      // Escape is handled here rather than in the editor's shared handler:
      // that one closes seven overlays at once, so a menu open over a confirm
      // dialog would dismiss both. Stopping in the capture phase also shields
      // Space-to-play and Shift+arrows while a menu is up.
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const keyed: Record<string, () => number> = {
        ArrowDown: () => step(cursor, 1),
        ArrowUp: () => step(cursor, -1),
        Home: () => edge(1),
        End: () => edge(-1),
      };
      const next = keyed[e.key];
      if (next) {
        e.preventDefault();
        e.stopPropagation();
        setCursor(next());
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        run(items[cursor]);
      }
    };
    // Outside press dismisses, but is deliberately not swallowed — right-click
    // one clip then left-click another should be a single gesture.
    const onDown = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) onClose();
    };
    // Capture, because `scroll` does not bubble from elements: a bubble-phase
    // window listener would miss the sidebar, the inspector and the timeline.
    const onScroll = () => onClose();

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('blur', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('blur', onScroll);
    };
  });

  return (
    <div
      ref={host}
      role="menu"
      tabIndex={-1}
      className="fixed w-[236px] bg-panel border border-edge-2 rounded-[4px] shadow-[0_14px_40px_-12px_rgba(0,0,0,.8)] py-1 z-[70] overflow-y-auto outline-none"
      style={{
        left: place?.left ?? x,
        top: place?.top ?? y,
        maxHeight: place?.maxHeight,
        opacity: place ? 1 : 0,
      }}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} role="separator" className="h-px my-1 bg-[#2f353d]" />;
        if (item.kind === 'section') {
          return (
            <div key={i} className="h-[22px] px-2.5 flex items-center text-[10px] tracking-[.07em] uppercase text-ink-faint">
              {item.label}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role={item.on === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.on === undefined ? undefined : item.on}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason ?? item.hint : item.hint}
            onMouseEnter={() => setCursor(i)}
            onClick={() => run(item)}
            className={`w-full h-6 px-2.5 flex items-center gap-2 text-[11px] text-left cursor-pointer ${
              item.danger ? 'text-bad hover:bg-bad/15' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
            } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
            style={{ background: i === cursor && !item.disabled ? '#2b3138' : undefined }}
          >
            <span className="w-3 shrink-0 text-accent">{item.on ? '✓' : ''}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.keys && <Kbd>{item.keys}</Kbd>}
          </button>
        );
      })}
      {!items.length && (
        <div className="h-6 px-2.5 flex items-center text-[11px] text-ink-ghost">Nothing to do here.</div>
      )}
    </div>
  );
}
