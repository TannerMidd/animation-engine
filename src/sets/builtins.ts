import { DEFAULT_WALKABLE_AREA, defaultParallax, type SetDescriptor } from './schema.ts';

/**
 * Builtin sets, materialised into `sets/` on first use.
 *
 * They live in code rather than as checked-in JSON so a fresh clone can render
 * without any asset step — the same reasoning as the placeholder puppets. Once
 * written to disk they are yours to edit, and the engine never rewrites them.
 */

/**
 * The original office, rebuilt from props.
 *
 * Geometry carried over from the hardcoded version it replaces, so the
 * migration is a like-for-like rebuild rather than a redesign.
 */
const office: SetDescriptor = {
  name: 'office',
  palette: 'office-fluorescent',
  layout: { horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220, walkable: { ...DEFAULT_WALKABLE_AREA }, parallax: defaultParallax() },
  layers: {
    back: [
      { prop: 'room-wall', scale: 1, flip: false, params: { bandHeight: 150, railWidth: 6 } },
      { prop: 'room-ceiling', scale: 1, flip: false, params: { gridOffset: 58 } },
      { prop: 'room-floor', scale: 1, flip: false, params: { bandOffset: 96 } },
      { prop: 'ceiling-light', x: 300, scale: 1, flip: false, params: { width: 240 } },
      { prop: 'ceiling-light', x: 980, scale: 1, flip: false, params: { width: 240 } },
      { prop: 'cubicle-panel', x: -10, scale: 1, flip: false, params: { width: 260, height: 274 } },
      { prop: 'cubicle-panel', x: 1310, scale: 1, flip: false, params: { width: 300, height: 286 } },
      { prop: 'clock', x: 640, scale: 1, flip: false, params: { radius: 30, y: 430 } },
    ],
    mid: [
      { prop: 'desk', x: 221, scale: 1, flip: false, params: { width: 250, height: 96 } },
      { prop: 'monitor', x: 221, y: 470, scale: 1, flip: false, params: { width: 108, height: 76 } },
      { prop: 'plant', x: 1075, scale: 1, flip: false, params: { height: 130, leaves: 3 } },
    ],
    fore: [],
  },
};

/** Proves the system generalises: same props, different palette and layout. */
const diveBar: SetDescriptor = {
  name: 'dive-bar',
  palette: 'bar-night',
  layout: { horizonY: 580, ceilingY: 70, marginX: 420, marginY: 220, walkable: { ...DEFAULT_WALKABLE_AREA }, parallax: defaultParallax() },
  layers: {
    back: [
      { prop: 'room-wall', scale: 1, flip: false, params: { bandHeight: 180, railWidth: 5 } },
      { prop: 'room-ceiling', scale: 1, flip: false, params: { gridOffset: 0 } },
      { prop: 'room-floor', scale: 1, flip: false, params: { bandOffset: 110 } },
      { prop: 'neon-sign', x: 330, scale: 1, flip: false, params: { text: 'OPEN', y: 400, size: 46 } },
      { prop: 'bottle-shelf', x: 950, scale: 1, flip: false, params: { width: 320, y: 250, rows: 2 } },
      { prop: 'booth', x: 120, scale: 1, flip: false, params: { width: 260, height: 210 } },
      { prop: 'tv', x: 640, scale: 1, flip: false, params: { width: 190, height: 115, y: 330, on: true } },
    ],
    mid: [{ prop: 'bar-counter', x: 950, scale: 1, flip: false, params: { width: 520, height: 150 } }],
    // Stools in front, so a character can stand between the bar and the camera.
    fore: [
      { prop: 'stool', x: 760, scale: 1, flip: false, params: { height: 130 } },
      { prop: 'stool', x: 1180, scale: 1, flip: false, params: { height: 130 } },
    ],
  },
};

/** An exterior, to prove sky/ground works as well as walls and ceilings. */
const roadside: SetDescriptor = {
  name: 'roadside',
  palette: 'exterior-dusk',
  layout: { horizonY: 560, ceilingY: 0, marginX: 420, marginY: 220, walkable: { ...DEFAULT_WALKABLE_AREA }, parallax: defaultParallax() },
  layers: {
    back: [
      { prop: 'sky', scale: 1, flip: false, params: { bandHeight: 150 } },
      { prop: 'room-floor', scale: 1, flip: false, params: { bandOffset: 120 } },
      { prop: 'moon', x: 260, scale: 1, flip: false, params: { radius: 46, y: 540 } },
      { prop: 'cloud', x: 820, scale: 1, flip: false, params: { width: 240, y: 470 } },
      { prop: 'facade', x: 1230, scale: 1, flip: false, params: { width: 340, height: 430, floors: 3, windowsPerFloor: 3, lit: true } },
      { prop: 'tree', x: 130, scale: 1, flip: false, params: { height: 430, spread: 165, trunk: 34 } },
    ],
    mid: [
      { prop: 'streetlight', x: 430, scale: 1, flip: false, params: { height: 460, lit: true } },
      { prop: 'road-sign', x: 900, scale: 1, flip: false, params: { text: 'STOP', height: 210, width: 120 } },
    ],
    fore: [
      { prop: 'bush', x: 200, scale: 1, flip: false, params: { width: 150, height: 80 } },
      { prop: 'rock', x: 1120, scale: 1, flip: false, params: { width: 120, height: 66 } },
    ],
  },
};

export const BUILTIN_SETS: Record<string, SetDescriptor> = {
  office,
  'dive-bar': diveBar,
  roadside,
};

export const BUILTIN_SET_NAMES = Object.keys(BUILTIN_SETS);
