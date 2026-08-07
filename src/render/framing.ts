import type { IRCamera } from '../schema/index.ts';
import type { Shot, CameraMove } from '../schema/script.ts';
import { activeIdentity } from '../show/context.ts';

/**
 * Shot names to camera viewBoxes.
 *
 * The camera is just a viewBox over the set's coordinate space, so "cutting" is
 * an instantaneous viewBox swap and costs nothing. Framing is derived from
 * where the actors actually are and where their faces actually are, rather than
 * from hardcoded rectangles, so restaging a scene reframes it automatically.
 */

export interface ActorFrameInfo {
  id: string;
  /** Anchor position in set coordinates. */
  x: number;
  y: number;
  scale: number;
  /** Face position in set coordinates, derived from the rig's focus point. */
  headX: number;
  headY: number;
  /**
   * Half the head's height in set coordinates.
   *
   * Close-ups are framed from this rather than from a fraction of the stage,
   * because head size is now a per-character property — a squat build with the
   * head slider up is nearly twice the height of a lanky one. A fixed CU
   * rectangle that suited the average crops the crown off the large ones.
   */
  headR: number;
}

export interface Stage {
  width: number;
  height: number;
}

/** Shot width as a fraction of stage width. Used by the shots that frame bodies. */
const SHOT_WIDTH: Record<Shot, number> = {
  WIDE: 1.0,
  MID: 0.62,
  OTS: 0.56,
  TWO_SHOT: 0.8,
  CU: 0.3,
  ECU: 0.18,
};

/**
 * How much of the frame's height the head fills, for the shots that are *about*
 * the head. A close-up is defined by how big the face is, not by how many stage
 * units happen to be visible.
 */
const HEAD_FILL: Partial<Record<Shot, number>> = {
  CU: 0.52,
  ECU: 0.8,
};

/**
 * How far below the face the frame centres, as a fraction of frame height.
 *
 * A close-up centred exactly on the eyes leaves too much headroom and reads as
 * badly composed; dropping the centre slightly puts the face in the upper third.
 */
const VERTICAL_BIAS: Record<Shot, number> = {
  WIDE: 0,
  MID: 0.22,
  OTS: 0.22,
  TWO_SHOT: 0.2,
  CU: 0.12,
  ECU: 0.06,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function baseFrame(
  shot: Shot,
  focus: string[],
  actors: ActorFrameInfo[],
  stage: Stage,
): IRCamera {
  const aspect = stage.height / stage.width;

  // An empty focus list means "everyone" — used by WIDE and TWO_SHOT.
  const targets = focus.length ? actors.filter((a) => focus.includes(a.id)) : actors;
  const subjects = targets.length ? targets : actors;

  if (shot === 'WIDE' || !subjects.length) {
    return { x: 0, y: 0, w: stage.width, h: stage.height };
  }

  let w = stage.width * SHOT_WIDTH[shot];

  // A two-shot has to actually contain both people, however they are staged.
  if (shot === 'TWO_SHOT' && subjects.length > 1) {
    const xs = subjects.map((a) => a.headX);
    const spread = Math.max(...xs) - Math.min(...xs);
    w = clamp(spread * 1.9, stage.width * 0.55, stage.width);
  }

  // Close-ups size themselves to the biggest head in shot. Clamped at both ends
  // so an extreme character still gets a recognisable close-up rather than a
  // frame that has quietly become a mid or an eyeball.
  const fill = HEAD_FILL[shot];
  if (fill) {
    const headR = Math.max(...subjects.map((a) => a.headR));
    if (headR > 0) {
      const h = (headR * 2) / fill;
      w = clamp(h / aspect, stage.width * 0.16, stage.width * 0.52);
    }
  }

  const h = w * aspect;

  const cx = subjects.reduce((s, a) => s + a.headX, 0) / subjects.length;
  const cy = subjects.reduce((s, a) => s + a.headY, 0) / subjects.length + h * VERTICAL_BIAS[shot];

  let x = cx - w / 2;
  const y = cy - h / 2;

  // An over-the-shoulder pushes the speaker off centre, leaving room where the
  // listener would be.
  if (shot === 'OTS' && subjects.length === 1) {
    const speaker = subjects[0]!;
    const otherSide = actors.find((a) => a.id !== speaker.id);
    const dir = otherSide && otherSide.headX > speaker.headX ? 1 : -1;
    x += dir * w * 0.16;
  }

  // Deliberately not clamped to the stage bounds. Clamping keeps the camera
  // inside the set, but it also means a close-up on anyone standing off-centre
  // gets shoved sideways until they are no longer centred in their own shot,
  // which looks like a framing bug. Sets are drawn wider than the WIDE frame
  // for exactly this reason — the margin is there to be used.
  return { x, y, w, h };
}

/** Deterministic jitter for SHAKE — a function of frame index, not call order. */
function shakeOffset(frame: number, axis: number): number {
  let h = Math.imul(frame + 1, 0x27d4eb2d) ^ Math.imul(axis + 7, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296 - 0.5;
}

/**
 * Apply a camera move.
 *
 * `t` is progress through the beat, 0 to 1. Moves are applied to the base frame
 * rather than baked into it so that changing a shot size doesn't invalidate the
 * move on top of it.
 */
export function applyMove(
  cam: IRCamera,
  move: CameraMove,
  t: number,
  frame: number,
  stage: Stage,
): IRCamera {
  if (move === 'HOLD') return cam;

  // Ease-in-out. A linear push reads as mechanical.
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  switch (move) {
    case 'PUSH_IN':
    case 'PULL_OUT': {
      // Deliberately small. A big move draws attention to the camera; the point
      // of a slow push here is that you feel it without noticing it.
      const amount = 0.09;
      const k = move === 'PUSH_IN' ? 1 - amount * e : 1 - amount * (1 - e);
      const w = cam.w * k;
      const h = cam.h * k;
      return { x: cam.x + (cam.w - w) / 2, y: cam.y + (cam.h - h) / 2, w, h };
    }
    case 'PAN_L':
    case 'PAN_R': {
      const dir = move === 'PAN_R' ? 1 : -1;
      const travel = cam.w * 0.18 * e * dir;
      const x = clamp(cam.x + travel, 0, Math.max(0, stage.width - cam.w));
      return { ...cam, x };
    }
    case 'SHAKE': {
      // Decays over the beat, so an angry line snaps and then settles.
      const decay = Math.max(0, 1 - t * 1.6);
      const amp = cam.w * 0.012 * decay;
      return {
        ...cam,
        x: cam.x + shakeOffset(frame, 0) * amp,
        y: cam.y + shakeOffset(frame, 1) * amp,
      };
    }
    case 'SNAP_IN': {
      // The stepped punch-in. Deliberately NO easing anywhere: the frame is one
      // size, then it is instantly another size, then it holds. The steps land
      // early in the beat so the line plays inside the tightened frame.
      const snap = activeIdentity().editorial.snapIn;
      const stepAt = (i: number) => 0.06 + i * 0.1;
      let taken = 0;
      for (let i = 0; i < snap.steps; i++) {
        if (t >= stepAt(i)) taken = i + 1;
      }
      if (taken === 0) return cam;
      const k = 1 - (snap.amount * taken) / snap.steps;
      const w = cam.w * k;
      const h = cam.h * k;
      return { x: cam.x + (cam.w - w) / 2, y: cam.y + (cam.h - h) / 2, w, h };
    }
    default:
      return cam;
  }
}
