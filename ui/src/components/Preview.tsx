import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button, Badge } from './ui.tsx';
import { ScaledFrame } from './ScaledFrame.tsx';

/**
 * The live preview.
 *
 * The iframe loads the *same page the renderer renders*: `buildPage` output,
 * with `window.__seek(frame)` applying a frame synchronously. Playback here is
 * a requestAnimationFrame loop calling that function; the final render is
 * Playwright calling it and screenshotting. One code path, so the preview
 * cannot show you something the render won't produce.
 */

interface RuntimeWindow extends Window {
  __ready?: boolean;
  __seek?: (frame: number) => number;
  __frameCount?: number;
}

export interface PreviewHandle {
  seekFrame(frame: number): void;
  seekMs(ms: number): void;
  pause(): void;
}

interface Props {
  previewId: string | null;
  frameCount: number;
  fps: number;
  /** Mixed dialogue track, when it has been rendered. */
  audioUrl?: string | null;
  /** Beat boundaries in ms, drawn as ticks on the scrubber. */
  beatStarts?: number[];
  /** True when timing is estimated from word counts rather than real audio. */
  estimated?: boolean;
  onFrame?: (frame: number) => void;
  /** Fired when the user scrubs or steps, so the timeline can follow. */
  onUserSeek?: (ms: number) => void;
}

export const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { previewId, frameCount, fps, audioUrl, beatStarts, estimated, onFrame, onUserSeek },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);

  const clampFrame = useCallback(
    (f: number) => Math.max(0, Math.min(frameCount - 1, Math.round(f))),
    [frameCount],
  );

  /** Push a frame into the runtime. The only place that talks to the iframe. */
  const apply = useCallback(
    (f: number) => {
      const win = iframeRef.current?.contentWindow as RuntimeWindow | null | undefined;
      if (!win?.__seek) return;
      const next = clampFrame(f);
      try {
        win.__seek(next);
      } catch {
        // A stale preview (server restarted, id expired) shouldn't throw on every tick.
        return;
      }
      frameRef.current = next;
      setFrame(next);
      onFrame?.(next);
    },
    [clampFrame, onFrame],
  );

  // Wait for the runtime to finish building before seeking at it.
  useEffect(() => {
    setReady(false);
    setPlaying(false);
    if (!previewId) return;

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
  }, [previewId, frameCount, apply]);

  // Playback clock. Wall time drives it, so a slow frame drops rather than
  // stretching the scene — matching how the finished video would play.
  useEffect(() => {
    if (!playing || !ready) return;

    const startWall = performance.now();
    const startFrame = frameRef.current >= frameCount - 1 ? 0 : frameRef.current;
    let raf = 0;

    const tick = () => {
      const elapsed = (performance.now() - startWall) / 1000;
      const next = startFrame + elapsed * fps;
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
  }, [playing, ready, fps, frameCount, apply]);

  // Audio follows the frame clock rather than the other way round: the picture
  // is authoritative because that is what gets rendered.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (playing) {
      audio.currentTime = frameRef.current / fps;
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [playing, audioUrl, fps]);

  useImperativeHandle(ref, () => ({
    seekFrame: (f) => {
      setPlaying(false);
      apply(f);
    },
    seekMs: (ms) => {
      setPlaying(false);
      apply((ms / 1000) * fps);
    },
    pause: () => setPlaying(false),
  }), [apply, fps]);

  const step = (delta: number) => {
    setPlaying(false);
    apply(frameRef.current + delta);
    onUserSeek?.(((frameRef.current + delta) / fps) * 1000);
  };

  const durationMs = (frameCount / fps) * 1000;
  const t = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative flex-1 min-h-0 rounded-t-md overflow-hidden">
        <ScaledFrame src={previewId ? `/preview/${previewId}` : null} title="preview" iframeRef={iframeRef} />
        {previewId && !ready && (
          <div className="absolute inset-0 grid place-items-center text-ink-faint text-[12px] bg-stage/60 pointer-events-none">
            building preview…
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-edge bg-panel px-2 py-1.5 rounded-b-md">
        <div className="flex items-center gap-2">
          <Button onClick={() => setPlaying((p) => !p)} disabled={!ready} variant="primary">
            {playing ? '❚❚' : '▶'}
          </Button>
          <Button onClick={() => step(-1)} disabled={!ready} title="previous frame">‹</Button>
          <Button onClick={() => step(1)} disabled={!ready} title="next frame">›</Button>

          <div className="relative flex-1 h-6 flex items-center">
            {/* Beat ticks, so you can see where cuts land while scrubbing. */}
            <div className="absolute inset-x-0 top-0 h-1.5 pointer-events-none">
              {beatStarts?.map((ms, i) => (
                <div
                  key={i}
                  className="absolute top-0 w-px h-1.5 bg-ink-faint/60"
                  style={{ left: `${(ms / Math.max(1, durationMs)) * 100}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, frameCount - 1)}
              value={frame}
              disabled={!ready}
              onChange={(e) => {
                setPlaying(false);
                const f = Number(e.target.value);
                apply(f);
                onUserSeek?.((f / fps) * 1000);
              }}
              className="w-full accent-accent"
            />
          </div>

          <span className="text-[11px] tabular-nums text-ink-dim w-28 text-right">
            {t((frame / fps) * 1000)} / {t(durationMs)}
          </span>
          {estimated && <Badge tone="warn">estimated</Badge>}
        </div>
      </div>

      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" className="hidden" />}
    </div>
  );
});
