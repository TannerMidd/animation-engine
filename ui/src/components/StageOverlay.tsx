import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayerName, PropInstance, PropDefInfo } from '../types.ts';

const STAGE_W = 1280;
const STAGE_H = 720;

/**
 * Drag handles floating over the set preview.
 *
 * The preview is an iframe running the real runtime page, so it cannot be
 * interacted with directly — and shouldn't be, since that page is the renderer
 * and giving it edit affordances would put editor concerns inside the thing that
 * has to stay identical to the output. Instead the handles sit in a transparent
 * layer above it, positioned by the same stage-to-pixel scale the frame uses.
 *
 * Only the current layer gets handles. Showing all three at once produces a
 * thicket of overlapping targets in a set where props are deliberately stacked
 * in depth.
 */
/** Where a prop's vertical position actually lives, if anywhere. */
type YField = 'instance' | 'param' | 'none';

export interface StageMove {
  x: number;
  y?: number;
  paramY?: number;
}

export function StageOverlay({
  items, layer, selected, onSelect, onMove, defs, horizonY,
}: {
  items: PropInstance[];
  layer: LayerName;
  selected: number | null;
  onSelect: (i: number) => void;
  onMove: (i: number, move: StageMove) => void;
  defs: PropDefInfo[];
  horizonY: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const drag = useRef<
    { index: number; startX: number; startY: number; origX: number; origY: number; field: YField } | null
  >(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width < 8 || height < 8) return;
      setScale(Math.min(width / STAGE_W, height / STAGE_H));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      // Screen delta back into stage units, so a drag tracks the cursor exactly
      // however the panel is sized.
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;
      const y = Math.round(d.origY + dy);

      onMove(d.index, {
        x: Math.round(d.origX + dx),
        ...(d.field === 'instance' ? { y } : d.field === 'param' ? { paramY: y } : {}),
      });
    },
    [scale, onMove],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [onPointerMove, endDrag]);

  const label = (key: string) => defs.find((d) => d.key === key)?.label ?? key;
  const spanning = (key: string) => defs.find((d) => d.key === key)?.spanning ?? false;

  /**
   * A prop's height, and which field controls it.
   *
   * Three cases, and they need telling apart or the handles lie. Some props
   * carry an instance `y`. Others — a neon sign, a wall clock — hang themselves
   * from a `y` *param*, and putting their handle on the floor line would show a
   * sign at head height with a grab point by someone's shoes. The rest stand on
   * the ground by definition, and dragging those vertically would silently pin
   * them off it.
   */
  const vertical = (item: PropInstance): { y: number; field: YField } => {
    if (item.y !== undefined) return { y: item.y, field: 'instance' };

    const def = defs.find((d) => d.key === item.prop);
    const spec = def?.params.find((p) => p.key === 'y');
    if (spec) {
      const own = item.params['y'] ?? spec.default;
      if (typeof own === 'number') return { y: own, field: 'param' };
    }
    return { y: horizonY, field: 'none' };
  };

  return (
    <div ref={host} className="absolute inset-0 grid place-items-center pointer-events-none">
      <div
        style={{ width: STAGE_W * scale, height: STAGE_H * scale }}
        className="relative pointer-events-none"
      >
        {items.map((item, i) => {
          // Spanning props cover the whole set and have no position to drag.
          if (spanning(item.prop)) return null;
          const pos = vertical(item);
          const x = (item.x ?? STAGE_W / 2) * scale;
          const y = pos.y * scale;
          const isSelected = selected === i;

          return (
            <button
              key={`${item.prop}-${i}`}
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(i);
                drag.current = {
                  index: i,
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: item.x ?? STAGE_W / 2,
                  origY: pos.y,
                  field: pos.field,
                };
              }}
              style={{ left: x, top: y }}
              title={
                pos.field === 'none'
                  ? `${label(item.prop)} — drag sideways (it stands on the floor)`
                  : `${label(item.prop)} — drag to move`
              }
              className={`absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto cursor-grab active:cursor-grabbing
                rounded-full border-2 transition-colors ${
                  isSelected
                    ? 'w-4 h-4 border-accent bg-accent/40'
                    : 'w-3 h-3 border-white/70 bg-black/40 hover:border-accent'
                }`}
            >
              {isSelected && (
                <span className="absolute left-1/2 -translate-x-1/2 top-4 whitespace-nowrap text-[10px] px-1 rounded bg-black/70 text-white">
                  {label(item.prop)} {Math.round(item.x ?? 0)}
                  {pos.field === 'none' ? '' : `, ${Math.round(pos.y)}`}
                </span>
              )}
            </button>
          );
        })}

        <div className="absolute left-1 bottom-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white/80 pointer-events-none">
          dragging {layer}
        </div>
      </div>
    </div>
  );
}
