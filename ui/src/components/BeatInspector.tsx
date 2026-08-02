import type { Beat, CastMember, Vocab } from '../types.ts';
import { Field, Select, NumberInput, Empty, Badge } from './ui.tsx';

/**
 * Edits one beat.
 *
 * Writes the same fields you would edit by hand in shotlist.json — there is no
 * app-only state. Changing an expression changes both the drawn face and the
 * vocal delivery, since the voice engine's emotion controls are driven from it.
 */
export function BeatInspector({
  beat, index, cast, vocab, expressionsFor, onChange,
}: {
  beat: Beat | null;
  index: number | null;
  cast: CastMember[];
  vocab: Vocab | null;
  /** Expressions the given actor's rig actually has. */
  expressionsFor: (actorId: string) => string[];
  onChange: (index: number, next: Beat) => void;
}) {
  if (!beat || index === null) {
    return <Empty>Select a beat to edit it</Empty>;
  }

  const patch = (changes: Partial<Beat>) => onChange(index, { ...beat, ...changes } as Beat);
  const actorIds = cast.map((c) => c.id);
  const others = beat.kind === 'line' ? actorIds.filter((a) => a !== beat.speaker) : actorIds;

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Badge tone={beat.kind === 'line' ? 'neutral' : beat.kind === 'pause' ? 'warn' : 'good'}>
          {beat.kind}
        </Badge>
        <span className="text-ink-faint text-[11px]">beat {index}</span>
      </div>

      {beat.kind === 'line' && (
        <>
          <div className="mb-3 p-2 rounded bg-panel-2 border border-edge text-[12px] leading-snug">
            <span className="text-accent font-medium">{beat.speaker}</span>
            <div className="text-ink-dim mt-0.5">{beat.text}</div>
          </div>

          <Field label="Expression" hint="Sets the face and the vocal delivery.">
            <Select
              value={beat.expression}
              options={expressionsFor(beat.speaker)}
              onChange={(v) => patch({ expression: v } as Partial<Beat>)}
            />
          </Field>

          <Field label="Gesture">
            <Select
              value={beat.gesture}
              options={vocab?.gestures ?? [beat.gesture]}
              onChange={(v) => patch({ gesture: v } as Partial<Beat>)}
            />
          </Field>
        </>
      )}

      {beat.kind !== 'line' && (
        <Field label={beat.kind === 'pause' ? 'Duration (ms)' : 'Hold (ms)'} hint="The pause is the joke; its length is a writing decision.">
          <NumberInput
            value={beat.ms}
            min={100}
            max={8000}
            step={100}
            onChange={(v) => patch({ ms: Math.max(100, v) } as Partial<Beat>)}
          />
        </Field>
      )}

      {beat.kind === 'action' && (
        <div className="mb-3 p-2 rounded bg-panel-2 border border-edge text-[12px] text-ink-dim leading-snug">
          {beat.text}
        </div>
      )}

      <Field label="Shot">
        <Select value={beat.shot} options={vocab?.shots ?? [beat.shot]} onChange={(v) => patch({ shot: v } as Partial<Beat>)} />
      </Field>

      <Field label="Camera">
        <Select value={beat.camera} options={vocab?.cameraMoves ?? [beat.camera]} onChange={(v) => patch({ camera: v } as Partial<Beat>)} />
      </Field>

      <Field label="Focus" hint="Who the shot is on. Empty means everyone.">
        <div className="flex flex-wrap gap-1">
          {actorIds.map((id) => {
            const on = beat.focus.includes(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() =>
                  patch({ focus: on ? beat.focus.filter((f) => f !== id) : [...beat.focus, id] } as Partial<Beat>)
                }
                className={`px-2 py-1 rounded border text-[11px] transition-colors ${
                  on ? 'bg-accent text-stage border-accent' : 'bg-panel-2 text-ink-dim border-edge hover:text-ink'
                }`}
              >
                {id}
              </button>
            );
          })}
        </div>
      </Field>

      {others.length > 0 && (
        <Field label="Reactions" hint="What everyone else is doing while this lands.">
          <div className="space-y-1.5">
            {others.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[11px] text-ink-dim w-20 truncate">{id}</span>
                <Select
                  className="flex-1"
                  value={beat.reactions[id] ?? cast.find((c) => c.id === id)?.resting ?? 'DEADPAN'}
                  options={expressionsFor(id)}
                  onChange={(v) => patch({ reactions: { ...beat.reactions, [id]: v } } as Partial<Beat>)}
                />
              </div>
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}
