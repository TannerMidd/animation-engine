import fs from 'node:fs/promises';
import path from 'node:path';
import { SETS_DIR } from '../core/paths.ts';
import { SetDescriptor, geometryFor, STAGE, type PropInstance, type SetGeometry } from './schema.ts';
import { getPalette, type Palette } from './palettes.ts';
import { getProp, PROP_KEYS, PROPS } from './props/index.ts';
import { r } from './props/types.ts';

/**
 * Set descriptor -> SVG.
 *
 * Emits two fragments rather than one. Everything in `back` and `mid` draws
 * behind the characters; `fore` draws in front of them. That split is what lets
 * someone stand behind a bar instead of on top of it.
 */
export interface RenderedSet {
  back: string;
  fore: string;
  geo: SetGeometry;
  palette: Palette;
}

function renderInstance(inst: PropInstance, palette: Palette, geo: SetGeometry): string {
  const def = getProp(inst.prop);
  const ctx = {
    palette,
    geo,
    params: inst.params,
    x: inst.x ?? STAGE.width / 2,
    y: inst.y ?? geo.horizonY,
  };

  // Spanning props cover the whole set and place themselves in set coordinates.
  if (def.spanning) return def.render(ctx);

  // Everything else authors in local space around its own base, and the
  // registry places it. Keeping that arithmetic in one place is deliberate:
  // props computing their own transforms is exactly how the first puppet ended
  // up with limbs rotating about empty space.
  const sx = inst.flip ? -inst.scale : inst.scale;
  const transform = `translate(${r(ctx.x)},${r(ctx.y)}) scale(${r(sx)},${r(inst.scale)})`;
  return `<g transform="${transform}">${def.render(ctx)}</g>`;
}

export function renderSet(desc: SetDescriptor): RenderedSet {
  const palette = getPalette(desc.palette);
  const geo = geometryFor(desc.layout);

  const layer = (items: PropInstance[]) => items.map((i) => renderInstance(i, palette, geo)).join('\n');

  return {
    back: layer(desc.layers.back) + '\n' + layer(desc.layers.mid),
    fore: layer(desc.layers.fore),
    geo,
    palette,
  };
}

// --- storage --------------------------------------------------------------

export function setPath(name: string): string {
  // Tolerant of a stray extension — scenes recorded a set as "office.svg" back
  // when sets were raw SVG files, and those shouldn't resolve to "office.svg.json".
  const base = name.replace(/\.(json|svg)$/i, '');
  return path.join(SETS_DIR, `${base}.json`);
}

export async function loadSet(name: string): Promise<SetDescriptor> {
  const file = setPath(name);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`no set at ${file}. Available: ${(await listSets()).join(', ') || '(none)'}`);
  }
  return SetDescriptor.parse(JSON.parse(raw));
}

export async function saveSet(desc: SetDescriptor): Promise<string> {
  await fs.mkdir(SETS_DIR, { recursive: true });
  const file = setPath(desc.name);
  await fs.writeFile(file, JSON.stringify(desc, null, 2) + '\n', 'utf8');
  return file;
}

export async function listSets(): Promise<string[]> {
  try {
    const files = await fs.readdir(SETS_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch {
    return [];
  }
}

/**
 * Check a descriptor against the registry before anything tries to render it.
 *
 * The same guard the director has: whatever wrote this — a hand edit, the
 * designer UI, or a model — cannot reference a prop or palette that doesn't
 * exist without being told exactly which one.
 */
export function validateSet(desc: SetDescriptor): string[] {
  const errors: string[] = [];

  try {
    getPalette(desc.palette);
  } catch (err) {
    errors.push((err as Error).message);
  }

  for (const [layerName, items] of Object.entries(desc.layers)) {
    items.forEach((inst, i) => {
      const at = `${layerName}[${i}]`;
      if (!PROP_KEYS.includes(inst.prop)) {
        errors.push(`${at}: unknown prop "${inst.prop}"`);
        return;
      }
      const def = getProp(inst.prop);
      const known = new Set(def.params.map((p) => p.key));
      for (const key of Object.keys(inst.params)) {
        if (!known.has(key)) {
          errors.push(
            `${at} ("${inst.prop}"): unknown param "${key}". Accepts: ${[...known].join(', ') || '(none)'}`,
          );
        }
      }
    });
  }

  return errors;
}

/**
 * Composition problems that are legal but wrong.
 *
 * `validateSet` answers "will this render"; this answers "will it look like a
 * room". Separate because these are judgement calls, not errors — a set can
 * break every one of them deliberately. They exist mainly to be fed back to a
 * model on retry, since a generated set satisfies the schema by construction
 * and so passes validation while still putting a water cooler through
 * someone's chest.
 */
/**
 * Repair a set's composition, deterministically.
 *
 * The linter can only complain, and a 14B model asked to fix its own layout
 * mostly rearranges which rule it breaks. These particular problems have exactly
 * one sensible answer each, so the engine applies it directly — the same
 * division of labour as everywhere else here: the model invents, deterministic
 * code arranges.
 *
 * Deliberately conservative. Props stacked at the same x are left alone, because
 * a monitor on a desk is *supposed* to share the desk's x, and no amount of
 * inspecting a descriptor distinguishes that from clutter. This only fixes the
 * three problems that are unambiguously wrong.
 */
export function tidySet(input: SetDescriptor): SetDescriptor {
  const desc = SetDescriptor.parse(structuredClone(input));
  const geo = geometryFor(desc.layout);

  /**
   * Drop props repeated identically across layers.
   *
   * A model handed three arrays and told they mean depth sometimes fills all
   * three with the same list, which renders each prop three times in three
   * planes. Nothing is lost by keeping the first: the duplicates are not a
   * composition, they are the same object drawn on top of itself. Back wins over
   * mid wins over fore, so a repeated prop settles behind the characters rather
   * than in front of them.
   */
  const seen = new Set<string>();
  for (const layer of ['back', 'mid', 'fore'] as const) {
    desc.layers[layer] = desc.layers[layer].filter((inst) => {
      const key = `${inst.prop}@${inst.x ?? ''}:${inst.y ?? ''}:${JSON.stringify(inst.params)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  for (const items of Object.values(desc.layers)) {
    for (const inst of items) {
      const def = PROPS[inst.prop];
      if (!def) continue;

      if (def.spanning) {
        // Spanning props place themselves across the whole set; a position on
        // the instance is ignored at best and misleading in the designer.
        delete inst.x;
        delete inst.y;
        continue;
      }
      // A prop with its own y param takes its height from there, and an instance
      // y fights it. A y above the floor line on anything else is a prop hovering.
      if (def.params.some((p) => p.key === 'y') || (inst.y !== undefined && inst.y < geo.horizonY - 40)) {
        delete inst.y;
      }
    }
  }

  // Furniture in "fore" draws over the characters' faces. Structural pieces are
  // the only things that legitimately pass in front of someone.
  const { mid, fore } = desc.layers;
  if (fore.length > mid.length && fore.length > 1) {
    const structural = fore.filter((i) => PROPS[i.prop]?.tags.includes('structure'));
    desc.layers.mid = [...mid, ...fore.filter((i) => !PROPS[i.prop]?.tags.includes('structure'))];
    desc.layers.fore = structural;
  }

  // The middle of frame belongs to the characters. Keep the two props nearest
  // the centre — something has to furnish the shot — and move the rest out to
  // whichever side they were already closer to, so the model's left/right
  // intent survives.
  const standing = [desc.layers.back, desc.layers.mid, desc.layers.fore]
    .flat()
    .filter((i) => PROPS[i.prop] && !PROPS[i.prop]!.spanning);

  const middle = STAGE.width / 2;
  const crowded = standing.filter((i) => i.x !== undefined && i.x > 380 && i.x < 900);

  if (crowded.length > 2) {
    const keep = new Set(
      [...crowded].sort((a, b) => Math.abs(a.x! - middle) - Math.abs(b.x! - middle)).slice(0, 2),
    );
    let left = 320;
    let right = 960;
    for (const inst of crowded) {
      if (keep.has(inst)) continue;
      if (inst.x! < middle) {
        inst.x = left;
        left -= 150;
      } else {
        inst.x = right;
        right += 150;
      }
    }
  }

  return desc;
}

export interface SetNote {
  /** What is wrong, phrased for a person reading the designer. */
  message: string;
  /**
   * What to do about it, phrased as an instruction.
   *
   * Separate from the message because the two audiences want opposite things.
   * A person wants to know what is wrong and will decide what to do; a model
   * handed the same sentence will find *a* way to make the complaint go away,
   * and the cheapest way to satisfy "furniture belongs in mid" is to delete the
   * furniture. Every fix therefore names the props involved and says explicitly
   * that nothing may be removed.
   */
  fix: string;
}

export function lintSet(desc: SetDescriptor): SetNote[] {
  const notes: SetNote[] = [];
  const { back, mid, fore } = desc.layers;
  const geo = geometryFor(desc.layout);

  const standing = [...back, ...mid, ...fore].filter((i) => {
    const def = PROPS[i.prop];
    return def && !def.spanning;
  });

  if (!back.some((i) => PROPS[i.prop]?.spanning)) {
    notes.push({
      message: 'no wall/sky or floor in "back" — the room has no shell',
      fix: 'Insert a wall (interior) or sky (exterior) prop as the FIRST item in "back", and a floor ' +
        'after it. Keep every prop you already placed, exactly where it is.',
    });
  }

  // Characters render between mid and fore, so fore is for occluders only.
  if (fore.length > mid.length && fore.length > 1) {
    // Structural pieces are the ones that legitimately pass in front of someone;
    // a desk is not.
    const misplaced = fore.filter((i) => !PROPS[i.prop]?.tags.includes('structure'));
    const names = [...new Set(misplaced.map((i) => i.prop))].join(', ');
    notes.push({
      message:
        `${fore.length} props in "fore" but ${mid.length} in "mid" — "fore" draws in FRONT of the ` +
        'characters, so furniture placed there covers their faces',
      fix:
        `Move these props from the "fore" array into the "mid" array, keeping their x, y, scale and ` +
        `params unchanged: ${names || 'the furniture in "fore"'}. Do not delete any prop and do not ` +
        'add any. Only something meant to pass in front of a character — a pillar, a doorway, a plant ' +
        'at the very edge — belongs in "fore".',
    });
  }

  for (const [layerName, items] of Object.entries(desc.layers)) {
    items.forEach((inst, i) => {
      const def = PROPS[inst.prop];
      if (!def || def.spanning) return;

      // A prop that positions itself via a `y` param does not want an instance y.
      const selfPositions = def.params.some((p) => p.key === 'y');
      if (inst.y !== undefined && selfPositions) {
        notes.push({
          message: `${layerName}[${i}] "${inst.prop}": has an instance "y", but positions itself via its own "y" param`,
          fix: `Delete the "y" field from ${layerName}[${i}] ("${inst.prop}") and set its "y" param instead. Keep the prop.`,
        });
      } else if (inst.y !== undefined && inst.y < geo.horizonY - 40) {
        notes.push({
          message: `${layerName}[${i}] "${inst.prop}": y=${inst.y} floats above the floor (${geo.horizonY})`,
          fix: `Delete the "y" field from ${layerName}[${i}] ("${inst.prop}") so it stands on the ground. Keep the prop.`,
        });
      }
    });
  }

  // The middle of frame is where the characters go.
  const centre = standing.filter((i) => i.x !== undefined && i.x > 380 && i.x < 900);
  if (centre.length > 2) {
    const names = [...new Set(centre.map((i) => i.prop))].join(', ');
    notes.push({
      message:
        `${centre.length} props between x=380 and x=900 — that is where the characters stand, so they ` +
        'will be buried in the furniture',
      fix:
        `Keep every prop. Change only the "x" of some of these so that at most two remain between 380 ` +
        `and 900: ${names}. Move the rest to x below 340 or above 940 — the set is 1280 wide and ` +
        'extends past the frame, so there is plenty of room at the edges.',
    });
  }

  return notes;
}

export { SetDescriptor, geometryFor, STAGE };
export type { SetGeometry, PropInstance };
export * from './palettes.ts';
