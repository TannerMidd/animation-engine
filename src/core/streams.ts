import crypto from 'node:crypto';
import { deriveSeed } from './rng.ts';
import type { ShowIdentity } from '../schema/identity.ts';

/**
 * Named variation streams.
 *
 * Every stochastic decision belongs to a named stream rooted in the show's
 * seed and keyed by a *stable id* — never by a display name. That's the whole
 * mechanism behind two guarantees the roadmap demands:
 *
 *   - renaming something changes nothing, because names are not seeds;
 *   - adding a new kind of variation can't reshuffle existing ones, because
 *     each stream is derived independently rather than drawn in sequence.
 *
 * Streams that exist today; later milestones add theirs here so the namespace
 * is one greppable list rather than scattered string literals:
 */
export const STREAMS = {
  /** A character's rolled appearance. */
  look: 'look',
  /** A character's minted voice and take seeds (M18). */
  voice: 'voice',
  /** A character's vocal delivery personality (M18). */
  persona: 'persona',
  /** A character's acting profile (M20). */
  acting: 'acting',
  /** Ensemble-level outfit distribution (M19). */
  ensemble: 'ensemble',
  /** Ambience and sting synthesis (M18). */
  ambience: 'ambience',
} as const;
export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

/** Seed for one entity's stream under one identity. */
export function streamSeed(identity: ShowIdentity, stream: StreamName, entityId: string): number {
  return deriveSeed(deriveSeed(identity.seed, `stream:${stream}`), entityId);
}

/**
 * A fresh stable id for a character, set, or asset.
 *
 * Random, not derived: ids exist precisely so that nothing about an entity —
 * least of all its name — determines its identity. Short enough to read in a
 * diff, long enough that a cast of thousands wouldn't collide.
 */
export function newEntityId(): string {
  return crypto.randomBytes(5).toString('hex');
}
