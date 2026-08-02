import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * The preview page at a fixed 1280x720, scaled to fit its container.
 *
 * Scaled rather than resized on purpose: the runtime page *is* the render
 * surface, and letting it reflow to the panel width would change framing and
 * make the preview lie about what gets rendered.
 */
interface RuntimeWindow extends Window {
  __ready?: boolean;
  __seek?: (frame: number) => number;
}

export function ScaledFrame({
  src, title, iframeRef, onLoad, seekOnReady = true, width = 1280, height = 720,
}: {
  src: string | null;
  title: string;
  iframeRef?: React.Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  width?: number;
  height?: number;
  /**
   * Apply frame 0 once the runtime is ready.
   *
   * The page loads with actors unplaced — nothing has a transform until
   * something calls __seek. Single-frame previews (sets, cast) have no
   * playback loop to do it, so without this every puppet renders stacked at
   * its own local origin instead of on its mark.
   */
  seekOnReady?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.5);

  // The iframe is owned here (so we can seek it), but callers that drive
  // playback need a handle to it too.
  useImperativeHandle(iframeRef, () => own.current as HTMLIFrameElement, [src]);

  useEffect(() => {
    if (!src || !seekOnReady) return;
    let cancelled = false;
    const started = Date.now();

    const poll = () => {
      if (cancelled) return;
      const win = own.current?.contentWindow as RuntimeWindow | null | undefined;
      if (win?.__ready && win.__seek) {
        try {
          win.__seek(0);
        } catch {
          // A stale preview shouldn't throw here.
        }
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
  }, [src, seekOnReady]);

  // Layout effect, not effect: ResizeObserver first fires *after* paint, so an
  // ordinary effect shows one frame at the placeholder scale before snapping to
  // the right size. Measuring synchronously before paint removes that flash.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;

    const measure = () => {
      const { width: containerWidth, height: containerHeight } = el.getBoundingClientRect();
      if (containerWidth < 8 || containerHeight < 8) return;
      setScale(Math.min(containerWidth / Math.max(1, width), containerHeight / Math.max(1, height)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  // The wrapper is sized to the *scaled* dimensions and the iframe scales from
  // its top-left corner.
  //
  // The obvious approach — centre the 1280x720 iframe and scale about its
  // centre — is subtly broken: an element wider than its container does not
  // centre symmetrically, browsers clamp it to the start edge, so the transform
  // then scales about a centre that is already displaced and the frame lands
  // hundreds of pixels off. Giving the wrapper the post-scale size means
  // ordinary centring applies to something that actually fits.
  const wrapper: CSSProperties = {
    width: width * scale,
    height: height * scale,
    position: 'relative',
    overflow: 'hidden',
  };

  const frame: CSSProperties = {
    width,
    height,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    position: 'absolute',
    top: 0,
    left: 0,
  };

  return (
    <div ref={host} className="w-full h-full grid place-items-center overflow-hidden bg-black/40">
      {src ? (
        <div style={wrapper}>
          <iframe ref={own} key={src} src={src} title={title} className="border-0" style={frame} scrolling="no" onLoad={onLoad} />
        </div>
      ) : (
        <span className="text-ink-faint text-[12px]">building…</span>
      )}
    </div>
  );
}
