import path from 'node:path';

/**
 * A file-backed project entity identifier.
 *
 * Scene, cast, set and prop names become path segments. Keeping one definition
 * prevents an encoded slash or Windows separator from turning an API identifier
 * into a filesystem path. Dots are allowed, except for the special `.` and
 * `..` directory segments.
 */
export const PROJECT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

export class InvalidProjectIdError extends Error {
  constructor(
    readonly value: string,
    readonly label = 'project identifier',
  ) {
    super(`${label} "${value}" must be 1-128 letters, numbers, ., _ or - and cannot be . or ..`);
    this.name = 'InvalidProjectIdError';
  }
}

export function projectId(value: string, label = 'project identifier'): string {
  if (!PROJECT_ID_PATTERN.test(value)) throw new InvalidProjectIdError(value, label);
  return value;
}

/** Resolve a descendant path, rejecting sibling-prefix and traversal tricks. */
export function resolveWithin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...parts);
  const relative = path.relative(base, candidate);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return candidate;
  }
  throw new Error(`path escapes ${base}: ${candidate}`);
}
