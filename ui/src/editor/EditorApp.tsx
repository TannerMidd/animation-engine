import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, followJob } from '../api.ts';
import type {
  AnimationDocument, Beat, CastMember, CastSummary, CheckResult, DialogueCue, DialogueDocument, Health,
  JobEvent, LlmStatus, PreviewInfo, ProductionPreflightNote, ProductionPreflightReport, PropReferenceIssue,
  SceneDetail, SceneSoundInfo, SceneSummary, SetDescriptor, SetSummary, ShotList, ShowInfo, Vocab, PropDefInfo,
} from '../types.ts';
import { GenerateDialog } from '../components/GenerateDialog.tsx';
import { useLlmStart } from '../components/useLlmStart.ts';
import type { AnimationEditTarget, StagePropTarget } from '../components/AnimationOverlay.tsx';
import { propInstanceId } from './stage/interaction.ts';
import { AppBar, StaleBar, type ContextTool, type EngineOption, type SaveState } from './AppBar.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Inspector } from './Inspector.tsx';
import { Timeline } from './Timeline.tsx';
import { StageColumn, type OverlayPrefs, type StageHandle } from './stage/StageColumn.tsx';
import { ExportStrip, ShotStrip, TakeStrip } from './stage/strips.tsx';
import { LinesPane, MixerPane, ReadinessPane, ScriptPane, subPaneWidth } from './panes.tsx';
import { CommandPalette, ConfirmDialog, PreflightPopover, type Command, type ConfirmSpec } from './overlays.tsx';
import { ContextMenu, act, sep, section, type MenuItem, type MenuTarget, type OpenMenu } from './ContextMenu.tsx';
import { AuditionOverlay, CompareOverlay, ConversionCheckOverlay, SystemReport } from './tools.tsx';
import { SetPicker } from './SetPicker.tsx';
import {
  applySetRepairs, planSetRepairs, retargetOne, unresolvedIssues, unresolvedText, usableSubstitutes,
} from './setSwitch.ts';
import { Btn, Mono, Spinner } from './chrome.tsx';
import {
  beatSpine, beatStartsFor, cueForBeat, defaultTabFor, fmtTimecode, isTyping, motionDeletionBlocker,
  MODE_DEFS, sceneCues, speakerColour, spineDrift, totalMsFor, withoutMotionSegment,
  type InspectorTab, type Mode,
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
  scene, scenes, cast, sets, props, vocab, health, show, llm, expressionsFor,
  onScene, onSceneChanged, onNewScene, onOpenCast, onOpenSets, onOpenProps,
  setRequest, onSetRequestHandled,
}: {
  scene: string;
  scenes: SceneSummary[];
  cast: CastSummary[];
  sets: SetSummary[];
  props: PropDefInfo[];
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
  onOpenProps: (key: string | null) => void;
  /** A set the designer asked to bind to this scene, answered on arrival. */
  setRequest?: { name: string; nonce: number } | null;
  onSetRequestHandled?: () => void;
}) {
  const [mode, setModeRaw] = useState<Mode>('write');
  const [tab, setTab] = useState<InspectorTab>('beat');
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [source, setSource] = useState('');
  const [shots, setShots] = useState<ShotList | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  /**
   * The source `check` describes. Beat indexes only line up with the script
   * that produced them, so the composer needs to know when its errors have
   * fallen behind rather than pinning them on whichever line moved into place.
   */
  const [checkedSource, setCheckedSource] = useState<string | null>(null);
  const applyCheck = useCallback((result: CheckResult, from: string) => {
    setCheck(result);
    setCheckedSource(from);
  }, []);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [dialogue, setDialogue] = useState<DialogueDocument | null>(null);
  const [animation, setAnimation] = useState<AnimationDocument | null>(null);
  const [preflight, setPreflight] = useState<ProductionPreflightReport | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  /** Age of the displayed verdict, so a cached one cannot pass for a live one. */
  const [preflightAgoS, setPreflightAgoS] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [setDescriptor, setSetDescriptor] = useState<SetDescriptor | null>(null);
  /**
   * Every set priced against this scene's staging.
   *
   * Refetched with the shot list rather than at boot, because what a set costs
   * is a fact about the *current* beats: adding "he taps the desk" changes which
   * rooms can host the scene, and the picker has to say so before it is opened.
   */
  const [pricedSets, setPricedSets] = useState<SetSummary[] | null>(null);
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
  const [systemOpen, setSystemOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [auditionOpen, setAuditionOpen] = useState(false);
  const [scoreTake, setScoreTake] = useState<{ takeId: string; label: string } | null>(null);
  const [sound, setSound] = useState<SceneSoundInfo | null>(null);
  const [soundLoading, setSoundLoading] = useState(false);
  const [engine, setEngineRaw] = useState('chatterbox');
  /** Set once the creator picks; auto-defaulting must never override a choice. */
  const engineChosen = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  /** Where the context menu is and what it is about; its items are built at render. */
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const llmStart = useLlmStart(llm);
  /** Timeline view state, up here because the context menu drives it too. */
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [trackLocks, setTrackLocks] = useState<Record<string, boolean>>({});
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
  const preflightAt = useRef<number | null>(null);

  const setPrefs = (patch: Partial<OverlayPrefs>) => setPrefsState((p) => ({ ...p, ...patch }));

  const withAudio = quality !== 'Draft' && Boolean(detail?.hasAudio);
  /**
   * Whether to attach the mixed audio to the transport.
   *
   * `detail.hasAudio` only says a dialogue.wav exists; the server additionally
   * refuses to serve one that predates the current direction. The preview
   * applies exactly that test, so deferring to its verdict is what keeps the
   * editor from promising sound the server will not hand over.
   */
  const audioPlayable = withAudio && preview !== null && !preview.estimated;
  const previewLayout = mode === 'publish' && layout === '9:16' ? 'vertical' : 'horizontal';
  const setName = shots?.set ? shots.set.replace(/\.(json|svg)$/, '') : sets[0]?.name ?? 'office';

  const setMode = useCallback((next: Mode) => {
    setModeRaw(next);
    setTab(defaultTabFor(next));
    if (next !== 'animate') setAnimationTarget(null);
  }, []);

  // --- voice engine ---
  // Chatterbox when it works; otherwise the first engine that does. A machine
  // with no Python stack lands on sapi instead of an error minutes later.
  const engineNames = useMemo(
    () => (vocab?.engines?.length ? vocab.engines : ['chatterbox', 'sapi']),
    [vocab],
  );
  const engines: EngineOption[] = useMemo(() => engineNames.map((name) => {
    const status = health?.engines[name];
    return {
      name,
      ok: status?.ok ?? false,
      ...(status?.checking || !health ? { checking: true } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
    };
  }), [engineNames, health]);

  useEffect(() => {
    if (engineChosen.current || !health) return;
    const usable = engines.filter((e) => e.ok && !e.checking);
    if (!usable.length) return;
    if (!usable.some((e) => e.name === engine)) setEngineRaw(usable[0]!.name);
  }, [health, engines, engine]);

  const setEngine = useCallback((name: string) => {
    engineChosen.current = true;
    setEngineRaw(name);
    setInfo(`Voices and renders now use the ${name} engine. The mix reads as stale until Voices runs with it.`);
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
    setCheck(null);
    setCheckedSource(null);
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
          // Direct the loaded script without writing anything, purely so the
          // staleness comparison below has both sides on arrival. Without it a
          // scene that is *already* out of date looks fine until you type.
          void api.check(scene, { source: d.source, set: d.shots.set })
            .then((res) => { if (!cancelled) applyCheck(res, d.source); })
            .catch(() => {});
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

  // The set designer's "use in this scene", answered here so the confirm about
  // what it breaks lands on the stage rather than over the designer.
  const requestedSet = setRequest?.nonce ?? null;
  useEffect(() => {
    if (!setRequest || !shots) return;
    chooseSet(setRequest.name);
    onSetRequestHandled?.();
    // Keyed on the nonce: the same set may be asked for twice in a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSet, shots !== null]);

  // What each set would cost this scene. Follows the shot list on the same
  // debounce as the preview, so the picker and the stage never disagree.
  useEffect(() => {
    if (!shots) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void api.sets(scene)
        .then((list) => { if (!cancelled) setPricedSets(list); })
        .catch(() => {});
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [scene, shots]);

  // --- preview rebuilds whenever its inputs change ---
  // Once the accurate (voice-engine) path fails, stop asking it on every edit;
  // a struggling GPU does not get healthier by being hammered. Voices resets it.
  const accurateBroken = useRef(false);
  /** Say "the mix went stale" once, not on every rebuild the edit triggers. */
  const staleSoundtrackAnnounced = useRef(false);
  const rebuildPreview = useCallback(async () => {
    const wantAudio = withAudio && !accurateBroken.current;
    try {
      const next = await api.preview(scene, wantAudio, previewLayout);
      setPreview(next);
      // The picture will play in silence otherwise, with nothing to explain it.
      if (wantAudio && next.soundtrack === 'stale') {
        if (!staleSoundtrackAnnounced.current) {
          staleSoundtrackAnnounced.current = true;
          setInfo('The mixed audio predates the current direction, so the preview is playing without sound and timing is estimated. Run Voices to rebuild it.');
        }
      } else if (next.soundtrack === 'current') {
        staleSoundtrackAnnounced.current = false;
      }
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
          applyCheck(await api.check(scene, { source, set: setName }), source);
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

  /** Record a fresh verdict and reset its age. */
  const acceptPreflight = useCallback((report: ProductionPreflightReport) => {
    setPreflight(report);
    preflightAt.current = Date.now();
    setPreflightAgoS(0);
  }, []);

  // --- preflight runs automatically; it is milliseconds, renders are minutes ---
  useEffect(() => {
    if (!shots) {
      setPreflight(null);
      preflightAt.current = null;
      setPreflightAgoS(null);
      return;
    }
    let cancelled = false;
    setPreflightBusy(true);
    const t = setTimeout(() => {
      void api.preflight(scene)
        .then((report) => { if (!cancelled) acceptPreflight(report); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setPreflightBusy(false); });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [scene, shots, dialogue, animation, acceptPreflight]);

  // Keep the "checked Ns ago" label honest, like the save chip's.
  useEffect(() => {
    const t = setInterval(() => {
      setPreflightAgoS(preflightAt.current === null
        ? null
        : Math.round((Date.now() - preflightAt.current) / 1000));
    }, 5000);
    return () => clearInterval(t);
  }, []);

  /**
   * How far the shot list has fallen behind the script, in beats.
   *
   * `check` is the current script fully directed, so comparing its spine to
   * the applied shot list's is the whole question. A script mid-edit parses to
   * errors or to nothing; neither is divergence, and claiming it would put an
   * alarm on the screen every time someone starts a line.
   */
  const staleBeats = useMemo(() => {
    if (!shots || !check || check.errors.length || !check.beats.length) return 0;
    return spineDrift(beatSpine(check.beats), beatSpine(shots.beats));
  }, [shots, check]);

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

  /** Top-level scene settings — set, seed, frame rates, cards — from the Scene tab. */
  const editShots = useCallback((changes: Partial<Pick<ShotList, 'set' | 'seed' | 'fps' | 'characterFps' | 'cards' | 'title' | 'subtitle'>>) => {
    pushShots((current) => ({ ...current, ...changes }), false);
  }, [pushShots]);

  /** One change to every cast member in a single write — the scene resting default. */
  const editAllCast = useCallback((changes: Partial<CastMember>) => {
    pushShots((current) => ({
      ...current,
      cast: current.cast.map((member) => ({ ...member, ...changes })),
    }), false);
  }, [pushShots]);

  /**
   * Change the set, and deal with what that costs before it costs it.
   *
   * A set that cannot host the scene's staging used to be discovered by the
   * compiler *after* the switch, which blanked the stage behind an exception.
   * The same question is now asked first: if the new room breaks beats, the
   * repairs are named and applied in the same write, so the scene that comes
   * back is one that stages.
   */
  const chooseSet = useCallback((name: string | null) => {
    const references = pricedSets?.find((item) => item.fit)?.fit?.references ?? 0;
    const fit = name === null ? undefined : pricedSets?.find((item) => item.name === name)?.fit;
    const repairs = planSetRepairs(fit);
    const unresolved = unresolvedIssues(fit);

    if (name === null && references > 0) {
      setConfirm({
        title: 'Play this scene on a bare stage?',
        body: `${references} prop ${references === 1 ? 'move' : 'moves'} in this scene need something to touch. `
          + 'A bare stage has nothing, so the preview will not build until the scene is staged somewhere again '
          + 'or those beats are rewritten.',
        ok: 'Use the bare stage',
        okTone: 'bad',
        onOk: () => editShots({ set: null }),
      });
      return;
    }

    if (!repairs.length && !unresolved.length) {
      editShots({ set: name });
      return;
    }

    const rows = [
      ...repairs.map((repair) => ({
        tag: repair.issue.beatIndex === null ? repair.issue.actorId ?? '—' : `beat ${repair.issue.beatIndex}`,
        fg: '#6f9b5a',
        text: `${repair.issue.label} — ${repair.text}`,
      })),
      ...unresolved.map((issue) => ({
        tag: issue.beatIndex === null ? issue.actorId ?? '—' : `beat ${issue.beatIndex}`,
        fg: '#c8834a',
        text: `${issue.label} — ${unresolvedText(issue)}`,
      })),
    ];

    // Nothing to apply: the set simply cannot host this scene as written, and
    // saying so is more use than a button that pretends otherwise.
    if (!repairs.length) {
      setConfirm({
        title: `"${name}" cannot host every beat`,
        body: 'Every beat and its text stays exactly as written, but the staging below has nothing to work with '
          + 'there. The stage stays blocked until each one is pointed at something this set has, the beat is '
          + 'rewritten, or the scene moves to a set that can host it.',
        list: rows,
        ok: `Stage here anyway`,
        okTone: 'bad',
        onOk: () => editShots({ set: name }),
      });
      return;
    }

    setConfirm({
      title: `"${name}" needs the staging repointed`,
      body: `Every beat and its text stays as written. ${repairs.length === 1 ? 'One piece' : `${repairs.length} pieces`} `
        + `of business can be repointed at what this set has${unresolved.length ? ', and the rest needs a decision from you' : ''}:`,
      list: rows,
      ok: `Switch and repoint ${repairs.length === 1 ? 'it' : 'them'}`,
      okTone: 'accent',
      onOk: () => pushShots((current) => ({ ...applySetRepairs(current, repairs), set: name }), false),
      alt: {
        label: 'Switch, leave the staging alone',
        onPick: () => editShots({ set: name }),
      },
    });
  }, [pricedSets, editShots, pushShots]);

  const saveDialogueCue = useCallback(async (cue: DialogueCue) => {
    setPreflight(null);
    const result = await api.saveDialogueCue(scene, cue, dialogueRevision.current);
    dialogueRevision.current = result.revision;
    await reloadDialogue();
    void rebuildPreview();
  }, [scene, reloadDialogue, rebuildPreview]);

  /**
   * Forget the cues the script has left behind.
   *
   * They are retained automatically so a restored line comes back with its
   * work, which is right until a scene has been rewritten past recognition and
   * is carrying dozens of lines from a script nobody remembers. Locked cues are
   * left where they are: the engine refuses to drop them, and it is right to.
   */
  const discardOrphanCues = useCallback((orphans: DialogueCue[]) => {
    if (!dialogue || !orphans.length) return;
    const locked = orphans.filter((cue) => cue.locked);
    const fieldLocked = orphans.filter((cue) => cue.lockedFields.length);
    const dropIds = new Set(orphans.map((cue) => cue.id));

    setConfirm({
      title: `Discard ${orphans.length} left-behind ${orphans.length === 1 ? 'line' : 'lines'}?`,
      body: 'These cues belong to lines that are no longer in the script. Discarding them removes their '
        + 'editorial state — selections, trims and approvals — so restoring one of those lines later '
        + 'would start it from scratch.',
      list: [
        { tag: 'KEEPS', fg: '#7a8fc0', text: 'Recorded audio stays on disk as an immutable audit record.' },
        ...(locked.length ? [{
          tag: 'UNLOCKS',
          fg: '#a89050',
          // The engine requires unlocking and removing to be separate revisions;
          // this does both on one click rather than leaving a lock nobody can
          // reach — the cue it protects belongs to a scene that no longer exists.
          text: `${locked.length} approved ${locked.length === 1 ? 'cue is' : 'cues are'} unlocked first, in its own save.`,
        }] : []),
      ],
      ok: `Discard ${orphans.length}`,
      okTone: 'bad',
      onOk: () => {
        void (async () => {
          try {
            setPreflight(null);
            // Each save bumps the document revision, and the next one has to
            // present the revision it is editing — so carry it forward rather
            // than replaying the stale one this closure started with.
            let current = dialogue;
            const save = async (cues: DialogueCue[]) => {
              const saved = await api.saveDialogue(scene, { ...current, cues });
              current = { ...current, cues, revision: saved.revision };
              dialogueRevision.current = saved.revision;
            };
            // Locks come off one kind at a time: a full lock only ever permits
            // the single transition to unlocked, so batching them with anything
            // else is refused at the persistence boundary.
            if (locked.length) {
              await save(current.cues.map((cue) => (dropIds.has(cue.id) && cue.locked ? { ...cue, locked: false } : cue)));
            }
            if (fieldLocked.length) {
              await save(current.cues.map((cue) => (dropIds.has(cue.id) ? { ...cue, lockedFields: [] } : cue)));
            }
            await save(current.cues.filter((cue) => !dropIds.has(cue.id)));
            await reloadDialogue();
          } catch (err) {
            setError((err as Error).message);
          }
        })();
      },
    });
  }, [dialogue, scene, reloadDialogue]);

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

  /**
   * The scene's own lines.
   *
   * Everything that counts, lists or reasons about "the lines" reads this
   * rather than the raw document, which also carries cues the script has left
   * behind. See `sceneCues` for why those are kept at all.
   */
  const sceneLines = useMemo(() => sceneCues(dialogue, shots), [dialogue, shots]);

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
          // Only lines this script still has: approving a voice for a speaker
          // must not silently approve one for a scene they were in two rewrites
          // ago, which the retained cues would otherwise sweep in.
          const live = new Set(sceneCues(dialogue, shots).map((c) => c.id));
          const eligible = (c: DialogueCue) =>
            live.has(c.id) && c.speaker === cue.speaker && (c.voiceSource ?? 'performance') === 'performance'
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
  }, [dialogue, shots, scene, reloadDialogue, rebuildPreview]);

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

  /**
   * Blocking left behind by a cast that has since changed.
   *
   * Motion segments name the actor they move. Rewrite the script until that
   * character is gone and the segments stay, pointing at nobody — which the
   * compiler refuses outright, so the whole preview goes dark over blocking for
   * someone who is not in the scene. Same shape as the retained dialogue cues,
   * except this one stops the picture rather than only cluttering a list.
   */
  const strandedMotion = useMemo(() => {
    if (!animation || !shots) return [];
    const cast = new Set(shots.cast.map((member) => member.id));
    return animation.segments.filter((segment) => !cast.has(segment.actorId));
  }, [animation, shots]);

  const dropStrandedMotion = useCallback(() => {
    if (!animation || busy) return;
    const removable = strandedMotion.filter((segment) => !motionDeletionBlocker(animation, segment.id));
    const kept = strandedMotion.length - removable.length;
    if (!removable.length) {
      setError('Every stranded motion segment is locked. Unlock them in the Motion panel first.');
      return;
    }
    const actors = [...new Set(removable.map((segment) => segment.actorId))].join(', ');
    setConfirm({
      title: `Remove blocking for ${actors}?`,
      body: `${removable.length} motion segment${removable.length === 1 ? ' still moves' : 's still move'} ${actors}, `
        + `who ${actors.includes(',') ? 'are' : 'is'} not in this scene's cast. The compiler refuses to render blocking `
        + 'for an actor who is not there, so the preview stays blocked until these go.',
      list: removable.slice(0, 6).map((segment) => ({
        tag: segment.actorId,
        fg: '#c8595a',
        text: `${segment.channel === 'part.transform' ? segment.partId : 'root'} · ${segment.id}`,
      })),
      ...(kept ? { alt: { label: `Leave the ${kept} locked ${kept === 1 ? 'one' : 'ones'}`, onPick: () => {} } } : {}),
      ok: `Remove ${removable.length}`,
      okTone: 'bad',
      onOk: () => {
        void (async () => {
          setBusy('delete-motion');
          setError(null);
          setPreflight(null);
          try {
            const ids = new Set(removable.map((segment) => segment.id));
            const next = removable.reduce(
              (document, segment) => withoutMotionSegment(document, segment.id),
              animation,
            );
            const saved = await api.saveAnimation(scene, next);
            setAnimation(saved.document);
            if (selectedMotionId && ids.has(selectedMotionId)) setSelectedMotionId(null);
            void rebuildPreview();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  }, [animation, busy, scene, selectedMotionId, strandedMotion, rebuildPreview]);

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
        // Re-establish the comparison against whatever the script says *now* —
        // it may have moved on while the diff was sitting in the dialog.
        void api.check(scene, { source, set: setName }).then((res) => applyCheck(res, source)).catch(() => {});
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
            ...(res.newCharacters.length ? [{ tag: 'CAST', fg: '#6f9b5a', text: `creates placeholder rigs for ${res.newCharacters.join(', ')}` }] : []),
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

  const refreshPreflight = useCallback(async () => {
    setPreflightBusy(true);
    try {
      acceptPreflight(await api.preflight(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreflightBusy(false);
    }
  }, [scene, acceptPreflight]);

  // --- sound mode reads the stems on disk ---
  const reloadSound = useCallback(async () => {
    setSoundLoading(true);
    try {
      setSound(await api.sound(scene));
    } catch {
      // An undirected scene has no stems to describe; the pane explains itself.
      setSound(null);
    } finally {
      setSoundLoading(false);
    }
  }, [scene]);

  useEffect(() => {
    if (mode !== 'sound') return;
    void reloadSound();
  }, [mode, scene, shots, reloadSound]);

  // --- long jobs ---
  const runJob = useCallback(async (kind: 'voices' | 'render' | 'sound', opts: { draft?: boolean } = {}) => {
    setBusy(kind);
    setJob({ kind, event: null });
    setError(null);
    try {
      const started = kind === 'voices'
        ? await api.voices(scene, engine)
        : kind === 'sound'
          // No engine passed: a rebuild remixes with whatever engine built the
          // track, never a silent engine change.
          ? await api.rebuildStems(scene)
          : await api.render(scene, { engine, draft: opts.draft });
      const stop = followJob(started.id, (e) => {
        setJob({ kind, event: e });
        if (e.type === 'done' || e.type === 'error') {
          stop();
          setBusy(null);
          setJob(null);
          if (e.type === 'error') {
            setError(e.message ?? 'job failed');
          } else {
            setInfo(kind === 'voices'
              ? 'Voices rendered — the preview now uses real audio.'
              : kind === 'sound'
                ? 'Stems rebuilt — dialogue, Foley, room tone and stings are current again.'
                : opts.draft
                  ? 'Draft rendered. The export manifest is labelled non-production.'
                  : 'Master rendered. Files are in the Export strip.');
            void api.scene(scene).then((d) => {
              setDetail(d);
              if (kind === 'voices' || kind === 'sound') {
                accurateBroken.current = false;
                setQuality((q) => (q === 'Draft' ? 'Accurate' : q));
                void rebuildPreview();
                // Voices re-syncs the dialogue document as it resolves timings,
                // so the cue state on screen is a revision behind by the time
                // the job reports done.
                void reloadDialogue().catch(() => {});
                void reloadSound();
              }
              // The readiness verdict was computed against the state this job
              // just changed — which is the whole reason it ran. Nothing else
              // re-runs it: the automatic pass watches shots, dialogue and
              // animation, and finishing a job touches none of them.
              void refreshPreflight();
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
  }, [scene, engine, onSceneChanged, rebuildPreview, refreshPreflight, reloadDialogue, reloadSound]);

  const acknowledgeWarnings = useCallback(async () => {
    setPreflightBusy(true);
    try {
      acceptPreflight(await api.acknowledgePreflightWarnings(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreflightBusy(false);
    }
  }, [scene, acceptPreflight]);

  const blockers = preflight?.notes.filter((n) => n.level === 'error') ?? [];
  const reviewPending = Boolean(preflight && !preflight.productionBlocked && preflight.warningReview.required && !preflight.warningReview.current);

  const askRenderDraft = useCallback(() => {
    setConfirm({
      title: 'Render a draft with blockers?',
      body: 'A draft is a diagnostic, not a release: the production gate is explicitly bypassed, and the export manifest is labelled draft so downstream tooling cannot mistake it for an approved bundle. Video pixels are not watermarked.',
      list: [
        { tag: 'LABELS', fg: '#c8834a', text: 'productionStatus: draft lands in the export manifest, with the blockers recorded.' },
        { tag: 'KEEPS', fg: '#7a8fc0', text: 'Locked beats, approved takes and creator-authored motion are untouched.' },
      ],
      ok: 'Render draft',
      okTone: 'accent',
      onOk: () => void runJob('render', { draft: true }),
    });
  }, [runJob]);

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
        alt: { label: 'Render a draft instead…', onPick: askRenderDraft },
      });
      return;
    }
    setConfirm({
      title: 'Render the production master?',
      body: 'The render consumes one immutable snapshot of the scene. A concurrent edit belongs to the next render, never half of this one.',
      list: [
        { tag: 'ENGINE', fg: '#9aa1ab', text: `Dialogue synthesizes with ${engine}.` },
        { tag: 'STAMPS', fg: '#7a8fc0', text: 'Identity, seed, hashes and provenance land in the export manifest.' },
        { tag: 'RESUMES', fg: '#6f9b5a', text: 'Held frames are skipped; the job resumes if interrupted.' },
      ],
      ok: 'Render master',
      okTone: 'good',
      onOk: () => void runJob('render'),
    });
  }, [preflight, blockers, reviewPending, runJob, engine, askRenderDraft]);

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
      applyCheck(res, source);
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
  const switchIdentity = useCallback((id: string) => {
    const next = show?.profiles.find((p) => p.id === id);
    if (!next) return;
    setConfirm({
      title: `Switch show identity to ${next.name}?`,
      body: 'Identity governs line treatment, register, wardrobe, acting envelope and cutting rhythm. Switching re-derives everything downstream, so the app reloads.',
      ok: `Switch to ${next.name}`,
      okTone: 'accent',
      onOk: () => {
        void api.setActiveShow(next.id)
          .then(() => window.location.reload())
          .catch((err: Error) => setError(err.message));
      },
    });
  }, [show]);

  /**
   * The identity reel: this scene's script under two identity profiles,
   * stacked. A generic job follower — the result opens as a video.
   */
  const askRenderReel = useCallback(() => {
    setConfirm({
      title: 'Render the identity reel?',
      body: 'The evaluation script renders twice — once under each fixture identity — and the halves stack into one video. Two full renders; expect minutes. If the halves don’t read as two different shows, the identity system isn’t doing its job.',
      list: [
        { tag: 'TOP', fg: '#7a8fc0', text: 'fixtures/dry-institutional' },
        { tag: 'BOTTOM', fg: '#c8834a', text: 'fixtures/loud-cartoon' },
        { tag: 'KEEPS', fg: '#6f9b5a', text: 'The active identity is restored when the reel finishes.' },
      ],
      ok: 'Render reel',
      okTone: 'accent',
      onOk: () => {
        void (async () => {
          setBusy('reel');
          setJob({ kind: 'reel', event: null });
          setError(null);
          try {
            const started = await api.renderReel();
            const stop = followJob(started.id, (e) => {
              setJob({ kind: 'reel', event: e });
              if (e.type !== 'done' && e.type !== 'error') return;
              stop();
              setBusy(null);
              setJob(null);
              if (e.type === 'error') {
                setError(e.message ?? 'reel failed');
                return;
              }
              const url = (e.result as { url?: string } | undefined)?.url;
              setInfo('Identity reel rendered — top: dry-institutional, bottom: loud-cartoon.');
              if (url) window.open(url, '_blank');
            });
          } catch (err) {
            setBusy(null);
            setJob(null);
            setError((err as Error).message);
          }
        })();
      },
    });
  }, []);

  /** Whole-cast contact sheet from the palette; the result opens as an image. */
  const runContactSheet = useCallback(async () => {
    setBusy('sheet');
    setJob({ kind: 'sheet', event: null });
    setError(null);
    try {
      const started = await api.castSheet();
      const stop = followJob(started.id, (e) => {
        setJob({ kind: 'sheet', event: e });
        if (e.type !== 'done' && e.type !== 'error') return;
        stop();
        setBusy(null);
        setJob(null);
        if (e.type === 'error') {
          setError(e.message ?? 'contact sheet failed');
          return;
        }
        const url = (e.result as { url?: string } | undefined)?.url;
        if (url) window.open(url, '_blank');
      });
    } catch (err) {
      setBusy(null);
      setJob(null);
      setError((err as Error).message);
    }
  }, []);

  /** Rig validation from the palette — fast enough to answer as a toast. */
  const runCastCheck = useCallback(async () => {
    try {
      const { ok, results } = await api.checkCast();
      const bad = results.filter((r) => !r.ok);
      setInfo(ok
        ? `Cast check: all ${results.length} rig${results.length === 1 ? '' : 's'} valid.`
        : `Cast check: ${bad.length} of ${results.length} failed — ${bad.map((r) => r.name).join(', ')}. Details in the cast editor's tools.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const cycleQuality = useCallback(() => {
    setQuality((q) => (q === 'Draft' ? 'Accurate' : q === 'Accurate' ? 'Final' : 'Draft'));
  }, []);

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmd((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        // The context menu closes itself, in the capture phase. This is the
        // backstop: without it, one Escape with a menu open over a dialog would
        // dismiss both, and the menu's own guard depends on it holding focus.
        if (menu) return;
        setCmd(false);
        setPreflightOpen(false);
        setConfirm(null);
        setSystemOpen(false);
        setCompareOpen(false);
        setAuditionOpen(false);
        setScoreTake(null);
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
  }, [askDeleteMotion, selected, selectedMotionId, shots, selectBeat, menu]);

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
          {
            label: 'Direct the script →',
            hint: 'Turn this draft into the shot list. The timeline, voices, animation, preview and render all read the shot list — this is what pushes your script into them. You confirm the diff first.',
            primary: true, busy: busy === 'direct', go: () => void runDirect(),
          },
        ];
      case 'direct':
        return [
          {
            label: 'Re-direct…',
            hint: 'Propose new direction from the current script and apply it to the timeline, voices, animation and preview. You confirm the diff before anything is written; locked beats survive.',
            busy: busy === 'direct', go: () => void runDirect(),
          },
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
          { label: 'Audition…', hint: 'The whole cast through the real synthesis path, side by side, with per-line verification verdicts.', go: () => setAuditionOpen(true) },
          { label: 'Voices', hint: `Synthesize all lines with the ${engine} engine.`, busy: busy === 'voices', disabled: !shots, go: () => void runJob('voices') },
        ];
      case 'sound':
        return [
          {
            label: 'Rebuild stems',
            hint: 'Remix dialogue, Foley, room tone and stings from cached takes — the same assembly path as Voices, without asking for new synthesis.',
            busy: busy === 'sound',
            disabled: !shots,
            go: () => void runJob('sound'),
          },
          { label: 'Voices', hint: `Synthesize any missing lines with ${engine} and remix.`, busy: busy === 'voices', disabled: !shots, go: () => void runJob('voices') },
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
  }, [mode, llm, busy, shots, prefs, tab, layout, detail, scene, engine, runCheck, runDirect, runJob, refreshPreflight, openBooth]);

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
    out.push({ icon: '⚙', label: 'Rebuild sound stems', group: 'Action', keywords: 'mix foley ambience', run: () => void runJob('sound') });
    out.push({ icon: '⚙', label: 'Open production readiness', group: 'Action', run: () => { setPreflightOpen(true); void refreshPreflight(); } });
    out.push({ icon: '⚙', label: 'Render master…', group: 'Action', run: askRenderMaster });
    out.push({ icon: '⚙', label: 'Render draft with blockers…', group: 'Action', keywords: 'diagnostic', run: askRenderDraft });
    out.push({ icon: '▤', label: 'Scene settings — set, seed, frame rate, cards', group: 'Action', keywords: 'scene tab', run: () => selectTab('scene') });
    for (const option of engines) {
      if (option.name === engine) continue;
      out.push({
        icon: '♪',
        label: `Use the ${option.name} voice engine${option.ok ? '' : ' (unavailable)'}`,
        group: 'Engine',
        keywords: 'voice tts',
        run: () => setEngine(option.name),
      });
    }
    out.push({ icon: '♪', label: 'Open Audition — cast voice bench', group: 'Voices', keywords: 'bench listen', run: () => setAuditionOpen(true) });
    out.push({ icon: '⚕', label: 'Open System report', group: 'System', keywords: 'doctor toolchain health migrate', run: () => setSystemOpen(true) });
    out.push({ icon: '⚕', label: 'Validate cast rigs', group: 'System', keywords: 'cast check', run: () => void runCastCheck() });
    out.push({ icon: '⚕', label: 'Contact sheet — whole cast', group: 'System', keywords: 'sheet png', run: () => void runContactSheet() });
    out.push({ icon: '◔', label: 'Compare identity profiles…', group: 'Identity', run: () => setCompareOpen(true) });
    out.push({ icon: '◔', label: 'Render identity reel…', group: 'Identity', run: askRenderReel });
    for (const profile of show?.profiles ?? []) {
      if (profile.id === show?.active.id) continue;
      out.push({ icon: '◔', label: `Switch identity to ${profile.name}`, group: 'Identity', run: () => switchIdentity(profile.id) });
    }
    for (const s of scenes) {
      out.push({ icon: '≡', label: `Open scene ${s.name}`, group: 'Scene', keywords: 'switch', run: () => onScene(s.name) });
    }
    for (const member of cast) {
      out.push({ icon: '◍', label: `Open ${member.name} in the cast editor`, group: 'Project', run: () => onOpenCast(member.name) });
    }
    for (const item of sets) {
      if (item.name === setName) continue;
      out.push({
        icon: '▦',
        label: `Stage this scene in ${item.name}`,
        group: 'Scene',
        keywords: 'set room change',
        run: () => chooseSet(item.name),
      });
    }
    out.push({ icon: '▦', label: 'Open the set designer', group: 'Project', run: () => onOpenSets(null) });
    // One entry, worded so it is found by either half of what people search for
    // — the thing they want to make, or the name of the tool that makes it.
    out.push({ icon: '◆', label: 'New prop — open the prop studio', group: 'Project', run: () => onOpenProps(null) });
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
  }, [
    prefs, scenes, cast, sets, setName, chooseSet, shots, show, engine, engines, setMode, selectTab, setEngine,
    runCheck, runDirect, runJob, refreshPreflight, askRenderMaster, askRenderDraft, askRenderReel, runCastCheck,
    runContactSheet, switchIdentity, onScene, onOpenCast, onOpenSets, onOpenProps, selectBeat,
  ]);

  // --- context menu ---
  /**
   * Right-click selects what it is about, then opens.
   *
   * Selecting without seeking is deliberate: the menu must not rearrange the
   * thing it is a menu for. For the same reason a dialogue clip does not go
   * through `selectVoice`, which force-switches mode — that becomes an item you
   * can choose instead of a side effect you cannot decline.
   */
  const openMenu: OpenMenu = (e, target) => {
    e.preventDefault();
    e.stopPropagation();
    if (target.kind === 'beat' || target.kind === 'dialogue') selectBeat(target.index, false);
    if (target.kind === 'motion') setSelectedMotionId(target.segmentId);
    // Chrome reports 0,0 for a keyboard-invoked menu (the Menu key, Shift+F10).
    // Anchor those to the focused row instead of the corner of the screen.
    const box = e.clientX === 0 && e.clientY === 0
      ? (document.activeElement as HTMLElement | null)?.getBoundingClientRect() ?? null
      : null;
    setMenu({ x: box ? box.left : e.clientX, y: box ? box.bottom : e.clientY, target });
  };

  /**
   * What each kind of thing can do, assembled from the actions that already
   * exist. Built during render rather than memoized: it closes over most of
   * this component, and computing it live is what keeps the ✓ marks honest.
   */
  function menuItemsFor(target: MenuTarget): MenuItem[] {
    const goMode = (m: Mode, label: string) => act({ label, on: mode === m, go: () => setMode(m) });
    const overlay = (key: keyof OverlayPrefs, label: string) =>
      act({ label, on: prefs[key], go: () => setPrefs({ [key]: !prefs[key] }) });
    const snapItem = act({ label: 'Snap to beats', on: prefs.snap, go: () => setPrefs({ snap: !prefs.snap }) });
    const fitItem = act({ label: 'Fit scene to width', on: timelineZoom === 1, go: () => setTimelineZoom(1) });

    switch (target.kind) {
      case 'beat': {
        const beat = shots?.beats[target.index];
        if (!beat) return [];
        return [
          act({ label: 'Edit this beat', keys: '↵', go: () => { selectBeat(target.index); selectTab('beat'); } }),
          act({
            label: beat.locked ? 'Unlock beat' : 'Lock beat',
            on: beat.locked,
            hint: 'Locked beats survive a re-direct untouched.',
            go: () => void editBeat(target.index, { ...beat, locked: !beat.locked }),
          }),
          act({
            label: 'Play from here',
            keys: 'Space',
            go: () => stageRef.current?.seekMs(beatStarts[target.index] ?? 0),
          }),
          sep,
          goMode('write', 'Open in Write'),
          goMode('direct', 'Open in Direct'),
        ];
      }
      case 'dialogue': {
        const beat = shots?.beats[target.index];
        const cue = cueForBeat(dialogue, beat ?? null);
        if (!cue) return [];
        const takeId = cue.selectedTakeId;
        const rigName = shots?.cast.find((m) => m.id === cue.speaker)?.rig ?? cue.speaker;
        const bound = Boolean(cast.find((c) => c.name === rigName)?.voiceRef);
        return [
          act({ label: 'Open in Perform', go: () => selectVoice(target.index) }),
          act({ label: 'Line Booth', hint: 'Perform this line with context playback and a count-in.', go: () => { selectVoice(target.index); openBooth(); } }),
          sep,
          act({
            label: 'Use the character voice',
            hint: 'Approve the generated voice for this line — the explicit decision that no recording is intended.',
            go: () => useGenerated(cue, 'line'),
          }),
          act({
            label: 'Convert to the character voice',
            disabled: !takeId || !bound,
            disabledReason: !takeId
              ? 'Record or select a take first — conversion needs a performance to convert.'
              : `${rigName} has no voice reference yet. Give them one in the cast editor.`,
            go: () => convertToCharacter(cue),
          }),
          act({
            label: 'Check the conversion',
            disabled: !takeId,
            disabledReason: 'No take is selected for this line.',
            go: () => takeId && setScoreTake({
              takeId,
              label: `${cue.speaker} — “${cue.displayText.slice(0, 44)}${cue.displayText.length > 44 ? '…' : ''}”`,
            }),
          }),
          sep,
          act({
            label: 'Discard the selected take',
            danger: true,
            disabled: !takeId,
            disabledReason: 'No take is selected for this line.',
            go: () => takeId && discardTake(takeId),
          }),
        ];
      }
      case 'motion': {
        const blocker = animation ? motionDeletionBlocker(animation, target.segmentId) : 'No animation document is loaded.';
        return [
          act({
            label: 'Open in Animate',
            go: () => {
              setSelected(null);
              setSelectedMotionId(target.segmentId);
              setMode('animate');
            },
          }),
          sep,
          act({
            label: 'Delete motion',
            danger: true,
            keys: 'Del',
            disabled: Boolean(blocker) || busy === 'delete-motion',
            disabledReason: blocker ?? 'A motion delete is already running.',
            go: () => askDeleteMotion(target.segmentId),
          }),
        ];
      }
      case 'track':
        return [
          act({
            label: trackLocks[target.trackId] ? 'Unlock track' : 'Lock track',
            on: trackLocks[target.trackId],
            hint: 'A locked track ignores clicks on its clips.',
            go: () => setTrackLocks((l) => ({ ...l, [target.trackId]: !l[target.trackId] })),
          }),
          sep,
          snapItem,
          fitItem,
        ];
      case 'ruler':
      case 'lane':
        return [
          act({ label: 'Play from here', go: () => stageRef.current?.seekMs(target.ms) }),
          sep,
          snapItem,
          fitItem,
          sep,
          act({ label: 'Command palette…', keys: '⌘K', go: () => setCmd(true) }),
        ];
      case 'actor': {
        const member = shots?.cast.find((item) => item.id === target.actorId);
        return [
          act({ label: `Open ${target.actorId} in the cast editor`, go: () => onOpenCast(member?.rig ?? target.actorId) }),
          act({ label: 'Character inspector', go: () => selectTab('character') }),
          sep,
          goMode('animate', 'Animate this character'),
        ];
      }
      case 'prop':
        return [
          act({ label: 'Prop inspector', go: () => selectTab('prop') }),
          act({ label: 'Open the set designer', go: () => onOpenSets(setName) }),
          act({ label: 'Edit this prop…', go: () => onOpenProps(target.propId.replace(/-\d+$/, '')) }),
        ];
      case 'stage':
        return [
          act({ label: 'Play / pause', keys: 'Space', go: () => stageRef.current?.togglePlay() }),
          sep,
          section('Overlays'),
          overlay('grid', 'Composition grid'),
          overlay('safe', 'Safe areas'),
          overlay('marks', 'Actor marks'),
          overlay('path', 'Motion path'),
          overlay('captions', 'Captions'),
        ];
      case 'scene':
        return [
          act({ label: `Open ${target.name}`, disabled: target.name === scene, disabledReason: 'Already open.', go: () => onScene(target.name) }),
          sep,
          act({ label: 'New scene…', go: onNewScene }),
        ];
      case 'cast':
        return [
          act({ label: `Open ${target.name} in the cast editor`, go: () => onOpenCast(target.name) }),
          sep,
          act({ label: 'Validate cast rigs', go: () => void runCastCheck() }),
          act({ label: 'Contact sheet — whole cast', go: () => void runContactSheet() }),
        ];
      case 'set': {
        const inUse = target.name === setName;
        return [
          act({
            label: `Use ${target.name} in this scene`,
            disabled: inUse || !shots,
            disabledReason: inUse ? 'This scene already stages here.' : 'Direct the scene first — the set lives on the shot list.',
            go: () => chooseSet(target.name),
          }),
          sep,
          act({ label: `Open ${target.name} in the set designer`, go: () => onOpenSets(target.name) }),
        ];
      }
      case 'sceneFile': {
        const open = (path: string) => window.open(`/api/scenes/${scene}/${path}`, '_blank');
        if (target.file === 'video') {
          return [
            act({ label: 'Open the render', disabled: !detail?.hasExport, disabledReason: 'Nothing has been rendered yet.', go: () => open('video') }),
            act({ label: 'Export manifest', disabled: !detail?.hasExport, disabledReason: 'Written by the render.', go: () => open('export') }),
            sep,
            goMode('publish', 'Open in Publish'),
          ];
        }
        const owner: Record<Exclude<typeof target.file, 'video'>, Mode> = {
          script: 'write', shotlist: 'direct', dialogue: 'perform', animation: 'animate',
        };
        return [
          goMode(owner[target.file], `Open in ${owner[target.file][0]!.toUpperCase()}${owner[target.file].slice(1)}`),
          sep,
          act({ label: 'Production readiness', go: () => { setPreflightOpen(true); void refreshPreflight(); } }),
        ];
      }
      case 'chrome':
        return [
          act({ label: 'Command palette…', keys: '⌘K', go: () => setCmd(true) }),
          sep,
          section('Go to'),
          ...MODE_DEFS.map((m) => goMode(m.id, m.label)),
          sep,
          act({ label: 'Check', hint: 'Parse, direct and validate. Sub-second, renders nothing.', go: () => void runCheck() }),
          act({ label: 'Production readiness', go: () => { setPreflightOpen(true); void refreshPreflight(); } }),
          act({ label: 'System report', go: () => setSystemOpen(true) }),
        ];
    }
  }

  // --- assembled pieces ---
  const identityLabel = show ? `${show.active.id}@${show.active.hash.slice(0, 12)}` : '…';
  const sceneTitle = scene.split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
  const beatsCount = shots?.beats.length ?? check?.beats.length ?? 0;
  const sceneMeta = `${beatsCount ? `${beatsCount} beats` : 'undirected'}${totalMs ? ` · ${(totalMs / 1000).toFixed(1)}s` : ''}${staleBeats ? ' · script ahead' : ''}`;
  const hasStaleRender = Boolean(preflight?.notes.some((n) => n.code.includes('stale')));
  const selectedCue = cueForBeat(dialogue, selectedBeat);
  const speakerBound = selectedCue
    ? Boolean(cast.find((c) => c.name === shots?.cast.find((m) => m.id === selectedCue.speaker)?.rig)?.voiceRef)
    : false;

  const performContext = selected !== null && selected > 0 && audioPlayable
    ? {
        audioUrl: `/api/scenes/${scene}/audio`,
        startMs: beatStarts[Math.max(0, selected - 1)] ?? 0,
        endMs: beatStarts[selected] ?? playheadMs,
      }
    : null;
  const sceneRun = audioPlayable && totalMs > 0
    ? { audioUrl: `/api/scenes/${scene}/audio`, beatStarts, durationMs: totalMs }
    : null;

  /**
   * Put the creator in front of what a readiness note is about.
   *
   * Switching mode alone was never enough: a note naming `sarah:line-19293i4`
   * left you in a mode with dozens of lines and no way to tell which. When the
   * note carries a target, select the thing; otherwise fall back to the mode
   * the code implies.
   */
  const jumpToNote = (note: ProductionPreflightNote) => {
    const target = note.target;
    const beats = shots?.beats ?? [];

    if (target?.kind === 'cue' || target?.kind === 'beat') {
      const index = beats.findIndex((beat) => beat.id === target.id);
      if (index >= 0) {
        setMode(target.kind === 'cue' ? 'perform' : 'direct');
        selectBeat(index);
        if (target.kind === 'cue') setTab('voice');
        setPreflightOpen(false);
        return;
      }
    }
    if (target?.kind === 'motion') {
      setMode('animate');
      const segment = animation?.segments.find((item) => item.id === target.id);
      // An orphaned segment has no beat to seek to, but selecting it is what
      // lets Delete reach it.
      if (segment) setSelectedMotionId(segment.id);
      setPreflightOpen(false);
      return;
    }
    if (target?.kind === 'actor') {
      const member = shots?.cast.find((item) => item.id === target.id);
      onOpenCast(member?.rig ?? target.id);
      setPreflightOpen(false);
      return;
    }
    if (target?.kind === 'set') {
      onOpenSets(target.id.replace(/\.(json|svg)$/, ''));
      setPreflightOpen(false);
      return;
    }

    const code = note.code;
    if (/dialogue|voice|take/.test(code)) setMode('perform');
    else if (/animation|motion|blocking|walkable|staging/.test(code)) setMode('animate');
    else if (/action|script|caption/.test(code)) setMode('direct');
    else if (/render|export/.test(code)) setMode('publish');
    setPreflightOpen(false);
  };

  const subPane = mode === 'animate' ? null : (
    <div
      className="shrink-0 flex flex-col bg-stage border-r border-edge min-h-0"
      style={{ width: subPaneWidth(mode) }}
    >
      {(mode === 'write' || mode === 'direct') && (
        <ScriptPane
          scene={scene}
          source={source}
          onChange={setSource}
          mode={mode}
          vocab={vocab}
          cast={cast}
          check={check}
          checkedSource={checkedSource}
        />
      )}
      {mode === 'perform' && (
        <LinesPane
          dialogue={dialogue}
          shots={shots}
          selected={selected}
          onSelect={(i) => { selectBeat(i); setTab('voice'); }}
          speakerFilter={null}
          onDiscardOrphans={discardOrphanCues}
        />
      )}
      {mode === 'publish' && (
        <ReadinessPane report={preflight} onJump={jumpToNote} />
      )}
      {mode === 'sound' && (
        <MixerPane
          scene={scene}
          sound={sound}
          loading={soundLoading}
          rebuilding={busy === 'sound'}
          onRebuild={() => void runJob('sound')}
        />
      )}
    </div>
  );

  /**
   * The way out of a stage the set has blocked.
   *
   * The compiler stops at the first prop it cannot resolve, which reads as "the
   * editor is broken" from the stage. The same fit that prices the picker
   * explains it here in the creator's own words, and offers the repair from the
   * place the problem is being experienced.
   */
  const currentSetFit = pricedSets?.find((item) => item.name === setName)?.fit ?? null;
  const blockedMotionFix = !preview && strandedMotion.length ? (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="text-[10.5px] leading-[1.45]">
        <span className="text-[#d6c3c3]">
          {strandedMotion.length} motion segment{strandedMotion.length === 1 ? '' : 's'} still
          {' '}move{strandedMotion.length === 1 ? 's' : ''}{' '}
          {[...new Set(strandedMotion.map((segment) => segment.actorId))].join(', ')}
        </span>
        <span className="text-ink-faint"> — not in this scene's cast, left behind by an earlier draft.</span>
      </div>
      <div>
        <Btn primary onClick={dropStrandedMotion} title="Remove blocking for actors this scene does not have.">
          Remove {strandedMotion.length === 1 ? 'it' : `those ${strandedMotion.length}`}
        </Btn>
      </div>
    </div>
  ) : null;

  const blockedSetFix = !preview && currentSetFit?.issues.length ? (
    <div className="mt-2 flex flex-col gap-2">
      {currentSetFit.issues.slice(0, 3).map((issue, i) => {
        const options = usableSubstitutes(issue);
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="text-[10.5px] leading-[1.45]">
              <span className="text-[#d6c3c3]">{issue.detail}</span>
              <span className="text-ink-faint"> — “{issue.label}”</span>
            </div>
            {options.length ? (
              <div className="flex items-center gap-1 flex-wrap">
                {options.map((option) => (
                  <Btn
                    key={option.reference}
                    primary={options.length === 1}
                    onClick={() => {
                      pushShots((current) => retargetOne(current, issue, option.reference!), false);
                      // There is no undo stack, so name the way back that exists:
                      // the script still says exactly what it always said.
                      setInfo(
                        `“${issue.label}” now points at the ${option.label.toLowerCase()}. `
                        + 'The script is untouched — Direct it again to get the original staging back.',
                      );
                    }}
                    title={`Rewrite this beat's target to "${option.reference}" and keep everything else.`}
                  >
                    {issue.verb} the {option.label.toLowerCase()}
                  </Btn>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-ink-faint leading-[1.45]">
                Nothing in “{setName}” can take it. Rewrite the beat in Write, or stage the scene somewhere that can —
                the picker below prices every set against this scene.
              </div>
            )}
          </div>
        );
      })}
      {currentSetFit.issues.length > 3 && (
        <div className="text-[10px] text-ink-faint">and {currentSetFit.issues.length - 3} more.</div>
      )}
      <div className="flex items-center gap-1.5">
        <SetPicker
          sets={pricedSets ?? sets}
          current={setName}
          onChoose={chooseSet}
          onOpenDesigner={onOpenSets}
        />
        <span className="text-[10px] text-ink-faint">every set, priced against this scene</span>
      </div>
    </div>
  ) : null;

  const bottomStrip = mode === 'write' || mode === 'direct'
    ? (shots ? <ShotStrip shots={shots} beatStarts={beatStarts} selected={selected} onSelect={selectBeat} /> : null)
    : mode === 'perform'
      ? (
          <TakeStrip
            scene={scene}
            cue={selectedCue}
            dialogue={dialogue}
            sceneLines={sceneLines}
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
            onScoreAcrossCast={selectedCue?.selectedTakeId ? () => {
              const takeId = selectedCue.selectedTakeId!;
              setScoreTake({
                takeId,
                label: `${selectedCue.speaker} — “${selectedCue.displayText.slice(0, 44)}${selectedCue.displayText.length > 44 ? '…' : ''}”`,
              });
            } : null}
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
    <div
      className="h-full flex flex-col bg-stage text-ink text-[12px] overflow-hidden relative"
      /*
       * The fallback menu, so right-click is never dead. Bubble phase, which
       * gives specificity for free: a clip's own handler runs first and stops
       * propagation, so this only fires on chrome nothing else claimed.
       */
      onContextMenu={(e) => { if (!isTyping(e.target)) openMenu(e, { kind: 'chrome' }); }}
    >
      <AppBar
        sceneTitle={sceneTitle}
        sceneMeta={sceneMeta}
        sceneMetaStale={staleBeats > 0}
        save={save}
        mode={mode}
        onMode={setMode}
        tools={tools}
        show={show}
        onSwitchIdentity={switchIdentity}
        onCompareIdentity={() => setCompareOpen(true)}
        onRenderReel={askRenderReel}
        quality={quality}
        onCycleQuality={cycleQuality}
        engine={engine}
        engines={engines}
        onEngine={setEngine}
        preflight={preflight}
        preflightBusy={preflightBusy}
        onTogglePreflight={() => {
          const opening = !preflightOpen;
          setPreflightOpen(opening);
          // Opening the report *is* the question "what is true now?". It costs
          // milliseconds, and refreshing only when empty is what let a verdict
          // from before the last Voices run keep answering it.
          if (opening) void refreshPreflight();
        }}
        onRender={() => {
          setMode('publish');
          setPreflightOpen(true);
          void refreshPreflight();
        }}
        onCmd={() => setCmd(true)}
      />

      {staleBeats > 0 && shots && check && (
        <StaleBar
          beats={staleBeats}
          scriptBeats={check.beats.length}
          shotBeats={shots.beats.length}
          busy={busy === 'direct'}
          onApply={() => void runDirect()}
        />
      )}

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
          staleBeats={staleBeats}
          cast={cast}
          sets={sets}
          props={props}
          health={health}
          mode={mode}
          onScene={onScene}
          onMode={setMode}
          onNewScene={onNewScene}
          onOpenCast={onOpenCast}
          onOpenSets={onOpenSets}
          onUseSet={chooseSet}
          onOpenProps={onOpenProps}
          onOpenSystem={() => setSystemOpen(true)}
          onContextMenu={openMenu}
        />

        <div className="flex-1 min-w-0 flex flex-col bg-deep">
          <div className="flex-1 min-h-0 flex">
            {subPane}
            <StageColumn
              ref={stageRef}
              mode={mode}
              preview={preview}
              audioUrl={audioPlayable ? `/api/scenes/${scene}/audio` : null}
              onAudioError={setInfo}
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
              toolbarExtra={shots ? (
                <SetPicker
                  sets={pricedSets ?? sets}
                  current={shots.set ? shots.set.replace(/\.(json|svg)$/, '') : null}
                  onChoose={chooseSet}
                  onOpenDesigner={onOpenSets}
                  onDescribe={() => onOpenSets(null)}
                />
              ) : null}
              previewRepair={blockedSetFix || blockedMotionFix ? (
                <>{blockedSetFix}{blockedMotionFix}</>
              ) : null}
              bottomStrip={bottomStrip}
              onContextMenu={openMenu}
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
          sets={pricedSets ?? sets}
          playheadMs={playheadMs}
          totalMs={totalMs}
          identityLabel={identityLabel}
          expressionsFor={expressionsFor}
          onEditBeat={(i, next) => void editBeat(i, next)}
          onEditCast={(actorId, changes) => void editCastMember(actorId, changes)}
          onEditShots={(changes) => void editShots(changes)}
          onChooseSet={chooseSet}
          onEditAllCast={(changes) => void editAllCast(changes)}
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
        zoom={timelineZoom}
        locks={trackLocks}
        onToggleSnap={() => setPrefs({ snap: !prefs.snap })}
        onZoom={setTimelineZoom}
        onToggleLock={(trackId) => setTrackLocks((l) => ({ ...l, [trackId]: !l[trackId] }))}
        onSelect={selectBeat}
        onScrub={(ms) => stageRef.current?.seekMs(ms)}
        onSelectVoice={selectVoice}
        onSelectMotion={(segmentId) => {
          setSelected(null);
          setSelectedMotionId(segmentId);
          setMode('animate');
        }}
        onDeleteMotion={askDeleteMotion}
        onContextMenu={openMenu}
      />

      {/* status bar */}
      <div className="h-[22px] shrink-0 flex items-center gap-2.5 px-2.5 bg-deep border-t border-edge font-mono text-[10px] text-ink-faint select-text">
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
            <div className="text-[11px] text-[#d6c3c3] leading-[1.45] break-words select-text">{error}</div>
          </div>
        )}
        {info && (
          <div className="pointer-events-auto border border-edge bg-panel rounded-[3px] px-2.5 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[8.5px] tracking-[.07em] uppercase text-gen border border-gen rounded-[2px] px-1">note</span>
              <div className="flex-1" />
              <button type="button" onClick={() => setInfo(null)} className="text-ink-faint text-[11px] cursor-pointer hover:text-ink">×</button>
            </div>
            <div className="text-[11px] text-[#c9ccd1] leading-[1.45] break-words select-text">{info}</div>
          </div>
        )}
      </div>

      {/* overlays */}
      {cmd && <CommandPalette commands={commands} onClose={() => setCmd(false)} />}
      {systemOpen && <SystemReport onClose={() => setSystemOpen(false)} />}
      {compareOpen && show && <CompareOverlay show={show} onClose={() => setCompareOpen(false)} />}
      {auditionOpen && <AuditionOverlay onClose={() => setAuditionOpen(false)} />}
      {scoreTake && (
        <ConversionCheckOverlay
          scene={scene}
          takeId={scoreTake.takeId}
          takeLabel={scoreTake.label}
          onClose={() => setScoreTake(null)}
        />
      )}
      {preflightOpen && (
        <PreflightPopover
          report={preflight}
          busy={preflightBusy}
          checkedAgoS={preflightAgoS}
          onClose={() => setPreflightOpen(false)}
          onAcknowledge={() => void acknowledgeWarnings()}
          onJump={jumpToNote}
          onRender={askRenderMaster}
        />
      )}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
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
          disabled={llmStart.status ? !llmStart.status.ok : false}
          disabledReason={llmStart.status?.reason ?? null}
          startable={llmStart.startable}
          starting={llmStart.starting}
          startError={llmStart.startError}
          onStart={() => void llmStart.start()}
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
