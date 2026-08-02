import { Look } from '../schema/look.ts';
import { isLocked, stampOf } from '../schema/identity.ts';
import { activeIdentity } from '../show/context.ts';
import { newEntityId } from '../core/streams.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from './placeholder.ts';
import { rollLook, rollLookFor } from './look.ts';
import { loadRig, saveRig, validateRig, type LoadedRig } from './store.ts';

/**
 * Creating and re-drawing characters.
 *
 * Shared by the CLI and the server so both do the same thing — in particular so
 * both preserve the same fields. Regeneration exists because the puppet
 * generator keeps gaining features, and "you have to delete your cast to get the
 * new faces" is not an acceptable upgrade path.
 */

type RigDoc = LoadedRig['rig'];

/** Fields a regenerate must never clobber: they are choices, not derived art. */
function carryOver(existing: RigDoc, fresh: RigDoc): RigDoc {
  return {
    ...fresh,
    charId: existing.charId,
    locks: existing.locks,
    voice: existing.voice,
    voiceRate: existing.voiceRate,
    voiceRef: existing.voiceRef,
    idle: existing.idle,
  };
}

/**
 * Enforce a character's locks against a candidate look.
 *
 * The reroll happens in full; locked fields simply keep their existing values.
 * Locks are stored as rig-level dotted paths ("look.hair", or "look" for the
 * whole appearance), and the show profile can contribute its own.
 */
function applyLookLocks(existing: RigDoc, candidate: Look): Look {
  const current = existing.look;
  if (!current) return candidate;

  const locks = [...existing.locks, ...activeIdentity().variation.locks];
  if (isLocked(locks, 'look')) return current;

  const merged: Record<string, unknown> = { ...candidate };
  for (const key of Object.keys(current) as Array<keyof Look>) {
    if (isLocked(locks, `look.${key}`)) merged[key] = current[key];
  }
  return Look.parse(merged);
}

export interface RegenerateOptions {
  /** Draw with this look instead of the character's current one. */
  look?: Look;
  /** Discard the current look and roll a fresh one. */
  reroll?: boolean;
  /** Vary the reroll without disturbing the character's unsalted default. */
  salt?: string;
}

/**
 * Redraw a character's art from their look.
 *
 * The look is the input and the SVG is the output, so this is how any
 * appearance change actually lands on disk — the editor changes the descriptor
 * and calls this rather than trying to patch SVG. Locks always win: a locked
 * field survives an explicit edit, a reroll, and a model proposal alike.
 */
export async function regenerateRig(name: string, opts: RegenerateOptions = {}): Promise<LoadedRig> {
  const existing = await loadRig(name);
  const identity = activeIdentity();

  const candidate = opts.look
    ? Look.parse(opts.look)
    : opts.reroll
      ? existing.rig.charId
        ? rollLookFor(existing.rig.charId, identity, opts.salt ?? '')
        : rollLook(name + (opts.salt ?? ''))
      : (existing.rig.look ?? rollLook(name));

  const look = applyLookLocks(existing.rig, candidate);

  const rig = carryOver(existing.rig, buildPlaceholderRig(name, look));
  rig.identity = stampOf(identity);
  const svg = buildPlaceholderSvg(name, look);

  // The generator producing art that fails its own manifest is a bug in the
  // generator, not bad input — so it fails loudly rather than saving something
  // the renderer will silently draw nothing for.
  const errors = validateRig({ rig, svg });
  if (errors.length) throw new Error(`regenerated rig for "${name}" failed validation: ${errors.join('; ')}`);

  await saveRig(rig, svg);
  return { rig, svg };
}

/**
 * A brand new character.
 *
 * Gets a stable id at birth. Their *initial* look is the name-roll — the same
 * face every ephemeral preview of this character has already shown, so casting
 * someone never changes them mid-flow. From then on the name is only a label:
 * rerolls and every other seeded stream key off the id.
 */
export async function createRig(name: string, look?: Look): Promise<LoadedRig> {
  const identity = activeIdentity();
  const charId = newEntityId();
  const resolved = look ? Look.parse(look) : rollLook(name);

  const rig = buildPlaceholderRig(name, resolved);
  rig.charId = charId;
  rig.identity = stampOf(identity);
  const svg = buildPlaceholderSvg(name, resolved);

  const errors = validateRig({ rig, svg });
  if (errors.length) throw new Error(`generated rig for "${name}" failed validation: ${errors.join('; ')}`);

  await saveRig(rig, svg);
  return { rig, svg };
}

/** A character's look, rolling one for puppets that predate the field. */
export function lookOf(rig: RigDoc): Look {
  return rig.look ?? rollLook(rig.name);
}
