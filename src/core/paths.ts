import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { projectId, resolveWithin } from './project.ts';

/** Project root, resolved from this module's location rather than cwd. */
export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const CAST_DIR = path.join(ROOT, 'cast');
export const SETS_DIR = path.join(ROOT, 'sets');
export const SCRIPTS_DIR = path.join(ROOT, 'scripts');
export const OUT_DIR = path.join(ROOT, 'out');
export const SHOW_DIR = path.join(ROOT, 'show');
/** Baked props: procedural source, bake config, and the committed geometry. */
export const PROPS_DIR = path.join(ROOT, 'props');

/** Per-scene working directory. Holds audio, timing, IR, frames and the final MP4. */
export function sceneDir(scene: string): string {
  return resolveWithin(OUT_DIR, projectId(scene, 'scene name'));
}
