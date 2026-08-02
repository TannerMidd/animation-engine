import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Project root, resolved from this module's location rather than cwd. */
export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const CAST_DIR = path.join(ROOT, 'cast');
export const SETS_DIR = path.join(ROOT, 'sets');
export const SCRIPTS_DIR = path.join(ROOT, 'scripts');
export const OUT_DIR = path.join(ROOT, 'out');
export const SHOW_DIR = path.join(ROOT, 'show');

/** Per-scene working directory. Holds audio, timing, IR, frames and the final MP4. */
export function sceneDir(scene: string): string {
  return path.join(OUT_DIR, scene);
}
