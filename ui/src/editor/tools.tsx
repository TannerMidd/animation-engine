import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, followJob } from '../api.ts';
import type {
  BenchResult, ConversionCheckResult, DoctorReport, JobEvent, MigrationInfo, ProfileDiff,
  ProfileValidation, ShowInfo,
} from '../types.ts';
import { Dot, Mono, Spinner } from './chrome.tsx';

/**
 * The tool overlays: the System report, identity comparison, the voice bench
 * (Audition) and the cast-wide conversion check. Each is the editor surface of
 * a command that used to be CLI-only, rendering the same pipeline data the
 * command prints.
 */

function ToolShell({
  title, meta, width, onClose, children, headerRight,
}: {
  title: string;
  meta?: string;
  width: number;
  onClose: () => void;
  children: ReactNode;
  headerRight?: ReactNode;
}) {
  return (
    <div onClick={onClose} className="absolute inset-0 bg-[rgba(12,13,15,.55)] z-40 flex justify-center pt-14 pb-8">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width }}
        className="h-fit max-h-full bg-panel border border-edge-2 rounded-[5px] overflow-hidden shadow-[0_28px_70px_-18px_rgba(0,0,0,.85)] flex flex-col"
      >
        <div className="h-[34px] shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-[#282d34]">
          <span className="text-[11px] tracking-[.07em] uppercase text-ink">{title}</span>
          {meta && <Mono className="text-ink-faint">{meta}</Mono>}
          <div className="flex-1" />
          {headerRight}
          <button type="button" onClick={onClose} className="w-5 h-5 text-ink-faint text-[12px] cursor-pointer hover:text-ink">×</button>
        </div>
        {/* Diagnostics are meant to be copied into a bug report. */}
        <div className="flex-1 min-h-0 overflow-y-auto select-text">{children}</div>
      </div>
    </div>
  );
}

function SectionHead({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 h-[26px] bg-[#22262c] border-y border-[#2f353d] first:border-t-0">
      <span className="text-[10px] tracking-[.08em] uppercase text-ink-faint">{label}</span>
      <div className="flex-1" />
      {right}
    </div>
  );
}

function ReportRow({
  label, ok, value, detail, fix,
}: {
  label: string;
  ok: boolean | null;
  value: string;
  detail?: string | null;
  fix?: string | null;
}) {
  return (
    <div className="flex gap-2.5 items-start px-3 py-[7px] border-b border-[#262b32]">
      <span className="w-[96px] shrink-0 font-mono text-[10.5px] text-ink-dim pt-px">{label}</span>
      {ok !== null && <span className="pt-[3px]"><Dot color={ok ? '#6f9b5a' : '#c8595a'} /></span>}
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] leading-[1.4]" style={{ color: ok === false ? '#d6a5a6' : '#c9ccd1' }}>{value}</span>
        {detail && <span className="block text-[10px] text-ink-faint leading-[1.45] mt-[2px] break-words">{detail}</span>}
        {fix && <span className="block text-[10px] text-[#e0b489] leading-[1.45] mt-[2px]">fix: {fix}</span>}
      </span>
    </div>
  );
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * `anim doctor`, in the place people already look: the health strip opens it.
 * Identity validation and the migration offer live here too, because "is this
 * machine and this project sound" is one question.
 */
export function SystemReport({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [profiles, setProfiles] = useState<ProfileValidation[] | null>(null);
  const [migration, setMigration] = useState<MigrationInfo | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyArmed, setApplyArmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The doctor probes chromium and walks the model caches — a second or
      // two, priced only when the report is actually open.
      const [doctorReport, validation, plan] = await Promise.all([
        api.doctor(),
        api.validateShow(),
        api.migrationPlan(),
      ]);
      setReport(doctorReport);
      setProfiles(validation.results);
      setMigration(plan);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyMigration = async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await api.applyMigration();
      setApplied(result.applied);
      setApplyArmed(false);
      setMigration(await api.migrationPlan());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <ToolShell
      title="System report"
      meta="toolchain · models · identity"
      width={620}
      onClose={onClose}
      headerRight={
        <button
          type="button"
          onClick={() => void refresh()}
          className="h-[22px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[10.5px] cursor-pointer hover:text-ink inline-flex items-center gap-1.5"
        >
          {busy ? <Spinner /> : null}
          Re-check
        </button>
      }
    >
      {error && (
        <div className="mx-3 mt-2 px-2.5 py-2 border border-bad/45 bg-bad/10 rounded-[3px] text-[11px] text-[#d6c3c3]">{error}</div>
      )}
      {!report && busy && (
        <div className="py-10 text-center text-[11px] text-ink-ghost">Probing the toolchain…</div>
      )}
      {report && (
        <>
          <SectionHead label="Toolchain" />
          <ReportRow
            label="ffmpeg"
            ok={Boolean(report.ffmpeg.version)}
            value={report.ffmpeg.version ? `${report.ffmpeg.version}` : 'NOT FOUND'}
            detail={report.ffmpeg.version ? report.ffmpeg.path : null}
            fix={report.ffmpeg.old
              ? 'that build is old — every reference clip and master transcodes through it. Drop a recent static build under tools\\ffmpeg-*\\.'
              : null}
          />
          <ReportRow
            label="chromium"
            ok={report.chromium.ok}
            value={report.chromium.ok ? `ok (${report.chromium.version})` : 'FAILED'}
            detail={report.chromium.error}
            fix={report.chromium.ok ? null : 'run: npx playwright install chromium'}
          />
          <ReportRow
            label="rhubarb"
            ok={report.rhubarb.ok}
            value={report.rhubarb.ok ? `ok (${report.rhubarb.path})` : 'NOT FOUND'}
            detail={report.rhubarb.ok ? 'waveform-derived mouth cues' : 'needed by every engine except sapi'}
          />
          {report.engines.map((engine) => (
            <ReportRow
              key={engine.name}
              label={`voice:${engine.name}`}
              ok={engine.checking ? null : engine.ok}
              value={engine.checking ? 'probing…' : engine.ok ? 'ok' : 'unavailable'}
              detail={engine.ok ? null : engine.reason}
            />
          ))}
          <ReportRow
            label="asr"
            ok={report.asr.ok}
            value={report.asr.ok ? 'ok (whisper small.en)' : 'unavailable — generated lines ship unverified'}
            detail={report.asr.ok ? 'generated lines are verified against the script' : report.asr.reason}
          />
          <ReportRow
            label="llm"
            ok={report.llm.ok}
            value={report.llm.ok ? `ok (${report.llm.models.join(', ')})` : 'unavailable'}
            detail={report.llm.ok ? null : report.llm.reason}
          />
          {/*
            Blender shows as neutral rather than failed when absent. Baked props
            are committed geometry, so a machine without it renders the whole
            catalogue and only loses the ability to bake new props.
          */}
          <ReportRow
            label="blender"
            ok={report.blender.ok ? true : null}
            value={report.blender.ok ? `ok (${report.blender.version})` : 'not installed'}
            detail={report.blender.ok
              ? report.blender.path
              : 're-baking props unavailable — existing baked props still render'}
            fix={report.blender.ok ? null : report.blender.reason}
          />
          <ReportRow
            label="props"
            ok={report.bakedProps.errors.length ? false : true}
            value={`${report.bakedProps.count} baked`}
            detail={`${report.bakedProps.shapes} shapes, ${report.bakedProps.points} points`}
            fix={report.bakedProps.errors.length
              ? report.bakedProps.errors.map((e) => `${e.file}: ${e.error.split('\n')[0]}`).join(' · ')
              : report.bakedProps.stale.length
                ? `stale against source: ${report.bakedProps.stale.join(', ')} — run: anim props bake <name>`
                : null}
          />

          <SectionHead label="Model storage" />
          <ReportRow
            label="root"
            ok={report.models.onSystemDrive ? false : true}
            value={report.models.root}
            fix={report.models.onSystemDrive ? 'that is the system drive. Set ANIM_MODELS_ROOT elsewhere.' : null}
          />
          {report.models.caches.map((cache) => (
            <ReportRow key={cache.name} label={cache.name} ok={null} value={gb(cache.bytes)} detail={cache.dir} />
          ))}
          <ReportRow
            label="manifest"
            ok={report.models.manifest.ok}
            value={report.models.manifest.ok ? 'approved models present' : 'model verification failed'}
            detail={`${report.models.manifest.path} · ${report.models.manifest.checkedHashes ? 'checksums verified' : 'files present'}`}
            fix={report.models.manifest.ok ? null : report.models.manifest.models
              .filter((model) => !model.ok)
              .map((model) => `${model.id}: ${[...model.missing, ...model.mismatched].join(', ')}`)
              .join('; ')}
          />
          {report.models.strays.map((stray) => (
            <ReportRow
              key={stray.label}
              label="STRAY"
              ok={false}
              value={`${stray.label} has ${gb(stray.bytes)} on the system drive`}
              detail={stray.dir}
              fix={stray.fix}
            />
          ))}
          {!report.models.strays.length && (
            <div className="px-3 py-1.5 text-[10px] text-ink-faint border-b border-[#262b32]">(nothing stray on the system drive)</div>
          )}

          <SectionHead label="Identity profiles" />
          {(profiles ?? []).map((profile) => (
            <ReportRow
              key={profile.id}
              label={profile.id}
              ok={profile.ok}
              value={profile.ok ? `v${profile.version} · ${profile.hash}` : 'FAILED TO LOAD'}
              detail={profile.error}
            />
          ))}
          {profiles !== null && !profiles.length && (
            <div className="px-3 py-1.5 text-[10px] text-ink-faint border-b border-[#262b32]">
              No identity profiles yet — running on the built-in defaults. Migration below creates the project profile.
            </div>
          )}

          <SectionHead
            label="Migration"
            right={migration && migration.changes.length ? (
              <button
                type="button"
                disabled={applying}
                onClick={() => (applyArmed ? void applyMigration() : setApplyArmed(true))}
                className={`h-[22px] px-2 rounded-[3px] border text-[10.5px] cursor-pointer inline-flex items-center gap-1.5 ${
                  applyArmed
                    ? 'border-accent bg-accent/20 text-accent'
                    : 'border-edge bg-panel-2 text-ink-dim hover:text-ink'
                }`}
              >
                {applying ? <Spinner /> : null}
                {applyArmed ? 'Confirm — write the changes' : `Apply ${migration.changes.length} change${migration.changes.length === 1 ? '' : 's'}…`}
              </button>
            ) : null}
          />
          {applied !== null && (
            <div className="px-3 py-1.5 text-[10px] text-good border-b border-[#262b32]">
              Applied {applied} change{applied === 1 ? '' : 's'}. Review with git diff; roll back with git checkout.
            </div>
          )}
          {migration && !migration.changes.length && (
            <div className="px-3 py-1.5 text-[10px] text-ink-faint border-b border-[#262b32]">
              Nothing to migrate — everything is already under the active identity.
            </div>
          )}
          {migration?.changes.map((change) => (
            <div key={`${change.kind}:${change.target}`} className="px-3 py-[7px] border-b border-[#262b32]">
              <div className="flex items-center gap-2">
                <span className="text-[9px] tracking-[.06em] uppercase border border-edge rounded-[2px] px-1 text-ink-faint">{change.kind}</span>
                <Mono className="text-[#c9ccd1]">{change.target}</Mono>
              </div>
              {change.actions.map((action) => (
                <div key={action} className="text-[10px] text-ink-faint leading-[1.45] pl-1 mt-[2px]">- {action}</div>
              ))}
            </div>
          ))}

          <SectionHead label="Cast" />
          <div className="px-3 py-2 text-[10.5px] font-mono text-ink-dim break-words">
            {report.cast.length ? report.cast.join(', ') : '(none yet)'}
          </div>
        </>
      )}
    </ToolShell>
  );
}

/** Side-by-side identity diff — the caller `show compare` never had. */
export function CompareOverlay({ show, onClose }: { show: ShowInfo; onClose: () => void }) {
  const ids = show.profiles.map((p) => p.id);
  const [a, setA] = useState(show.active.id);
  const [b, setB] = useState(ids.find((id) => id !== show.active.id) ?? show.active.id);
  const [diffs, setDiffs] = useState<ProfileDiff[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (idA: string, idB: string) => {
    setBusy(true);
    setError(null);
    try {
      setDiffs((await api.compareShow(idA, idB)).diffs);
    } catch (err) {
      setError((err as Error).message);
      setDiffs(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(a, b);
  }, [a, b, run]);

  const selectCls = 'h-[22px] border border-edge bg-panel-2 rounded-[3px] px-1 text-[10.5px] text-[#c9ccd1] outline-none cursor-pointer';
  const cell = (value: unknown) => {
    const s = JSON.stringify(value);
    return s === undefined ? '—' : s.length > 60 ? `${s.slice(0, 59)}…` : s;
  };

  return (
    <ToolShell title="Compare identities" width={640} onClose={onClose} headerRight={busy ? <Spinner /> : undefined}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2f353d]">
        <select value={a} onChange={(e) => setA(e.target.value)} className={selectCls}>
          {ids.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <span className="text-[10px] text-ink-faint">vs</span>
        <select value={b} onChange={(e) => setB(e.target.value)} className={selectCls}>
          {ids.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <div className="flex-1" />
        <Mono className="text-ink-faint">
          {diffs ? `${diffs.length} differing field${diffs.length === 1 ? '' : 's'}` : ''}
        </Mono>
      </div>
      {error && <div className="mx-3 mt-2 px-2.5 py-2 border border-bad/45 bg-bad/10 rounded-[3px] text-[11px] text-[#d6c3c3]">{error}</div>}
      {diffs && !diffs.length && (
        <div className="py-8 text-center text-[11px] text-ink-ghost">Identical.</div>
      )}
      {diffs?.map((diff) => (
        <div key={diff.path} className="px-3 py-[7px] border-b border-[#262b32]">
          <Mono className="text-[#c9ccd1]">{diff.path}</Mono>
          <div className="flex gap-2 mt-1 text-[10px] font-mono">
            <span className="flex-1 min-w-0 text-[#e0b489] break-words">{a}: {cell(diff.a)}</span>
            <span className="flex-1 min-w-0 text-[#a8b6d4] break-words">{b}: {cell(diff.b)}</span>
          </div>
        </div>
      ))}
    </ToolShell>
  );
}

/** Progress line for the overlays that run their own job. */
function JobProgress({ event }: { event: JobEvent | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-faint">
      <Spinner />
      {event?.stage ?? 'starting…'}{event?.total ? ` ${event.done}/${event.total}` : ''}
    </span>
  );
}

/**
 * The Audition overlay: `voices bench` rendered in the app instead of a file
 * you were told to go open. The whole cast side by side, per-line verdicts,
 * playable in place.
 */
export function AuditionOverlay({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<BenchResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [event, setEvent] = useState<JobEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void api.bench()
      .then((r) => setResult(r.result))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoaded(true));
    return () => stopRef.current?.();
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    setEvent(null);
    try {
      const started = await api.runBench();
      stopRef.current = followJob(started.id, (e) => {
        setEvent(e);
        if (e.type !== 'done' && e.type !== 'error') return;
        stopRef.current?.();
        setRunning(false);
        if (e.type === 'error') {
          setError(e.message ?? 'bench failed');
          return;
        }
        void api.bench().then((r) => setResult(r.result)).catch(() => {});
      });
    } catch (err) {
      setRunning(false);
      setError((err as Error).message);
    }
  };

  return (
    <ToolShell
      title="Audition"
      meta={result ? `${result.characters.length} characters · ${result.engine} · ${new Date(result.renderedAt).toLocaleString()}` : 'voice bench'}
      width={720}
      onClose={onClose}
      headerRight={running ? <JobProgress event={event} /> : (
        <button
          type="button"
          onClick={() => void run()}
          className="h-[22px] px-2 rounded-[3px] border border-accent bg-accent/20 text-accent text-[10.5px] cursor-pointer hover:bg-accent/30"
        >
          {result ? 'Re-render bench' : 'Render bench'}
        </button>
      )}
    >
      <div className="px-3 py-2 text-[10.5px] text-ink-dim leading-[1.5] border-b border-[#2f353d]">
        Every referenced character through the real synthesis path, across the expression spread. Listen for distinct
        registers across the cast, no buzz or shifted formants against the reference, DEADPAN reading flat, ANGRY
        reading hot without racing. Fixed seeds — a re-run after nothing changed is all cache hits.
      </div>
      {error && <div className="mx-3 mt-2 px-2.5 py-2 border border-bad/45 bg-bad/10 rounded-[3px] text-[11px] text-[#d6c3c3]">{error}</div>}
      {loaded && !result && !running && !error && (
        <div className="py-10 text-center text-[11px] text-ink-ghost">
          No bench rendered yet. Press “Render bench” — the first run synthesizes every line, later runs reuse the cache.
        </div>
      )}
      {result?.characters.map((character) => (
        <div key={character.name} className="border-b border-[#262b32]">
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
            <span className="font-serif text-[13px] text-ink">{character.name}</span>
            <span className="text-[9px] tracking-[.05em] uppercase border border-edge rounded-[2px] px-1 text-ink-faint">{character.badge}</span>
          </div>
          <div className="px-3 pb-2 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-[84px] shrink-0 text-[9.5px] tracking-[.05em] lowercase text-ink-faint">reference</span>
              <audio controls preload="none" src={api.benchAudioUrl(character.name, character.refFile)} className="h-7 flex-1 min-w-0" />
              <span className="w-[200px] shrink-0 text-[10px] text-ink-ghost italic truncate">what the engine clones</span>
            </div>
            {character.lines.map((line) => (
              <div key={line.expression} className="flex items-center gap-2">
                <span className="w-[84px] shrink-0 text-[9.5px] tracking-[.05em] lowercase text-ink-faint">{line.expression}</span>
                <audio controls preload="none" src={api.benchAudioUrl(character.name, line.file)} className="h-7 flex-1 min-w-0" />
                <span
                  className="w-[200px] shrink-0 text-[10px] italic truncate"
                  title={line.qa ? (line.qa.passed ? `verified · word error rate ${line.qa.wer.toFixed(2)}` : `FAILED VERIFICATION — heard: ${line.qa.transcript || 'nothing'}`) : line.text}
                  style={{ color: line.qa ? (line.qa.passed ? '#6f9b5a' : '#c8595a') : '#5d656e' }}
                >
                  {line.qa
                    ? line.qa.passed ? `verified · wer ${line.qa.wer.toFixed(2)}` : `failed — heard “${line.qa.transcript || 'nothing'}”`
                    : `“${line.text}”`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </ToolShell>
  );
}

/**
 * `voices check`, asked from where the question actually comes up: a recorded
 * performance in Perform, scored against every cast voice.
 */
export function ConversionCheckOverlay({
  scene, takeId, takeLabel, onClose,
}: {
  scene: string;
  takeId: string;
  takeLabel: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ConversionCheckResult | null>(null);
  const [event, setEvent] = useState<JobEvent | null>(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const started = await api.voicesCheck({ scene, takeId });
        if (cancelled) return;
        stopRef.current = followJob(started.id, (e) => {
          setEvent(e);
          if (e.type !== 'done' && e.type !== 'error') return;
          stopRef.current?.();
          setRunning(false);
          if (e.type === 'error') setError(e.message ?? 'conversion check failed');
          else setResult(e.result as ConversionCheckResult);
        });
      } catch (err) {
        if (!cancelled) {
          setRunning(false);
          setError((err as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
      stopRef.current?.();
    };
  }, [scene, takeId]);

  const cell = (value: number | null, digits = 0) => (value === null ? '—' : value.toFixed(digits));

  return (
    <ToolShell
      title="Conversion check"
      meta={takeLabel}
      width={680}
      onClose={onClose}
      headerRight={running ? <JobProgress event={event} /> : undefined}
    >
      <div className="px-3 py-2 text-[10.5px] text-ink-dim leading-[1.5] border-b border-[#2f353d]">
        This performance, converted into every cast voice and scored. Voicing is the share of your voiced speech that
        survived (want ≥ 0.65); register is the distance from the character’s own pitch in semitones (want within 4).
      </div>
      {error && <div className="mx-3 mt-2 px-2.5 py-2 border border-bad/45 bg-bad/10 rounded-[3px] text-[11px] text-[#d6c3c3]">{error}</div>}
      {running && !error && (
        <div className="py-8 text-center text-[11px] text-ink-ghost">Converting into each cast voice — the first run loads the model into VRAM…</div>
      )}
      {result && (
        <>
          <div className="grid grid-cols-[110px_60px_50px_60px_62px_62px_1fr] gap-1 px-3 py-1.5 border-b border-[#2f353d] text-[9px] tracking-[.06em] uppercase text-ink-faint">
            <span>character</span><span>ref Hz</span><span>lift</span><span>out Hz</span><span>voicing</span><span>register</span><span>listen</span>
          </div>
          {result.rows.map((row) => (
            <div key={row.name} className="border-b border-[#262b32]">
              <div className="grid grid-cols-[110px_60px_50px_60px_62px_62px_1fr] gap-1 px-3 py-1.5 items-center">
                <span className="flex items-center gap-1.5 min-w-0">
                  <Dot color={row.ok ? '#6f9b5a' : '#c8595a'} />
                  <span className="font-mono text-[10.5px] text-[#c9ccd1] truncate">{row.name}</span>
                </span>
                <Mono className="text-ink-dim">{cell(row.targetMedianPitchHz)}</Mono>
                <Mono className="text-ink-dim">{cell(row.conditioningLiftSemitones, 1)}</Mono>
                <Mono className="text-ink-dim">{cell(row.outputMedianPitchHz)}</Mono>
                <span className="font-mono text-[10px]" style={{ color: (row.voicedRetention ?? 1) >= 0.65 ? '#6f9b5a' : '#c8595a' }}>
                  {cell(row.voicedRetention, 2)}
                </span>
                <span className="font-mono text-[10px]" style={{ color: Math.abs(row.pitchErrorSemitones ?? 0) <= 4 ? '#6f9b5a' : '#c8595a' }}>
                  {cell(row.pitchErrorSemitones, 1)}
                </span>
                {row.file
                  ? <audio controls preload="none" src={api.voicesCheckAudioUrl(row.file)} className="h-6 w-full min-w-0" />
                  : <span className="text-[10px] text-ink-ghost">{row.missing ? 'no result' : '—'}</span>}
              </div>
              {row.failures.filter((f) => f !== 'conversion returned no result').map((failure) => (
                <div key={failure} className="px-3 pb-1.5 text-[10px] text-[#d6a5a6] leading-[1.45]">{failure}</div>
              ))}
            </div>
          ))}
          <div className="px-3 py-2 text-[10px] text-ink-faint">
            {result.rows.length - result.failures}/{result.rows.length} character voices convert cleanly from this performance.
          </div>
        </>
      )}
    </ToolShell>
  );
}
