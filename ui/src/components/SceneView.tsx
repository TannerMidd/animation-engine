import { useCallback, useEffect, useRef, useState } from 'react';
import { api, followJob, fmtMs } from '../api.ts';
import type {
  AnimationDocument, Beat, CastMember, CheckResult, DialogueCue, DialogueDocument, JobEvent, LlmStatus,
  PreviewInfo, PropDefInfo, SceneDetail, SetDescriptor, ShotList, Vocab,
} from '../types.ts';
import { GenerateDialog } from './GenerateDialog.tsx';
import { ScriptEditor } from './ScriptEditor.tsx';
import { Preview, type PreviewHandle } from './Preview.tsx';
import { BeatTimeline } from './BeatTimeline.tsx';
import { BeatInspector } from './BeatInspector.tsx';
import { PerformancePanel } from './PerformancePanel.tsx';
import { AnimationPanel } from './AnimationPanel.tsx';
import type { AnimationEditTarget } from './AnimationOverlay.tsx';
import { Button, Panel, Badge, Spinner, Select, Empty } from './ui.tsx';

/**
 * The main working surface: write, watch, retime, render.
 *
 * Two loops, deliberately different speeds. Editing the script re-checks on a
 * debounce and rebuilds an *estimated* preview — instant, no TTS. Editing a
 * beat writes the shot list and rebuilds too. Only "Voices" and "Render" cost
 * real time, and both are explicit.
 */
export function SceneView({
  scene, vocab, llm, expressionsFor, onSceneChanged,
}: {
  scene: string;
  vocab: Vocab | null;
  llm: LlmStatus | null;
  expressionsFor: (actorId: string) => string[];
  onSceneChanged: () => void;
}) {
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [source, setSource] = useState('');
  const [shots, setShots] = useState<ShotList | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<{ kind: string; event: JobEvent | null } | null>(null);
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof api.preflight>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withAudio, setWithAudio] = useState(false);
  const [previewLayout, setPreviewLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  const [setName, setSetName] = useState<string>('office');
  const [sets, setSets] = useState<string[]>([]);
  const [setDescriptor, setSetDescriptor] = useState<SetDescriptor | null>(null);
  const [propDefs, setPropDefs] = useState<PropDefInfo[]>([]);
  const [dialogue, setDialogue] = useState<DialogueDocument | null>(null);
  const [animation, setAnimation] = useState<AnimationDocument | null>(null);
  const [animationTarget, setAnimationTarget] = useState<AnimationEditTarget | null>(null);
  const [inspector, setInspector] = useState<'beat' | 'perform' | 'animate'>('beat');

  const [writing, setWriting] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const previewRef = useRef<PreviewHandle>(null);
  const dirty = useRef(false);

  // --- load ---
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setSelected(null);
    setError(null);
    setDialogue(null);
    setAnimation(null);
    setAnimationTarget(null);
    setPreflight(null);
    void (async () => {
      try {
        const [d, s, registry] = await Promise.all([api.scene(scene), api.sets(), api.props()]);
        if (cancelled) return;
        setDetail(d);
        setSource(d.source);
        setShots(d.shots);
        setWithAudio(d.hasAudio);
        setSets(s.map((x) => x.name));
        setPropDefs(registry.props);
        if (d.shots?.set) setSetName(d.shots.set.replace(/\.(json|svg)$/, ''));
        if (d.shots) {
          const [dialogueDocument, animationDocument] = await Promise.all([
            api.dialogue(scene),
            api.animation(scene),
          ]);
          if (cancelled) return;
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

  useEffect(() => {
    let cancelled = false;
    setSetDescriptor(null);
    if (!setName) return () => { cancelled = true; };
    void api.set(setName)
      .then((descriptor) => {
        if (!cancelled) setSetDescriptor(descriptor);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [setName]);

  // --- rebuild preview whenever the shot list changes ---
  const rebuildPreview = useCallback(
    async (audio: boolean) => {
      try {
        setPreview(await api.preview(scene, audio, previewLayout));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [previewLayout, scene],
  );

  const reloadDialogue = useCallback(async () => {
    setPreflight(null);
    const document = await api.dialogue(scene);
    setDialogue(document);
  }, [scene]);

  const saveDialogueCue = useCallback(async (cue: DialogueCue) => {
    setPreflight(null);
    await api.saveDialogueCue(scene, cue, dialogue?.revision);
    await reloadDialogue();
    await rebuildPreview(withAudio);
  }, [dialogue?.revision, rebuildPreview, reloadDialogue, scene, withAudio]);

  const changeAnimationDocument = useCallback((document: AnimationDocument) => {
    setPreflight(null);
    setAnimation(document);
    void rebuildPreview(withAudio);
  }, [rebuildPreview, withAudio]);

  const changeAnimationTarget = useCallback((target: AnimationEditTarget | null) => {
    setAnimationTarget(target);
  }, []);

  const setPropInstances = setDescriptor && setDescriptor.name === setName
    ? Object.values(setDescriptor.layers).flat()
    : [];
  const seatablePropInstances = setDescriptor && setDescriptor.name === setName
    ? [...setDescriptor.layers.back, ...setDescriptor.layers.mid]
    : [];
  const propTypeCounts = new Map<string, number>();
  for (const instance of setPropInstances) {
    propTypeCounts.set(instance.prop, (propTypeCounts.get(instance.prop) ?? 0) + 1);
  }
  const addressablePropRef = (instance: (typeof setPropInstances)[number]): string | null =>
    instance.id ?? (propTypeCounts.get(instance.prop) === 1 ? instance.prop : null);
  const propTargets = setPropInstances
    .filter((instance) => propDefs.find((def) => def.key === instance.prop)?.interaction?.handles.some((handle) =>
      handle.kind === 'contact' || handle.kind === 'control' || handle.kind === 'grip'))
    .map(addressablePropRef)
    .filter((ref): ref is string => Boolean(ref));
  const portablePropTargets = setPropInstances
    .filter((instance) => propDefs.find((def) => def.key === instance.prop)?.interaction?.portable)
    .map(addressablePropRef)
    .filter((ref): ref is string => Boolean(ref));
  const placementTargets = setPropInstances
    .filter((instance) => propDefs.find((def) => def.key === instance.prop)?.interaction?.handles.some((handle) =>
      handle.kind === 'placement'))
    .map(addressablePropRef)
    .filter((ref): ref is string => Boolean(ref));
  const seatTargets = seatablePropInstances
    .filter((instance) => propDefs.find((def) => def.key === instance.prop)?.interaction?.handles.some((handle) =>
      handle.kind === 'seat'))
    .map(addressablePropRef)
    .filter((ref): ref is string => Boolean(ref));

  useEffect(() => {
    if (!shots) return;
    const t = setTimeout(() => void rebuildPreview(withAudio), 120);
    return () => clearTimeout(t);
  }, [shots, withAudio, rebuildPreview]);

  // --- debounced save + check while typing ---
  useEffect(() => {
    if (!detail || source === detail.source) return;
    setPreflight(null);
    dirty.current = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await api.saveScript(scene, source);
          setCheck(await api.check(scene, { source, set: setName }));
          dirty.current = false;
        } catch (err) {
          setError((err as Error).message);
        }
      })();
    }, 500);
    return () => clearTimeout(t);
  }, [source, detail, scene, setName]);

  // --- actions ---
  /**
   * Directing is propose-then-apply: the director returns a proposal and a
   * diff, and locked beats survive the merge. The confirm names what changes,
   * so accepting is a decision rather than a habit.
   */
  const runDirect = async () => {
    setBusy('direct');
    try {
      await api.saveScript(scene, source);
      const res = await api.direct(scene, { source, set: setName });

      const changes = res.diff.filter((d) => d.change !== 'kept-locked').length;
      const summary =
        `${changes} beat${changes === 1 ? '' : 's'} change` +
        (res.keptLocked ? `; ${res.keptLocked} locked beat${res.keptLocked === 1 ? '' : 's'} kept` : '') +
        (res.droppedLocked ? `; ${res.droppedLocked} locked beat${res.droppedLocked === 1 ? '' : 's'} no longer match the script and would be dropped` : '');

      if (shots && !window.confirm(`Apply the director's proposal?

${summary}`)) return;

      await api.applyDirect(scene, res.proposed);
      setShots(res.proposed);
      setSelected(null);
      const [dialogueDocument, animationDocument] = await Promise.all([
        api.dialogue(scene),
        api.animation(scene),
      ]);
      setDialogue(dialogueDocument);
      setAnimation(animationDocument);
      setError(res.errors.length ? res.errors.join('; ') : null);
      onSceneChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runJob = async (kind: 'voices' | 'render') => {
    if (kind === 'voices') setPreflight(null);
    setBusy(kind);
    setJob({ kind, event: null });
    try {
      if (kind === 'render') {
        const preflight = await api.preflight(scene);
        setPreflight(preflight);
        const blockers = preflight.notes.filter((note) => note.level === 'error');
        if (blockers.length) {
          setError(`Production preflight blocked export: ${blockers.map((note) => note.message).join('; ')}`);
          setBusy(null);
          setJob(null);
          return;
        }
        if (preflight.warningReview.required && !preflight.warningReview.current) {
          setError('Production warnings need a current, persisted creator acknowledgement. Review them below and acknowledge before rendering.');
          setBusy(null);
          setJob(null);
          return;
        }
      }
      const started = kind === 'voices' ? await api.voices(scene) : await api.render(scene);
      const stop = followJob(started.id, (e) => {
        setJob({ kind, event: e });
        if (e.type === 'done' || e.type === 'error') {
          stop();
          setBusy(null);
          if (e.type === 'error') setError(e.message ?? 'job failed');
          else {
            void api.scene(scene).then((d) => {
              setDetail(d);
              if (kind === 'voices') {
                setWithAudio(true);
                void rebuildPreview(true);
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
  };

  const runPreflight = async () => {
    setBusy('preflight');
    setError(null);
    try {
      setPreflight(await api.preflight(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const acknowledgePreflightWarnings = async () => {
    setBusy('acknowledging warnings');
    setError(null);
    try {
      setPreflight(await api.acknowledgePreflightWarnings(scene));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Beat edits write straight through to the shot list on disk. */
  const editBeat = async (index: number, next: Beat) => {
    if (!shots) return;
    const updated: ShotList = { ...shots, beats: shots.beats.map((b, i) => (i === index ? next : b)) };
    setPreflight(null);
    setShots(updated);
    try {
      await api.saveShotList(scene, updated);
      await reloadDialogue();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const editCastMember = async (actorId: string, changes: Partial<CastMember>) => {
    if (!shots) return;
    const updated: ShotList = {
      ...shots,
      cast: shots.cast.map((member) => member.id === actorId ? { ...member, ...changes } : member),
    };
    setPreflight(null);
    setShots(updated);
    try {
      await api.saveShotList(scene, updated);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const beats = shots?.beats ?? [];
  const beatStarts = preview?.beatStarts ?? [];
  const duration = preview?.durationMs ?? 0;
  const castIds = shots?.cast.map((c) => c.id) ?? [];
  const errors = check?.errors ?? [];
  const selectedBeat = selected === null ? null : (beats[selected] ?? null);
  const selectedCue = selectedBeat?.kind === 'line'
    ? dialogue?.cues.find((cue) => cue.id === selectedBeat.id) ?? null
    : null;
  const performanceContext = selected !== null && selected > 0 && withAudio && detail?.hasAudio
    ? {
        audioUrl: `/api/scenes/${scene}/audio`,
        startMs: beatStarts[Math.max(0, selected - 1)] ?? 0,
        endMs: beatStarts[selected] ?? playheadMs,
      }
    : null;

  const jobLabel = () => {
    const e = job?.event;
    if (!e) return 'starting…';
    if (e.type === 'done') return 'done';
    if (e.type === 'error') return e.message ?? 'failed';
    const pct = e.total ? ` ${e.done}/${e.total}` : '';
    return `${e.stage ?? job?.kind}${pct}`;
  };

  /** Generated scripts land in the editor unsaved, so a bad take costs nothing. */
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

  return (
    <div className="flex flex-col h-full min-h-0 gap-2 p-2">
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
          onGenerate={(t) => void runWrite(t)}
          onClose={() => {
            setWriting(false);
            setGenError(null);
          }}
        />
      )}

      {/* toolbar */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[13px] font-medium">{scene}</span>
        {check && <span className="text-[11px] text-ink-faint">~{fmtMs(check.estimateMs)}</span>}
        {shots && <span className="text-[11px] text-ink-faint">{beats.length} beats</span>}

        <div className="flex-1" />

        <span className="text-[11px] text-ink-faint">set</span>
        <Select value={setName} options={sets.length ? sets : [setName]} onChange={setSetName} />
        <Button
          variant={previewLayout === 'vertical' ? 'default' : 'ghost'}
          onClick={() => setPreviewLayout((value) => value === 'horizontal' ? 'vertical' : 'horizontal')}
          title="Preview the actor-aware publishing camera"
        >
          {previewLayout === 'vertical' ? '9:16 view' : '16:9 view'}
        </Button>

        <Button onClick={() => setWriting(true)} disabled={!!busy} title="Write this scene from a premise using the local model.">
          Write…
        </Button>
        <Button onClick={runDirect} disabled={!!busy} title="Propose new direction. Locked beats survive; you confirm before anything is written.">
          {busy === 'direct' ? <Spinner /> : 'Direct'}
        </Button>
        <Button onClick={() => void runJob('voices')} disabled={!!busy || !shots}>
          {busy === 'voices' ? <Spinner /> : 'Voices'}
        </Button>
        <Button onClick={() => void runPreflight()} disabled={!!busy || !shots} title="Check production voices, staging, animation, continuity, and soundtrack freshness.">
          {busy === 'preflight' ? <Spinner /> : 'Preflight'}
        </Button>
        <Button
          variant="primary"
          onClick={() => void runJob('render')}
          disabled={!!busy || !shots || Boolean(preflight && (!preflight.ok || (preflight.warningReview.required && !preflight.warningReview.current)))}
          title={preflight && !preflight.ok
            ? 'Resolve the blocking preflight errors below before rendering.'
            : preflight?.warningReview.required && !preflight.warningReview.current
              ? 'Review and acknowledge the current preflight warnings below before rendering.'
              : undefined}
        >
          {busy === 'render' ? <Spinner /> : 'Render'}
        </Button>
        {detail?.hasVideo && (
          <a
            href={`/api/scenes/${scene}/video`}
            target="_blank"
            rel="noreferrer"
            className="px-2.5 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[12px]"
          >
            MP4
          </a>
        )}
        {detail?.hasVertical && (
          <a
            href={`/api/scenes/${scene}/video/vertical`}
            className="px-2 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[11px]"
            download
            title="Actor-aware 9:16 master"
          >
            9:16 MP4
          </a>
        )}
        {detail?.hasExport && (
          <>
            <a
              href={`/api/scenes/${scene}/captions.vtt`}
              className="px-2 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[11px]"
              download
              title="WebVTT sidecar; captions are not burned into the MP4"
            >
              VTT captions
            </a>
            <a href={`/api/scenes/${scene}/thumbnail/0`} target="_blank" rel="noreferrer" className="px-2 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[11px]">
              Thumbnail
            </a>
            <a href={`/api/scenes/${scene}/export`} target="_blank" rel="noreferrer" className="px-2 py-1 rounded border border-edge bg-panel-2 hover:bg-edge text-[11px]">
              Manifest
            </a>
          </>
        )}
      </div>

      {(job || error) && (
        <div className="shrink-0 flex items-center gap-2 text-[11px] px-2 py-1 rounded bg-panel border border-edge">
          {job && (
            <>
              <Badge tone={job.event?.type === 'error' ? 'bad' : job.event?.type === 'done' ? 'good' : 'warn'}>
                {job.kind}
              </Badge>
              <span className="text-ink-dim tabular-nums">{jobLabel()}</span>
            </>
          )}
          {error && <span className="text-bad flex-1 truncate">{error}</span>}
        </div>
      )}

      {preflight && (
        <div className="shrink-0 max-h-24 overflow-auto rounded border border-edge bg-panel px-2 py-1">
          <div className="flex items-center gap-2 mb-0.5">
            <Badge tone={!preflight.ok ? 'bad' : preflight.notes.some((note) => note.level === 'warn') ? 'warn' : 'good'}>
              {!preflight.ok
                ? 'production blocked'
                : preflight.notes.some((note) => note.level === 'warn')
                  ? 'no blockers · review required'
                  : 'preflight clear'}
            </Badge>
            <span className="text-[10px] text-ink-faint">{preflight.notes.length} check note{preflight.notes.length === 1 ? '' : 's'}</span>
            {preflight.warningReview.required && preflight.warningReview.current && (
              <Badge tone="good">warnings acknowledged</Badge>
            )}
            {preflight.warningReview.required && !preflight.warningReview.current && !preflight.productionBlocked && (
              <Button
                className="py-0.5"
                disabled={!!busy}
                onClick={() => void acknowledgePreflightWarnings()}
                title="Append a review record bound to these exact warnings and creative inputs. Any edit makes it stale."
              >
                I reviewed these warnings
              </Button>
            )}
            <button className="ml-auto text-[10px] text-ink-faint hover:text-ink" onClick={() => setPreflight(null)}>close</button>
          </div>
          {preflight.warningReview.current && preflight.warningReview.acknowledgement && (
            <div className="text-[10px] text-ink-faint leading-snug">
              Review {preflight.warningReview.acknowledgement.id} · {preflight.warningReview.acknowledgement.acknowledgedBy} · {new Date(preflight.warningReview.acknowledgement.acknowledgedAt).toLocaleString()}
            </div>
          )}
          {preflight.notes.map((note, i) => (
            <div key={`${i}-${note.message}`} className={`text-[10px] leading-snug ${note.level === 'error' ? 'text-bad' : note.level === 'warn' ? 'text-accent' : 'text-ink-dim'}`}>
              {note.level.toUpperCase()} · {note.message}
            </div>
          ))}
        </div>
      )}

      {/* main row */}
      <div className="flex-1 min-h-0 flex gap-2">
        <Panel title="Script" className="w-[34%] shrink-0" bodyClass="p-0">
          <ScriptEditor value={source} onChange={setSource} />
        </Panel>

        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <Panel className="flex-1 min-h-0" bodyClass="p-0">
            <Preview
              ref={previewRef}
              previewId={preview?.previewId ?? null}
              frameCount={preview?.frameCount ?? 0}
              fps={preview?.fps ?? 24}
              viewportWidth={preview?.width ?? 1280}
              viewportHeight={preview?.height ?? 720}
              beatStarts={beatStarts}
              estimated={preview?.estimated}
              audioUrl={withAudio && detail?.hasAudio ? `/api/scenes/${scene}/audio` : null}
              onFrame={(f) => setPlayheadMs((f / (preview?.fps ?? 24)) * 1000)}
              animationTarget={inspector === 'animate' && previewLayout === 'horizontal' ? animationTarget : null}
              animationValidArea={setDescriptor?.layout.walkable ?? null}
            />
          </Panel>

          {errors.length > 0 && (
            <div className="shrink-0 max-h-24 overflow-auto rounded border border-bad/40 bg-bad/10 p-2">
              {errors.map((e, i) => (
                <div key={i} className="text-[11px] text-bad leading-snug">• {e}</div>
              ))}
            </div>
          )}
        </div>

        <Panel
          title="Creator"
          className="w-[25%] shrink-0"
          bodyClass="p-0"
          actions={
            <div className="flex gap-0.5">
              {(['beat', 'perform', 'animate'] as const).map((tab) => (
                <Button
                  key={tab}
                  variant={inspector === tab ? 'default' : 'ghost'}
                  className="px-1.5 py-0.5 text-[10px] capitalize"
                  onClick={() => setInspector(tab)}
                >
                  {tab}
                </Button>
              ))}
            </div>
          }
        >
          {inspector === 'beat' && (shots ? (
              <BeatInspector
                beat={selectedBeat}
                index={selected}
                cast={shots.cast}
                vocab={vocab}
                propTargets={propTargets}
                portablePropTargets={portablePropTargets}
                placementTargets={placementTargets}
                seatTargets={seatTargets}
                expressionsFor={expressionsFor}
                onChange={(i, next) => void editBeat(i, next)}
                onCastChange={(actorId, changes) => void editCastMember(actorId, changes)}
              />
            ) : (
              <Empty>Press Direct to build a shot list</Empty>
            ))}
          {inspector === 'perform' && (
            <PerformancePanel
              scene={scene}
              cue={selectedCue}
              document={dialogue}
              context={performanceContext}
              sceneRun={withAudio && detail?.hasAudio && duration > 0 ? {
                audioUrl: `/api/scenes/${scene}/audio`,
                beatStarts,
                durationMs: duration,
              } : null}
              onReload={reloadDialogue}
              onSaveCue={saveDialogueCue}
            />
          )}
          {inspector === 'animate' && (
            <AnimationPanel
              scene={scene}
              shots={shots}
              document={animation}
              playheadMs={playheadMs}
              onDocument={changeAnimationDocument}
              onTarget={changeAnimationTarget}
            />
          )}
        </Panel>
      </div>

      {/* timeline */}
      <Panel title="Timeline" className="h-24 shrink-0" bodyClass="p-0">
        {shots ? (
          <BeatTimeline
            beats={beats}
            beatStarts={beatStarts}
            durationMs={duration}
            selected={selected}
            cast={castIds}
            playheadMs={playheadMs}
            onSelect={(i) => {
              setSelected(i);
              const ms = beatStarts[i];
              if (ms !== undefined) previewRef.current?.seekMs(ms + 40);
            }}
          />
        ) : (
          <Empty>No shot list yet</Empty>
        )}
      </Panel>
    </div>
  );
}
