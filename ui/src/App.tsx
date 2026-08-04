import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { CastSummary, Health, SceneSummary, SetSummary, ShowInfo, Vocab } from './types.ts';
import { EditorApp } from './editor/EditorApp.tsx';
import { SetDesigner } from './components/SetDesigner.tsx';
import { CastEditor } from './components/CastEditor.tsx';
import { Spinner } from './editor/chrome.tsx';
import { isTyping } from './editor/lib.ts';

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

/**
 * Boot shell. The production editor is the app; the set designer and cast
 * editor open over it from the project tree, since blocking, voices and
 * wardrobe are edited per asset rather than per scene.
 */
export default function App() {
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [scene, setScene] = useState<string | null>(null);
  const [cast, setCast] = useState<CastSummary[]>([]);
  const [sets, setSets] = useState<SetSummary[]>([]);
  const [vocab, setVocab] = useState<Vocab | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [show, setShow] = useState<ShowInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [legacy, setLegacy] = useState<null | { kind: 'sets' | 'cast'; name: string | null }>(null);

  const refreshScenes = useCallback(async () => {
    const list = await api.scenes();
    setScenes(list);
    setScene((current) => current ?? list[0]?.name ?? null);
  }, []);

  const refreshCast = useCallback(async () => setCast(await api.cast()), []);
  const refreshSets = useCallback(async () => setSets(await api.sets()), []);

  useEffect(() => {
    void (async () => {
      try {
        const [v, s] = await Promise.all([api.vocab(), api.show(), refreshScenes(), refreshCast(), refreshSets()]);
        setVocab(v);
        setShow(s);
      } finally {
        setBooting(false);
      }
      // Health probes Python and can take a while; never block the app on it.
      void api.health().then(setHealth).catch(() => {});
    })();
  }, [refreshScenes, refreshCast, refreshSets]);

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
  };

  /** Expressions a given actor's rig actually has, for the beat inspector. */
  const expressionsFor = useCallback(
    (actorId: string) => cast.find((c) => c.name === actorId)?.expressions ?? ['NEUTRAL', 'DEADPAN'],
    [cast],
  );

  if (booting) {
    return (
      <div className="h-full grid place-items-center text-ink-faint">
        <Spinner size={14} />
      </div>
    );
  }

  if (!scene) {
    return (
      <div className="h-full grid place-items-center">
        <div className="w-[420px] border border-[#2f353d] bg-stage rounded-[3px] px-4 py-3.5">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[8.5px] tracking-[.07em] uppercase text-gen border border-gen rounded-[2px] px-1">empty</span>
            <span className="font-mono text-[9px] text-ink-ghost">no scenes</span>
          </div>
          <div className="text-[12px] text-[#c9ccd1] leading-snug mb-1">Nothing here yet.</div>
          <div className="text-[11px] text-ink-faint leading-[1.5] mb-3">
            Start from a premise with the local model, or write Fountain straight into the editor.
          </div>
          <button
            type="button"
            onClick={() => void newScene()}
            className="h-6 px-3 rounded-[3px] border border-good bg-good/15 text-[#8fbd76] text-[11px] cursor-pointer hover:bg-good/25"
          >
            Create a scene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full relative"
      /*
       * Kill the browser's menu for the whole app, here rather than on the
       * editor: the cast editor and set designer open as a *sibling* overlay
       * below, so a handler inside EditorApp would never see them. Capture
       * phase means no surface can forget to suppress it. Text fields and the
       * script editor keep the native menu — Paste cannot be rebuilt, because
       * the page is not allowed to read the clipboard on demand.
       */
      onContextMenuCapture={(e) => { if (!isTyping(e.target)) e.preventDefault(); }}
    >
      <EditorApp
        key={scene}
        scene={scene}
        scenes={scenes}
        cast={cast}
        sets={sets}
        vocab={vocab}
        health={health}
        show={show}
        llm={health?.llm ?? null}
        expressionsFor={expressionsFor}
        onScene={setScene}
        onSceneChanged={() => {
          void refreshScenes();
          void refreshCast();
        }}
        onNewScene={() => void newScene()}
        onOpenCast={(name) => setLegacy({ kind: 'cast', name })}
        onOpenSets={(name) => setLegacy({ kind: 'sets', name })}
      />

      {legacy && (
        <div className="absolute inset-0 z-50 bg-well flex flex-col">
          <div className="h-9 shrink-0 flex items-center gap-2.5 px-2.5 bg-panel border-b border-edge">
            <button
              type="button"
              onClick={() => {
                setLegacy(null);
                void refreshCast();
                void refreshSets();
              }}
              className="h-[23px] px-2 rounded-[3px] border border-edge bg-panel-2 text-ink-dim text-[11px] cursor-pointer hover:text-ink"
            >
              ← Back to the editor
            </button>
            <span className="text-[11px] tracking-[.06em] uppercase text-ink-faint">
              {legacy.kind === 'cast' ? 'Cast editor' : 'Set designer'}
            </span>
            {legacy.name && <span className="font-serif text-[14px] text-ink">{legacy.name}</span>}
            <div className="flex-1" />
            <span className="text-[10px] text-ink-ghost">edits here land on disk and show up in the scene on the next preview</span>
          </div>
          <div className="flex-1 min-h-0">
            {legacy.kind === 'sets' && <SetDesigner vocab={vocab} llm={health?.llm ?? null} open={legacy.name} />}
            {legacy.kind === 'cast' && <CastEditor health={health} vocab={vocab} open={legacy.name} />}
          </div>
        </div>
      )}
    </div>
  );
}
