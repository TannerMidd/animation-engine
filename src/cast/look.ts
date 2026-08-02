import { Rng, deriveSeed } from '../core/rng.ts';
import { Look, BUILDS, SKINS, SHIRTS, HAIRS, TROUSERS, type Build } from '../schema/look.ts';

/**
 * Rolling a default appearance.
 *
 * The `Look` descriptor itself lives in the schema layer, since the rig carries
 * one and the UI enumerates its options. What lives here is the part that only
 * the puppet generator cares about: how a character who has never been edited
 * gets a face, and how each build reshapes the body.
 */

/**
 * Build archetypes.
 *
 * A cast built from one puppet recoloured reads as one puppet recoloured. Each
 * build reshapes the silhouette enough to be recognisable from across the room
 * — which is the only distance limited animation gives you.
 */
export interface BuildSpec {
  head: number;
  bodyWidth: number;
  bodyHeight: number;
  limbLength: number;
  limbWidth: number;
  torso: 'rounded' | 'boxy' | 'round' | 'pear';
}

export const BUILD_SPECS: Record<Build, BuildSpec> = {
  squat: { head: 1.28, bodyWidth: 1.22, bodyHeight: 0.8, limbLength: 0.72, limbWidth: 1.2, torso: 'round' },
  lanky: { head: 0.8, bodyWidth: 0.76, bodyHeight: 1.18, limbLength: 1.28, limbWidth: 0.78, torso: 'rounded' },
  boxy: { head: 1.02, bodyWidth: 1.16, bodyHeight: 1.0, limbLength: 0.94, limbWidth: 1.12, torso: 'boxy' },
  round: { head: 1.12, bodyWidth: 1.3, bodyHeight: 0.88, limbLength: 0.8, limbWidth: 1.02, torso: 'round' },
  pear: { head: 0.94, bodyWidth: 1.08, bodyHeight: 1.02, limbLength: 0.98, limbWidth: 0.94, torso: 'pear' },
};

/**
 * Weighted pick.
 *
 * Uniform choice over eleven hairstyles gives every third character a topknot.
 * Weights keep the ordinary options ordinary, so the distinctive ones stay
 * distinctive when they do come up.
 */
function weighted<T extends string>(rng: Rng, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return table[table.length - 1]![0];
}

const HEAD_WEIGHTS = [
  ['round', 10], ['square', 8], ['egg', 7], ['long', 6], ['wide', 6], ['pointed', 4],
] as const;

const HAIR_WEIGHTS = [
  ['crop', 10], ['side-part', 9], ['combover', 7], ['mop', 7], ['receding', 6],
  ['bald', 5], ['spikes', 4], ['curly', 4], ['ponytail', 4], ['bun', 3], ['tall', 3],
] as const;

const FACIAL_WEIGHTS = [
  ['none', 30], ['stubble', 8], ['moustache', 7], ['goatee', 5], ['beard', 5], ['chops', 3],
] as const;

const GLASSES_WEIGHTS = [['none', 22], ['square', 6], ['round', 5], ['halfrim', 3]] as const;

const EYE_WEIGHTS = [
  ['round', 14], ['oval', 9], ['dot', 6], ['beady', 5], ['hooded', 5], ['googly', 3],
] as const;

const NOSE_WEIGHTS = [
  ['button', 10], ['bulb', 8], ['wide', 7], ['pointed', 6], ['beak', 5], ['hook', 4], ['none', 2],
] as const;

const BROW_WEIGHTS = [['thin', 10], ['thick', 8], ['bushy', 5], ['sparse', 4], ['angled', 4]] as const;

const EAR_WEIGHTS = [['small', 12], ['large', 6], ['stuck-out', 4], ['none', 3]] as const;

/**
 * A character's default appearance, derived from their name.
 *
 * Stable across machines and runs, so "steve" is the same guy everywhere, and
 * two characters in a scene are visually distinct without anyone choosing.
 * Every field is rolled unconditionally, even ones the chosen style will not
 * use — a bald character still draws a hair colour, because skipping it would
 * shift every later choice and quietly recast everyone the moment a hairstyle
 * is added to the table.
 */
export function rollLook(name: string): Look {
  const rng = new Rng(deriveSeed(0x5eed, name.toLowerCase()));

  return Look.parse({
    build: rng.pick(BUILDS),
    head: weighted(rng, HEAD_WEIGHTS),
    hair: weighted(rng, HAIR_WEIGHTS),
    facialHair: weighted(rng, FACIAL_WEIGHTS),
    glasses: weighted(rng, GLASSES_WEIGHTS),
    eyes: weighted(rng, EYE_WEIGHTS),
    nose: weighted(rng, NOSE_WEIGHTS),
    brows: weighted(rng, BROW_WEIGHTS),
    ears: weighted(rng, EAR_WEIGHTS),

    skin: rng.pick(SKINS),
    shirt: rng.pick(SHIRTS),
    hairColour: rng.pick(HAIRS),
    trousers: rng.pick(TROUSERS),
    line: '#1a1a1a',

    // Small per-character variation on top of the build, so two "boxy"
    // characters are not literally the same puppet.
    headSize: rng.range(0.92, 1.1),
    bodyWidth: rng.range(0.94, 1.08),
    bodyHeight: rng.range(0.95, 1.06),
    limbLength: rng.range(0.94, 1.08),
    limbWidth: rng.range(0.92, 1.1),
    eyeSize: rng.range(0.85, 1.2),
    eyeSpread: rng.range(0.88, 1.14),
  });
}

export { Look };
export type { Build };
