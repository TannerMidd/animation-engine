import { useCallback, useEffect, useRef, useState } from 'react';
import { api, followJob, fmtMs } from '../api.ts';
import type { Beat, CheckResult, JobEvent, LlmStatus, PreviewInfo, SceneDetail, ShotList, Vocab } from '../types.ts';
import { GenerateDialog } from './GenerateDialog.tsx';
import { ScriptEditor } from './ScriptEditor.tsx';
import { Preview, type PreviewHandle } from './Preview.tsx';
import { BeatTimeline } from './BeatTimeline.tsx';
import { BeatInspector } from './BeatInspector.tsx';
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
  const [error, setError] = useState<string | null>(null);
  const [withAudio, setWithAudio] = useState(false);
  const [setName, setSetName] = useState<string>('office');
  const [sets, setSets] = useState<string[]>([]);

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
    void (async () => {
      try {
        const [d, s] = await Promise.all([api.scene(scene), api.sets()]);
        if (cancelled) return;
        setDetail(d);
        setSource(d.source);
        setShots(d.shots);
        setWithAudio(d.hasAudio);
        setSets(s.map((x) => x.name));
        if (d.shots?.set) setSetName(d.shots.set.replace(/\.(json|svg)$/, ''));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scene]);

  // --- rebuild preview whenever the shot list changes ---
  const rebuildPreview = useCallback(
    async (audio: boolean) => {
      try {
        setPreview(await api.preview(scene, audio));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [scene],
  );

  useEffect(() => {
    if (!shots) return;
    const t = setTimeout(() => void rebuildPreview(withAudio), 120);
    return () => clearTimeout(t);
  }, [shots, withAudio, rebuildPreview]);

  // --- debounced save + check while typing ---
  useEffect(() => {
    if (!detail || source === detail.source) return;
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
  const runDirect = async () => {
    setBusy('direct');
    try {
      await api.saveScript(scene, source);
      const res = await api.direct(scene, { source, set: setName });
      setShots(res.shots);
      setSelected(null);
      setError(res.errors.length ? res.errors.join('; ') : null);
      onSceneChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runJob = async (kind: 'voices' | 'render') => {
    setBusy(kind);
    setJob({ kind, event: null });
    try {
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

  /** Beat edits write straight through to the shot list on disk. */
  const editBeat = async (index: number, next: Beat) => {
    if (!shots) return;
    const updated: ShotList = { ...shots, beats: shots.beats.map((b, i) => (i === index ? next : b)) };
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

        <Button onClick={() => setWriting(true)} disabled={!!busy} title="Write this scene from a premise using the local model.">
          Write…
        </Button>
        <Button onClick={runDirect} disabled={!!busy} title="Re-run the director. Replaces beat edits.">
          {busy === 'direct' ? <Spinner /> : 'Direct'}
        </Button>
        <Button onClick={() => void runJob('voices')} disabled={!!busy || !shots}>
          {busy === 'voices' ? <Spinner /> : 'Voices'}
        </Button>
        <Button variant="primary" onClick={() => void runJob('render')} disabled={!!busy || !shots}>
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
              beatStarts={beatStarts}
              estimated={preview?.estimated}
              audioUrl={withAudio && detail?.hasAudio ? `/api/scenes/${scene}/audio` : null}
              onFrame={(f) => setPlayheadMs((f / (preview?.fps ?? 24)) * 1000)}
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

        <Panel title="Beat" className="w-[22%] shrink-0" bodyClass="p-0">
          {shots ? (
            <BeatInspector
              beat={selected !== null ? (beats[selected] ?? null) : null}
              index={selected}
              cast={shots.cast}
              vocab={vocab}
              expressionsFor={expressionsFor}
              onChange={(i, next) => void editBeat(i, next)}
            />
          ) : (
            <Empty>Press Direct to build a shot list</Empty>
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
