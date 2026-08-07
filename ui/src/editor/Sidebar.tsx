import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import type { AnimationDocument, CastSummary, DialogueDocument, Health, PropDefInfo, SceneDetail, SceneSummary, SetSummary, ShotList } from '../types.ts';
import { Dot, SectionRule } from './chrome.tsx';
import type { MenuTarget, OpenMenu } from './ContextMenu.tsx';
import { cueUndecided, sceneCues, type Mode } from './lib.ts';

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
  /** A verb the row carries in its own right — "use this set in the scene". */
  action?: { label: string; hint: string; go: () => void };
  /** What a right-click on this row is about. */
  menu?: MenuTarget;
}

/**
 * One tree row, and — where the row can be *applied* rather than only opened —
 * its own verb.
 *
 * A set row used to paint an "in use by this scene" dot and then offer no way
 * to change which one that was, which is a large part of why the set felt
 * unchangeable. The action sits on the row itself so the answer is where the
 * question is; it cannot nest inside the row button, hence the wrapper.
 */
function TreeRow({ row, onContextMenu }: { row: Row; onContextMenu: OpenMenu }) {
  const menu = row.menu ? (e: MouseEvent<HTMLElement>) => onContextMenu(e, row.menu!) : undefined;
  return (
    <div
      className="w-full flex items-center hover:bg-panel-2"
      onContextMenu={menu}
      style={{
        height: row.h,
        background: row.bg ?? 'transparent',
        borderLeft: `2px solid ${row.mark ?? 'transparent'}`,
      }}
    >
      <button
        type="button"
        title={row.hint}
        onClick={row.go}
        className="flex-1 min-w-0 h-full flex items-center gap-1.5 pr-1.5 border-0 bg-transparent text-left cursor-pointer"
        style={{ paddingLeft: row.pad, color: row.fg ?? '#9aa1ab' }}
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
      {row.action && (
        <button
          type="button"
          title={row.action.hint}
          onClick={row.action.go}
          className="shrink-0 mr-1.5 h-[15px] px-[5px] rounded-[2px] border border-edge bg-panel-2 text-[9px] tracking-[.05em] uppercase text-ink-ghost cursor-pointer hover:text-accent hover:border-accent/60"
        >
          {row.action.label}
        </button>
      )}
    </div>
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
  scenes, scene, detail, shots, dialogue, animation, dirty, hasStaleRender, staleBeats,
  cast, sets, props, health, mode: _mode, onScene, onMode, onNewScene, onOpenCast, onOpenSets, onUseSet, onOpenProps,
  onOpenSystem, onContextMenu,
}: {
  scenes: SceneSummary[];
  scene: string | null;
  detail: SceneDetail | null;
  shots: ShotList | null;
  dialogue: DialogueDocument | null;
  animation: AnimationDocument | null;
  dirty: boolean;
  hasStaleRender: boolean;
  /** Beats by which the script has outrun the shot list; 0 when in sync. */
  staleBeats: number;
  cast: CastSummary[];
  props: PropDefInfo[];
  sets: SetSummary[];
  health: Health | null;
  mode: Mode;
  onScene: (name: string) => void;
  onMode: (mode: Mode) => void;
  onNewScene: () => void;
  onOpenCast: (name: string | null) => void;
  onOpenSets: (name: string | null) => void;
  /** Stage the open scene in this set, repairs and all. */
  onUseSet: (name: string) => void;
  onOpenProps: (key: string | null) => void;
  /** The health strip opens the full System report — doctor, in the place people already look. */
  onOpenSystem: () => void;
  onContextMenu: OpenMenu;
}) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ scripts: true, cast: true, sets: true });

  const lineCues = sceneCues(dialogue, shots);
  const missing = lineCues.filter((cue) => cueUndecided(cue)).length;
  const lockedBeats = shots?.beats.filter((b) => b.locked).length ?? 0;
  const lockedSegments = animation?.segments.filter((s) => s.locked).length ?? 0;

  const chips = [
    { label: 'modified', dot: '#c8834a', hint: dirty ? 'Script has unsaved edits' : 'Nothing modified since the last save' },
    { label: 'locked', dot: '#a89050', hint: `${lockedBeats} locked beat${lockedBeats === 1 ? '' : 's'}, ${lockedSegments} locked segment${lockedSegments === 1 ? '' : 's'}` },
    { label: 'missing', dot: '#c8595a', hint: `${missing} of ${lineCues.length} dialogue lines still undecided (no approved take or generated-voice choice)` },
  ];

  const match = useCallback(
    (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase()),
    [filter],
  );

  const openSceneRows: Row[] = useMemo(() => {
    if (!scene) return [];
    const summary = scenes.find((s) => s.name === scene);
    const rows: Row[] = [
      {
        key: 'scene', label: scene, glyph: '▸', pad: 8, h: 24, serif: true,
        fg: '#e6e3dc', mark: '#c8834a', bg: 'rgba(200,131,74,.13)',
        badge: { text: 'open', color: '#c8834a', hint: 'Currently open scene' },
        hint: summary?.directed
          ? `${summary.beats} beats · directed${summary.hasVideo ? ' · rendered' : ''}${staleBeats ? ' · the script has moved ahead' : ''}`
          : 'undirected',
        menu: { kind: 'scene', name: scene },
      },
      {
        key: 'md', label: `${scene}.md`, glyph: '≡', pad: 22, h: 22,
        dot: dirty ? { color: '#c8834a', hint: 'Modified — unsaved edits' } : undefined,
        hint: 'Fountain source. Saved on a 500 ms debounce.', go: () => onMode('write'),
        menu: { kind: 'sceneFile', file: 'script' },
      },
    ];
    if (shots) {
      // Everything in this group is derived from the shot list, so when the
      // script has outrun it they are all describing the previous scene.
      const behind = staleBeats
        ? { color: '#c8834a', hint: `Out of date — the script has moved ${staleBeats} beat${staleBeats === 1 ? '' : 's'} ahead of the last Direct` }
        : undefined;
      rows.push({
        key: 'shotlist', label: 'shotlist.json', glyph: '▤', pad: 22, h: 22,
        dot: behind,
        hint: staleBeats
          ? 'Readable shot list — behind the script. Apply direction to catch it up.'
          : 'Readable shot list. Edit it here or by hand.',
        go: () => onMode('direct'),
        menu: { kind: 'sceneFile', file: 'shotlist' },
      });
      rows.push({
        key: 'dialogue', label: 'dialogue.json', glyph: '▤', pad: 22, h: 22,
        dot: behind ?? (missing ? { color: '#c8595a', hint: `${missing} of ${lineCues.length} lines undecided` } : { color: '#6f9b5a', hint: 'Every line has a decided voice' }),
        hint: 'Immutable takes, trims, approvals, timing.', go: () => onMode('perform'),
        menu: { kind: 'sceneFile', file: 'dialogue' },
      });
      rows.push({
        key: 'animation', label: 'animation.json', glyph: '▤', pad: 22, h: 22,
        dot: behind ?? (lockedSegments ? { color: '#a89050', hint: `${lockedSegments} locked motion segment${lockedSegments === 1 ? '' : 's'}` } : undefined),
        hint: 'Generated + creator-owned motion layers.', go: () => onMode('animate'),
        menu: { kind: 'sceneFile', file: 'animation' },
      });
    }
    if (detail?.hasVideo) {
      rows.push({
        key: 'mp4', label: `${scene}.mp4`, glyph: '▶', pad: 22, h: 22, fg: '#6b737d',
        dot: hasStaleRender ? { color: '#5e6874', hint: 'Stale — inputs changed since this render' } : { color: '#6f9b5a', hint: 'Current render' },
        hint: 'Rendered master. Opens in a new tab.',
        go: () => window.open(`/api/scenes/${scene}/video`, '_blank'),
        menu: { kind: 'sceneFile', file: 'video' },
      });
    }
    return rows;
  }, [scene, scenes, shots, detail, dirty, missing, lineCues.length, lockedSegments, hasStaleRender, staleBeats, onMode]);

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
          menu: { kind: 'scene', name: s.name },
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
          menu: { kind: 'cast', name: member.name },
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
          hint: `${s.propCount} props · palette ${s.palette} — click to edit this set`,
          go: () => onOpenSets(s.name),
          action: inUse || !shots
            ? undefined
            : { label: 'use', hint: `Stage this scene in ${s.name}`, go: () => onUseSet(s.name) },
          menu: { kind: 'set', name: s.name },
        });
      }
    }

    // Props sit beside sets because that is the order you meet them in: you are
    // dressing a room when you discover the catalogue is missing a waste bin.
    section('props', 'Props', props.length);
    if (open['props']) {
      for (const prop of props.filter((prop) => match(prop.key) || match(prop.label))) {
        rows.push({
          key: `prop:${prop.key}`, label: prop.label, glyph: '◆', pad: 22, h: 21, fg: '#6b737d',
          hint: `${prop.tags.join(' · ')} — open the prop studio`,
          go: () => onOpenProps(prop.key),
          menu: { kind: 'prop', propId: prop.key },
        });
      }
      rows.push({
        key: 'new-prop', label: '+ new prop', glyph: '', pad: 22, h: 21, fg: '#6b737d',
        hint: 'Draw one, describe it to the local model, or bake it',
        go: () => onOpenProps(null),
      });
    }

    return rows;
  }, [scenes, cast, sets, props, open, scene, shots, match, onScene, onNewScene, onOpenCast, onOpenSets, onUseSet, onOpenProps]);

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
        {openSceneRows.map((row) => <TreeRow key={row.key} row={row} onContextMenu={onContextMenu} />)}

        <div className="pt-2">
          <SectionRule label="Project" />
        </div>
        {projectRows.map((row) => <TreeRow key={row.key} row={row} onContextMenu={onContextMenu} />)}
      </div>

      <button
        type="button"
        onClick={onOpenSystem}
        title="Open the full System report — toolchain, engines, model storage, identity profiles and migration."
        className="h-[26px] shrink-0 flex items-center gap-2 px-2 border-0 border-t border-t-[#2f353d] bg-stage overflow-hidden cursor-pointer text-left hover:bg-[#1f2227]"
      >
        {healthRows.length ? healthRows.map((row) => (
          <span key={row.label} title={row.hint} className="inline-flex items-center gap-1 text-[9px] text-ink-faint whitespace-nowrap">
            <Dot color={'checking' in row && row.checking ? '#6b737d' : row.ok ? '#6f9b5a' : '#c8595a'} pulse={'checking' in row && !!row.checking} />
            {row.label}
          </span>
        )) : <span className="text-[9px] text-ink-faint">checking toolchain…</span>}
        <span className="flex-1" />
        <span className="text-[9px] text-ink-ghost">report ▸</span>
      </button>
    </div>
  );
}
