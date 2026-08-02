import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { CastSummary, Health, SceneSummary, Vocab } from './types.ts';
import { SceneView } from './components/SceneView.tsx';
import { SetDesigner } from './components/SetDesigner.tsx';
import { CastEditor } from './components/CastEditor.tsx';
import { Badge, Empty, Spinner } from './components/ui.tsx';

type View = 'scenes' | 'sets' | 'cast';

const STARTER = `# NEW SCENE

INT. SOMEWHERE - DAY

Someone approaches, holding something they will not explain.

ALICE
(deadpan)
Morning.

BOB
(flat)
Morning.

[BEAT 1200]

ALICE
So that'd be great.
`;

export default function App() {
  const [view, setView] = useState<View>('scenes');
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [scene, setScene] = useState<string | null>(null);
  const [cast, setCast] = useState<CastSummary[]>([]);
  const [vocab, setVocab] = useState<Vocab | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [booting, setBooting] = useState(true);

  const refreshScenes = useCallback(async () => {
    const list = await api.scenes();
    setScenes(list);
    setScene((current) => current ?? list[0]?.name ?? null);
  }, []);

  const refreshCast = useCallback(async () => setCast(await api.cast()), []);

  useEffect(() => {
    void (async () => {
      try {
        const [v] = await Promise.all([api.vocab(), refreshScenes(), refreshCast()]);
        setVocab(v);
      } finally {
        setBooting(false);
      }
      // Health probes Python and can take a while; never block the app on it.
      void api.health().then(setHealth).catch(() => {});
    })();
  }, [refreshScenes, refreshCast]);

  // The engine probe finishes in the background — poll briefly until it lands.
  useEffect(() => {
    if (!health) return;
    const pending = Object.values(health.engines).some((e) => e.checking);
    if (!pending) return;
    const t = setTimeout(() => void api.health().then(setHealth).catch(() => {}), 2500);
    return () => clearTimeout(t);
  }, [health]);

  const newScene = async () => {
    const name = window.prompt('Scene name', 'new-scene');
    if (!name) return;
    const clean = name.trim().toLowerCase().replace(/[^\w-]/g, '-');
    await api.saveScript(clean, STARTER);
    await refreshScenes();
    setScene(clean);
    setView('scenes');
  };

  /** Expressions a given actor's rig actually has, for the beat inspector. */
  const expressionsFor = useCallback(
    (actorId: string) => cast.find((c) => c.name === actorId)?.expressions ?? ['NEUTRAL', 'DEADPAN'],
    [cast],
  );

  if (booting) {
    return (
      <div className="h-full grid place-items-center text-ink-faint gap-2">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* rail */}
      <div className="w-48 shrink-0 flex flex-col border-r border-edge bg-panel">
        <div className="px-3 py-2.5 border-b border-edge">
          <div className="text-[12px] font-medium tracking-wide">animation engine</div>
        </div>

        <nav className="flex gap-0.5 p-1 border-b border-edge">
          {(['scenes', 'sets', 'cast'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`flex-1 px-2 py-1 rounded text-[11px] uppercase tracking-wide transition-colors ${
                view === v ? 'bg-accent text-stage' : 'text-ink-faint hover:text-ink hover:bg-panel-2'
              }`}
            >
              {v}
            </button>
          ))}
        </nav>

        {view === 'scenes' && (
          <div className="flex-1 min-h-0 overflow-auto p-1">
            {scenes.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => setScene(s.name)}
                className={`w-full text-left px-2 py-1.5 rounded text-[12px] ${
                  scene === s.name ? 'bg-accent/20 text-ink' : 'text-ink-dim hover:bg-panel-2'
                }`}
              >
                <div className="truncate">{s.name}</div>
                <div className="text-[10px] text-ink-faint flex gap-1.5">
                  <span>{s.directed ? `${s.beats} beats` : 'undirected'}</span>
                  {s.hasVideo && <span className="text-good">rendered</span>}
                </div>
              </button>
            ))}
            <button
              type="button"
              onClick={() => void newScene()}
              className="w-full text-left px-2 py-1.5 mt-1 rounded text-[12px] text-ink-faint hover:text-accent hover:bg-panel-2"
            >
              + new scene
            </button>
          </div>
        )}

        {view !== 'scenes' && <div className="flex-1" />}

        {/* health */}
        <div className="shrink-0 border-t border-edge p-2 space-y-1">
          {health ? (
            <>
              <HealthRow label="ffmpeg" ok={!!health.ffmpeg} detail={health.ffmpeg ?? 'missing'} />
              <HealthRow label="rhubarb" ok={!!health.rhubarb} detail={health.rhubarb ? 'ok' : 'missing'} />
              <HealthRow
                label="local llm"
                ok={health.llm.ok}
                detail={health.llm.ok ? (health.llm.recommended ?? 'ok') : (health.llm.reason ?? 'unavailable')}
              />
              {Object.entries(health.engines).map(([name, s]) => (
                <HealthRow
                  key={name}
                  label={name}
                  ok={s.ok}
                  checking={s.checking}
                  detail={s.checking ? 'checking…' : s.ok ? 'ok' : (s.reason?.split('\n')[0] ?? 'unavailable')}
                />
              ))}
            </>
          ) : (
            <div className="text-[10px] text-ink-faint">checking toolchain…</div>
          )}
        </div>
      </div>

      {/* workspace */}
      <div className="flex-1 min-w-0">
        {view === 'scenes' &&
          (scene ? (
            <SceneView
              key={scene}
              scene={scene}
              vocab={vocab}
              llm={health?.llm ?? null}
              expressionsFor={expressionsFor}
              onSceneChanged={() => {
                void refreshScenes();
                void refreshCast();
              }}
            />
          ) : (
            <Empty>No scenes yet — create one from the rail.</Empty>
          ))}
        {view === 'sets' && <SetDesigner vocab={vocab} llm={health?.llm ?? null} />}
        {view === 'cast' && <CastEditor health={health} vocab={vocab} />}
      </div>
    </div>
  );
}

function HealthRow({ label, ok, detail, checking }: { label: string; ok: boolean; detail: string; checking?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]" title={detail}>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          checking ? 'bg-ink-faint animate-pulse' : ok ? 'bg-good' : 'bg-bad'
        }`}
      />
      <span className="text-ink-faint">{label}</span>
      <span className="text-ink-faint/70 truncate flex-1 text-right">{detail}</span>
    </div>
  );
}

export { Badge };
