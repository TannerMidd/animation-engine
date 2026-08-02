import { DEFAULT_IDENTITY, type ShowIdentity } from '../schema/identity.ts';

/**
 * The active identity, as module state.
 *
 * A deliberate seam: profile *storage* touches the filesystem, but the code
 * that consumes identity — the style renderer, the prompts, the seed streams —
 * is synchronous and deep inside call stacks that have no business doing IO.
 * Entry points (CLI, server, tests) load a profile once and set it here;
 * everything else reads it synchronously.
 *
 * Defaults to the built-in house identity, so code that runs before any
 * project is loaded — or a project that predates profiles entirely — behaves
 * exactly as it did before identity became data.
 */

let active: ShowIdentity = DEFAULT_IDENTITY;

export function setActiveIdentity(identity: ShowIdentity): void {
  active = identity;
}

export function activeIdentity(): ShowIdentity {
  return active;
}
