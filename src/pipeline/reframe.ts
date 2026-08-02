import type { IRCamera, IRFrame, SceneIR } from '../schema/ir.ts';

/** Social portrait master. The camera is recomposed, never pixel-cropped. */
export const PORTRAIT_MASTER = { width: 720, height: 1280 } as const;

export interface PortraitReframeOptions {
  width?: number;
  height?: number;
  /** Approximate breathing room around the outermost focal actor, in set units. */
  actorMargin?: number;
  /** Portrait-native cards generated from the same identity template. */
  cards?: SceneIR['meta']['cards'];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function focalActors(frame: IRFrame): Array<{ x: number; y: number }> {
  const visible = Object.values(frame.actors).filter((actor) => actor.visible);
  if (!visible.length) return [];
  const { camera } = frame;
  const padX = camera.w * 0.18;
  const padY = camera.h * 0.2;
  const inComposition = visible.filter((actor) => (
    actor.x >= camera.x - padX && actor.x <= camera.x + camera.w + padX &&
    actor.y >= camera.y - padY && actor.y <= camera.y + camera.h + padY
  ));
  return (inComposition.length ? inComposition : visible).map((actor) => ({ x: actor.x, y: actor.y }));
}

/**
 * Recompose one baked frame for a portrait viewport.
 *
 * The existing shot remains the editorial source: its vertical field of view
 * and screen-side bias are retained. Visible actors inside that composition
 * determine the horizontal centre and, for ensembles, widen the portrait
 * camera enough to keep the relationship readable. This differs from a centre
 * crop because a speaker at FAR_L produces a FAR_L portrait camera.
 */
export function portraitCamera(frame: IRFrame, source: SceneIR['meta'], options: PortraitReframeOptions = {}): IRCamera {
  const width = options.width ?? PORTRAIT_MASTER.width;
  const height = options.height ?? PORTRAIT_MASTER.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('portrait dimensions must be positive finite numbers');
  }
  const aspect = width / height;
  const margin = options.actorMargin ?? 150;
  const original = frame.camera;
  const actors = focalActors(frame);
  const originalCenterX = original.x + original.w / 2;
  const originalCenterY = original.y + original.h / 2;

  let centreX = originalCenterX;
  let neededWidth = original.h * aspect;
  if (actors.length) {
    const xs = actors.map((actor) => actor.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    centreX = (minX + maxX) / 2;
    neededWidth = Math.max(neededWidth, maxX - minX + margin * 2);

    // Preserve a meaningful left/right screen-side choice for a single. The
    // offset is modest so captions still have safe central room.
    if (actors.length === 1 && original.w > 0) {
      const side = clamp((actors[0]!.x - original.x) / original.w, 0, 1);
      const desiredFraction = side < 0.42 ? 0.4 : side > 0.58 ? 0.6 : 0.5;
      centreX += (0.5 - desiredFraction) * neededWidth;
    }
  }

  // A portrait frame may reveal more set vertically to keep a two-shot, but it
  // never invents a tighter vertical crop than the approved horizontal shot.
  const cameraWidth = clamp(neededWidth, source.width * 0.14, source.width * 1.15);
  const cameraHeight = cameraWidth / aspect;
  const setMarginX = source.width * 0.22;
  const setMarginY = source.height * 0.34;
  const x = clamp(centreX - cameraWidth / 2, -setMarginX, source.width + setMarginX - cameraWidth);
  const y = clamp(originalCenterY - cameraHeight / 2, -setMarginY, source.height + setMarginY - cameraHeight);
  return { x, y, w: cameraWidth, h: cameraHeight };
}

/** Build a second deterministic IR for portrait capture and encoding. */
export function reframeScenePortrait(input: SceneIR, options: PortraitReframeOptions = {}): SceneIR {
  const width = Math.round(options.width ?? PORTRAIT_MASTER.width);
  const height = Math.round(options.height ?? PORTRAIT_MASTER.height);
  if (width < 1 || height < 1) throw new Error('portrait dimensions must be positive');
  const frames = input.frames.map((frame) => ({
    ...frame,
    camera: portraitCamera(frame, input.meta, { ...options, width, height }),
  }));
  return {
    ...input,
    meta: {
      ...input.meta,
      width,
      height,
      cards: options.cards ?? input.meta.cards,
    },
    frames,
  };
}
