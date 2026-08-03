import { useMemo } from 'react';
import type { DialogueDocument, ProductionPreflightReport, ShotList } from '../types.ts';
import { ScriptEditor } from '../components/ScriptEditor.tsx';
import { Dot } from './chrome.tsx';
import { cueApproval, speakerColour, type Mode } from './lib.ts';

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

/** Write/Direct: the fountain source, colours doing the parsing for you. */
export function ScriptPane({
  scene, source, onChange,
}: {
  scene: string;
  source: string;
  onChange: (source: string) => void;
}) {
  return (
    <>
      <SubPaneHeader title="Script" meta={`${scene}.md · fountain`} />
      <div className="flex-1 min-h-0">
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
  const approvedCount = (dialogue?.cues ?? []).filter((cue) => cueApproval(cue) === 'approved').length;

  return (
    <>
      <SubPaneHeader
        title={speakerFilter ? `Lines · ${speakerFilter}` : 'Lines'}
        meta={dialogue ? `${approvedCount} of ${dialogue.cues.length} approved` : '—'}
      />
      <div className="flex-1 min-h-0 overflow-y-auto py-1 pb-3.5">
        {cues.map((cue, n) => {
          const on = selected === cue.beatIndex;
          const state = cueApproval(cue);
          const dot = state === 'approved' ? '#6f9b5a' : state === 'candidate' ? '#c8834a' : '#c8595a';
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
                    title={state === 'approved' ? 'Approved take, locked to picture' : state === 'candidate' ? 'Candidate take — auditioned, not approved' : 'No take recorded yet'}
                  />
                  {state === 'approved' && <span title="Approved and pinned to picture" className="text-[8px] text-lock">🔒</span>}
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
    go?: () => void;
  }>;
}

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
  onJump?: (code: string) => void,
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
      go: onJump ? () => onJump(note.code) : undefined,
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
          title={item.go ? 'Jump to the affected mode' : undefined}
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
  onJump: (code: string) => void;
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

/** Sound: the proposed mix surface. Explicitly designed ahead of the engine. */
export function MixerPane() {
  const strips = [
    { name: 'Dialogue', color: '#6f9b5a', rest: 22, db: '−6.0 dB' },
    { name: 'Foley', color: '#5e8f8a', rest: 48, db: '−15.5 dB' },
    { name: 'Room tone', color: '#5e6874', rest: 72, db: '−28.0 dB' },
    { name: 'Music', color: '#8f7fb0', rest: 88, db: '−34.0 dB' },
    { name: 'Programme', color: '#c8834a', rest: 16, db: '−14.1 LUFS' },
  ];
  return (
    <>
      <SubPaneHeader title="Mix" meta="48 kHz · stereo" />
      <div className="flex-1 min-h-0 overflow-y-auto px-[9px] py-2.5 pb-4 flex flex-col gap-2">
        <div className="border border-gen/45 bg-gen/10 rounded-[3px] px-[9px] py-[7px] text-[11px] text-[#a8b6d4] leading-[1.5]">
          Designed ahead of the engine. Mixing, stems and Foley run in the CLI render today — this pane is the proposed surface, not a shipped one.
        </div>
        {strips.map((strip) => (
          <div key={strip.name} className="flex items-center gap-2 px-2 py-[7px] border border-[#2f353d] rounded-[3px] bg-[#22262c]">
            <span className="w-[3px] h-[26px] rounded-px shrink-0" style={{ background: strip.color }} />
            <span className="w-[74px] shrink-0 text-[10px] tracking-[.05em] uppercase text-ink-dim">{strip.name}</span>
            <span className="flex-1 h-1.5 rounded-[3px] bg-deep overflow-hidden relative block">
              <span className="absolute inset-y-0 left-0" style={{ right: `${strip.rest}%`, background: strip.color }} />
            </span>
            <span className="font-mono text-[10px] text-ink-faint w-[52px] text-right shrink-0">{strip.db}</span>
          </div>
        ))}
        <div className="flex gap-1.5 mt-0.5">
          <div className="flex-1 border border-[#2f353d] rounded-[3px] px-2 py-1.5 bg-[#22262c]">
            <div className="text-[9px] tracking-[.07em] uppercase text-ink-faint">integrated</div>
            <div className="font-mono text-[14px] text-good mt-[2px]">−14.1 LUFS</div>
          </div>
          <div className="flex-1 border border-[#2f353d] rounded-[3px] px-2 py-1.5 bg-[#22262c]">
            <div className="text-[9px] tracking-[.07em] uppercase text-ink-faint">true peak</div>
            <div className="font-mono text-[14px] text-good mt-[2px]">−1.4 dBTP</div>
          </div>
        </div>
      </div>
    </>
  );
}
