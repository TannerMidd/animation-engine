import { useEffect, useRef, useState } from 'react';
import { api, followJob, toBase64 } from '../api.ts';
import type { DialogueCue, DialogueDocument } from '../types.ts';
import { Badge, Button, Empty, Field, NumberInput, Select, Spinner, TextInput } from './ui.tsx';
import { WaveformEditor } from './WaveformEditor.tsx';

const QUALITY_WARNING_ACK_PREFIX = 'Creator reviewed automated quality warnings for selected asset ';

function cuePlaybackDurationMs(cue: DialogueCue, document: DialogueDocument): number | null {
  if (cue.durationPolicy.mode !== 'follow-performance' && cue.durationPolicy.targetFrames) {
    return (cue.durationPolicy.targetFrames / document.fps) * 1000;
  }
  if (cue.trim) return cue.trim.outMs - cue.trim.inMs;
  const render = cue.selectedRenderId
    ? document.voiceRenders.find((item) => item.id === cue.selectedRenderId)
    : null;
  if (render?.audio) return render.audio.durationMs;
  const take = cue.selectedTakeId
    ? document.recordedTakes.find((item) => item.id === cue.selectedTakeId)
    : null;
  if (take) return take.audio.durationMs;
  return cue.durationFrames ? (cue.durationFrames / document.fps) * 1000 : null;
}

export function PerformancePanel({
  scene, cue, document, context, sceneRun, onReload, onSaveCue,
}: {
  scene: string;
  cue: DialogueCue | null;
  document: DialogueDocument | null;
  context?: { audioUrl: string; startMs: number; endMs: number } | null;
  sceneRun?: { audioUrl: string; beatStarts: number[]; durationMs: number } | null;
  onReload: () => Promise<void>;
  onSaveCue: (cue: DialogueCue) => Promise<void>;
}) {
  const [spokenText, setSpokenText] = useState('');
  const [intent, setIntent] = useState('');
  const [deliveryExpression, setDeliveryExpression] = useState('NEUTRAL');
  const [consentId, setConsentId] = useState('');
  const [consentSubject, setConsentSubject] = useState('creator-owned target voice');
  const [consentBasis, setConsentBasis] = useState<'self-owned' | 'written-license' | 'performer-contract' | 'synthetic-owned'>('self-owned');
  const [consentScope, setConsentScope] = useState<'target-voice' | 'performance' | 'both'>('both');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [performerId, setPerformerId] = useState('creator');
  const [registerPolicy, setRegisterPolicy] = useState<'preserve-performer' | 'adapt-to-character'>('adapt-to-character');
  const [conversionSeed, setConversionSeed] = useState(1);
  const [recording, setRecording] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [runRecording, setRunRecording] = useState(false);
  const [runCountIn, setRunCountIn] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [latencyCompensationMs, setLatencyCompensationMs] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [timingValidation, setTimingValidation] = useState<string | null>(null);
  const [qualityWarningsAcknowledged, setQualityWarningsAcknowledged] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<number | null>(null);
  const stopJob = useRef<(() => void) | null>(null);
  const contextAudio = useRef<HTMLAudioElement | null>(null);
  const runAudio = useRef<HTMLAudioElement | null>(null);
  const contextTimer = useRef<number | null>(null);
  const countInTimer = useRef<number | null>(null);

  const selectedQualityAssetId = cue?.selectedRenderId ?? cue?.selectedTakeId ?? null;
  const qualityAcknowledgementNote = selectedQualityAssetId
    ? `${QUALITY_WARNING_ACK_PREFIX}"${selectedQualityAssetId}".`
    : null;

  useEffect(() => {
    setSpokenText(cue?.spokenText ?? '');
    setIntent(cue?.delivery.intent ?? '');
    setDeliveryExpression(cue?.delivery.expression ?? 'NEUTRAL');
    setConversionSeed(((cue?.beatIndex ?? 0) + 1) * 1000 + 1);
    setWarnings([]);
    setTimingValidation(null);
    setError(null);
  }, [cue?.delivery.expression, cue?.delivery.intent, cue?.id, cue?.spokenText]);

  useEffect(() => {
    setQualityWarningsAcknowledged(Boolean(
      qualityAcknowledgementNote && cue?.approval.notes.includes(qualityAcknowledgementNote),
    ));
  }, [cue?.approval.notes, cue?.id, qualityAcknowledgementNote]);

  useEffect(() => () => {
    stopJob.current?.();
    if (ticker.current !== null) window.clearInterval(ticker.current);
    if (contextTimer.current !== null) window.clearTimeout(contextTimer.current);
    if (countInTimer.current !== null) window.clearTimeout(countInTimer.current);
    contextAudio.current?.pause();
    runAudio.current?.pause();
    recorder.current?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  if (!cue || !document) return <Empty>Select a dialogue line to perform it</Empty>;

  const takes = document.recordedTakes.filter((take) => (
    take.cueId === cue.id || take.provenance.sceneRunSegments?.some((segment) => segment.cueId === cue.id)
  ));
  const renders = document.voiceRenders.filter((render) =>
    render.source.kind !== 'draft-tts' && (!render.source.takeId || takes.some((take) => take.id === render.source.takeId)));
  const selectedRender = cue.selectedRenderId
    ? document.voiceRenders.find((render) => render.id === cue.selectedRenderId && render.audio)
    : null;
  const selectedTake = cue.selectedTakeId
    ? document.recordedTakes.find((take) => take.id === cue.selectedTakeId)
    : null;
  const selectedTakeSegment = selectedTake?.provenance.sceneRunSegments?.find((segment) => segment.cueId === cue.id) ?? null;
  const selectedTakeQuality = selectedTakeSegment?.quality ?? (selectedTake?.capture.mode === 'scene-run' ? null : selectedTake?.quality);
  const takeQualityWarnings = selectedTakeQuality?.verdict === 'warn'
    ? (selectedTakeQuality.flags.length ? selectedTakeQuality.flags : ['Selected performance take requires human quality review.'])
    : [];
  const renderQualityWarnings = selectedRender?.quality.verdict === 'warn'
    ? (selectedRender.quality.flags.length ? selectedRender.quality.flags : ['Selected character render requires human quality review.'])
    : [];
  const selectedQualityWarnings = [...new Set([...takeQualityWarnings, ...renderQualityWarnings])];
  const selectedQualityRejected = selectedTakeQuality?.verdict === 'reject' || selectedRender?.quality.verdict === 'reject';
  const selectedQualityMissing = Boolean(selectedTake && !selectedTakeQuality);
  const selectedAsset = selectedRender?.audio ?? selectedTake?.audio ?? null;
  const selectedConsent = document.consents.find((item) => item.id === consentId.trim()) ?? null;
  const consentBaseActive = Boolean(
    selectedConsent && !selectedConsent.revokedAt &&
    (!selectedConsent.expiresAt || Date.parse(selectedConsent.expiresAt) > Date.now()),
  );
  const targetConsentActive = Boolean(
    consentBaseActive && selectedConsent?.permits.voiceConversion && selectedConsent.permits.distribution &&
    (selectedConsent.scope === 'target-voice' || selectedConsent.scope === 'both') && selectedConsent.referenceChecksum,
  );
  const performanceConsentActive = Boolean(
    consentBaseActive && selectedConsent?.permits.distribution &&
    (selectedConsent.scope === 'performance' || selectedConsent.scope === 'both'),
  );
  const selectedAudioUrl = selectedRender?.audio
    ? `/api/scenes/${scene}/dialogue/renders/${selectedRender.id}/audio`
    : selectedTake
      ? `/api/scenes/${scene}/dialogue/takes/${selectedTake.id}/audio`
      : null;
  const earlierDialogueCue = [...document.cues]
    .filter((item) => item.beatIndex < cue.beatIndex)
    .sort((a, b) => b.beatIndex - a.beatIndex)[0] ?? null;
  // The compiler requires the overlap target to be both the preceding dialogue
  // cue and the immediately preceding scene beat. An intervening pause/action
  // has its own clock interval and therefore makes an overlap unavailable.
  const previousCue = earlierDialogueCue?.beatIndex === cue.beatIndex - 1 ? earlierDialogueCue : null;
  const previousCueDurationMs = previousCue ? cuePlaybackDurationMs(previousCue, document) : null;
  const maxInterruptMs = previousCueDurationMs === null
    ? null
    : Math.max(0, Math.ceil(previousCueDurationMs) - 1);
  const storedOverlapValidation = cue.overlap && !previousCue
    ? 'Overlap is invalid: the immediately preceding scene beat is not a dialogue cue. Clear it before saving timing.'
    : cue.overlap && cue.overlap.withCueId !== previousCue?.id
      ? `Overlap is invalid: it targets "${cue.overlap.withCueId}" instead of the immediately preceding dialogue cue.`
      : cue.overlap && cue.startFrame > 0
        ? 'A cue cannot combine an absolute start frame with overlap timing.'
        : cue.overlap?.mode === 'interruption' && cue.overlap.interruptAtMs !== null && (
          previousCueDurationMs === null || cue.overlap.interruptAtMs <= 0 || cue.overlap.interruptAtMs >= previousCueDurationMs
        )
          ? `Interruption must be 1-${maxInterruptMs ?? '?'} ms inside the preceding cue, or 0 to let it continue underneath.`
          : null;
  const runCues = document.cues
    .filter((item) => item.speaker === cue.speaker && !item.locked)
    .sort((a, b) => a.beatIndex - b.beatIndex);
  const activeRunCue = runRecording
    ? [...runCues].reverse().find((item) => (sceneRun?.beatStarts[item.beatIndex] ?? Infinity) <= elapsed * 1000) ?? null
    : null;

  const saveDurationPolicy = (patch: Partial<DialogueCue['durationPolicy']>) => {
    const next = { ...cue.durationPolicy, ...patch };
    if (next.mode !== 'follow-performance' && next.targetFrames === null) {
      next.targetFrames = cue.durationFrames ?? Math.max(1, Math.round(((cue.trim?.outMs ?? 1000) - (cue.trim?.inMs ?? 0)) / 1000 * document.fps));
    }
    if (next.mode === 'follow-performance') next.targetFrames = null;
    void saveFields({ durationPolicy: next });
  };

  const saveFields = async (patch: Partial<DialogueCue>) => {
    if (cue.locked && patch.locked !== false) {
      setError('This performance is locked. Unlock it before changing timing, text, or selection.');
      return;
    }
    setBusy('saving');
    setError(null);
    try {
      await onSaveCue({ ...cue, ...patch });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveOverlapMode = (mode: string) => {
    setTimingValidation(null);
    if (mode === 'none') {
      void saveFields({ overlap: null });
      return;
    }
    if (!previousCue) {
      setTimingValidation('Overlap requires a dialogue cue on the immediately preceding scene beat.');
      return;
    }
    if (cue.startFrame > 0) {
      setTimingValidation('Clear the absolute start frame before adding overlap timing.');
      return;
    }
    if (mode === 'interruption' && (maxInterruptMs === null || maxInterruptMs < 1)) {
      setTimingValidation('The preceding cue has no reviewed playback duration to place an interruption inside.');
      return;
    }
    const nextMode = mode as 'pickup' | 'overlap' | 'interruption';
    const existingCut = cue.overlap?.mode === 'interruption' ? cue.overlap.interruptAtMs : null;
    const interruptAtMs = nextMode === 'interruption' && existingCut !== null && maxInterruptMs !== null &&
      existingCut >= 1 && existingCut <= maxInterruptMs
      ? existingCut
      : null;
    void saveFields({
      overlap: {
        withCueId: previousCue.id,
        mode: nextMode,
        ms: cue.overlap?.ms ?? 120,
        interruptAtMs,
      },
    });
  };

  const saveInterruptionPoint = (value: number) => {
    const interruptAtMs = Math.round(value);
    if (interruptAtMs <= 0) {
      setTimingValidation(null);
      void saveFields({ overlap: { ...cue.overlap!, interruptAtMs: null } });
      return;
    }
    if (previousCueDurationMs === null || maxInterruptMs === null || interruptAtMs > maxInterruptMs) {
      setTimingValidation(
        `The cut must be inside the preceding cue: 1-${maxInterruptMs ?? '?'} ms, or 0 to leave it running underneath.`,
      );
      return;
    }
    setTimingValidation(null);
    void saveFields({ overlap: { ...cue.overlap!, interruptAtMs } });
  };

  const upload = async (blob: Blob, filename: string, inputDevice: string | null, countInMs = 0) => {
    setBusy('uploading performance');
    setError(null);
    setWarnings([]);
    try {
      const result = await api.uploadPerformance(scene, cue.id, {
        dataBase64: await toBase64(blob),
        filename,
        mode: 'line-booth',
        performerId: performerId.trim() || null,
        consentId: consentId.trim() || null,
        inputDevice,
        countInMs,
      });
      setWarnings(result.capture.warnings);
      await onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uploadSceneRun = async (blob: Blob, filename: string, inputDevice: string | null) => {
    if (!sceneRun || !runCues.length) return;
    setBusy('segmenting Scene Run');
    setError(null);
    setWarnings([]);
    try {
      const segments = runCues.map((item) => ({
        cueId: item.id,
        inMs: sceneRun.beatStarts[item.beatIndex] ?? 0,
        outMs: sceneRun.beatStarts[item.beatIndex + 1] ?? sceneRun.durationMs,
      }));
      const result = await api.uploadSceneRun(scene, {
        dataBase64: await toBase64(blob),
        filename,
        speaker: cue.speaker,
        segments,
        performerId: performerId.trim() || null,
        consentId: consentId.trim() || null,
        inputDevice,
        latencyCompensationMs: Math.round(latencyCompensationMs),
        countInMs: 700,
      });
      setWarnings(result.capture.warnings);
      await onReload();
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
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      rec.onstop = () => {
        if (ticker.current !== null) window.clearInterval(ticker.current);
        ticker.current = null;
        setRecording(false);
        const label = stream.getAudioTracks()[0]?.label || null;
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        void upload(blob, 'performance.webm', label, 700);
      };
      recorder.current = rec;
      setCountIn(true);
      setBusy('count-in');
      countInTimer.current = window.setTimeout(() => {
        countInTimer.current = null;
        rec.start();
        const started = performance.now();
        setElapsed(0);
        ticker.current = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
        setCountIn(false);
        setBusy(null);
        setRecording(true);
      }, 700);
    } catch (err) {
      setError(`could not open the microphone: ${(err as Error).message}`);
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
  };

  const startSceneRun = async () => {
    if (!sceneRun || !runCues.length) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const guide = new Audio(`/api/scenes/${scene}/dialogue/guide/${encodeURIComponent(cue.speaker)}`);
      guide.preload = 'auto';
      guide.currentTime = 0;
      runAudio.current = guide;
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      rec.onstop = () => {
        if (ticker.current !== null) window.clearInterval(ticker.current);
        ticker.current = null;
        guide.pause();
        setRunRecording(false);
        const label = stream.getAudioTracks()[0]?.label || null;
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        void uploadSceneRun(blob, 'scene-run.webm', label);
      };
      guide.onended = () => {
        if (rec.state !== 'inactive') rec.stop();
      };
      recorder.current = rec;
      setRunCountIn(true);
      setBusy('scene count-in');
      countInTimer.current = window.setTimeout(() => {
        countInTimer.current = null;
        rec.start();
        void guide.play().catch((err: unknown) => {
          setError(`could not play the Scene Run guide: ${(err as Error).message}`);
          if (rec.state !== 'inactive') rec.stop();
        });
        const started = performance.now();
        setElapsed(0);
        ticker.current = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
        setRunCountIn(false);
        setBusy(null);
        setRunRecording(true);
      }, 700);
    } catch (err) {
      setRunCountIn(false);
      setBusy(null);
      setError(`could not start the Scene Run: ${(err as Error).message}`);
    }
  };

  const stopSceneRun = () => {
    runAudio.current?.pause();
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
    recorder.current = null;
  };

  const playContext = () => {
    if (!context) return;
    if (contextTimer.current !== null) window.clearTimeout(contextTimer.current);
    contextAudio.current?.pause();
    const player = new Audio(context.audioUrl);
    contextAudio.current = player;
    player.currentTime = Math.max(0, context.startMs / 1000);
    void player.play().catch((err: unknown) => setError(`could not play scene context: ${(err as Error).message}`));
    contextTimer.current = window.setTimeout(() => player.pause(), Math.max(100, context.endMs - context.startMs));
  };

  const convert = async () => {
    if (!cue.selectedTakeId) return;
    if (!consentId.trim()) {
      setError('Enter the target voice consent/rights record before conversion.');
      return;
    }
    if (!targetConsentActive) {
      setError('Select or register an active consent record that permits voice conversion and distribution.');
      return;
    }
    setBusy('converting');
    setError(null);
    try {
      const job = await api.convertPerformance(scene, cue.id, {
        takeId: cue.selectedTakeId,
        consentId: consentId.trim(),
        registerPolicy,
        seed: conversionSeed,
      });
      stopJob.current?.();
      stopJob.current = followJob(job.id, (event) => {
        if (event.type === 'progress') setBusy(event.stage ?? 'converting');
        if (event.type === 'error') {
          stopJob.current?.();
          setBusy(null);
          setError(event.message ?? 'voice conversion failed');
        }
        if (event.type === 'done') {
          stopJob.current?.();
          setBusy(null);
          setConversionSeed((value) => value + 1);
          void onReload();
        }
      });
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  };

  const registerConsent = async () => {
    if (!consentId.trim() || !consentSubject.trim()) {
      setError('Consent ID and rights holder/subject are required.');
      return;
    }
    if (!rightsConfirmed) {
      setError('Confirm that you own or have permission to use this target voice.');
      return;
    }
    setBusy('registering consent');
    setError(null);
    try {
      await api.registerVoiceConsent(scene, cue.id, {
        id: consentId.trim(),
        subject: consentSubject.trim(),
        basis: consentBasis,
        scope: consentScope,
        distribution: true,
        training: false,
        confirmed: true,
      });
      setRightsConfirmed(false);
      await onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revokeConsent = async () => {
    if (!selectedConsent || selectedConsent.revokedAt) return;
    setBusy('revoking consent');
    setError(null);
    try {
      await api.revokeVoiceConsent(scene, selectedConsent.id);
      await onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const chooseTake = (id: string) => {
    const take = takes.find((item) => item.id === id);
    if (!take) return;
    const segment = take.provenance.sceneRunSegments?.find((item) => item.cueId === cue.id);
    const quality = segment?.quality ?? (take.capture.mode === 'scene-run' ? null : take.quality);
    if (quality?.verdict === 'reject') {
      setError('This exact performance segment failed capture QC. Select or record another take.');
      return;
    }
    const trim = segment
      ? {
          inMs: segment.inMs,
          outMs: segment.outMs,
          speechOnsetMs: segment.speechOnsetMs,
          speechEndMs: segment.speechEndMs,
        }
      : { inMs: 0, outMs: take.audio.durationMs, speechOnsetMs: 0, speechEndMs: take.audio.durationMs };
    setQualityWarningsAcknowledged(false);
    void saveFields({
      selectedTakeId: id,
      selectedRenderId: null,
      trim,
      durationFrames: Math.max(1, Math.round(((trim.outMs - trim.inMs) / 1000) * document.fps)),
      approval: { ...cue.approval, state: 'candidate', at: null },
    });
  };

  const chooseRender = (id: string) => {
    const render = renders.find((item) => item.id === id && item.audio);
    if (!render?.audio) return;
    setQualityWarningsAcknowledged(false);
    void saveFields({
      selectedTakeId: render.source.takeId ?? cue.selectedTakeId,
      selectedRenderId: id,
      trim: { inMs: 0, outMs: render.audio.durationMs, speechOnsetMs: 0, speechEndMs: render.audio.durationMs },
      durationFrames: Math.max(1, Math.round((render.audio.durationMs / 1000) * document.fps)),
      approval: { ...cue.approval, state: 'candidate', at: null },
    });
  };

  return (
    <div className="p-3 space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Badge>{cue.speaker}</Badge>
          <Badge tone={cue.approval.state === 'approved' ? 'good' : cue.approval.state === 'rejected' ? 'bad' : 'warn'}>
            {cue.approval.state}
          </Badge>
        </div>
        <div className="text-[12px] text-ink-dim leading-snug">{cue.displayText}</div>
      </div>

      <Field label="Spoken text" hint="Synthesis/performance punctuation can differ from the displayed script.">
        <div className="flex gap-1">
          <TextInput value={spokenText} onChange={setSpokenText} disabled={cue.locked} />
          <Button disabled={cue.locked || busy === 'saving' || !spokenText.trim()} onClick={() => void saveFields({ spokenText })}>Save</Button>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Performer ID"><TextInput value={performerId} onChange={setPerformerId} /></Field>
        <Field label="Rights record ID" hint="Capture needs performance rights; conversion also needs target-voice rights.">
          <TextInput value={consentId} onChange={setConsentId} placeholder="creator-owned-voice" />
        </Field>
      </div>

      {consentId.trim() && selectedConsent && !performanceConsentActive && (
        <div className="text-[10px] text-warn">This record does not cover the performed source. You can record locally, but production preflight will block it.</div>
      )}

      <div className="rounded border border-edge p-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint flex-1">Voice and performance rights</div>
          {selectedConsent && (
            <div className="flex gap-1">
              <Badge tone={performanceConsentActive ? 'good' : 'bad'}>performance {performanceConsentActive ? 'active' : 'blocked'}</Badge>
              <Badge tone={targetConsentActive ? 'good' : 'bad'}>target {targetConsentActive ? 'active' : 'blocked'}</Badge>
            </div>
          )}
        </div>
        {selectedConsent ? (
          <div className="space-y-1">
            <div className="text-[10px] text-ink-dim">
              {selectedConsent.subject} · {selectedConsent.basis} · reference {selectedConsent.referenceChecksum?.slice(0, 10) ?? 'unbound'}
            </div>
            {!selectedConsent.revokedAt && (
              <Button variant="danger" disabled={!!busy} onClick={() => void revokeConsent()}>Revoke permission</Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Rights holder / subject">
                <TextInput value={consentSubject} onChange={setConsentSubject} />
              </Field>
              <Field label="Permission basis">
                <Select value={consentBasis} options={['self-owned', 'written-license', 'performer-contract', 'synthetic-owned']} onChange={(value) => setConsentBasis(value as typeof consentBasis)} />
              </Field>
              <Field label="Rights scope">
                <Select value={consentScope} options={['both', 'performance', 'target-voice']} onChange={(value) => setConsentScope(value as typeof consentScope)} />
              </Field>
            </div>
            <label className="flex items-start gap-2 text-[10px] text-ink-dim">
              <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
              I confirm the selected performance/target voice rights are mine or licensed for distribution and, when selected, voice conversion. Target-voice rights bind to the current reference-file checksum; training permission stays off.
            </label>
            <Button disabled={!!busy || !rightsConfirmed || !consentId.trim()} onClick={() => void registerConsent()}>
              Register permission
            </Button>
          </>
        )}
      </div>

      <div className="flex gap-1">
        {context && (
          <Button disabled={recording || runRecording || !!busy} onClick={playContext} title="Play the preceding exchange before performing this line">
            ▶ Context
          </Button>
        )}
        {recording ? (
          <Button variant="danger" className="flex-1" onClick={stopRecording}>■ Stop {elapsed.toFixed(1)}s</Button>
        ) : (
          <Button variant="primary" className="flex-1" disabled={cue.locked || runRecording || !!busy} onClick={() => void startRecording()}>
            {countIn ? 'Get ready…' : '● Record performance'}
          </Button>
        )}
        <label className={`px-2.5 py-1 rounded border border-edge bg-panel-2 text-[12px] ${busy ? 'opacity-40' : 'cursor-pointer hover:bg-edge'}`}>
          Import…
          <input
            className="hidden"
            type="file"
            accept="audio/*"
            disabled={cue.locked || !!busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file, file.name, null, 0);
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {sceneRun && runCues.length > 0 && (
        <div className="rounded border border-edge p-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-faint">Scene Run · {cue.speaker}</div>
              <div className="text-[10px] text-ink-dim">Perform all {runCues.length} unlocked lines against the full scene guide. Use headphones.</div>
            </div>
            {runRecording ? (
              <Button variant="danger" onClick={stopSceneRun}>■ Stop {elapsed.toFixed(1)}s</Button>
            ) : (
              <Button disabled={recording || !!busy} onClick={() => void startSceneRun()}>
                {runCountIn ? 'Get ready…' : '● Record character run'}
              </Button>
            )}
          </div>
          {activeRunCue && (
            <div className="rounded bg-panel-2 p-2">
              <div className="text-[10px] uppercase text-accent mb-1">Now · {activeRunCue.speaker}</div>
              <div className="text-[12px] text-ink">{activeRunCue.displayText}</div>
            </div>
          )}
          <div className="h-1 rounded bg-panel-2 overflow-hidden">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, (elapsed * 1000 / Math.max(1, sceneRun.durationMs)) * 100)}%` }}
            />
          </div>
          <Field label="Capture latency correction ms" hint="Positive values shift the recorded segments later to compensate measured mic/input delay.">
            <NumberInput
              disabled={runRecording || runCountIn || !!busy}
              value={latencyCompensationMs}
              min={-500}
              max={1000}
              step={5}
              onChange={(value) => setLatencyCompensationMs(Math.round(value))}
            />
          </Field>
          <div className="text-[10px] text-ink-faint">The original continuous take remains immutable; each line receives editable, nondestructive segment trims.</div>
        </div>
      )}

      {takes.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Performance takes</div>
          <div className="space-y-1.5">
            {takes.map((take, index) => {
              const segment = take.provenance.sceneRunSegments?.find((item) => item.cueId === cue.id) ?? null;
              const quality = segment?.quality ?? (take.capture.mode === 'scene-run' ? null : take.quality);
              const durationMs = segment ? segment.outMs - segment.inMs : take.audio.durationMs;
              return (
                <div key={take.id} className={`rounded border p-1.5 ${cue.selectedTakeId === take.id ? 'border-accent' : 'border-edge'}`}>
                  <div className="flex items-center gap-1 mb-1">
                    <button
                      className="text-[11px] text-left flex-1 disabled:opacity-50"
                      disabled={cue.locked || quality?.verdict === 'reject'}
                      onClick={() => chooseTake(take.id)}
                      title={quality?.verdict === 'reject' ? 'This exact Scene Run segment failed capture QC and cannot be selected.' : undefined}
                    >
                      Take {index + 1} · {(durationMs / 1000).toFixed(2)}s{segment ? ' segment' : ''}
                    </button>
                    {cue.selectedTakeId === take.id && <Badge tone="good">selected</Badge>}
                    {quality ? (
                      <Badge tone={quality.verdict === 'pass' ? 'good' : quality.verdict === 'reject' ? 'bad' : 'warn'}>
                        {segment ? 'segment' : 'capture'} {quality.verdict}
                      </Badge>
                    ) : (
                      <Badge tone="bad">{segment ? 'segment' : 'capture'} QC missing</Badge>
                    )}
                  </div>
                  <audio controls src={`/api/scenes/${scene}/dialogue/takes/${take.id}/audio`} className="w-full h-7" />
                  {(quality?.flags ?? (segment ? ['This Scene Run segment has no structured QC report.'] : take.provenance.notes)).map((note) => (
                    <div key={note} className="text-[10px] text-accent mt-1">{note}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {cue.selectedTakeId && (
        <div className="rounded border border-edge p-2">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Register">
              <Select disabled={cue.locked} value={registerPolicy} options={['adapt-to-character', 'preserve-performer']} onChange={(value) => setRegisterPolicy(value as typeof registerPolicy)} />
            </Field>
            <Field label="Candidate seed" hint="Incremented after each successful conversion.">
              <NumberInput
                disabled={cue.locked || !!busy}
                value={conversionSeed}
                min={0}
                max={2_147_483_647}
                onChange={(value) => setConversionSeed(Math.max(0, Math.round(value)))}
              />
            </Field>
            <div className="flex items-end pb-2.5">
              <Button className="w-full" disabled={cue.locked || !!busy || !targetConsentActive} onClick={() => void convert()}>
                {busy?.includes('convert') ? <><Spinner /> Converting…</> : 'Convert to character'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {renders.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Character renders</div>
          <div className="text-[10px] text-ink-faint mb-1.5">
            Automated conversion QC checks signal level, clipping, speech ratio, duration, and energy-envelope cadence.
            It does not verify the transcript, target-speaker identity, or phonemes; audition every candidate before approval.
          </div>
          <div className="space-y-1.5">
            {renders.map((render) => (
              <div key={render.id} className={`rounded border p-1.5 ${cue.selectedRenderId === render.id ? 'border-accent' : 'border-edge'}`}>
                <div className="flex items-center gap-1 mb-1">
                  <button className="text-[11px] text-left flex-1 disabled:opacity-50" disabled={cue.locked || !render.audio || render.state !== 'ready'} onClick={() => chooseRender(render.id)}>
                    {render.id}
                  </button>
                  <Badge tone={render.quality.verdict === 'pass' ? 'good' : render.quality.verdict === 'reject' ? 'bad' : 'warn'}>
                    {render.quality.verdict}
                  </Badge>
                </div>
                {render.audio && <audio controls src={`/api/scenes/${scene}/dialogue/renders/${render.id}/audio`} className="w-full h-7" />}
                <div className="text-[10px] text-ink-faint mt-1">
                  {render.model.engine} · {render.model.revision.includes('@')
                    ? render.model.revision
                    : `unverified model revision: ${render.model.revision}`}
                  {typeof render.model.settings['runtimeFingerprint'] === 'string'
                    ? ` · runtime ${render.model.settings['runtimeFingerprint'].slice(0, 10)}`
                    : ''}
                  {render.quality.cadenceSimilarity !== null ? ` · cadence proxy ${render.quality.cadenceSimilarity.toFixed(2)}` : ''}
                </div>
                {render.quality.flags.map((flag) => <div key={flag} className="text-[10px] text-accent mt-1">{flag}</div>)}
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedAsset && selectedAudioUrl && cue.trim && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Trim and speech boundaries</div>
          <WaveformEditor
            url={selectedAudioUrl}
            durationMs={selectedAsset.durationMs}
            trim={cue.trim}
            disabled={cue.locked || !!busy}
            onSave={async (trim) => saveFields({
              trim,
              durationFrames: Math.max(1, Math.round(((trim.outMs - trim.inMs) / 1000) * document.fps)),
              approval: { ...cue.approval, state: 'candidate', at: null },
            })}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Pickup ms" hint="Starts this line before its neutral response point.">
          <NumberInput disabled={cue.locked || !!busy} value={cue.pickupMs} min={0} max={3000} onChange={(pickupMs) => void saveFields({ pickupMs: Math.round(pickupMs) })} />
        </Field>
        <Field label="Response gap ms">
          <NumberInput disabled={cue.locked || !!busy} value={cue.turnGapMs} min={0} max={4000} onChange={(turnGapMs) => void saveFields({ turnGapMs: Math.round(turnGapMs) })} />
        </Field>
        <Field label="Pause after ms">
          <NumberInput disabled={cue.locked || !!busy} value={cue.pauseAfterMs} min={0} max={8000} onChange={(pauseAfterMs) => void saveFields({ pauseAfterMs: Math.round(pauseAfterMs) })} />
        </Field>
        <Field
          label="Overlap previous line"
          hint={previousCue
            ? `Immediate previous cue: ${previousCue.speaker} · ${Math.round(previousCueDurationMs ?? 0)} ms reviewed window`
            : 'Unavailable: the immediately preceding scene beat is not dialogue'}
        >
          <Select
            disabled={cue.locked || !!busy}
            value={cue.overlap?.mode ?? 'none'}
            options={['none', 'pickup', 'overlap', 'interruption']}
            onChange={saveOverlapMode}
          />
        </Field>
      </div>

      {cue.overlap && (
        <div className="grid grid-cols-2 gap-2 rounded border border-edge p-2">
          <Field label="Overlap amount ms">
            <NumberInput
              disabled={cue.locked || !!busy || Boolean(storedOverlapValidation)}
              value={cue.overlap.ms}
              min={1}
              max={4000}
              onChange={(ms) => {
                setTimingValidation(null);
                void saveFields({ overlap: { ...cue.overlap!, ms: Math.max(1, Math.round(ms)) } });
              }}
            />
          </Field>
          {cue.overlap.mode === 'interruption' && (
            <Field
              label="Cut previous at ms"
              hint={`0 keeps it underneath; a cut must be 1-${maxInterruptMs ?? '?'} ms.`}
            >
              <NumberInput
                disabled={cue.locked || !!busy || Boolean(storedOverlapValidation && cue.overlap.withCueId !== previousCue?.id)}
                value={cue.overlap.interruptAtMs ?? 0}
                min={0}
                max={maxInterruptMs ?? 0}
                onChange={saveInterruptionPoint}
              />
            </Field>
          )}
        </div>
      )}

      {(timingValidation ?? storedOverlapValidation) && (
        <div className="rounded border border-bad/40 bg-bad/10 p-2 flex items-center gap-2">
          <div className="text-[10px] text-bad flex-1">{timingValidation ?? storedOverlapValidation}</div>
          {cue.overlap && (
            <Button disabled={cue.locked || !!busy} onClick={() => {
              setTimingValidation(null);
              void saveFields({ overlap: null });
            }}>
              Clear overlap
            </Button>
          )}
        </div>
      )}

      <div className="rounded border border-edge p-2 space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Performance direction</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Intent">
            <TextInput
              disabled={cue.locked || !!busy}
              value={intent}
              placeholder="restrained disbelief"
              onChange={setIntent}
              onBlur={() => {
                if (intent !== cue.delivery.intent) void saveFields({ delivery: { ...cue.delivery, intent } });
              }}
            />
          </Field>
          <Field label="Expression">
            <TextInput
              disabled={cue.locked || !!busy}
              value={deliveryExpression}
              onChange={setDeliveryExpression}
              onBlur={() => {
                if (deliveryExpression !== cue.delivery.expression) {
                  void saveFields({ delivery: { ...cue.delivery, expression: deliveryExpression } });
                }
              }}
            />
          </Field>
          <Field label="Energy">
            <NumberInput
              disabled={cue.locked || !!busy}
              value={cue.delivery.energy}
              min={0.1}
              max={2}
              step={0.05}
              onChange={(energy) => void saveFields({ delivery: { ...cue.delivery, energy } })}
            />
          </Field>
          <Field label="Pace">
            <NumberInput
              disabled={cue.locked || !!busy}
              value={cue.delivery.pace}
              min={0.5}
              max={2}
              step={0.05}
              onChange={(pace) => void saveFields({ delivery: { ...cue.delivery, pace } })}
            />
          </Field>
        </div>
      </div>

      <div className="rounded border border-edge p-2 space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Timing policy</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Picture behavior">
            <Select
              disabled={cue.locked || !!busy}
              value={cue.durationPolicy.mode}
              options={['follow-performance', 'fit-locked-window', 'rerecord-to-picture']}
              onChange={(mode) => saveDurationPolicy({ mode: mode as DialogueCue['durationPolicy']['mode'] })}
            />
          </Field>
          <Field label="Downstream animation">
            <Select
              disabled={cue.locked || !!busy}
              value={cue.durationPolicy.downstream}
              options={['ripple', 'retime-attached-motion', 'preserve-absolute']}
              onChange={(downstream) => saveDurationPolicy({ downstream: downstream as DialogueCue['durationPolicy']['downstream'] })}
            />
          </Field>
          {cue.durationPolicy.mode !== 'follow-performance' && (
            <Field label="Target frames" hint={`${document.fps} fps; fitting is rejected if voiced material would exceed the policy limit.`}>
              <NumberInput
                disabled={cue.locked || !!busy}
                value={cue.durationPolicy.targetFrames ?? cue.durationFrames ?? 1}
                min={1}
                max={10000}
                onChange={(targetFrames) => saveDurationPolicy({ targetFrames: Math.max(1, Math.round(targetFrames)) })}
              />
            </Field>
          )}
          <Field label="Absolute start frame" hint="0 follows conversational timing; a positive frame pins this cue and clears overlap.">
            <NumberInput
              disabled={cue.locked || !!busy}
              value={cue.startFrame}
              min={0}
              max={100000}
              step={1}
              onChange={(startFrame) => void saveFields({
                startFrame: Math.max(0, Math.round(startFrame)),
                ...(startFrame > 0 ? { overlap: null } : {}),
              })}
            />
          </Field>
        </div>
        <div className="text-[10px] text-ink-faint">
          Follow Performance ripples the scene clock. Fit Locked Window only accepts safe, alignment-aware changes. Re-record never warps the performance.
        </div>
      </div>

      {cue.locked ? (
        <Button
          className="w-full"
          disabled={!!busy}
          onClick={() => void saveFields({
            locked: false,
            approval: { ...cue.approval, state: 'candidate', at: null },
          })}
        >
          Unlock performance for editing
        </Button>
      ) : (cue.selectedTakeId || cue.selectedRenderId) && cue.trim && (
        <div className="space-y-2">
          {selectedQualityMissing && (
            <div className="rounded border border-bad/40 bg-bad/10 p-2 text-[10px] text-bad">
              The selected {selectedTakeSegment ? 'Scene Run segment' : 'take'} has no structured capture QC report and cannot be approved for production.
            </div>
          )}
          {selectedQualityRejected && (
            <div className="rounded border border-bad/40 bg-bad/10 p-2 text-[10px] text-bad">
              The selected asset failed automated capture/conversion QC and cannot be approved. Select another take or render.
            </div>
          )}
          {selectedQualityWarnings.length > 0 && !selectedQualityMissing && !selectedQualityRejected && (
            <label className="rounded border border-accent/40 bg-accent/10 p-2 flex items-start gap-2 text-[10px] text-ink-dim">
              <input
                type="checkbox"
                checked={qualityWarningsAcknowledged}
                onChange={(event) => setQualityWarningsAcknowledged(event.target.checked)}
              />
              <span>
                I auditioned the source and selected result and accept the {selectedQualityWarnings.length} unresolved quality
                warning{selectedQualityWarnings.length === 1 ? '' : 's'}. This acknowledgement will be stored with the cue approval;
                it does not turn the acoustic checks into transcript, speaker-identity, or phoneme verification.
              </span>
            </label>
          )}
          <div className="grid grid-cols-3 gap-1">
            <Button
              variant="primary"
              className="col-span-2"
              disabled={!!busy || selectedQualityMissing || selectedQualityRejected || (selectedQualityWarnings.length > 0 && !qualityWarningsAcknowledged)}
              title={selectedQualityWarnings.length > 0 && !qualityWarningsAcknowledged ? 'Acknowledge the unresolved quality warnings after auditioning this asset.' : undefined}
              onClick={() => void saveFields({
                approval: {
                  state: 'approved',
                  by: performerId.trim() || 'creator',
                  at: new Date().toISOString(),
                  notes: [
                    ...cue.approval.notes.filter((note) => !note.startsWith(QUALITY_WARNING_ACK_PREFIX)),
                    ...(selectedQualityWarnings.length > 0 && qualityAcknowledgementNote ? [qualityAcknowledgementNote] : []),
                  ],
                },
                locked: true,
              })}
            >
              Approve and lock performance
            </Button>
            <Button
              variant="danger"
              disabled={!!busy}
              onClick={() => void saveFields({
                approval: {
                  state: 'rejected',
                  by: performerId.trim() || 'creator',
                  at: new Date().toISOString(),
                  notes: ['Rejected during line-booth review'],
                },
              })}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {busy && <div className="text-[11px] text-ink-dim flex items-center gap-2"><Spinner /> {busy}</div>}
      {warnings.map((warning) => <div key={warning} className="text-[11px] text-accent">{warning}</div>)}
      {error && <div className="text-[11px] text-bad">{error}</div>}
    </div>
  );
}
