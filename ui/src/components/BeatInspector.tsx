import type { Beat, CastMember, StageAction, Vocab } from '../types.ts';
import { Field, Select, NumberInput, TextInput, Empty, Badge, Button } from './ui.tsx';

const EDITABLE_ACTIONS = [
  'enter', 'exit', 'move', 'sit', 'stand', 'look', 'turn',
  'reach', 'pick_up', 'put_down', 'tap',
] as const;

function newAction(type: StageAction['type'], actor: string, propRef = 'prop-id'): StageAction {
  if (type === 'move') return { type, actor, to: { mark: 'CENTER' } };
  if (type === 'enter') return { type, actor, to: { mark: 'CENTER' } };
  if (type === 'look' || type === 'turn') return { type, actor, direction: 'front' };
  if (type === 'reach') return { type, actor, target: propRef };
  if (type === 'pick_up' || type === 'put_down') return { type, actor, prop: propRef };
  if (type === 'tap') return { type, actor, target: propRef, count: 1 };
  return { type, actor };
}

/**
 * Edits one beat.
 *
 * Writes the same fields you would edit by hand in shotlist.json — there is no
 * app-only state. Changing an expression changes both the drawn face and the
 * vocal delivery, since the voice engine's emotion controls are driven from it.
 */
export function BeatInspector({
  beat, index, cast, vocab, propTargets = [], portablePropTargets = [], expressionsFor, onChange, onCastChange,
}: {
  beat: Beat | null;
  index: number | null;
  cast: CastMember[];
  vocab: Vocab | null;
  /** Addressable set props with a contact handle. */
  propTargets?: string[];
  /** Addressable contact props that may be attached to an actor. */
  portablePropTargets?: string[];
  /** Expressions the given actor's rig actually has. */
  expressionsFor: (actorId: string) => string[];
  onChange: (index: number, next: Beat) => void;
  onCastChange?: (actorId: string, changes: Partial<CastMember>) => void;
}) {
  if (!beat || index === null) {
    return <Empty>Select a beat to edit it</Empty>;
  }

  const patch = (changes: Partial<Beat>) => onChange(index, { ...beat, ...changes } as Beat);
  const actorIds = cast.map((c) => c.id);
  const others = beat.kind === 'line' ? actorIds.filter((a) => a !== beat.speaker) : actorIds;
  const editAction = (actionIndex: number, action: StageAction) => {
    if (beat.kind !== 'action') return;
    patch({ stage: (beat.stage ?? []).map((item, i) => i === actionIndex ? action : item) } as Partial<Beat>);
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Badge tone={beat.kind === 'line' ? 'neutral' : beat.kind === 'pause' ? 'warn' : 'good'}>
          {beat.kind}
        </Badge>
        <span className="text-ink-faint text-[11px]">beat {index}</span>
        <div className="flex-1" />
        <Button
          variant={beat.locked ? 'default' : 'ghost'}
          className="px-1.5 py-0.5 text-[10px]"
          onClick={() => patch({ locked: !beat.locked } as Partial<Beat>)}
          title="Locked beats survive director reruns"
        >
          {beat.locked ? 'Locked' : 'Lock'}
        </Button>
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
        <>
          <div className="mb-3 p-2 rounded bg-panel-2 border border-edge text-[12px] text-ink-dim leading-snug">
            {beat.text}
          </div>
          {(beat.unsupported ?? []).map((note) => (
            <div key={note} className="mb-2 p-2 rounded border border-bad/40 bg-bad/10 text-[11px] text-bad">{note}</div>
          ))}
          <Field label="Stage actions" hint="Ordered actions share this beat. Unsupported physical business blocks production export.">
            <div className="space-y-2">
              {(beat.stage ?? []).map((action, actionIndex) => (
                <div key={`${actionIndex}-${action.type}-${action.actor}`} className="rounded border border-edge bg-panel-2 p-2 space-y-1.5">
                  <div className="grid grid-cols-2 gap-1">
                    <Select
                      value={action.type}
                      options={EDITABLE_ACTIONS}
                      onChange={(value) => {
                        const type = value as StageAction['type'];
                        const refs = type === 'pick_up' || type === 'put_down' ? portablePropTargets : propTargets;
                        editAction(actionIndex, newAction(type, action.actor, refs[0]));
                      }}
                    />
                    <Select
                      value={action.actor}
                      options={actorIds}
                      onChange={(actor) => editAction(actionIndex, { ...action, actor })}
                    />
                  </div>

                  {(action.type === 'enter' || action.type === 'move' || action.type === 'exit') && (
                    <Select
                      value={action.to?.mark ?? cast.find((member) => member.id === action.actor)?.mark ?? 'CENTER'}
                      options={vocab?.marks ?? ['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R']}
                      onChange={(mark) => editAction(actionIndex, { ...action, to: { ...(action.to ?? {}), mark: mark as CastMember['mark'] } })}
                      className="w-full"
                    />
                  )}

                  {(action.type === 'look' || action.type === 'turn') && (
                    <div className="grid grid-cols-2 gap-1">
                      <Select
                        value={action.target ?? ''}
                        options={['', ...actorIds.filter((id) => id !== action.actor)]}
                        onChange={(target) => editAction(actionIndex, {
                          ...action,
                          target: target || undefined,
                          direction: target ? undefined : (action.direction ?? 'front'),
                        })}
                      />
                      <Select
                        value={action.target ? '' : (action.direction ?? 'front')}
                        options={['', 'left', 'right', 'front']}
                        onChange={(direction) => editAction(actionIndex, {
                          ...action,
                          target: direction ? undefined : action.target,
                          direction: direction ? direction as 'left' | 'right' | 'front' : undefined,
                        })}
                      />
                    </div>
                  )}

                  {(action.type === 'reach' || action.type === 'tap') && (
                    propTargets.length ? (
                      <Select
                        value={action.target ?? propTargets[0]!}
                        options={propTargets}
                        onChange={(target) => editAction(actionIndex, { ...action, target })}
                        className="w-full"
                      />
                    ) : (
                      <TextInput
                        value={action.target ?? ''}
                        placeholder="stable prop ID"
                        onChange={(target) => editAction(actionIndex, { ...action, target })}
                      />
                    )
                  )}

                  {(action.type === 'pick_up' || action.type === 'put_down') && (
                    portablePropTargets.length ? (
                      <Select
                        value={action.prop ?? portablePropTargets[0]!}
                        options={portablePropTargets}
                        onChange={(prop) => editAction(actionIndex, { ...action, prop })}
                        className="w-full"
                      />
                    ) : (
                      <TextInput
                        value={action.prop ?? ''}
                        placeholder="portable prop ID"
                        onChange={(prop) => editAction(actionIndex, { ...action, prop })}
                      />
                    )
                  )}

                  {action.type === 'put_down' && (
                    <Select
                      value={action.to?.mark ?? ''}
                      options={['', ...(vocab?.marks ?? ['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R'])]}
                      onChange={(mark) => editAction(actionIndex, {
                        ...action,
                        to: mark ? { mark: mark as CastMember['mark'] } : undefined,
                      })}
                      className="w-full"
                    />
                  )}

                  {action.type === 'tap' && (
                    <div className="flex items-center gap-2 text-[10px] text-ink-faint">
                      taps
                      <NumberInput
                        className="w-20"
                        value={action.count ?? 1}
                        min={1}
                        max={16}
                        step={1}
                        onChange={(count) => editAction(actionIndex, { ...action, count: Math.max(1, Math.round(count)) })}
                      />
                    </div>
                  )}

                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-ink-faint">frames (0 = share beat)</span>
                    <NumberInput
                      className="w-20"
                      value={action.durationFrames ?? 0}
                      min={0}
                      max={Math.max(1, Math.round((beat.ms / 1000) * 120))}
                      onChange={(frames) => {
                        const next = { ...action };
                        if (frames > 0) next.durationFrames = Math.round(frames);
                        else delete next.durationFrames;
                        editAction(actionIndex, next);
                      }}
                    />
                    <div className="flex-1" />
                    <Button
                      variant="danger"
                      className="px-1.5"
                      onClick={() => patch({ stage: (beat.stage ?? []).filter((_, i) => i !== actionIndex) } as Partial<Beat>)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                className="w-full"
                disabled={!actorIds.length}
                onClick={() => patch({ stage: [...(beat.stage ?? []), newAction('move', actorIds[0]!)] } as Partial<Beat>)}
              >
                Add stage action
              </Button>
            </div>
          </Field>

          <Field label="Initial cast state" hint="Use hidden for actors whose first appearance is an ENTER. Exact root animation may override the mark later.">
            <div className="space-y-1.5">
              {cast.map((member) => (
                <div key={member.id} className="rounded border border-edge bg-panel-2 p-1.5">
                  <div className="flex items-center gap-1 mb-1">
                    <span className="w-16 truncate text-[11px] text-ink-dim">{member.id}</span>
                    <Button
                      variant={member.visible !== false ? 'default' : 'ghost'}
                      className="px-1.5 py-0.5 text-[10px]"
                      onClick={() => onCastChange?.(member.id, { visible: member.visible === false })}
                    >
                      {member.visible === false ? 'hidden' : 'visible'}
                    </Button>
                    <Select
                      value={member.mark}
                      options={vocab?.marks ?? ['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R']}
                      onChange={(mark) => onCastChange?.(member.id, { mark: mark as CastMember['mark'], position: null })}
                      className="flex-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <Select
                      value={member.pose ?? 'IDLE'}
                      options={['IDLE', 'SIT']}
                      onChange={(pose) => onCastChange?.(member.id, { pose })}
                    />
                    <NumberInput
                      value={member.depth ?? 0}
                      min={-1}
                      max={1}
                      step={0.1}
                      onChange={(depth) => onCastChange?.(member.id, { depth: Math.max(-1, Math.min(1, depth)) })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-1 mt-1">
                    <Select
                      value={member.heldProp ?? ''}
                      options={['', ...portablePropTargets]}
                      onChange={(heldProp) => onCastChange?.(member.id, heldProp
                        ? { heldProp, heldHand: member.heldHand ?? 'right' }
                        : { heldProp: null, heldHand: null })}
                    />
                    <Select
                      value={member.heldHand ?? ''}
                      options={member.heldProp ? ['left', 'right'] : ['']}
                      disabled={!member.heldProp}
                      onChange={(heldHand) => onCastChange?.(member.id, {
                        heldHand: heldHand ? heldHand as 'left' | 'right' : null,
                      })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Field>
        </>
      )}

      <Field label="Shot">
        <Select value={beat.shot} options={vocab?.shots ?? [beat.shot]} onChange={(v) => patch({ shot: v } as Partial<Beat>)} />
      </Field>

      <Field label="Shot purpose" hint="The story job this composition performs; director reruns use it to preserve motivated coverage.">
        <Select
          value={beat.purpose}
          options={vocab?.shotPurposes ?? [beat.purpose]}
          onChange={(purpose) => patch({ purpose: purpose as Beat['purpose'] } as Partial<Beat>)}
        />
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
