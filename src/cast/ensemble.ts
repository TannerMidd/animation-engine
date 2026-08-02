import { Rng, deriveSeed } from '../core/rng.ts';
import { streamSeed, STREAMS } from '../core/streams.ts';
import { Outfit, OUTFIT_CHOICES, ACCENTS, type OutfitFamily } from '../schema/outfit.ts';
import type { ShowIdentity } from '../schema/identity.ts';

/**
 * Ensemble wardrobe assignment.
 *
 * A cast where every field rolls independently reads as a random crowd; a
 * designed ensemble repeats a few silhouettes with contrast between them. The
 * assigner deals each character an outfit *family* from the visual bible, then
 * rolls their personal variation inside that family's narrowed options.
 *
 * Stability rules, in tension and resolved deliberately:
 *
 *   - A character's family depends only on (identity seed, charId) — adding or
 *     renaming cast members cannot re-dress anyone else.
 *   - `maxPerScene` caps are enforced *within the presented cast*, in charId
 *     order, by bumping the newest offenders to their second-choice family —
 *     so a third suit joining a two-suit-max scene changes into something
 *     else, rather than forcing an existing suit to.
 */

/** Weighted family preference order for one character. Pure. */
function familyPreference(identity: ShowIdentity, charId: string, families: OutfitFamily[]): OutfitFamily[] {
  const rng = new Rng(deriveSeed(streamSeed(identity, STREAMS.ensemble, charId), 'family'));

  // Deal by weighted sampling without replacement: the first pick is the
  // character's home family, the rest are fallbacks for cap bumps.
  const remaining = [...families];
  const order: OutfitFamily[] = [];
  while (remaining.length) {
    const total = remaining.reduce((s, f) => s + f.weight, 0);
    let roll = rng.next() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      roll -= remaining[i]!.weight;
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    order.push(remaining.splice(idx, 1)[0]!);
  }
  return order;
}

/** Roll a concrete outfit inside a family's constraints. Pure. */
export function outfitWithin(identity: ShowIdentity, charId: string, family: OutfitFamily | null): Outfit {
  const rng = new Rng(deriveSeed(streamSeed(identity, STREAMS.ensemble, charId), 'outfit'));
  const accents = identity.visual.accents.length ? identity.visual.accents : ACCENTS;

  const pick = <K extends keyof typeof OUTFIT_CHOICES>(key: K): string => {
    const fixed = family?.fixed[key];
    if (fixed !== undefined) return fixed;
    const options = family?.options[key] ?? OUTFIT_CHOICES[key];
    return rng.pick(options as readonly string[]);
  };

  return Outfit.parse({
    sleeves: pick('sleeves'),
    collar: pick('collar'),
    neckwear: pick('neckwear'),
    pattern: pick('pattern'),
    hat: pick('hat'),
    shoes: pick('shoes'),
    accent: family?.fixed.accent ?? rng.pick(accents),
  });
}

export interface EnsembleAssignment {
  charId: string;
  family: string | null;
  outfit: Outfit;
}

/**
 * Dress a cast.
 *
 * Characters are considered in charId order (stable, not scene order) so cap
 * enforcement is deterministic for a given cast set regardless of how the
 * scene happens to list them.
 */
export function assignEnsemble(identity: ShowIdentity, charIds: string[]): Map<string, EnsembleAssignment> {
  const families = identity.visual.outfitFamilies;
  const out = new Map<string, EnsembleAssignment>();

  if (!families.length) {
    for (const id of charIds) {
      out.set(id, { charId: id, family: null, outfit: outfitWithin(identity, id, null) });
    }
    return out;
  }

  const worn = new Map<string, number>();
  for (const charId of [...charIds].sort()) {
    const preference = familyPreference(identity, charId, families);
    // First family in preference order with cap room; the last preference is
    // taken cap-or-no-cap so everyone ends up dressed.
    let chosen = preference[preference.length - 1]!;
    for (const family of preference) {
      const count = worn.get(family.name) ?? 0;
      if (family.maxPerScene === undefined || count < family.maxPerScene) {
        chosen = family;
        break;
      }
    }
    worn.set(chosen.name, (worn.get(chosen.name) ?? 0) + 1);
    out.set(charId, { charId, family: chosen.name, outfit: outfitWithin(identity, charId, chosen) });
  }
  return out;
}

/** The default outfit for one character under the active identity. */
export function defaultOutfit(identity: ShowIdentity, charId: string): Outfit {
  const assignment = assignEnsemble(identity, [charId]).get(charId);
  return assignment!.outfit;
}
