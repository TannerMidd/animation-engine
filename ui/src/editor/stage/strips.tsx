import { useEffect, useRef, useState } from 'react';
import { api, toBase64 } from '../../api.ts';
import type {
  DialogueCue, DialogueDocument, ProductionPreflightReport, SceneDetail, ShotList, VoiceRender,
} from '../../types.ts';
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
 * full booth (context playback, conversion, consent management). The header
 * names the speaker and the line, so a take can't quietly land on the wrong
 * character; every mistake has a way back — discard, unselect, unapprove.
 */
export function TakeStrip({
  scene, cue, dialogue, sceneLines, speakerFg, castVoiceBound, recording, onRecordingChange, onReload, onSaveCue,
  onDiscardTake, onUseGenerated, onOpenVoiceTab, speakerRig, converting, onConvert, onScoreAcrossCast,
  onOpenCastEditor, conversionRuntime,
}: {
  scene: string;
  cue: DialogueCue | null;
  dialogue: DialogueDocument | null;
  /** The cues this script still has, so counts never include left-behind lines. */
  sceneLines: DialogueCue[];
  speakerFg: string;
  castVoiceBound: boolean;
  recording: boolean;
  onRecordingChange: (rec: boolean) => void;
  onReload: () => Promise<void>;
  onSaveCue: (cue: DialogueCue) => Promise<void>;
  onDiscardTake: (takeId: string) => void;
  /** Approve the character's generated voice — this line, or every undecided line of the speaker. */
  onUseGenerated: (scope: 'line' | 'speaker') => void;
  onOpenVoiceTab: () => void;
  /** The cast rig behind the speaker — the voice a conversion targets. */
  speakerRig: string | null;
  converting: boolean;
  onConvert: () => void;
  /** Score this take against every cast voice — the conversion check, asked where it comes up. */
  onScoreAcrossCast: (() => void) | null;
  onOpenCastEditor: (name: string | null) => void;
  /** Fingerprint of the conversion runtime running now; older output is not offered. */
  conversionRuntime: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [abPlaying, setAbPlaying] = useState<'a' | 'b' | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  // Line takes plus any Scene Run whose segments cover this line — a run
  // belongs to no single cue, but it must still be visible and discardable
  // from every line it touches.
  const takes = cue && dialogue
    ? dialogue.recordedTakes.filter((t) =>
        !t.revokedAt &&
        (t.cueId === cue.id || t.provenance.sceneRunSegments?.some((s) => s.cueId === cue.id)))
    : [];
  const undecidedForSpeaker = cue
    ? sceneLines.filter((c) =>
        c.speaker === cue.speaker && (c.voiceSource ?? 'performance') === 'performance'
        && !c.selectedTakeId && !c.selectedRenderId && !c.locked).length
    : 0;
  const selectedTake = cue?.selectedTakeId ? takes.find((t) => t.id === cue.selectedTakeId) ?? null : null;
  const render = cue?.selectedRenderId && dialogue
    ? dialogue.voiceRenders.find((r) => r.id === cue.selectedRenderId) ?? null
    : null;

  // Conversions of the selected take: the same performance in the character's
  // voice. Newest last, because each attempt appends rather than replaces.
  const conversions = cue && dialogue && selectedTake
    ? dialogue.voiceRenders.filter((r) => r.source.kind === 'voice-conversion' && r.source.takeId === selectedTake.id
        && r.source.sourceCueId === cue.id)
    : [];
  // Output from a build with a since-fixed defect is not something to warn
  // about — it is something to never hand back. A conversion counts only when
  // the runtime that made it is the runtime running now.
  const current = (r: VoiceRender) => !conversionRuntime
    || r.model.settings['runtimeFingerprint'] === conversionRuntime;
  const readyConversion = [...conversions].reverse()
    .find((r) => r.state === 'ready' && r.audio && current(r)) ?? null;
  const supersededConversion = !readyConversion
    && conversions.some((r) => r.state === 'ready' && r.audio && !current(r));
  const latestConversion = conversions[conversions.length - 1] ?? null;
  const rejectedConversion = latestConversion?.state === 'rejected' ? latestConversion : null;
  const convertedInUse = Boolean(render && render.source.kind === 'voice-conversion' && current(render));
  const staleInUse = Boolean(render && render.source.kind === 'voice-conversion' && !current(render));
  const voiceName = speakerRig ?? cue?.speaker ?? 'the character';
  /** B side of the A/B: the conversion in use, or the latest one waiting to be. */
  const bRender = render ?? readyConversion;
  const conversionNote = staleInUse
    ? `This line is playing a conversion from an older build. Press “Convert again” to remake it with ${voiceName}'s voice.`
    : rejectedConversion
      ? `${voiceName} conversion rejected — ${(rejectedConversion.quality.flags[0] ?? 'it failed the duration, cadence and signal checks').replace(/\.$/, '')}. Your recording is untouched.`
      : supersededConversion
        ? `${voiceName}'s earlier conversion came from an older build and is no longer offered. Convert again.`
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
      : which === 'b' && bRender
        ? `/api/scenes/${scene}/dialogue/renders/${bRender.id}/audio`
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
    save(next);
  };

  const framesFor = (ms: number) => Math.max(1, Math.round((ms / 1000) * (dialogue?.fps ?? 24)));

  /** Every cue write goes through here, so a rejected save is visible rather than silent. */
  const save = (next: DialogueCue) => {
    setError(null);
    void onSaveCue(next).catch((err: Error) => setError(err.message));
  };

  /** Play the raw recording again. The conversion stays, reselectable. */
  const useMyVoice = () => {
    if (!cue || !selectedTake) return;
    const segment = selectedTake.provenance.sceneRunSegments?.find((s) => s.cueId === cue.id) ?? null;
    const trimBack = segment
      ? { inMs: segment.inMs, outMs: segment.outMs, speechOnsetMs: segment.speechOnsetMs, speechEndMs: segment.speechEndMs }
      : { inMs: 0, outMs: selectedTake.audio.durationMs, speechOnsetMs: 0, speechEndMs: selectedTake.audio.durationMs };
    save({
      ...cue,
      selectedRenderId: null,
      trim: trimBack,
      durationFrames: framesFor(trimBack.outMs - trimBack.inMs),
      approval: cue.approval.state === 'approved'
        ? { ...cue.approval, state: 'candidate', at: null }
        : cue.approval,
    });
  };

  /** Reselect a conversion already on disk, without paying for the model again. */
  const useCharacterVoice = () => {
    if (!cue || !readyConversion?.audio) return;
    const { durationMs } = readyConversion.audio;
    const map = readyConversion.alignment.sourceToOutput;
    save({
      ...cue,
      selectedRenderId: readyConversion.id,
      trim: {
        inMs: 0,
        outMs: durationMs,
        speechOnsetMs: Math.min(durationMs, map[1]?.outputMs ?? 0),
        speechEndMs: Math.min(durationMs, map[2]?.outputMs ?? durationMs),
      },
      durationFrames: framesFor(durationMs),
      approval: cue.approval.state === 'approved'
        ? { ...cue.approval, state: 'candidate', at: null }
        : cue.approval,
    });
  };

  const approved = cue?.approval.state === 'approved';

  /**
   * Approving locks the line, the same as the booth's "Approve and lock" — an
   * approval that leaves the line unlocked still reads as unfinished to
   * production preflight, which is a blocker with no visible cause.
   *
   * Withdrawing has to unlock first: the engine only accepts an unlock as a
   * save of its own, so folding both into one write made the button look dead.
   * Failures land on the header instead of vanishing.
   */
  const toggleApprove = () => {
    if (!cue) return;
    void (async () => {
      try {
        setError(null);
        if (!approved) {
          await onSaveCue({
            ...cue,
            locked: true,
            approval: { ...cue.approval, state: 'approved', by: 'local-creator', at: new Date().toISOString() },
          });
          return;
        }
        if (cue.locked) await onSaveCue({ ...cue, locked: false });
        await onSaveCue({
          ...cue,
          locked: false,
          approval: { ...cue.approval, state: 'candidate', by: null, at: null },
        });
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  };

  const qc = selectedTake?.quality ?? null;
  const trim = cue?.trim ?? (selectedTake
    ? { inMs: 0, outMs: selectedTake.audio.durationMs, speechOnsetMs: 0, speechEndMs: selectedTake.audio.durationMs }
    : null);

  return (
    <div className="h-[196px] shrink-0 flex flex-col bg-stage border-t border-edge min-h-0">
      <div className="h-6 shrink-0 flex items-center gap-2 px-[9px] border-b border-[#2f353d]">
        <span className="text-[10px] tracking-[.09em] uppercase text-ink-faint">Take</span>
        {cue && (
          <>
            <span
              title="The line this strip records onto. Pick a different line in the Lines pane."
              className="text-[9px] tracking-[.07em] uppercase border rounded-[2px] px-[5px] py-px shrink-0"
              style={{ color: speakerFg, borderColor: speakerFg }}
            >
              {cue.speaker}
            </span>
            <span className="text-[10px] text-ink-dim truncate max-w-64" title={cue.displayText}>“{cue.displayText}”</span>
          </>
        )}
        <Mono className="text-ink-ghost shrink-0">
          {selectedTake
            ? `take ${takes.indexOf(selectedTake) + 1} of ${takes.length} · ${(selectedTake.audio.durationMs / 1000).toFixed(2)} s · ${(selectedTake.audio.sampleRate / 1000).toFixed(0)} kHz ${selectedTake.audio.channels === 1 ? 'mono' : 'stereo'}`
            : takes.length ? `${takes.length} take${takes.length === 1 ? '' : 's'} — none selected` : 'no takes yet'}
        </Mono>
        <div className="flex-1" />
        {(error ?? conversionNote) && (
          <span className="text-[10px] text-bad truncate max-w-64" title={error ?? conversionNote ?? ''}>{error ?? conversionNote}</span>
        )}
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
                try {
                  setError(null);
                  await onSaveCue({ ...cue, trim: next });
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          ) : cue?.voiceSource === 'generated' ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <div className="text-[11px] text-[#a8b6d4] leading-[1.5]">
                <span className="text-gen">◇</span> Character voice — this line is synthesized from {cue.speaker}'s seeded
                voice{cue.approval.state === 'approved' ? ', approved and locked' : ''}. It regenerates identically on every render.
              </div>
              <button
                type="button"
                title="Go back to performing this line yourself — unlocks it and clears the generated-voice decision."
                onClick={() => {
                  void (async () => {
                    try {
                      setError(null);
                      // A locked cue may only be unlocked in its own save; the
                      // decision change follows in a second revision.
                      if (cue.locked) await onSaveCue({ ...cue, locked: false });
                      await onSaveCue({
                        ...cue,
                        locked: false,
                        voiceSource: 'performance',
                        approval: { ...cue.approval, state: 'draft', by: null, at: null },
                      });
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  })();
                }}
                className="h-[22px] px-2.5 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10px] cursor-pointer hover:text-ink"
              >
                Switch to performed voice
              </button>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <div className="text-[11px] text-ink-ghost leading-relaxed">
                {cue
                  ? `No audio chosen for this line. Perform it yourself — and re-voice the take as ${voiceName} if you want your delivery in the character's voice — or let ${cue.speaker} speak with the character's own generated voice.`
                  : 'Select a line in the Lines pane.'}
              </div>
              {cue && (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    title={`Approve the generated character voice for this line. It synthesizes deterministically from ${cue.speaker}'s voice reference — no recording needed.`}
                    onClick={() => onUseGenerated('line')}
                    className="h-6 px-2.5 rounded-[3px] border border-gen/60 bg-gen/15 text-[#a8b6d4] text-[10.5px] cursor-pointer hover:bg-gen/25"
                  >
                    ◇ Use character voice
                  </button>
                  {undecidedForSpeaker > 1 && (
                    <button
                      type="button"
                      title={`Approve the generated character voice for all ${undecidedForSpeaker} undecided ${cue.speaker} lines in one step.`}
                      onClick={() => onUseGenerated('speaker')}
                      className="h-6 px-2.5 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer hover:text-ink"
                    >
                      …for all {undecidedForSpeaker} {cue.speaker} lines
                    </button>
                  )}
                </div>
              )}
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

          <div className="flex flex-wrap gap-1 max-h-[56px] overflow-y-auto">
            {takes.map((take, i) => {
              const on = cue?.selectedTakeId === take.id;
              const segment = take.provenance.sceneRunSegments?.find((s) => s.cueId === cue?.id) ?? null;
              const segQuality = segment?.quality ?? (take.capture.mode === 'scene-run' ? null : take.quality);
              const rejected = segQuality?.verdict === 'reject';
              const chipMs = segment ? segment.outMs - segment.inMs : take.audio.durationMs;
              return (
                <div
                  key={take.id}
                  className={`h-6 rounded-[3px] border text-[10px] flex items-stretch overflow-hidden ${
                    on ? 'bg-accent/20 border-accent text-accent' : rejected ? 'bg-bad/10 border-bad/40 text-[#8c6f72]' : 'bg-panel-2 border-edge text-ink-dim'
                  }`}
                  style={{ minWidth: 64 }}
                >
                  <button
                    type="button"
                    disabled={cue?.locked || (!on && rejected)}
                    title={cue?.locked
                      ? 'This line is approved and locked. Withdraw the approval to change what it plays.'
                      : on
                      ? 'Selected. Click to unselect — the line goes back to “no take chosen”.'
                      : rejected
                        ? 'This segment failed capture QC and cannot be selected. Discard it, or record another take.'
                        : segment
                          ? `Use this Scene Run segment (${(chipMs / 1000).toFixed(2)}s slice of a ${(take.audio.durationMs / 1000).toFixed(1)}s run) for this line`
                          : `Use take ${i + 1} for this line`}
                    onClick={() => {
                      if (!cue) return;
                      const trim = segment
                        ? { inMs: segment.inMs, outMs: segment.outMs, speechOnsetMs: segment.speechOnsetMs, speechEndMs: segment.speechEndMs }
                        : { inMs: 0, outMs: take.audio.durationMs, speechOnsetMs: 0, speechEndMs: take.audio.durationMs };
                      save(on
                        ? {
                            ...cue,
                            selectedTakeId: null,
                            trim: null,
                            approval: cue.approval.state === 'approved'
                              ? { ...cue.approval, state: 'draft', by: null, at: null }
                              : cue.approval,
                          }
                        : {
                            ...cue,
                            selectedTakeId: take.id,
                            selectedRenderId: null,
                            trim,
                            approval: { ...cue.approval, state: 'candidate', at: null },
                          });
                    }}
                    className="flex-1 px-1.5 cursor-pointer flex flex-col items-center justify-center leading-[1.15] hover:text-ink disabled:cursor-not-allowed"
                  >
                    <span>{segment ? `Run ${i + 1}` : `Take ${i + 1}`}</span>
                    <span className="font-mono text-[8px] opacity-70">{(chipMs / 1000).toFixed(2)}s{rejected ? ' · qc' : ''}</span>
                  </button>
                  <button
                    type="button"
                    title={`Discard take ${i + 1} — removes the recording from this scene`}
                    onClick={() => onDiscardTake(take.id)}
                    className="w-[16px] border-l border-[rgba(255,255,255,.06)] text-ink-faint cursor-pointer hover:text-bad hover:bg-bad/10"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {!takes.length && <div className="flex-1 h-6 rounded-[3px] border border-dashed border-edge grid place-items-center text-[9px] text-ink-ghost">no takes recorded</div>}
          </div>

          {/*
            The character-voice step. Conversion keeps the performance — timing,
            pauses, emphasis — and replaces only vocal identity, so it belongs
            beside the take it converts rather than buried in the booth. Each
            state names its own way forward: no target voice yet, nothing to
            convert, convert, or already converted.
          */}
          <div className="px-[7px] py-[5px] border border-gen/40 bg-gen/10 rounded-[3px] flex flex-col gap-[5px]">
            {!castVoiceBound ? (
              <button
                type="button"
                disabled={!cue}
                title={`Conversion re-voices your recording as ${voiceName} — your timing, pauses and delivery are kept, only the vocal identity changes. ${voiceName} has no voice reference to convert to yet; roll or record one in the cast editor.`}
                onClick={() => onOpenCastEditor(speakerRig)}
                className="h-[22px] rounded-[3px] border border-gen/60 bg-gen/15 text-[#a8b6d4] text-[10.5px] cursor-pointer hover:bg-gen/25 disabled:opacity-40"
              >
                ◈ Give {voiceName} a voice…
              </button>
            ) : converting ? (
              <div className="h-[22px] rounded-[3px] border border-gen/60 bg-gen/15 text-[#a8b6d4] text-[10.5px] grid place-items-center">
                ◈ Converting…
              </div>
            ) : convertedInUse ? (
              <button
                type="button"
                disabled={cue?.locked}
                title={`Playing in ${voiceName}'s voice, performed by you. Click to go back to your own recording — the conversion stays and can be reselected.`}
                onClick={useMyVoice}
                className="h-[22px] rounded-[3px] border border-gen bg-gen/25 text-[#c5d0e6] text-[10.5px] cursor-pointer hover:bg-gen/35 disabled:opacity-40"
              >
                ◈ {voiceName}’s voice · use mine
              </button>
            ) : staleInUse ? (
              <button
                type="button"
                disabled={cue?.locked}
                title={`This line is playing a conversion made by an older build of the converter. Remake it with the current one.`}
                onClick={onConvert}
                className="h-[22px] rounded-[3px] border border-accent bg-accent/20 text-accent text-[10.5px] cursor-pointer hover:bg-accent/30 disabled:opacity-40"
              >
                ◈ Convert again — older build
              </button>
            ) : (
              <button
                type="button"
                disabled={!selectedTake || cue?.locked}
                title={cue?.locked
                  ? 'This line is approved and locked. Withdraw the approval to change what it plays.'
                  : !selectedTake
                    ? 'Record or select a take first — conversion re-voices a performance, it does not invent one.'
                    : readyConversion
                    ? `Switch to the conversion already made from this take: your performance in ${voiceName}'s voice.`
                    : `Re-voice this take as ${voiceName}: your timing, pauses, emphasis and emotion are kept exactly; only the vocal identity changes. The original take is never altered.`}
                onClick={readyConversion ? useCharacterVoice : onConvert}
                className="h-[22px] rounded-[3px] border border-gen/60 bg-gen/15 text-[#a8b6d4] text-[10.5px] cursor-pointer hover:bg-gen/25 disabled:opacity-40"
              >
                ◈ {readyConversion ? `Use ${voiceName}’s voice` : `Speak as ${voiceName}`}
              </button>
            )}

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!cue}
                title="Follow Performance lets the line run as long as you performed it. Off, it is fitted to the locked picture window instead."
                onClick={toggleFollow}
                className="w-[26px] h-[15px] rounded-lg border relative cursor-pointer shrink-0 p-0 disabled:opacity-40"
                style={{ borderColor: follow ? '#7a8fc0' : '#363d46', background: follow ? 'rgba(122,143,192,.4)' : '#2b3138' }}
              >
                <span
                  className="absolute top-px w-[11px] h-[11px] rounded-full transition-[left] duration-100"
                  style={{ left: follow ? 12 : 1, background: follow ? '#c5d0e6' : '#6b737d' }}
                />
              </button>
              <span className="flex-1 text-[10px] text-[#a8b6d4] leading-[1.3] truncate">
                Follow Performance
                <span className="text-ink-faint">{follow ? ' · your timing rules' : ' · fit to picture'}</span>
              </span>
              {onScoreAcrossCast && (
                <button
                  type="button"
                  title="Convert this take into every cast voice and score each result — voicing kept, register hit. Runs the conversion model per character."
                  onClick={onScoreAcrossCast}
                  className="h-[18px] px-1.5 rounded-[2px] border border-gen/50 text-[#a8b6d4] text-[9px] cursor-pointer hover:bg-gen/15 shrink-0"
                >
                  score vs cast
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-[5px] mt-auto">
            <button
              type="button"
              disabled={!selectedTake}
              title={bRender
                ? `A is your recording, B is the same performance in ${voiceName}’s voice. Click to alternate.`
                : 'A: your recording. There is no B until this take is converted to the character’s voice.'}
              onClick={() => playAB(abPlaying === 'a' || !bRender ? 'a' : 'b')}
              className={`flex-1 h-6 rounded-[3px] border text-[10px] cursor-pointer disabled:opacity-40 ${
                abPlaying ? 'bg-accent/15 border-accent/50 text-accent' : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
              }`}
            >
              {abPlaying === 'a' ? '■ A' : abPlaying === 'b' ? '■ B' : 'A / B'}
            </button>
            <button
              type="button"
              disabled={!cue || (!selectedTake && !approved)}
              title={approved
                ? 'Approved and locked. Click to withdraw — the line unlocks and the take stays selected as a candidate.'
                : 'Approve what this line plays and lock it to picture. Production preflight only counts locked approvals.'}
              onClick={toggleApprove}
              className={`flex-1 h-6 rounded-[3px] border text-[10px] cursor-pointer disabled:opacity-40 ${
                approved
                  ? 'border-lock bg-lock/20 text-[#cbb87e] hover:bg-lock/30'
                  : 'border-good bg-good/20 text-[#8fbd76] hover:bg-good/30'
              }`}
            >
              {approved ? '✓ Approved · withdraw' : 'Approve'}
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
