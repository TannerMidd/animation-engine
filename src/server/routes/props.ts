import fs from 'node:fs/promises';
import path from 'node:path';
import { json, readJson, HttpError, type Router } from '../http.ts';
import { protectRunningRenderState } from '../state.ts';
import { PROPS_DIR, ROOT } from '../../core/paths.ts';
import {
  PropDocument, propFromDocument, propManifest, propTags, propKeys, allProps,
  getProp, reloadProps, BAKE_BUDGET, documentBoxes,
} from '../../sets/props/index.ts';
import type { PropDef } from '../../sets/props/types.ts';
import { PALETTES, PALETTE_NAMES, getPalette } from '../../sets/palettes.ts';
import { geometryFor, LAYERS, type ParamValue, type SetDescriptor } from '../../sets/schema.ts';
import { listSets, loadSet, saveSet } from '../../sets/index.ts';

/**
 * Authoring props over HTTP.
 *
 * The set routes could stay read-only about props because a prop was a piece of
 * TypeScript; the only way to add one was to edit the source and restart. These
 * are the routes that stop being true — write a document, the registry reloads,
 * and the prop is in the designer palette without anybody touching a file.
 *
 * The shape deliberately mirrors the set routes next door: a GET for the
 * document, a PUT that validates before it writes, and a render endpoint that
 * takes its subject in the request body so the studio can look at something it
 * has not saved.
 */

const KEY = /^[a-z0-9][a-z0-9-]*$/;

/** The default stage, which is what a prop is drawn against in isolation. */
const GEO = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });

function requireKey(raw: string): string {
  if (!KEY.test(raw)) {
    throw new HttpError(400, `"${raw}" is not a valid prop key — lowercase letters, digits and hyphens`);
  }
  return raw;
}

const documentPath = (key: string) => path.join(PROPS_DIR, key, `${key}.geo.json`);

async function readDocument(key: string): Promise<PropDocument | null> {
  try {
    return PropDocument.parse(JSON.parse(await fs.readFile(documentPath(key), 'utf8')));
  } catch {
    return null;
  }
}

/** What the studio needs to list and open a prop, whether or not it is editable. */
function summarise(key: string, def: PropDef, document: PropDocument | null) {
  return {
    key,
    label: def.label,
    tags: def.tags,
    spanning: def.spanning ?? false,
    params: def.params,
    interaction: def.interaction ?? null,
    /**
     * Coded props cannot be edited in place — there is no document behind them.
     * The studio offers to duplicate one into a document instead, which is the
     * honest version of "edit" for something that is still a render function.
     */
    editable: document !== null,
    document,
  };
}

/**
 * Every number that reaches the page, so the canvas can frame the prop.
 *
 * Read off the emitted markup rather than walked over the primitives: the house
 * style moves geometry — the wobble pushes points out, the fill sits off
 * register — and a box drawn from the authored numbers would crop it.
 */
function extentOf(svg: string): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    const nums = m[1]!.match(/-?\d+(?:\.\d+)?/g);
    if (!nums) continue;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = Number(nums[i]);
      const y = Number(nums[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  for (const m of svg.matchAll(/<(?:rect|ellipse|text)\s[^>]*?\b(?:x|cx)="(-?\d+(?:\.\d+)?)"[^>]*?\b(?:y|cy)="(-?\d+(?:\.\d+)?)"/g)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

interface RenderRequest {
  document?: unknown;
  key?: string;
  params?: Record<string, ParamValue>;
  palette?: string;
  view?: string;
}

/** Build the prop a request is talking about: a document in the body, or a registered key. */
function subjectOf(body: RenderRequest): PropDef {
  if (body.document !== undefined) {
    const doc = PropDocument.parse(body.document);
    try {
      return propFromDocument(doc);
    } catch (err) {
      // A bad expression is a 400, not a 500: the document parsed, it just
      // names something that does not exist.
      throw new HttpError(400, (err as Error).message);
    }
  }
  if (!body.key) throw new HttpError(400, 'need a document or a key');
  try {
    return getProp(body.key);
  } catch (err) {
    throw new HttpError(404, (err as Error).message);
  }
}

/**
 * Render a prop everywhere it has to work.
 *
 * The same sweep the catalogue test does — every palette, every param at both
 * ends — run against one prop so the studio can say "this is fine" before it is
 * saved rather than after a set using it fails to render.
 */
function checkProp(def: PropDef): string[] {
  const problems: string[] = [];

  const attempt = (label: string, palette: string, params: Record<string, ParamValue>): void => {
    let svg: string;
    try {
      svg = def.render({ palette: getPalette(palette), geo: GEO, params, x: 640, y: 566 });
    } catch (err) {
      problems.push(`${label}: ${(err as Error).message}`);
      return;
    }
    if (!svg.length) problems.push(`${label}: draws nothing`);
    if (svg.includes('NaN')) problems.push(`${label}: produced NaN — check the arithmetic`);
    if (svg.includes('undefined')) problems.push(`${label}: produced "undefined" — check the palette slots`);
  };

  for (const palette of PALETTE_NAMES) attempt(palette, palette, {});

  for (const spec of def.params) {
    if (spec.type === 'number') {
      for (const [edge, value] of [['min', spec.min], ['max', spec.max]] as const) {
        if (typeof value === 'number') attempt(`${spec.key}=${edge}`, 'office-fluorescent', { [spec.key]: value });
      }
    } else if (spec.type === 'boolean') {
      for (const value of [true, false]) attempt(`${spec.key}=${value}`, 'office-fluorescent', { [spec.key]: value });
    } else if (spec.type === 'choice') {
      for (const value of spec.choices ?? []) attempt(`${spec.key}=${value}`, 'office-fluorescent', { [spec.key]: value });
    }
  }

  return problems;
}

/** Which sets place this prop, so a rename or a deletion is never a surprise. */
async function setsUsing(key: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listSets()) {
    let desc: SetDescriptor;
    try {
      desc = await loadSet(name);
    } catch {
      continue;
    }
    if (LAYERS.some((layer) => desc.layers[layer].some((inst) => inst.prop === key))) out.push(name);
  }
  return out;
}

/**
 * Carry saved sets across a change to a prop's parameters.
 *
 * `validateSet` refuses a param the prop does not declare, so renaming one
 * would strand every set that used it. Warning about that would be no use to
 * anybody — the sets are right there and the fix is mechanical — so the sets
 * are brought along and the studio reports how many moved.
 */
async function migrateSets(key: string, known: Set<string>, renames: Record<string, string>): Promise<string[]> {
  const touched: string[] = [];

  for (const name of await listSets()) {
    let desc: SetDescriptor;
    try {
      desc = await loadSet(name);
    } catch {
      continue;
    }

    let changed = false;
    for (const layer of LAYERS) {
      for (const inst of desc.layers[layer]) {
        if (inst.prop !== key) continue;
        for (const param of Object.keys(inst.params)) {
          const renamed = renames[param];
          if (renamed && known.has(renamed)) {
            inst.params[renamed] = inst.params[param]!;
            delete inst.params[param];
            changed = true;
          } else if (!known.has(param)) {
            delete inst.params[param];
            changed = true;
          }
        }
      }
    }

    if (changed) {
      await saveSet(desc);
      touched.push(name);
    }
  }

  return touched;
}

export function registerPropRoutes(router: Router): void {
  router.get('/api/props', ({ res }) => json(res, { props: propManifest(), tags: propTags() }));

  /** Full palettes, so the studio can offer slots as swatches rather than as names. */
  router.get('/api/palettes', ({ res }) => json(res, PALETTES));

  router.get('/api/props/:key', async ({ res, params }) => {
    const key = requireKey(params['key']!);
    const def = allProps()[key];
    if (!def) throw new HttpError(404, `no prop "${key}"`);
    json(res, summarise(key, def, await readDocument(key)));
  });

  router.put('/api/props/:key', async ({ req, res, params }) => {
    protectRunningRenderState('props');
    const key = requireKey(params['key']!);
    const body = await readJson<{ document: unknown; renames?: Record<string, string> }>(req);

    const doc = PropDocument.parse(body.document);
    if (doc.key !== key) throw new HttpError(400, `document key "${doc.key}" does not match "${key}"`);

    // A collision with a coded prop must be refused here. `mergeProps` would
    // catch it on reload, but by then the file is on disk and the registry
    // throws for everyone until somebody deletes it by hand.
    const existing = await readDocument(key);
    if (!existing && allProps()[key]) {
      throw new HttpError(409, `"${key}" is already a built-in prop — pick another name, or duplicate it instead`);
    }

    let def: PropDef;
    try {
      def = propFromDocument(doc);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    const problems = checkProp(def);
    if (problems.length) throw new HttpError(400, problems.slice(0, 6).join('; '));

    await fs.mkdir(path.join(PROPS_DIR, key), { recursive: true });
    await fs.writeFile(documentPath(key), JSON.stringify(doc, null, 2) + '\n', 'utf8');

    try {
      reloadProps();
    } catch (err) {
      // The registry rolled itself back, so the only broken thing is the file
      // we just wrote. Take it away again rather than leave a landmine.
      await fs.rm(path.join(PROPS_DIR, key), { recursive: true, force: true });
      reloadProps();
      throw new HttpError(409, (err as Error).message);
    }

    const known = new Set(doc.params.map((p) => p.key));
    const migrated = await migrateSets(key, known, body.renames ?? {});

    const counted = Object.values(doc.views).reduce(
      (sum, view) => sum + (view.primitives?.length ?? view.shapes?.length ?? 0),
      0,
    );
    json(res, {
      ok: true,
      path: path.relative(ROOT, documentPath(key)),
      migratedSets: migrated,
      warnings: counted > BAKE_BUDGET.warnShapes
        ? [`${counted} shapes is past the ${BAKE_BUDGET.warnShapes} the house style was tuned for`]
        : [],
    });
  });

  router.del('/api/props/:key', async ({ res, params }) => {
    protectRunningRenderState('props');
    const key = requireKey(params['key']!);

    if (!await readDocument(key)) {
      throw new HttpError(allProps()[key] ? 409 : 404, allProps()[key]
        ? `"${key}" is a built-in prop and is not deletable`
        : `no prop "${key}"`);
    }

    const used = await setsUsing(key);
    if (used.length) {
      throw new HttpError(409, `"${key}" is placed in ${used.join(', ')} — remove it there first`);
    }

    await fs.rm(path.join(PROPS_DIR, key), { recursive: true, force: true });
    reloadProps();
    json(res, { ok: true });
  });

  /**
   * One prop, rendered.
   *
   * Takes the document in the request body rather than reading from disk, so
   * the studio's canvas shows what is being drawn rather than what was last
   * saved — the same bargain the set preview makes.
   */
  router.post('/api/props/render', async ({ req, res }) => {
    const body = await readJson<RenderRequest>(req);
    const def = subjectOf(body);
    const palette = body.palette ?? 'office-fluorescent';
    const document = body.document === undefined ? null : PropDocument.parse(body.document);

    let svg: string;
    try {
      svg = def.render({
        palette: getPalette(palette),
        geo: GEO,
        params: { ...(body.view ? { view: body.view } : {}), ...(body.params ?? {}) },
        x: 640,
        y: 566,
      });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    const warnings: string[] = [];
    if (svg.includes('NaN')) warnings.push('some geometry evaluated to NaN');
    if (!svg.length) warnings.push('this draws nothing at these values');

    json(res, {
      svg,
      extent: extentOf(svg),
      // Where each primitive landed, so the canvas can put a handle on it
      // without reimplementing the expression language to find out.
      boxes: document ? documentBoxes(document, body.params ?? {}, body.view) : [],
      spanning: def.spanning ?? false,
      params: def.params,
      interaction: def.interactionFor?.(body.params ?? {}) ?? def.interaction ?? null,
      warnings,
    });
  });

  /** The per-prop form of the catalogue test, so the studio can say "this holds". */
  router.post('/api/props/check', async ({ req, res }) => {
    const body = await readJson<RenderRequest>(req);
    const problems = checkProp(subjectOf(body));
    json(res, { ok: problems.length === 0, problems });
  });

  /** Which sets would be affected by editing or deleting this prop. */
  router.get('/api/props/:key/usage', async ({ res, params }) => {
    const key = requireKey(params['key']!);
    if (!propKeys().includes(key)) throw new HttpError(404, `no prop "${key}"`);
    json(res, { sets: await setsUsing(key) });
  });
}
