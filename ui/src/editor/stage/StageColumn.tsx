import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Beat, CastMember, PreviewInfo, SetDescriptor, ShotList } from '../../types.ts';
import {
  AnimationOverlay,
  type AnimationEditTarget,
  type AnimationValidArea,
  type StagePropTarget,
} from '../../components/AnimationOverlay.tsx';
import { Mono } from '../chrome.tsx';
import type { OpenMenu } from '../ContextMenu.tsx';
import { MARK_X, captionAt, fmtTimecode, isTyping, type Mode } from '../lib.ts';
import { buildSnapCandidates, listPropTargets } from './interaction.ts';

interface RuntimeWindow extends Window {
  __ready?: boolean;
  __seek?: (frame: number) => number;
}

/**
 * A media failure in creator words.
 *
 * The two codes that matter here both mean the same thing in practice: the
 * audio endpoint refused the request, which it does when the rendered mix no
 * longer belongs to the scene. `SRC_NOT_SUPPORTED` is what a JSON error body
 * looks like to a media element.
 */
function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'The mixed audio is out of date — run Voices to rebuild it. The picture is playing without sound.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'The mixed audio could not be decoded — run Voices to rebuild it.';
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Loading the preview audio was interrupted.';
    default:
      return 'The preview audio could not be loaded. The picture is playing without sound.';
  }
}

export interface StageHandle {
  seekMs(ms: number): void;
  togglePlay(): void;
  pause(): void;
}

export interface OverlayPrefs {
  grid: boolean;
  safe: boolean;
  snap: boolean;
  onion: boolean;
  path: boolean;
  marks: boolean;
  walkable: boolean;
  props: boolean;
  selection: boolean;
  captions: boolean;
}

/**
 * The stage: toolbar, the frame itself with its overlay layers, transport.
 *
 * The iframe loads the same page the renderer captures; playback is a
 * requestAnimationFrame loop calling `__seek`, so the preview cannot show
 * something the render won't produce. Overlays are chrome layered on top —
 * they never touch the frame.
 */
export const StageColumn = forwardRef<StageHandle, {
  mode: Mode;
  preview: PreviewInfo | null;
  audioUrl: string | null;
  shots: ShotList | null;
  beatStarts: number[];
  totalMs: number;
  selected: number | null;
  setDescriptor: SetDescriptor | null;
  prefs: OverlayPrefs;
  onPrefs: (patch: Partial<OverlayPrefs>) => void;
  onPlayhead: (ms: number) => void;
  onSelectBeat: (index: number) => void;
  animationTarget: AnimationEditTarget | null;
  validArea: AnimationValidArea | null;
  onCommitProp: (prop: StagePropTarget, to: [number, number]) => void;
  recording: boolean;
  draftMarked: boolean;
  previewError?: string | null;
  /** Reports a media failure the creator would otherwise experience as silence. */
  onAudioError?: (message: string) => void;
  toolbarExtra?: ReactNode;
  /** Offered inside the blocked-preview panel when the cause is known and fixable. */
  previewRepair?: ReactNode;
  bottomStrip?: ReactNode;
  onContextMenu: OpenMenu;
}>(function StageColumn({
  mode, preview, audioUrl, shots, beatStarts, totalMs, selected, setDescriptor,
  prefs, onPrefs, onPlayhead, onSelectBeat, animationTarget, validArea, onCommitProp,
  recording, draftMarked, previewError, onAudioError, toolbarExtra, previewRepair,
  bottomStrip, onContextMenu,
}, ref) {
  const host = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Held in a ref so a new callback identity cannot restart playback.
  const onAudioErrorRef = useRef(onAudioError);
  onAudioErrorRef.current = onAudioError;
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [frame, setFrame] = useState(0);
  const [fitScale, setFitScale] = useState(0.5);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit
  const frameRef = useRef(0);
  const playheadCb = useRef(onPlayhead);
  playheadCb.current = onPlayhead;

  const fps = preview?.fps ?? 24;
  const frameCount = preview?.frameCount ?? 0;
  const width = preview?.width ?? 1280;
  const height = preview?.height ?? 720;
  const durationMs = totalMs || (frameCount / fps) * 1000;

  const clampFrame = useCallback(
    (f: number) => Math.max(0, Math.min(Math.max(0, frameCount - 1), Math.round(f))),
    [frameCount],
  );

  const apply = useCallback((f: number) => {
    const win = iframeRef.current?.contentWindow as RuntimeWindow | null | undefined;
    if (!win?.__seek) return;
    const next = clampFrame(f);
    try {
      win.__seek(next);
    } catch {
      return; // stale preview id — the next rebuild replaces it
    }
    frameRef.current = next;
    setFrame(next);
    playheadCb.current((next / fps) * 1000);
  }, [clampFrame, fps]);

  // Wait for the runtime to build before seeking at it.
  useEffect(() => {
    setReady(false);
    setPlaying(false);
    if (!preview?.previewId) return;
    let cancelled = false;
    const started = Date.now();
    const poll = () => {
      if (cancelled) return;
      const win = iframeRef.current?.contentWindow as RuntimeWindow | null | undefined;
      if (win?.__ready && win.__seek) {
        setReady(true);
        apply(Math.min(frameRef.current, frameCount - 1));
        return;
      }
      if (Date.now() - started > 15_000) return;
      setTimeout(poll, 60);
    };
    const t = setTimeout(poll, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [preview?.previewId, frameCount, apply]);

  // Wall time drives playback: a slow frame drops rather than stretching.
  useEffect(() => {
    if (!playing || !ready) return;
    const loopBounds = loop && selected !== null && beatStarts[selected] !== undefined
      ? {
          from: Math.round((beatStarts[selected]! / 1000) * fps),
          to: selected + 1 < beatStarts.length
            ? Math.round(((beatStarts[selected + 1] ?? durationMs) / 1000) * fps)
            : frameCount - 1,
        }
      : null;
    const startWall = performance.now();
    const startFrame = loopBounds
      ? (frameRef.current >= loopBounds.to || frameRef.current < loopBounds.from ? loopBounds.from : frameRef.current)
      : frameRef.current >= frameCount - 1 ? 0 : frameRef.current;
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - startWall) / 1000;
      const next = startFrame + elapsed * fps;
      if (loopBounds && next >= loopBounds.to) {
        apply(loopBounds.from);
        setPlaying(false);
        setTimeout(() => setPlaying(true), 0);
        return;
      }
      if (next >= frameCount - 1) {
        apply(frameCount - 1);
        setPlaying(false);
        return;
      }
      apply(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, ready, fps, frameCount, apply, loop, selected, beatStarts, durationMs]);

  // Audio follows the frame clock; the picture is what gets rendered.
  //
  // Failures are reported rather than swallowed. Silence during playback is
  // indistinguishable from a scene with no dialogue, so a discarded rejection
  // here is a bug nobody can see — which is exactly what happened when the
  // audio endpoint began refusing a mix that had gone stale.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (playing) {
      audio.currentTime = frameRef.current / fps;
      void audio.play().catch((err: unknown) => {
        // A blocked autoplay is the browser's policy, not a broken scene, and
        // it clears the moment the creator interacts with the page.
        const message = err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'The browser blocked audio until you interact with the page — press play again.'
          : `Preview audio could not play: ${err instanceof Error ? err.message : String(err)}`;
        onAudioErrorRef.current?.(message);
      });
    } else {
      audio.pause();
    }
  }, [playing, audioUrl, fps]);

  useImperativeHandle(ref, () => ({
    seekMs: (ms) => {
      setPlaying(false);
      apply((ms / 1000) * fps);
    },
    togglePlay: () => setPlaying((p) => !p),
    pause: () => setPlaying(false),
  }), [apply, fps]);

  // Fit-scale measurement, before paint so the frame never flashes wrong.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      setFitScale(Math.min((rect.width - 24) / width, (rect.height - 24) / height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  const scale = zoom ?? fitScale;

  /**
   * The picture is an iframe, so a right-click on it never reaches the app —
   * the parent's suppressor cannot see it, and the *iframe's* own browser menu
   * is what opens. It is same-origin by design (the dev server proxies
   * /preview for exactly this reason), so listen inside it and hand the event
   * back out.
   *
   * Coordinates have to come out too: the frame is scaled from its top left,
   * so an inner point sits at `rect.left + x * scale`.
   */
  useEffect(() => {
    const frameEl = iframeRef.current;
    const doc = frameEl?.contentDocument;
    if (!frameEl || !doc) return;
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      const rect = frameEl.getBoundingClientRect();
      onContextMenu({
        clientX: rect.left + e.clientX * scale,
        clientY: rect.top + e.clientY * scale,
        preventDefault: () => {},
        stopPropagation: () => {},
      }, { kind: 'stage' });
    };
    doc.addEventListener('contextmenu', onMenu);
    return () => doc.removeEventListener('contextmenu', onMenu);
    // `ready` is a dependency because the iframe's document is replaced as the
    // preview loads — the listener has to be reattached to the new one.
  }, [preview?.previewId, ready, scale, onContextMenu]);

  const playMs = (frame / fps) * 1000;
  const activeBeatIndex = beatStarts.length
    ? beatStarts.reduce((acc, start, i) => (playMs >= start ? i : acc), 0)
    : 0;
  const activeBeat: Beat | null = shots?.beats[activeBeatIndex] ?? null;

  /**
   * Scrub the transport. Same shape as the timeline's — preventDefault keeps
   * the drag from selecting the chrome it crosses, and pointer capture keeps a
   * release over the preview iframe from leaving the scrub running.
   */
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    const move = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setPlaying(false);
      apply(pct * (frameCount - 1));
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    try { el.setPointerCapture(pointerId); } catch { /* best effort — window listeners still track */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
  };

  const tools: Array<{ label: string; hint: string; on?: boolean; go?: () => void }> = [
    { label: '−', hint: 'Zoom out', go: () => setZoom((z) => Math.max(0.2, (z ?? fitScale) / 1.25)) },
    { label: 'Fit', hint: 'Fit the frame to the viewport', on: zoom === null, go: () => setZoom(null) },
    { label: '+', hint: 'Zoom in', go: () => setZoom((z) => Math.min(3, (z ?? fitScale) * 1.25)) },
    { label: 'Grid', hint: 'Composition grid — thirds and centre', on: prefs.grid, go: () => onPrefs({ grid: !prefs.grid }) },
    { label: 'Snap', hint: 'Snap body and prop drags to marks, seats and the walkable edges', on: prefs.snap, go: () => onPrefs({ snap: !prefs.snap }) },
    { label: 'Safe areas', hint: 'Title-safe 90% and action-safe 95%', on: prefs.safe, go: () => onPrefs({ safe: !prefs.safe }) },
    { label: 'Onion', hint: 'Ghost the active controller either side of the playhead (count set in the Motion panel)', on: prefs.onion, go: () => onPrefs({ onion: !prefs.onion }) },
  ];

  const [overlayMenu, setOverlayMenu] = useState(false);

  const showSafe = prefs.safe && (mode === 'write' || mode === 'direct' || mode === 'publish');
  const showMarks = prefs.marks && (mode === 'direct' || mode === 'animate');
  const showWalkable = prefs.walkable && mode === 'animate';
  const showSelection = prefs.selection && (mode === 'write' || mode === 'direct' || mode === 'perform');
  const showCaptions = prefs.captions && mode === 'publish';

  const selectedBeat = selected === null ? null : shots?.beats[selected] ?? null;
  const selectionMember: CastMember | null = (() => {
    if (!shots || !selectedBeat) return null;
    const id = selectedBeat.kind === 'line' ? selectedBeat.speaker : selectedBeat.focus[0];
    return shots.cast.find((c) => c.id === id) ?? null;
  })();

  const walk = setDescriptor?.layout.walkable ?? null;
  const captionBeat = showCaptions && activeBeat?.kind === 'line' ? activeBeat : null;
  // A long line ships as several cues in sequence, so show the one that is on
  // screen now rather than the whole line at once.
  const captionText = captionBeat
    ? captionAt(captionBeat.text, (() => {
        const from = beatStarts[activeBeatIndex] ?? 0;
        const to = beatStarts[activeBeatIndex + 1] ?? durationMs;
        return to > from ? (playMs - from) / (to - from) : 0;
      })())
    : '';

  // Draggable set instances, decorated with seat occupancy. Seats are matched
  // by explicit instance id or by prop kind — the same references cast[].seat uses.
  const propTargets = useMemo<StagePropTarget[]>(() => {
    if (!setDescriptor) return [];
    return listPropTargets(setDescriptor).map((target) => ({
      ...target,
      seatedBy: shots?.cast.find((c) => c.seat === target.id || c.seat === target.prop)?.id,
    }));
  }, [setDescriptor, shots]);

  const snapCandidates = useMemo(
    () => buildSnapCandidates(width, setDescriptor, validArea ?? null),
    [width, setDescriptor, validArea],
  );

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* stage toolbar */}
      <div className="h-7 shrink-0 flex items-center gap-1 px-2 bg-stage border-b border-[#2f353d]">
        {toolbarExtra}
        {toolbarExtra && <span className="w-px h-[13px] bg-edge mx-0.5" />}
        {tools.map((tool) => (
          <button
            key={tool.label}
            type="button"
            title={tool.hint}
            onClick={tool.go}
            className={`h-5 px-[7px] rounded-[3px] border text-[10px] cursor-pointer inline-flex items-center gap-1 whitespace-nowrap ${
              tool.on ? 'bg-accent/15 border-accent/50 text-accent' : 'bg-panel-2 border-edge text-ink-dim hover:text-ink'
            }`}
          >
            {tool.label}
          </button>
        ))}
        <div className="relative">
          <button
            type="button"
            title="Choose which overlays are shown: marks, walkable area, prop handles, selection, captions"
            onClick={() => setOverlayMenu((v) => !v)}
            className="h-5 px-[7px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:text-ink"
          >
            Overlays ▾
          </button>
          {overlayMenu && (
            <div className="absolute left-0 top-6 z-30 w-44 bg-panel border border-edge-2 rounded-[4px] shadow-[0_14px_40px_-12px_rgba(0,0,0,.8)] py-1">
              {([
                ['marks', 'Actor marks'],
                ['walkable', 'Walkable area'],
                ['props', 'Prop handles'],
                ['selection', 'Selection outline'],
                ['captions', 'Captions (publish)'],
                ['path', 'Motion path'],
              ] as Array<[keyof OverlayPrefs, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onPrefs({ [key]: !prefs[key] })}
                  className="w-full h-6 px-2.5 flex items-center gap-2 text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink cursor-pointer"
                >
                  <span className="w-3 text-accent">{prefs[key] ? '✓' : ''}</span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1" />
        <Mono title="Shot type for the beat under the playhead" className="text-ink-dim border border-edge rounded-[2px] px-[5px] py-px">
          {activeBeat?.shot ?? '—'}
        </Mono>
        <Mono title="Camera move" className="text-ink-dim border border-edge rounded-[2px] px-[5px] py-px">
          {activeBeat?.camera ?? '—'}
        </Mono>
        <span className="w-px h-[13px] bg-edge mx-0.5" />
        <Mono className="text-ink-faint">{zoom === null ? 'fit' : `${Math.round(scale * 100)}%`}</Mono>
      </div>

      {/* the stage well */}
      <div ref={host} className="flex-1 min-h-0 grid place-items-center bg-well p-3 relative overflow-hidden">
        <div
          className="relative bg-[#0c0d0f]"
          style={{
            width: width * scale,
            height: height * scale,
            boxShadow: '0 0 0 1px #363d46, 0 12px 34px -14px rgba(0,0,0,.8)',
          }}
        >
          {preview?.previewId ? (
            <iframe
              ref={iframeRef}
              key={preview.previewId}
              src={`/preview/${preview.previewId}`}
              title="stage"
              scrolling="no"
              className="border-0 absolute top-0 left-0"
              style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center p-6">
              {shots && previewError ? (
                <div className="max-w-[440px] border border-bad/45 bg-bad/10 rounded-[3px] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[8.5px] tracking-[.07em] uppercase text-bad border border-bad rounded-[2px] px-1">preview blocked</span>
                  </div>
                  {/*
                    A known cause explains itself and offers its own repair; the
                    raw compiler message stays underneath rather than being the
                    only thing on offer.
                  */}
                  {previewRepair ?? (
                    <div className="text-[10px] text-ink-faint leading-[1.5] mt-1.5">
                      Fix the beat in the inspector — unstaged action beats carry a red ! in the shot list.
                    </div>
                  )}
                  <div
                    className={`text-[11px] leading-[1.5] select-text ${previewRepair ? 'mt-2 text-[10px] text-ink-faint' : 'text-[#d6c3c3]'}`}
                  >
                    {previewError}
                  </div>
                </div>
              ) : (
                <span className="text-ink-faint text-[11px]">
                  {shots ? 'building preview…' : 'No shot list yet — Direct the script to stage it.'}
                </span>
              )}
            </div>
          )}

          {/* grid */}
          {prefs.grid && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(230,227,220,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(230,227,220,.07) 1px,transparent 1px)',
                backgroundSize: '5% 8.888%',
              }}
            />
          )}

          {/* safe areas */}
          {showSafe && (
            <>
              <div title="Action safe · 95%" className="absolute inset-[2.5%] border border-dashed border-[rgba(230,227,220,.22)] pointer-events-none" />
              <div title="Title safe · 90%" className="absolute inset-[5%] border border-dashed border-[rgba(230,227,220,.16)] pointer-events-none" />
              <div className="absolute left-[5%] top-[5%] -translate-y-[130%] font-mono text-[9px] text-[rgba(230,227,220,.4)] pointer-events-none">
                TITLE SAFE
              </div>
            </>
          )}

          {/* actor marks */}
          {showMarks && Object.entries(MARK_X).map(([mark, x]) => {
            const occupant = shots?.cast.find((c) => c.mark === mark && c.visible !== false);
            return (
              <div
                key={mark}
                title={occupant ? `${mark} — occupied by ${occupant.id}` : `${mark} — valid destination`}
                className="absolute pointer-events-none flex flex-col items-center gap-[2px]"
                style={{ left: `${x * 100}%`, top: '78.6%', transform: 'translate(-50%,-50%)' }}
              >
                <span
                  className="block rounded-full border-[1.5px]"
                  style={{
                    width: occupant ? 9 : 7,
                    height: occupant ? 9 : 7,
                    borderColor: occupant ? '#c8834a' : 'rgba(230,227,220,.42)',
                    background: occupant ? 'rgba(200,131,74,.35)' : 'transparent',
                  }}
                />
                <span
                  className="font-mono text-[8px] tracking-[.06em]"
                  style={{ color: occupant ? '#c8834a' : 'rgba(230,227,220,.42)', textShadow: '0 1px 2px rgba(0,0,0,.9)' }}
                >
                  {mark}
                </span>
              </div>
            );
          })}

          {/* walkable area */}
          {showWalkable && walk && (
            <>
              <div
                title="Walkable area — actor roots are clamped to it"
                className="absolute border border-[rgba(115,166,199,.5)] bg-[rgba(115,166,199,.07)] pointer-events-none"
                style={{
                  left: `${(walk.x / width) * 100}%`,
                  top: `${(walk.y / height) * 100}%`,
                  width: `${(walk.width / width) * 100}%`,
                  height: `${(walk.height / height) * 100}%`,
                }}
              />
              <div
                className="absolute font-mono text-[8.5px] text-[rgba(115,166,199,.85)] tracking-[.05em] pointer-events-none"
                style={{ left: `${(walk.x / width) * 100}%`, top: `${(walk.y / height) * 100}%`, transform: 'translateY(-125%)' }}
              >
                WALKABLE
              </div>
            </>
          )}

          {/* selection outline */}
          {showSelection && selectionMember && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: `${(MARK_X[selectionMember.mark] ?? 0.5) * 100 - 10.2}%`,
                top: '8.4%',
                width: '20.5%',
                height: '71%',
              }}
            >
              <div className="absolute inset-0 border border-[rgba(0,0,0,.85)]" />
              <div className="absolute inset-px border border-accent" />
              {(['-3px_-3px_auto_auto', 'auto_-3px_-3px_auto', '-3px_auto_auto_-3px', 'auto_auto_-3px_-3px'] as const).map((pos, i) => {
                const [top, right, bottom, left] = pos.split('_');
                return (
                  <span
                    key={i}
                    className="absolute w-1.5 h-1.5 bg-accent"
                    style={{
                      top: top === 'auto' ? undefined : top,
                      right: right === 'auto' ? undefined : right,
                      bottom: bottom === 'auto' ? undefined : bottom,
                      left: left === 'auto' ? undefined : left,
                      boxShadow: '0 0 0 1px rgba(0,0,0,.8)',
                    }}
                  />
                );
              })}
              <span className="absolute left-0 -top-[17px] flex items-center gap-[5px] px-[5px] py-px bg-accent text-stage text-[9px] tracking-[.04em] whitespace-nowrap">
                {selectionMember.id} · {selectionMember.mark}
              </span>
            </div>
          )}

          {/* captions */}
          {captionBeat && (
            <div className="absolute left-[10%] right-[10%] bottom-[9%] flex justify-center pointer-events-none">
              <span className="bg-[rgba(12,13,15,.86)] text-ink text-[13px] leading-[1.35] px-2.5 py-1 text-center [text-wrap:balance] whitespace-pre-line">
                {captionBeat.speaker[0]?.toUpperCase()}{captionBeat.speaker.slice(1)}: {captionText}
              </span>
            </div>
          )}

          {/* draft marking */}
          {mode === 'publish' && draftMarked && (
            <>
              <div className="absolute left-0 top-0 flex items-center gap-1.5 px-[9px] py-[3px] bg-[rgba(200,89,90,.92)] text-[#1a1113] text-[10px] font-semibold tracking-[.1em] uppercase">
                draft · not for release
              </div>
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ backgroundImage: 'repeating-linear-gradient(135deg,rgba(200,89,90,.055) 0 26px,transparent 26px 52px)' }}
              />
            </>
          )}

          {/* recording tally */}
          {recording && (
            <>
              <div className="absolute inset-0 border-2 border-bad pointer-events-none" />
              <div className="absolute right-2 top-2 flex items-center gap-1.5 px-2 py-[2px] rounded-[2px] bg-[rgba(200,89,90,.95)] text-white text-[10px] tracking-[.09em]">
                <span className="w-[7px] h-[7px] rounded-full bg-white" style={{ animation: 'recpulse 1.1s infinite' }} />
                REC
              </div>
            </>
          )}

          {/* direct manipulation — inside the frame box so inset-0 IS the frame,
              at any zoom. Mounts whenever a motion target exists. */}
          {ready && animationTarget && (
            <AnimationOverlay
              iframe={iframeRef}
              frame={frame}
              target={animationTarget}
              validArea={validArea}
              scale={scale}
              width={width}
              height={height}
              showOnion={prefs.onion}
              showPath={prefs.path}
              showPropHandles={prefs.props}
              snapEnabled={prefs.snap}
              snapCandidates={snapCandidates}
              propTargets={propTargets}
              onCommitProp={onCommitProp}
              onInteractStart={() => setPlaying(false)}
              onContextMenu={onContextMenu}
            />
          )}
        </div>

        {preview?.previewId && !ready && (
          <div className="absolute inset-0 grid place-items-center text-ink-faint text-[12px] bg-stage/60 pointer-events-none">
            building preview…
          </div>
        )}
      </div>

      {/* transport */}
      <div className="h-8 shrink-0 flex items-center gap-[7px] px-2 bg-stage border-t border-[#2f353d]">
        <button
          type="button"
          title="Play / pause · Space"
          disabled={!ready}
          onClick={() => setPlaying((p) => !p)}
          className="w-[26px] h-[22px] rounded-[3px] border border-edge bg-accent text-stage text-[10px] cursor-pointer inline-flex items-center justify-center disabled:opacity-40"
        >
          {playing ? '❙❙' : '▶'}
        </button>
        <button
          type="button"
          title="Previous beat · ⇧←"
          onClick={() => onSelectBeat(Math.max(0, (selected ?? activeBeatIndex) - 1))}
          className="w-6 h-[22px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:bg-edge hover:text-ink"
        >
          ‹
        </button>
        <button
          type="button"
          title="Next beat · ⇧→"
          onClick={() => onSelectBeat(Math.min((shots?.beats.length ?? 1) - 1, (selected ?? activeBeatIndex) + 1))}
          className="w-6 h-[22px] rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:bg-edge hover:text-ink"
        >
          ›
        </button>
        <span className="font-mono text-[11px] text-ink whitespace-nowrap shrink-0">
          {fmtTimecode(playMs)} <span className="text-ink-ghost">/ {fmtTimecode(durationMs)}</span>
        </span>
        <div onPointerDown={ready ? scrub : undefined} title="Scrub" className="flex-1 h-[22px] flex items-center cursor-ew-resize relative touch-none">
          <div className="w-full h-[3px] rounded-[2px] bg-panel-2 relative">
            <div
              className="absolute left-0 top-0 bottom-0 bg-accent rounded-[2px]"
              style={{ width: `${durationMs ? Math.min(100, (playMs / durationMs) * 100) : 0}%` }}
            />
            <div
              className="absolute top-1/2 w-[9px] h-[9px] -mt-[4.5px] -ml-[4.5px] rounded-full bg-ink"
              style={{ left: `${durationMs ? Math.min(100, (playMs / durationMs) * 100) : 0}%` }}
            />
          </div>
        </div>
        {/* Fidelity claim. With no preview at all there is nothing to be
            accurate about, and saying so beats implying the picture on screen
            is the one that renders. */}
        <span
          title={!preview
            ? 'No preview has built for this scene — see the error for what is blocking it.'
            : !preview.estimated
              ? 'Real audio and Rhubarb mouth cues'
              : preview.soundtrack === 'stale'
                ? 'Timing estimated from word counts — the mixed audio predates this direction and will not play. Run Voices to rebuild it.'
                : preview.soundtrack === 'missing'
                  ? 'Timing estimated from word counts — no audio has been rendered yet. Run Voices.'
                  : 'Timing estimated from word counts — instant, no synthesis'}
          className="text-[9px] tracking-[.07em] uppercase border rounded-[2px] px-[5px] py-px"
          style={{
            color: !preview ? '#c8595a' : preview.estimated ? '#c8834a' : '#6f9b5a',
            borderColor: !preview ? '#c8595a' : preview.estimated ? '#c8834a' : '#6f9b5a',
          }}
        >
          {!preview ? 'no preview' : preview.estimated ? 'estimated' : 'accurate'}
        </span>
        <button
          type="button"
          title="Loop the selected beat"
          onClick={() => setLoop((v) => !v)}
          className={`h-[22px] px-[7px] rounded-[3px] border text-[10px] cursor-pointer ${
            loop ? 'bg-accent/15 border-accent/50 text-accent' : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
          }`}
        >
          Loop
        </button>
        <Mono className="text-ink-faint">{width}×{height}</Mono>
      </div>

      {bottomStrip}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          className="hidden"
          onError={() => onAudioErrorRef.current?.(mediaErrorMessage(audioRef.current?.error ?? null))}
        />
      )}
    </div>
  );
});
