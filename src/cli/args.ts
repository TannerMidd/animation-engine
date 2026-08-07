export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Small, deterministic argument parser for the dependency-free local CLI. */
export function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith('--')) {
      const key = argument.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(argument);
    }
  }
  return { _, flags };
}

export function numberFlag(flags: Args['flags'], key: string, fallback: number): number {
  const value = flags[key];
  if (value === undefined || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number, got "${value}"`);
  return parsed;
}

/** A flag as a number, or undefined so the pipeline default applies. */
export function optionalNumberFlag(flags: Args['flags'], key: string): number | undefined {
  return flags[key] === undefined ? undefined : numberFlag(flags, key, 0);
}
