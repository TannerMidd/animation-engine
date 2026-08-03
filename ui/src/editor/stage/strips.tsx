import { useEffect, useRef, useState } from 'react';
import { api, toBase64 } from '../../api.ts';
import type { DialogueCue, DialogueDocument, ProductionPreflightReport, SceneDetail, ShotList } from '../../types.ts';
import { WaveformEditor } from '../../components/WaveformEditor.tsx';
import { Mono } from '../chrome.tsx';
import { speakerColour } from '../lib.ts';

/** Write/Direct: the shot list as cards, linked to script and timeline. */
export function ShotStrip({
  shots, beatStarts, selected, onSelect,
}: {
  shots: ShotList;
  beatStarts: number[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const castIds = shots.cast.map((c) => c.id);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected === null) return;
    host.current?.querySelector(`[data-beat="${selected}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  return (
    <div className="h-[106px] shrink-0 flex flex-col bg-stage border-t border-edge min-h-0">
      <div className="h-6 shrink-0 flex items-center gap-2 px-[9px] border-b border-[#2f353d]">
        <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">Shot list</span>
        <span className="text-[10px] text-ink-ghost">linked to script — selecting a beat scrolls both</span>
        <div className="flex-1" />
        <Mono className="text-ink-ghost">shotlist.json</Mono>
      </div>
      <div ref={host} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden flex gap-1.5 px-[9px] py-2">
        {shots.beats.map((beat, i) => {
          const on = selected === i;
          const durMs = i + 1 < beatStarts.length
            ? (beatStarts[i + 1] ?? 0) - (beatStarts[i] ?? 0)
            : beat.kind === 'line' ? 0 : beat.ms;
          const who = beat.kind === 'line' ? beat.speaker : beat.kind;
          const unsupported = beat.kind === 'action' && ((beat.unsupported?.length ?? 0) > 0 || !beat.stage?.length);
          return (
            <button
              key={beat.id}
              type="button"
              data-beat={i}
              title={`beat ${i} · ${beat.shot} · ${beat.camera}${beat.locked ? ' · locked' : ''}${unsupported ? ' · unsupported physical business' : ''}`}
              onClick={() => onSelect(i)}
              className="w-[150px] shrink-0 flex flex-col gap-1 px-[7px] py-1.5 border rounded-[3px] cursor-pointer text-left hover:border-edge-2"
              style={{
                background: on ? 'rgba(200,131,74,.12)' : '#22262c',
                borderColor: on ? '#c8834a' : '#2f353d',
              }}
            >
              <span className="flex items-center gap-[5px]">
                <Mono className="text-ink-ghost">{i}</Mono>
                <span className="text-[9px] tracking-[.06em] uppercase" style={{ color: beat.kind === 'line' ? speakerColour(castIds, beat.speaker) : '#6b737d' }}>
                  {who}
                </span>
                <span className="flex-1" />
                {beat.locked && <span title="Locked — survives director reruns" className="text-[9px] text-lock">🔒</span>}
                {unsupported && <span title="Unstructured or unsupported action — production export blocks on it" className="text-[9px] text-bad">!</span>}
              </span>
              <span className="flex gap-1">
                <Mono className="text-ink-dim border border-edge rounded-[2px] px-1">{beat.shot}</Mono>
                <Mono className="text-ink-faint border border-edge rounded-[2px] px-1">{beat.camera}</Mono>
                <span className="flex-1" />
                <Mono className="text-ink-faint">{durMs ? `${(durMs / 1000).toFixed(1)}s` : ''}</Mono>
              </span>
              <span
                className="text-[10px] leading-[1.35] overflow-hidden"
                style={{
                  color: on ? '#c9ccd1' : '#8b939d',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {beat.kind === 'pause' ? `pause · ${beat.ms} ms` : beat.text}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Perform: the selected line's take — trim, boundaries, capture.
 *
 * Recording here is the Line Booth's quick path; the Voice tab carries the
 * full booth (context playback, conversion, consent management).
 */
export function TakeStrip({
  scene, cue, dialogue, castVoiceBound, recording, onRecordingChange, onReload, onSaveCue, onOpenVoiceTab,
}: {
  scene: string;
  cue: DialogueCue | null;
  dialogue: DialogueDocument | null;
  castVoiceBound: boolean;
  recording: boolean;
  onRecordingChange: (rec: boolean) => void;
  onReload: () => Promise<void>;
  onSaveCue: (cue: DialogueCue) => Promise<void>;
  onOpenVoiceTab: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [abPlaying, setAbPlaying] = useState<'a' | 'b' | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const takes = cue && dialogue ? dialogue.recordedTakes.filter((t) => t.cueId === cue.id) : [];
  const selectedTake = cue?.selectedTakeId ? takes.find((t) => t.id === cue.selectedTakeId) ?? null : null;
  const render = cue?.selectedRenderId && dialogue
    ? dialogue.voiceRenders.find((r) => r.id === cue.selectedRenderId) ?? null
    : null;

  useEffect(() => () => {
    recorder.current?.stop();
    if (ticker.current) window.clearInterval(ticker.current);
    audio.current?.pause();
  }, []);
  useEffect(() => {
    setAbPlaying(null);
    audio.current?.pause();
  }, [cue?.id]);

  const startRecording = async () => {
    if (!cue) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => chunks.current.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void (async () => {
          try {
            const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' });
            await api.uploadPerformance(scene, cue.id, {
              dataBase64: await toBase64(blob),
              filename: 'line-booth.webm',
              mode: 'line-booth',
              performerId: 'creator',
            });
            await onReload();
          } catch (err) {
            setError((err as Error).message);
          }
        })();
      };
      mr.start();
      recorder.current = mr;
      onRecordingChange(true);
      setElapsed(0);
      ticker.current = window.setInterval(() => setElapsed((s) => s + 0.1), 100);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
    if (ticker.current) window.clearInterval(ticker.current);
    onRecordingChange(false);
  };

  const playAB = (which: 'a' | 'b') => {
    audio.current?.pause();
    if (abPlaying === which) {
      setAbPlaying(null);
      return;
    }
    const url = which === 'a' && selectedTake
      ? `/api/scenes/${scene}/dialogue/takes/${selectedTake.id}/audio`
      : which === 'b' && render
        ? `/api/scenes/${scene}/dialogue/renders/${render.id}/audio`
        : null;
    if (!url) return;
    const el = new Audio(url);
    el.onended = () => setAbPlaying(null);
    audio.current = el;
    void el.play().catch(() => setAbPlaying(null));
    setAbPlaying(which);
  };

  const follow = cue?.durationPolicy.mode !== 'fit-locked-window';
  const toggleFollow = () => {
    if (!cue) return;
    const next: DialogueCue = {
      ...cue,
      durationPolicy: {
        ...cue.durationPolicy,
        mode: follow ? 'fit-locked-window' : 'follow-performance',
        targetFrames: follow ? (cue.durationPolicy.targetFrames ?? cue.durationFrames) : cue.durationPolicy.targetFrames,
      },
    };
    void onSaveCue(next);
  };

  const approve = () => {
    if (!cue) return;
    void onSaveCue({
      ...cue,
      approval: { ...cue.approval, state: 'approved', by: 'local-creator', at: new Date().toISOString() },
    });
  };

  const qc = selectedTake?.quality ?? null;
  const trim = cue?.trim ?? (selectedTake
    ? { inMs: 0, outMs: selectedTake.audio.durationMs, speechOnsetMs: 0, speechEndMs: selectedTake.audio.durationMs }
    : null);

  return (
    <div className="h-[168px] shrink-0 flex flex-col bg-stage border-t border-edge min-h-0">
      <div className="h-6 shrink-0 flex items-center gap-2 px-[9px] border-b border-[#2f353d]">
        <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">Take · trim &amp; speech boundaries</span>
        <Mono className="text-ink-ghost">
          {selectedTake
            ? `take ${takes.indexOf(selectedTake) + 1} of ${takes.length} · ${(selectedTake.audio.durationMs / 1000).toFixed(2)} s · ${(selectedTake.audio.sampleRate / 1000).toFixed(0)} kHz ${selectedTake.audio.channels === 1 ? 'mono' : 'stereo'}`
            : takes.length ? `${takes.length} take${takes.length === 1 ? '' : 's'} — none selected` : 'no takes yet'}
        </Mono>
        <div className="flex-1" />
        {error && <span className="text-[10px] text-bad truncate max-w-64" title={error}>{error}</span>}
        {qc && (
          <span
            title="Automated capture QC checks level, clipping, speech ratio, duration and cadence. It does not verify the transcript or speaker identity."
            className="text-[9px] tracking-[.06em] uppercase border rounded-[2px] px-[5px] py-px"
            style={{
              color: qc.verdict === 'pass' ? '#6f9b5a' : qc.verdict === 'warn' ? '#c8834a' : '#c8595a',
              borderColor: qc.verdict === 'pass' ? '#6f9b5a' : qc.verdict === 'warn' ? '#c8834a' : '#c8595a',
            }}
          >
            capture qc · {qc.verdict}
          </span>
        )}
        <span
          className="text-[9px] tracking-[.06em] uppercase border rounded-[2px] px-[5px] py-px"
          style={{ color: castVoiceBound ? '#6f9b5a' : '#c8595a', borderColor: castVoiceBound ? '#6f9b5a' : '#c8595a' }}
          title={castVoiceBound ? 'A voice reference is bound; conversion and rights records are available.' : 'No bound voice reference — conversion is unavailable; recording stays in your own voice.'}
        >
          {castVoiceBound ? 'reference bound' : 'no reference'}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative px-3 py-2">
          {cue && selectedTake && trim ? (
            <WaveformEditor
              url={`/api/scenes/${scene}/dialogue/takes/${selectedTake.id}/audio`}
              durationMs={selectedTake.audio.durationMs}
              trim={trim}
              onSave={async (next) => {
                await onSaveCue({ ...cue, trim: next });
              }}
            />
          ) : (
            <div className="h-full grid place-items-center text-[11px] text-ink-ghost text-center leading-relaxed">
              {cue
                ? 'No take selected. Record one, or pick a line with takes.'
                : 'Select a line in the Lines pane.'}
            </div>
          )}
        </div>

        <div className="w-[238px] shrink-0 border-l border-[#2f353d] px-2.5 py-2 flex flex-col gap-[7px]">
          <div className="flex gap-[5px]">
            <button
              type="button"
              disabled={!cue}
              title={recording ? 'Stop and upload. The original take stays immutable.' : 'Record this line in place. The full booth with context playback lives in the Voice tab.'}
              onClick={() => (recording ? stopRecording() : void startRecording())}
              className={`flex-1 h-[26px] rounded-[3px] border text-[11px] font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 ${
                recording ? 'bg-bad/20 border-bad text-[#e0a0a1]' : 'bg-accent border-accent text-stage'
              }`}
            >
              {recording ? `■ Stop · ${elapsed.toFixed(1)} s` : '● Record performance'}
            </button>
            <button
              type="button"
              onClick={onOpenVoiceTab}
              title="Open the full Line Booth — context playback, count-in, conversion, consent"
              className="h-[26px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[11px] cursor-pointer hover:text-ink"
            >
              Booth
            </button>
          </div>

          <div className="flex gap-1">
            {takes.slice(-3).map((take, i) => {
              const on = cue?.selectedTakeId === take.id;
              return (
                <button
                  key={take.id}
                  type="button"
                  title={`Select take ${takes.indexOf(take) + 1}`}
                  onClick={() => cue && void onSaveCue({ ...cue, selectedTakeId: take.id })}
                  className={`flex-1 h-6 rounded-[3px] border text-[10px] cursor-pointer flex flex-col items-center justify-center leading-[1.15] ${
                    on ? 'bg-accent/20 border-accent text-accent' : 'bg-panel-2 border-edge text-ink-dim hover:text-ink'
                  }`}
                >
                  <span>Take {takes.indexOf(take) + 1}</span>
                  <span className="font-mono text-[8px] opacity-70">{(take.audio.durationMs / 1000).toFixed(2)}s</span>
                </button>
              );
            })}
            {!takes.length && <div className="flex-1 h-6 rounded-[3px] border border-dashed border-edge grid place-items-center text-[9px] text-ink-ghost">no takes recorded</div>}
          </div>

          <div className="flex items-center gap-1.5 px-[7px] py-[5px] border border-gen/40 bg-gen/10 rounded-[3px]">
            <button
              type="button"
              disabled={!cue}
              title="Preserves your timing, pauses, emotion and cadence. Only vocal identity is converted."
              onClick={toggleFollow}
              className="w-[26px] h-[15px] rounded-lg border relative cursor-pointer shrink-0 p-0 disabled:opacity-40"
              style={{ borderColor: follow ? '#7a8fc0' : '#363d46', background: follow ? 'rgba(122,143,192,.4)' : '#2b3138' }}
            >
              <span
                className="absolute top-px w-[11px] h-[11px] rounded-full transition-[left] duration-100"
                style={{ left: follow ? 12 : 1, background: follow ? '#c5d0e6' : '#6b737d' }}
              />
            </button>
            <span className="flex-1 text-[10px] text-[#a8b6d4] leading-[1.3]">
              Follow Performance<br />
              <span className="text-ink-faint">{follow ? 'your timing kept · identity converted' : 'fit to the locked picture window'}</span>
            </span>
          </div>

          <div className="flex gap-[5px] mt-auto">
            <button
              type="button"
              disabled={!selectedTake}
              title={render ? 'Compare the original recording against the converted character voice' : 'A: the recording. Conversion has not produced a B side yet.'}
              onClick={() => playAB(abPlaying === 'a' || !render ? 'a' : 'b')}
              className={`flex-1 h-6 rounded-[3px] border text-[10px] cursor-pointer disabled:opacity-40 ${
                abPlaying ? 'bg-accent/15 border-accent/50 text-accent' : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
              }`}
            >
              {abPlaying === 'a' ? '■ A' : abPlaying === 'b' ? '■ B' : 'A / B'}
            </button>
            <button
              type="button"
              disabled={!cue || !selectedTake || cue.approval.state === 'approved'}
              title="Approve this take and lock it to picture"
              onClick={approve}
              className="flex-1 h-6 rounded-[3px] border border-good bg-good/20 text-[#8fbd76] text-[10px] cursor-pointer hover:bg-good/30 disabled:opacity-40"
            >
              {cue?.approval.state === 'approved' ? '✓ Approved' : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Publish: what the export produces, and the two ways to produce it. */
export function ExportStrip({
  scene, detail, preview, identityLabel, preflight, onRenderMaster, onRenderDraft,
}: {
  scene: string;
  detail: SceneDetail | null;
  preview: { width: number; height: number } | null;
  identityLabel: string;
  preflight: ProductionPreflightReport | null;
  onRenderMaster: () => void;
  onRenderDraft: () => void;
}) {
  const blockers = preflight?.notes.filter((n) => n.level === 'error').length ?? 0;
  const reviewPending = Boolean(preflight && !preflight.productionBlocked && preflight.warningReview.required && !preflight.warningReview.current);
  const blocked = blockers > 0 || reviewPending;
  const w = preview?.width ?? 1280;
  const h = preview?.height ?? 720;

  const rows: Array<{ label: string; value: string; note?: string; noteFg?: string }> = [
    {
      label: 'Masters',
      value: `16:9 ${w}×${h}${detail?.hasVertical ? ` · 9:16 ${h}×${w}` : ''}`,
      note: 'actor-aware recompose',
      noteFg: '#7a8fc0',
    },
    { label: 'Captions', value: 'WebVTT + SRT sidecars', note: 'not burned in', noteFg: '#c8834a' },
    {
      label: 'Audio',
      value: detail?.hasAudio ? '48 kHz stereo dialogue mix' : 'not built — run Voices',
      note: detail?.hasAudio ? undefined : 'blocker',
      noteFg: '#c8595a',
    },
    { label: 'Manifest', value: `hashes · provenance · ${identityLabel}` },
  ];

  return (
    <div className="h-[124px] shrink-0 flex flex-col bg-stage border-t border-edge">
      <div className="h-6 shrink-0 flex items-center gap-2 px-[9px] border-b border-[#2f353d]">
        <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">Export</span>
        <div className="flex-1" />
        <Mono className="text-ink-ghost">manifest records hashes, provenance and identity stamp</Mono>
      </div>
      <div className="flex-1 flex gap-[9px] px-2.5 py-2 min-h-0">
        <div className="flex-1 flex flex-col gap-[5px] min-w-0">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-2 h-5">
              <span className="w-[88px] shrink-0 text-[10px] tracking-[.05em] uppercase text-ink-faint">{row.label}</span>
              <Mono className="text-ink truncate">{row.value}</Mono>
              <span className="flex-1" />
              {row.note && <span className="text-[10px] shrink-0" style={{ color: row.noteFg }}>{row.note}</span>}
            </div>
          ))}
          {detail?.hasExport && (
            <div className="flex gap-1.5 mt-auto">
              {[
                ['MP4', `/api/scenes/${scene}/video`],
                ['9:16', `/api/scenes/${scene}/video/vertical`, !detail.hasVertical],
                ['VTT', `/api/scenes/${scene}/captions.vtt`],
                ['SRT', `/api/scenes/${scene}/captions.srt`],
                ['Manifest', `/api/scenes/${scene}/export`],
              ].map(([label, href, hidden]) => hidden ? null : (
                <a
                  key={label as string}
                  href={href as string}
                  target="_blank"
                  rel="noreferrer"
                  className="h-[19px] px-1.5 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] inline-flex items-center hover:text-ink"
                >
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="w-px bg-[#2f353d]" />
        <div className="w-[246px] shrink-0 flex flex-col gap-1.5">
          <div className="flex gap-[5px]">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                title={detail?.hasExport ? `Thumbnail candidate ${i + 1}` : 'Thumbnails are picked at export time'}
                className="flex-1 h-[38px] rounded-[2px] border overflow-hidden relative bg-[#0c0d0f]"
                style={{ borderColor: i === 0 ? '#c8834a' : '#363d46' }}
              >
                {detail?.hasExport ? (
                  <img src={`/api/scenes/${scene}/thumbnail/${i}`} alt={`thumbnail candidate ${i + 1}`} className="w-full h-full object-cover opacity-85" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-[8px] text-ink-ghost font-mono">—</span>
                )}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={onRenderMaster}
            title={blocked ? `${blockers ? `${blockers} blocker${blockers === 1 ? '' : 's'} must clear first` : 'Warnings need a review acknowledgement first'}` : 'Render the production master'}
            className={`h-7 rounded-[3px] border text-[11px] font-semibold cursor-pointer flex items-center justify-center gap-1.5 ${
              blocked
                ? 'border-bad/50 bg-bad/10 text-bad'
                : 'border-good bg-good/20 text-[#8fbd76] hover:bg-good/30'
            }`}
          >
            {blocked
              ? `Render master — blocked by ${blockers || 'review'}${blockers ? ` issue${blockers === 1 ? '' : 's'}` : ''}`
              : 'Render master'}
          </button>
          <button
            type="button"
            onClick={onRenderDraft}
            title="Draft renders are labelled in the manifest and marked in the preview"
            className="h-6 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:text-ink"
          >
            Render draft with blockers…
          </button>
        </div>
      </div>
    </div>
  );
}
