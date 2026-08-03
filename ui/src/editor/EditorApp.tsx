import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, followJob } from '../api.ts';
import type {
  AnimationDocument, Beat, CastMember, CastSummary, CheckResult, DialogueCue, DialogueDocument, Health,
  JobEvent, LlmStatus, PreviewInfo, ProductionPreflightReport, SceneDetail, SceneSummary, SetDescriptor,
  SetSummary, ShotList, ShowInfo, Vocab,
} from '../types.ts';
import { GenerateDialog } from '../components/GenerateDialog.tsx';
import type { AnimationEditTarget, StagePropTarget } from '../components/AnimationOverlay.tsx';
import { propInstanceId } from './stage/interaction.ts';
import { AppBar, type ContextTool, type SaveState } from './AppBar.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Inspector } from './Inspector.tsx';
import { Timeline } from './Timeline.tsx';
import { StageColumn, type OverlayPrefs, type StageHandle } from './stage/StageColumn.tsx';
import { ExportStrip, ShotStrip, TakeStrip } from './stage/strips.tsx';
import { LinesPane, MixerPane, ReadinessPane, ScriptPane, subPaneWidth } from './panes.tsx';
import { CommandPalette, ConfirmDialog, PreflightPopover, type Command, type ConfirmSpec } from './overlays.tsx';
import { Mono, Spinner } from './chrome.tsx';
import {
  beatStartsFor, cueForBeat, defaultTabFor, fmtTimecode, motionDeletionBlocker, speakerColour, totalMsFor,
  withoutMotionSegment, type InspectorTab, type Mode,
} from './lib.ts';

type Quality = 'Draft' | 'Accurate' | 'Final';

/**
 * The production editor: one scene, six modes, one selected thing.
 *
 * Two loops, deliberately different speeds. Editing the script re-checks on a
 * debounce and rebuilds an estimated preview — instant, no TTS. Editing a beat
 * writes the shot list and rebuilds too. Only Voices and Render cost real
 * time, and both are explicit jobs with progress.
 */
export function EditorApp({
  scene, scenes, cast, sets, vocab, health, show, llm, expressionsFor,
  onScene, onSceneChanged, onNewScene, onOpenCast, onOpenSets,
}: {
  scene: string;
  scenes: SceneSummary[];
  cast: CastSummary[];
  sets: SetSummary[];
  vocab: Vocab | null;
  health: Health | null;
  show: ShowInfo | null;
  llm: LlmStatus | null;
  expressionsFor: (actorId: string) => string[];
  onScene: (name: string) => void;
  onSceneChanged: () => void;
  onNewScene: () => void;
  onOpenCast: (name: string | null) => void;
  onOpenSets: (name: string | null) => void;
}) {
  const [mode, setModeRaw] = useState<Mode>('write');
  const [tab, setTab] = useState<InspectorTab>('beat');
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [source, setSource] = useState('');
  const [shots, setShots] = useState<ShotList | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [dialogue, setDialogue] = useState<DialogueDocument | null>(null);
  const [animation, setAnimation] = useState<AnimationDocument | null>(null);
  const [preflight, setPreflight] = useState<ProductionPreflightReport | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [setDescriptor, setSetDescriptor] = useState<SetDescriptor | null>(null);
  const [animationTarget, setAnimationTarget] = useState<AnimationEditTarget | null>(null);
  const [selectedMotionId, setSelectedMotionId] = useState<string | null>(null);
  const [quality, setQuality] = useState<Quality>('Accurate');
  const [layout, setLayout] = useState<'16:9' | '9:16'>('16:9');
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<{ kind: string; event: JobEvent | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rec, setRec] = useState(false);
  const [cmd, setCmd] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [writing, setWriting] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ state: 'saved', agoS: 0 });
  const [prefs, setPrefsState] = useState<OverlayPrefs>({
    grid: false, safe: true, snap: true, onion: true, path: true,
    marks: true, walkable: true, props: true, selection: true, captions: true,
  });

  const stageRef = useRef<StageHandle>(null);
  const editCount = useRef(0);
  const savedAt = useRef<number | null>(Date.now());

  const setPrefs = (patch: Partial<OverlayPrefs>) => setPrefsState((p) => ({ ...p, ...patch }));

  const withAudio = quality !== 'Draft' && Boolean(detail?.hasAudio);
  const previewLayout = mode === 'publish' && layout === '9:16' ? 'vertical' : 'horizontal';
  const setName = shots?.set ? shots.set.replace(/\.(json|svg)$/, '') : sets[0]?.name ?? 'office';

  const setMode = useCallback((next: Mode) => {
    setModeRaw(next);
    setTab(defaultTabFor(next));
    if (next !== 'animate') setAnimationTarget(null);
  }, []);

  // Tab→mode: the Motion tab implies animate mode, so the stage mounts the
  // drag surface and swaps to animate chrome (mirrors Timeline motion clicks).
  const selectTab = useCallback((next: InspectorTab) => {
    setTab(next);
    if (next === 'motion') setModeRaw('animate');
  }, []);

  // --- load on scene change ---
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setSelected(null);
    setError(null);
    setDialogue(null);
    setAnimation(null);
    setAnimationTarget(null);
    setSelectedMotionId(null);
    setPreflight(null);
    setPlayheadMs(0);
    accurateBroken.current = false;
    void (async () => {
      try {
        const d = await api.scene(scene);
        if (cancelled) return;
        setDetail(d);
        setSource(d.source);
        setShots(d.shots);
        setSave({ state: 'saved', agoS: 0 });
        savedAt.current = Date.now();
        editCount.current = 0;
        if (d.shots) {
          const [dialogueDocument, animationDocument] = await Promise.all([api.dialogue(scene), api.animation(scene)]);
          if (cancelled) return;
          dialogueRevision.current = dialogueDocument.revision;
          setDialogue(dialogueDocument);
          setAnimation(animationDocument);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scene]);

  // Set descriptor follows whatever set the shot list names.
  useEffect(() => {
    let cancelled = false;
    setSetDescriptor(null);
    if (!setName) return () => { cancelled = true; };
    void api.set(setName)
      .then((descriptor) => { if (!cancelled) setSetDescriptor(descriptor); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [setName]);

  // --- preview rebuilds whenever its inputs change ---
  // Once the accurate (voice-engine) path fails, stop asking it on every edit;
  // a struggling GPU does not get healthier by being hammered. Voices resets it.
  const accurateBroken = useRef(false);
  const rebuildPreview = useCallback(async () => {
    const wantAudio = withAudio && !accurateBroken.current;
    try {
      setPreview(await api.preview(scene, wantAudio, previewLayout));
      setError(null);
    } catch (err) {
      // The accurate path needs the voice engine; when it is busy or stale the
      // estimated preview is still true to the picture. Fall back and say so.
      if (wantAudio) {
        accurateBroken.current = true;
        try {
          setPreview(await api.preview(scene, false, previewLayout));
          setInfo(`Accurate preview unavailable (${(err as Error).message}). Showing estimated timing — run Voices to refresh the mix.`);
          return;
        } catch (fallbackErr) {
          setError((fallbackErr as Error).message);
          return;
        }
      }
      setError((err as Error).message);
    }
  }, [scene, withAudio, previewLayout]);

  useEffect(() => {
    if (!shots) return;
    const t = setTimeout(() => void rebuildPreview(), 120);
    return () => clearTimeout(t);
  }, [shots, rebuildPreview]);

  // --- debounced save + check while typing ---
  useEffect(() => {
    if (!detail || source === detail.source) return;
    setPreflight(null);
    editCount.current += 1;
    setSave({ state: 'dirty', edits: editCount.current });
    const t = setTimeout(() => {
      void (async () => {
        try {
          setSave({ state: 'saving' });
          await api.saveScript(scene, source);
          setDetail((d) => (d ? { ...d, source } : d));
          savedAt.current = Date.now();
          editCount.current = 0;
          setSave({ state: 'saved', agoS: 0 });
          setCheck(await api.check(scene, { source, set: setName }));
        } catch (err) {
          setSave({ state: 'failed', reason: (err as Error).message });
        }
      })();
    }, 500);
    return () => clearTimeout(t);
  }, [source, detail, scene, setName]);

  // Keep the "Saved Ns ago" label honest without re-rendering every frame.
  useEffect(() => {
    const t = setInterval(() => {
      setSave((s) => (s.state === 'saved' && savedAt.current
        ? { state: 'saved', agoS: Math.round((Date.now() - savedAt.current) / 1000) }
        : s));
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // --- preflight runs automatically; it is milliseconds, renders are minutes ---
  useEffect(() => {
    if (!shots) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setPreflightBusy(true);
    const t = setTimeout(() => {
      void api.preflight(scene)
        .then((report) => { if (!cancelled) setPreflight(report); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setPreflightBusy(false); });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [scene, shots, dialogue, animation]);

  const beatStarts = useMemo(() => beatStartsFor(shots, preview?.beatStarts), [shots, preview]);
  const totalMs = useMemo(() => totalMsFor(shots, beatStarts, preview?.durationMs), [shots, beatStarts, preview]);
  const selectedBeat: Beat | null = selected === null ? null : shots?.beats[selected] ?? null;

  const selectBeat = useCallback((index: number, seek = true) => {
    setSelectedMotionId(null);
    setSelected(index);
    if (seek) {
      const ms = beatStarts[index];
      if (ms !== undefined) stageRef.current?.seekMs(ms + 40);
    }
  }, [beatStarts]);

  const selectVoice = useCallback((index: number) => {
    selectBeat(index);
    setTab('voice');
    if (mode !== 'perform') setModeRaw('perform');
  }, [selectBeat, mode]);

  // --- write-through edits ---
  /**
   * The revision the next cue write must claim.
   *
   * A render-scoped copy goes stale the moment two saves run back to back —
   * unlocking a cue and then editing it, for instance — because the second
   * call is issued before React has committed the first result. The ref is
   * updated by the write itself, so sequences land instead of colliding.
   */
  const dialogueRevision = useRef<number | undefined>(undefined);

  const reloadDialogue = useCallback(async () => {
    setPreflight(null);
    const document = await api.dialogue(scene);
    dialogueRevision.current = document.revision;
    setDialogue(document);
  }, [scene]);

  /**
   * Shot-list writes are serialized. Two quick edits are two PUTs; letting
   * them race means the slower (older) payload can land last and quietly
   * clobber the newer one on disk.
   */
  const saveChain = useRef(Promise.resolve());
  const pushShots = useCallback((make: (current: ShotList) => ShotList, refreshDialogue: boolean) => {
    setPreflight(null);
    setShots((current) => {
      if (!current) return current;
      const updated = make(current);
      saveChain.current = saveChain.current
        .then(() => api.saveShotList(scene, updated))
        .then(() => (refreshDialogue ? reloadDialogue() : undefined))
        .catch((err: Error) => setError(err.message));
      return updated;
    });
  }, [scene, reloadDialogue]);

  const editBeat = useCallback((index: number, next: Beat) => {
    pushShots((current) => ({ ...current, beats: current.beats.map((b, i) => (i === index ? next : b)) }), true);
  }, [pushShots]);

  const editCastMember = useCallback((actorId: string, changes: Partial<CastMember>) => {
    pushShots((current) => ({
      ...current,
      cast: current.cast.map((member) => (member.id === actorId ? { ...member, ...changes } : member)),
    }), false);
  }, [pushShots]);

  const saveDialogueCue = useCallback(async (cue: DialogueCue) => {
    setPreflight(null);
    const result = await api.saveDialogueCue(scene, cue, dialogueRevision.current);
    dialogueRevision.current = result.revision;
    await reloadDialogue();
    void rebuildPreview();
  }, [scene, reloadDialogue, rebuildPreview]);

  /**
   * Discard a recorded take, via the engine's revocation operation: the row
   * stays on disk as immutable audit evidence, but it leaves every working
   * surface — the take list, any cue selection and trim, conversions derived
   * from it, and approvals that stood on those.
   */
  const discardTake = useCallback((takeId: string) => {
    if (!dialogue) return;
    const take = dialogue.recordedTakes.find((t) => t.id === takeId);
    if (!take) return;
    const affected = dialogue.cues.find((c) => c.id === take.cueId);
    const runCueIds = new Set((take.provenance.sceneRunSegments ?? []).map((s) => s.cueId));
    const runLines = dialogue.cues.filter((c) => runCueIds.has(c.id));
    setConfirm({
      title: take.capture.mode === 'scene-run' ? 'Discard this Scene Run?' : 'Discard this take?',
      body: take.capture.mode === 'scene-run'
        ? `The continuous ${take.speaker} run is revoked. ${runLines.length ? `Its segments cover ${runLines.length} line${runLines.length === 1 ? '' : 's'} (“${runLines[0]!.displayText.slice(0, 50)}${runLines.length > 1 ? '…” and more' : '…”'}); each` : 'Each line using it'} falls back to “no take chosen”.`
        : affected
          ? `The recording for ${affected.speaker} — “${affected.displayText.slice(0, 80)}${affected.displayText.length > 80 ? '…' : ''}” — is revoked: it leaves the take list, and any selection, conversion or approval built on it is cleared.`
          : 'The recording is revoked: it leaves the take list, and any selection, conversion or approval built on it is cleared.',
      list: [
        { tag: 'KEEPS', fg: '#7a8fc0', text: 'The audio stays on disk as an immutable audit record.' },
        { tag: 'RESETS', fg: '#c8834a', text: 'Lines using this take fall back to “no take chosen”.' },
      ],
      ok: 'Discard take',
      okTone: 'bad',
      onOk: () => {
        void (async () => {
          try {
            setPreflight(null);
            await api.revokeTake(scene, takeId);
            await reloadDialogue();
            void rebuildPreview();
          } catch (err) {
            setError((err as Error).message);
          }
        })();
      },
    });
  }, [dialogue, scene, reloadDialogue, rebuildPreview]);

  /** Booth opens the Voice tab; the flash is the "something happened" signal. */
  const [voiceFlash, setVoiceFlash] = useState(0);
  const openBooth = useCallback(() => {
    setTab('voice');
    setVoiceFlash((n) => n + 1);
  }, []);

  /**
   * Approve the character's generated voice — the explicit decision that "no
   * recording" is intentional. Approved and locked like any performance, so
   * it clears the production gate the same way.
   */
  const useGenerated = useCallback((cue: DialogueCue | null, scope: 'line' | 'speaker') => {
    if (!dialogue || !cue) return;
    const decide = (c: DialogueCue): DialogueCue => ({
      ...c,
      voiceSource: 'generated',
      selectedTakeId: null,
      selectedRenderId: null,
      trim: null,
      approval: {
        ...c.approval,
        state: 'approved',
        by: 'local-creator',
        at: new Date().toISOString(),
        notes: [...c.approval.notes, 'generated character voice approved'],
      },
      locked: true,
    });
    void (async () => {
      try {
        setPreflight(null);
        if (scope === 'line') {
          const result = await api.saveDialogueCue(scene, decide(cue), dialogueRevision.current);
          dialogueRevision.current = result.revision;
        } else {
          const eligible = (c: DialogueCue) =>
            c.speaker === cue.speaker && (c.voiceSource ?? 'performance') === 'performance'
            && !c.selectedTakeId && !c.selectedRenderId && !c.locked;
          await api.saveDialogue(scene, {
            ...dialogue,
            cues: dialogue.cues.map((c) => (eligible(c) ? decide(c) : c)),
          });
        }
        await reloadDialogue();
        void rebuildPreview();
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [dialogue, scene, reloadDialogue, rebuildPreview]);

  /**
   * Speak a recorded take in the character's voice.
   *
   * The performance stays the performance: timing, pauses, emphasis and
   * emotion come from the recording, and only vocal identity is replaced. The
   * engine binds every conversion to a rights record naming the target voice,
   * so the first conversion for a scene asks for that affirmation and registers
   * it in the same step rather than sending the creator hunting for a form.
   */
  const convertToCharacter = useCallback((cue: DialogueCue | null) => {
    if (!cue || !dialogue || !shots || !cue.selectedTakeId) return;
    const takeId = cue.selectedTakeId;
    const rigName = shots.cast.find((m) => m.id === cue.speaker)?.rig ?? cue.speaker;
    if (!cast.find((c) => c.name === rigName)?.voiceRef) return;

    const run = async (consentId: string) => {
      setBusy('convert');
      setJob({ kind: 'convert', event: null });
      setError(null);
      setPreflight(null);
      try {
        const started = await api.convertPerformance(scene, cue.id, {
          takeId,
          consentId,
          registerPolicy: 'adapt-to-character',
        });
        const stop = followJob(started.id, (e) => {
          setJob({ kind: 'convert', event: e });
          if (e.type !== 'done' && e.type !== 'error') return;
          stop();
          setBusy(null);
          setJob(null);
          if (e.type === 'error') {
            setError(e.message ?? 'voice conversion failed');
            return;
          }
          void reloadDialogue().then(() => rebuildPreview());
        });
      } catch (err) {
        setBusy(null);
        setJob(null);
        setError((err as Error).message);
      }
    };

    const existing = dialogue.consents.find((c) => (
      !c.revokedAt && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()) &&
      c.permits.voiceConversion && c.permits.distribution &&
      (c.scope === 'target-voice' || c.scope === 'both') && c.referenceChecksum
    ));
    if (existing) {
      void run(existing.id);
      return;
    }

    setConfirm({
      title: `Speak this take in ${rigName}’s voice?`,
      body: `Your recording stays the performance — timing, pauses, emphasis and emotion are kept exactly as you played them. Only the vocal identity is replaced with ${rigName}’s voice reference. Conversion needs a one-time rights record for that voice, which this registers.`,
      list: [
        { tag: 'CONFIRMS', fg: '#c8834a', text: `${rigName}’s voice and your performance are yours or licensed for distribution. Training permission stays off.` },
        { tag: 'KEEPS', fg: '#7a8fc0', text: 'The original take is untouched and stays selectable — the conversion arrives beside it as a candidate to audition.' },
      ],
      ok: 'I confirm — convert',
      okTone: 'accent',
      onOk: () => {
        void (async () => {
          try {
            const base = `self-owned-${rigName}-voice`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            let id = base;
            for (let n = 2; dialogue.consents.some((c) => c.id === id); n++) id = `${base}-${n}`;
            await api.registerVoiceConsent(scene, cue.id, {
              id,
              subject: 'creator',
              basis: 'self-owned',
              scope: 'both',
              distribution: true,
              training: false,
              confirmed: true,
              notes: [`registered from the take strip to convert ${cue.speaker} performances`],
            });
            await reloadDialogue();
            await run(id);
          } catch (err) {
            setError((err as Error).message);
          }
        })();
      },
    });
  }, [dialogue, shots, cast, scene, reloadDialogue, rebuildPreview]);

  const changeAnimationDocument = useCallback((document: AnimationDocument) => {
    setPreflight(null);
    setAnimation(document);
    void rebuildPreview();
  }, [rebuildPreview]);

  // A stage prop drag edits the SET document, which is shared across scenes.
  const commitPropMove = useCallback(async (prop: StagePropTarget, to: [number, number]) => {
    if (!setDescriptor || busy) return;
    const items = setDescriptor.layers[prop.layer];
    const instance = items?.[prop.index];
    if (!instance || propInstanceId(instance, prop.layer, prop.index) !== prop.id) {
      // The set changed underneath the drag (another editor, a tidy pass) —
      // resync instead of writing to the wrong instance.
      void api.set(setName).then(setSetDescriptor).catch(() => {});
      return;
    }
    setBusy('save-set');
    setError(null);
    try {
      const next: SetDescriptor = {
        ...setDescriptor,
        layers: {
          ...setDescriptor.layers,
          [prop.layer]: items.map((item, index) => (index === prop.index
            ? { ...item, x: Math.round(to[0] * 10) / 10, y: Math.round(to[1] * 10) / 10 }
            : item)),
        },
      };
      await api.saveSet(setName, next);
      setSetDescriptor(next);
      setInfo(`Moved ${prop.prop} in set "${setName}" — shared by every scene that uses it.`);
      void rebuildPreview();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [busy, rebuildPreview, setDescriptor, setName]);

  const deleteMotionSegment = useCallback(async (segmentId: string) => {
    if (!animation || busy) return;
    const blocker = motionDeletionBlocker(animation, segmentId);
    if (blocker) {
      setError(blocker);
      return;
    }
    setBusy('delete-motion');
    setError(null);
    setPreflight(null);
    try {
      const saved = await api.saveAnimation(scene, withoutMotionSegment(animation, segmentId));
      setAnimation(saved.document);
      setSelectedMotionId(null);
      setAnimationTarget(null);
      void rebuildPreview();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [animation, busy, rebuildPreview, scene]);

  const askDeleteMotion = useCallback((segmentId: string) => {
    const segment = animation?.segments.find((item) => item.id === segmentId);
    if (!animation || !segment) {
      setSelectedMotionId(null);
      return;
    }
    const blocker = motionDeletionBlocker(animation, segmentId);
    if (blocker) {
      setError(blocker);
      return;
    }
    setConfirm({
      title: 'Delete this motion segment?',
      body: 'This removes the selected motion clip and both endpoint keys. Every other animation track and segment stays unchanged.',
      list: [{
        tag: 'MOTION',
        fg: '#c8595a',
        text: `${segment.actorId} · ${segment.channel === 'part.transform' ? segment.partId : 'root'} · ${segment.id}`,
      }],
      ok: 'Delete motion',
      okTone: 'bad',
      onOk: () => { void deleteMotionSegment(segmentId); },
    });
  }, [animation, deleteMotionSegment]);

  // --- direct: propose, confirm the diff, apply ---
  const runDirect = useCallback(async () => {
    setBusy('direct');
    setError(null);
    try {
      await api.saveScript(scene, source);
      const res = await api.direct(scene, { source, set: setName });
      const changes = res.diff.filter((d) => d.change !== 'kept-locked');
      const apply = async () => {
        await api.applyDirect(scene, res.proposed);
        setShots(res.proposed);
        setSelected(null);
        const [dialogueDocument, animationDocument] = await Promise.all([api.dialogue(scene), api.animation(scene)]);
        dialogueRevision.current = dialogueDocument.revision;
        setDialogue(dialogueDocument);
        setAnimation(animationDocument);
        setError(res.errors.length ? res.errors.join('; ') : null);
        if (mode === 'write') setMode('direct');
        onSceneChanged();
      };
      if (!shots) {
        await apply();
      } else {
        setConfirm({
          title: 'Apply the director’s proposal?',
          body: 'The proposal is diffed against your shot list before anything is written. Locked beats are excluded from the rerun.',
          list: [
            { tag: 'CHANGES', fg: '#7a8fc0', text: `${changes.length} beat${changes.length === 1 ? '' : 's'} change` },
            ...(res.keptLocked ? [{ tag: 'KEPT', fg: '#a89050', text: `${res.keptLocked} locked beat${res.keptLocked === 1 ? '' : 's'} survive untouched` }] : []),
            ...(res.droppedLocked ? [{ tag: 'DROPPED', fg: '#c8595a', text: `${res.droppedLocked} locked beat${res.droppedLocked === 1 ? '' : 's'} no longer match the script and would be dropped` }] : []),
            ...changes.slice(0, 3).map((d) => ({ tag: d.change.toUpperCase(), fg: '#9aa1ab', text: `beat ${d.index} · ${d.summary}` })),
          ],
          ok: 'Apply proposal',
          okTone: 'accent',
          onOk: () => void apply().catch((err: Error) => setError(err.message)),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [scene, source, setName, shots, mode, setMode, onSceneChanged]);

  // --- long jobs ---
  const runJob = useCallback(async (kind: 'voices' | 'render') => {
    setBusy(kind);
    setJob({ kind, event: null });
    setError(null);
    try {
      const started = kind === 'voices' ? await api.voices(scene) : await api.render(scene);
      const stop = followJob(started.id, (e) => {
        setJob({ kind, event: e });
        if (e.type === 'done' || e.type === 'error') {
          stop();
          setBusy(null);
          if (e.type === 'error') {
            setError(e.message ?? 'job failed');
          } else {
            setJob(null);
            setInfo(kind === 'voices' ? 'Voices rendered — the preview now uses real audio.' : 'Master rendered. Files are in the Export strip.');
            void api.scene(scene).then((d) => {
              setDetail(d);
              if (kind === 'voices') {
                accurateBroken.current = false;
                setQuality((q) => (q === 'Draft' ? 'Accurate' : q));
                void rebuildPreview();
              }
              onSceneChanged();
            });
          }
        }
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      setJob(null);
    }
  }, [scene, onSceneChanged, rebuildPreview]);

  const refreshPreflight = useCallback(async () => {
    setPreflightBusy(true);
    try {
      setPreflight(await api.preflight(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreflightBusy(false);
    }
  }, [scene]);

  const acknowledgeWarnings = useCallback(async () => {
    setPreflightBusy(true);
    try {
      setPreflight(await api.acknowledgePreflightWarnings(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreflightBusy(false);
    }
  }, [scene]);

  const blockers = preflight?.notes.filter((n) => n.level === 'error') ?? [];
  const reviewPending = Boolean(preflight && !preflight.productionBlocked && preflight.warningReview.required && !preflight.warningReview.current);

  const askRenderMaster = useCallback(() => {
    if (!preflight || blockers.length || reviewPending) {
      setConfirm({
        title: 'Render the production master?',
        body: preflight
          ? 'Production render is stricter than preview. These issues must clear before an export can be labelled production-ready.'
          : 'Preflight has not finished yet. Review readiness before rendering.',
        list: blockers.slice(0, 4).map((n) => ({ tag: 'ERROR', fg: '#c8595a', text: n.message })),
        ok: 'Review readiness',
        okTone: 'bad',
        onOk: () => setPreflightOpen(true),
      });
      return;
    }
    setConfirm({
      title: 'Render the production master?',
      body: 'The render consumes one immutable snapshot of the scene. A concurrent edit belongs to the next render, never half of this one.',
      list: [
        { tag: 'STAMPS', fg: '#7a8fc0', text: 'Identity, seed, hashes and provenance land in the export manifest.' },
        { tag: 'RESUMES', fg: '#6f9b5a', text: 'Held frames are skipped; the job resumes if interrupted.' },
      ],
      ok: 'Render master',
      okTone: 'good',
      onOk: () => void runJob('render'),
    });
  }, [preflight, blockers, reviewPending, runJob]);

  const askRenderDraft = useCallback(() => {
    setConfirm({
      title: 'Render a draft with blockers?',
      body: 'Draft renders are a CLI-only diagnostic today: the export manifest is labelled draft and the bundle is not approved for distribution. The server render endpoint always enforces production gates.',
      list: [
        { tag: 'RUN', fg: '#c8834a', text: `npm run anim -- render ${scene} --draft` },
        { tag: 'KEEPS', fg: '#7a8fc0', text: 'Locked beats, approved takes and creator-authored motion are untouched.' },
      ],
      ok: 'Copy command',
      okTone: 'accent',
      onOk: () => {
        void navigator.clipboard?.writeText(`npm run anim -- render ${scene} --draft`).catch(() => {});
        setInfo(`Command copied: npm run anim -- render ${scene} --draft`);
      },
    });
  }, [scene]);

  // --- write from premise ---
  const runWrite = async (premise: string) => {
    setGenBusy(true);
    setGenError(null);
    try {
      const res = await api.generateScript(premise, { targetSeconds: 75 });
      setSource(res.source);
      setWriting(false);
    } catch (err) {
      setGenError((err as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  const runCheck = useCallback(async () => {
    setBusy('check');
    try {
      const res = await api.check(scene, { source, set: setName });
      setCheck(res);
      setInfo(res.errors.length
        ? `Check: ${res.errors.length} error${res.errors.length === 1 ? '' : 's'} — ${res.errors[0]}`
        : `Check passed · ${res.beats.length} beats · ~${(res.estimateMs / 1000).toFixed(1)}s`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [scene, source, setName]);

  // --- identity + quality ---
  const cycleIdentity = useCallback(() => {
    if (!show || show.profiles.length < 2) return;
    const i = show.profiles.findIndex((p) => p.id === show.active.id);
    const next = show.profiles[(i + 1) % show.profiles.length]!;
    setConfirm({
      title: `Switch show identity to ${next.name}?`,
      body: 'Identity governs line treatment, register, wardrobe, acting envelope and cutting rhythm. Switching re-derives everything downstream, so the app reloads.',
      ok: `Switch to ${next.name}`,
      okTone: 'accent',
      onOk: () => {
        void api.setActiveShow(next.id).then(() => window.location.reload());
      },
    });
  }, [show]);

  const cycleQuality = useCallback(() => {
    setQuality((q) => (q === 'Draft' ? 'Accurate' : q === 'Accurate' ? 'Final' : 'Draft'));
  }, []);

  // --- keyboard ---
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        || el.isContentEditable || Boolean(el.closest?.('.cm-editor'));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmd((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        setCmd(false);
        setPreflightOpen(false);
        setConfirm(null);
        return;
      }
      if (isTyping(e.target)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedMotionId) {
        e.preventDefault();
        askDeleteMotion(selectedMotionId);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        stageRef.current?.togglePlay();
      }
      if (e.shiftKey && e.key === 'ArrowLeft') selectBeat(Math.max(0, (selected ?? 1) - 1));
      if (e.shiftKey && e.key === 'ArrowRight') selectBeat(Math.min((shots?.beats.length ?? 1) - 1, (selected ?? -1) + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askDeleteMotion, selected, selectedMotionId, shots, selectBeat]);

  // --- context tools per mode ---
  const tools: ContextTool[] = useMemo(() => {
    switch (mode) {
      case 'write':
        return [
          {
            label: 'Write from premise…', hint: llm?.ok === false ? `Local model unavailable: ${llm.reason ?? 'not running'}` : 'Generate a draft with the local model. It lands unsaved.',
            disabled: llm ? !llm.ok : false, go: () => setWriting(true),
          },
          { label: 'Check', hint: 'Parse, direct and validate. Sub-second, renders nothing.', busy: busy === 'check', go: () => void runCheck() },
          { label: 'Direct →', hint: 'Propose a shot list from this draft.', primary: true, busy: busy === 'direct', go: () => void runDirect() },
        ];
      case 'direct':
        return [
          { label: 'Re-direct…', hint: 'Propose new direction. You confirm the diff before anything is written.', busy: busy === 'direct', go: () => void runDirect() },
          { label: 'Voices', hint: 'Synthesize dialogue and derive Rhubarb mouth cues.', busy: busy === 'voices', disabled: !shots, go: () => void runJob('voices') },
          { label: 'Preflight', hint: 'Check voices, staging, animation, continuity, soundtrack freshness.', go: () => { setPreflightOpen(true); void refreshPreflight(); } },
        ];
      case 'animate':
        return [
          { label: 'Onion', hint: 'Ghost the active controller either side of the playhead — count set in the Motion panel.', on: prefs.onion, go: () => setPrefs({ onion: !prefs.onion }) },
          { label: 'Motion path', hint: 'Show the authored A→B path with waypoints.', on: prefs.path, go: () => setPrefs({ path: !prefs.path }) },
          { label: 'Snap', hint: 'Snap body and prop drags to marks, seats and the walkable edges.', on: prefs.snap, go: () => setPrefs({ snap: !prefs.snap }) },
        ];
      case 'perform':
        return [
          { label: 'Line Booth', hint: 'Perform one line with context playback and count-in — in the Voice tab.', on: tab === 'voice', go: openBooth },
          { label: 'Scene Run', hint: 'Perform every unlocked line for one character against the full guide track — in the Voice tab.', go: openBooth },
          { label: 'Voices', hint: 'Synthesize all lines with the local engine.', busy: busy === 'voices', disabled: !shots, go: () => void runJob('voices') },
        ];
      case 'sound':
        return [
          { label: 'Rebuild stems', hint: 'Planned — dialogue, Foley, music and room tone as separate stems.', disabled: true, go: () => {} },
          { label: 'Room tone', hint: 'Planned — per-set room tone bed from the identity profile.', disabled: true, go: () => {} },
        ];
      case 'publish':
        return [
          { label: '16:9', hint: 'Horizontal master.', on: layout === '16:9', go: () => setLayout('16:9') },
          { label: '9:16', hint: 'Actor-aware portrait recompose.', on: layout === '9:16', go: () => setLayout('9:16') },
          {
            label: 'Captions', hint: detail?.hasExport ? 'WebVTT / SRT sidecars. Not burned in.' : 'Sidecars are written at export time.',
            disabled: !detail?.hasExport, go: () => window.open(`/api/scenes/${scene}/captions.vtt`, '_blank'),
          },
          {
            label: 'Export manifest', hint: detail?.hasExport ? 'Hashes, provenance and identity stamp.' : 'Written by the render.',
            disabled: !detail?.hasExport, go: () => window.open(`/api/scenes/${scene}/export`, '_blank'),
          },
        ];
    }
  }, [mode, llm, busy, shots, prefs, tab, layout, detail, scene, runCheck, runDirect, runJob, refreshPreflight, openBooth]);

  // --- command palette ---
  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    for (const m of ['write', 'direct', 'animate', 'perform', 'sound', 'publish'] as Mode[]) {
      out.push({ icon: '▸', label: `Go to ${m[0]!.toUpperCase()}${m.slice(1)}`, group: 'Mode', run: () => setMode(m) });
    }
    out.push({ icon: '◍', label: 'Toggle grid', group: 'Overlay', run: () => setPrefs({ grid: !prefs.grid }) });
    out.push({ icon: '◍', label: 'Toggle safe areas', group: 'Overlay', run: () => setPrefs({ safe: !prefs.safe }) });
    out.push({ icon: '◍', label: 'Toggle onion skin', group: 'Overlay', run: () => setPrefs({ onion: !prefs.onion }) });
    out.push({ icon: '◍', label: 'Toggle actor marks', group: 'Overlay', run: () => setPrefs({ marks: !prefs.marks }) });
    out.push({ icon: '⚙', label: 'Run Check', group: 'Action', run: () => void runCheck() });
    out.push({ icon: '⚙', label: 'Direct the scene', group: 'Action', run: () => void runDirect() });
    out.push({ icon: '⚙', label: 'Render voices', group: 'Action', run: () => void runJob('voices') });
    out.push({ icon: '⚙', label: 'Open production readiness', group: 'Action', run: () => { setPreflightOpen(true); void refreshPreflight(); } });
    out.push({ icon: '⚙', label: 'Render master…', group: 'Action', run: askRenderMaster });
    for (const s of scenes) {
      out.push({ icon: '≡', label: `Open scene ${s.name}`, group: 'Scene', keywords: 'switch', run: () => onScene(s.name) });
    }
    for (const member of cast) {
      out.push({ icon: '◍', label: `Open ${member.name} in the cast editor`, group: 'Project', run: () => onOpenCast(member.name) });
    }
    out.push({ icon: '▦', label: 'Open the set designer', group: 'Project', run: () => onOpenSets(null) });
    (shots?.beats ?? []).forEach((beat, i) => {
      const text = beat.kind === 'pause' ? `pause ${beat.ms}ms` : beat.text;
      out.push({
        icon: '▤',
        label: `Go to beat ${i} — ${text.slice(0, 52)}${text.length > 52 ? '…' : ''}`,
        group: 'Navigate',
        keywords: beat.kind === 'line' ? beat.speaker : beat.kind,
        run: () => selectBeat(i),
      });
    });
    return out;
  }, [prefs, scenes, cast, shots, setMode, runCheck, runDirect, runJob, refreshPreflight, askRenderMaster, onScene, onOpenCast, onOpenSets, selectBeat]);

  // --- assembled pieces ---
  const identityLabel = show ? `${show.active.id}@${show.active.hash.slice(0, 12)}` : '…';
  const sceneTitle = scene.split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
  const beatsCount = shots?.beats.length ?? check?.beats.length ?? 0;
  const sceneMeta = `${beatsCount ? `${beatsCount} beats` : 'undirected'}${totalMs ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''}`;
  const hasStaleRender = Boolean(preflight?.notes.some((n) => n.code.includes('stale')));
  const selectedCue = cueForBeat(dialogue, selectedBeat);
  const speakerBound = selectedCue
    ? Boolean(cast.find((c) => c.name === shots?.cast.find((m) => m.id === selectedCue.speaker)?.rig)?.voiceRef)
    : false;

  const performContext = selected !== null && selected > 0 && withAudio && detail?.hasAudio
    ? {
        audioUrl: `/api/scenes/${scene}/audio`,
        startMs: beatStarts[Math.max(0, selected - 1)] ?? 0,
        endMs: beatStarts[selected] ?? playheadMs,
      }
    : null;
  const sceneRun = withAudio && detail?.hasAudio && totalMs > 0
    ? { audioUrl: `/api/scenes/${scene}/audio`, beatStarts, durationMs: totalMs }
    : null;

  const jumpForCode = (code: string) => {
    if (/dialogue|voice|take/.test(code)) setMode('perform');
    else if (/animation|motion|blocking|walkable|staging/.test(code)) setMode('animate');
    else if (/action|script/.test(code)) setMode('direct');
    else if (/caption|render|export/.test(code)) setMode('publish');
    setPreflightOpen(false);
  };

  const subPane = mode === 'animate' ? null : (
    <div
      className="shrink-0 flex flex-col bg-stage border-r border-edge min-h-0"
      style={{ width: subPaneWidth(mode) }}
    >
      {(mode === 'write' || mode === 'direct') && <ScriptPane scene={scene} source={source} onChange={setSource} />}
      {mode === 'perform' && (
        <LinesPane dialogue={dialogue} shots={shots} selected={selected} onSelect={(i) => { selectBeat(i); setTab('voice'); }} speakerFilter={null} />
      )}
      {mode === 'publish' && (
        <ReadinessPane report={preflight} onJump={(code) => jumpForCode(code)} />
      )}
      {mode === 'sound' && <MixerPane />}
    </div>
  );

  const bottomStrip = mode === 'write' || mode === 'direct'
    ? (shots ? <ShotStrip shots={shots} beatStarts={beatStarts} selected={selected} onSelect={selectBeat} /> : null)
    : mode === 'perform'
      ? (
          <TakeStrip
            scene={scene}
            cue={selectedCue}
            dialogue={dialogue}
            speakerFg={selectedCue ? speakerColour(shots?.cast.map((c) => c.id) ?? [], selectedCue.speaker) : '#6b737d'}
            castVoiceBound={speakerBound}
            recording={rec}
            onRecordingChange={setRec}
            onReload={reloadDialogue}
            onSaveCue={saveDialogueCue}
            onDiscardTake={discardTake}
            onUseGenerated={(scope) => useGenerated(selectedCue, scope)}
            onOpenVoiceTab={openBooth}
            speakerRig={selectedCue ? shots?.cast.find((m) => m.id === selectedCue.speaker)?.rig ?? null : null}
            converting={busy === 'convert'}
            onConvert={() => convertToCharacter(selectedCue)}
            onOpenCastEditor={onOpenCast}
            conversionRuntime={health?.voiceConversion?.fingerprint ?? null}
          />
        )
      : mode === 'publish'
        ? (
            <ExportStrip
              scene={scene}
              detail={detail}
              preview={preview}
              identityLabel={identityLabel}
              preflight={preflight}
              onRenderMaster={askRenderMaster}
              onRenderDraft={askRenderDraft}
            />
          )
        : null;

  const statusSel = selectedBeat && selected !== null
    ? `beat ${selected} · ${selectedBeat.kind === 'line' ? selectedBeat.speaker : selectedBeat.kind} · ${selectedBeat.shot}`
    : 'nothing selected';

  return (
    <div className="h-full flex flex-col bg-stage text-ink text-[12px] overflow-hidden relative">
      <AppBar
        sceneTitle={sceneTitle}
        sceneMeta={sceneMeta}
        save={save}
        mode={mode}
        onMode={setMode}
        tools={tools}
        show={show}
        onCycleIdentity={cycleIdentity}
        quality={quality}
        onCycleQuality={cycleQuality}
        preflight={preflight}
        preflightBusy={preflightBusy}
        onTogglePreflight={() => {
          setPreflightOpen((v) => !v);
          if (!preflight) void refreshPreflight();
        }}
        onRender={() => {
          setMode('publish');
          setPreflightOpen(true);
          if (!preflight) void refreshPreflight();
        }}
        onCmd={() => setCmd(true)}
      />

      <div className="flex-1 min-h-0 flex">
        <Sidebar
          scenes={scenes}
          scene={scene}
          detail={detail}
          shots={shots}
          dialogue={dialogue}
          animation={animation}
          dirty={save.state === 'dirty' || save.state === 'saving'}
          hasStaleRender={hasStaleRender}
          cast={cast}
          sets={sets}
          health={health}
          mode={mode}
          onScene={onScene}
          onMode={setMode}
          onNewScene={onNewScene}
          onOpenCast={onOpenCast}
          onOpenSets={onOpenSets}
        />

        <div className="flex-1 min-w-0 flex flex-col bg-deep">
          <div className="flex-1 min-h-0 flex">
            {subPane}
            <StageColumn
              ref={stageRef}
              mode={mode}
              preview={preview}
              audioUrl={withAudio && detail?.hasAudio ? `/api/scenes/${scene}/audio` : null}
              shots={shots}
              beatStarts={beatStarts}
              totalMs={totalMs}
              selected={selected}
              setDescriptor={setDescriptor}
              prefs={prefs}
              onPrefs={setPrefs}
              onPlayhead={setPlayheadMs}
              onSelectBeat={selectBeat}
              animationTarget={animationTarget}
              validArea={setDescriptor?.layout.walkable ?? null}
              onCommitProp={(prop, to) => { void commitPropMove(prop, to); }}
              recording={rec}
              draftMarked={Boolean(preflight?.productionBlocked)}
              previewError={preview ? null : error}
              bottomStrip={bottomStrip}
            />
          </div>
        </div>

        <Inspector
          tab={tab}
          onTab={selectTab}
          flash={voiceFlash}
          scene={scene}
          shots={shots}
          vocab={vocab}
          selected={selected}
          beat={selectedBeat}
          dialogue={dialogue}
          animation={animation}
          setDescriptor={setDescriptor}
          playheadMs={playheadMs}
          totalMs={totalMs}
          identityLabel={identityLabel}
          expressionsFor={expressionsFor}
          onEditBeat={(i, next) => void editBeat(i, next)}
          onEditCast={(actorId, changes) => void editCastMember(actorId, changes)}
          onAnimationDocument={changeAnimationDocument}
          onAnimationTarget={setAnimationTarget}
          onAnimationSeek={(ms) => stageRef.current?.seekMs(ms)}
          selectedMotionId={selectedMotionId}
          onDeleteMotion={askDeleteMotion}
          onReloadDialogue={reloadDialogue}
          onSaveCue={saveDialogueCue}
          onDiscardTake={discardTake}
          speakerVoiceBound={speakerBound}
          performContext={performContext}
          sceneRun={sceneRun}
          onOpenCastEditor={onOpenCast}
          onGoWrite={() => setMode('write')}
        />
      </div>

      <Timeline
        shots={shots}
        dialogue={dialogue}
        animation={animation}
        beatStarts={beatStarts}
        totalMs={totalMs}
        playheadMs={playheadMs}
        selected={selected}
        selectedMotionId={selectedMotionId}
        motionBusy={busy === 'delete-motion'}
        snap={prefs.snap}
        onToggleSnap={() => setPrefs({ snap: !prefs.snap })}
        onSelect={selectBeat}
        onScrub={(ms) => stageRef.current?.seekMs(ms)}
        onSelectVoice={selectVoice}
        onSelectMotion={(segmentId) => {
          setSelected(null);
          setSelectedMotionId(segmentId);
          setMode('animate');
        }}
        onDeleteMotion={askDeleteMotion}
      />

      {/* status bar */}
      <div className="h-[22px] shrink-0 flex items-center gap-2.5 px-2.5 bg-deep border-t border-edge font-mono text-[10px] text-ink-faint">
        <span>{statusSel}</span>
        <span className="text-edge">│</span>
        <span>{fmtTimecode(playheadMs)} / {fmtTimecode(totalMs)}</span>
        <span className="text-edge">│</span>
        <span>frame {Math.round((playheadMs / 1000) * (shots?.fps ?? 24))} of {preview?.frameCount ?? 0}</span>
        <span className="text-edge">│</span>
        <span title="Characters run on twos, camera on ones">char {shots?.characterFps ?? 12} fps · cam {shots?.fps ?? 24} fps</span>
        <div className="flex-1" />
        <span title="Every render is stamped with the active show identity">identity {identityLabel}</span>
        <span className="text-edge">│</span>
        <span title="Seeded determinism: same inputs produce byte-identical frames">seed {shots?.seed ?? '—'}</span>
        <span className="text-edge">│</span>
        <span>{quality.toLowerCase()} preview · snap {prefs.snap ? 'on' : 'off'}</span>
      </div>

      {/* job / error / info toasts */}
      <div className="absolute right-3 bottom-8 z-30 flex flex-col gap-2 w-[340px] pointer-events-none">
        {job && (
          <div className="pointer-events-auto border border-accent/40 bg-panel rounded-[3px] px-2.5 py-2 shadow-[0_14px_40px_-12px_rgba(0,0,0,.8)]">
            <div className="flex items-center gap-1.5 mb-1">
              <Spinner />
              <span className="text-[8.5px] tracking-[.07em] uppercase text-accent border border-accent rounded-[2px] px-1">{job.kind}</span>
              <Mono className="text-[#5d656e]">
                {job.event?.stage ?? 'starting…'}{job.event?.total ? ` · ${job.event.done}/${job.event.total}` : ''}
              </Mono>
            </div>
            <div className="text-[11px] text-[#c9ccd1] leading-[1.45]">
              {job.kind === 'render'
                ? 'Rendering. Held frames are skipped; the job resumes if you close the app.'
                : job.kind === 'convert'
                  ? 'Converting your performance to the character’s voice. Your timing and delivery are preserved; only vocal identity changes. The first run loads the model into VRAM.'
                  : 'Synthesizing dialogue and deriving mouth cues.'}
            </div>
            {job.event?.total ? (
              <div className="mt-2 h-1 rounded-[2px] bg-deep overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.round(((job.event.done ?? 0) / job.event.total) * 100)}%` }} />
              </div>
            ) : null}
          </div>
        )}
        {error && (
          <div className="pointer-events-auto border border-bad/45 bg-bad/10 rounded-[3px] px-2.5 py-2 backdrop-blur-sm">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[8.5px] tracking-[.07em] uppercase text-bad border border-bad rounded-[2px] px-1">error</span>
              <div className="flex-1" />
              <button type="button" onClick={() => setError(null)} className="text-ink-faint text-[11px] cursor-pointer hover:text-ink">×</button>
            </div>
            <div className="text-[11px] text-[#d6c3c3] leading-[1.45] break-words">{error}</div>
          </div>
        )}
        {info && (
          <div className="pointer-events-auto border border-edge bg-panel rounded-[3px] px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[8.5px] tracking-[.07em] uppercase text-gen border border-gen rounded-[2px] px-1">note</span>
              <div className="flex-1" />
              <button type="button" onClick={() => setInfo(null)} className="text-ink-faint text-[11px] cursor-pointer hover:text-ink">×</button>
            </div>
            <div className="text-[11px] text-[#c9ccd1] leading-[1.45] break-words">{info}</div>
          </div>
        )}
      </div>

      {/* overlays */}
      {cmd && <CommandPalette commands={commands} onClose={() => setCmd(false)} />}
      {preflightOpen && (
        <PreflightPopover
          report={preflight}
          busy={preflightBusy}
          onClose={() => setPreflightOpen(false)}
          onAcknowledge={() => void acknowledgeWarnings()}
          onJump={jumpForCode}
          onRender={askRenderMaster}
        />
      )}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
      {writing && (
        <GenerateDialog
          title="Write a scene"
          label="Premise"
          placeholder="Office Space tone, but the coffee machine has become a middle manager."
          hint="The engine animates people standing in a room talking — write to that and it plays well."
          examples={[
            'Two coworkers discover the building has been sold to itself.',
            'A performance review conducted entirely about a chair.',
            'Someone explains a mandatory training module about the heat death of the universe.',
          ]}
          busy={genBusy}
          error={genError}
          disabled={llm ? !llm.ok : false}
          disabledReason={llm?.reason ?? null}
          onGenerate={(premise) => void runWrite(premise)}
          onClose={() => {
            setWriting(false);
            setGenError(null);
          }}
        />
      )}
    </div>
  );
}
