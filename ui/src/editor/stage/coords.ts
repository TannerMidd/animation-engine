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
