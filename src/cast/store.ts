import fs from 'node:fs/promises';
import path from 'node:path';
import { CAST_DIR } from '../core/paths.ts';
import { Rig } from '../schema/index.ts';

export interface LoadedRig {
  rig: Rig;
  svg: string;
}

export function rigPath(name: string): string {
  return path.join(CAST_DIR, `${name}.rig.json`);
}

export async function saveRig(rig: Rig, svg: string): Promise<void> {
  await fs.mkdir(CAST_DIR, { recursive: true });
  await fs.writeFile(rigPath(rig.name), JSON.stringify(rig, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(CAST_DIR, rig.svg), svg, 'utf8');
}

export async function loadRig(name: string): Promise<LoadedRig> {
  const file = rigPath(name);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`No rig named "${name}". Expected ${file}. Create one with: anim cast new ${name}`);
  }
  const rig = Rig.parse(JSON.parse(raw));
  const svg = await fs.readFile(path.join(CAST_DIR, rig.svg), 'utf8');
  return { rig, svg };
}

export async function listRigs(): Promise<string[]> {
  try {
    const files = await fs.readdir(CAST_DIR);
    return files.filter((f) => f.endsWith('.rig.json')).map((f) => f.replace(/\.rig\.json$/, '')).sort();
  } catch {
    return [];
  }
}

/**
 * Assert that a rig manifest and its SVG actually agree.
 *
 * This is the check that makes "draw your own puppet" tractable: it names the
 * exact ids that are missing rather than letting the renderer silently draw
 * nothing. Run it on every new or edited character.
 */
export function validateRig({ rig, svg }: LoadedRig): string[] {
  const errors: string[] = [];
  const ids = new Set(Array.from(svg.matchAll(/\bid="([^"]+)"/g), (m) => m[1]!));

  const need = (id: string, why: string) => {
    if (!ids.has(id)) errors.push(`SVG is missing id="${id}" (${why})`);
  };

  const partIds = new Set(rig.parts.map((p) => p.id));
  for (const part of rig.parts) {
    need(part.id, 'declared as a part');
    if (part.parent !== null && !partIds.has(part.parent)) {
      errors.push(`part "${part.id}" has parent "${part.parent}", which is not a declared part`);
    }
  }

  // A part cycle would hang the transform walk, so catch it here rather than there.
  for (const part of rig.parts) {
    const seen = new Set<string>([part.id]);
    let cur = part.parent;
    while (cur !== null) {
      if (seen.has(cur)) {
        errors.push(`part "${part.id}" is in a parent cycle via "${cur}"`);
        break;
      }
      seen.add(cur);
      cur = rig.parts.find((p) => p.id === cur)?.parent ?? null;
    }
  }

  for (const set of rig.swapSets) {
    for (const v of set.variants) need(v, `variant of swap slot "${set.slot}"`);
    if (!set.variants.includes(set.default)) {
      errors.push(`swap slot "${set.slot}" default "${set.default}" is not one of its variants`);
    }
  }

  const slots = new Map(rig.swapSets.map((s) => [s.slot, s]));
  for (const expr of rig.expressions) {
    for (const [slot, variant] of Object.entries(expr.swaps)) {
      const set = slots.get(slot);
      if (!set) {
        errors.push(`expression "${expr.name}" uses unknown swap slot "${slot}"`);
      } else if (!set.variants.includes(variant)) {
        errors.push(`expression "${expr.name}" sets "${slot}" to "${variant}", which is not a variant of that slot`);
      }
    }
    for (const id of Object.keys(expr.parts)) {
      if (!partIds.has(id)) errors.push(`expression "${expr.name}" transforms unknown part "${id}"`);
    }
  }

  for (const pose of rig.poses) {
    for (const id of Object.keys(pose.parts)) {
      if (!partIds.has(id)) errors.push(`pose "${pose.name}" transforms unknown part "${id}"`);
    }
  }

  return errors;
}
