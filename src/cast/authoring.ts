import { Look } from '../schema/look.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from './placeholder.ts';
import { rollLook } from './look.ts';
import { loadRig, saveRig, validateRig, type LoadedRig } from './store.ts';

/**
 * Creating and re-drawing characters.
 *
 * Shared by the CLI and the server so both do the same thing — in particular so
 * both preserve the same fields. Regeneration exists because the puppet
 * generator keeps gaining features, and "you have to delete your cast to get the
 * new faces" is not an acceptable upgrade path.
 */

/** Fields a regenerate must never clobber: they are choices, not derived art. */
function carryOver(existing: LoadedRig['rig'], fresh: LoadedRig['rig']): LoadedRig['rig'] {
  return {
    ...fresh,
    voice: existing.voice,
    voiceRate: existing.voiceRate,
    voiceRef: existing.voiceRef,
    idle: existing.idle,
  };
}

export interface RegenerateOptions {
  /** Draw with this look instead of the character's current one. */
  look?: Look;
  /** Discard the current look and roll a fresh one from the name. */
  reroll?: boolean;
}

/**
 * Redraw a character's art from their look.
 *
 * The look is the input and the SVG is the output, so this is how any
 * appearance change actually lands on disk — the editor changes the descriptor
 * and calls this rather than trying to patch SVG.
 */
export async function regenerateRig(name: string, opts: RegenerateOptions = {}): Promise<LoadedRig> {
  const existing = await loadRig(name);

  const look = opts.look
    ? Look.parse(opts.look)
    : opts.reroll
      ? rollLook(name)
      : (existing.rig.look ?? rollLook(name));

  const rig = carryOver(existing.rig, buildPlaceholderRig(name, look));
  const svg = buildPlaceholderSvg(name, look);

  // The generator producing art that fails its own manifest is a bug in the
  // generator, not bad input — so it fails loudly rather than saving something
  // the renderer will silently draw nothing for.
  const errors = validateRig({ rig, svg });
  if (errors.length) throw new Error(`regenerated rig for "${name}" failed validation: ${errors.join('; ')}`);

  await saveRig(rig, svg);
  return { rig, svg };
}

/** A brand new character, drawn from their name. */
export async function createRig(name: string, look?: Look): Promise<LoadedRig> {
  const resolved = look ? Look.parse(look) : rollLook(name);
  const rig = buildPlaceholderRig(name, resolved);
  const svg = buildPlaceholderSvg(name, resolved);

  const errors = validateRig({ rig, svg });
  if (errors.length) throw new Error(`generated rig for "${name}" failed validation: ${errors.join('; ')}`);

  await saveRig(rig, svg);
  return { rig, svg };
}

/** A character's look, rolling one for puppets that predate the field. */
export function lookOf(rig: LoadedRig['rig']): Look {
  return rig.look ?? rollLook(rig.name);
}
