import { useMemo, useRef, useState } from 'react';
import type { AnimationDocument, Beat, DialogueDocument, ShotList } from '../types.ts';
import { Mono } from './chrome.tsx';
import { cueApproval, estimateBeatMs, motionDeletionBlocker, resolveAnchor, speakerColour } from './lib.ts';

interface Clip {
  key: string;
  leftPct: number;
  widthPct: number;
  top: number;
  bg: string;
  border: string;
  fg: string;
  label: string;
  sub?: string;
  icon?: string;
  iconFg?: string;
  stripe?: boolean;
  shadow?: string;
  selected?: boolean;
  weight?: number;
  fontSize?: number;
  hint: string;
  onClick?: () => void;
}

interface Key {
  key: string;
  leftPct: number;
  bg: string;
  hint: string;
}

interface Lane {
  id: string;
  h: number;
  bg?: string;
  clips: Clip[];
  keys: Key[];
}

const TRACKS: Array<{ id: string; label: string; color: string; h: number; bar: number; fs: number; weight: number; strong?: boolean }> = [
  { id: 'beats', label: 'Script beats', color: '#c8834a', h: 36, bar: 19, fs: 10, weight: 600, strong: true },
  { id: 'dialogue', label: 'Dialogue', color: '#6f9b5a', h: 28, bar: 15, fs: 9, weight: 500 },
  { id: 'motion', label: 'Character motion', color: '#73a6c7', h: 24, bar: 12, fs: 9, weight: 400 },
  { id: 'camera', label: 'Camera', color: '#b06a8f', h: 20, bar: 10, fs: 9, weight: 400 },
  { id: 'expr', label: 'Expressions', color: '#8f7fb0', h: 18, bar: 9, fs: 9, weight: 400 },
  { id: 'gest', label: 'Gestures', color: '#8f7fb0', h: 18, bar: 9, fs: 9, weight: 400 },
  { id: 'props', label: 'Props', color: '#a89050', h: 18, bar: 9, fs: 9, weight: 400 },
  { id: 'sfx', label: 'Foley / SFX', color: '#5e8f8a', h: 20, bar: 10, fs: 9, weight: 400 },
  { id: 'caption', label: 'Captions', color: '#5e6874', h: 18, bar: 9, fs: 9, weight: 400 },
];

const STRIPE = 'repeating-linear-gradient(135deg,rgba(255,255,255,.09) 0 3px,transparent 3px 7px)';

/**
 * The timeline. Script beats sit on top in weight, height and contrast —
 * they are the layer you edit most; everything below is derived from or
 * attached to them.
 */
export function Timeline({
  shots, dialogue, animation, beatStarts, totalMs, playheadMs, selected, snap,
  selectedMotionId, motionBusy, onToggleSnap, onSelect, onScrub, onSelectVoice, onSelectMotion, onDeleteMotion,
}: {
  shots: ShotList | null;
  dialogue: DialogueDocument | null;
  animation: AnimationDocument | null;
  beatStarts: number[];
  totalMs: number;
  playheadMs: number;
  selected: number | null;
  selectedMotionId: string | null;
  motionBusy: boolean;
  snap: boolean;
  onToggleSnap: () => void;
  onSelect: (index: number) => void;
  onScrub: (ms: number) => void;
  onSelectVoice: (index: number) => void;
  onSelectMotion: (segmentId: string) => void;
  onDeleteMotion: (segmentId: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);

  const beats = shots?.beats ?? [];
  const castIds = shots?.cast.map((c) => c.id) ?? [];
  const total = Math.max(1, totalMs);

  const pos = (i: number) => {
    const start = beatStarts[i] ?? 0;
    const end = i + 1 < beatStarts.length ? beatStarts[i + 1]! : total;
    return { leftPct: (start / total) * 100, widthPct: Math.max(0.4, ((end - start) / total) * 100) };
  };

  const durationOf = (i: number) => {
    const start = beatStarts[i] ?? 0;
    const end = i + 1 < beatStarts.length ? beatStarts[i + 1]! : total;
    return Math.max(0, end - start) || estimateBeatMs(beats[i]!);
  };

  const lanes: Lane[] = useMemo(() => {
    if (!beats.length) return [];

    const beatClips: Clip[] = beats.map((beat, i) => {
      const p = pos(i);
      const on = selected === i;
      const colour = beat.kind === 'line' ? speakerColour(castIds, beat.speaker) : beat.kind === 'pause' ? '#3d444d' : '#4d5560';
      const unsupported = beat.kind === 'action' && (beat.unsupported?.length ?? 0) > 0;
      return {
        key: beat.id,
        ...p,
        top: 2,
        bg: colour,
        border: on ? '#e6e3dc' : 'rgba(0,0,0,.35)',
        shadow: on ? '0 0 0 1px #e6e3dc' : beat.locked ? '0 0 0 1px #a89050' : undefined,
        fg: beat.kind === 'pause' ? 'rgba(230,227,220,.8)' : 'rgba(30,33,38,.92)',
        weight: 600,
        fontSize: 9,
        icon: beat.locked ? '🔒' : unsupported ? '!' : beat.kind === 'pause' ? '⏸' : undefined,
        iconFg: beat.kind === 'pause' ? 'rgba(230,227,220,.8)' : '#1e2126',
        label: beat.kind === 'line' ? beat.speaker : beat.kind === 'pause' ? `${beat.ms}ms` : 'action',
        sub: beat.shot,
        hint: `beat ${i} · ${beat.kind} · ${beat.shot} · ${beat.camera}\n${beat.kind === 'pause' ? `${beat.ms} ms` : beat.text}${beat.locked ? '\nlocked' : ''}${unsupported ? '\nunsupported physical business' : ''}`,
        onClick: () => onSelect(i),
      };
    });

    const dialogueClips: Clip[] = beats.flatMap((beat, i) => {
      if (beat.kind !== 'line') return [];
      const cue = dialogue?.cues.find((c) => c.id === beat.id);
      const state = cueApproval(cue);
      const tone = state === 'approved' ? '#6f9b5a' : state === 'generated' ? '#7a8fc0' : state === 'candidate' ? '#c8834a' : '#c8595a';
      const p = pos(i);
      return [{
        key: `d-${beat.id}`,
        ...p,
        top: 3,
        bg: state === 'missing' ? 'rgba(200,89,90,.10)' : `${tone}22`,
        border: state === 'missing' ? 'rgba(200,89,90,.5)' : `${tone}99`,
        stripe: state === 'missing' || state === 'generated',
        icon: state === 'approved' ? '✓' : state === 'generated' ? '◇' : state === 'missing' ? '○' : '◔',
        iconFg: tone,
        fg: state === 'missing' ? '#8c6f72' : state === 'generated' ? '#a8b6d4' : '#9aa1ab',
        fontSize: 9,
        label: beat.text,
        hint: `${beat.speaker} — “${beat.text}”\n${
          state === 'approved' ? 'approved take, locked to picture'
          : state === 'generated' ? 'generated character voice, approved'
          : state === 'candidate' ? 'candidate take, not approved'
          : 'undecided — no take recorded'}`,
        onClick: () => onSelectVoice(i),
      }];
    });

    const layerOwnership = new Map((animation?.layers ?? []).map((l) => [l.id, l.ownership]));
    const anchorMs = (anchor: Parameters<typeof resolveAnchor>[0]) =>
      resolveAnchor(anchor, beats, beatStarts, durationOf);

    const motionClips: Clip[] = (animation?.segments ?? []).map((segment) => {
      const from = anchorMs(segment.from.time);
      const to = anchorMs(segment.to.time);
      const creator = layerOwnership.get(segment.layerId) !== 'generated';
      const label = `${segment.actorId} · ${segment.channel === 'part.transform' ? segment.partId : 'root'}`;
      const isSelected = selectedMotionId === segment.id;
      return {
        key: segment.id,
        leftPct: (from / total) * 100,
        widthPct: Math.max(0.4, ((to - from) / total) * 100),
        top: 3,
        bg: creator ? 'rgba(200,131,74,.20)' : 'rgba(122,143,192,.16)',
        border: isSelected ? '#e6e3dc' : creator ? 'rgba(200,131,74,.65)' : 'rgba(122,143,192,.5)',
        shadow: isSelected ? '0 0 0 1px #e6e3dc' : undefined,
        selected: isSelected,
        stripe: !creator,
        icon: segment.locked ? '🔒' : undefined,
        iconFg: '#a89050',
        fg: creator ? '#e0b58a' : '#a8b6d4',
        fontSize: 9,
        label,
        hint: `${label}\n${creator ? 'creator-authored — survives regeneration' : 'generated — editable, replaced on rerun'}${segment.locked ? '\nlocked' : ''}`,
        onClick: () => onSelectMotion(segment.id),
      };
    });

    const motionKeys: Key[] = (animation?.segments ?? []).flatMap((segment) => [
      { key: `${segment.id}-a`, leftPct: (anchorMs(segment.from.time) / total) * 100, bg: segment.from.locked ? '#a89050' : '#c8834a', hint: 'Key · segment start' },
      { key: `${segment.id}-b`, leftPct: (anchorMs(segment.to.time) / total) * 100, bg: segment.to.locked ? '#a89050' : '#c8834a', hint: 'Key · segment end' },
    ]);

    const simple = (
      entries: Array<{ i: number; label: string; hint?: string }>,
      colour: string,
      fg: string,
      go?: (i: number) => void,
    ): Clip[] => entries.map(({ i, label, hint }, n) => ({
      key: `${label}-${i}-${n}`,
      ...pos(i),
      top: 3,
      bg: `${colour}1f`,
      border: `${colour}66`,
      fg,
      fontSize: 8,
      label,
      hint: hint ?? label,
      onClick: () => (go ?? onSelect)(i),
    }));

    const cameraClips = simple(
      beats.map((b, i) => ({ b, i })).filter(({ b }) => b.camera !== 'HOLD').map(({ b, i }) => ({ i, label: b.camera })),
      '#b06a8f', '#c99bb4',
    );
    const exprClips = simple(
      beats.map((b, i) => ({ b, i }))
        .filter(({ b }) => b.kind === 'line' && b.expression && b.expression !== 'NEUTRAL')
        .map(({ b, i }) => ({ i, label: (b as Beat & { kind: 'line' }).expression })),
      '#8f7fb0', '#b3a6cc',
    );
    const gestClips = simple(
      beats.map((b, i) => ({ b, i }))
        .filter(({ b }) => b.kind === 'line' && b.gesture && b.gesture !== 'NONE')
        .map(({ b, i }) => ({ i, label: (b as Beat & { kind: 'line' }).gesture })),
      '#8f7fb0', '#b3a6cc',
    );

    const propEntries: Array<{ i: number; label: string; hint?: string }> = [];
    const sfxEntries: Array<{ i: number; label: string; hint?: string }> = [];
    beats.forEach((beat, i) => {
      if (beat.kind !== 'action' || !beat.stage) return;
      for (const action of beat.stage) {
        if (action.type === 'tap') {
          propEntries.push({ i, label: `${action.prop ?? action.target ?? 'surface'} · tap${action.count ? ` ×${action.count}` : ''}` });
          sfxEntries.push({ i, label: `taps`, hint: 'Deterministic Foley — regenerates identically from the same seed' });
        }
        if (action.type === 'pick_up' || action.type === 'put_down') {
          propEntries.push({ i, label: `${action.prop ?? 'prop'} · ${action.type.replace('_', ' ')}` });
        }
        if (action.type === 'enter' || action.type === 'exit' || action.type === 'move') {
          sfxEntries.push({ i, label: 'footsteps', hint: 'Deterministic Foley — regenerates identically from the same seed' });
        }
      }
    });
    const heldProps: Clip[] = (shots?.cast ?? [])
      .filter((member) => member.heldProp)
      .map((member) => ({
        key: `held-${member.id}`,
        leftPct: 0,
        widthPct: 100,
        top: 3,
        bg: 'rgba(168,144,80,.12)',
        border: 'rgba(168,144,80,.4)',
        fg: '#cbb87e',
        fontSize: 8,
        label: `${member.heldProp} held by ${member.id}`,
        hint: `${member.heldProp} · held ${member.heldHand ?? ''}`.trim(),
      }));

    const captionClips = simple(
      beats.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'line').map(({ i }) => ({ i, label: 'CC' })),
      '#5e6874', '#8b939d',
    );

    return [
      { id: 'beats', h: 36, bg: '#242931', clips: beatClips, keys: [] },
      { id: 'dialogue', h: 28, clips: dialogueClips, keys: [] },
      { id: 'motion', h: 24, clips: motionClips, keys: motionKeys },
      { id: 'camera', h: 20, clips: cameraClips, keys: [] },
      { id: 'expr', h: 18, clips: exprClips, keys: [] },
      { id: 'gest', h: 18, clips: gestClips, keys: [] },
      { id: 'props', h: 18, clips: [...heldProps, ...simple(propEntries, '#a89050', '#cbb87e')], keys: [] },
      { id: 'sfx', h: 20, clips: simple(sfxEntries, '#5e8f8a', '#8fc0ba'), keys: [] },
      { id: 'caption', h: 18, clips: captionClips, keys: [] },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beats, castIds.join('|'), dialogue, animation, beatStarts, total, selected, selectedMotionId]);

  /** Entrances and the button beat, derived straight from the shot list. */
  const markers = useMemo(() => {
    const out: Array<{ leftPct: number; label: string; hint: string }> = [];
    beats.forEach((beat, i) => {
      if (beat.kind === 'action' && beat.stage) {
        for (const action of beat.stage) {
          if (action.type === 'enter') {
            out.push({
              leftPct: ((beatStarts[i] ?? 0) / total) * 100,
              label: `${action.actor.toUpperCase()} IN`,
              hint: 'Marker · character entrance',
            });
          }
        }
      }
      if (beat.purpose === 'button') {
        out.push({ leftPct: ((beatStarts[i] ?? 0) / total) * 100, label: 'BUTTON', hint: 'Marker · final joke lands here' });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beats, beatStarts, total]);

  const ticks = useMemo(() => {
    const stepMs = total > 120_000 ? 10_000 : 5_000;
    const n = Math.floor(total / stepMs) + 1;
    return Array.from({ length: n }, (_, i) => ({
      leftPct: ((i * stepMs) / total) * 100,
      label: `${String(Math.floor((i * stepMs) / 60000)).padStart(2, '0')}:${String(Math.floor(((i * stepMs) % 60000) / 1000)).padStart(2, '0')}`,
      strong: i % 2 === 0,
    }));
  }, [total]);

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const move = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onScrub(pct * total);
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const playPct = Math.min(100, (playheadMs / total) * 100);
  const selectedMotion = selectedMotionId
    ? animation?.segments.find((segment) => segment.id === selectedMotionId) ?? null
    : null;
  const deleteBlocker = selectedMotion && animation
    ? motionDeletionBlocker(animation, selectedMotion.id)
    : null;

  return (
    <div className="h-[264px] shrink-0 flex flex-col bg-[#22262c] border-t border-edge">
      {/* toolbar */}
      <div className="h-[26px] shrink-0 flex items-center gap-1.5 px-2 border-b border-[#2f353d]">
        <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">Timeline</span>
        <div className="w-px h-[13px] bg-edge" />
        <ToolChip label="Snap" on={snap} hint="Snap clips to beat boundaries, speech onsets and frames" onClick={onToggleSnap} />
        <ToolChip label="Ripple" hint="Downstream animation follows retimed dialogue — set per line via Follow Performance" />
        <ToolChip label="Waveform" on hint="Dialogue waveforms are drawn in the Perform strip" />
        {selectedMotion && (
          <button
            type="button"
            disabled={motionBusy || Boolean(deleteBlocker)}
            title={deleteBlocker ?? `Delete ${selectedMotion.actorId} motion · Delete/Backspace`}
            onClick={() => onDeleteMotion(selectedMotion.id)}
            className="h-[19px] px-[7px] rounded-[3px] border border-bad/55 bg-bad/10 text-bad text-[10px] cursor-pointer hover:bg-bad/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Delete motion
          </button>
        )}
        <div className="flex-1" />
        <Mono className="text-ink-faint">{zoom.toFixed(1)}×</Mono>
        <input
          type="range"
          min={1}
          max={8}
          step={0.5}
          value={zoom}
          title="Timeline zoom"
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-[88px] h-3.5 accent-accent cursor-pointer"
        />
        <button
          type="button"
          title="Fit scene to width"
          onClick={() => {
            setZoom(1);
            scroller.current?.scrollTo({ left: 0 });
          }}
          className="h-[19px] px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:text-ink"
        >
          Fit
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* track heads */}
        <div className="w-[154px] shrink-0 border-r border-edge bg-[#1f2329] overflow-hidden flex flex-col">
          <div className="h-5 shrink-0 border-b border-[#2f353d] flex items-center px-2 text-[9px] tracking-[.09em] uppercase text-ink-ghost">
            tracks
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {TRACKS.map((track) => (
              <div
                key={track.id}
                title={`${track.label} track`}
                className="flex items-center gap-1.5 px-[7px] border-b border-[#2a2f36]"
                style={{ height: track.h, background: track.strong ? '#252a31' : 'transparent' }}
              >
                <span className="w-[3px] rounded-px shrink-0" style={{ height: track.bar, background: track.color }} />
                <span
                  className="flex-1 tracking-[.05em] uppercase overflow-hidden text-ellipsis whitespace-nowrap"
                  style={{ fontSize: track.fs, fontWeight: track.weight, color: track.strong ? '#e6e3dc' : '#9aa1ab' }}
                >
                  {track.label}
                </span>
                <button
                  type="button"
                  title={locks[track.id] ? `${track.label} is locked — unlock to edit` : `Lock ${track.label}`}
                  onClick={() => setLocks((l) => ({ ...l, [track.id]: !l[track.id] }))}
                  className="w-[15px] h-[15px] rounded-[2px] text-[9px] cursor-pointer hover:bg-panel-2 shrink-0"
                  style={{ color: locks[track.id] ? '#a89050' : '#454d57' }}
                >
                  {locks[track.id] ? '🔒' : '⌾'}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* lanes */}
        <div ref={scroller} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden relative">
          <div className="relative flex flex-col min-h-full" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
            {/* ruler */}
            <div onPointerDown={scrub} title="Drag to scrub" className="h-5 shrink-0 border-b border-[#2f353d] bg-[#1f2329] relative cursor-ew-resize overflow-hidden">
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 pl-1 flex items-center border-l"
                  style={{ left: `${tick.leftPct}%`, borderColor: tick.strong ? '#3a414a' : '#2a2f36' }}
                >
                  <span className="font-mono text-[9px]" style={{ color: tick.strong ? '#6b737d' : '#454d57' }}>{tick.label}</span>
                </div>
              ))}
              {markers.map((marker, i) => (
                <div
                  key={i}
                  title={marker.hint}
                  className="absolute top-[3px] h-3.5 px-1 rounded-[2px] bg-lock text-stage text-[8px] tracking-[.05em] flex items-center"
                  style={{ left: `${marker.leftPct}%` }}
                >
                  {marker.label}
                </div>
              ))}
            </div>

            {/* lanes body */}
            <div onPointerDown={scrub} className="flex-1 min-h-0 relative">
              {lanes.map((lane) => (
                <div
                  key={lane.id}
                  className="border-b border-[#2a2f36] relative"
                  style={{ height: lane.h, background: lane.bg ?? 'transparent', opacity: locks[lane.id] ? 0.55 : 1 }}
                >
                  {lane.clips.map((clip) => (
                    <div
                      key={clip.key}
                      title={clip.hint}
                      onPointerDown={(e) => {
                        if (locks[lane.id]) return;
                        e.stopPropagation();
                        clip.onClick?.();
                      }}
                      className="absolute rounded-[2px] overflow-hidden cursor-pointer flex items-center gap-[3px] px-[3px] border"
                      style={{
                        top: clip.top,
                        bottom: clip.top,
                        left: `${clip.leftPct}%`,
                        width: `${clip.widthPct}%`,
                        background: clip.bg,
                        borderColor: clip.border,
                        boxShadow: clip.shadow,
                      }}
                    >
                      {clip.stripe && <span className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: STRIPE }} />}
                      {clip.icon && <span className="text-[8px] shrink-0 relative" style={{ color: clip.iconFg }}>{clip.icon}</span>}
                      <span
                        className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap relative leading-[1.25]"
                        style={{ fontSize: clip.fontSize ?? 9, color: clip.fg, fontWeight: clip.weight ?? 400 }}
                      >
                        {clip.label}
                      </span>
                      {clip.sub && <span className="font-mono text-[8px] shrink-0 relative" style={{ color: 'rgba(30,33,38,.6)' }}>{clip.sub}</span>}
                    </div>
                  ))}
                  {lane.keys.map((key) => (
                    <div
                      key={key.key}
                      title={key.hint}
                      className="absolute top-1/2 w-[7px] h-[7px] -mt-[3.5px] -ml-[3.5px] rotate-45 cursor-pointer border border-stage"
                      style={{ left: `${key.leftPct}%`, background: key.bg }}
                    />
                  ))}
                </div>
              ))}
              {!lanes.length && (
                <div className="absolute inset-0 grid place-items-center text-[11px] text-ink-ghost">
                  No shot list yet — Direct the script to stage it.
                </div>
              )}
              <div className="absolute top-0 bottom-0 w-px bg-ink pointer-events-none z-[5]" style={{ left: `${playPct}%` }} />
            </div>

            {/* playhead needle */}
            <div className="absolute top-0 bottom-0 pointer-events-none z-[6]" style={{ left: `${playPct}%` }}>
              <div className="w-[9px] h-[9px] -ml-1 bg-ink" style={{ clipPath: 'polygon(0 0,100% 0,50% 100%)' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolChip({ label, hint, on, onClick }: { label: string; hint: string; on?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={hint}
      onClick={onClick}
      className={`h-[19px] px-[7px] rounded-[3px] border text-[10px] cursor-pointer inline-flex items-center gap-1 ${
        on ? 'bg-accent/15 border-accent/50 text-accent' : 'bg-panel-2 border-edge text-ink-dim hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}
