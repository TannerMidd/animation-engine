import fs from 'node:fs/promises';
import path from 'node:path';
import { SCRIPTS_DIR, sceneDir } from '../core/paths.ts';
import { atomicWriteFile } from '../core/files.ts';
import { projectId, resolveWithin } from '../core/project.ts';
import { SHOT_LIST_SCHEMA_VERSION, ShotList } from '../schema/script.ts';

/**
 * Scene storage.
 *
 * A scene is a script file plus, once directed, a shot list. Both are plain
 * files on disk — the UI edits exactly the same things you would edit by hand,
 * so nothing is hidden in an app-only format.
 */

export function scriptPath(scene: string): string {
  return resolveWithin(SCRIPTS_DIR, `${projectId(scene, 'scene name')}.md`);
}

export function shotlistPath(scene: string): string {
  return path.join(sceneDir(scene), 'shotlist.json');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listScenes(): Promise<string[]> {
  try {
    const files = await fs.readdir(SCRIPTS_DIR);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export async function readScript(scene: string): Promise<string> {
  return fs.readFile(scriptPath(scene), 'utf8');
}

export async function writeScript(scene: string, source: string): Promise<void> {
  await atomicWriteFile(scriptPath(scene), source);
}

export async function readShotList(scene: string): Promise<ShotList | null> {
  const file = shotlistPath(scene);
  if (!(await exists(file))) return null;
  return ShotList.parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

export async function writeShotList(scene: string, shots: ShotList): Promise<void> {
  if (shots.scene !== scene) {
    throw new Error(`cannot save shot list for scene "${shots.scene}" as "${scene}"`);
  }
  const document = ShotList.parse({ ...shots, schemaVersion: SHOT_LIST_SCHEMA_VERSION });
  const file = shotlistPath(scene);
  await atomicWriteFile(file, JSON.stringify(document, null, 2) + '\n');
}

/** Where a recorded VO override for a given beat would live. */
export function voPath(scene: string, beatIndex: number, speaker: string): string {
  return path.join(sceneDir(scene), 'vo', `${String(beatIndex).padStart(3, '0')}-${speaker}.wav`);
}

export function outputPath(scene: string): string {
  return path.join(sceneDir(scene), `${scene}.mp4`);
}
