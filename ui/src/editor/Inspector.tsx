import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AnimationDocument, Beat, CastMember, DialogueCue, DialogueDocument, Mark, SetDescriptor, SetSummary,
  ShotList, StageAction, Vocab,
} from '../types.ts';
import { AnimationPanel } from '../components/AnimationPanel.tsx';
import { PerformancePanel } from '../components/PerformancePanel.tsx';
import type { AnimationEditTarget } from '../components/AnimationOverlay.tsx';
import { FieldLabel, OptionChips, Tag } from './chrome.tsx';
import { cueForBeat, speakerColour, type InspectorTab } from './lib.ts';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'beat', label: 'Beat' },
  { id: 'character', label: 'Character' },
  { id: 'motion', label: 'Motion' },
  { id: 'rig', label: 'Rig' },
  { id: 'camera', label: 'Camera' },
  { id: 'prop', label: 'Prop' },
  { id: 'voice', label: 'Voice' },
  { id: 'scene', label: 'Scene' },
];

const STAGE_ACTIONS: StageAction['type'][] = ['enter', 'exit', 'move', 'sit', 'stand', 'look', 'turn', 'reach', 'pick_up', 'put_down', 'tap'];
const MARKS = ['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R'];

export interface InspectorProps {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  /** Bumped by Booth-style buttons elsewhere; draws the eye to this panel. */
  flash?: number;
  scene: string;
  shots: ShotList | null;
  vocab: Vocab | null;
  selected: number | null;
  beat: Beat | null;
  dialogue: DialogueDocument | null;
  animation: AnimationDocument | null;
  setDescriptor: SetDescriptor | null;
  /** Every set the scene could bind, for the Scene tab's picker. */
  sets: SetSummary[];
  playheadMs: number;
  totalMs: number;
  identityLabel: string;
  expressionsFor: (actorId: string) => string[];
  onEditBeat: (index: number, next: Beat) => void;
  onEditCast: (actorId: string, changes: Partial<CastMember>) => void;
  /** Top-level shot-list fields — set, seed, frame rates, cards. Same debounced write path as beats. */
  onEditShots: (changes: Partial<Pick<ShotList, 'set' | 'seed' | 'fps' | 'characterFps' | 'cards' | 'title' | 'subtitle'>>) => void;
  /** One change applied to every cast member in a single write — the scene-wide resting default. */
  onEditAllCast: (changes: Partial<CastMember>) => void;
  onAnimationDocument: (doc: AnimationDocument) => void;
  onAnimationTarget: (target: AnimationEditTarget | null) => void;
  onAnimationSeek: (ms: number) => void;
  selectedMotionId: string | null;
  onDeleteMotion: (segmentId: string) => void;
  onReloadDialogue: () => Promise<void>;
  onSaveCue: (cue: DialogueCue) => Promise<void>;
  onDiscardTake: (takeId: string) => void;
  speakerVoiceBound: boolean;
  performContext: { audioUrl: string; startMs: number; endMs: number } | null;
  sceneRun: { audioUrl: string; beatStarts: number[]; durationMs: number } | null;
  onOpenCastEditor: (name: string | null) => void;
  onGoWrite: () => void;
}

/** The right-hand inspector: always about the one selected thing. */
export function Inspector(p: InspectorProps) {
  const { tab, beat, selected, shots } = p;
  const castIds = shots?.cast.map((c) => c.id) ?? [];
  const cue = cueForBeat(p.dialogue, beat);
  const missingVoice = (p.dialogue?.cues ?? []).some((c) => c.approval.state !== 'approved');
  const hasMotion = (p.animation?.segments.length ?? 0) > 0;

  // A short accent ring when something elsewhere hands off to this panel —
  // without it, a "Booth" click that lands on an already-open tab looks dead.
  const [flashing, setFlashing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.flash) return;
    setFlashing(true);
    body.current?.scrollTo({ top: 0, behavior: 'smooth' });
    const t = setTimeout(() => setFlashing(false), 1100);
    return () => clearTimeout(t);
  }, [p.flash]);

  const kindFg = beat?.kind === 'pause' ? '#c8834a' : beat?.kind === 'action' ? '#6f9b5a' : '#9aa1ab';
  const isCreator = Boolean(beat?.locked);

  return (
    <div
      className="w-[302px] shrink-0 flex flex-col bg-[#22262c] border-l border-edge min-h-0 transition-shadow duration-300"
      style={flashing ? { boxShadow: 'inset 0 0 0 2px #c8834a' } : undefined}
    >
      {/* tab strip */}
      <div className="shrink-0 px-1.5 pt-[5px] pb-1 border-b border-[#2f353d] flex flex-wrap gap-[2px]">
        {TABS.map((t) => {
          const on = tab === t.id;
          const dot = t.id === 'motion' && hasMotion ? '#c8834a' : t.id === 'voice' && missingVoice ? '#c8595a' : null;
          return (
            <button
              key={t.id}
              type="button"
              title={`${t.label} inspector`}
              onClick={() => p.onTab(t.id)}
              className={`h-[21px] px-2 rounded-[3px] border text-[10px] tracking-[.04em] uppercase cursor-pointer inline-flex items-center gap-1 ${
                on ? 'bg-panel-2 border-edge-2 text-ink' : 'border-transparent text-ink-faint hover:text-ink-dim'
              }`}
            >
              {t.label}
              {dot && <span className="w-1 h-1 rounded-full" style={{ background: dot }} />}
            </button>
          );
        })}
      </div>

      <div ref={body} className="flex-1 min-h-0 overflow-y-auto">
        {/* context header */}
        {beat && selected !== null && (
          <div className="px-2.5 pt-[9px] pb-1.5 border-b border-[#2f353d] flex items-center gap-[7px]">
            <Tag color={kindFg}>{beat.kind}</Tag>
            <span className="font-mono text-[10px] text-ink-faint">beat {selected}</span>
            <div className="flex-1" />
            <span
              title={isCreator
                ? 'Pinned by you. Locked beats survive every director rerun and regeneration.'
                : 'Proposed by the director. Editable, and replaced on the next rerun unless you lock it.'}
              className="text-[9px] tracking-[.06em] uppercase inline-flex items-center gap-1"
              style={{ color: isCreator ? '#c8834a' : '#7a8fc0' }}
            >
              <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: isCreator ? '#c8834a' : '#7a8fc0' }} />
              {isCreator ? 'creator' : 'generated'}
            </span>
            <button
              type="button"
              title={beat.locked
                ? 'Unlock to edit. Locked beats survive director reruns.'
                : 'Lock this beat so director reruns leave it alone.'}
              onClick={() => p.onEditBeat(selected, { ...beat, locked: !beat.locked })}
              className={`h-[19px] px-1.5 rounded-[3px] border text-[9px] tracking-[.05em] uppercase cursor-pointer ${
                beat.locked ? 'bg-lock border-lock text-stage' : 'bg-panel-2 border-edge text-ink-dim hover:text-ink'
              }`}
            >
              {beat.locked ? 'Locked' : 'Lock'}
            </button>
          </div>
        )}

        {beat?.locked && (
          <Card tone="lock">
            <span className="text-lock text-[11px] leading-[1.2]">🔒</span>
            <span className="flex-1 text-[10.5px] text-[#c3b98f] leading-[1.45]">
              Locked. This beat survives director reruns and regeneration untouched. Unlock it to edit timing, shot or delivery.
            </span>
          </Card>
        )}

        {beat?.kind === 'action' && ((beat.unsupported?.length ?? 0) > 0 || !(beat.stage?.length)) && selected !== null && (
          <div className="mx-2.5 mt-[9px] p-2 pb-2.5 border border-bad/45 bg-bad/10 rounded-[3px]">
            <div className="flex items-center gap-1.5 mb-[5px]">
              <Tag color="#c8595a">ambiguous action</Tag>
              <span className="font-mono text-[9px] text-[#a86d6e]">action-unstructured</span>
            </div>
            <div className="text-[11px] text-[#d6c3c3] leading-[1.45] mb-1.5">
              “{beat.text}” is prose with no structured stage action
              {(beat.unsupported?.length ?? 0) > 0 ? ` (${beat.unsupported!.join('; ')})` : ''}.
              The director cannot stage it, and the preview and production export block on it.
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  const actor = beat.focus[0] ?? castIds[0] ?? '';
                  const mark = p.shots?.cast.find((c) => c.id === actor)?.mark ?? 'SR';
                  const staged: Beat = {
                    ...beat,
                    unsupported: [],
                    stage: [...(beat.stage ?? []), { type: 'enter', actor, to: { mark } } as StageAction],
                  };
                  p.onEditBeat(selected, staged);
                  // An entrance implies the actor is not on stage at open.
                  p.onEditCast(actor, { visible: false });
                }}
                className="h-6 rounded-[3px] border border-good bg-good/15 text-[#8fbd76] text-[10.5px] cursor-pointer text-left px-2 hover:bg-good/25"
              >
                Stage it as <b>enter {beat.focus[0] ?? castIds[0] ?? '…'} → {p.shots?.cast.find((c) => c.id === (beat.focus[0] ?? castIds[0]))?.mark ?? 'SR'}</b> — then adjust below
              </button>
              <button
                type="button"
                onClick={p.onGoWrite}
                className="h-6 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer text-left px-2 hover:text-ink"
              >
                Rewrite the line in the script
              </button>
            </div>
          </div>
        )}

        <div className="px-2.5 py-2.5 pb-4 flex flex-col gap-[11px]">
          {tab === 'beat' && <BeatTab {...p} cue={cue} castIds={castIds} />}
          {tab === 'motion' && (
            <AnimationPanel
              scene={p.scene}
              shots={p.shots}
              document={p.animation}
              playheadMs={p.playheadMs}
              selectedSegmentId={p.selectedMotionId}
              onDocument={p.onAnimationDocument}
              onTarget={p.onAnimationTarget}
              onSeek={p.onAnimationSeek}
              onDeleteSegment={p.onDeleteMotion}
            />
          )}
          {tab === 'rig' && <RigTab {...p} castIds={castIds} />}
          {tab === 'voice' && (
            <PerformancePanel
              scene={p.scene}
              cue={cue}
              document={p.dialogue}
              context={p.performContext}
              sceneRun={p.sceneRun}
              onReload={p.onReloadDialogue}
              onSaveCue={p.onSaveCue}
              onDiscardTake={p.onDiscardTake}
              speakerVoiceBound={p.speakerVoiceBound}
            />
          )}
          {tab === 'scene' && <SceneTab {...p} />}
          {tab === 'character' && <CharacterTab {...p} castIds={castIds} />}
          {tab === 'camera' && <CameraTab {...p} />}
          {tab === 'prop' && <PropTab {...p} />}
        </div>
      </div>
    </div>
  );
}

function Card({ children, tone }: { children: ReactNode; tone: 'lock' | 'info' }) {
  const border = tone === 'lock' ? 'rgba(168,144,80,.45)' : 'rgba(122,143,192,.4)';
  const bg = tone === 'lock' ? 'rgba(168,144,80,.10)' : 'rgba(122,143,192,.09)';
  return (
    <div className="mx-2.5 mt-[9px] px-2 py-[7px] rounded-[3px] border flex gap-[7px] items-start" style={{ borderColor: border, background: bg }}>
      {children}
    </div>
  );
}

function EmptyTab({ name }: { name: string }) {
  return (
    <div className="px-3 py-[22px] text-center text-[#5d656e] text-[11px] leading-[1.55]">
      Nothing of this kind is selected.<br />
      <span className="text-ink-ghost">Pick a {name} on the stage or in the timeline.</span>
    </div>
  );
}

// --- beat ------------------------------------------------------------------

function BeatTab(p: InspectorProps & { cue: DialogueCue | null; castIds: string[] }) {
  const { beat, selected, vocab, castIds } = p;
  if (!beat || selected === null) return <EmptyTab name="beat" />;
  const edit = (next: Beat) => p.onEditBeat(selected, next);
  const shotOptions = vocab?.shots ?? ['WIDE', 'MID', 'CU'];
  const cameraOptions = vocab?.cameraMoves ?? ['HOLD', 'PUSH_IN'];

  const speakerFg = beat.kind === 'line' ? speakerColour(castIds, beat.speaker) : '#6b737d';
  const headline = beat.kind === 'line' ? beat.speaker : beat.kind === 'pause' ? 'pause' : 'stage action';

  return (
    <>
      <div className="px-2 py-[7px] border border-[#2f353d] bg-stage rounded-[3px]">
        <div className="text-[9px] tracking-[.07em] uppercase mb-[3px]" style={{ color: speakerFg }}>{headline}</div>
        <div className="text-[12px] text-[#c9ccd1] leading-[1.45]">
          {beat.kind === 'pause' ? `${beat.ms} ms` : beat.text}
        </div>
      </div>

      {beat.kind === 'line' && (
        <>
          <label className="block">
            <FieldLabel label="Expression" value={beat.expression} />
            <OptionChips
              options={p.expressionsFor(beat.speaker)}
              value={beat.expression}
              onPick={(expression) => edit({ ...beat, expression })}
            />
            <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">
              Sets the face and the vocal delivery — a DEADPAN line is performed flat and slow, not merely drawn that way.
            </span>
          </label>
          <label className="block">
            <FieldLabel label="Gesture" value={beat.gesture} />
            <OptionChips
              options={vocab?.gestures ?? ['NONE', 'TALK']}
              value={beat.gesture}
              onPick={(gesture) => edit({ ...beat, gesture })}
            />
          </label>
        </>
      )}

      {beat.kind === 'pause' && (
        <label className="block">
          <FieldLabel label="Hold" value={`${beat.ms} ms`} />
          <span className="flex h-6 w-32 border border-edge bg-panel-2 rounded-[3px] overflow-hidden">
            <button type="button" onClick={() => edit({ ...beat, ms: Math.max(100, beat.ms - 100) })} className="w-[22px] text-ink-faint hover:bg-edge hover:text-ink cursor-pointer">−</button>
            <span className="flex-1 flex items-center justify-center font-mono text-[11px] text-ink">{beat.ms}</span>
            <button type="button" onClick={() => edit({ ...beat, ms: beat.ms + 100 })} className="w-[22px] text-ink-faint hover:bg-edge hover:text-ink cursor-pointer">+</button>
          </span>
          <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">The pause is the joke; its length is a writing decision.</span>
        </label>
      )}

      {beat.kind === 'action' && (
        <ActionFields
          beat={beat}
          castIds={castIds}
          onEdit={edit}
          occupied={occupiedMarks(p.shots)}
          defaultTarget={defaultContactTarget(p.setDescriptor)}
        />
      )}

      <label className="block">
        <FieldLabel label="Shot" />
        <OptionChips options={shotOptions} value={beat.shot} onPick={(shot) => edit({ ...beat, shot: shot as Beat['shot'] })} />
      </label>
      <label className="block">
        <FieldLabel label="Camera" />
        <OptionChips options={cameraOptions} value={beat.camera} onPick={(camera) => edit({ ...beat, camera: camera as Beat['camera'] })} />
      </label>
      <label className="block">
        <FieldLabel label="Focus" hint="Who the shot is on. Empty means everyone." />
        <OptionChips
          options={castIds}
          value={beat.focus[0] ?? null}
          onPick={(who) => edit({ ...beat, focus: beat.focus[0] === who ? [] : [who] })}
        />
      </label>

      <div>
        <FieldLabel label="Reactions" />
        {castIds
          .filter((id) => !(beat.kind === 'line' && id === beat.speaker))
          .map((id) => (
            <div key={id} className="flex items-center gap-[7px] h-[26px]">
              <span className="w-[52px] shrink-0 text-[10.5px]" style={{ color: speakerColour(castIds, id) }}>{id}</span>
              <select
                value={beat.reactions[id] ?? ''}
                onChange={(e) => edit({ ...beat, reactions: { ...beat.reactions, [id]: e.target.value } })}
                className="flex-1 h-[22px] border border-edge bg-panel-2 rounded-[3px] px-1.5 text-[10.5px] text-[#c9ccd1] outline-none cursor-pointer"
              >
                <option value="">—</option>
                {p.expressionsFor(id).map((expr) => <option key={expr} value={expr}>{expr}</option>)}
              </select>
            </div>
          ))}
        <div className="text-[10px] text-[#5d656e] mt-1 leading-[1.4]">What everyone else is doing while this lands.</div>
      </div>
    </>
  );
}

/** A sensible default contact prop: the first addressable mid-layer instance. */
function defaultContactTarget(set: SetDescriptor | null): string {
  if (!set) return 'desk';
  const counts = new Map<string, number>();
  for (const instance of Object.values(set.layers).flat()) {
    counts.set(instance.prop, (counts.get(instance.prop) ?? 0) + 1);
  }
  for (const instance of [...set.layers.mid, ...set.layers.fore, ...set.layers.back]) {
    if (instance.id) return instance.id;
    if (counts.get(instance.prop) === 1 && !instance.prop.startsWith('room-') && !instance.prop.startsWith('ceiling')) {
      return instance.prop;
    }
  }
  return 'desk';
}

function occupiedMarks(shots: ShotList | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const member of shots?.cast ?? []) {
    if (member.visible !== false) out[member.mark] = `${member.mark} is occupied by ${member.id}`;
  }
  return out;
}

/**
 * Ordered stage actions for an action beat.
 *
 * Each row is one structured action; the contextual second line follows the
 * action's contract in the schema — a destination mark for movement, a
 * required contact target for taps and reaches, a prop for pick-up business,
 * a direction for looks and turns. Type switches rebuild the action with
 * valid defaults so every write is schema-valid.
 */
function ActionFields({
  beat, castIds, onEdit, occupied, defaultTarget,
}: {
  beat: Beat & { kind: 'action' };
  castIds: string[];
  onEdit: (next: Beat) => void;
  occupied: Record<string, string>;
  defaultTarget: string;
}) {
  const actions = beat.stage ?? [];
  const write = (next: StageAction[]) => onEdit({ ...beat, stage: next });
  const patch = (index: number, changes: Partial<StageAction>) =>
    write(actions.map((a, i) => (i === index ? { ...a, ...changes } as StageAction : a)));

  const freshAction = (type: StageAction['type'], actor: string): StageAction => {
    switch (type) {
      case 'enter':
      case 'move':
        return { type, actor, to: { mark: 'CENTER' as Mark } };
      case 'exit':
      case 'stand':
      case 'sit':
        return { type, actor };
      case 'look':
      case 'turn':
        return { type, actor, direction: 'left' };
      case 'reach':
      case 'tap':
        return type === 'tap'
          ? { type, actor, target: defaultTarget, count: 2 }
          : { type, actor, target: defaultTarget };
      case 'pick_up':
      case 'put_down':
        return { type, actor, prop: defaultTarget };
    }
  };
  const retype = (index: number, type: StageAction['type']) =>
    write(actions.map((a, i) => (i === index ? freshAction(type, a.actor) : a)));

  const selectCls = 'h-[22px] border border-edge bg-panel-2 rounded-[3px] px-1 text-[10.5px] text-[#c9ccd1] outline-none cursor-pointer';
  const inputCls = 'h-[22px] w-full border border-edge bg-panel-2 rounded-[3px] px-1.5 text-[10.5px] text-[#c9ccd1] outline-none font-mono';

  /** Commit a required text field only when it is non-empty; reset otherwise. */
  const requiredBlur = (index: number, key: 'target' | 'prop' | 'seat', previous: string) =>
    (e: React.FocusEvent<HTMLInputElement>) => {
      const value = e.target.value.trim();
      if (!value) {
        e.target.value = previous;
        return;
      }
      patch(index, { [key]: value } as Partial<StageAction>);
    };

  return (
    <div>
      <FieldLabel label="Stage actions" hint="Ordered — they share this beat." />
      <div className="flex flex-col gap-1.5">
        {actions.map((action, i) => (
          <div key={i} className="border border-[#2f353d] rounded-[3px] bg-stage px-1.5 py-1.5 flex flex-col gap-1">
            <div className="flex gap-1">
              <select value={action.type} onChange={(e) => retype(i, e.target.value as StageAction['type'])} className={selectCls}>
                {STAGE_ACTIONS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
              <select value={action.actor} onChange={(e) => patch(i, { actor: e.target.value })} className={selectCls}>
                {castIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <span className="flex-1" />
              <button
                type="button"
                title="Remove this action"
                onClick={() => write(actions.filter((_, n) => n !== i))}
                className="w-[22px] h-[22px] rounded-[3px] border border-transparent text-ink-faint cursor-pointer hover:text-bad hover:border-bad/40"
              >
                ×
              </button>
            </div>
            {(action.type === 'enter' || action.type === 'move') && (
              <OptionChips
                options={MARKS}
                value={action.to?.mark ?? null}
                invalid={Object.fromEntries(Object.entries(occupied).filter(([mark, hint]) => !hint.includes(action.actor) && mark !== action.to?.mark))}
                onPick={(mark) => patch(i, { to: { ...(action.to ?? {}), mark: mark as Mark } })}
              />
            )}
            {(action.type === 'look' || action.type === 'turn') && (
              <select value={action.direction ?? 'left'} onChange={(e) => patch(i, { direction: e.target.value as 'left' | 'right' | 'front' })} className={selectCls}>
                {['left', 'right', 'front'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {(action.type === 'tap' || action.type === 'reach') && (
              <div className="flex gap-1 items-center">
                <input
                  placeholder="contact target, e.g. desk"
                  defaultValue={action.target ?? ''}
                  onBlur={requiredBlur(i, 'target', action.target ?? defaultTarget)}
                  className={inputCls}
                />
                {action.type === 'tap' && (
                  <input
                    type="number"
                    min={1}
                    max={5}
                    title="Tap count"
                    value={action.count ?? 2}
                    onChange={(e) => patch(i, { count: Math.max(1, Number(e.target.value) || 1) })}
                    className={`${inputCls} w-12`}
                  />
                )}
              </div>
            )}
            {(action.type === 'pick_up' || action.type === 'put_down') && (
              <input
                placeholder="prop, e.g. clipboard"
                defaultValue={action.prop ?? ''}
                onBlur={requiredBlur(i, 'prop', action.prop ?? defaultTarget)}
                className={inputCls}
              />
            )}
            {action.type === 'sit' && (
              <input
                placeholder="seat id (blank = nearest seat)"
                defaultValue={action.seat ?? ''}
                onBlur={(e) => patch(i, { seat: e.target.value.trim() || undefined })}
                className={inputCls}
              />
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => write([...actions, freshAction('move', beat.focus[0] ?? castIds[0] ?? '')])}
          className="h-[22px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:text-ink"
        >
          + Add action
        </button>
      </div>
      <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">
        Occupied marks are shown red. Unsupported physical business blocks production export.
      </span>
    </div>
  );
}

// --- rig -------------------------------------------------------------------

function RigTab(p: InspectorProps & { castIds: string[] }) {
  const member = p.beat?.kind === 'line'
    ? p.shots?.cast.find((c) => c.id === (p.beat as Beat & { kind: 'line' }).speaker)
    : p.shots?.cast[0];
  const walk = p.setDescriptor?.layout.walkable;
  const inBounds = member?.position && walk
    ? member.position.x >= walk.x && member.position.x <= walk.x + walk.width
    : true;

  const constraints = [
    { label: 'Walkable area', value: inBounds ? 'in bounds' : 'outside', dot: inBounds ? '#6f9b5a' : '#c8595a', fg: inBounds ? '#6f9b5a' : '#c8595a' },
    { label: 'Seat', value: member?.seat ?? 'none', dot: member?.seat ? '#a89050' : '#6f9b5a', fg: '#9aa1ab' },
    { label: 'Held prop', value: member?.heldProp ?? 'none', dot: member?.heldProp ? '#a89050' : '#6f9b5a', fg: '#9aa1ab' },
  ];

  return (
    <>
      <div className="text-[9.5px] tracking-[.09em] uppercase text-ink-faint">Controller</div>
      <div className="px-2 py-2 border border-[#2f353d] bg-stage rounded-[3px] text-[10.5px] text-ink-dim leading-[1.5]">
        Body changes blocking. A part adds a manual transform above generated acting — plain language, no rig jargon:{' '}
        <b className="text-[#c9ccd1]">hand</b>, <b className="text-[#c9ccd1]">head</b>, <b className="text-[#c9ccd1]">torso</b>,{' '}
        <b className="text-[#c9ccd1]">foot</b>. Pick the controller in the Motion tab; drag it on the stage.
      </div>
      <div>
        <FieldLabel label="Constraints" />
        {constraints.map((c) => (
          <div key={c.label} className="flex items-center gap-[7px] h-6 border-b border-[#262b32]">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c.dot }} />
            <span className="flex-1 text-[10.5px] text-ink-dim">{c.label}</span>
            <span className="font-mono text-[10px]" style={{ color: c.fg }}>{c.value}</span>
          </div>
        ))}
      </div>
      <div>
        <FieldLabel label="Motion presets" />
        <div className="flex flex-wrap gap-[3px]">
          {[
            { label: 'Reach and take', hint: 'Hand to a contact handle, grip, return' },
            { label: 'Sit down', hint: 'Approach the seat, turn, lower' },
            { label: 'Stand up', hint: 'Rise, settle, small recovery' },
            { label: 'Tap twice', hint: 'Two-step snap on a surface' },
            { label: 'Look off', hint: 'Head turn with a held beat' },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled
              title={`${preset.hint}. Designed ahead — presets are not in the engine yet; author the motion with a drag instead.`}
              className="h-[22px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-faint text-[10px] opacity-60 cursor-not-allowed"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-[#5d656e] mt-[5px] leading-[1.4]">
          Applying a preset writes an editable segment. It never overwrites motion you authored by hand.
        </div>
      </div>
    </>
  );
}

// --- scene -----------------------------------------------------------------

const FPS_OPTIONS = [12, 24, 30];
const CHARACTER_FPS_OPTIONS = [6, 8, 12, 24];

/**
 * The scene's own settings, written through the same shot-list path as every
 * beat edit. This tab used to be a readout — which meant a script headed
 * INT. OPEN PLAN OFFICE could stage in whichever set sorted first
 * alphabetically, with no visible cause and no control to fix it.
 */
function SceneTab(p: InspectorProps) {
  const shots = p.shots;
  const selectCls = 'h-[22px] border border-edge bg-panel-2 rounded-[3px] px-1 text-[10.5px] text-[#c9ccd1] outline-none cursor-pointer';
  const inputCls = 'h-[22px] border border-edge bg-panel-2 rounded-[3px] px-1.5 text-[10.5px] text-[#c9ccd1] outline-none';

  const readOnlyRows: Array<{ label: string; value: string; fg?: string }> = [
    { label: 'Scene', value: p.scene, fg: '#e6e3dc' },
    { label: 'Cast', value: shots ? shots.cast.map((c) => `${c.id} ${c.mark}`).join(' · ') : '—' },
    { label: 'Identity', value: p.identityLabel },
    {
      label: 'Duration',
      value: p.totalMs
        ? `${(p.totalMs / 1000).toFixed(1)} s · ${Math.round((p.totalMs / 1000) * (shots?.fps ?? 24))} frames`
        : '—',
    },
    { label: 'Beats', value: shots ? String(shots.beats.length) : '—' },
  ];

  if (!shots) {
    return (
      <>
        {readOnlyRows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 pb-1.5 border-b border-[#262b32]">
            <span className="w-[92px] shrink-0 text-[9.5px] tracking-[.07em] uppercase text-ink-faint">{row.label}</span>
            <span className="flex-1 font-mono text-[10.5px] leading-snug" style={{ color: row.fg ?? '#9aa1ab' }}>{row.value}</span>
          </div>
        ))}
        <div className="px-2 py-2 border border-[#2f353d] bg-stage rounded-[3px] text-[10.5px] text-ink-dim leading-[1.5]">
          Direct the scene to unlock its settings — set, seed, frame rates and cards all live on the shot list.
        </div>
      </>
    );
  }

  const currentSet = shots.set ? shots.set.replace(/\.(json|svg)$/, '') : '';
  const setNames = [...new Set([...p.sets.map((s) => s.name), ...(currentSet ? [currentSet] : [])])].sort();

  return (
    <>
      <label className="block">
        <FieldLabel label="Set" hint="The room this scene stages in." />
        <select
          value={currentSet}
          onChange={(e) => p.onEditShots({ set: e.target.value || null })}
          className={`${selectCls} w-full`}
        >
          <option value="">(no set — bare stage)</option>
          {setNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">
          The stage, walkable area and prop contacts all come from the set. Changing it redraws the preview immediately.
        </span>
      </label>

      <label className="block">
        <FieldLabel label="Seed" value={String(shots.seed)} />
        <span className="flex gap-1 items-center">
          <input
            type="number"
            value={shots.seed}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) p.onEditShots({ seed: Math.round(n) });
            }}
            className={`${inputCls} w-24 font-mono`}
          />
          <button
            type="button"
            title="Roll a different seed — new takes, blinks and idle phases, same direction."
            onClick={() => p.onEditShots({ seed: 1 + Math.floor(Math.random() * 9998) })}
            className="h-[22px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer hover:text-ink"
          >
            ↻ Reroll
          </button>
        </span>
        <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">
          Same inputs produce byte-identical frames — the seed is the one knob that changes performance without changing direction.
        </span>
      </label>

      <div className="flex gap-2">
        <label className="block flex-1">
          <FieldLabel label="Camera fps" />
          <select
            value={shots.fps}
            onChange={(e) => p.onEditShots({ fps: Number(e.target.value) })}
            className={`${selectCls} w-full`}
          >
            {[...new Set([...FPS_OPTIONS, shots.fps])].sort((a, b) => a - b).map((v) => (
              <option key={v} value={v}>{v} fps</option>
            ))}
          </select>
        </label>
        <label className="block flex-1">
          <FieldLabel label="Character fps" />
          <select
            value={shots.characterFps}
            onChange={(e) => p.onEditShots({ characterFps: Number(e.target.value) })}
            className={`${selectCls} w-full`}
          >
            {[...new Set([...CHARACTER_FPS_OPTIONS, shots.characterFps])].sort((a, b) => a - b).map((v) => (
              <option key={v} value={v}>{v} fps</option>
            ))}
          </select>
        </label>
      </div>
      <span className="block text-[10px] text-[#5d656e] -mt-2 leading-[1.4]">
        Characters run on twos while the camera stays smooth — lower character fps reads cheaper, not slower.
      </span>

      <div>
        <div className="flex items-center gap-[7px]">
          <FieldLabel label="Title cards" />
          <button
            type="button"
            title="Title and end cards around the scene. Treatment comes from the show identity; this is the per-scene switch and wording."
            onClick={() => p.onEditShots({ cards: !shots.cards })}
            className={`h-[22px] px-2 rounded-[3px] border text-[10.5px] cursor-pointer ${
              shots.cards ? 'border-accent/60 bg-accent/15 text-accent' : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
            }`}
          >
            {shots.cards ? 'on' : 'off'}
          </button>
        </div>
        {shots.cards && (
          <div className="flex flex-col gap-1 mt-1.5">
            <input
              placeholder={`title — blank uses “${p.scene}”`}
              defaultValue={shots.title ?? ''}
              onBlur={(e) => p.onEditShots({ title: e.target.value.trim() || null })}
              className={`${inputCls} w-full`}
            />
            <input
              placeholder="subtitle — blank for none"
              defaultValue={shots.subtitle ?? ''}
              onBlur={(e) => p.onEditShots({ subtitle: e.target.value.trim() || null })}
              className={`${inputCls} w-full`}
            />
          </div>
        )}
      </div>

      <SceneRestingField shots={shots} expressionsFor={p.expressionsFor} onEditAllCast={p.onEditAllCast} />

      {readOnlyRows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-2 pb-1.5 border-b border-[#262b32]">
          <span className="w-[92px] shrink-0 text-[9.5px] tracking-[.07em] uppercase text-ink-faint">{row.label}</span>
          <span className="flex-1 font-mono text-[10.5px] leading-snug" style={{ color: row.fg ?? '#9aa1ab' }}>{row.value}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The scene-wide resting default. `resting` is a per-cast-member field, so
 * this writes every member; a single character's override belongs in the
 * Character tab.
 */
function SceneRestingField({
  shots, expressionsFor, onEditAllCast,
}: {
  shots: ShotList;
  expressionsFor: (actorId: string) => string[];
  onEditAllCast: (changes: Partial<CastMember>) => void;
}) {
  const shared = shots.cast.every((member) => member.resting === shots.cast[0]?.resting)
    ? shots.cast[0]?.resting ?? null
    : null;
  // Only expressions every cast member can actually make are offered scene-wide.
  const options = shots.cast
    .map((member) => new Set(expressionsFor(member.id)))
    .reduce<string[]>((common, set, i) => (
      i === 0 ? [...set] : common.filter((e) => set.has(e))
    ), []);

  return (
    <label className="block">
      <FieldLabel label="Resting expression" value={shared ?? 'mixed'} />
      <OptionChips
        options={options.length ? options : ['NEUTRAL', 'DEADPAN']}
        value={shared}
        onPick={(resting) => onEditAllCast({ resting })}
      />
      <span className="block text-[10px] text-[#5d656e] mt-1 leading-[1.4]">
        The face everyone returns to when not otherwise directed. Per-character overrides live in the Character tab.
      </span>
    </label>
  );
}

// --- character / camera / prop --------------------------------------------

function CharacterTab(p: InspectorProps & { castIds: string[] }) {
  const speaker = p.beat?.kind === 'line' ? p.beat.speaker : p.beat?.focus[0] ?? null;
  const member = speaker ? p.shots?.cast.find((c) => c.id === speaker) ?? null : null;
  if (!member) return <EmptyTab name="character" />;
  return (
    <>
      <div className="px-2 py-[7px] border border-[#2f353d] bg-stage rounded-[3px]">
        <div className="text-[9px] tracking-[.07em] uppercase mb-[3px]" style={{ color: speakerColour(p.castIds, member.id) }}>{member.id}</div>
        <div className="font-mono text-[10.5px] text-ink-dim">rig {member.rig} · resting {member.resting}</div>
      </div>
      <label className="block">
        <FieldLabel label="Mark" />
        <OptionChips options={MARKS} value={member.mark} onPick={(mark) => p.onEditCast(member.id, { mark: mark as CastMember['mark'] })} />
      </label>
      <label className="block">
        <FieldLabel label="Resting" hint="The face this character returns to when not otherwise directed." />
        <OptionChips
          options={p.expressionsFor(member.id)}
          value={member.resting}
          onPick={(resting) => p.onEditCast(member.id, { resting })}
        />
      </label>
      <div className="flex items-center gap-[7px]">
        <span className="text-[9.5px] tracking-[.09em] uppercase text-ink-faint w-16">Facing</span>
        <button
          type="button"
          onClick={() => p.onEditCast(member.id, { flip: !member.flip })}
          className="h-[22px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer hover:text-ink"
        >
          {member.flip ? 'stage left ←' : '→ stage right'}
        </button>
      </div>
      <div className="flex items-center gap-[7px]">
        <span className="text-[9.5px] tracking-[.09em] uppercase text-ink-faint w-16">At open</span>
        <button
          type="button"
          title="Whether this character is on stage when the scene opens. A staged enter action requires them to start off."
          onClick={() => p.onEditCast(member.id, { visible: member.visible === false })}
          className={`h-[22px] px-2 rounded-[3px] border text-[10.5px] cursor-pointer ${
            member.visible === false
              ? 'border-gen/50 bg-gen/15 text-[#a8b6d4]'
              : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
          }`}
        >
          {member.visible === false ? 'enters later' : 'on stage'}
        </button>
      </div>
      <button
        type="button"
        onClick={() => p.onOpenCastEditor(member.rig)}
        className="h-6 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer hover:text-ink"
      >
        Open {member.rig} in the cast editor…
      </button>
    </>
  );
}

function CameraTab(p: InspectorProps) {
  const { beat, selected } = p;
  if (!beat || selected === null) return <EmptyTab name="camera move" />;
  return (
    <>
      <label className="block">
        <FieldLabel label="Shot" />
        <OptionChips
          options={p.vocab?.shots ?? []}
          value={beat.shot}
          onPick={(shot) => p.onEditBeat(selected, { ...beat, shot: shot as Beat['shot'] })}
        />
      </label>
      <label className="block">
        <FieldLabel label="Move" />
        <OptionChips
          options={p.vocab?.cameraMoves ?? []}
          value={beat.camera}
          onPick={(camera) => p.onEditBeat(selected, { ...beat, camera: camera as Beat['camera'] })}
        />
      </label>
      <div className="px-2 py-2 border border-[#2f353d] bg-stage rounded-[3px] text-[10.5px] text-ink-dim leading-[1.5]">
        Characters run on twos, the camera on ones — a PUSH_IN stays silky while the acting stays limited.
      </div>
    </>
  );
}

function PropTab(p: InspectorProps) {
  const instances = p.setDescriptor ? Object.values(p.setDescriptor.layers).flat() : [];
  if (!instances.length) return <EmptyTab name="prop" />;
  return (
    <>
      <FieldLabel label={`Props in ${p.setDescriptor?.name ?? 'set'}`} />
      {instances.map((instance, i) => {
        const id = instance.id ?? instance.prop;
        const seated = p.shots?.cast.find((c) => c.seat === id);
        const held = p.shots?.cast.find((c) => c.heldProp === id);
        return (
          <div key={`${id}-${i}`} className="flex items-center gap-[7px] h-6 border-b border-[#262b32]">
            <span className="flex-1 font-mono text-[10.5px] text-ink-dim truncate">{id}</span>
            {seated && <Tag color="#c8595a" title={`Seat occupied by ${seated.id}`}>occupied</Tag>}
            {held && <Tag color="#6f9b5a" title={`Held by ${held.id}`}>held</Tag>}
          </div>
        );
      })}
      <div className="text-[10px] text-[#5d656e] leading-[1.4]">
        Seats are addressable targets with occupancy, not a generic “sit” verb.
      </div>
    </>
  );
}
