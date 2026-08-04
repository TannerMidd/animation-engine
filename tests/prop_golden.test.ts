import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { PROP_KEYS, getProp, type ParamSpec } from '../src/sets/props/index.ts';
import { PALETTES, PALETTE_NAMES } from '../src/sets/palettes.ts';
import { geometryFor, type ParamValue } from '../src/sets/schema.ts';
import { setActiveIdentity } from '../src/show/context.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';

/**
 * The rendering of every prop, pinned byte for byte.
 *
 * The prop catalogue is moving out of TypeScript and into data: each prop
 * becomes a document of primitives that the same drawing helpers render. That
 * migration is only safe if "the desk still looks exactly like the desk" is a
 * thing a machine can check, so this captures the current output of all 47
 * props before any of it moves and holds the new implementation to it.
 *
 * It is a corpus rather than a handful of spot checks because the failure it
 * exists to catch is a prop nobody thought to look at — a rounding difference
 * in one arm of a chair, a fill that stopped being misregistered. Every prop in
 * every palette, and every parameter at both ends of its range.
 *
 * Regenerate deliberately, never reflexively:
 *
 *   UPDATE_PROP_GOLDEN=1 npx vitest run tests/prop_golden.test.ts
 *
 * A diff here is a change to what the show looks like. Read it.
 */

const CORPUS = fileURLToPath(new URL('./reference/prop-golden.json', import.meta.url));

/** Extremes are pinned in one palette; a palette only ever changes colours. */
const BASE = 'office-fluorescent';

const geo = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });

interface Case {
  id: string;
  key: string;
  palette: string;
  params: Record<string, ParamValue>;
}

/** Both ends of a param's range, plus the values that have their own code path. */
function edges(spec: ParamSpec): Array<[string, ParamValue]> {
  switch (spec.type) {
    case 'number':
      return [['min', spec.min ?? 0], ['max', spec.max ?? 1000]];
    case 'boolean':
      return [['true', true], ['false', false]];
    case 'choice':
      return (spec.choices ?? []).map((c) => [c, c] as [string, ParamValue]);
    case 'text':
      // The second one pins escaping: a text param must never reach the page as
      // markup, and that is exactly the kind of thing a reimplementation drops.
      return [['long', 'WIDE LOAD 12345'], ['markup', '<script>&"x"</script>']];
  }
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const key of PROP_KEYS) {
    // Defaults in every palette: catches a prop reaching for a slot whose
    // meaning differs between palettes.
    for (const palette of PALETTE_NAMES) {
      out.push({ id: `${key} | ${palette} | default`, key, palette, params: {} });
    }
    // Every param at its edges: catches geometry.
    for (const spec of getProp(key).params) {
      for (const [label, value] of edges(spec)) {
        out.push({
          id: `${key} | ${BASE} | ${spec.key}=${label}`,
          key,
          palette: BASE,
          params: { [spec.key]: value },
        });
      }
    }
  }
  return out;
}

function render(c: Case): string {
  return getProp(c.key).render({
    palette: PALETTES[c.palette]!,
    geo,
    params: c.params,
    x: 640,
    y: 566,
  });
}

/** One entry per line, sorted — so a re-render diffs as the props that moved. */
function serialise(entries: Record<string, string>): string {
  const body = Object.keys(entries)
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(entries[k])}`)
    .join(',\n');
  return `{\n${body}\n}\n`;
}

describe('prop golden corpus', () => {
  beforeAll(() => {
    // The house style is identity-owned and the env var is a dev override, so
    // pin both: a corpus captured under `ANIM_STYLE=clean` would be unwobbled
    // and would fail for everyone else.
    delete process.env['ANIM_STYLE'];
    setActiveIdentity(DEFAULT_IDENTITY);
  });

  it('reproduces the committed rendering of every prop', () => {
    const actual: Record<string, string> = {};
    for (const c of cases()) actual[c.id] = render(c);

    if (process.env['UPDATE_PROP_GOLDEN']) {
      fs.writeFileSync(CORPUS, serialise(actual));
      return;
    }

    expect(fs.existsSync(CORPUS), `no corpus at ${CORPUS} — regenerate it`).toBe(true);
    const golden = JSON.parse(fs.readFileSync(CORPUS, 'utf8')) as Record<string, string>;

    // Report the shape of the change before the content of it. A prop that
    // gained or lost a param shows up here as a whole missing group, which is a
    // very different problem from a prop that draws itself differently.
    const added = Object.keys(actual).filter((k) => !(k in golden));
    const removed = Object.keys(golden).filter((k) => !(k in actual));
    expect(added, 'cases with no golden entry').toEqual([]);
    expect(removed, 'golden entries no longer produced').toEqual([]);

    const changed = Object.keys(actual).filter((k) => actual[k] !== golden[k]);
    expect(changed, `${changed.length} props render differently`).toEqual([]);
  });

  it('covers every prop in every palette', () => {
    const all = cases();
    for (const key of PROP_KEYS) {
      const mine = all.filter((c) => c.key === key);
      expect(new Set(mine.map((c) => c.palette)).size, key).toBeGreaterThanOrEqual(PALETTE_NAMES.length);
    }
    expect(all.length).toBeGreaterThan(PROP_KEYS.length * PALETTE_NAMES.length);
  });

  it('pins a rendering that actually drew something', () => {
    // A corpus of empty strings would pass every comparison above forever.
    for (const c of cases()) {
      expect(render(c).length, c.id).toBeGreaterThan(0);
    }
  });
});
