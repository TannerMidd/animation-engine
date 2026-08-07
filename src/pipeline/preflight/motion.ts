import { sampleMotionSegment, type ResolvedAnimation } from '../../compile/animation.ts';
import { MARKS, type ShotList } from '../../schema/script.ts';
import { DEFAULT_WALKABLE_AREA, type WalkableArea } from '../../sets/schema.ts';
import type {
  ProductionPreflightInput,
  ProductionPreflightLevel,
  ProductionPreflightNote,
  ProductionPreflightTarget,
} from '../preflight.ts';

export const REPEATED_GESTURE_WARNING_COUNT = 3;
export const GENERIC_TALK_WARNING_COUNT = 5;
export const LONG_POSE_HOLD_WARNING_MS = 3_000;

function addNote(
  notes: ProductionPreflightNote[],
  level: ProductionPreflightLevel,
  code: string,
  message: string,
  target?: ProductionPreflightTarget,
): void {
  if (notes.some((item) => item.code === code && item.message === message)) return;
  notes.push({ code, level, blocking: level === 'error', message, ...(target ? { target } : {}) });
}

function normalizedGesture(gesture: string): string {
  return gesture === 'TALK_A' || gesture === 'TALK_B' ? 'TALK' : gesture;
}

export function inspectGestureQuality(shots: ShotList, notes: ProductionPreflightNote[]): void {
  const histories = new Map<string, { gesture: string | null; run: number }>();
  for (const beat of shots.beats) {
    if (beat.kind !== 'line') continue;
    const gesture = normalizedGesture(beat.gesture);
    const state = histories.get(beat.speaker) ?? { gesture: null, run: 0 };
    state.run = state.gesture === gesture ? state.run + 1 : 1;
    state.gesture = gesture;
    histories.set(beat.speaker, state);
    const threshold = gesture === 'TALK' ? GENERIC_TALK_WARNING_COUNT : REPEATED_GESTURE_WARNING_COUNT;
    if (gesture !== 'NONE' && state.run === threshold) {
      addNote(
        notes,
        'warn',
        gesture === 'TALK' ? 'motion-generic-repetition' : 'motion-gesture-repetition',
        `"${beat.speaker}" repeats ${gesture} for ${state.run} consecutive speaking beats; vary the gesture or deliberately choose stillness`,
      );
    }
  }
}

function walkableFor(input: ProductionPreflightInput): WalkableArea {
  return input.setDescriptor?.layout.walkable ?? { ...DEFAULT_WALKABLE_AREA };
}

function pointInArea(point: readonly [number, number], area: WalkableArea): boolean {
  const [x, y] = point;
  return (
    x >= area.x - 1e-7 &&
    x <= area.x + area.width + 1e-7 &&
    y >= area.y - 1e-7 &&
    y <= area.y + area.height + 1e-7
  );
}

function areaLabel(area: WalkableArea): string {
  return `${area.x},${area.y} through ${area.x + area.width},${area.y + area.height}`;
}

export function inspectWalkableBlocking(
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
): void {
  const { shots } = input;
  if (!shots) return;
  const area = walkableFor(input);
  const positions = new Map(
    shots.cast.map((member) => [
      member.id,
      [member.position?.x ?? shots.width * MARKS[member.mark], member.position?.y ?? shots.height * 0.97] as [
        number,
        number,
      ],
    ]),
  );

  for (const member of shots.cast) {
    const position = positions.get(member.id)!;
    if (member.visible && !pointInArea(position, area)) {
      addNote(
        notes,
        'error',
        'blocking-outside-walkable',
        `visible actor "${member.id}" starts at ${Math.round(position[0])},${Math.round(position[1])}, outside set walkable area ${areaLabel(area)}`,
      );
    }
  }

  for (const beat of shots.beats) {
    if (beat.kind !== 'action') continue;
    for (const action of beat.stage) {
      if (action.type !== 'move' && action.type !== 'enter') continue;
      const current = positions.get(action.actor);
      if (!current) continue;
      const target = action.to;
      const next: [number, number] = [
        target?.x ?? (target?.mark ? shots.width * MARKS[target.mark] : current[0]),
        target?.y ?? current[1],
      ];
      positions.set(action.actor, next);
      if (!pointInArea(next, area)) {
        addNote(
          notes,
          'error',
          'blocking-outside-walkable',
          `beat "${beat.id}" ${action.type.toUpperCase()} for "${action.actor}" ends at ${Math.round(next[0])},${Math.round(next[1])}, outside set walkable area ${areaLabel(area)}`,
        );
      }
    }
  }
}

function motionValueSignature(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'number' ? Math.round(item * 100) / 100 : item,
  );
}

export function inspectResolvedMotionQuality(
  resolved: ResolvedAnimation,
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
): void {
  const area = walkableFor(input);
  for (const item of resolved.tracks) {
    if (!item.layer.enabled || !item.track.enabled) continue;
    if (item.track.channel === 'root.position') {
      const outside = item.keys.find((key) => !pointInArea(key.value as [number, number], area));
      if (outside) {
        const [x, y] = outside.value as [number, number];
        addNote(
          notes,
          'error',
          'animation-outside-walkable',
          `animation track "${item.track.id}" puts "${item.track.actorId}" at ${Math.round(x)},${Math.round(y)}, outside set walkable area ${areaLabel(area)}`,
        );
      }
    }
    if (item.track.channel !== 'part.transform') continue;
    for (let index = 0; index < item.keys.length - 1; index++) {
      const left = item.keys[index]!;
      const right = item.keys[index + 1]!;
      const duration = right.timeMs - left.timeMs;
      if (left.interpolation === 'hold' && duration >= LONG_POSE_HOLD_WARNING_MS) {
        addNote(
          notes,
          'warn',
          'animation-long-pose-hold',
          `animation track "${item.track.id}" holds ${item.track.partId} unchanged for ${Math.round(duration)}ms; confirm this is intentional`,
        );
      }
    }
    const tail = resolved.timeline.durationMs - item.keys.at(-1)!.timeMs;
    if (tail >= LONG_POSE_HOLD_WARNING_MS * 2) {
      addNote(
        notes,
        'warn',
        'animation-long-pose-hold',
        `animation track "${item.track.id}" leaves ${item.track.partId} in its final authored pose for ${Math.round(tail)}ms through scene end`,
      );
    }
  }

  const recentSegments = new Map<string, { signature: string | null; run: number }>();
  for (const item of resolved.segments) {
    if (!item.layer.enabled || !item.segment.enabled) continue;
    const segment = item.segment;
    if (segment.channel === 'root.position') {
      let outside: [number, number] | null = null;
      for (let step = 0; step <= 20; step++) {
        const atMs = item.startMs + (item.endMs - item.startMs) * (step / 20);
        const value = sampleMotionSegment(item, atMs) as [number, number] | undefined;
        if (value && !pointInArea(value, area)) {
          outside = value;
          break;
        }
      }
      if (outside) {
        addNote(
          notes,
          'error',
          'animation-outside-walkable',
          `motion segment "${segment.id}" leaves set walkable area ${areaLabel(area)} at ${Math.round(outside[0])},${Math.round(outside[1])}`,
        );
      }
    }

    const holdMs = (item.endMs - item.startMs) * segment.assist.hold;
    if (holdMs >= LONG_POSE_HOLD_WARNING_MS) {
      addNote(
        notes,
        'warn',
        'animation-long-pose-hold',
        `motion segment "${segment.id}" authors a ${Math.round(holdMs)}ms endpoint hold; confirm it is a deliberate pose`,
      );
    }

    const key = `${segment.actorId}:${segment.channel}:${segment.channel === 'part.transform' ? segment.partId : ''}`;
    const signature = `${motionValueSignature(segment.from.value)}>${motionValueSignature(segment.to.value)}`;
    const state = recentSegments.get(key) ?? { signature: null, run: 0 };
    state.run = state.signature === signature ? state.run + 1 : 1;
    state.signature = signature;
    recentSegments.set(key, state);
    if (state.run === REPEATED_GESTURE_WARNING_COUNT) {
      addNote(
        notes,
        'warn',
        'animation-motion-repetition',
        `"${segment.actorId}" repeats the same ${segment.channel} motion ${state.run} times; offset its path, timing, or endpoint`,
      );
    }
  }
}
