import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import type {
  CastSummary, FacePlate, Health, Look, LookChoiceKey, LookSwatchKey, RigDoc, Vocab,
} from '../types.ts';
import { Button, Panel, Select, Slider, Swatches, Field, Empty, Badge, Spinner } from './ui.tsx';
import { ScaledFrame } from './ScaledFrame.tsx';
import { VoicePanel } from './VoicePanel.tsx';

/**
 * Grouped so the panel reads head-downwards rather than as one long list.
 *
 * Field labels are short because the group heading already carries the context —
 * "Hair / Style" rather than "Hair / Hair style", which is the same words twice.
 */
const LOOK_GROUPS: Array<{ title: string; fields: Array<[LookChoiceKey, string]> }> = [
  { title: 'Body', fields: [['build', 'Build']] },
  { title: 'Head', fields: [['head', 'Shape'], ['ears', 'Ears'], ['nose', 'Nose']] },
  { title: 'Eyes', fields: [['eyes', 'Style'], ['brows', 'Brows']] },
  { title: 'Hair', fields: [['hair', 'Style'], ['facialHair', 'Facial']] },
  { title: 'Extras', fields: [['glasses', 'Glasses']] },
];

const SWATCH_LABELS: Record<LookSwatchKey, string> = {
  skin: 'Skin',
  hairColour: 'Hair',
  shirt: 'Shirt',
  trousers: 'Trousers',
};

/**
 * Characters: how they look, how they sound.
 *
 * Appearance is edited as a descriptor and the artwork is redrawn from it, so
 * every control here is a real property of the character rather than a filter
 * over a fixed puppet. The stage preview runs through the same runtime page a
 * render does; the face sheet shows every expression at once, because the only
 * question that matters about an expression is whether it is distinguishable
 * from the other nine.
 */
export function CastEditor({ health, vocab }: { health: Health | null; vocab: Vocab | null }) {
  const [cast, setCast] = useState<CastSummary[]>([]);
  const [name, setName] = useState<string>('');
  const [rig, setRig] = useState<RigDoc | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [dirty, setDirty] = useState(false);

  const [view, setView] = useState<'stage' | 'faces'>('stage');
  const [pose, setPose] = useState('IDLE');
  const [expression, setExpression] = useState('NEUTRAL');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [plates, setPlates] = useState<FacePlate[]>([]);
  const [platesBusy, setPlatesBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rollCount = useRef(0);

  const refreshCast = useCallback(async () => setCast(await api.cast()), []);

  useEffect(() => {
    void refreshCast().then(() => undefined);
  }, [refreshCast]);

  useEffect(() => {
    if (!name && cast[0]) setName(cast[0].name);
  }, [cast, name]);

  useEffect(() => {
    if (!name) return;
    setDirty(false);
    void api
      .rig(name)
      .then((r) => {
        setRig(r.rig);
        setLook(r.look);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [name]);

  // The stage preview follows the working copy, so unsaved appearance edits are
  // visible without a save round-trip.
  useEffect(() => {
    if (!name || !look || view !== 'stage') return;
    const t = setTimeout(() => {
      void api
        .castPreview(name, pose, expression, look)
        .then((r) => setPreviewId(r.previewId))
        .catch((e: Error) => setError(e.message));
    }, 140);
    return () => clearTimeout(t);
  }, [name, look, pose, expression, view]);

  useEffect(() => {
    if (!name || !look || view !== 'faces') return;
    setPlatesBusy(true);
    const t = setTimeout(() => {
      void api
        .faces(name, look)
        .then((r) => setPlates(r.plates))
        .catch((e: Error) => setError(e.message))
        .finally(() => setPlatesBusy(false));
    }, 140);
    return () => clearTimeout(t);
  }, [name, look, view]);

  const summary = cast.find((c) => c.name === name);
  const expressions = summary?.expressions ?? rig?.expressions.map((e) => e.name) ?? ['NEUTRAL'];
  const poses = summary?.poses ?? rig?.poses.map((p) => p.name) ?? ['IDLE'];

  const patchLook = (changes: Partial<Look>) => {
    setLook((l) => (l ? { ...l, ...changes } : l));
    setDirty(true);
  };

  const patchRig = (changes: Partial<RigDoc>) => {
    setRig((r) => (r ? { ...r, ...changes } : r));
    setDirty(true);
  };

  const save = async () => {
    if (!rig || !look) return;
    setSaving(true);
    try {
      // Look first: it redraws the SVG and rewrites the rig, so saving voice
      // settings the other way round would write them into a stale document.
      const saved = await api.saveLook(rig.name, look);
      await api.saveRig(rig.name, {
        ...saved.rig,
        voice: rig.voice,
        voiceRate: rig.voiceRate,
        voiceRef: rig.voiceRef,
      });
      setRig({ ...saved.rig, voice: rig.voice, voiceRate: rig.voiceRate, voiceRef: rig.voiceRef });
      setDirty(false);
      setError(null);
      await refreshCast();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reroll = async () => {
    if (!name) return;
    rollCount.current += 1;
    try {
      const { look: rolled } = await api.rollLook(name, String(rollCount.current));
      setLook(rolled);
      setDirty(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const addCharacter = async () => {
    const raw = window.prompt('New character name');
    if (!raw) return;
    const clean = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!clean) return;
    try {
      await api.newCharacter(clean);
      await refreshCast();
      setName(clean);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!cast.length) {
    return (
      <Empty>
        <div>
          No characters yet. They are cast automatically when a script names them.
          <div className="mt-3">
            <Button onClick={() => void addCharacter()}>Create one anyway</Button>
          </div>
          {error && <div className="mt-3 text-bad">{error}</div>}
        </div>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <Panel
        title="Cast"
        className="w-44 shrink-0"
        bodyClass="p-1"
        actions={<Button variant="ghost" onClick={() => void addCharacter()} title="New character">+</Button>}
      >
        {cast.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => setName(c.name)}
            className={`w-full text-left px-2 py-1.5 rounded text-[12px] ${
              name === c.name ? 'bg-accent/20 text-ink' : 'text-ink-dim hover:bg-panel-2'
            }`}
          >
            <div className="flex items-center gap-1">
              <span className="flex-1 truncate">{c.name}</span>
              {name === c.name && dirty && <span className="text-accent text-[14px] leading-none">•</span>}
            </div>
            <div className="text-[10px] text-ink-faint truncate">
              {c.look.build} · {c.voiceRef ? 'cloned voice' : c.voice}
            </div>
          </button>
        ))}
      </Panel>

      <Panel
        className="flex-1 min-w-0"
        bodyClass={view === 'faces' ? 'p-2' : 'p-0'}
        title={view === 'stage' ? 'Preview' : 'Expressions'}
        actions={
          <div className="flex items-center gap-2">
            {view === 'stage' && (
              <>
                <Select value={expression} options={expressions} onChange={setExpression} />
                <Select value={pose} options={poses} onChange={setPose} />
              </>
            )}
            <div className="flex gap-0.5">
              {(['stage', 'faces'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                    view === v ? 'bg-accent text-stage' : 'text-ink-faint hover:text-ink'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {view === 'stage' ? (
          <ScaledFrame src={previewId ? `/preview/${previewId}` : null} title="cast preview" />
        ) : (
          <FaceSheet plates={plates} busy={platesBusy} selected={expression} onSelect={setExpression} />
        )}
      </Panel>

      <div className="w-[25%] min-w-[260px] shrink-0 flex flex-col gap-2 min-h-0">
        <Panel
          title="Appearance"
          className="flex-1 min-h-0"
          bodyClass="p-3"
          actions={<Button variant="ghost" onClick={() => void reroll()} title="Roll a different look">↻ Reroll</Button>}
        >
          {!look || !vocab ? (
            <Empty>Loading…</Empty>
          ) : (
            <>
              {LOOK_GROUPS.map((group) => (
                <div key={group.title} className="mb-3">
                  <div className="text-[10px] uppercase tracking-wider text-accent/70 mb-1 pb-0.5 border-b border-edge">
                    {group.title}
                  </div>
                  {group.fields.map(([key, label]) => (
                    <Field key={key} label={label}>
                      <Select
                        value={look[key]}
                        options={vocab.look.choices[key] ?? [look[key]]}
                        onChange={(v) => patchLook({ [key]: v } as Partial<Look>)}
                        className="w-full"
                      />
                    </Field>
                  ))}
                </div>
              ))}

              <div className="h-px bg-edge my-3" />
              {(Object.keys(SWATCH_LABELS) as LookSwatchKey[]).map((key) => (
                <Swatches
                  key={key}
                  label={SWATCH_LABELS[key]}
                  value={look[key]}
                  options={vocab.look.swatches[key] ?? [look[key]]}
                  onChange={(v) => patchLook({ [key]: v } as Partial<Look>)}
                />
              ))}

              <div className="h-px bg-edge my-3" />
              {vocab.look.sliders.map((s) => (
                <Slider
                  key={s.key}
                  label={s.label}
                  min={s.min}
                  max={s.max}
                  step={0.01}
                  value={look[s.key]}
                  onChange={(v) => patchLook({ [s.key]: v } as Partial<Look>)}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
              ))}
            </>
          )}
        </Panel>

        <Panel title="Voice" className="h-[46%] shrink-0" bodyClass="p-0">
          {rig ? (
            <VoicePanel rig={rig} vocab={vocab} health={health} onPatch={patchRig} />
          ) : (
            <Empty>Select a character</Empty>
          )}
        </Panel>

        <div className="shrink-0">
          {error && <div className="text-[11px] text-bad mb-1">{error}</div>}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving} className="flex-1">
              {saving ? <><Spinner /> Saving…</> : dirty ? 'Save character' : 'Saved'}
            </Button>
            {rig?.voiceRef && <Badge tone="good">cloned</Badge>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Every expression at once. Clicking one sends the stage preview to it. */
function FaceSheet({
  plates, busy, selected, onSelect,
}: {
  plates: FacePlate[];
  busy: boolean;
  selected: string;
  onSelect: (name: string) => void;
}) {
  if (!plates.length) {
    return <Empty>{busy ? 'Drawing faces…' : 'No expressions on this character'}</Empty>;
  }

  return (
    <div className={`grid grid-cols-5 gap-2 transition-opacity ${busy ? 'opacity-60' : ''}`}>
      {plates.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onSelect(p.label)}
          className={`rounded border p-1 bg-[#e9e3d6] transition-colors ${
            selected === p.label ? 'border-accent' : 'border-transparent hover:border-edge'
          }`}
        >
          <div className="[&>svg]:w-full [&>svg]:h-auto" dangerouslySetInnerHTML={{ __html: p.svg }} />
          <div className="text-[10px] text-center text-[#2b2f36] pt-0.5 tracking-wide">{p.label}</div>
        </button>
      ))}
    </div>
  );
}
