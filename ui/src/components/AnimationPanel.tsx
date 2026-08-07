import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type {
  AnimationDocument, AnimationKey, MotionSegment, MotionValue, RigDoc, ShotList, TimeAnchor,
} from '../types.ts';
import {
  availableControllers,
  type AnimationEditTarget,
  type MotionAuthoringCommit,
  type MotionAuthoringRequest,
} from '../editor/stage/interaction.ts';
import { Badge, Button, Empty, Field, NumberInput, Select, Spinner } from './ui.tsx';
import { motionDeletionBlocker } from '../editor/lib.ts';

type Easing = AnimationKey['easing'];

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '-');
}

function controlId(segmentId: string, edge: 'from' | 'to', suffix = ''): string {
  return `${segmentId}:${edge}${suffix}`;
}

function absoluteMs(anchor: TimeAnchor): number | null {
  return anchor.kind === 'absolute' ? anchor.ms : null;
}

type Gait = NonNullable<Extract<MotionSegment, { channel: 'root.position' }>['gait']>;

function segmentFor(request: MotionAuthoringRequest, easing: Easing, gait: Gait): MotionSegment {
  const target = request.channel === 'part.transform' ? `${request.channel}:${request.partId}` : request.channel;
  const id = safeId(`manual:${request.actorId}:${target}:${Math.round(request.startMs * 10)}`);
  const common = {
    id,
    layerId: 'manual',
    actorId: request.actorId,
    blend: 'override',
    enabled: true,
    locked: false,
    easing,
    path: request.path ?? { shape: 'smooth' as const, curvature: 0.2 },
    assist: request.assist ?? { anticipation: 0, overshoot: 0, hold: 0, recovery: 0.15 },
    source: request.source ?? 'drag',
    from: {
      id: controlId(id, 'from'),
      time: { kind: 'absolute' as const, ms: request.startMs },
      value: request.from,
      locked: false,
    },
    to: {
      id: controlId(id, 'to'),
      time: { kind: 'absolute' as const, ms: request.endMs },
      value: request.to,
      locked: false,
    },
    waypoints: (request.waypoints ?? []).map((waypoint, index) => ({
      id: `${id}:waypoint:${String(index).padStart(3, '0')}`,
      at: waypoint.at,
      value: waypoint.value,
      locked: false,
    })),
  };
  return request.channel === 'root.position'
    ? { ...common, channel: 'root.position', gait } as MotionSegment
    : { ...common, channel: 'part.transform', partId: request.partId! } as MotionSegment;
}

function mergeMotion(
  document: AnimationDocument,
  request: MotionAuthoringRequest,
  easing: Easing,
  gait: Gait,
): AnimationDocument {
  const proposed = segmentFor(request, easing, gait);
  const existing = document.segments.find((segment) => segment.id === proposed.id);
  if (existing?.locked) throw new Error(`The ${existing.id} motion segment is locked.`);

  const overlaps = document.segments.find((segment) => {
    if (segment.id === proposed.id || segment.layerId !== 'manual') return false;
    if (
      segment.actorId !== request.actorId || segment.channel !== request.channel ||
      ((segment.channel === 'part.transform' ? segment.partId : null) ?? null) !== (request.partId ?? null)
    ) return false;
    const start = absoluteMs(segment.from.time);
    const end = absoluteMs(segment.to.time);
    return start !== null && end !== null && request.startMs < end && request.endMs > start;
  });
  if (overlaps) throw new Error(`Motion overlaps existing authoring interval ${overlaps.id}; retime that segment first.`);

  return existing
    ? { ...document, segments: document.segments.map((segment) => segment.id === existing.id ? proposed : segment) }
    : { ...document, segments: [...document.segments, proposed] };
}

function shiftAnchor(anchor: TimeAnchor, deltaMs: number): TimeAnchor {
  return anchor.kind === 'absolute'
    ? { ...anchor, ms: Math.max(0, anchor.ms + deltaMs) }
    : { ...anchor, offsetMs: anchor.offsetMs + deltaMs };
}

function midpoint(a: MotionValue, b: MotionValue): MotionValue {
  if (typeof a === 'number' && typeof b === 'number') return (a + b) / 2;
  if (Array.isArray(a) && Array.isArray(b)) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (!Array.isArray(a) && typeof a !== 'number' && !Array.isArray(b) && typeof b !== 'number') {
    return {
      rot: (a.rot + b.rot) / 2,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      scale: (a.scale + b.scale) / 2,
    };
  }
  throw new Error('motion endpoints use different value shapes');
}

function interpolateMotion(a: MotionValue, b: MotionValue, amount: number): MotionValue {
  if (amount === 0.5) return midpoint(a, b);
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * amount;
  if (Array.isArray(a) && Array.isArray(b)) {
    return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount];
  }
  if (!Array.isArray(a) && typeof a !== 'number' && !Array.isArray(b) && typeof b !== 'number') {
    return {
      rot: a.rot + (b.rot - a.rot) * amount,
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
      scale: a.scale + (b.scale - a.scale) * amount,
    };
  }
  throw new Error('motion endpoints use different value shapes');
}

function nudgeMotion(value: MotionValue, dx: number, dy: number): MotionValue {
  if (typeof value === 'number') return Math.max(0.01, value + dx * 0.01);
  if (Array.isArray(value)) return [value[0] + dx, value[1] + dy];
  return { ...value, x: value.x + dx, y: value.y + dy };
}

/** Controls which actor controller is draggable in the preview. */
export function AnimationPanel({
  scene, shots, document, playheadMs, selectedSegmentId, onDocument, onTarget, onSeek, onDeleteSegment,
}: {
  scene: string;
  shots: ShotList | null;
  document: AnimationDocument | null;
  playheadMs: number;
  selectedSegmentId: string | null;
  onDocument: (document: AnimationDocument) => void;
  onTarget: (target: AnimationEditTarget | null) => void;
  onSeek: (ms: number) => void;
  onDeleteSegment: (segmentId: string) => void;
}) {
  const actorIds = shots?.cast.map((member) => member.id) ?? [];
  const [actorId, setActorId] = useState('');
  const [partId, setPartId] = useState('body');
  const [durationFrames, setDurationFrames] = useState(12);
  const [easing, setEasing] = useState<Easing>('ease-in-out');
  const [gait, setGait] = useState<Gait>('auto');
  /** The phrase a gait change writes to; a ref because it is derived below. */
  const gaitSegmentRef = useRef<MotionSegment | null>(null);
  const [pathShape, setPathShape] = useState<'linear' | 'smooth' | 'arc'>('smooth');
  const [curvature, setCurvature] = useState(0.2);
  const [anticipation, setAnticipation] = useState(0);
  const [overshoot, setOvershoot] = useState(0.08);
  const [hold, setHold] = useState(0.08);
  const [recovery, setRecovery] = useState(0.15);
  const [recording, setRecording] = useState(false);
  const [onionSkinFrames, setOnionSkinFrames] = useState(2);
  const [rig, setRig] = useState<RigDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<AnimationDocument[]>([]);
  const [redoStack, setRedoStack] = useState<AnimationDocument[]>([]);

  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    setRecording(false);
  }, [scene]);

  useEffect(() => {
    if (!actorIds.length) setActorId('');
    else if (!actorIds.includes(actorId)) setActorId(actorIds[0]!);
  }, [actorIds.join('|'), actorId]);

  // Keyed on the rig NAME, not shots identity: an unrelated shot-list save
  // must not refetch the rig and stomp the user's Body-part selection. On
  // load the current selection is validated, never blindly reset.
  const rigName = shots?.cast.find((item) => item.id === actorId)?.rig ?? null;
  useEffect(() => {
    if (!rigName) {
      setRig(null);
      return;
    }
    let cancelled = false;
    void api.rig(rigName).then((result) => {
      if (!cancelled) {
        setRig(result.rig);
        setPartId((current) => {
          const partIds = new Set((result.rig.parts ?? []).map((part) => part.id));
          const supported = new Set<string>(availableControllers(partIds));
          return supported.has(current) ? current : 'body';
        });
      }
    }).catch((err: unknown) => {
      if (!cancelled) setError((err as Error).message);
    });
    return () => { cancelled = true; };
  }, [rigName]);

  useEffect(() => {
    const selected = selectedSegmentId
      ? document?.segments.find((segment) => segment.id === selectedSegmentId)
      : null;
    if (!selected) return;
    if (actorId !== selected.actorId) {
      setActorId(selected.actorId);
      return;
    }
    if (!rig) return;
    if (selected.channel !== 'part.transform') {
      setPartId('body');
    } else if (selected.partId.startsWith('arm_L_')) {
      setPartId('wrist_L');
    } else if (selected.partId.startsWith('arm_R_')) {
      setPartId('wrist_R');
    } else {
      setPartId(selected.partId);
    }
  }, [actorId, document?.revision, rig, selectedSegmentId]);

  const commit = useCallback(async (request: MotionAuthoringCommit) => {
    // The target stays mounted while saving, so this is the re-entrancy guard
    // that stops a second drag racing the in-flight save.
    if (!document || busy) return;
    // Capture is one-shot. Disarm on every completed drag, including a stale
    // normal-drag callback or a save failure, so the next gesture is predictable.
    setRecording(false);
    setBusy(true);
    setError(null);
    try {
      const edited = (Array.isArray(request) ? request : [request])
        .reduce((current, edit) => mergeMotion(current, edit, easing, gait), document);
      const saved = await api.saveAnimation(scene, edited);
      setUndoStack((items) => [...items, document].slice(-50));
      setRedoStack([]);
      onDocument(saved.document);
      const edits = Array.isArray(request) ? request : [request];
      onSeek(Math.max(...edits.map((edit) => edit.endMs)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, document, easing, gait, onDocument, onSeek, scene]);

  const restore = useCallback(async (direction: 'undo' | 'redo') => {
    if (!document || busy) return;
    const source = direction === 'undo' ? undoStack : redoStack;
    const snapshot = source[source.length - 1];
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveAnimation(scene, { ...snapshot, revision: document.revision });
      if (direction === 'undo') {
        setUndoStack((items) => items.slice(0, -1));
        setRedoStack((items) => [...items, document].slice(-50));
      } else {
        setRedoStack((items) => items.slice(0, -1));
        setUndoStack((items) => [...items, document].slice(-50));
      }
      onDocument(saved.document);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, document, onDocument, redoStack, scene, undoStack]);

  /**
   * Gait is a property of a move that already exists, not a setting for the
   * next one.
   *
   * The other controls here arm the next drag and merely echo whatever is
   * selected. That is the wrong contract for this one: reading "walk" on a move
   * you just made and finding it changed nothing is indistinguishable from the
   * feature being broken. So it writes through to the selected phrase, and
   * arms the next drag as well.
   */
  const changeGait = useCallback(async (next: Gait) => {
    setGait(next);
    const segment = gaitSegmentRef.current;
    if (!document || !segment || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveAnimation(scene, {
        ...document,
        segments: document.segments.map((item) => (
          item.id === segment.id && item.channel === 'root.position' ? { ...item, gait: next } : item
        )),
      });
      setUndoStack((items) => [...items, document].slice(-50));
      setRedoStack([]);
      onDocument(saved.document);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, document, onDocument, scene]);

  const selectedPartIds = partId === 'wrist_L'
    ? ['arm_L_upper', 'arm_L_fore']
    : partId === 'wrist_R'
      ? ['arm_R_upper', 'arm_R_fore']
      : partId === 'body' ? [] : [partId];
  const selectedSegments = document?.segments.filter((segment) =>
    segment.layerId === 'manual' && segment.actorId === actorId && (
      partId === 'body'
        ? segment.channel === 'root.position'
        : segment.channel === 'part.transform' && !!segment.partId && selectedPartIds.includes(segment.partId)
    )) ?? [];
  const explicitlySelectedSegment = selectedSegmentId
    ? document?.segments.find((segment) => segment.id === selectedSegmentId) ?? null
    : null;
  const selectedSegment = explicitlySelectedSegment ?? [...selectedSegments].sort((a, b) => {
    const aStart = absoluteMs(a.from.time) ?? 0;
    const bStart = absoluteMs(b.from.time) ?? 0;
    return Math.abs(aStart - playheadMs) - Math.abs(bStart - playheadMs) || a.id.localeCompare(b.id);
  })[0] ?? null;

  gaitSegmentRef.current = selectedSegment?.channel === 'root.position' ? selectedSegment : null;

  useEffect(() => {
    if (!selectedSegment) return;
    setEasing(selectedSegment.easing);
    if (selectedSegment.channel === 'root.position') setGait(selectedSegment.gait ?? 'auto');
    setPathShape(selectedSegment.path.shape);
    setCurvature(selectedSegment.path.curvature);
    setAnticipation(selectedSegment.assist.anticipation);
    setOvershoot(selectedSegment.assist.overshoot);
    setHold(selectedSegment.assist.hold);
    setRecovery(selectedSegment.assist.recovery);
  }, [document?.revision, selectedSegment?.id]);

  const target = useMemo<AnimationEditTarget | null>(() => {
    if (!shots || !document || !actorId) return null;
    return {
      actorId,
      partId: partId === 'body' ? null : partId,
      startMs: playheadMs,
      durationFrames,
      fps: shots.fps,
      recording,
      busy,
      onionSkinFrames,
      path: { shape: pathShape, curvature },
      assist: { anticipation, overshoot, hold, recovery },
      ghostPath: selectedSegment
        ? [selectedSegment.from.value, ...selectedSegment.waypoints.map((waypoint) => waypoint.value), selectedSegment.to.value]
          .filter((value): value is [number, number] | { rot: number; x: number; y: number; scale: number } => typeof value !== 'number')
        : undefined,
      onCommit: (request) => { void commit(request); },
      onCaptureEnd: () => setRecording(false),
      onPickPart: (controller) => setPartId(controller),
      onPickActor: (id, controller) => {
        if (!shots.cast.some((member) => member.id === id)) return;
        setActorId(id);
        if (controller) setPartId(controller);
      },
    };
  }, [
    actorId, anticipation, busy, commit, curvature, document, durationFrames, hold,
    onionSkinFrames, overshoot, partId, pathShape, playheadMs, recording, recovery,
    selectedSegment, shots,
  ]);

  useEffect(() => {
    onTarget(target);
    return () => onTarget(null);
  }, [onTarget, target]);

  if (!shots || !document) return <Empty>Direct the scene before authoring motion</Empty>;

  const partIds = new Set((rig?.parts ?? []).map((part) => part.id));
  const controllers = [
    { value: 'body', label: 'Body / stage position' },
    ...(partIds.has('head') ? [{ value: 'head', label: 'Head' }] : []),
    ...(partIds.has('torso') ? [{ value: 'torso', label: 'Torso' }] : []),
    ...(partIds.has('arm_L_upper') && partIds.has('arm_L_fore')
      ? [{ value: 'wrist_L', label: 'Left arm' }]
      : []),
    ...(partIds.has('arm_R_upper') && partIds.has('arm_R_fore')
      ? [{ value: 'wrist_R', label: 'Right arm' }]
      : []),
  ];
  const targetLabel = partId === 'body'
    ? 'body'
    : partId === 'wrist_L'
      ? 'left arm'
      : partId === 'wrist_R'
        ? 'right arm'
        : partId.replace('_', ' ');
  const ownedTracks = document.tracks.filter((track) => track.layerId === 'manual').length;
  const ownedSegments = document.segments.filter((segment) => segment.layerId === 'manual').length;
  const selectedTracks = document.tracks.filter((track) =>
    track.layerId === 'manual' && track.actorId === actorId && (
      partId === 'body'
        ? track.channel === 'root.position'
        : track.channel === 'part.transform' && !!track.partId && selectedPartIds.includes(track.partId)
    ));
  const selectedCount = selectedTracks.length + selectedSegments.length;
  const selectedLocked = selectedCount > 0 &&
    selectedTracks.every((track) => track.locked) && selectedSegments.every((segment) => segment.locked);
  const frameMs = 1_000 / shots.fps;
  const deleteBlocker = selectedSegment ? motionDeletionBlocker(document, selectedSegment.id) : null;

  const saveEdited = async (edited: AnimationDocument) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveAnimation(scene, edited);
      setUndoStack((items) => [...items, document].slice(-50));
      setRedoStack([]);
      onDocument(saved.document);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateSelectedSegment = async (
    edit: (segment: MotionSegment) => MotionSegment,
    { allowLocked = false }: { allowLocked?: boolean } = {},
  ) => {
    if (!selectedSegment || busy) return;
    if (selectedSegment.locked && !allowLocked) {
      setError(`Unlock ${selectedSegment.id} before editing it.`);
      return;
    }
    await saveEdited({
      ...document,
      segments: document.segments.map((segment) => segment.id === selectedSegment.id ? edit(segment) : segment),
    });
  };

  const toggleSelectedLocks = async () => {
    if (!selectedCount || busy) return;
    const trackIds = new Set(selectedTracks.map((track) => track.id));
    const segmentIds = new Set(selectedSegments.map((segment) => segment.id));
    await saveEdited({
      ...document,
      tracks: document.tracks.map((track) => trackIds.has(track.id) ? { ...track, locked: !selectedLocked } : track),
      segments: document.segments.map((segment) => segmentIds.has(segment.id)
        ? { ...segment, locked: !selectedLocked }
        : segment),
    });
  };

  const retimeEndpoint = async (edge: 'from' | 'to', deltaMs: number) => {
    if (!selectedSegment) return;
    if (selectedSegment[edge].locked) {
      setError(`Unlock the ${edge} endpoint before retiming it.`);
      return;
    }
    await updateSelectedSegment((segment) => ({
      ...segment,
      [edge]: { ...segment[edge], time: shiftAnchor(segment[edge].time, deltaMs) },
    } as MotionSegment));
  };

  const shiftSelectedSegment = async (requestedDeltaMs: number) => {
    if (!selectedSegment) return;
    if (selectedSegment.from.locked || selectedSegment.to.locked) {
      setError('Unlock both endpoints before shifting the segment.');
      return;
    }
    let deltaMs = requestedDeltaMs;
    if (selectedSegment.from.time.kind === 'absolute') deltaMs = Math.max(deltaMs, -selectedSegment.from.time.ms);
    if (selectedSegment.to.time.kind === 'absolute') deltaMs = Math.max(deltaMs, -selectedSegment.to.time.ms);
    await updateSelectedSegment((segment) => ({
      ...segment,
      from: { ...segment.from, time: shiftAnchor(segment.from.time, deltaMs) },
      to: { ...segment.to, time: shiftAnchor(segment.to.time, deltaMs) },
    } as MotionSegment));
  };

  const applyStyle = async () => {
    if (!selectedSegment) return;
    if (overshoot > 0 && recovery <= 0) {
      setError('Overshoot needs a positive recovery interval.');
      return;
    }
    if (hold + (overshoot > 0 ? recovery : 0) > 0.8) {
      setError('Hold and recovery together must leave at least 20% for the main move.');
      return;
    }
    await updateSelectedSegment((segment) => ({
      ...segment,
      easing,
      path: { shape: pathShape, curvature },
      assist: { anticipation, overshoot, hold, recovery },
    }));
  };

  const lastWaypoint = selectedSegment
    ? [...selectedSegment.waypoints].sort((a, b) => a.at - b.at).at(-1) ?? null
    : null;

  const addWaypoint = async () => {
    await updateSelectedSegment((segment) => {
      const positions = [0, ...segment.waypoints.map((waypoint) => waypoint.at).sort((a, b) => a - b), 1];
      let gapStart = 0;
      let gapEnd = 1;
      for (let index = 1; index < positions.length; index += 1) {
        if (positions[index]! - positions[index - 1]! > gapEnd - gapStart) {
          gapStart = positions[index - 1]!;
          gapEnd = positions[index]!;
        }
      }
      const at = (gapStart + gapEnd) / 2;
      let index = segment.waypoints.length;
      let id = `${segment.id}:waypoint:${String(index).padStart(3, '0')}`;
      const ids = new Set(segment.waypoints.map((waypoint) => waypoint.id));
      while (ids.has(id)) {
        index += 1;
        id = `${segment.id}:waypoint:${String(index).padStart(3, '0')}`;
      }
      return {
        ...segment,
        waypoints: [...segment.waypoints, {
          id,
          at,
          value: interpolateMotion(segment.from.value, segment.to.value, at),
          locked: false,
        }],
      } as MotionSegment;
    });
  };

  const removeLastWaypoint = async () => {
    if (!lastWaypoint || !selectedSegment) return;
    if (lastWaypoint.locked) {
      setError('Unlock the waypoint before removing it.');
      return;
    }
    await updateSelectedSegment((segment) => ({
      ...segment,
      waypoints: segment.waypoints.filter((waypoint) => waypoint.id !== lastWaypoint.id),
    } as MotionSegment));
  };

  const toggleLastWaypointLock = async () => {
    if (!lastWaypoint) return;
    await updateSelectedSegment((segment) => ({
      ...segment,
      waypoints: segment.waypoints.map((waypoint) => waypoint.id === lastWaypoint.id
        ? { ...waypoint, locked: !waypoint.locked }
        : waypoint),
    } as MotionSegment));
  };

  const nudgeLastWaypoint = async (dx: number, dy: number) => {
    if (!lastWaypoint) return;
    if (lastWaypoint.locked) {
      setError('Unlock the waypoint before moving it.');
      return;
    }
    await updateSelectedSegment((segment) => ({
      ...segment,
      waypoints: segment.waypoints.map((waypoint) => waypoint.id === lastWaypoint.id
        ? { ...waypoint, value: nudgeMotion(waypoint.value, dx, dy) }
        : waypoint),
    } as MotionSegment));
  };

  const retimeLastWaypoint = async (delta: number) => {
    if (!lastWaypoint || !selectedSegment) return;
    if (lastWaypoint.locked) {
      setError('Unlock the waypoint before retiming it.');
      return;
    }
    const ordered = [...selectedSegment.waypoints].sort((a, b) => a.at - b.at);
    const index = ordered.findIndex((waypoint) => waypoint.id === lastWaypoint.id);
    const minimum = (ordered[index - 1]?.at ?? 0) + 0.01;
    const maximum = (ordered[index + 1]?.at ?? 1) - 0.01;
    const at = Math.min(maximum, Math.max(minimum, lastWaypoint.at + delta));
    await updateSelectedSegment((segment) => ({
      ...segment,
      waypoints: segment.waypoints.map((waypoint) => waypoint.id === lastWaypoint.id
        ? { ...waypoint, at }
        : waypoint),
    } as MotionSegment));
  };

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-1.5">
        <Badge tone="good">direct manipulation</Badge>
        <span className="text-[11px] text-ink-faint">
          {ownedSegments} segment{ownedSegments === 1 ? '' : 's'} · {ownedTracks} key track{ownedTracks === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <Button variant="ghost" className="px-1.5" disabled={!undoStack.length || busy} onClick={() => void restore('undo')} title="Undo the last manual animation edit">↶</Button>
        <Button variant="ghost" className="px-1.5" disabled={!redoStack.length || busy} onClick={() => void restore('redo')} title="Redo the last undone animation edit">↷</Button>
      </div>

      <Field label="Actor">
        <Select value={actorId} options={actorIds} onChange={setActorId} className="w-full" />
      </Field>
      <Field label="Body part" hint="Choose the body part you want to move. Arm dragging poses the upper arm and forearm together.">
        <Select value={partId} options={controllers} onChange={setPartId} className="w-full" />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Travel frames">
          <NumberInput
            value={durationFrames}
            min={1}
            max={Math.max(1, shots.fps * 10)}
            onChange={(value) => setDurationFrames(Math.max(1, Math.round(value)))}
          />
        </Field>
        <Field label="Easing">
          <Select
            value={easing}
            options={['ease-in-out', 'ease-in', 'ease-out', 'linear']}
            onChange={(value) => setEasing(value as Easing)}
            className="w-full"
          />
        </Field>
      </div>

      {partId === 'body' && (
        <Field
          label="Gait"
          hint="Auto walks any move long enough to read as travel; none carries them there"
        >
          <Select
            value={gait}
            options={['auto', 'walk', 'none']}
            onChange={(value) => { void changeGait(value as Gait); }}
            className="w-full"
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Path shape">
          <Select
            value={pathShape}
            options={['linear', 'smooth', 'arc']}
            onChange={(value) => setPathShape(value as typeof pathShape)}
            className="w-full"
          />
        </Field>
        <Field label="Curve" hint="Signed arc bend">
          <NumberInput
            value={curvature}
            min={-1}
            max={1}
            step={0.05}
            onChange={(value) => setCurvature(Math.min(1, Math.max(-1, value)))}
          />
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        <Field label="Anticipate">
          <NumberInput value={anticipation} min={0} max={0.5} step={0.01} onChange={(value) => setAnticipation(Math.min(0.5, Math.max(0, value)))} />
        </Field>
        <Field label="Overshoot">
          <NumberInput value={overshoot} min={0} max={0.5} step={0.01} onChange={(value) => setOvershoot(Math.min(0.5, Math.max(0, value)))} />
        </Field>
        <Field label="Hold">
          <NumberInput value={hold} min={0} max={0.8} step={0.01} onChange={(value) => setHold(Math.min(0.8, Math.max(0, value)))} />
        </Field>
        <Field label="Recover">
          <NumberInput value={recovery} min={0} max={0.5} step={0.01} onChange={(value) => setRecovery(Math.min(0.5, Math.max(0, value)))} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2 items-end">
        <Field label="Onion frames" hint="Ghosts before/after playhead">
          <NumberInput
            value={onionSkinFrames}
            min={0}
            max={12}
            onChange={(value) => setOnionSkinFrames(Math.min(12, Math.max(0, Math.round(value))))}
          />
        </Field>
        <Button
          variant={recording ? 'danger' : 'default'}
          disabled={!actorId || busy}
          onClick={() => setRecording((active) => !active)}
          title="Capture the full route of one drag; the orange trace is smoothed into editable motion"
          className="mb-2.5"
        >
          {recording ? 'Cancel path capture' : partId.startsWith('wrist_') ? 'Record arm path' : 'Record path'}
        </Button>
      </div>

      <div className="rounded border border-accent/40 bg-accent/10 p-2 text-[11px] text-ink-dim leading-snug">
        {partId.startsWith('wrist_') ? (
          <>Drag the on-character <span className="text-ink">{targetLabel}</span> control; the rendered arm follows your pointer live. Release to save the move and show its ending pose. </>
        ) : (
          <>Drag the on-character <span className="text-ink">{targetLabel}</span> handle to set the ending pose. </>
        )}
        Choose Record path first only when you want the full route of your drag captured and smoothed.
        {partId.startsWith('wrist_') && <span> One arm control moves both arm sections.</span>}
        {recording && <span className="text-bad"> Armed for one drag: the orange line previews the captured path, then capture turns off automatically (10 second maximum).</span>}
      </div>

      {selectedSegment && (
        <div className="rounded border border-edge bg-panel-2/60 p-2 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px]">
            <Badge tone={selectedSegment.locked ? 'warn' : 'neutral'}>{selectedSegment.source}</Badge>
            <span className="text-ink-dim truncate" title={selectedSegment.id}>{selectedSegment.path.shape} path</span>
            <span className="text-ink-faint">
              {selectedSegment.waypoints.length} waypoint{selectedSegment.waypoints.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="text-[10px] uppercase tracking-wide text-ink-faint">Segment timing · one frame</div>
          <div className="grid grid-cols-3 gap-1">
            <Button disabled={busy || selectedSegment.locked || selectedSegment.from.locked} onClick={() => void retimeEndpoint('from', -frameMs)}>Start −</Button>
            <Button disabled={busy || selectedSegment.locked || selectedSegment.to.locked} onClick={() => void retimeEndpoint('to', -frameMs)}>End −</Button>
            <Button disabled={busy || selectedSegment.locked || selectedSegment.from.locked || selectedSegment.to.locked} onClick={() => void shiftSelectedSegment(-frameMs)}>Shift −</Button>
            <Button disabled={busy || selectedSegment.locked || selectedSegment.from.locked} onClick={() => void retimeEndpoint('from', frameMs)}>Start +</Button>
            <Button disabled={busy || selectedSegment.locked || selectedSegment.to.locked} onClick={() => void retimeEndpoint('to', frameMs)}>End +</Button>
            <Button disabled={busy || selectedSegment.locked || selectedSegment.from.locked || selectedSegment.to.locked} onClick={() => void shiftSelectedSegment(frameMs)}>Shift +</Button>
          </div>

          <div className="flex gap-1">
            <Button className="flex-1" disabled={busy || selectedSegment.locked} onClick={() => void addWaypoint()}>Add waypoint</Button>
            <Button disabled={busy || !lastWaypoint || selectedSegment.locked || lastWaypoint.locked} onClick={() => void removeLastWaypoint()}>Remove</Button>
            <Button disabled={busy || !lastWaypoint || selectedSegment.locked} onClick={() => void toggleLastWaypointLock()}>
              {lastWaypoint?.locked ? 'Unlock point' : 'Lock point'}
            </Button>
          </div>

          {lastWaypoint && (
            <div className="grid grid-cols-6 gap-1" title="Edit the last waypoint in path order">
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void retimeLastWaypoint(-0.05)}>Time −</Button>
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void retimeLastWaypoint(0.05)}>Time +</Button>
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void nudgeLastWaypoint(-5, 0)}>←</Button>
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void nudgeLastWaypoint(0, -5)}>↑</Button>
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void nudgeLastWaypoint(0, 5)}>↓</Button>
              <Button disabled={busy || selectedSegment.locked || lastWaypoint.locked} onClick={() => void nudgeLastWaypoint(5, 0)}>→</Button>
            </div>
          )}

          <Button className="w-full" disabled={busy || selectedSegment.locked} onClick={() => void applyStyle()}>
            Apply easing, path & assist
          </Button>
          <Button
            variant="danger"
            className="w-full"
            disabled={busy || Boolean(deleteBlocker)}
            title={deleteBlocker ?? 'Delete this complete motion segment from the timeline'}
            onClick={() => onDeleteSegment(selectedSegment.id)}
          >
            Delete motion segment
          </Button>
        </div>
      )}

      <div className="flex gap-1">
        <Button
          className="flex-1"
          disabled={!target || busy}
          onClick={() => onTarget(target)}
          title="Re-enable the selected preview handle"
        >
          {busy ? <><Spinner /> Saving motion…</> : `Handle active · ${Math.round(playheadMs)} ms`}
        </Button>
        <Button
          disabled={!selectedCount || busy}
          onClick={() => void toggleSelectedLocks()}
          title="Locked motion survives automation and must be explicitly unlocked before editing"
        >
          {selectedLocked ? 'Unlock' : 'Lock'}
        </Button>
      </div>

      {error && <div className="text-[11px] text-bad">{error}</div>}
    </div>
  );
}
