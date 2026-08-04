import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../core/paths.ts';

/**
 * Blender, as an optional authoring tool.
 *
 * It bakes 3D geometry down to the flat polylines a prop is made of, and that is
 * the entire extent of its involvement: the output is committed, so rendering a
 * scene never needs Blender installed. Its absence costs you the ability to
 * re-bake, not the ability to work — which is why every message here says so
 * rather than reading as a broken toolchain.
 */

/** Minimum version. We use only mesh/bmesh/mathutils, stable since 2.8. */
export const MIN_BLENDER = [3, 6] as const;

let cachedExe: string | null | undefined;

/**
 * Locate the Blender executable: the BLENDER env var, then tools/, then PATH.
 *
 * Same asymmetry as the other tool finders. An explicitly set but wrong env var
 * throws, because someone pointed at a specific build and silently ignoring that
 * is worse than stopping. A missing bundled copy returns null and the caller
 * decides whether that matters.
 */
export async function findBlender(): Promise<string | null> {
  if (cachedExe !== undefined) return cachedExe;

  const fromEnv = process.env['BLENDER'];
  if (fromEnv) {
    try {
      await fs.access(fromEnv);
      cachedExe = fromEnv;
      return cachedExe;
    } catch {
      throw new Error(`BLENDER is set to "${fromEnv}" but nothing is there`);
    }
  }

  const toolsDir = path.join(ROOT, 'tools');
  try {
    for (const entry of (await fs.readdir(toolsDir)).sort()) {
      for (const exe of ['blender.exe', 'blender']) {
        const candidate = path.join(toolsDir, entry, exe);
        try {
          await fs.access(candidate);
          cachedExe = candidate;
          return cachedExe;
        } catch {
          // Keep looking.
        }
      }
    }
  } catch {
    // No tools directory at all.
  }

  // A bundled build wins over PATH deliberately, matching ffmpeg: a stale
  // system Blender producing subtly different geometry is worse than none.
  cachedExe = null;
  return null;
}

/** Reset the memo. Tests only — discovery is process-lifetime otherwise. */
export function resetBlenderCache(): void {
  cachedExe = undefined;
}

export interface BlenderVersion {
  raw: string;
  major: number;
  minor: number;
}

export function parseBlenderVersion(output: string): BlenderVersion | null {
  const match = /Blender\s+(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return { raw: match[0], major: Number(match[1]), minor: Number(match[2]) };
}

export function blenderVersion(exe: string): Promise<BlenderVersion | null> {
  return new Promise((resolve) => {
    const proc = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += String(d)));
    proc.on('error', () => resolve(null));
    proc.on('close', () => resolve(parseBlenderVersion(out)));
  });
}

/**
 * Environment for a Blender child process.
 *
 * Blender writes temp files and, given the chance, config into the user profile
 * on the system drive — the same class of problem that put several gigabytes of
 * model weights there before the models root existed. Both are redirected into
 * the project, and `--factory-startup` stops it reading anything back out.
 */
export function blenderProcessEnv(scratch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMP: scratch,
    TEMP: scratch,
    BLENDER_USER_RESOURCES: path.join(ROOT, '.cache', 'blender'),
  };
}

export type Availability = { ok: true } | { ok: false; reason: string };

const INSTALL_HINT =
  'Put a build under tools\\blender-*\\blender.exe or set the BLENDER env var. ' +
  'Download: https://www.blender.org/download/ — only needed to re-bake props; ' +
  'props already in props/ render without it.';

/**
 * Is the foundry usable?
 *
 * Reported rather than thrown so `doctor` can show it as an absent optional tool
 * instead of a failure, and so the bake command can name the remedy.
 */
export async function blenderAvailable(): Promise<Availability> {
  let exe: string | null;
  try {
    exe = await findBlender();
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!exe) return { ok: false, reason: `Blender not found. ${INSTALL_HINT}` };

  const version = await blenderVersion(exe);
  if (!version) return { ok: false, reason: `"${exe}" did not report a Blender version. ${INSTALL_HINT}` };

  if (
    version.major < MIN_BLENDER[0] ||
    (version.major === MIN_BLENDER[0] && version.minor < MIN_BLENDER[1])
  ) {
    return {
      ok: false,
      reason:
        `Blender ${version.major}.${version.minor} is older than the ${MIN_BLENDER[0]}.${MIN_BLENDER[1]} ` +
        'minimum the bake script needs. Install a newer build under tools\\ or point BLENDER at one.',
    };
  }

  return { ok: true };
}
