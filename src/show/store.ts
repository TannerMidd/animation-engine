import fs from 'node:fs/promises';
import path from 'node:path';
import { SHOW_DIR } from '../core/paths.ts';
import { atomicWriteFile } from '../core/files.ts';
import { projectId, resolveWithin } from '../core/project.ts';
import {
  ShowIdentity, DEFAULT_IDENTITY, canonicalJson,
} from '../schema/identity.ts';
import { identityHash } from './identity.ts';
import { setActiveIdentity } from './context.ts';

/**
 * Identity profile storage.
 *
 * Profiles live under `show/` as `<id>.identity.json`, with `show/show.json`
 * pointing at the active one. Fixture profiles used by the evaluation suite
 * live under `show/fixtures/` and are loadable but never auto-activated.
 *
 * A project with no `show/` directory is a pre-identity project: it gets the
 * built-in house profile, which is defined to reproduce the engine's previous
 * hardcoded behaviour exactly.
 */

const POINTER = path.join(SHOW_DIR, 'show.json');

export function profilePath(id: string): string {
  return resolveWithin(SHOW_DIR, `${projectId(id, 'show profile id')}.identity.json`);
}

export async function listProfiles(): Promise<Array<{ id: string; name: string; version: string; hash: string }>> {
  let files: string[];
  try {
    files = await fs.readdir(SHOW_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.identity.json')).sort()) {
    try {
      const identity = ShowIdentity.parse(JSON.parse(await fs.readFile(path.join(SHOW_DIR, file), 'utf8')));
      out.push({ id: identity.id, name: identity.name, version: identity.version, hash: identityHash(identity) });
    } catch {
      // A malformed profile shouldn't hide the valid ones; validate surfaces it.
    }
  }
  return out;
}

export async function loadProfile(id: string): Promise<ShowIdentity> {
  // Fixtures are addressable with a prefix, so the eval tooling can load them
  // without them ever appearing in the ordinary profile list.
  const file = id.startsWith('fixtures/')
    ? resolveWithin(SHOW_DIR, 'fixtures', `${projectId(id.slice('fixtures/'.length), 'fixture profile id')}.identity.json`)
    : profilePath(id);

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    const known = (await listProfiles()).map((p) => p.id).join(', ') || '(none)';
    throw new Error(`no identity profile "${id}" at ${file}. Available: ${known}`);
  }
  return ShowIdentity.parse(JSON.parse(raw));
}

export async function saveProfile(identity: ShowIdentity): Promise<string> {
  const parsed = ShowIdentity.parse(identity);
  const file = profilePath(parsed.id);
  await atomicWriteFile(file, JSON.stringify(parsed, null, 2) + '\n');
  return file;
}

export async function activeProfileId(): Promise<string | null> {
  try {
    const pointer = JSON.parse(await fs.readFile(POINTER, 'utf8')) as { active?: string };
    return pointer.active ?? null;
  } catch {
    return null;
  }
}

export async function setActiveProfileId(id: string): Promise<void> {
  // Loading first means the pointer can never name a profile that doesn't parse.
  await loadProfile(id);
  await atomicWriteFile(POINTER, JSON.stringify({ active: id }, null, 2) + '\n');
}

/**
 * Load the active profile and make it current for every synchronous consumer.
 *
 * Called once by each entry point (CLI, server) before real work starts.
 * Returns what it activated so callers can report it.
 */
export async function initShow(): Promise<ShowIdentity> {
  const id = await activeProfileId();
  const identity = id ? await loadProfile(id) : DEFAULT_IDENTITY;
  setActiveIdentity(identity);
  return identity;
}

/** Flat field-by-field difference between two profiles, for `show compare`. */
export function compareProfiles(
  a: ShowIdentity,
  b: ShowIdentity,
): Array<{ path: string; a: unknown; b: unknown }> {
  const flat = (value: unknown, prefix: string, into: Map<string, unknown>): void => {
    if (Array.isArray(value) || value === null || typeof value !== 'object') {
      into.set(prefix, value);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flat(child, prefix ? `${prefix}.${key}` : key, into);
    }
  };

  const fa = new Map<string, unknown>();
  const fb = new Map<string, unknown>();
  flat(a, '', fa);
  flat(b, '', fb);

  const diffs: Array<{ path: string; a: unknown; b: unknown }> = [];
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    const va = fa.get(key);
    const vb = fb.get(key);
    if (canonicalJson(va) !== canonicalJson(vb)) diffs.push({ path: key, a: va, b: vb });
  }
  return diffs.sort((x, y) => x.path.localeCompare(y.path));
}
