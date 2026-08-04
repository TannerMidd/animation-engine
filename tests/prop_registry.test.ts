import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  reloadProps, propKeys, allProps, propManifest, propTags, getProp, bakedErrors, bakedTotals,
} from '../src/sets/props/index.ts';
import { setJsonSchema } from '../src/llm/set.ts';
import { tempDir } from './helpers.ts';

/**
 * The registry is no longer fixed at startup.
 *
 * Props are authored while the server is running, so the vocabulary a set can
 * draw on changes underneath everything that reads it — the designer palette,
 * validation, and the enum handed to a model. These pin the two properties that
 * makes safe: a new document becomes a first-class prop immediately, and a
 * document that would collide with an existing key changes nothing at all.
 */

const dirs: string[] = [];

/** Always put the process back on the real catalogue, whatever a test did. */
afterEach(() => reloadProps());
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  reloadProps();
});

function document(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 2,
    key,
    label: `Prop ${key}`,
    tags: ['test', 'drawn'],
    provenance: { blender: 'none (drawn in the editor)', source: 'sha1:0', baked: '2026-08-04' },
    views: { default: { primitives: [{ k: 'rect', f: 'wood', x: -40, y: -60, w: 80, h: 60 }] } },
    ...overrides,
  };
}

async function withDocuments(docs: Array<Record<string, unknown>>): Promise<string> {
  const dir = await tempDir('props');
  dirs.push(dir);
  for (const doc of docs) {
    const key = doc['key'] as string;
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, `${key}.geo.json`), JSON.stringify(doc), 'utf8');
  }
  return dir;
}

describe('a prop written to disk becomes a prop', () => {
  it('appears in the registry without a restart', async () => {
    expect(propKeys()).not.toContain('waste-bin');
    reloadProps(await withDocuments([document('waste-bin')]));

    expect(propKeys()).toContain('waste-bin');
    expect(getProp('waste-bin').label).toBe('Prop waste-bin');
    expect(allProps()['waste-bin']).toBeDefined();
  });

  it('reaches every consumer of the registry at once', async () => {
    reloadProps(await withDocuments([document('waste-bin')]));

    // The designer palette.
    expect(propManifest().map((p) => p.key)).toContain('waste-bin');
    expect(propTags()).toContain('drawn');

    // The enum a model is constrained to, which is why it cannot name a prop
    // that does not exist — and must therefore learn about ones that now do.
    const schema = setJsonSchema() as {
      properties: { layers: { properties: { back: { items: { properties: { prop: { enum: string[] } } } } } } };
    };
    expect(schema.properties.layers.properties.back.items.properties.prop.enum).toContain('waste-bin');
  });

  it('marks which props can be edited and which are built in', async () => {
    reloadProps(await withDocuments([document('waste-bin')]));
    const manifest = propManifest();
    expect(manifest.find((p) => p.key === 'waste-bin')?.source).toBe('document');
    expect(manifest.find((p) => p.key === 'desk')?.source).toBe('builtin');
  });

  it('disappears again when the document is removed', async () => {
    const dir = await withDocuments([document('waste-bin')]);
    reloadProps(dir);
    expect(propKeys()).toContain('waste-bin');

    await fsp.rm(path.join(dir, 'waste-bin'), { recursive: true, force: true });
    reloadProps(dir);
    expect(propKeys()).not.toContain('waste-bin');
  });

  it('keeps the keys sorted, since they are handed out as an enum', async () => {
    reloadProps(await withDocuments([document('aaa-first'), document('zzz-last')]));
    expect(propKeys()).toEqual([...propKeys()].sort());
  });
});

describe('a collision changes nothing', () => {
  it('refuses to let a document shadow a coded prop, and says where both are', async () => {
    const before = propKeys();
    const dir = await withDocuments([document('desk')]);

    expect(() => reloadProps(dir)).toThrow(/duplicate prop key "desk"/);

    // The important half: the throw must not leave the process without a
    // catalogue. Every set that rendered a moment ago still can.
    expect(propKeys()).toEqual(before);
    expect(getProp('desk').label).toBe('Desk');
  });
});

describe('a broken document is reported, not thrown', () => {
  it('collects the failure and leaves the rest of the catalogue working', async () => {
    const dir = await withDocuments([document('good-one')]);
    fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken', 'broken.geo.json'), '{ not json', 'utf8');

    expect(() => reloadProps(dir)).not.toThrow();
    expect(propKeys()).toContain('good-one');
    expect(propKeys()).not.toContain('broken');
    expect(bakedErrors().map((e) => e.file)).toContain('broken/broken.geo.json');
  });

  it('reports a document whose expression names something undeclared', async () => {
    const dir = await withDocuments([document('bad-maths', {
      views: { default: { primitives: [{ k: 'rect', f: 'wood', x: 'depth * 2', y: 0, w: 1, h: 1 }] } },
    })]);

    reloadProps(dir);
    expect(propKeys()).not.toContain('bad-maths');
    expect(bakedErrors()[0]?.error).toMatch(/unknown name "depth"/);
  });

  it('reports a key that does not match its directory', async () => {
    const dir = await tempDir('props');
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'stated-name'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'stated-name', 'stated-name.geo.json'),
      JSON.stringify(document('other-name')),
      'utf8',
    );

    reloadProps(dir);
    expect(bakedErrors()[0]?.error).toMatch(/does not match its directory/);
  });

  it('counts geometry so a bloated catalogue is visible without opening files', async () => {
    reloadProps(await withDocuments([document('waste-bin')]));
    expect(bakedTotals().shapes).toBe(1);
    expect(bakedTotals().points).toBe(4);
  });
});

describe('the real catalogue', () => {
  it('loads with no errors at all', () => {
    reloadProps();
    expect(bakedErrors()).toEqual([]);
  });

  it('is restored after every one of these tests', () => {
    expect(propKeys()).toContain('desk');
    expect(propKeys()).toContain('crate-stack');
    expect(propKeys()).not.toContain('waste-bin');
  });
});
