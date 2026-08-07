import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  reducePuppeteeringSamples,
  type PuppeteeringSample,
} from '../../../src/animation/recording.ts';
import type { OpenMenu } from '../editor/ContextMenu.tsx';
import {
  clientToStage,
  clientToWorld,
  layerParallaxOffset,
  worldPerCssPx,
  worldToOverlay,
  type CameraRect,
  type FrameGeom,
} from '../editor/stage/coords.ts';
import {
  actorIdFromDom,
  actorLocalToWorld,
  availableControllers,
  clampToArea,
  controllerForPart,
  controllerLabel,
  controllerLocalPoint,
  dragTargetTo,
  partIdFromDom,
  partMaxReach,
  partOffsetTo,
  snapPoint,
  solveArm,
  worldToActorLocal,
  FORE_LENGTH_RATIO,
  type AnimationEditTarget,
  type AnimationValidArea,
  type ControllerId,
  type IRTransform,
  type MotionAuthoringRequest,
  type PropTarget,
  type RuntimeRigData,
  type SnapCandidate,
} from '../editor/stage/interaction.ts';

// The authoring contract moved to the pure interaction module; re-export so
// existing imports keep working.
export type {
  AnimationEditTarget,
  AnimationValidArea,
  MotionAuthoringCommit,
  MotionAuthoringRequest,
} from '../editor/stage/interaction.ts';

interface RuntimeScene {
  cast: Array<{ id: string; rig: string }>;
  frames: Array<{
    camera: CameraRect;
    actors: Record<string, {
      visible: boolean; x: number; y: number; scale: number; flip: boolean;
      parts: Record<string, IRTransform>;
    }>;
  }>;
}
interface RuntimeWindow extends Window {
  __IR?: RuntimeScene;
  __RIGS?: Record<string, RuntimeRigData>;
  __seek?: (frame: number) => void;
  __previewParts?: (actorId: string, transforms: Record<string, IRTransform>) => boolean;
  __previewRoot?: (actorId: string, x: number, y: number) => boolean;
  __previewProp?: (id: string, dx: number, dy: number) => boolean;
}

/** A draggable set instance, decorated with who is seated at it. */
export interface StagePropTarget extends PropTarget {
  seatedBy?: string;
}

interface DragSample {
  clientX: number;
  clientY: number;
  elapsedMs: number;
  frame: number;
}

interface ActorDragState {
  kind: 'actor';
  pointerId: number;
  controller: ControllerId;
  startMs: number;
  startClient: [number, number];
  startWorld: [number, number];
  startActorPos: [number, number];
  /** Pointer and controller in rig-local space at grab (part controllers). */
  startLocal: [number, number] | null;
  startControllerLocal: [number, number] | null;
  /** Authored part offset at grab (head/torso). */
  startOffset: [number, number];
  /** Authored arm angles at grab (wrists). */
  startPose: { upper: number; fore: number } | null;
  clientX: number;
  clientY: number;
  startedAt: number;
  samples: DragSample[];
}

interface PropDragState {
  kind: 'prop';
  pointerId: number;
  prop: StagePropTarget;
  startClient: [number, number];
  startWorld: [number, number];
  startPos: [number, number];
  clientX: number;
  clientY: number;
  startedAt: number;
}

type DragState = ActorDragState | PropDragState;

type Hit =
  | { kind: 'actor'; controller: ControllerId }
  | { kind: 'other-actor'; actorId: string; controller: ControllerId }
  | { kind: 'prop'; prop: StagePropTarget };

type Hover =
  | { kind: 'actor'; controller: ControllerId }
  | { kind: 'other-actor'; actorId: string; at: [number, number] }
  | { kind: 'prop'; id: string };

const HANDLE_GRAB_RADIUS_PX = 24;
const CLICK_SLOP_PX = 3;

/**
 * Direct manipulation over the immutable renderer iframe.
 *
 * Mounted inside the frame box, so `inset-0` is exactly the frame at any zoom
 * and `getBoundingClientRect` gives the true frame origin. The root is the hit
 * surface: pointerdown anywhere hit-tests the preview's SVG (same-origin) to
 * find the character part or prop under the cursor; the handles are shortcuts
 * to the same gestures. Everything the surface covers is inert chrome.
 */
export function AnimationOverlay({
  iframe, frame, target, validArea, scale, width, height,
  showOnion, showPath, showPropHandles, snapEnabled, snapCandidates, propTargets,
  onCommitProp, onInteractStart, onContextMenu,
}: {
  iframe: React.RefObject<HTMLIFrameElement | null>;
  frame: number;
  target: AnimationEditTarget;
  /** Set-authored actor-root blocking bounds. Parts still use rig reach. */
  validArea?: AnimationValidArea | null;
  scale: number;
  width: number;
  height: number;
  showOnion: boolean;
  showPath: boolean;
  showPropHandles: boolean;
  snapEnabled: boolean;
  snapCandidates: readonly SnapCandidate[];
  propTargets: readonly StagePropTarget[];
  onCommitProp?: (prop: StagePropTarget, to: [number, number]) => void;
  onInteractStart?: () => void;
  /** Right-click, resolved against whatever the hit test finds under the pointer. */
  onContextMenu?: OpenMenu;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragCapture = useRef<DragState | null>(null);
  const dragPaintFrame = useRef<number | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const armPreviewPose = useRef<{ upper: number; fore: number } | null>(null);
  const previewApplied = useRef<null | { kind: 'actor' } | { kind: 'prop'; id: string }>(null);

  const geom: FrameGeom = { width, height, scale };
  const runtime = iframe.current?.contentWindow as RuntimeWindow | null | undefined;
  const scene = runtime?.__IR;
  const frameState = scene?.frames[Math.max(0, Math.min(frame, (scene?.frames.length ?? 1) - 1))];
  const camera = frameState?.camera;
  const actor = frameState?.actors[target.actorId];
  const member = scene?.cast.find((item) => item.id === target.actorId);
  const rig = member ? runtime?.__RIGS?.[member.rig] : undefined;
  const rigPartIds = new Set((rig?.parts ?? []).map((part) => part.id));
  const controllers = rig ? availableControllers(rigPartIds) : (['body'] as ControllerId[]);
  const requestedController = (target.partId ?? 'body') as ControllerId;
  const activeController: ControllerId = controllers.includes(requestedController) ? requestedController : 'body';

  const rootArea = useMemo(
    () => validArea ?? { x: 0, y: 0, width, height },
    [validArea, width, height],
  );
  const stageArea: AnimationValidArea = { x: 0, y: 0, width, height };
  const snapThreshold = camera ? 12 * worldPerCssPx(camera, geom) : 0;

  const controllerWorldAt = useCallback((controller: ControllerId, frameIndex: number): [number, number] | null => {
    const index = Math.max(0, Math.min(frameIndex, (scene?.frames.length ?? 1) - 1));
    const state = scene?.frames[index]?.actors[target.actorId];
    if (!state) return null;
    if (!rig) return controller === 'body' ? [state.x, state.y] : null;
    const local = controllerLocalPoint(controller, rig, state.parts);
    return local ? actorLocalToWorld(local, state, rig.anchor) : null;
  }, [rig, scene, target.actorId]);

  const armParts = useCallback((controller: 'wrist_L' | 'wrist_R') => {
    const side = controller === 'wrist_L' ? 'L' : 'R';
    const upper = rig?.parts.find((part) => part.id === `arm_${side}_upper`);
    const fore = rig?.parts.find((part) => part.id === `arm_${side}_fore`);
    return upper && fore ? { upper, fore } : null;
  }, [rig]);

  const frameRect = () => host.current?.getBoundingClientRect() ?? null;

  const pointerToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || !camera) return null;
    return clientToWorld(camera, geom, rect.left, rect.top, clientX, clientY);
  }, [camera, geom.width, geom.height, geom.scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- drag resolution (pure, reused by preview, paint and commit) -----------

  const resolveBodyDrag = useCallback((state: ActorDragState, world: [number, number]) => {
    const raw = dragTargetTo(state.startActorPos, state.startWorld, world);
    const point = clampToArea(raw, rootArea);
    const clamped = Math.abs(point[0] - raw[0]) > 0.05 || Math.abs(point[1] - raw[1]) > 0.05;
    if (!snapEnabled || target.recording) return { point, hits: [] as SnapCandidate[], clamped };
    const snapped = snapPoint(point, snapCandidates, snapThreshold);
    return { point: snapped.point, hits: snapped.hits, clamped };
  }, [rootArea.x, rootArea.y, rootArea.width, rootArea.height, snapEnabled, target.recording, snapCandidates, snapThreshold]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvePropDrag = useCallback((state: PropDragState, world: [number, number]) => {
    const raw = dragTargetTo(state.startPos, state.startWorld, world);
    const point = clampToArea(raw, stageArea);
    if (!snapEnabled) return { point, hits: [] as SnapCandidate[] };
    const candidates = snapCandidates.filter((c) => !(c.kind === 'seat' && c.id === state.prop.id));
    return snapPoint(point, candidates, snapThreshold);
  }, [snapEnabled, snapCandidates, snapThreshold, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Wrist target in rig-local space, preserving the grab offset. */
  const armTargetLocal = useCallback((state: ActorDragState, world: [number, number]): [number, number] | null => {
    if (!actor || !rig || !state.startLocal || !state.startControllerLocal) return null;
    const local = worldToActorLocal(world, actor, rig.anchor);
    return [
      state.startControllerLocal[0] + (local[0] - state.startLocal[0]),
      state.startControllerLocal[1] + (local[1] - state.startLocal[1]),
    ];
  }, [actor, rig]);

  // --- live preview while a drag is held --------------------------------------

  const restorePreview = useCallback(() => {
    const applied = previewApplied.current;
    if (!applied) return;
    const win = iframe.current?.contentWindow as RuntimeWindow | null | undefined;
    try {
      if (applied.kind === 'prop') win?.__previewProp?.(applied.id, 0, 0);
      else win?.__seek?.(frame);
    } catch {
      // A preview rebuild may replace the iframe during a save. Its first seek
      // will render the authored pose, so there is nothing left to restore.
    }
    previewApplied.current = null;
    armPreviewPose.current = null;
  }, [frame, iframe]);

  useLayoutEffect(() => {
    if (!drag) return;
    const win = iframe.current?.contentWindow as RuntimeWindow | null | undefined;
    if (!win) return;
    const world = pointerToWorld(drag.clientX, drag.clientY);
    if (!world) return;

    if (drag.kind === 'prop') {
      const to = resolvePropDrag(drag, world).point;
      if (win.__previewProp?.(drag.prop.id, to[0] - drag.startPos[0], to[1] - drag.startPos[1])) {
        previewApplied.current = { kind: 'prop', id: drag.prop.id };
      }
      return;
    }
    if (!actor || !actor.visible) return;

    if (drag.controller === 'body') {
      const to = resolveBodyDrag(drag, world).point;
      if (win.__previewRoot?.(target.actorId, to[0], to[1])) {
        previewApplied.current = { kind: 'actor' };
      }
      return;
    }
    if (!rig) return;

    if (drag.controller === 'wrist_L' || drag.controller === 'wrist_R') {
      const parts = armParts(drag.controller);
      const localTarget = armTargetLocal(drag, world);
      if (!parts || !localTarget || !win.__previewParts) return;
      const upperT = actor.parts[parts.upper.id] ?? [0, 0, 0, 1] as IRTransform;
      const foreT = actor.parts[parts.fore.id] ?? [0, 0, 0, 1] as IRTransform;
      const previous = armPreviewPose.current ?? drag.startPose ?? { upper: upperT[0], fore: foreT[0] };
      const solved = solveArm(parts.upper.pivot, parts.fore.pivot, localTarget, previous.upper, previous.fore);
      armPreviewPose.current = { upper: solved.upper, fore: solved.fore };
      if (win.__previewParts(target.actorId, {
        [parts.upper.id]: [solved.upper, upperT[1], upperT[2], upperT[3]],
        [parts.fore.id]: [solved.fore, foreT[1], foreT[2], foreT[3]],
      })) previewApplied.current = { kind: 'actor' };
      return;
    }

    if (!drag.startLocal || !win.__previewParts) return;
    const local = worldToActorLocal(world, actor, rig.anchor);
    const offset = partOffsetTo(drag.startOffset, drag.startLocal, local, partMaxReach(drag.controller));
    const t = actor.parts[drag.controller] ?? [0, 0, 0, 1] as IRTransform;
    if (win.__previewParts(target.actorId, { [drag.controller]: [t[0], offset[0], offset[1], t[3]] })) {
      previewApplied.current = { kind: 'actor' };
    }
  }, [
    actor, armParts, armTargetLocal, drag, iframe, pointerToWorld,
    resolveBodyDrag, resolvePropDrag, rig, target.actorId,
  ]);

  useEffect(() => () => restorePreview(), [restorePreview]);

  // --- gesture lifecycle -------------------------------------------------------

  const beginDrag = (event: React.PointerEvent, initial: DragState) => {
    event.preventDefault();
    event.stopPropagation();
    onInteractStart?.();
    dragCapture.current = initial;
    setDrag(initial.kind === 'actor' ? { ...initial, samples: [...initial.samples] } : { ...initial });
    try {
      host.current?.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; the window listeners still track the pointer.
    }
  };

  const beginActorDrag = (event: React.PointerEvent, controller: ControllerId) => {
    if (target.busy || event.button !== 0 || !actor?.visible || !camera) return;
    const world = pointerToWorld(event.clientX, event.clientY);
    if (!world) return;
    if (controller !== activeController) target.onPickPart(controller);
    const isArm = controller === 'wrist_L' || controller === 'wrist_R';
    const parts = isArm ? armParts(controller as 'wrist_L' | 'wrist_R') : null;
    if (isArm && !parts) return;
    const upperT = parts ? (actor.parts[parts.upper.id] ?? [0, 0, 0, 1] as IRTransform) : null;
    const foreT = parts ? (actor.parts[parts.fore.id] ?? [0, 0, 0, 1] as IRTransform) : null;
    const partT = controller === 'head' || controller === 'torso'
      ? (actor.parts[controller] ?? [0, 0, 0, 1] as IRTransform)
      : null;
    armPreviewPose.current = upperT && foreT ? { upper: upperT[0], fore: foreT[0] } : null;
    beginDrag(event, {
      kind: 'actor',
      pointerId: event.pointerId,
      controller,
      startMs: target.startMs,
      startClient: [event.clientX, event.clientY],
      startWorld: world,
      startActorPos: [actor.x, actor.y],
      startLocal: rig ? worldToActorLocal(world, actor, rig.anchor) : null,
      startControllerLocal: rig ? controllerLocalPoint(controller, rig, actor.parts) : null,
      startOffset: partT ? [partT[1], partT[2]] : [0, 0],
      startPose: upperT && foreT ? { upper: upperT[0], fore: foreT[0] } : null,
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: event.timeStamp,
      samples: target.recording
        ? [{ clientX: event.clientX, clientY: event.clientY, elapsedMs: 0, frame: 1 }]
        : [],
    });
  };

  const beginPropDrag = (event: React.PointerEvent, prop: StagePropTarget) => {
    if (target.busy || event.button !== 0 || !camera || !onCommitProp) return;
    const world = pointerToWorld(event.clientX, event.clientY);
    if (!world) return;
    beginDrag(event, {
      kind: 'prop',
      pointerId: event.pointerId,
      prop,
      startClient: [event.clientX, event.clientY],
      startWorld: world,
      startPos: [prop.x, prop.y],
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: event.timeStamp,
    });
  };

  /** What lives under a stage-px point: a part of an actor, or a prop. */
  const hitTest = (stage: [number, number]): Hit | null => {
    const doc = iframe.current?.contentDocument;
    const el = (doc?.elementFromPoint(stage[0], stage[1]) ?? null) as Element | null;
    if (el) {
      const group = el.closest('g[id^="actor-"]');
      if (group) {
        const actorId = actorIdFromDom(group.id);
        if (actorId) {
          const hitMember = scene?.cast.find((item) => item.id === actorId);
          const hitRig = hitMember ? runtime?.__RIGS?.[hitMember.rig] : undefined;
          const hitPartIds = new Set((hitRig?.parts ?? []).map((part) => part.id));
          const available = new Set(availableControllers(hitPartIds));
          let partId: string | null = null;
          for (let node: Element | null = el; node; node = node.parentElement) {
            const candidate = node.id ? partIdFromDom(node.id, actorId) : null;
            if (candidate && hitPartIds.has(candidate)) {
              partId = candidate;
              break;
            }
            if (node === group) break;
          }
          const controller = controllerForPart(partId, available);
          return actorId === target.actorId
            ? { kind: 'actor', controller }
            : { kind: 'other-actor', actorId, controller };
        }
      }
      const propId = el.closest('[data-prop-id]')?.getAttribute('data-prop-id');
      if (propId && onCommitProp) {
        const prop = propTargets.find((item) => item.id === propId);
        if (prop) return { kind: 'prop', prop };
      }
    }
    // Transparent gaps in the artwork fall through — grab the nearest handle
    // of the current actor instead of doing nothing.
    if (actor?.visible && camera) {
      const pointer: [number, number] = [stage[0] * scale, stage[1] * scale];
      let best: { controller: ControllerId; distance: number } | null = null;
      for (const controller of controllers) {
        const world = controllerWorldAt(controller, frame);
        if (!world) continue;
        const at = worldToOverlay(camera, geom, world);
        const distance = Math.hypot(at[0] - pointer[0], at[1] - pointer[1]);
        if (distance <= HANDLE_GRAB_RADIUS_PX && (!best || distance < best.distance)) {
          best = { controller, distance };
        }
      }
      if (best) return { kind: 'actor', controller: best.controller };
    }
    return null;
  };

  /**
   * Right-click on the stage, resolved to whatever is under the pointer.
   *
   * This layer is in the parent document and sits above the iframe, so when a
   * motion target is being edited it intercepts before StageColumn's in-frame
   * bridge — which is what lets the menu know it is about an actor rather than
   * about the picture in general.
   */
  const onSurfaceContextMenu = (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    const rect = frameRect();
    const hit = rect && camera ? hitTest(clientToStage(geom, rect.left, rect.top, event.clientX, event.clientY)) : null;
    onContextMenu(
      event,
      hit?.kind === 'prop' ? { kind: 'prop', propId: hit.prop.id }
        : hit?.kind === 'other-actor' ? { kind: 'actor', actorId: hit.actorId }
          : hit?.kind === 'actor' ? { kind: 'actor', actorId: target.actorId }
            : { kind: 'stage' },
    );
  };

  const onSurfacePointerDown = (event: React.PointerEvent) => {
    if (target.busy || event.button !== 0 || !camera) return;
    const rect = frameRect();
    if (!rect) return;
    const stage = clientToStage(geom, rect.left, rect.top, event.clientX, event.clientY);
    const hit = hitTest(stage);
    if (!hit) return;
    if (hit.kind === 'other-actor') {
      event.preventDefault();
      setHover(null);
      target.onPickActor(hit.actorId, hit.controller);
      return;
    }
    if (hit.kind === 'prop') {
      beginPropDrag(event, hit.prop);
      return;
    }
    beginActorDrag(event, hit.controller);
  };

  const onSurfacePointerMove = (event: React.PointerEvent) => {
    if (dragCapture.current || hoverFrame.current !== null) return;
    const { clientX, clientY } = event;
    hoverFrame.current = window.requestAnimationFrame(() => {
      hoverFrame.current = null;
      const rect = frameRect();
      if (!rect || !camera) {
        setHover(null);
        return;
      }
      const stage = clientToStage(geom, rect.left, rect.top, clientX, clientY);
      const hit = hitTest(stage);
      setHover(hit === null ? null
        : hit.kind === 'actor' ? { kind: 'actor', controller: hit.controller }
        : hit.kind === 'other-actor' ? { kind: 'other-actor', actorId: hit.actorId, at: [stage[0] * scale, stage[1] * scale] }
        : { kind: 'prop', id: hit.prop.id });
    });
  };

  const onSurfacePointerLeave = () => {
    if (hoverFrame.current !== null) {
      window.cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = null;
    }
    setHover(null);
  };

  const dragActive = drag !== null;

  useEffect(() => {
    if (!dragActive) return;
    const paint = () => {
      if (dragPaintFrame.current !== null) return;
      dragPaintFrame.current = window.requestAnimationFrame(() => {
        dragPaintFrame.current = null;
        const current = dragCapture.current;
        if (!current) return;
        setDrag(current.kind === 'actor' ? { ...current, samples: [...current.samples] } : { ...current });
      });
    };
    const addSample = (event: PointerEvent) => {
      const current = dragCapture.current;
      if (!current) return;
      current.clientX = event.clientX;
      current.clientY = event.clientY;
      if (current.kind === 'actor' && target.recording) {
        const elapsedMs = Math.max(0, event.timeStamp - current.startedAt);
        const sampleFrame = Math.max(1, Math.min(target.fps * 10, Math.round((elapsedMs / 1000) * target.fps)));
        const sample = { clientX: event.clientX, clientY: event.clientY, elapsedMs, frame: sampleFrame };
        if (current.samples.at(-1)?.frame === sampleFrame) current.samples[current.samples.length - 1] = sample;
        else current.samples.push(sample);
      }
      paint();
    };
    const stopPaint = () => {
      if (dragPaintFrame.current !== null) {
        window.cancelAnimationFrame(dragPaintFrame.current);
        dragPaintFrame.current = null;
      }
    };
    const releaseCapture = (pointerId: number) => {
      try {
        host.current?.releasePointerCapture(pointerId);
      } catch {
        // Pointer already gone; nothing held.
      }
    };
    const up = (event: PointerEvent) => {
      addSample(event);
      const completed = dragCapture.current;
      dragCapture.current = null;
      stopPaint();
      const world = pointerToWorld(event.clientX, event.clientY);
      // The live preview chained IK solves along the whole gesture; committing
      // against its final pose keeps the saved elbow on the branch the user
      // watched, instead of re-deciding from the authored pose and popping.
      const finalArmPose = armPreviewPose.current;
      restorePreview();
      setDrag(null);
      if (completed) releaseCapture(completed.pointerId);
      if (completed?.kind === 'actor' && target.recording) target.onCaptureEnd?.();
      if (!completed || !world) return;

      // A stationary press is a selection, not a zero-length motion.
      const moved = Math.hypot(
        event.clientX - completed.startClient[0],
        event.clientY - completed.startClient[1],
      ) >= CLICK_SLOP_PX;
      if (!moved) return;

      if (completed.kind === 'prop') {
        const to = resolvePropDrag(completed, world).point;
        if (to[0] !== completed.startPos[0] || to[1] !== completed.startPos[1]) {
          onCommitProp?.(completed.prop, to);
        }
        return;
      }
      if (!actor) return;

      const startMs = completed.startMs;
      const endMs = startMs + (target.durationFrames / target.fps) * 1000;
      const capturedWorld = (target.recording ? completed.samples : []).flatMap((sample) => {
        const point = pointerToWorld(sample.clientX, sample.clientY);
        return point ? [{ frame: sample.frame, world: point }] : [];
      });
      const recordedRequest = <T extends MotionAuthoringRequest['from']>(
        request: Omit<MotionAuthoringRequest, 'from' | 'to' | 'endMs'>,
        from: T,
        recorded: Array<{ frame: number; value: T }>,
      ): MotionAuthoringRequest => {
        const reduced = reducePuppeteeringSamples(
          [{ frame: 0, value: from }, ...recorded] as PuppeteeringSample[],
          { smoothingPasses: 2, tolerance: Array.isArray(from) ? 1.5 : 0.75 },
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

      if (completed.controller === 'body') {
        if (target.recording && capturedWorld.length) {
          target.onCommit(recordedRequest(
            { actorId: target.actorId, channel: 'root.position', startMs },
            completed.startActorPos,
            capturedWorld.map((sample) => ({
              frame: sample.frame,
              value: clampToArea(
                dragTargetTo(completed.startActorPos, completed.startWorld, sample.world),
                rootArea,
              ),
            })),
          ));
          return;
        }
        target.onCommit({
          actorId: target.actorId,
          channel: 'root.position',
          startMs,
          endMs,
          from: completed.startActorPos,
          to: resolveBodyDrag(completed, world).point,
          path: target.path,
          assist: target.assist,
          source: 'drag',
        });
        return;
      }
      if (!rig) return;

      if (completed.controller === 'wrist_L' || completed.controller === 'wrist_R') {
        const parts = armParts(completed.controller);
        if (!parts) return;
        const upperT = actor.parts[parts.upper.id] ?? [0, 0, 0, 1] as IRTransform;
        const foreT = actor.parts[parts.fore.id] ?? [0, 0, 0, 1] as IRTransform;
        const upperFrom = { rot: upperT[0], x: upperT[1], y: upperT[2], scale: upperT[3] };
        const foreFrom = { rot: foreT[0], x: foreT[1], y: foreT[2], scale: foreT[3] };
        const solveTo = (point: [number, number], previousUpper: number, previousFore: number) => {
          const local = armTargetLocal(completed, point);
          return local ? solveArm(parts.upper.pivot, parts.fore.pivot, local, previousUpper, previousFore) : null;
        };
        if (target.recording && capturedWorld.length) {
          let previousUpper = upperT[0];
          let previousFore = foreT[0];
          const recorded = capturedWorld.flatMap((sample) => {
            const solved = solveTo(sample.world, previousUpper, previousFore);
            if (!solved) return [];
            previousUpper = solved.upper;
            previousFore = solved.fore;
            return [{ frame: sample.frame, solved }];
          });
          if (!recorded.length) return;
          target.onCommit([
            recordedRequest(
              { actorId: target.actorId, channel: 'part.transform', partId: parts.upper.id, startMs },
              upperFrom,
              recorded.map((sample) => ({
                frame: sample.frame,
                value: { ...upperFrom, rot: Math.round(sample.solved.upper * 10) / 10 },
              })),
            ),
            recordedRequest(
              { actorId: target.actorId, channel: 'part.transform', partId: parts.fore.id, startMs },
              foreFrom,
              recorded.map((sample) => ({
                frame: sample.frame,
                value: { ...foreFrom, rot: Math.round(sample.solved.fore * 10) / 10 },
              })),
            ),
          ]);
          return;
        }
        const solved = solveTo(world, finalArmPose?.upper ?? upperT[0], finalArmPose?.fore ?? foreT[0]);
        if (!solved) return;
        target.onCommit([
          {
            actorId: target.actorId,
            channel: 'part.transform',
            partId: parts.upper.id,
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
            partId: parts.fore.id,
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

      const partId = completed.controller;
      if (!completed.startLocal) return;
      const partT = actor.parts[partId] ?? [0, 0, 0, 1] as IRTransform;
      const from = { rot: partT[0], x: completed.startOffset[0], y: completed.startOffset[1], scale: partT[3] };
      const valueAt = (point: [number, number]) => {
        const local = worldToActorLocal(point, actor, rig.anchor);
        const offset = partOffsetTo(completed.startOffset, completed.startLocal!, local, partMaxReach(partId));
        return { ...from, x: offset[0], y: offset[1] };
      };
      if (target.recording && capturedWorld.length) {
        target.onCommit(recordedRequest(
          { actorId: target.actorId, channel: 'part.transform', partId, startMs },
          from,
          capturedWorld.map((sample) => ({ frame: sample.frame, value: valueAt(sample.world) })),
        ));
        return;
      }
      target.onCommit({
        actorId: target.actorId,
        channel: 'part.transform',
        partId,
        startMs,
        endMs,
        from,
        to: valueAt(world),
        path: target.path,
        assist: target.assist,
        source: 'drag',
      });
    };
    const cancel = () => {
      const active = dragCapture.current;
      dragCapture.current = null;
      stopPaint();
      restorePreview();
      setDrag(null);
      if (active) releaseCapture(active.pointerId);
      if (active?.kind === 'actor' && target.recording) target.onCaptureEnd?.();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', addSample);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', addSample);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
    };
  }, [
    dragActive, actor, rig, armParts, armTargetLocal, onCommitProp, pointerToWorld,
    resolveBodyDrag, resolvePropDrag, restorePreview, rootArea, target,
  ]);

  // --- render ------------------------------------------------------------------

  if (!scene || !camera) return null;

  const toOverlay = (point: [number, number]): [number, number] => worldToOverlay(camera, geom, point);

  const pointerWorld = drag ? pointerToWorld(drag.clientX, drag.clientY) : null;

  /** Where the active gesture currently lands, plus its badges. */
  const dragVisual = (() => {
    if (!drag || !pointerWorld) return null;
    if (drag.kind === 'prop') {
      const resolved = resolvePropDrag(drag, pointerWorld);
      // Same correction as the resting handle: the ghost has to travel with the
      // art, not with the authored coordinates behind it.
      const shift = layerParallaxOffset(iframe.current?.contentDocument, drag.prop.layer);
      const shifted = (p: [number, number]): [number, number] =>
        toOverlay([p[0] + shift[0], p[1] + shift[1]]);
      return {
        origin: shifted(drag.startPos),
        point: shifted(resolved.point),
        hits: resolved.hits,
        clamped: false,
      };
    }
    if (!actor) return null;
    if (drag.controller === 'body') {
      const resolved = resolveBodyDrag(drag, pointerWorld);
      return {
        origin: toOverlay(drag.startActorPos),
        point: toOverlay(resolved.point),
        hits: resolved.hits,
        clamped: resolved.clamped,
      };
    }
    if (!rig || !drag.startControllerLocal) return null;
    if (drag.controller === 'wrist_L' || drag.controller === 'wrist_R') {
      const parts = armParts(drag.controller);
      const localTarget = armTargetLocal(drag, pointerWorld);
      if (!parts || !localTarget) return null;
      const previous = armPreviewPose.current ?? drag.startPose ?? { upper: 0, fore: 0 };
      const solved = solveArm(parts.upper.pivot, parts.fore.pivot, localTarget, previous.upper, previous.fore);
      const clamped = Math.hypot(
        solved.clampedTarget[0] - localTarget[0],
        solved.clampedTarget[1] - localTarget[1],
      ) > 0.5;
      return {
        origin: toOverlay(actorLocalToWorld(drag.startControllerLocal, actor, rig.anchor)),
        point: toOverlay(actorLocalToWorld(solved.clampedTarget, actor, rig.anchor)),
        hits: [] as SnapCandidate[],
        clamped,
      };
    }
    const local = worldToActorLocal(pointerWorld, actor, rig.anchor);
    const rawDx = drag.startOffset[0] + (local[0] - drag.startLocal![0]);
    const rawDy = drag.startOffset[1] + (local[1] - drag.startLocal![1]);
    const offset = partOffsetTo(drag.startOffset, drag.startLocal!, local, partMaxReach(drag.controller));
    const pivot = rig.parts.find((part) => part.id === drag.controller)?.pivot;
    if (!pivot) return null;
    return {
      origin: toOverlay(actorLocalToWorld(
        [pivot[0] + drag.startOffset[0], pivot[1] + drag.startOffset[1]], actor, rig.anchor,
      )),
      point: toOverlay(actorLocalToWorld([pivot[0] + offset[0], pivot[1] + offset[1]], actor, rig.anchor)),
      hits: [] as SnapCandidate[],
      clamped: Math.hypot(rawDx, rawDy) > partMaxReach(drag.controller) + 0.05,
    };
  })();

  const draggedController = drag?.kind === 'actor' ? drag.controller : null;

  const handles = actor?.visible
    ? controllers.flatMap((controller) => {
        const world = controllerWorldAt(controller, frame);
        if (!world) return [];
        const at = draggedController === controller && dragVisual ? dragVisual.point : toOverlay(world);
        return [{ controller, at }];
      })
    : [];

  const onionPoints = showOnion && target.onionSkinFrames > 0
    ? [frame - target.onionSkinFrames, frame + target.onionSkinFrames]
      .map((index) => controllerWorldAt(activeController, index))
      .flatMap((point) => (point ? [toOverlay(point)] : []))
    : [];

  const ghostPoints = showPath && actor
    ? (target.ghostPath ?? []).flatMap((value) => {
        if (Array.isArray(value)) return [toOverlay(value)];
        if (!rig || activeController === 'body' || activeController === 'wrist_L' || activeController === 'wrist_R') return [];
        const pivot = rig.parts.find((part) => part.id === activeController)?.pivot;
        if (!pivot) return [];
        return [toOverlay(actorLocalToWorld([pivot[0] + value.x, pivot[1] + value.y], actor, rig.anchor))];
      })
    : [];

  const recordedPoints = drag?.kind === 'actor'
    ? drag.samples.flatMap((sample) => {
        const point = pointerToWorld(sample.clientX, sample.clientY);
        return point ? [toOverlay(point)] : [];
      })
    : [];

  const reach = (() => {
    if (!actor?.visible || !rig || activeController === 'body') return null;
    if (activeController === 'wrist_L' || activeController === 'wrist_R') {
      const parts = armParts(activeController);
      if (!parts) return null;
      const upperLength = Math.hypot(
        parts.fore.pivot[0] - parts.upper.pivot[0],
        parts.fore.pivot[1] - parts.upper.pivot[1],
      );
      return {
        center: toOverlay(actorLocalToWorld(parts.upper.pivot, actor, rig.anchor)),
        radius: upperLength * (1 + FORE_LENGTH_RATIO) * actor.scale * (width / camera.w) * scale,
      };
    }
    const pivot = rig.parts.find((part) => part.id === activeController)?.pivot;
    if (!pivot) return null;
    return {
      center: toOverlay(actorLocalToWorld(pivot, actor, rig.anchor)),
      radius: partMaxReach(activeController) * actor.scale * (width / camera.w) * scale,
    };
  })();

  const cursorClass = drag
    ? 'cursor-grabbing'
    : hover?.kind === 'other-actor'
      ? 'cursor-pointer'
      : hover
        ? 'cursor-grab'
        : '';

  return (
    <div
      ref={host}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onSurfacePointerMove}
      onPointerLeave={onSurfacePointerLeave}
      onContextMenu={onSurfaceContextMenu}
      className={`absolute inset-0 z-20 pointer-events-auto touch-none select-none ${cursorClass}`}
    >
      {!actor?.visible && (
        <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none">
          <span className="rounded border border-edge bg-panel/90 px-2 py-1 text-[10px] text-ink-dim shadow-lg">
            {target.actorId} is off-stage at this frame — move the playhead, or click another character to select it.
          </span>
        </div>
      )}

      {(ghostPoints.length > 1 || recordedPoints.length > 1 || dragVisual) && (
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
          {dragVisual && (
            <line
              x1={dragVisual.origin[0]} y1={dragVisual.origin[1]}
              x2={dragVisual.point[0]} y2={dragVisual.point[1]}
              stroke="#c8834a" strokeWidth="2" strokeDasharray="5 4"
            />
          )}
        </svg>
      )}

      {onionPoints.map((point, index) => (
        <span
          key={`onion-${index}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 border-info/60 bg-info/10 pointer-events-none"
          style={{ left: point[0], top: point[1], opacity: index === 0 ? 0.45 : 0.7 }}
          title={index === 0 ? 'Previous onion skin' : 'Next onion skin'}
        />
      ))}

      {reach && !drag && (
        <div
          className="absolute rounded-full border border-accent/50 pointer-events-none"
          style={{
            left: reach.center[0],
            top: reach.center[1],
            width: reach.radius * 2,
            height: reach.radius * 2,
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}

      {dragVisual && dragVisual.clamped && (
        <span
          className="absolute -translate-x-1/2 rounded bg-bad/90 text-white text-[10px] px-1.5 py-0.5 pointer-events-none whitespace-nowrap"
          style={{ left: dragVisual.point[0], top: dragVisual.point[1] + 12 }}
        >
          {draggedController && draggedController !== 'body' ? 'clamped to valid reach' : 'clamped to walkable area'}
        </span>
      )}
      {dragVisual && dragVisual.hits.length > 0 && (
        <>
          <span
            className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full border-2 border-good pointer-events-none"
            style={{ left: dragVisual.point[0], top: dragVisual.point[1] }}
          />
          <span
            className="absolute -translate-x-1/2 rounded bg-good/90 text-stage text-[9px] font-semibold tracking-[.04em] px-1.5 py-0.5 pointer-events-none whitespace-nowrap"
            style={{ left: dragVisual.point[0], top: dragVisual.point[1] - 24 }}
          >
            {dragVisual.hits.map((hit) => hit.id).join(' · ')}
          </span>
        </>
      )}

      {showPropHandles && propTargets.map((prop) => {
        const dragging = drag?.kind === 'prop' && drag.prop.id === prop.id;
        // A prop in a parallaxed layer is drawn offset from its authored
        // position, so the handle has to move with the art or it detaches from
        // the thing it grabs. Drag deltas need no such correction: parallax is
        // translation only, so a pointer delta is still a world delta.
        const shift = layerParallaxOffset(iframe.current?.contentDocument, prop.layer);
        const at = dragging && dragVisual
          ? dragVisual.point
          : toOverlay([prop.x + shift[0], prop.y + shift[1]]);
        return (
          <button
            key={prop.id}
            type="button"
            onPointerDown={(event) => beginPropDrag(event, prop)}
            title={prop.seatedBy
              ? `${prop.id} · seat target — occupied by ${prop.seatedBy}. Drag to move it in the shared set.`
              : `${prop.id} · ${prop.prop} — drag to move it in the shared set`}
            className={`absolute w-[11px] h-[11px] -translate-x-1/2 -translate-y-1/2 border-[1.5px] bg-[rgba(12,13,15,.55)] cursor-grab active:cursor-grabbing pointer-events-auto ${
              hover?.kind === 'prop' && hover.id === prop.id ? 'shadow-[0_0_0_3px_rgba(168,144,80,.35)]' : ''
            }`}
            style={{
              left: at[0],
              top: at[1],
              borderColor: prop.seatedBy ? '#c8595a' : '#a89050',
              borderRadius: prop.seatedBy ? '50%' : 2,
            }}
          >
            {dragging && (
              <span className="absolute left-1/2 -translate-x-1/2 top-4 whitespace-nowrap rounded bg-black/75 text-white text-[10px] px-1 pointer-events-none">
                {prop.prop}
              </span>
            )}
          </button>
        );
      })}

      {handles.map(({ controller, at }) => {
        const active = controller === activeController;
        const highlighted = hover?.kind === 'actor' && hover.controller === controller;
        return (
          <button
            key={controller}
            type="button"
            onPointerDown={(event) => beginActorDrag(event, controller)}
            title={`Drag ${target.actorId}'s ${controllerLabel(controller).toLowerCase()}${active ? '' : ' (selects it)'}`}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 pointer-events-auto cursor-grab active:cursor-grabbing ${
              active
                ? 'w-5 h-5 border-accent bg-accent/30 hover:bg-accent/60'
                : 'w-3.5 h-3.5 border-accent/60 bg-stage/60 hover:border-accent hover:bg-accent/30'
            } ${highlighted ? 'shadow-[0_0_0_3px_rgba(200,131,74,.3)]' : ''} ${target.busy ? 'opacity-50' : ''}`}
            style={{ left: at[0], top: at[1] }}
          >
            {(active || highlighted) && (
              <span className="absolute left-1/2 -translate-x-1/2 top-5 whitespace-nowrap rounded bg-black/75 text-white text-[10px] px-1 pointer-events-none">
                {controllerLabel(controller)}
              </span>
            )}
            {active && target.recording && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-bad text-white text-[9px] px-1 pointer-events-none">REC</span>
            )}
            {active && target.busy && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-panel border border-edge text-ink-dim text-[9px] px-1 pointer-events-none whitespace-nowrap">
                saving…
              </span>
            )}
          </button>
        );
      })}

      {hover?.kind === 'other-actor' && !drag && (
        <span
          className="absolute rounded bg-black/80 text-white text-[10px] px-1.5 py-0.5 pointer-events-none whitespace-nowrap"
          style={{ left: hover.at[0] + 12, top: hover.at[1] - 8 }}
        >
          select {hover.actorId}
        </span>
      )}
    </div>
  );
}
