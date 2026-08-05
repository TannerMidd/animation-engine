import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type {
  LlmStatus, Palette, ParamSpec, ParamValue, Primitive, PropDefInfo, PropDocument, PropRender,
} from '../types.ts';
import { Badge, Button, Empty, Field, Panel, Select, Spinner, TextInput } from './ui.tsx';
import { PropCanvas, type Tool } from './PropCanvas.tsx';
import { InteractionEditor, ParamControl, ParamEditor, PrimitiveInspector } from './PropInspector.tsx';
import { GenerateDialog } from './GenerateDialog.tsx';
import { useLlmStart } from './useLlmStart.ts';
import { PropBakeDialog } from './PropBakeDialog.tsx';

/**
 * Making a prop.
 *
 * Until now the only way to add one was to write TypeScript and restart the
 * server, which meant the catalogue was closed to everybody who was not editing
 * the engine. This is the same three columns as the set designer — pick on the
 * left, look in the middle, adjust on the right — because the two tools sit
 * next to each other in the same job and there is no reason to learn twice.
 *
 * Nothing here renders a prop. The canvas shows markup the engine produced, so
 * what is on screen is what will be in the film.
 */

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: '⌖', hint: 'Select and move' },
  { id: 'rect', label: '▭', hint: 'Rectangle' },
  { id: 'ellipse', label: '◯', hint: 'Ellipse' },
  { id: 'poly', label: '⬠', hint: 'Polygon — click each corner, double-click to close' },
  { id: 'line', label: '╱', hint: 'Line' },
  { id: 'text', label: 'T', hint: 'Text' },
];

const TODAY = new Date().toISOString().slice(0, 10);

function blankDocument(key: string): PropDocument {
  return {
    format: 2,
    key,
    label: key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    tags: ['interior'],
    spanning: false,
    params: [],
    provenance: { blender: 'none (drawn in the editor)', source: 'sha1:0', baked: TODAY },
    views: { default: { primitives: [{ k: 'rect', f: 'surface', x: -60, y: -120, w: 120, h: 120 }] } },
  };
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Present a format-1 document as primitives.
 *
 * A bake writes flat shapes, and the engine reads them as polygons — so the
 * studio has to as well, or opening a baked prop shows a picture with nothing
 * behind it. Editing one converts it, which is the honest outcome: it is a
 * drawing now, and its geometry no longer came only from Blender.
 */
function normalise(doc: PropDocument): PropDocument {
  const views: PropDocument['views'] = {};
  for (const [name, view] of Object.entries(doc.views)) {
    views[name] = {
      primitives: view.primitives ?? (view.shapes ?? []).map((s): Primitive => ({
        k: 'poly',
        p: s.p,
        ...(s.c === undefined ? {} : { c: s.c }),
        f: s.f ?? null,
        ...(s.l === undefined ? {} : { l: s.l }),
        ...(s.e === undefined ? {} : { e: s.e }),
      })),
    };
  }
  return { ...doc, format: 2, views };
}

// --- addressing a primitive inside nested repeats --------------------------

function primitiveAt(list: Primitive[], path: number[]): Primitive | null {
  const [head, ...rest] = path;
  const here = head === undefined ? null : list[head] ?? null;
  if (!here || rest.length === 0) return here;
  return here.k === 'repeat' ? primitiveAt(here.of, rest) : null;
}

function replacePrimitive(list: Primitive[], path: number[], change: (p: Primitive) => Primitive | null): Primitive[] {
  const [head, ...rest] = path;
  if (head === undefined || !list[head]) return list;
  const out = [...list];
  const target = out[head]!;

  if (rest.length === 0) {
    const next = change(target);
    if (next === null) out.splice(head, 1);
    else out[head] = next;
    return out;
  }
  if (target.k !== 'repeat') return list;
  out[head] = { ...target, of: replacePrimitive(target.of, rest, change) };
  return out;
}

function movePrimitive(list: Primitive[], path: number[], by: number): Primitive[] {
  const [head, ...rest] = path;
  if (head === undefined || !list[head]) return list;
  if (rest.length > 0) {
    const target = list[head]!;
    if (target.k !== 'repeat') return list;
    const out = [...list];
    out[head] = { ...target, of: movePrimitive(target.of, rest, by) };
    return out;
  }
  const to = head + by;
  if (to < 0 || to >= list.length) return list;
  const out = [...list];
  const [taken] = out.splice(head, 1);
  out.splice(to, 0, taken!);
  return out;
}

/** Shift a primitive's authored position, leaving any bound field alone. */
function shifted(prim: Primitive, dx: number, dy: number): Primitive {
  const move = (v: unknown, d: number) => (typeof v === 'number' ? Math.round(v + d) : v);
  switch (prim.k) {
    case 'rect': case 'text': return { ...prim, x: move(prim.x, dx) as number, y: move(prim.y, dy) as number };
    case 'ellipse': return { ...prim, cx: move(prim.cx, dx) as number, cy: move(prim.cy, dy) as number };
    case 'line': return {
      ...prim,
      x1: move(prim.x1, dx) as number, y1: move(prim.y1, dy) as number,
      x2: move(prim.x2, dx) as number, y2: move(prim.y2, dy) as number,
    };
    case 'poly': return { ...prim, p: prim.p.map((v, i) => move(v, i % 2 === 0 ? dx : dy) as number) };
    default: return prim;
  }
}

export function PropStudio({ open, llm, onCatalogueChanged }: {
  open: string | null;
  llm: LlmStatus | null;
  onCatalogueChanged?: () => void;
}) {
  const [catalogue, setCatalogue] = useState<PropDefInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState('all');
  const [palettes, setPalettes] = useState<Record<string, Palette>>({});
  const [paletteName, setPaletteName] = useState('office-fluorescent');

  const [key, setKey] = useState<string | null>(open);
  const [doc, setDoc] = useState<PropDocument | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [saved, setSaved] = useState(true);
  const [renames, setRenames] = useState<Record<string, string>>({});

  const [view, setView] = useState('default');
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<number[] | null>(null);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [render, setRender] = useState<PropRender | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [describing, setDescribing] = useState(false);
  const [baking, setBaking] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const llmStart = useLlmStart(llm);

  const refreshCatalogue = useCallback(async () => {
    const { props, tags: t } = await api.props();
    setCatalogue(props);
    setTags(t);
  }, []);

  useEffect(() => {
    void refreshCatalogue();
    void api.palettes().then(setPalettes).catch(() => {});
  }, [refreshCatalogue]);

  // Open a prop: its document if it has one, or a read-only shell if it is
  // still a coded built-in.
  useEffect(() => {
    if (!key) return;
    let live = true;
    void api.prop(key).then((detail) => {
      if (!live) return;
      setDoc(detail.document ? normalise(detail.document) : null);
      setReadOnly(!detail.editable);
      setSaved(true);
      setRenames({});
      setSelected(null);
      setView(Object.keys(detail.document?.views ?? { default: {} })[0] ?? 'default');
      setParams({});
    }).catch((e: Error) => setMessage({ tone: 'bad', text: e.message }));
    return () => { live = false; };
  }, [key]);

  /** Redraw through the engine whenever the document or the test values move. */
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!key && !doc) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api.renderProp({
        ...(doc ? { document: doc } : { key: key! }),
        params,
        palette: paletteName,
        view,
      })
        .then((r) => { setRender(r); setMessage(null); })
        .catch((e: Error) => setMessage({ tone: 'bad', text: e.message }));
    }, 140);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [doc, key, params, paletteName, view]);

  const mutate = (change: (d: PropDocument) => PropDocument) => {
    if (readOnly) return;
    setDoc((d) => (d ? change(structuredClone(d)) : d));
    setSaved(false);
  };

  const primitives = doc?.views[view]?.primitives ?? [];
  const setPrimitives = (next: Primitive[]) =>
    mutate((d) => ({ ...d, views: { ...d.views, [view]: { ...d.views[view], primitives: next } } }));

  const current = selected ? primitiveAt(primitives, selected) : null;
  const palette = palettes[paletteName] ?? {};

  const visible = useMemo(
    () => catalogue.filter((p) => tag === 'all' || p.tags.includes(tag)),
    [catalogue, tag],
  );

  // --- actions ---

  const create = async () => {
    const name = window.prompt('What is it called?', 'waste bin');
    if (!name) return;
    const clean = slug(name);
    if (!clean) return;
    if (catalogue.some((p) => p.key === clean)) {
      setMessage({ tone: 'bad', text: `There is already a prop called "${clean}".` });
      return;
    }
    setKey(null);
    setDoc(blankDocument(clean));
    setReadOnly(false);
    setSaved(false);
    setView('default');
    setSelected([0]);
    setParams({});
  };

  const duplicate = () => {
    if (!key) return;
    const name = window.prompt('Name for the copy', `${key}-2`);
    if (!name) return;
    const clean = slug(name);
    if (!clean) return;
    // A built-in has no document to copy, so a fork starts from a blank one
    // carrying its label and tags — the geometry is still a render function.
    const source = doc ?? blankDocument(clean);
    const info = catalogue.find((p) => p.key === key);
    setKey(null);
    setDoc({
      ...structuredClone(source),
      key: clean,
      label: `${info?.label ?? clean} copy`,
      provenance: { blender: 'none (drawn in the editor)', source: 'sha1:0', baked: TODAY },
    });
    setReadOnly(false);
    setSaved(false);
    setSelected(null);
  };

  const save = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const result = await api.saveProp(doc.key, doc, renames);
      setSaved(true);
      setRenames({});
      setKey(doc.key);
      await refreshCatalogue();
      onCatalogueChanged?.();
      const migrated = result.migratedSets.length
        ? ` Updated ${result.migratedSets.length} set${result.migratedSets.length === 1 ? '' : 's'} that use it.`
        : '';
      setMessage({ tone: 'good', text: `Saved.${migrated}${result.warnings.length ? ` ${result.warnings[0]}` : ''}` });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!key || readOnly) return;
    const usage = await api.propUsage(key).catch(() => ({ sets: [] as string[] }));
    const warning = usage.sets.length ? `\n\nIt is placed in: ${usage.sets.join(', ')}` : '';
    if (!window.confirm(`Delete "${key}"?${warning}`)) return;
    setBusy(true);
    try {
      await api.deleteProp(key);
      setKey(null);
      setDoc(null);
      setRender(null);
      await refreshCatalogue();
      onCatalogueChanged?.();
      setMessage({ tone: 'good', text: 'Deleted.' });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      const result = await api.checkProp(doc ? { document: doc } : { key: key! });
      setMessage(result.ok
        ? { tone: 'good', text: 'Renders in every palette, at every setting.' }
        : { tone: 'bad', text: result.problems.slice(0, 3).join(' · ') });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Describe it, then edit it.
   *
   * The result is never saved: a local model drawing a recognisable object from
   * coordinates is the least certain part of this tool, so what comes back is a
   * starting point on the canvas rather than a file somebody has to go and
   * delete.
   */
  const describe = async (text: string) => {
    setGenBusy(true);
    setGenError(null);
    try {
      const proposed = slug(text) || 'new-prop';
      const unique = catalogue.some((p) => p.key === proposed) ? `${proposed}-2` : proposed;
      const result = await api.generateProp(text, unique);
      setKey(null);
      setDoc(result.document);
      setReadOnly(false);
      setSaved(false);
      setView('default');
      setSelected(null);
      setParams({});
      setDescribing(false);
      setMessage(result.warnings.length
        ? { tone: 'bad', text: `${result.model}: ${result.warnings[0]}` }
        : { tone: 'good', text: `Drawn by ${result.model}. Nothing is saved yet.` });
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  const shapeCount = countPrimitives(primitives);

  return (
    <div className="h-full flex gap-2 p-2 min-h-0">
      {/* --- left: the catalogue --- */}
      <Panel
        title="Props"
        className="w-56 shrink-0"
        actions={
          <>
            <Button onClick={() => { setGenError(null); setDescribing(true); }} title="Describe it to the local model">
              Describe
            </Button>
            <Button onClick={() => setBaking(true)} title="Bake a shape that needs real form">
              Bake
            </Button>
            <Button variant="primary" onClick={() => void create()}>New</Button>
          </>
        }
      >
        <div className="p-1.5 border-b border-edge">
          <Select value={tag} options={['all', ...tags]} onChange={setTag} className="w-full" />
        </div>
        <div className="p-1">
          {visible.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setKey(p.key)}
              className={`w-full text-left px-2 py-1 rounded text-[12px] cursor-pointer flex items-center gap-1.5 ${
                p.key === key ? 'bg-accent/20 text-ink' : 'text-ink-dim hover:bg-panel-2'
              }`}
            >
              <span className="flex-1 truncate">{p.label}</span>
              {p.source === 'document' && <span className="text-[9px] text-accent" title="Drawn — editable">◆</span>}
              {p.spanning && <span className="text-[9px] text-ink-ghost" title="Spans the set">▤</span>}
            </button>
          ))}
        </div>
      </Panel>

      {/* --- centre: the canvas --- */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 shrink-0">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.hint}
              disabled={readOnly || !doc}
              onClick={() => setTool(t.id)}
              className={`w-7 h-7 rounded border text-[13px] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                tool === t.id ? 'border-accent bg-accent/20 text-ink' : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="w-px h-5 bg-edge mx-1" />
          <Select value={paletteName} options={Object.keys(palettes)} onChange={setPaletteName} />
          {doc && Object.keys(doc.views).length > 1 && (
            <Select value={view} options={Object.keys(doc.views)} onChange={setView} />
          )}
          <div className="flex-1" />
          {busy && <Spinner />}
          {message && (
            <span className={`text-[11px] ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}>{message.text}</span>
          )}
          <Badge tone={shapeCount > 120 ? 'warn' : 'neutral'}>{shapeCount} shapes</Badge>
        </div>

        <div className="flex-1 min-h-0 border border-edge rounded-md overflow-hidden bg-well">
          {doc || render ? (
            <PropCanvas
              render={render}
              tool={readOnly ? 'select' : tool}
              selected={selected}
              spanning={doc?.spanning ?? render?.spanning ?? false}
              onSelect={setSelected}
              onDraw={(prim) => {
                setPrimitives([...primitives, prim]);
                setSelected([primitives.length]);
              }}
              onNudge={(path, dx, dy) => setPrimitives(replacePrimitive(primitives, path, (p) => shifted(p, dx, dy)))}
              onFinishTool={() => setTool('select')}
            />
          ) : (
            <Empty>
              Pick a prop to look at it, or make a new one.
              <br />
              Drawn props can be edited; the built-in ones can be duplicated.
            </Empty>
          )}
        </div>
      </div>

      {/* --- right: the inspector --- */}
      <Panel title={readOnly ? 'Built-in prop' : 'Prop'} className="w-[302px] shrink-0" bodyClass="p-2.5">
        {!doc && !key && <Empty>Nothing open.</Empty>}

        {key && readOnly && (
          <div className="mb-3">
            <div className="text-[12px] text-ink-dim leading-snug mb-2">
              This one is still a render function in the engine, so there is nothing to edit here yet.
              Duplicate it to get a drawing you can change.
            </div>
            <Button variant="primary" onClick={duplicate}>Duplicate &amp; edit</Button>
          </div>
        )}

        {doc && (
          <>
            <Field label="Name">
              <TextInput value={doc.label} onChange={(label) => mutate((d) => ({ ...d, label }))} />
            </Field>
            <Field label="Key" hint="How sets and scripts refer to it. Fixed once saved.">
              <TextInput
                value={doc.key}
                disabled={!!key}
                onChange={(v) => mutate((d) => ({ ...d, key: slug(v) }))}
              />
            </Field>
            <Field label="Tags" hint="Comma separated. These are the designer's filters.">
              <TextInput
                value={doc.tags.join(', ')}
                onChange={(v) => mutate((d) => ({ ...d, tags: v.split(',').map((t) => t.trim()).filter(Boolean) }))}
              />
            </Field>

            <div className="flex gap-1.5 mb-3">
              <Button variant="primary" onClick={() => void save()} disabled={busy || saved}>
                {saved ? 'Saved' : 'Save'}
              </Button>
              <Button onClick={() => void check()} disabled={busy}>Check</Button>
              {key && <Button variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Button>}
            </div>

            <Section title="Shape">
              {current ? (
                <PrimitiveInspector
                  primitive={current}
                  params={doc.params}
                  palette={palette}
                  onChange={(patch) => setPrimitives(replacePrimitive(primitives, selected!, (p) => ({ ...p, ...patch } as Primitive)))}
                  onDelete={() => {
                    setPrimitives(replacePrimitive(primitives, selected!, () => null));
                    setSelected(null);
                  }}
                  onRaise={() => setPrimitives(movePrimitive(primitives, selected!, 1))}
                  onLower={() => setPrimitives(movePrimitive(primitives, selected!, -1))}
                  onRepeat={() => {
                    // Step down and to the right by default: visible at once, so
                    // the count control has something to obviously act on.
                    const count = doc.params.find((p) => p.type === 'number' && /count|shelves|drawers|steps|rows|panes/i.test(p.key));
                    setPrimitives(replacePrimitive(primitives, selected!, (p) => ({
                      k: 'repeat', n: count?.key ?? 4, dx: 0, dy: -70, of: [p],
                    })));
                    setSelected([...selected!]);
                  }}
                  onUnwrap={() => setPrimitives(replacePrimitive(primitives, selected!, (p) =>
                    p.k === 'repeat' ? p.of[0] ?? null : p))}
                />
              ) : (
                <div className="text-[11px] text-ink-faint">
                  Pick a shape on the canvas, or draw one with the tools above.
                </div>
              )}
            </Section>

            <Section title="Being used">
              <InteractionEditor
                doc={doc}
                onChange={(interaction) => mutate((d) => ({ ...d, interaction }))}
              />
            </Section>

            <Section title="Controls">
              <ParamEditor
                doc={doc}
                onChange={(next, renamed) => {
                  mutate((d) => ({ ...d, params: next }));
                  if (Object.keys(renamed).length) setRenames((r) => ({ ...r, ...renamed }));
                }}
              />
            </Section>

            {doc.params.length > 0 && (
              <Section title="Try it">
                {doc.params.map((spec: ParamSpec) => (
                  <ParamControl
                    key={spec.key}
                    spec={spec}
                    value={params[spec.key] ?? spec.default}
                    onChange={(v) => setParams((p) => ({ ...p, [spec.key]: v }))}
                  />
                ))}
                <Button variant="ghost" onClick={() => setParams({})}>Back to defaults</Button>
              </Section>
            )}
          </>
        )}
      </Panel>

      {baking && (
        <PropBakeDialog
          taken={catalogue.map((p) => p.key)}
          onClose={() => setBaking(false)}
          onBaked={(baked) => {
            setBaking(false);
            void refreshCatalogue();
            onCatalogueChanged?.();
            setKey(baked);
            setMessage({ tone: 'good', text: 'Baked. It is in the catalogue now.' });
          }}
        />
      )}

      {describing && (
        <GenerateDialog
          title="Describe a prop"
          label="What is it?"
          placeholder="a dented metal waste bin"
          hint="You get a drawing to edit, not a finished prop. Nothing is saved until you save it."
          examples={['a dented metal waste bin', 'a tall filing cabinet with four drawers', 'a potted fern', 'a stack of pizza boxes']}
          busy={genBusy}
          error={genError}
          disabled={!llmStart.status?.ok}
          disabledReason={llmStart.status?.reason ?? null}
          startable={llmStart.startable}
          starting={llmStart.starting}
          startError={llmStart.startError}
          onStart={() => void llmStart.start()}
          onGenerate={(text) => void describe(text)}
          onClose={() => setDescribing(false)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-edge pt-2.5 mt-2.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function countPrimitives(list: Primitive[]): number {
  let n = 0;
  for (const prim of list) {
    if (prim.k === 'repeat') n += countPrimitives(prim.of) * Math.max(1, typeof prim.n === 'number' ? Math.round(prim.n) : 4);
    else n += 1;
  }
  return n;
}
