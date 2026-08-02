import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { LayerName, LlmStatus, ParamSpec, PropDefInfo, PropInstance, SetDescriptor, Vocab } from '../types.ts';
import { GenerateDialog } from './GenerateDialog.tsx';
import { Button, Panel, Select, NumberInput, TextInput, Field, Empty, Badge } from './ui.tsx';
import { ScaledFrame } from './ScaledFrame.tsx';
import { StageOverlay } from './StageOverlay.tsx';

const LAYERS: LayerName[] = ['back', 'mid', 'fore'];

/**
 * Build environments visually.
 *
 * Previewed with characters staged in it, because a set is impossible to judge
 * empty — the only question that matters is whether people read against it.
 * The layer tabs are depth: characters render between `mid` and `fore`.
 */
export function SetDesigner({ vocab, llm }: { vocab: Vocab | null; llm: LlmStatus | null }) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState<string>('');
  const [desc, setDesc] = useState<SetDescriptor | null>(null);
  const [props, setProps] = useState<PropDefInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState('all');
  const [layer, setLayer] = useState<LayerName>('back');
  const [selected, setSelected] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [list, reg] = await Promise.all([api.sets(), api.props()]);
      setNames(list.map((s) => s.name));
      setProps(reg.props);
      setTags(reg.tags);
      if (!name && list[0]) setName(list[0].name);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!name) return;
    setSelected(null);
    void api.set(name).then(setDesc).catch((e: Error) => setError(e.message));
  }, [name]);

  // Preview follows the working copy, so unsaved edits are visible.
  const refresh = useCallback(async (d: SetDescriptor) => {
    try {
      const res = await api.setPreview(d.name, d);
      setPreviewId(res.previewId);
      setNotes(res.notes ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!desc) return;
    const t = setTimeout(() => void refresh(desc), 180);
    return () => clearTimeout(t);
  }, [desc, refresh]);

  const propDef = (key: string) => props.find((p) => p.key === key);
  const items = desc?.layers[layer] ?? [];
  const current = selected !== null ? items[selected] : undefined;
  const currentDef = current ? propDef(current.prop) : undefined;

  const visibleProps = useMemo(
    () => (tag === 'all' ? props : props.filter((p) => p.tags.includes(tag))),
    [props, tag],
  );

  const mutate = (fn: (d: SetDescriptor) => SetDescriptor) => {
    setDesc((d) => (d ? fn(structuredClone(d)) : d));
    setSaved(false);
  };

  const nextPropId = (d: SetDescriptor, key: string): string => {
    const used = new Set(
      LAYERS.flatMap((candidate) => d.layers[candidate])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id)),
    );
    let ordinal = 1;
    while (used.has(`${key}-${ordinal}`)) ordinal += 1;
    return `${key}-${ordinal}`;
  };

  const addProp = (key: string) => {
    const def = propDef(key);
    mutate((d) => {
      d.layers[layer].push({
        id: nextPropId(d, key),
        prop: key,
        // Spanning props cover the whole set and ignore x, so don't give them one.
        ...(def?.spanning ? {} : { x: 640 }),
        scale: 1,
        flip: false,
        params: {},
      });
      return d;
    });
    setSelected(items.length);
  };

  const updateProp = (changes: Partial<PropInstance>) => {
    if (selected === null) return;
    mutate((d) => {
      const item = d.layers[layer][selected];
      if (item) Object.assign(item, changes);
      return d;
    });
  };

  const updateParam = (key: string, value: number | string | boolean) => {
    if (selected === null) return;
    mutate((d) => {
      const item = d.layers[layer][selected];
      if (item) item.params = { ...item.params, [key]: value };
      return d;
    });
  };

  const move = (delta: number) => {
    if (selected === null) return;
    const to = selected + delta;
    if (to < 0 || to >= items.length) return;
    mutate((d) => {
      const arr = d.layers[layer];
      const [item] = arr.splice(selected, 1);
      if (item) arr.splice(to, 0, item);
      return d;
    });
    setSelected(to);
  };

  const remove = () => {
    if (selected === null) return;
    mutate((d) => {
      d.layers[layer].splice(selected, 1);
      return d;
    });
    setSelected(null);
  };

  const save = async () => {
    if (!desc) return;
    try {
      await api.saveSet(desc.name, desc);
      setSaved(true);
      setError(null);
      setNames((n) => (n.includes(desc.name) ? n : [...n, desc.name].sort()));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveAs = async () => {
    if (!desc) return;
    const next = window.prompt('New set name', `${desc.name}-copy`);
    if (!next) return;
    const clean = next.trim().replace(/[^\w-]/g, '-').toLowerCase();
    const copy = { ...structuredClone(desc), name: clean };
    try {
      await api.saveSet(clean, copy);
      setNames((n) => [...new Set([...n, clean])].sort());
      setName(clean);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** Generated sets are saved immediately, then opened for adjustment. */
  const runDescribe = async (description: string) => {
    setGenBusy(true);
    setGenError(null);
    try {
      const suggested = description.trim().toLowerCase().split(/\s+/).slice(0, 3).join('-').replace(/[^\w-]/g, '');
      const res = await api.generateSet(description, suggested || 'generated-set');
      await api.saveSet(res.set.name, res.set);
      setNames((n) => [...new Set([...n, res.set.name])].sort());
      setName(res.set.name);
      setDescribing(false);
    } catch (err) {
      setGenError((err as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  if (!desc) return <Empty>{error ?? 'Loading sets…'}</Empty>;

  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      {describing && (
        <GenerateDialog
          title="Describe a set"
          label="Description"
          placeholder="A cramped break room at night, one flickering light, vending machine."
          hint="Props are placed from the catalogue below — it can only build from what exists."
          examples={[
            'A cramped break room at night with a vending machine',
            'A roadside bus stop at dusk, nothing around for miles',
            'A cheerful open-plan office that is trying too hard',
          ]}
          busy={genBusy}
          error={genError}
          disabled={llm ? !llm.ok : false}
          disabledReason={llm?.reason ?? null}
          onGenerate={(t) => void runDescribe(t)}
          onClose={() => {
            setDescribing(false);
            setGenError(null);
          }}
        />
      )}
      {/* left: layers + contents + palette */}
      <div className="w-[26%] shrink-0 flex flex-col gap-2 min-h-0">
        <Panel title="Set" bodyClass="p-2">
          <Select value={name} options={names} onChange={setName} className="w-full mb-2" />
          <Field label="Palette">
            <Select
              value={desc.palette}
              options={vocab?.palettes ?? [desc.palette]}
              onChange={(v) => mutate((d) => ({ ...d, palette: v }))}
              className="w-full"
            />
          </Field>
          <div className="flex gap-1">
            <Button variant="primary" onClick={() => void save()} className="flex-1">
              {saved ? 'Saved' : 'Save'}
            </Button>
            <Button onClick={() => void saveAs()}>Save as…</Button>
          </div>
          <Button
            className="w-full mt-1"
            onClick={() =>
              void api
                .tidySet(desc.name, desc)
                .then((r) => {
                  setDesc(r.set);
                  setSaved(false);
                })
                .catch((e: Error) => setError(e.message))
            }
            title="Fix the mechanical composition problems: furniture in front of the characters, props hovering, the middle of frame overcrowded."
          >
            Tidy composition
          </Button>
          <Button className="w-full mt-1" onClick={() => setDescribing(true)} title="Design a new set from a description.">
            Describe a new set…
          </Button>
        </Panel>

        <Panel
          title="Layers"
          className="flex-1 min-h-0"
          bodyClass="p-0"
          actions={
            <div className="flex gap-0.5">
              {LAYERS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => {
                    setLayer(l);
                    setSelected(null);
                  }}
                  className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                    layer === l ? 'bg-accent text-stage' : 'text-ink-faint hover:text-ink'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          }
        >
          <div className="p-1">
            <div className="text-[10px] text-ink-faint px-1 pb-1">
              {layer === 'fore' ? 'draws in front of characters' : layer === 'mid' ? 'behind characters' : 'furthest back'}
            </div>
            {items.map((item, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                className={`w-full text-left px-2 py-1 rounded text-[12px] flex items-center gap-2 ${
                  selected === i ? 'bg-accent/20 text-ink' : 'text-ink-dim hover:bg-panel-2'
                }`}
              >
                <span className="flex-1 truncate">{propDef(item.prop)?.label ?? item.prop}</span>
                {item.x !== undefined && <span className="text-[10px] text-ink-faint tabular-nums">{Math.round(item.x)}</span>}
              </button>
            ))}
            {!items.length && <div className="text-[11px] text-ink-faint px-2 py-3">empty layer</div>}
          </div>
        </Panel>

        <Panel
          title="Add prop"
          className="h-52 shrink-0"
          bodyClass="p-1"
          actions={<Select value={tag} options={['all', ...tags]} onChange={setTag} />}
        >
          <div className="grid grid-cols-2 gap-1">
            {visibleProps.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => addProp(p.key)}
                title={p.tags.join(' ')}
                className="px-1.5 py-1 rounded bg-panel-2 hover:bg-edge text-[11px] text-ink-dim hover:text-ink text-left truncate"
              >
                {p.label}
              </button>
            ))}
          </div>
        </Panel>
      </div>

      {/* centre: preview, with drag handles for the current layer over it */}
      <Panel
        className="flex-1 min-w-0"
        bodyClass="p-0"
        title="Preview"
        actions={notes.length > 0 && <Badge tone="warn">{notes.length} note{notes.length === 1 ? '' : 's'}</Badge>}
      >
        <div className="relative w-full h-full">
          <ScaledFrame src={previewId ? `/preview/${previewId}` : null} title="set preview" />
          <StageOverlay
            items={items}
            layer={layer}
            selected={selected}
            onSelect={setSelected}
            onMove={(i, move) =>
              mutate((d) => {
                const item = d.layers[layer][i];
                if (item) {
                  item.x = move.x;
                  if (move.y !== undefined) item.y = move.y;
                  if (move.paramY !== undefined) item.params = { ...item.params, y: move.paramY };
                }
                return d;
              })
            }
            defs={props}
            horizonY={desc.layout.horizonY}
          />
          {notes.length > 0 && (
            <div className="absolute left-2 right-2 bottom-2 flex flex-col gap-1 pointer-events-none">
              {notes.map((n) => (
                <div key={n} className="text-[11px] px-2 py-1 rounded bg-black/70 text-accent">{n}</div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      {/* right: inspector */}
      <Panel title="Set / prop" className="w-[22%] shrink-0" bodyClass="p-3">
        <div className="mb-3 pb-3 border-b border-edge">
          <div className="text-[11px] text-ink-dim mb-1">Walkable actor area</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Left">
              <NumberInput value={desc.layout.walkable.x} min={0} max={1279} step={8} onChange={(value) => mutate((draft) => {
                draft.layout.walkable.x = Math.max(0, Math.min(1279, value));
                draft.layout.walkable.width = Math.min(draft.layout.walkable.width, 1280 - draft.layout.walkable.x);
                return draft;
              })} />
            </Field>
            <Field label="Top">
              <NumberInput value={desc.layout.walkable.y} min={0} max={719} step={8} onChange={(value) => mutate((draft) => {
                draft.layout.walkable.y = Math.max(0, Math.min(719, value));
                draft.layout.walkable.height = Math.min(draft.layout.walkable.height, 720 - draft.layout.walkable.y);
                return draft;
              })} />
            </Field>
            <Field label="Width">
              <NumberInput value={desc.layout.walkable.width} min={1} max={1280 - desc.layout.walkable.x} step={8} onChange={(value) => mutate((draft) => {
                draft.layout.walkable.width = Math.max(1, Math.min(1280 - draft.layout.walkable.x, value));
                return draft;
              })} />
            </Field>
            <Field label="Height">
              <NumberInput value={desc.layout.walkable.height} min={1} max={720 - desc.layout.walkable.y} step={8} onChange={(value) => mutate((draft) => {
                draft.layout.walkable.height = Math.max(1, Math.min(720 - draft.layout.walkable.y, value));
                return draft;
              })} />
            </Field>
          </div>
          <div className="text-[10px] text-ink-faint mt-1">Body drags clamp here; entrances and exits remain explicit stage actions.</div>
        </div>
        {!current || !currentDef ? (
          <Empty>Select a prop</Empty>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Badge>{currentDef.label}</Badge>
              {currentDef.spanning && <Badge tone="warn">spans set</Badge>}
            </div>

            <div className="flex gap-1 mb-3">
              <Button onClick={() => move(-1)} title="Draw earlier (further back)">↑</Button>
              <Button onClick={() => move(1)} title="Draw later (further front)">↓</Button>
              <div className="flex-1" />
              <Button variant="danger" onClick={remove}>Remove</Button>
            </div>

            <Field
              label="Prop ID"
              hint="Stable scene-action target. IDs must be unique across this set."
            >
              <TextInput
                value={current.id ?? ''}
                placeholder={`${current.prop}-1`}
                onChange={(id) => updateProp({ id: id.trim() || undefined })}
              />
            </Field>

            {!currentDef.spanning && (
              <>
                <Field label="X">
                  <NumberInput value={current.x ?? 640} step={10} onChange={(v) => updateProp({ x: v })} />
                </Field>
                <Field label="Y" hint="Blank sits it on the floor.">
                  <NumberInput value={current.y ?? desc.layout.horizonY} step={10} onChange={(v) => updateProp({ y: v })} />
                </Field>
                <Field label="Scale">
                  <NumberInput value={current.scale} min={0.1} max={5} step={0.05} onChange={(v) => updateProp({ scale: v })} />
                </Field>
                <label className="flex items-center gap-2 mb-3 text-[12px] text-ink-dim">
                  <input type="checkbox" checked={current.flip} onChange={(e) => updateProp({ flip: e.target.checked })} />
                  Mirror
                </label>
              </>
            )}

            {currentDef.params.map((spec) => (
              <ParamControl
                key={spec.key}
                spec={spec}
                value={current.params[spec.key] ?? spec.default}
                onChange={(v) => updateParam(spec.key, v)}
              />
            ))}
          </>
        )}
        {error && <div className="mt-3 text-[11px] text-bad">{error}</div>}
      </Panel>
    </div>
  );
}

/** Controls are generated from the prop's declared ParamSpec, never hand-written. */
function ParamControl({
  spec, value, onChange,
}: {
  spec: ParamSpec;
  value: number | string | boolean;
  onChange: (v: number | string | boolean) => void;
}) {
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 mb-3 text-[12px] text-ink-dim">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    );
  }
  if (spec.type === 'choice') {
    return (
      <Field label={spec.label}>
        <Select value={String(value)} options={spec.choices ?? []} onChange={onChange} />
      </Field>
    );
  }
  if (spec.type === 'text') {
    return (
      <Field label={spec.label}>
        <TextInput value={String(value)} onChange={onChange} />
      </Field>
    );
  }
  return (
    <Field label={spec.label}>
      <NumberInput
        value={Number(value)}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        onChange={onChange}
      />
    </Field>
  );
}
