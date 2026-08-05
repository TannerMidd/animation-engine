import { useEffect, useState } from 'react';
import { api, followJob } from '../api.ts';
import type { JobEvent, ParamValue, Recipe } from '../types.ts';
import { Button, Empty, Field, Select, Spinner, TextInput } from './ui.tsx';
import { ParamControl } from './PropInspector.tsx';

/**
 * Baking, without writing Python.
 *
 * Baking exists for the props a flat elevation cannot describe — anything with
 * a visible top face. That was worth having and it was also gated behind
 * writing a `build.py`, which is a much higher wall than "open Blender" sounds
 * like. So the Python is written already: pick a shape, fill in the form.
 *
 * The camera is deliberately absent from that form. A person making a crate has
 * no opinion about orthographic scale, and the recipe knows which of its
 * parameters describe size, so the framing follows from them.
 */
export function PropBakeDialog({ taken, onBaked, onClose }: {
  taken: string[];
  onBaked: (key: string) => void;
  onClose: () => void;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [blender, setBlender] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [name, setName] = useState('');
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.propRecipes()
      .then((r) => {
        setRecipes(r.recipes);
        setBlender(r.blender);
        setChosen(r.recipes[0]?.name ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const recipe = recipes?.find((r) => r.name === chosen) ?? null;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const clash = key && taken.includes(key);

  // Each recipe brings its own form, so the values must not carry across.
  useEffect(() => setParams({}), [chosen]);

  const bake = async () => {
    if (!recipe || !key) return;
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      const { jobId } = await api.bakeProp(key, { recipe: recipe.name, params });
      await new Promise<void>((resolve, reject) => {
        followJob(jobId, (event: JobEvent) => {
          if (event.type === 'log' && event.message) setLog((l) => [...l.slice(-6), event.message!]);
          if (event.type === 'progress' && event.total) {
            setLog((l) => [...l.slice(-6), `${event.stage ?? 'baking'} ${event.done}/${event.total}`]);
          }
          if (event.type === 'done') resolve();
          if (event.type === 'error') reject(new Error(event.message ?? 'the bake failed'));
        });
      });
      onBaked(key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        className="w-[620px] max-w-full max-h-full overflow-auto bg-panel border border-edge rounded-lg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-edge flex items-center justify-between">
          <span className="text-[12px] uppercase tracking-wider text-ink-faint">Bake a prop</span>
          <Button variant="ghost" onClick={onClose}>✕</Button>
        </div>

        <div className="p-4">
          {!recipes && !error && <Empty><Spinner /></Empty>}

          {blender && !blender.ok && (
            <div className="mb-3 text-[12px] text-ink-dim leading-snug border border-edge rounded p-2.5">
              <div className="text-bad mb-1">Blender is not available.</div>
              {blender.reason}
            </div>
          )}

          {recipes && recipes.length > 0 && (
            <>
              <Field label="Shape">
                <Select
                  value={chosen}
                  options={recipes.map((r) => ({ value: r.name, label: r.label }))}
                  onChange={setChosen}
                  className="w-full"
                />
              </Field>
              {recipe && <div className="text-[11px] text-ink-faint -mt-1.5 mb-3">{recipe.blurb}</div>}

              <Field label="Name" hint={clash ? 'There is already a prop with that name.' : 'What sets will call it.'}>
                <TextInput value={name} onChange={setName} placeholder="pallet stack" />
              </Field>

              {recipe && (
                <div className="border-t border-edge pt-3 mt-1">
                  {recipe.params.map((spec) => (
                    <ParamControl
                      key={spec.key}
                      spec={spec}
                      value={params[spec.key] ?? spec.default}
                      onChange={(v) => setParams((p) => ({ ...p, [spec.key]: v }))}
                    />
                  ))}
                  <div className="text-[11px] text-ink-faint">
                    Sizes are in metres. The camera frames itself from them.
                  </div>
                </div>
              )}

              {log.length > 0 && (
                <div className="mt-3 font-mono text-[10px] text-ink-faint border border-edge rounded p-2 max-h-24 overflow-auto">
                  {log.map((line, i) => <div key={i}>{line}</div>)}
                </div>
              )}

              {error && <div className="mt-3 text-[11px] text-bad">{error}</div>}

              <div className="flex gap-1.5 mt-4">
                <Button
                  variant="primary"
                  disabled={busy || !key || !!clash || !blender?.ok}
                  onClick={() => void bake()}
                >
                  {busy ? 'Baking…' : 'Bake'}
                </Button>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                {busy && <Spinner />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
