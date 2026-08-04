/**
 * Screen ↔ stage ↔ world mapping for the stage overlay.
 *
 * Three spaces:
 * - client px: pointer event coordinates.
 * - stage px: the preview page's own pixels (0..width × 0..height). The iframe
 *   is laid out at natural size and CSS-scaled, so iframe-internal client px
 *   equal stage px — `elementFromPoint` on the inner document takes these.
 * - world: scene units under the active camera viewBox. Actor roots, prop
 *   positions and motion values live here.
 *
 * All functions are pure so the mapping is unit-testable away from the DOM;
 * callers supply the frame box origin from getBoundingClientRect at event time.
 */

export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stage natural size plus the CSS scale the frame box is rendered at. */
export interface FrameGeom {
  width: number;
  height: number;
  scale: number;
}

export function clientToStage(
  g: FrameGeom,
  frameLeft: number,
  frameTop: number,
  clientX: number,
  clientY: number,
): [number, number] {
  return [(clientX - frameLeft) / g.scale, (clientY - frameTop) / g.scale];
}

export function stageToWorld(cam: CameraRect, g: FrameGeom, p: [number, number]): [number, number] {
  return [cam.x + (p[0] / g.width) * cam.w, cam.y + (p[1] / g.height) * cam.h];
}

export function worldToStage(cam: CameraRect, g: FrameGeom, p: [number, number]): [number, number] {
  return [((p[0] - cam.x) / cam.w) * g.width, ((p[1] - cam.y) / cam.h) * g.height];
}

/** World → CSS px inside the frame box (which is width*scale × height*scale). */
export function worldToOverlay(cam: CameraRect, g: FrameGeom, p: [number, number]): [number, number] {
  const stage = worldToStage(cam, g, p);
  return [stage[0] * g.scale, stage[1] * g.scale];
}

export function clientToWorld(
  cam: CameraRect,
  g: FrameGeom,
  frameLeft: number,
  frameTop: number,
  clientX: number,
  clientY: number,
): [number, number] {
  return stageToWorld(cam, g, clientToStage(g, frameLeft, frameTop, clientX, clientY));
}

/** How many world units one CSS pixel spans — for screen-constant thresholds. */
export function worldPerCssPx(cam: CameraRect, g: FrameGeom): number {
  return cam.w / (g.width * g.scale);
}

/**
 * The parallax translation currently applied to one set layer.
 *
 * Read back off the preview document rather than recomputed here. The overlay's
 * only job is to put a handle on top of the art, so the one number that can
 * never be wrong is the one the renderer actually used — recomputing it would
 * add a second implementation of the depth maths whose whole purpose is to agree
 * with the first.
 *
 * A layer with no parallax carries no transform at all, so the common case is
 * the early return.
 */
export function layerParallaxOffset(
  doc: Document | null | undefined,
  layer: string,
): [number, number] {
  const value = doc?.getElementById(`set-${layer}`)?.getAttribute('transform');
  if (!value) return [0, 0];
  const match = /^translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(value);
  if (!match) return [0, 0];
  const dx = Number(match[1]);
  const dy = Number(match[2]);
  return Number.isFinite(dx) && Number.isFinite(dy) ? [dx, dy] : [0, 0];
}
