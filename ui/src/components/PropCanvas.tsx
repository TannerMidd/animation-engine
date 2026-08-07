import { useEffect, useRef, useState } from 'react';
import type { Primitive, PrimitiveBox, PropRender } from '../types.ts';

/**
 * The drawing surface.
 *
 * Two layers, deliberately. Underneath is markup the *engine* produced — the
 * real prop, with the real wobble, in the real palette — because a canvas that
 * drew its own approximation would be a second renderer, and the two would
 * drift. On top is a transparent layer of handles positioned from boxes the
 * server measured. Nothing here knows how a prop looks; it only knows where the
 * shapes are, which is the least it can know and still be draggable.
 *
 * The same split the stage overlay makes over the preview iframe, for the same
 * reason: one renderer, and an interaction layer that floats above it.
 */

export type Tool = 'select' | 'rect' | 'ellipse' | 'poly' | 'line' | 'text';

/** A character is about 500 units tall, which is the only scale reference that means anything. */
const FIGURE_HEIGHT = 500;

interface Point {
  x: number;
  y: number;
}

export function PropCanvas({
  render, tool, selected, spanning, onSelect, onDraw, onNudge, onFinishTool,
}: {
  render: PropRender | null;
  tool: Tool;
  selected: number[] | null;
  spanning: boolean;
  onSelect: (path: number[] | null) => void;
  onDraw: (primitive: Primitive) => void;
  onNudge: (path: number[], dx: number, dy: number) => void;
  onFinishTool: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point; moving: number[] | null } | null>(null);
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);

  // Leaving a tool must not strand a half-drawn polygon on the canvas.
  useEffect(() => setPolyPoints([]), [tool]);

  const box = frameFor(render, spanning);

  /** Screen pixels to prop-local units, via the SVG's own transform. */
  const at = (e: { clientX: number; clientY: number }): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const local = p.matrixTransform(ctm.inverse());
    return { x: round(local.x), y: round(local.y) };
  };

  const pointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const point = at(e);
    // Capture keeps a drag alive when the pointer leaves the shape. It throws
    // for a pointer id the browser does not know about, which is never fatal.
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch { /* not capturable — the drag still works, it just cannot leave */ }

    if (tool === 'poly') {
      setPolyPoints((pts) => [...pts, point]);
      return;
    }
    if (tool === 'select') {
      const hit = topmostAt(render?.boxes ?? [], point);
      onSelect(hit?.path ?? null);
      if (hit) setDrag({ from: point, to: point, moving: hit.path });
      return;
    }
    setDrag({ from: point, to: point, moving: null });
  };

  const pointerMove = (e: React.PointerEvent) => {
    const point = at(e);
    setCursor(point);
    setDrag((d) => (d ? { ...d, to: point } : null));
  };

  const pointerUp = () => {
    if (!drag) return;
    const { from, to, moving } = drag;
    setDrag(null);

    if (moving) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (dx || dy) onNudge(moving, dx, dy);
      return;
    }
    if (tool === 'select' || tool === 'poly') return;

    const made = primitiveFrom(tool, from, to);
    if (made) {
      onDraw(made);
      onFinishTool();
    }
  };

  const finishPoly = () => {
    if (polyPoints.length >= 3) {
      onDraw({ k: 'poly', f: 'surface', c: 1, p: polyPoints.flatMap((p) => [p.x, p.y]) });
      onFinishTool();
    }
    setPolyPoints([]);
  };

  useEffect(() => {
    if (tool !== 'poly') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') finishPoly();
      if (e.key === 'Escape') setPolyPoints([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const preview = drag && !drag.moving && tool !== 'select' && tool !== 'poly'
    ? primitiveFrom(tool, drag.from, drag.to)
    : null;

  const nudged = (b: PrimitiveBox) =>
    drag?.moving && samePath(drag.moving, b.path)
      ? { ...b, x: b.x + (drag.to.x - drag.from.x), y: b.y + (drag.to.y - drag.from.y) }
      : b;

  return (
    <svg
      ref={svgRef}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      className="w-full h-full select-none"
      style={{ cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={() => tool === 'poly' && finishPoly()}
    >
      <defs>
        <pattern id="prop-grid" width="50" height="50" patternUnits="userSpaceOnUse">
          <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#2a2f36" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="#16181c" />
      <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="url(#prop-grid)" />

      {/* A prop stands on y=0 with negative y upwards, and reads at human scale
          or it reads at no scale at all. */}
      <g pointerEvents="none">
        <rect x={-FIGURE_HEIGHT * 0.15} y={-FIGURE_HEIGHT} width={FIGURE_HEIGHT * 0.3} height={FIGURE_HEIGHT}
          fill="#8fb3d9" opacity="0.05" />
        <line x1={box.x} y1={0} x2={box.x + box.width} y2={0} stroke="#4a5561" strokeWidth="2" />
        <line x1={0} y1={box.y} x2={0} y2={box.y + box.height} stroke="#4a5561" strokeWidth="1" strokeDasharray="6 6" />
        <text x={6} y={-6} fill="#5a6673" fontSize={Math.max(11, box.height / 45)} fontFamily="monospace">floor</text>
      </g>

      {render && (
        <g pointerEvents="none" dangerouslySetInnerHTML={{ __html: render.svg }} />
      )}

      {/* Interaction handles, if the prop declares any: without these a prop is
          scenery, so seeing them beside the art is the point. */}
      {render?.interaction && (
        <g pointerEvents="none">
          <rect
            x={render.interaction.bounds.x} y={render.interaction.bounds.y}
            width={render.interaction.bounds.width} height={render.interaction.bounds.height}
            fill="none" stroke="#c98b3f" strokeWidth="1.5" strokeDasharray="8 5" opacity="0.65"
          />
          {render.interaction.handles.map((h) => (
            <g key={h.id}>
              <circle cx={h.x} cy={h.y} r={h.radius} fill="#c98b3f" opacity="0.12" />
              <circle cx={h.x} cy={h.y} r={5} fill="#c98b3f" />
            </g>
          ))}
        </g>
      )}

      {(render?.boxes ?? []).map((raw) => {
        const b = nudged(raw);
        const isSelected = selected !== null && samePath(selected, b.path);
        return (
          <rect
            key={`${b.path.join('.')}-${b.copy.join('.')}`}
            x={b.x} y={b.y} width={b.width} height={b.height}
            fill="transparent"
            stroke={isSelected ? '#6fa8dc' : 'transparent'}
            strokeWidth={isSelected ? 2 : 0}
            strokeDasharray={b.copy.length ? '6 4' : undefined}
            pointerEvents="none"
          />
        );
      })}

      {preview && <PreviewShape primitive={preview} />}

      {tool === 'poly' && polyPoints.length > 0 && (
        <g pointerEvents="none">
          <polyline
            points={[...polyPoints, cursor ?? polyPoints[polyPoints.length - 1]!]
              .map((p) => `${p.x},${p.y}`).join(' ')}
            fill="rgba(111,168,220,0.15)" stroke="#6fa8dc" strokeWidth="2"
          />
          {polyPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4} fill="#6fa8dc" />)}
        </g>
      )}
    </svg>
  );
}

function PreviewShape({ primitive }: { primitive: Primitive }) {
  const style = { fill: 'rgba(111,168,220,0.2)', stroke: '#6fa8dc', strokeWidth: 2 };
  if (primitive.k === 'rect') {
    return <rect x={Number(primitive.x)} y={Number(primitive.y)} width={Number(primitive.w)} height={Number(primitive.h)} {...style} pointerEvents="none" />;
  }
  if (primitive.k === 'ellipse') {
    return <ellipse cx={Number(primitive.cx)} cy={Number(primitive.cy)} rx={Number(primitive.rx)} ry={Number(primitive.ry)} {...style} pointerEvents="none" />;
  }
  if (primitive.k === 'line') {
    return <line x1={Number(primitive.x1)} y1={Number(primitive.y1)} x2={Number(primitive.x2)} y2={Number(primitive.y2)} stroke="#6fa8dc" strokeWidth={3} pointerEvents="none" />;
  }
  return null;
}

// --- geometry -------------------------------------------------------------

const round = (v: number) => Math.round(v);

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Topmost first: later primitives draw over earlier ones, so they win a click. */
function topmostAt(boxes: PrimitiveBox[], point: Point): PrimitiveBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i]!;
    const pad = b.width < 8 || b.height < 8 ? 6 : 0;
    if (point.x >= b.x - pad && point.x <= b.x + b.width + pad
      && point.y >= b.y - pad && point.y <= b.y + b.height + pad) return b;
  }
  return null;
}

function primitiveFrom(tool: Tool, from: Point, to: Point): Primitive | null {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const w = Math.abs(to.x - from.x);
  const h = Math.abs(to.y - from.y);

  switch (tool) {
    case 'rect':
      return w < 2 || h < 2 ? null : { k: 'rect', f: 'surface', x, y, w, h };
    case 'ellipse':
      return w < 2 || h < 2 ? null : { k: 'ellipse', f: 'surface', cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
    case 'line':
      return w < 2 && h < 2 ? null : { k: 'line', f: 'line', x1: from.x, y1: from.y, x2: to.x, y2: to.y, sw: 3 };
    case 'text':
      return { k: 'text', f: 'line', x: from.x, y: from.y, size: Math.max(12, Math.abs(h) || 32), value: 'TEXT' };
    default:
      return null;
  }
}

/**
 * The visible window, in prop-local units.
 *
 * Always contains the origin and a person's height, so an empty canvas already
 * tells you how big a chair is, and grows to hold whatever has been drawn.
 */
function frameFor(render: PropRender | null, spanning: boolean): { x: number; y: number; width: number; height: number } {
  const e = render?.extent;
  let minX = -320;
  let maxX = 320;
  let minY = -FIGURE_HEIGHT - 80;
  let maxY = 80;

  if (e) {
    minX = Math.min(minX, e.x);
    maxX = Math.max(maxX, e.x + e.width);
    minY = Math.min(minY, e.y);
    maxY = Math.max(maxY, e.y + e.height);
  }
  // A spanning prop draws in set coordinates and covers the whole stage; framing
  // it around the origin would show one corner of a wall.
  if (spanning && !e) {
    minX = -420; maxX = 1700; minY = -220; maxY = 940;
  }

  const padX = (maxX - minX) * 0.08;
  const padY = (maxY - minY) * 0.08;
  return { x: minX - padX, y: minY - padY, width: (maxX - minX) + padX * 2, height: (maxY - minY) + padY * 2 };
}
