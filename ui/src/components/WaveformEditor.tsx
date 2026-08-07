import { useEffect, useRef, useState } from 'react';
import { Button, Field, NumberInput, Spinner } from './ui.tsx';

export interface WaveformTrim {
  inMs: number;
  outMs: number;
  speechOnsetMs: number;
  speechEndMs: number;
}

function clampTrim(trim: WaveformTrim, durationMs: number): WaveformTrim {
  const inMs = Math.max(0, Math.min(durationMs - 1, Math.round(trim.inMs)));
  const outMs = Math.max(inMs + 1, Math.min(durationMs, Math.round(trim.outMs)));
  const speechOnsetMs = Math.max(inMs, Math.min(outMs, Math.round(trim.speechOnsetMs)));
  const speechEndMs = Math.max(speechOnsetMs, Math.min(outMs, Math.round(trim.speechEndMs)));
  return { inMs, outMs, speechOnsetMs, speechEndMs };
}

/** Dependency-free waveform and nondestructive trim/speech-boundary editor. */
export function WaveformEditor({
  url, durationMs, trim, disabled, onSave,
}: {
  url: string;
  durationMs: number;
  trim: WaveformTrim;
  disabled?: boolean;
  onSave: (trim: WaveformTrim) => Promise<void>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const stopTimer = useRef<number | null>(null);
  const [draft, setDraft] = useState(() => clampTrim(trim, durationMs));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { inMs, outMs, speechOnsetMs, speechEndMs } = trim;

  useEffect(() => {
    setDraft(clampTrim({ inMs, outMs, speechOnsetMs, speechEndMs }, durationMs));
  }, [durationMs, inMs, outMs, speechOnsetMs, speechEndMs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const bytes = await fetch(url).then((response) => {
          if (!response.ok) throw new Error(`waveform audio returned HTTP ${response.status}`);
          return response.arrayBuffer();
        });
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes.slice(0));
        if (cancelled) return;
        const el = canvas.current;
        if (!el) return;
        const width = Math.max(1, Math.round(el.getBoundingClientRect().width * window.devicePixelRatio));
        const height = Math.max(1, Math.round(72 * window.devicePixelRatio));
        el.width = width;
        el.height = height;
        const ctx = el.getContext('2d');
        if (!ctx) return;
        const samples = decoded.getChannelData(0);
        const perPixel = Math.max(1, Math.floor(samples.length / width));
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = '#c8834a';
        ctx.lineWidth = Math.max(1, window.devicePixelRatio);
        ctx.beginPath();
        for (let x = 0; x < width; x++) {
          let low = 1;
          let high = -1;
          const from = x * perPixel;
          const to = Math.min(samples.length, from + perPixel);
          for (let i = from; i < to; i++) {
            const value = samples[i]!;
            if (value < low) low = value;
            if (value > high) high = value;
          }
          ctx.moveTo(x, (1 - high) * height / 2);
          ctx.lineTo(x, (1 - low) * height / 2);
        }
        ctx.stroke();
        await context.close();
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
  }, []);

  const patch = (values: Partial<WaveformTrim>) => setDraft((current) => clampTrim({ ...current, ...values }, durationMs));
  const playSelection = () => {
    const player = audio.current;
    if (!player) return;
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    player.currentTime = draft.inMs / 1000;
    void player.play();
    stopTimer.current = window.setTimeout(() => player.pause(), Math.max(1, draft.outMs - draft.inMs));
  };

  const trimLeft = (draft.inMs / Math.max(1, durationMs)) * 100;
  const trimRight = 100 - (draft.outMs / Math.max(1, durationMs)) * 100;
  const speechLeft = (draft.speechOnsetMs / Math.max(1, durationMs)) * 100;
  const speechRight = 100 - (draft.speechEndMs / Math.max(1, durationMs)) * 100;

  return (
    <div className="rounded border border-edge p-2 space-y-2">
      <div className="relative h-[72px] overflow-hidden rounded bg-black/25">
        <canvas ref={canvas} className="absolute inset-0 w-full h-[72px]" />
        <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: `${trimLeft}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: `${trimRight}%` }} />
        <div className="absolute inset-y-1 border-x border-good/80 bg-good/10" style={{ left: `${speechLeft}%`, right: `${speechRight}%` }} />
        {loading && <div className="absolute inset-0 grid place-items-center"><Spinner /></div>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Trim in ms"><NumberInput value={draft.inMs} min={0} max={durationMs - 1} onChange={(inMs) => patch({ inMs })} /></Field>
        <Field label="Trim out ms"><NumberInput value={draft.outMs} min={1} max={durationMs} onChange={(outMs) => patch({ outMs })} /></Field>
        <Field label="Speech starts"><NumberInput value={draft.speechOnsetMs} min={draft.inMs} max={draft.outMs} onChange={(speechOnsetMs) => patch({ speechOnsetMs })} /></Field>
        <Field label="Speech ends"><NumberInput value={draft.speechEndMs} min={draft.speechOnsetMs} max={draft.outMs} onChange={(speechEndMs) => patch({ speechEndMs })} /></Field>
      </div>

      <div className="flex gap-1">
        <Button className="flex-1" disabled={disabled || loading} onClick={playSelection}>▶ Audition selection</Button>
        <Button
          variant="primary"
          className="flex-1"
          disabled={disabled || saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void onSave(draft).catch((err: unknown) => setError((err as Error).message)).finally(() => setSaving(false));
          }}
        >
          {saving ? <Spinner /> : 'Save boundaries'}
        </Button>
      </div>
      {error && <div className="text-[10px] text-bad">{error}</div>}
      <audio ref={audio} src={url} preload="metadata" className="hidden" />
    </div>
  );
}
