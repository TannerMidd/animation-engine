import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  reducePuppeteeringSamples,
  type PuppeteeringSample,
} from '../../../src/animation/recording.ts';

type IRTransform = [number, number, number, number];
interface RuntimeScene {
  cast: Array<{ id: string; rig: string }>;
  frames: Array<{
    camera: { x: number; y: number; w: number; h: number };
    actors: Record<string, {
      visible: boolean; x: number; y: number; scale: number; flip: boolean;
      parts: Record<string, IRTransform>;
    }>;
  }>;
}
interface RuntimeRig {
  anchor: [number, number];
  parts: Array<{ id: string; parent?: string | null; pivot: [number, number] }>;
}
interface RuntimeWindow extends Window {
  __IR?: RuntimeScene;
  __RIGS?: Record<string, RuntimeRig>;
}

export interface MotionAuthoringRequest {
  actorId: string;
  channel: 'root.position' | 'part.transform';
  partId?: string;
  startMs: number;
  endMs: number;
  from: [number, number] | { rot: number; x: number; y: number; scale: number };
  to: [number, number] | { rot: number; x: number; y: number; scale: number };
  waypoints?: Array<{
    at: number;
    value: [number, number] | { rot: number; x: number; y: number; scale: number };
  }>;
  path?: { shape: 'linear' | 'smooth' | 'arc'; curvature: number };
  assist?: { anticipation: number; overshoot: number; hold: number; recovery: number };
  source?: 'drag' | 'puppeteering';
}

export type MotionAuthoringCommit = MotionAuthoringRequest | MotionAuthoringRequest[];

export interface AnimationValidArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnimationEditTarget {
  actorId: string;
  partId: string | null;
  startMs: number;
  durationFrames: number;
  fps: number;
  recording: boolean;
  onionSkinFrames: number;
  path: { shape: 'linear' | 'smooth' | 'arc'; curvature: number };
  assist: { anticipation: number; overshoot: number; hold: number; recovery: number };
  ghostPath?: Array<[number, number] | { rot: number; x: number; y: number; scale: number }>;
  onCommit: (request: MotionAuthoringCommit) => void;
}

function rotate(point: [number, number], degrees: number): [number, number] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [point[0] * c - point[1] * s, point[0] * s + point[1] * c];
}

function normalizedDegrees(value: number): number {
  let out = value;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

function angularDistance(a: number, b: number): number {
  return Math.abs(normalizedDegrees(a - b));
}

/** Deterministic two-bone solve. Both elbow branches are tested; nearest current pose wins. */
function solveArm(
  shoulder: [number, number],
  elbow: [number, number],
  target: [number, number],
  currentUpper: number,
  currentFore: number,
): { upper: number; fore: number; clampedTarget: [number, number]; reach: number } {
  const rest = [elbow[0] - shoulder[0], elbow[1] - shoulder[1]] as [number, number];
  const upperLength = Math.max(1, Math.hypot(rest[0], rest[1]));
  const foreLength = upperLength * 0.92;
  const restAngle = Math.atan2(rest[1], rest[0]);
  let x = target[0] - shoulder[0];
  let y = target[1] - shoulder[1];
  let distance = Math.hypot(x, y);
  const minReach = Math.abs(upperLength - foreLength) + 1;
  const maxReach = upperLength + foreLength - 1;
  const wanted = Math.max(minReach, Math.min(maxReach, distance));
  if (distance < 0.001) {
    x = 0;
    y = wanted;
    distance = wanted;
  } else if (Math.abs(wanted - distance) > 0.001) {
    x *= wanted / distance;
    y *= wanted / distance;
    distance = wanted;
  }

  const cosine = Math.max(-1, Math.min(1,
    (distance * distance - upperLength * upperLength - foreLength * foreLength) /
    (2 * upperLength * foreLength)));
  const bend = Math.acos(cosine);
  const base = Math.atan2(y, x);
  const candidates = [bend, -bend].map((foreRadians) => {
    const upperRadians = base - Math.atan2(
      foreLength * Math.sin(foreRadians),
      upperLength + foreLength * Math.cos(foreRadians),
    );
    return {
      upper: normalizedDegrees((upperRadians - restAngle) * 180 / Math.PI),
      fore: normalizedDegrees(foreRadians * 180 / Math.PI),
    };
  });
  candidates.sort((a, b) =>
    angularDistance(a.upper, currentUpper) + angularDistance(a.fore, currentFore) -
    angularDistance(b.upper, currentUpper) - angularDistance(b.fore, currentFore));
  return {
    ...candidates[0]!,
    clampedTarget: [shoulder[0] + x, shoulder[1] + y],
    reach: maxReach,
  };
}

/** Direct-manipulation handles layered over the immutable renderer iframe. */
export function AnimationOverlay({
  iframe, frame, target, validArea,
}: {
  iframe: React.RefObject<HTMLIFrameElement | null>;
  frame: number;
  target: AnimationEditTarget;
  /** Set-authored actor-root blocking bounds. Parts still use rig reach. */
  validArea?: AnimationValidArea | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [drag, setDrag] = useState<{
    clientX: number;
    clientY: number;
    startedAt: number;
    samples: Array<{ clientX: number; clientY: number; elapsedMs: number }>;
  } | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const runtime = iframe.current?.contentWindow as RuntimeWindow | null | undefined;
  const scene = runtime?.__IR;
  const state = scene?.frames[Math.max(0, Math.min(frame, (scene?.frames.length ?? 1) - 1))];
  const actor = state?.actors[target.actorId];
  const member = scene?.cast.find((item) => item.id === target.actorId);
  const rig = member ? runtime?.__RIGS?.[member.rig] : undefined;
  const wristSide = target.partId?.match(/^wrist_([LR])$/)?.[1] as 'L' | 'R' | undefined;
  const armUpper = wristSide ? rig?.parts.find((item) => item.id === `arm_${wristSide}_upper`) : undefined;
  const armFore = wristSide ? rig?.parts.find((item) => item.id === `arm_${wristSide}_fore`) : undefined;
  const part = target.partId && !wristSide ? rig?.parts.find((item) => item.id === target.partId) : undefined;
  const transform = part && actor ? (actor.parts[part.id] ?? [0, 0, 0, 1] as IRTransform) : null;
  const upperTransform = armUpper && actor ? (actor.parts[armUpper.id] ?? [0, 0, 0, 1] as IRTransform) : null;
  const foreTransform = armFore && actor ? (actor.parts[armFore.id] ?? [0, 0, 0, 1] as IRTransform) : null;

  const scale = Math.min(size.width / 1280, size.height / 720);
  const originX = (size.width - 1280 * scale) / 2;
  const originY = (size.height - 720 * scale) / 2;
  const camera = state?.camera;
  const rootArea = validArea ?? { x: 0, y: 0, width: 1280, height: 720 };
  const clampRoot = useCallback((point: [number, number]): [number, number] => [
    Math.round(Math.max(rootArea.x, Math.min(rootArea.x + rootArea.width, point[0])) * 10) / 10,
    Math.round(Math.max(rootArea.y, Math.min(rootArea.y + rootArea.height, point[1])) * 10) / 10,
  ], [rootArea.x, rootArea.y, rootArea.width, rootArea.height]);

  const worldPoint = (() => {
    if (!actor) return null;
    if (!rig) return [actor.x, actor.y] as [number, number];
    const direction = actor.flip ? -1 : 1;
    if (wristSide && armUpper && armFore && upperTransform && foreTransform) {
      const shoulder = armUpper.pivot;
      const rest = [armFore.pivot[0] - shoulder[0], armFore.pivot[1] - shoulder[1]] as [number, number];
      const first = rotate(rest, upperTransform[0]);
      const second = rotate([rest[0] * 0.92, rest[1] * 0.92], upperTransform[0] + foreTransform[0]);
      const localX = shoulder[0] + first[0] + second[0];
      const localY = shoulder[1] + first[1] + second[1];
      return [
        actor.x + (localX - rig.anchor[0]) * actor.scale * direction,
        actor.y + (localY - rig.anchor[1]) * actor.scale,
      ] as [number, number];
    }
    if (!part || !transform) return [actor.x, actor.y] as [number, number];
    const localX = part.pivot[0] + transform[1];
    const localY = part.pivot[1] + transform[2];
    return [
      actor.x + (localX - rig.anchor[0]) * actor.scale * direction,
      actor.y + (localY - rig.anchor[1]) * actor.scale,
    ] as [number, number];
  })();

  const screenPoint = worldPoint && camera ? [
    originX + ((worldPoint[0] - camera.x) / camera.w) * 1280 * scale,
    originY + ((worldPoint[1] - camera.y) / camera.h) * 720 * scale,
  ] as [number, number] : null;

  const reachCenterWorld = actor && rig && wristSide && armUpper ? [
    actor.x + (armUpper.pivot[0] - rig.anchor[0]) * actor.scale * (actor.flip ? -1 : 1),
    actor.y + (armUpper.pivot[1] - rig.anchor[1]) * actor.scale,
  ] as [number, number] : worldPoint;
  const reachCenterScreen = reachCenterWorld && camera ? [
    originX + ((reachCenterWorld[0] - camera.x) / camera.w) * 1280 * scale,
    originY + ((reachCenterWorld[1] - camera.y) / camera.h) * 720 * scale,
  ] as [number, number] : screenPoint;

  const clientToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const el = host.current;
    if (!el || !camera) return null;
    const box = el.getBoundingClientRect();
    const sx = (clientX - box.left - originX) / scale;
    const sy = (clientY - box.top - originY) / scale;
    return [camera.x + (sx / 1280) * camera.w, camera.y + (sy / 720) * camera.h];
  }, [camera, originX, originY, scale]);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => setDrag((current) => current ? {
      ...current,
      clientX: event.clientX,
      clientY: event.clientY,
      samples: target.recording
        ? [...current.samples, {
            clientX: event.clientX,
            clientY: event.clientY,
            elapsedMs: Math.max(0, event.timeStamp - current.startedAt),
          }]
        : current.samples,
    } : null);
    const up = (event: PointerEvent) => {
      const world = clientToWorld(event.clientX, event.clientY);
      setDrag(null);
      if (!world || !actor) return;

      const startMs = target.startMs;
      const captured = target.recording
        ? [...drag.samples, {
            clientX: event.clientX,
            clientY: event.clientY,
            elapsedMs: Math.max(0, event.timeStamp - drag.startedAt),
          }]
        : [];
      const capturedWorld = captured.flatMap((sample) => {
        const point = clientToWorld(sample.clientX, sample.clientY);
        if (!point) return [];
        return [{
          frame: Math.max(1, Math.min(target.fps * 10, Math.round((sample.elapsedMs / 1000) * target.fps))),
          world: point,
        }];
      });
      const recordedRequest = <T extends MotionAuthoringRequest['from']>(
        request: Omit<MotionAuthoringRequest, 'from' | 'to' | 'endMs'>,
        from: T,
        recorded: Array<{ frame: number; value: T }>,
      ): MotionAuthoringRequest => {
        const reduced = reducePuppeteeringSamples(
          [{ frame: 0, value: from }, ...recorded] as PuppeteeringSample[],
          { smoothingPasses: 1, tolerance: Array.isArray(from) ? 1.5 : 0.75 },
        );
        const lastFrame = Math.max(1, reduced[reduced.length - 1]!.frame);
        return {
          ...request,
          from,
          to: reduced[reduced.length - 1]!.value as T,
          endMs: startMs + (lastFrame / target.fps) * 1000,
          waypoints: reduced.slice(1, -1).map((sample) => ({
            at: sample.frame / lastFrame,
            value: sample.value as T,
          })),
          path: target.path,
          assist: target.assist,
          source: 'puppeteering',
        };
      };
      const endMs = startMs + (target.durationFrames / target.fps) * 1000;
      if (!rig || (!part && !wristSide)) {
        // Root blocking remains on the set-authored floor. Entrances/exits use
        // explicit stage actions rather than an accidental off-area drag.
        const to = clampRoot(world);
        if (target.recording && capturedWorld.length) {
          target.onCommit(recordedRequest(
            { actorId: target.actorId, channel: 'root.position', startMs },
            [actor.x, actor.y] as [number, number],
            capturedWorld.map((sample) => ({ frame: sample.frame, value: clampRoot(sample.world) })),
          ));
          return;
        }
        target.onCommit({
          actorId: target.actorId,
          channel: 'root.position',
          startMs,
          endMs,
          from: [actor.x, actor.y],
          to,
          path: target.path,
          assist: target.assist,
          source: 'drag',
        });
        return;
      }

      if (wristSide && armUpper && armFore && upperTransform && foreTransform) {
        const direction = actor.flip ? -1 : 1;
        const solve = (point: [number, number]) => {
          const localTarget: [number, number] = [
            (point[0] - actor.x) / (actor.scale * direction) + rig.anchor[0],
            (point[1] - actor.y) / actor.scale + rig.anchor[1],
          ];
          return solveArm(
            armUpper.pivot,
            armFore.pivot,
            localTarget,
            upperTransform[0],
            foreTransform[0],
          );
        };
        const solved = solve(world);
        const upperFrom = { rot: upperTransform[0], x: upperTransform[1], y: upperTransform[2], scale: upperTransform[3] };
        const foreFrom = { rot: foreTransform[0], x: foreTransform[1], y: foreTransform[2], scale: foreTransform[3] };
        if (target.recording && capturedWorld.length) {
          const recorded = capturedWorld.map((sample) => ({ ...sample, solved: solve(sample.world) }));
          target.onCommit([
            recordedRequest(
              { actorId: target.actorId, channel: 'part.transform', partId: armUpper.id, startMs },
              upperFrom,
              recorded.map((sample) => ({
                frame: sample.frame,
                value: { ...upperFrom, rot: Math.round(sample.solved.upper * 10) / 10 },
              })),
            ),
            recordedRequest(
              { actorId: target.actorId, channel: 'part.transform', partId: armFore.id, startMs },
              foreFrom,
              recorded.map((sample) => ({
                frame: sample.frame,
                value: { ...foreFrom, rot: Math.round(sample.solved.fore * 10) / 10 },
              })),
            ),
          ]);
          return;
        }
        target.onCommit([
          {
            actorId: target.actorId,
            channel: 'part.transform',
            partId: armUpper.id,
            startMs,
            endMs,
            from: upperFrom,
            to: { ...upperFrom, rot: Math.round(solved.upper * 10) / 10 },
            path: target.path,
            assist: target.assist,
            source: 'drag',
          },
          {
            actorId: target.actorId,
            channel: 'part.transform',
            partId: armFore.id,
            startMs,
            endMs,
            from: foreFrom,
            to: { ...foreFrom, rot: Math.round(solved.fore * 10) / 10 },
            path: target.path,
            assist: target.assist,
            source: 'drag',
          },
        ]);
        return;
      }

      // A wrist target whose arm parts are missing from the rig has nothing
      // to solve against; bail rather than committing a malformed segment.
      if (!part || !transform) return;

      const direction = actor.flip ? -1 : 1;
      const from = { rot: transform[0], x: transform[1], y: transform[2], scale: transform[3] };
      const valueAt = (point: [number, number]) => {
        const localTargetX = (point[0] - actor.x) / (actor.scale * direction) + rig.anchor[0];
        const localTargetY = (point[1] - actor.y) / actor.scale + rig.anchor[1];
        let dx = localTargetX - part.pivot[0];
        let dy = localTargetY - part.pivot[1];
        const maxReach = part.id === 'head' ? 48 : 120;
        const distance = Math.hypot(dx, dy);
        if (distance > maxReach) {
          dx = (dx / distance) * maxReach;
          dy = (dy / distance) * maxReach;
        }
        return {
          ...from,
          x: Math.round(dx * 10) / 10,
          y: Math.round(dy * 10) / 10,
        };
      };
      const to = valueAt(world);
      if (target.recording && capturedWorld.length) {
        target.onCommit(recordedRequest(
          { actorId: target.actorId, channel: 'part.transform', partId: part.id, startMs },
          from,
          capturedWorld.map((sample) => ({ frame: sample.frame, value: valueAt(sample.world) })),
        ));
        return;
      }
      target.onCommit({
        actorId: target.actorId,
        channel: 'part.transform',
        partId: part.id,
        startMs,
        endMs,
        from,
        to,
        path: target.path,
        assist: target.assist,
        source: 'drag',
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [
    drag, actor, part, rig, transform, wristSide, armUpper, armFore, upperTransform, foreTransform,
    clientToWorld, clampRoot, target,
  ]);

  const rawDragWorld = drag ? clientToWorld(drag.clientX, drag.clientY) : null;
  const validatedDrag = (() => {
    if (!rawDragWorld || !actor) return { world: rawDragWorld, clamped: false };
    if (wristSide && rig && armUpper && armFore && upperTransform && foreTransform) {
      const direction = actor.flip ? -1 : 1;
      const local: [number, number] = [
        (rawDragWorld[0] - actor.x) / (actor.scale * direction) + rig.anchor[0],
        (rawDragWorld[1] - actor.y) / actor.scale + rig.anchor[1],
      ];
      const solved = solveArm(armUpper.pivot, armFore.pivot, local, upperTransform[0], foreTransform[0]);
      const world: [number, number] = [
        actor.x + (solved.clampedTarget[0] - rig.anchor[0]) * actor.scale * direction,
        actor.y + (solved.clampedTarget[1] - rig.anchor[1]) * actor.scale,
      ];
      return { world, clamped: Math.hypot(world[0] - rawDragWorld[0], world[1] - rawDragWorld[1]) > 0.5 };
    }
    if (!part) {
      const world = clampRoot(rawDragWorld);
      return { world, clamped: world[0] !== rawDragWorld[0] || world[1] !== rawDragWorld[1] };
    }
    return { world: rawDragWorld, clamped: false };
  })();
  const dragScreen = validatedDrag.world && camera ? [
    originX + ((validatedDrag.world[0] - camera.x) / camera.w) * 1280 * scale,
    originY + ((validatedDrag.world[1] - camera.y) / camera.h) * 720 * scale,
  ] as [number, number] : null;

  const worldToScreen = (point: [number, number]): [number, number] | null => camera ? [
    originX + ((point[0] - camera.x) / camera.w) * 1280 * scale,
    originY + ((point[1] - camera.y) / camera.h) * 720 * scale,
  ] : null;
  const controllerWorldAt = (index: number): [number, number] | null => {
    const actorAt = scene?.frames[Math.max(0, Math.min(index, (scene?.frames.length ?? 1) - 1))]
      ?.actors[target.actorId];
    if (!actorAt) return null;
    if (!rig) return [actorAt.x, actorAt.y];
    const direction = actorAt.flip ? -1 : 1;
    if (wristSide && armUpper && armFore) {
      const upper = actorAt.parts[armUpper.id] ?? [0, 0, 0, 1] as IRTransform;
      const fore = actorAt.parts[armFore.id] ?? [0, 0, 0, 1] as IRTransform;
      const rest = [
        armFore.pivot[0] - armUpper.pivot[0],
        armFore.pivot[1] - armUpper.pivot[1],
      ] as [number, number];
      const first = rotate(rest, upper[0]);
      const second = rotate([rest[0] * 0.92, rest[1] * 0.92], upper[0] + fore[0]);
      return [
        actorAt.x + (armUpper.pivot[0] + first[0] + second[0] - rig.anchor[0]) * actorAt.scale * direction,
        actorAt.y + (armUpper.pivot[1] + first[1] + second[1] - rig.anchor[1]) * actorAt.scale,
      ];
    }
    if (!part) return [actorAt.x, actorAt.y];
    const authored = actorAt.parts[part.id] ?? [0, 0, 0, 1] as IRTransform;
    return [
      actorAt.x + (part.pivot[0] + authored[1] - rig.anchor[0]) * actorAt.scale * direction,
      actorAt.y + (part.pivot[1] + authored[2] - rig.anchor[1]) * actorAt.scale,
    ];
  };
  const onionPoints = target.onionSkinFrames > 0
    ? [frame - target.onionSkinFrames, frame + target.onionSkinFrames]
      .map(controllerWorldAt)
      .flatMap((point) => point ? [worldToScreen(point)] : [])
      .filter((point): point is [number, number] => point !== null)
    : [];
  const ghostPoints = (target.ghostPath ?? []).flatMap((value) => {
    if (Array.isArray(value)) return [worldToScreen(value)];
    if (!actor || !rig || !part) return [];
    const direction = actor.flip ? -1 : 1;
    return [worldToScreen([
      actor.x + (part.pivot[0] + value.x - rig.anchor[0]) * actor.scale * direction,
      actor.y + (part.pivot[1] + value.y - rig.anchor[1]) * actor.scale,
    ])];
  }).filter((point): point is [number, number] => point !== null);
  const recordedPoints = drag?.samples.flatMap((sample) => {
    const point = clientToWorld(sample.clientX, sample.clientY);
    const screen = point ? worldToScreen(point) : null;
    return screen ? [screen] : [];
  }) ?? [];

  return (
    <div ref={host} className="absolute inset-0 z-20 pointer-events-none">
      {screenPoint && actor?.visible && (
        <>
          {(ghostPoints.length > 1 || recordedPoints.length > 1) && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              {ghostPoints.length > 1 && (
                <polyline
                  points={ghostPoints.map((point) => point.join(',')).join(' ')}
                  fill="none" stroke="#73a6c7" strokeWidth="2" strokeDasharray="4 5" opacity="0.65"
                />
              )}
              {recordedPoints.length > 1 && (
                <polyline
                  points={recordedPoints.map((point) => point.join(',')).join(' ')}
                  fill="none" stroke="#c8834a" strokeWidth="2.5" opacity="0.8"
                />
              )}
            </svg>
          )}
          {onionPoints.map((point, index) => (
            <span
              key={`${point[0]}:${point[1]}:${index}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 border-info/60 bg-info/10 pointer-events-none"
              style={{ left: point[0], top: point[1], opacity: index === 0 ? 0.45 : 0.7 }}
              title={index === 0 ? 'Previous onion skin' : 'Next onion skin'}
            />
          ))}
          {(part || wristSide) && (
            <div
              className="absolute rounded-full border border-accent/50 pointer-events-none"
              style={{
                left: reachCenterScreen?.[0] ?? screenPoint[0], top: reachCenterScreen?.[1] ?? screenPoint[1],
                width: (wristSide && armUpper && armFore
                  ? Math.hypot(armFore.pivot[0] - armUpper.pivot[0], armFore.pivot[1] - armUpper.pivot[1]) * 1.92 * 2
                  : part?.id === 'head' ? 96 : 240) * actor.scale * (1280 * scale / (camera?.w ?? 1280)),
                height: (wristSide && armUpper && armFore
                  ? Math.hypot(armFore.pivot[0] - armUpper.pivot[0], armFore.pivot[1] - armUpper.pivot[1]) * 1.92 * 2
                  : part?.id === 'head' ? 96 : 240) * actor.scale * (720 * scale / (camera?.h ?? 720)),
                transform: 'translate(-50%, -50%)',
              }}
            />
          )}
          {dragScreen && (
            <>
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <line x1={screenPoint[0]} y1={screenPoint[1]} x2={dragScreen[0]} y2={dragScreen[1]} stroke="#c8834a" strokeWidth="2" strokeDasharray="5 4" />
              </svg>
              {validatedDrag.clamped && (
                <span
                  className="absolute -translate-x-1/2 rounded bg-bad/90 text-white text-[10px] px-1.5 py-0.5 pointer-events-none"
                  style={{ left: dragScreen[0], top: dragScreen[1] + 10 }}
                >
                  {part || wristSide ? 'clamped to valid reach' : 'clamped to walkable area'}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              setDrag({
                clientX: event.clientX,
                clientY: event.clientY,
                startedAt: event.timeStamp,
                samples: target.recording ? [{
                  clientX: event.clientX,
                  clientY: event.clientY,
                  elapsedMs: 0,
                }] : [],
              });
            }}
            style={{ left: screenPoint[0], top: screenPoint[1] }}
            title={`Drag ${target.actorId} ${wristSide ? `wrist ${wristSide}` : part?.id ?? 'root'} to author ${target.durationFrames} frames of motion`}
            className="absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-accent bg-accent/30 hover:bg-accent/60 cursor-grab active:cursor-grabbing pointer-events-auto"
          >
            <span className="absolute left-1/2 -translate-x-1/2 top-5 whitespace-nowrap rounded bg-black/75 text-white text-[10px] px-1">
              {wristSide ? `wrist ${wristSide}` : part?.id ?? `${target.actorId} root`}
            </span>
            {target.recording && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-bad text-white text-[9px] px-1">REC</span>
            )}
          </button>
        </>
      )}
    </div>
  );
}
