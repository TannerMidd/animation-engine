import { useMemo, useState } from 'react';
import type { AnimationDocument, CastSummary, DialogueDocument, Health, SceneDetail, SceneSummary, SetSummary, ShotList } from '../types.ts';
import { Dot, SectionRule } from './chrome.tsx';
import { cueApproval, type Mode } from './lib.ts';

interface Row {
  key: string;
  label: string;
  glyph: string;
  pad: number;
  h: number;
  serif?: boolean;
  fg?: string;
  mark?: string;
  bg?: string;
  badge?: { text: string; color: string; hint: string };
  dot?: { color: string; hint: string };
  count?: string;
  hint: string;
  go?: () => void;
}

function TreeRow({ row }: { row: Row }) {
  return (
    <button
      type="button"
      title={row.hint}
      onClick={row.go}
      className="w-full flex items-center gap-1.5 pr-2 border-0 text-left cursor-pointer hover:bg-panel-2"
      style={{
        height: row.h,
        paddingLeft: row.pad,
        background: row.bg ?? 'transparent',
        borderLeft: `2px solid ${row.mark ?? 'transparent'}`,
        color: row.fg ?? '#9aa1ab',
      }}
    >
      <span className="w-[11px] text-center text-ink-faint text-[9px] shrink-0">{row.glyph}</span>
      <span
        className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] ${row.serif ? 'font-serif' : ''}`}
      >
        {row.label}
      </span>
      {row.badge && (
        <span
          title={row.badge.hint}
          className="text-[8px] tracking-[.05em] uppercase border rounded-[2px] px-[3px] leading-[11px] shrink-0"
          style={{ color: row.badge.color, borderColor: row.badge.color }}
        >
          {row.badge.text}
        </span>
      )}
      {row.count && <span className="font-mono text-[9px] text-ink-ghost shrink-0">{row.count}</span>}
      {row.dot && <Dot color={row.dot.color} title={row.dot.hint} />}
    </button>
  );
}

/**
 * Project sidebar: the open scene's files, then the whole project.
 *
 * Rows navigate — a file opens the mode that edits it, a cast member or set
 * opens its editor. Health pins the toolchain to the bottom where it can be
 * glanced at without being in the way.
 */
export function Sidebar({
  scenes, scene, detail, shots, dialogue, animation, dirty, hasStaleRender,
  cast, sets, health, mode, onScene, onMode, onNewScene, onOpenCast, onOpenSets,
}: {
  scenes: SceneSummary[];
  scene: string | null;
  detail: SceneDetail | null;
  shots: ShotList | null;
  dialogue: DialogueDocument | null;
  animation: AnimationDocument | null;
  dirty: boolean;
  hasStaleRender: boolean;
  cast: CastSummary[];
  sets: SetSummary[];
  health: Health | null;
  mode: Mode;
  onScene: (name: string) => void;
  onMode: (mode: Mode) => void;
  onNewScene: () => void;
  onOpenCast: (name: string | null) => void;
  onOpenSets: (name: string | null) => void;
}) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ scripts: true, cast: true, sets: true });

  const lineCues = dialogue?.cues ?? [];
  const missing = lineCues.filter((cue) => cueApproval(cue) !== 'approved').length;
  const lockedBeats = shots?.beats.filter((b) => b.locked).length ?? 0;
  const lockedSegments = animation?.segments.filter((s) => s.locked).length ?? 0;

  const chips = [
    { label: 'modified', dot: '#c8834a', hint: dirty ? 'Script has unsaved edits' : 'Nothing modified since the last save' },
    { label: 'locked', dot: '#a89050', hint: `${lockedBeats} locked beat${lockedBeats === 1 ? '' : 's'}, ${lockedSegments} locked segment${lockedSegments === 1 ? '' : 's'}` },
    { label: 'missing', dot: '#c8595a', hint: `${missing} of ${lineCues.length} dialogue lines without an approved take` },
  ];

  const match = (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase());

  const openSceneRows: Row[] = useMemo(() => {
    if (!scene) return [];
    const summary = scenes.find((s) => s.name === scene);
    const rows: Row[] = [
      {
        key: 'scene', label: scene, glyph: '▸', pad: 8, h: 24, serif: true,
        fg: '#e6e3dc', mark: '#c8834a', bg: 'rgba(200,131,74,.13)',
        badge: { text: 'open', color: '#c8834a', hint: 'Currently open scene' },
        hint: summary?.directed ? `${summary.beats} beats · directed${summary.hasVideo ? ' · rendered' : ''}` : 'undirected',
      },
      {
        key: 'md', label: `${scene}.md`, glyph: '≡', pad: 22, h: 22,
        dot: dirty ? { color: '#c8834a', hint: 'Modified — unsaved edits' } : undefined,
        hint: 'Fountain source. Saved on a 500 ms debounce.', go: () => onMode('write'),
      },
    ];
    if (shots) {
      rows.push({
        key: 'shotlist', label: 'shotlist.json', glyph: '▤', pad: 22, h: 22,
        hint: 'Readable shot list. Edit it here or by hand.', go: () => onMode('direct'),
      });
      rows.push({
        key: 'dialogue', label: 'dialogue.json', glyph: '▤', pad: 22, h: 22,
        dot: missing ? { color: '#c8595a', hint: `${missing} of ${lineCues.length} lines have no approved take` } : { color: '#6f9b5a', hint: 'All lines approved' },
        hint: 'Immutable takes, trims, approvals, timing.', go: () => onMode('perform'),
      });
      rows.push({
        key: 'animation', label: 'animation.json', glyph: '▤', pad: 22, h: 22,
        dot: lockedSegments ? { color: '#a89050', hint: `${lockedSegments} locked motion segment${lockedSegments === 1 ? '' : 's'}` } : undefined,
        hint: 'Generated + creator-owned motion layers.', go: () => onMode('animate'),
      });
    }
    if (detail?.hasVideo) {
      rows.push({
        key: 'mp4', label: `${scene}.mp4`, glyph: '▶', pad: 22, h: 22, fg: '#6b737d',
        dot: hasStaleRender ? { color: '#5e6874', hint: 'Stale — inputs changed since this render' } : { color: '#6f9b5a', hint: 'Current render' },
        hint: 'Rendered master. Opens in a new tab.',
        go: () => window.open(`/api/scenes/${scene}/video`, '_blank'),
      });
    }
    return rows;
  }, [scene, scenes, shots, detail, dirty, missing, lineCues.length, lockedSegments, hasStaleRender, onMode]);

  const projectRows: Row[] = useMemo(() => {
    const rows: Row[] = [];
    const section = (key: string, label: string, count: number, glyphOpen = '▾', glyphClosed = '▸') => {
      rows.push({
        key, label, glyph: open[key] ? glyphOpen : glyphClosed, pad: 8, h: 23, fg: '#9aa1ab',
        count: String(count), hint: label,
        go: () => setOpen((o) => ({ ...o, [key]: !o[key] })),
      });
    };

    section('scripts', 'Scripts', scenes.length);
    if (open['scripts']) {
      for (const s of scenes.filter((s) => match(s.name))) {
        rows.push({
          key: `s:${s.name}`, label: `${s.name}.md`, glyph: '≡', pad: 22, h: 21,
          fg: s.name === scene ? '#e6e3dc' : '#6b737d',
          dot: s.hasVideo ? { color: '#6f9b5a', hint: 'Rendered' } : undefined,
          hint: s.directed ? `${s.beats} beats · directed` : 'undirected',
          go: () => onScene(s.name),
        });
      }
      rows.push({
        key: 'new', label: '+ new scene', glyph: '', pad: 22, h: 21, fg: '#6b737d',
        hint: 'Create a scene from the starter script', go: onNewScene,
      });
    }

    section('cast', 'Cast', cast.length);
    if (open['cast']) {
      for (const member of cast.filter((c) => match(c.name))) {
        rows.push({
          key: `c:${member.name}`, label: member.name, glyph: '◍', pad: 22, h: 21,
          dot: member.voiceRef
            ? { color: '#6f9b5a', hint: 'Rig valid · voice reference bound' }
            : { color: '#c8595a', hint: 'Missing voice reference — conversion is blocked' },
          hint: 'Open the cast editor', go: () => onOpenCast(member.name),
        });
      }
    }

    section('sets', 'Sets', sets.length);
    if (open['sets']) {
      for (const s of sets.filter((s) => match(s.name))) {
        const inUse = shots?.set ? shots.set.replace(/\.(json|svg)$/, '') === s.name : false;
        rows.push({
          key: `set:${s.name}`, label: s.name, glyph: '▦', pad: 22, h: 21,
          fg: inUse ? '#e6e3dc' : '#6b737d',
          dot: inUse ? { color: '#c8834a', hint: 'In use by this scene' } : undefined,
          hint: `${s.propCount} props · palette ${s.palette}`, go: () => onOpenSets(s.name),
        });
      }
    }

    return rows;
  }, [scenes, cast, sets, open, scene, shots, filter, onScene, onNewScene, onOpenCast, onOpenSets]);

  const healthRows = health
    ? [
        { label: 'ffmpeg', ok: !!health.ffmpeg, hint: health.ffmpeg ? `ffmpeg ${health.ffmpeg}` : 'ffmpeg missing' },
        { label: 'rhubarb', ok: !!health.rhubarb, hint: health.rhubarb ? `Rhubarb ${health.rhubarb} — waveform-derived mouth cues` : 'rhubarb missing' },
        ...Object.entries(health.engines).map(([name, s]) => ({
          label: name, ok: s.ok, checking: s.checking,
          hint: s.checking ? 'probing…' : s.ok ? `${name} ready` : s.reason?.split('\n')[0] ?? 'unavailable',
        })),
        { label: 'llm', ok: health.llm.ok, hint: health.llm.ok ? `${health.llm.recommended ?? 'ready'}` : health.llm.reason ?? 'unavailable' },
      ]
    : [];

  return (
    <div className="w-56 shrink-0 flex flex-col bg-[#22262c] border-r border-edge min-h-0">
      <div className="h-[30px] shrink-0 flex items-center gap-1.5 px-2 border-b border-[#2f353d]">
        <span className="text-ink-faint text-[11px]">⌕</span>
        <input
          type="text"
          placeholder="Filter project…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 h-5 bg-transparent border-0 outline-none text-ink text-[11px] placeholder:text-ink-ghost"
        />
      </div>

      <div className="h-[26px] shrink-0 flex items-center gap-1 px-2 border-b border-[#2f353d] overflow-hidden">
        {chips.map((chip) => (
          <span
            key={chip.label}
            title={chip.hint}
            className="h-4 px-1.5 rounded-lg border border-edge text-ink-faint text-[9px] tracking-[.04em] inline-flex items-center gap-1"
          >
            <span className="w-[5px] h-[5px] rounded-full" style={{ background: chip.dot }} />
            {chip.label}
          </span>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1.5 pb-2.5">
        <SectionRule label="Open scene" />
        {openSceneRows.map((row) => <TreeRow key={row.key} row={row} />)}

        <div className="pt-2">
          <SectionRule label="Project" />
        </div>
        {projectRows.map((row) => <TreeRow key={row.key} row={row} />)}
      </div>

      <div className="h-[26px] shrink-0 flex items-center gap-2 px-2 border-t border-[#2f353d] bg-stage overflow-hidden">
        {healthRows.length ? healthRows.map((row) => (
          <span key={row.label} title={row.hint} className="inline-flex items-center gap-1 text-[9px] text-ink-faint whitespace-nowrap">
            <Dot color={'checking' in row && row.checking ? '#6b737d' : row.ok ? '#6f9b5a' : '#c8595a'} pulse={'checking' in row && !!row.checking} />
            {row.label}
          </span>
        )) : <span className="text-[9px] text-ink-faint">checking toolchain…</span>}
      </div>
    </div>
  );
}
