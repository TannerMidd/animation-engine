import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtMs } from '../api.ts';
import type {
  CastSummary, CheckResult, DialogueDocument, ProductionPreflightNote, ProductionPreflightReport,
  SceneSoundInfo, ShotList, StemId, Vocab,
} from '../types.ts';
import { ScriptEditor } from '../components/ScriptEditor.tsx';
import { ScriptComposer } from './compose/ScriptComposer.tsx';
import { Dot, Spinner } from './chrome.tsx';
import { cueApproval, cueUndecided, humanHint, speakerColour, type Mode } from './lib.ts';

/** Sub-pane widths per mode, from the design. */
export function subPaneWidth(mode: Mode): number {
  if (mode === 'write') return 496;
  if (mode === 'publish') return 384;
  if (mode === 'sound') return 332;
  if (mode === 'perform') return 288;
  return 272;
}

export function SubPaneHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="h-7 shrink-0 flex items-center gap-[7px] px-[9px] border-b border-[#2f353d] bg-[#22262c]">
      <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">{title}</span>
      <div className="flex-1" />
      <span className="font-mono text-[9px] text-ink-ghost">{meta}</span>
    </div>
  );
}

/**
 * Write/Direct: the script, as cards or as the file itself.
 *
 * Compose is the default when writing, because the vocabulary — which feelings
 * exist, what a pause looks like — should be something you pick, not something
 * you remember. Source is the default when directing, where the file is being
 * read rather than written. Both stay mounted so flipping tabs keeps the
 * editor's cursor and undo history intact.
 */
export function ScriptPane({
  scene, source, onChange, mode, vocab, cast, check, checkedSource,
}: {
  scene: string;
  source: string;
  onChange: (source: string) => void;
  mode: Mode;
  vocab: Vocab | null;
  cast: CastSummary[];
  check: CheckResult | null;
  checkedSource: string | null;
}) {
  const [tab, setTab] = useState<'compose' | 'source'>(mode === 'write' ? 'compose' : 'source');
  // A mode switch re-asserts the default; within a mode the choice sticks.
  useEffect(() => setTab(mode === 'write' ? 'compose' : 'source'), [mode]);

  return (
    <>
      <div className="h-7 shrink-0 flex items-center gap-[7px] px-[9px] border-b border-[#2f353d] bg-[#22262c]">
        {(['compose', 'source'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`text-[10px] tracking-[.09em] uppercase cursor-pointer ${
              tab === name ? 'text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {name}
          </button>
        ))}
        <div className="flex-1" />
        <span className="font-mono text-[9px] text-ink-ghost">
          {tab === 'source' ? `${scene}.md · fountain` : `${scene}.md`}
        </span>
      </div>
      <div className={`flex-1 min-h-0 flex flex-col ${tab === 'compose' ? '' : 'hidden'}`}>
        <ScriptComposer
          source={source}
          onChange={onChange}
          vocab={vocab}
          cast={cast}
          check={check}
          checkedSource={checkedSource}
          compact={mode !== 'write'}
        />
      </div>
      <div className={`flex-1 min-h-0 ${tab === 'source' ? '' : 'hidden'}`}>
        <ScriptEditor value={source} onChange={onChange} />
      </div>
    </>
  );
}

/** Perform: every line, its approval state, and where the takes are missing. */
export function LinesPane({
  dialogue, shots, selected, onSelect, speakerFilter,
}: {
  dialogue: DialogueDocument | null;
  shots: ShotList | null;
  selected: number | null;
  onSelect: (beatIndex: number) => void;
  speakerFilter: string | null;
}) {
  const castIds = shots?.cast.map((c) => c.id) ?? [];
  const cues = useMemo(
    () => (dialogue?.cues ?? []).filter((cue) => !speakerFilter || cue.speaker === speakerFilter),
    [dialogue, speakerFilter],
  );
  const decidedCount = (dialogue?.cues ?? []).filter((cue) => !cueUndecided(cue)).length;

  return (
    <>
      <SubPaneHeader
        title={speakerFilter ? `Lines · ${speakerFilter}` : 'Lines'}
        meta={dialogue ? `${decidedCount} of ${dialogue.cues.length} decided` : '—'}
      />
      <div className="flex-1 min-h-0 overflow-y-auto py-1 pb-3.5">
        {cues.map((cue, n) => {
          const on = selected === cue.beatIndex;
          const state = cueApproval(cue);
          const dot = state === 'approved' ? '#6f9b5a' : state === 'generated' ? '#7a8fc0' : state === 'candidate' ? '#c8834a' : '#c8595a';
          return (
            <button
              key={cue.id}
              type="button"
              title={`${cue.speaker} · beat ${cue.beatIndex}`}
              onClick={() => onSelect(cue.beatIndex)}
              className="w-full flex gap-2 items-start px-[9px] py-1.5 border-0 text-left cursor-pointer hover:bg-[#25292f]"
              style={{
                background: on ? 'rgba(200,131,74,.13)' : 'transparent',
                borderLeft: `2px solid ${on ? '#c8834a' : 'transparent'}`,
              }}
            >
              <span className="font-mono text-[9px] text-ink-ghost w-4 shrink-0 pt-[2px]">{n + 1}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 mb-[2px]">
                  <span className="text-[9px] tracking-[.07em] uppercase" style={{ color: speakerColour(castIds, cue.speaker) }}>
                    {cue.speaker}
                  </span>
                  <Dot
                    color={dot}
                    title={state === 'approved'
                      ? 'Approved take, locked to picture'
                      : state === 'generated'
                        ? 'Character voice — generated by explicit approval'
                        : state === 'candidate'
                          ? 'Candidate take — auditioned, not approved'
                          : 'Undecided — record a take or approve the generated voice'}
                  />
                  {state === 'approved' && <span title="Approved and pinned to picture" className="text-[8px] text-lock">🔒</span>}
                  {state === 'generated' && <span title="Generated character voice, approved" className="text-[8px] text-gen">◇</span>}
                </span>
                <span className="block text-[11px] leading-[1.35]" style={{ color: on ? '#e6e3dc' : '#8b939d' }}>
                  {cue.displayText}
                </span>
              </span>
            </button>
          );
        })}
        {!cues.length && (
          <div className="px-3 py-5 text-center text-[11px] text-ink-ghost leading-relaxed">
            No dialogue cues yet.<br />Direct the scene first.
          </div>
        )}
      </div>
    </>
  );
}

// --- publish: readiness ----------------------------------------------------

export interface ReadinessGroup {
  name: string;
  dot: string;
  fg: string;
  count: string;
  items: Array<{
    level: 'error' | 'warn' | 'info';
    levelFg: string;
    msg: string;
    code: string;
    /** Set when the note names something the editor can select. */
    targeted: boolean;
    go?: () => void;
  }>;
}

// Repair hints live in lib.ts so a test can hold them against the engine's
// code list without pulling React into the test.
export { humanHint };

const GROUPS: Array<{ name: string; test: RegExp }> = [
  { name: 'Script', test: /action|script|beat|parse/ },
  { name: 'Staging', test: /staging|walkable|blocking|collision|seat|mark/ },
  { name: 'Animation', test: /animation|motion|gesture|rig/ },
  { name: 'Dialogue', test: /dialogue|voice|take|consent|speaker|line/ },
  { name: 'Sound', test: /sound|audio|foley|lufs|loudness|music/ },
  { name: 'Portrait safety', test: /caption|portrait|vertical|safe/ },
  { name: 'Export', test: /render|export|manifest|stale|video/ },
];

export function groupPreflight(
  report: ProductionPreflightReport | null,
  onJump?: (note: ProductionPreflightNote) => void,
): ReadinessGroup[] {
  if (!report) return [];
  const buckets = new Map<string, ReadinessGroup['items']>();
  for (const note of report.notes) {
    const group = GROUPS.find((g) => g.test.test(note.code))?.name ?? 'General';
    const list = buckets.get(group) ?? [];
    list.push({
      level: note.level,
      levelFg: note.level === 'error' ? '#c8595a' : note.level === 'warn' ? '#c8834a' : '#7a8fc0',
      msg: note.message,
      code: note.code,
      targeted: Boolean(note.target),
      go: onJump ? () => onJump(note) : undefined,
    });
    buckets.set(group, list);
  }
  return [...buckets.entries()].map(([name, items]) => {
    const errors = items.filter((i) => i.level === 'error').length;
    const warns = items.filter((i) => i.level === 'warn').length;
    const infos = items.filter((i) => i.level === 'info').length;
    const parts = [
      errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
      warns ? `${warns} warning${warns === 1 ? '' : 's'}` : '',
      infos ? `${infos} note${infos === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return {
      name,
      items,
      dot: errors ? '#c8595a' : warns ? '#c8834a' : '#7a8fc0',
      fg: errors ? '#c8595a' : warns ? '#c8834a' : '#9aa1ab',
      count: parts.join(' · ') || '0',
    };
  });
}

export function ReadinessGroupCard({ group, dark }: { group: ReadinessGroup; dark?: boolean }) {
  return (
    <div className={`border border-[#2f353d] rounded-[3px] overflow-hidden ${dark ? 'bg-stage' : 'bg-[#22262c]'}`}>
      <div className={`h-6 flex items-center gap-[7px] px-2 border-b border-[#2f353d] ${dark ? 'bg-[#22262c]' : 'bg-panel'}`}>
        <Dot color={group.dot} />
        <span className="flex-1 text-[10px] tracking-[.07em] uppercase" style={{ color: group.fg }}>{group.name}</span>
        <span className="font-mono text-[9px] text-ink-ghost">{group.count}</span>
      </div>
      {group.items.map((item, i) => (
        <button
          key={`${item.code}-${i}`}
          type="button"
          onClick={item.go}
          title={!item.go ? undefined : item.targeted ? 'Select the line, clip or asset this is about' : 'Jump to the affected mode'}
          className="w-full flex gap-[7px] items-start px-2 py-1.5 border-0 border-t border-t-[#262b32] bg-transparent text-left cursor-pointer hover:bg-[#282d34]"
        >
          <span
            className="text-[9px] tracking-[.06em] uppercase border rounded-[2px] px-[3px] leading-[13px] mt-px shrink-0"
            style={{ color: item.levelFg, borderColor: item.levelFg }}
          >
            {item.level === 'warn' ? 'warn' : item.level}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] text-[#c9ccd1] leading-[1.4]">{item.msg}</span>
            {humanHint(item.code) && (
              <span className="block text-[10px] text-ink-faint leading-[1.45] mt-[2px]">{humanHint(item.code)}</span>
            )}
            <span className="inline-block mt-[3px] font-mono text-[9px] text-ink-ghost">{item.code}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ReadinessPane({
  report, onJump,
}: {
  report: ProductionPreflightReport | null;
  onJump: (note: ProductionPreflightNote) => void;
}) {
  const groups = groupPreflight(report, onJump);
  const errors = report?.notes.filter((n) => n.level === 'error').length ?? 0;
  const warns = report?.notes.filter((n) => n.level === 'warn').length ?? 0;
  const infos = report?.notes.filter((n) => n.level === 'info').length ?? 0;

  return (
    <>
      <SubPaneHeader title="Readiness" meta="policy production-v1" />
      <div className="flex-1 min-h-0 overflow-y-auto px-[9px] py-2 pb-4 flex flex-col gap-[9px]">
        <div className="flex gap-1.5">
          <StatCell n={errors} label="blockers" color="#c8595a" />
          <StatCell n={warns} label="warnings" color="#c8834a" />
          <StatCell n={infos} label="notes" color="#9aa1ab" />
        </div>
        {groups.map((group) => <ReadinessGroupCard key={group.name} group={group} />)}
        {!report && (
          <div className="px-3 py-5 text-center text-[11px] text-ink-ghost leading-relaxed">
            Preflight has not run yet.<br />It runs automatically as you edit.
          </div>
        )}
      </div>
    </>
  );
}

function StatCell({ n, label, color }: { n: number; label: string; color: string }) {
  const tinted = color !== '#9aa1ab';
  return (
    <div
      className="flex-1 rounded-[3px] px-2 py-1.5 border"
      style={{
        borderColor: tinted ? `${color}73` : '#363d46',
        background: tinted ? `${color}1a` : '#22262c',
      }}
    >
      <div className="font-mono text-[17px] leading-none" style={{ color }}>{n}</div>
      <div className="text-[9px] tracking-[.07em] uppercase mt-[2px]" style={{ color: tinted ? `${color}b3` : '#6b737d' }}>{label}</div>
    </div>
  );
}

// --- sound: the production stems ------------------------------------------

const STEM_META: Record<StemId, { label: string; color: string; blurb: string }> = {
  dialogue: { label: 'Dialogue', color: '#6f9b5a', blurb: 'every selected take and generated line, levelled per speaker' },
  foley: { label: 'Foley', color: '#5e8f8a', blurb: 'deterministic one-shots derived from staged actions' },
  ambience: { label: 'Room tone', color: '#5e6874', blurb: 'the set’s acoustic bed, from the identity profile' },
  stings: { label: 'Stings', color: '#8f7fb0', blurb: 'title and end card music, seeded from the identity' },
};

/**
 * Sound: the production stems as they stand on disk.
 *
 * The mixer writes dialogue, Foley, room tone and stings beside the master in
 * one pass; this pane plays them together with per-stem gain, solo and mute —
 * client-side monitoring only, since the master on disk is the deliverable.
 */
export function MixerPane({
  scene, sound, loading, rebuilding, onRebuild,
}: {
  scene: string;
  sound: SceneSoundInfo | null;
  loading: boolean;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [gains, setGains] = useState<Record<StemId, number>>({ dialogue: 1, ambience: 1, foley: 1, stings: 1 });
  const [muted, setMuted] = useState<Record<StemId, boolean>>({ dialogue: false, ambience: false, foley: false, stings: false });
  const [solo, setSolo] = useState<StemId | null>(null);
  const players = useRef(new Map<StemId, HTMLAudioElement>());

  const playable = Boolean(sound?.available && sound.current);
  const stems = (sound?.stems ?? []).filter((stem) => stem.exists);

  /** A stem is audible when not muted and either nothing or itself is soloed. */
  const audible = (id: StemId) => !muted[id] && (solo === null || solo === id);

  const applyVolumes = (nextGains = gains, nextMuted = muted, nextSolo = solo) => {
    for (const [id, el] of players.current) {
      const on = !nextMuted[id] && (nextSolo === null || nextSolo === id);
      el.volume = on ? Math.min(1, nextGains[id]) : 0;
    }
  };

  const stopAll = () => {
    for (const el of players.current.values()) {
      el.pause();
      el.currentTime = 0;
    }
    setPlaying(false);
  };

  const playAll = () => {
    applyVolumes();
    for (const el of players.current.values()) {
      el.currentTime = 0;
      void el.play().catch(() => {});
    }
    setPlaying(true);
  };

  // Stems change identity when the scene or mix does; stale elements must not
  // keep playing an old room.
  useEffect(() => stopAll, [scene, sound?.durationMs]);

  return (
    <>
      <SubPaneHeader
        title="Mix"
        meta={sound ? `${sound.engine}${sound.durationMs ? ` · ${fmtMs(sound.durationMs)}` : ''}` : '—'}
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-[9px] py-2.5 pb-4 flex flex-col gap-2">
        {loading && !sound && (
          <div className="py-6 text-center text-[11px] text-ink-ghost"><Spinner /> reading the mix…</div>
        )}

        {sound && !sound.available && (
          <div className="border border-gen/45 bg-gen/10 rounded-[3px] px-[9px] py-[7px] text-[11px] text-[#a8b6d4] leading-[1.5]">
            No stems yet. Run Voices — the mix writes dialogue, Foley, room tone and stings beside the master in one pass.
          </div>
        )}
        {sound?.available && !sound.current && (
          <div className="border border-accent/45 bg-accent/10 rounded-[3px] px-[9px] py-[7px] text-[11px] text-[#e0b489] leading-[1.5] flex items-center gap-2">
            <span className="flex-1">The stems predate the current scene — the server will not play stale audio.</span>
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuilding}
              className="h-[22px] px-2 rounded-[3px] border border-accent bg-accent/20 text-accent text-[10.5px] cursor-pointer hover:bg-accent/30 disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
            >
              {rebuilding ? <Spinner /> : null}
              Rebuild stems
            </button>
          </div>
        )}

        {playable && stems.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => (playing ? stopAll() : playAll())}
              className={`h-6 px-3 rounded-[3px] border text-[11px] font-semibold cursor-pointer ${
                playing ? 'bg-bad/20 border-bad text-[#e0a0a1]' : 'bg-accent border-accent text-stage'
              }`}
            >
              {playing ? '■ Stop' : '▶ Play stems'}
            </button>
            <span className="text-[10px] text-ink-faint">gain, solo and mute are monitoring only — the master on disk is untouched</span>
          </div>
        )}

        {stems.map((stem) => {
          const meta = STEM_META[stem.id];
          const on = audible(stem.id);
          return (
            <div key={stem.id} className="px-2 py-[7px] border border-[#2f353d] rounded-[3px] bg-[#22262c] flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="w-[3px] h-[22px] rounded-px shrink-0" style={{ background: meta.color, opacity: on ? 1 : 0.35 }} />
                <span className="w-[74px] shrink-0 text-[10px] tracking-[.05em] uppercase" style={{ color: on ? '#9aa1ab' : '#5d656e' }}>
                  {meta.label}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={gains[stem.id]}
                  onChange={(e) => {
                    const next = { ...gains, [stem.id]: Number(e.target.value) };
                    setGains(next);
                    applyVolumes(next);
                  }}
                  className="flex-1 h-1 cursor-pointer"
                  style={{ accentColor: meta.color }}
                />
                <button
                  type="button"
                  title="Solo this stem"
                  onClick={() => {
                    const next = solo === stem.id ? null : stem.id;
                    setSolo(next);
                    applyVolumes(gains, muted, next);
                  }}
                  className={`w-[20px] h-[18px] rounded-[2px] border text-[9px] cursor-pointer ${
                    solo === stem.id ? 'border-accent bg-accent/25 text-accent' : 'border-edge text-ink-faint hover:text-ink'
                  }`}
                >
                  S
                </button>
                <button
                  type="button"
                  title="Mute this stem"
                  onClick={() => {
                    const next = { ...muted, [stem.id]: !muted[stem.id] };
                    setMuted(next);
                    applyVolumes(gains, next);
                  }}
                  className={`w-[20px] h-[18px] rounded-[2px] border text-[9px] cursor-pointer ${
                    muted[stem.id] ? 'border-bad/60 bg-bad/20 text-bad' : 'border-edge text-ink-faint hover:text-ink'
                  }`}
                >
                  M
                </button>
              </div>
              <div className="text-[9.5px] text-ink-ghost pl-[85px] leading-[1.35]">{meta.blurb}</div>
              {playable && (
                <audio
                  ref={(el) => {
                    if (el) players.current.set(stem.id, el);
                    else players.current.delete(stem.id);
                  }}
                  src={api.stemUrl(scene, stem.id)}
                  preload="none"
                  onEnded={stem.id === 'dialogue' ? () => setPlaying(false) : undefined}
                  className="hidden"
                />
              )}
            </div>
          );
        })}

        {sound?.quality && (
          <div className="flex gap-1.5 mt-0.5">
            <div
              className="flex-1 border rounded-[3px] px-2 py-1.5"
              style={{
                borderColor: sound.quality.loudnessPassed ? '#3a4a38' : 'rgba(200,89,90,.5)',
                background: '#22262c',
              }}
            >
              <div className="text-[9px] tracking-[.07em] uppercase text-ink-faint">integrated</div>
              <div className={`font-mono text-[14px] mt-[2px] ${sound.quality.loudnessPassed ? 'text-good' : 'text-bad'}`}>
                {sound.quality.integratedLufs === null ? 'silence' : `${sound.quality.integratedLufs.toFixed(1)} LUFS`}
              </div>
              <div className="text-[9px] text-ink-ghost">target {sound.quality.targetIntegratedLufs?.toFixed(0) ?? '—'}</div>
            </div>
            <div
              className="flex-1 border rounded-[3px] px-2 py-1.5"
              style={{
                borderColor: sound.quality.truePeakPassed ? '#3a4a38' : 'rgba(200,89,90,.5)',
                background: '#22262c',
              }}
            >
              <div className="text-[9px] tracking-[.07em] uppercase text-ink-faint">true peak</div>
              <div className={`font-mono text-[14px] mt-[2px] ${sound.quality.truePeakPassed ? 'text-good' : 'text-bad'}`}>
                {sound.quality.truePeakDbtp === null ? 'silence' : `${sound.quality.truePeakDbtp.toFixed(1)} dBTP`}
              </div>
              <div className="text-[9px] text-ink-ghost">ceiling {sound.quality.truePeakCeilingDbtp?.toFixed(1) ?? '—'}</div>
            </div>
          </div>
        )}

        {sound && (
          <div className="px-2 py-[7px] border border-[#2f353d] rounded-[3px] bg-[#22262c]">
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-[.05em] uppercase text-ink-dim">Room tone</span>
              <div className="flex-1" />
              <span className="font-mono text-[10px] text-ink-faint">
                {sound.ambience.enabled ? `${sound.ambience.profile} · ${sound.ambience.levelDb.toFixed(0)} dB` : 'off (identity)'}
              </span>
            </div>
            <div className="text-[9.5px] text-ink-ghost leading-[1.4] mt-[2px]">
              The acoustic profile follows the scene's set through the identity profile — change the set in the Scene tab,
              or the profile's ambience settings, and rebuild.
            </div>
          </div>
        )}

        {sound && sound.foley.count > 0 && (
          <div className="border border-[#2f353d] rounded-[3px] bg-[#22262c] overflow-hidden">
            <div className="h-6 flex items-center gap-2 px-2 border-b border-[#2f353d]">
              <span className="text-[10px] tracking-[.05em] uppercase text-ink-dim">Foley events</span>
              <div className="flex-1" />
              <span className="font-mono text-[9px] text-ink-ghost">{sound.foley.count}</span>
            </div>
            <div className="max-h-[180px] overflow-y-auto">
              {sound.foley.events.map((event) => (
                <div key={event.id} className="flex items-center gap-2 px-2 h-[22px] border-b border-[#262b32] last:border-b-0">
                  <span className="font-mono text-[9px] text-ink-ghost w-[44px] shrink-0">{fmtMs(event.placementMs)}</span>
                  <span className="text-[10px] text-[#9fc0bb] w-[64px] shrink-0">{event.type.replace('_', ' ')}</span>
                  <span className="text-[10px] text-ink-dim flex-1 truncate">{event.actor}</span>
                  <span className="font-mono text-[9px] text-ink-ghost shrink-0">{event.gainDb.toFixed(0)} dB</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sound && sound.guides.length > 0 && (
          <div className="text-[10px] text-ink-faint leading-[1.5]">
            Scene Run guides: {sound.guides.join(', ')} — served to the booth with each performer's open lines muted.
          </div>
        )}
      </div>
    </>
  );
}
