/**
 * Pure stage-interaction logic: controller vocabulary, hit-test id mapping,
 * FK/IK for rig parts, drag math, and snapping.
 *
 * Everything here is DOM-free and browser-free on purpose — the overlay stays
 * a thin event/paint layer while the decisions live where vitest can reach
 * them (same split as editor/lib.ts).
 */

import type { LayerName, PropInstance, SetDescriptor } from '../../types.ts';
import { MARK_X } from '../lib.ts';

// --- motion authoring contract (shared by overlay, panel and editor) --------

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
  /** A save is in flight: handles stay mounted but must not start commits. */
  busy: boolean;
  onionSkinFrames: number;
  path: { shape: 'linear' | 'smooth' | 'arc'; curvature: number };
  assist: { anticipation: number; overshoot: number; hold: number; recovery: number };
  ghostPath?: Array<[number, number] | { rot: number; x: number; y: number; scale: number }>;
  onCommit: (request: MotionAuthoringCommit) => void;
  /** Disarm one-shot path capture even when a pointer gesture is cancelled. */
  onCaptureEnd?: () => void;
  /** Stage picked a different controller of the current actor. */
  onPickPart: (controller: ControllerId) => void;
  /** Stage picked another actor (optionally a specific controller on it). */
  onPickActor: (actorId: string, controller?: ControllerId) => void;
}

// --- controllers -------------------------------------------------------------

/** The draggable things on a character. `body` is the stage-position root. */
export type ControllerId = 'body' | 'head' | 'torso' | 'wrist_L' | 'wrist_R';

export type IRTransform = [number, number, number, number];

export interface RuntimeRigData {
  anchor: [number, number];
  parts: Array<{ id: string; pivot: [number, number] }>;
}

/** Forearm length is derived from the upper arm, matching the render rigs. */
export const FORE_LENGTH_RATIO = 0.92;

export function controllerLabel(controller: ControllerId): string {
  switch (controller) {
    case 'body': return 'Body';
    case 'head': return 'Head';
    case 'torso': return 'Torso';
    case 'wrist_L': return 'Left arm';
    case 'wrist_R': return 'Right arm';
  }
}

/** Which controllers a rig supports (same gating as the Motion panel list). */
export function availableControllers(partIds: ReadonlySet<string>): ControllerId[] {
  const out: ControllerId[] = ['body'];
  if (partIds.has('head')) out.push('head');
  if (partIds.has('torso')) out.push('torso');
  if (partIds.has('arm_L_upper') && partIds.has('arm_L_fore')) out.push('wrist_L');
  if (partIds.has('arm_R_upper') && partIds.has('arm_R_fore')) out.push('wrist_R');
  return out;
}

/** The rig parts a controller drives (empty for the root). */
export function controllerPartIds(controller: ControllerId): string[] {
  if (controller === 'wrist_L') return ['arm_L_upper', 'arm_L_fore'];
  if (controller === 'wrist_R') return ['arm_R_upper', 'arm_R_fore'];
  if (controller === 'body') return [];
  return [controller];
}

/**
 * Map a rig part hit on the picture to the controller that drags it.
 * Anything without its own controller (legs, unknown parts) moves the body.
 */
export function controllerForPart(
  partId: string | null,
  available: ReadonlySet<ControllerId>,
): ControllerId {
  if (partId?.startsWith('arm_L_') && available.has('wrist_L')) return 'wrist_L';
  if (partId?.startsWith('arm_R_') && available.has('wrist_R')) return 'wrist_R';
  if (partId === 'head' && available.has('head')) return 'head';
  if (partId === 'torso' && available.has('torso')) return 'torso';
  return 'body';
}

// --- DOM id mapping (the page namespaces rig ids per actor) ------------------

export function actorIdFromDom(groupId: string): string | null {
  return groupId.startsWith('actor-') ? groupId.slice('actor-'.length) : null;
}

export function partIdFromDom(elementId: string, actorId: string): string | null {
  const prefix = `${actorId}__`;
  return elementId.startsWith(prefix) ? elementId.slice(prefix.length) : null;
}

// --- FK: where a controller sits, in rig-local space -------------------------

export function rotate(point: [number, number], degrees: number): [number, number] {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [point[0] * c - point[1] * s, point[0] * s + point[1] * c];
}

/**
 * Rig-local position of a controller given the frame's part transforms.
 * Returns null when the rig lacks the parts the controller needs.
 */
export function controllerLocalPoint(
  controller: ControllerId,
  rig: RuntimeRigData,
  parts: Record<string, IRTransform | undefined>,
): [number, number] | null {
  if (controller === 'body') return [rig.anchor[0], rig.anchor[1]];
  if (controller === 'wrist_L' || controller === 'wrist_R') {
    const side = controller === 'wrist_L' ? 'L' : 'R';
    const upper = rig.parts.find((part) => part.id === `arm_${side}_upper`);
    const fore = rig.parts.find((part) => part.id === `arm_${side}_fore`);
    if (!upper || !fore) return null;
    const upperT = parts[upper.id] ?? [0, 0, 0, 1];
    const foreT = parts[fore.id] ?? [0, 0, 0, 1];
    const rest: [number, number] = [fore.pivot[0] - upper.pivot[0], fore.pivot[1] - upper.pivot[1]];
    const first = rotate(rest, upperT[0]);
    const second = rotate([rest[0] * FORE_LENGTH_RATIO, rest[1] * FORE_LENGTH_RATIO], upperT[0] + foreT[0]);
    return [upper.pivot[0] + first[0] + second[0], upper.pivot[1] + first[1] + second[1]];
  }
  const part = rig.parts.find((item) => item.id === controller);
  if (!part) return null;
  const t = parts[part.id] ?? [0, 0, 0, 1];
  return [part.pivot[0] + t[1], part.pivot[1] + t[2]];
}

export interface ActorPlacement {
  x: number;
  y: number;
  scale: number;
  flip: boolean;
}

export function actorLocalToWorld(
  p: [number, number],
  actor: ActorPlacement,
  anchor: [number, number],
): [number, number] {
  const direction = actor.flip ? -1 : 1;
  return [
    actor.x + (p[0] - anchor[0]) * actor.scale * direction,
    actor.y + (p[1] - anchor[1]) * actor.scale,
  ];
}

export function worldToActorLocal(
  p: [number, number],
  actor: ActorPlacement,
  anchor: [number, number],
): [number, number] {
  const direction = actor.flip ? -1 : 1;
  return [
    (p[0] - actor.x) / (actor.scale * direction) + anchor[0],
    (p[1] - actor.y) / actor.scale + anchor[1],
  ];
}

// --- IK ----------------------------------------------------------------------

export function normalizedDegrees(value: number): number {
  let out = value;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

export function angularDistance(a: number, b: number): number {
  return Math.abs(normalizedDegrees(a - b));
}

export function nearestEquivalentDegrees(value: number, reference: number): number {
  let out = value;
  while (out - reference > 180) out -= 360;
  while (out - reference < -180) out += 360;
  return out;
}

/** Deterministic two-bone solve. Both elbow branches are tested; nearest current pose wins. */
export function solveArm(
  shoulder: [number, number],
  elbow: [number, number],
  target: [number, number],
  currentUpper: number,
  currentFore: number,
): { upper: number; fore: number; clampedTarget: [number, number]; reach: number } {
  const rest = [elbow[0] - shoulder[0], elbow[1] - shoulder[1]] as [number, number];
  const upperLength = Math.max(1, Math.hypot(rest[0], rest[1]));
  const foreLength = upperLength * FORE_LENGTH_RATIO;
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
      upper: nearestEquivalentDegrees(
        normalizedDegrees((upperRadians - restAngle) * 180 / Math.PI),
        currentUpper,
      ),
      fore: nearestEquivalentDegrees(
        normalizedDegrees(foreRadians * 180 / Math.PI),
        currentFore,
      ),
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

// --- drag math ----------------------------------------------------------------

/** Grab-offset-preserving drag: the grabbed point travels with the pointer. */
export function dragTargetTo(
  start: [number, number],
  startPointer: [number, number],
  pointer: [number, number],
): [number, number] {
  return [start[0] + (pointer[0] - startPointer[0]), start[1] + (pointer[1] - startPointer[1])];
}

/** Clamp to an area, rounded to 0.1 world units (parity with authored motion). */
export function clampToArea(p: [number, number], area: AnimationValidArea): [number, number] {
  return [
    Math.round(Math.max(area.x, Math.min(area.x + area.width, p[0])) * 10) / 10,
    Math.round(Math.max(area.y, Math.min(area.y + area.height, p[1])) * 10) / 10,
  ];
}

/** How far a part offset may stray from its pivot. */
export function partMaxReach(partId: string): number {
  return partId === 'head' ? 48 : 120;
}

/** Offset-preserving part drag in rig-local space, clamped to the part's reach. */
export function partOffsetTo(
  startOffset: [number, number],
  startLocal: [number, number],
  nowLocal: [number, number],
  maxReach: number,
): [number, number] {
  let dx = startOffset[0] + (nowLocal[0] - startLocal[0]);
  let dy = startOffset[1] + (nowLocal[1] - startLocal[1]);
  const distance = Math.hypot(dx, dy);
  if (distance > maxReach) {
    dx = (dx / distance) * maxReach;
    dy = (dy / distance) * maxReach;
  }
  return [Math.round(dx * 10) / 10, Math.round(dy * 10) / 10];
}

// --- snapping -------------------------------------------------------------------

export interface SnapCandidate {
  kind: 'mark' | 'seat' | 'edge';
  id: string;
  x?: number;
  y?: number;
}

/**
 * Snap targets for stage drags: marks (x only), prop/seat anchors (x+y) and
 * the walkable edges. Candidates outside the walkable area are dropped —
 * a snap the root clamp would immediately undo is worse than no snap.
 */
export function buildSnapCandidates(
  stageWidth: number,
  set: SetDescriptor | null,
  walkable: AnimationValidArea | null,
): SnapCandidate[] {
  const inArea = (x: number | undefined, y: number | undefined): boolean => {
    if (!walkable) return true;
    if (x !== undefined && (x < walkable.x || x > walkable.x + walkable.width)) return false;
    if (y !== undefined && (y < walkable.y || y > walkable.y + walkable.height)) return false;
    return true;
  };
  const out: SnapCandidate[] = [];
  for (const [mark, fraction] of Object.entries(MARK_X)) {
    const x = fraction * stageWidth;
    if (inArea(x, undefined)) out.push({ kind: 'mark', id: mark, x });
  }
  if (set) {
    for (const target of listPropTargets(set)) {
      if (inArea(target.x, target.y)) {
        out.push({ kind: 'seat', id: target.id, x: target.x, y: target.y });
      }
    }
  }
  if (walkable) {
    out.push({ kind: 'edge', id: 'walkable-left', x: walkable.x });
    out.push({ kind: 'edge', id: 'walkable-right', x: walkable.x + walkable.width });
    out.push({ kind: 'edge', id: 'walkable-top', y: walkable.y });
    out.push({ kind: 'edge', id: 'walkable-bottom', y: walkable.y + walkable.height });
  }
  return out;
}

/**
 * Snap a point to the nearest candidates within the threshold.
 * A two-axis candidate (seat) wins whole; otherwise the best x-only and
 * y-only candidates apply independently. First-listed wins ties.
 */
export function snapPoint(
  p: [number, number],
  candidates: readonly SnapCandidate[],
  thresholdWorld: number,
): { point: [number, number]; hits: SnapCandidate[] } {
  let best2d: { candidate: SnapCandidate; distance: number } | null = null;
  let bestX: { candidate: SnapCandidate; distance: number } | null = null;
  let bestY: { candidate: SnapCandidate; distance: number } | null = null;
  for (const candidate of candidates) {
    const hasX = candidate.x !== undefined;
    const hasY = candidate.y !== undefined;
    if (hasX && hasY) {
      const distance = Math.hypot(p[0] - candidate.x!, p[1] - candidate.y!);
      if (distance <= thresholdWorld && (!best2d || distance < best2d.distance)) {
        best2d = { candidate, distance };
      }
    } else if (hasX) {
      const distance = Math.abs(p[0] - candidate.x!);
      if (distance <= thresholdWorld && (!bestX || distance < bestX.distance)) {
        bestX = { candidate, distance };
      }
    } else if (hasY) {
      const distance = Math.abs(p[1] - candidate.y!);
      if (distance <= thresholdWorld && (!bestY || distance < bestY.distance)) {
        bestY = { candidate, distance };
      }
    }
  }
  const axisBest = Math.min(bestX?.distance ?? Infinity, bestY?.distance ?? Infinity);
  if (best2d && best2d.distance <= axisBest) {
    return { point: [best2d.candidate.x!, best2d.candidate.y!], hits: [best2d.candidate] };
  }
  const hits: SnapCandidate[] = [];
  const point: [number, number] = [p[0], p[1]];
  if (bestX) {
    point[0] = bestX.candidate.x!;
    hits.push(bestX.candidate);
  }
  if (bestY) {
    point[1] = bestY.candidate.y!;
    hits.push(bestY.candidate);
  }
  return { point, hits };
}

// --- set props -------------------------------------------------------------------

function safeIdPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'prop';
}

/** Mirrors the renderer's identity rule (src/sets/interaction.ts) exactly. */
export function propInstanceId(instance: PropInstance, layer: LayerName, index: number): string {
  return instance.id ?? `auto:${layer}:${index}:${safeIdPart(instance.prop)}`;
}

export interface PropTarget {
  id: string;
  layer: LayerName;
  index: number;
  prop: string;
  x: number;
  y: number;
}

/**
 * Every draggable set instance. Instances without an authored x/y are either
 * spanning (walls, floors) or self-placing — those are not stage-draggable.
 */
export function listPropTargets(set: SetDescriptor): PropTarget[] {
  const out: PropTarget[] = [];
  for (const layer of ['back', 'mid', 'fore'] as LayerName[]) {
    set.layers[layer].forEach((instance, index) => {
      if (instance.x === undefined || instance.y === undefined) return;
      out.push({
        id: propInstanceId(instance, layer, index),
        layer,
        index,
        prop: instance.prop,
        x: instance.x,
        y: instance.y,
      });
    });
  }
  return out;
}
