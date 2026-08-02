import { useEffect, useRef, useState } from 'react';
import { api, followJob, toBase64 } from '../api.ts';
import type { Health, RigDoc, Vocab } from '../types.ts';
import { Button, Select, NumberInput, TextInput, Field, Badge, Spinner } from './ui.tsx';

/**
 * A character's voice: how it is chosen, cloned, and checked.
 *
 * Cloning is the one part of the pipeline you cannot verify by looking, so the
 * panel is built around hearing things. Record or drop in a reference, play it
 * back to confirm it is what you think it is, then audition a line in the cloned
 * voice — which runs the same synthesis path a render would, so there is no gap
 * between what you approve here and what comes out the other end.
 */
export function VoicePanel({
  rig, vocab, health, onPatch,
}: {
  rig: RigDoc;
  vocab: Vocab | null;
  health: Health | null;
  onPatch: (changes: Partial<RigDoc>) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refVersion, setRefVersion] = useState(0);

  const [line, setLine] = useState('');
  const [expression, setExpression] = useState('DEADPAN');
  const [take, setTake] = useState(0);
  const [auditionUrl, setAuditionUrl] = useState<string | null>(null);
  const [auditionStage, setAuditionStage] = useState<string | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopFollow = useRef<(() => void) | null>(null);

  const name = rig.name;
  const expressions = rig.expressions.map((e) => e.name);
  const lines = vocab?.auditionLines ?? [];
  const ideal = vocab?.referenceSeconds ?? { min: 4, max: 15 };
  const cloningReady = health?.engines['chatterbox']?.ok ?? false;

  // Selection is per-character, so switching in the list doesn't leave the
  // previous character's audition sitting there ready to play.
  useEffect(() => {
    setAuditionUrl(null);
    setAuditionStage(null);
    setWarnings([]);
    setError(null);
    setLine('');
  }, [name]);

  useEffect(() => () => stopFollow.current?.(), []);

  // A running timer, because the useful thing to know while recording is
  // whether you have said enough yet.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => clearInterval(t);
  }, [recording]);

  const upload = async (blob: Blob, filename: string) => {
    setBusy('Converting…');
    setError(null);
    try {
      const res = await api.uploadRef(name, filename, await toBase64(blob));
      onPatch({ voiceRef: res.voiceRef });
      setWarnings(res.warnings);
      // Bust the audio element's cache: the URL is stable but the file is not.
      setRefVersion((v) => v + 1);
      setAuditionUrl(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The browser's own cleanup helps more than it hurts for a reference
        // clip: what matters is a clean voice, not a faithful room.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      chunks.current = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        void upload(blob, 'recording.webm');
      };
      recorder.current = rec;
      rec.start();
      setElapsed(0);
      setRecording(true);
    } catch (err) {
      setError(
        `could not open the microphone: ${(err as Error).message}. ` +
          'Check the browser has permission for this page.',
      );
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  const audition = () => {
    stopFollow.current?.();
    setError(null);
    setAuditionUrl(null);
    setAuditionStage('starting');

    void api
      .audition(name, { text: line || undefined, expression, seed: take + 1 })
      .then((job) => {
        stopFollow.current = followJob(job.id, (e) => {
          if (e.type === 'progress') setAuditionStage(e.stage ?? 'synth');
          if (e.type === 'error') {
            setError(e.message ?? 'the audition failed');
            setAuditionStage(null);
          }
          if (e.type === 'done') {
            setAuditionStage(null);
            // Cache-busted so a second take actually plays the second take.
            setAuditionUrl(`/api/cast/${name}/audition.wav?t=${Date.now()}`);
          }
        });
      })
      .catch((err: Error) => {
        setError(err.message);
        setAuditionStage(null);
      });
  };

  return (
    <div className="p-3">
      <Field label="Speaking rate" hint="-10 slow to 10 fast. Slower reads deadpan.">
        <NumberInput value={rig.voiceRate} min={-10} max={10} onChange={(v) => onPatch({ voiceRate: Math.round(v) })} />
      </Field>

      <Field label="Fallback SAPI voice" hint="Used only by the sapi engine, or when no clip is attached.">
        <Select
          value={rig.voice}
          options={
            health?.sapiVoices.length
              ? health.sapiVoices.map((v) => v.replace('Microsoft ', '').replace(' Desktop', ''))
              : [rig.voice]
          }
          onChange={(v) => onPatch({ voice: v })}
        />
      </Field>

      <div className="h-px bg-edge my-3" />

      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">Voice clone</span>
        {rig.voiceRef ? <Badge tone="good">cloned</Badge> : <Badge>no clip</Badge>}
      </div>

      <p className="text-[11px] text-ink-faint mb-2">
        Read anything for {ideal.min}–{ideal.max} seconds in the voice you want. Chatterbox matches the
        timbre, not the words.
      </p>

      <div className="flex items-center gap-1 mb-2">
        {recording ? (
          <Button variant="danger" onClick={stopRecording} className="flex-1">
            ■ Stop ({elapsed.toFixed(1)}s)
          </Button>
        ) : (
          <Button onClick={() => void startRecording()} disabled={!!busy} className="flex-1">
            ● Record
          </Button>
        )}
        <label
          className={`px-2.5 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[12px] ${
            busy || recording ? 'opacity-40 pointer-events-none' : 'cursor-pointer'
          }`}
        >
          File…
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f, f.name);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {recording && (
        <div className="text-[11px] text-ink-dim mb-2">
          {elapsed < ideal.min
            ? `keep going — ${(ideal.min - elapsed).toFixed(0)}s more`
            : elapsed > ideal.max
              ? 'that is plenty'
              : 'good length, stop whenever'}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-[11px] text-ink-dim mb-2">
          <Spinner /> {busy}
        </div>
      )}

      {rig.voiceRef && !recording && (
        <div className="mb-2">
          <audio
            key={`${name}-${refVersion}`}
            controls
            src={`/api/cast/${name}/ref?v=${refVersion}`}
            className="w-full h-8"
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-ink-faint truncate">{rig.voiceRef}</span>
            <Button
              variant="danger"
              onClick={() =>
                void api
                  .clearRef(name)
                  .then(() => {
                    onPatch({ voiceRef: null });
                    setWarnings([]);
                  })
                  .catch((err: Error) => setError(err.message))
              }
            >
              Remove
            </Button>
          </div>
        </div>
      )}

      {warnings.map((w) => (
        <div key={w} className="text-[11px] text-accent mb-1">{w}</div>
      ))}

      <div className="h-px bg-edge my-3" />

      <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Audition</div>

      <Field label="Line">
        <TextInput
          value={line}
          placeholder={lines[0] ?? 'Say something.'}
          onChange={setLine}
        />
      </Field>
      {!line && lines.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2 -mt-1">
          {lines.slice(1).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLine(l)}
              title={l}
              className="px-1.5 py-0.5 rounded bg-panel-2 hover:bg-edge text-[10px] text-ink-dim max-w-full truncate"
            >
              {l.slice(0, 28)}…
            </button>
          ))}
        </div>
      )}

      <Field label="Delivery" hint="Drives the emotion Chatterbox synthesizes with.">
        <Select value={expression} options={expressions} onChange={setExpression} />
      </Field>

      <div className="flex gap-1">
        <Button
          variant="primary"
          className="flex-1"
          disabled={!!auditionStage || !cloningReady}
          onClick={audition}
          title={cloningReady ? undefined : 'Chatterbox is not available — see the health panel'}
        >
          {auditionStage ? <><Spinner /> {auditionStage}…</> : 'Hear it'}
        </Button>
        {auditionUrl && (
          <Button
            onClick={() => {
              setTake((t) => t + 1);
              audition();
            }}
            title="Same line, different take"
          >
            ↻
          </Button>
        )}
      </div>

      {!cloningReady && (
        <div className="text-[11px] text-ink-faint mt-2">
          {health?.engines['chatterbox']?.checking
            ? 'checking whether Chatterbox is available…'
            : (health?.engines['chatterbox']?.reason ?? 'Chatterbox is not available')}
        </div>
      )}

      {auditionStage === 'synth' && (
        <div className="text-[11px] text-ink-faint mt-2">
          The first take loads the model into VRAM and takes a while. Later ones are cached.
        </div>
      )}

      {auditionUrl && <audio key={auditionUrl} controls autoPlay src={auditionUrl} className="w-full h-8 mt-2" />}

      {error && <div className="mt-3 text-[11px] text-bad">{error}</div>}
    </div>
  );
}
