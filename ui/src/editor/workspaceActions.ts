import { useEffect, type RefObject } from 'react';
import type { LlmStatus, SceneDetail, ShotList } from '../types.ts';
import type { ContextTool } from './AppBar.tsx';
import type { InspectorTab, Mode } from './lib.ts';
import { isTyping } from './lib.ts';
import type { OverlayPrefs, StageHandle } from './stage/StageColumn.tsx';

export function buildModeTools(input: {
  mode: Mode;
  llm: LlmStatus | null;
  busy: string | null;
  shots: ShotList | null;
  prefs: OverlayPrefs;
  tab: InspectorTab;
  layout: '16:9' | '9:16';
  detail: SceneDetail | null;
  scene: string;
  engine: string;
  setWriting: (value: boolean) => void;
  runCheck: () => Promise<void>;
  runDirect: () => Promise<void>;
  runJob: (kind: 'voices' | 'render' | 'sound') => Promise<void>;
  openPreflight: () => void;
  setPrefs: (patch: Partial<OverlayPrefs>) => void;
  openBooth: () => void;
  openAudition: () => void;
  setLayout: (layout: '16:9' | '9:16') => void;
}): ContextTool[] {
  const {
    mode,
    llm,
    busy,
    shots,
    prefs,
    tab,
    layout,
    detail,
    scene,
    engine,
    setWriting,
    runCheck,
    runDirect,
    runJob,
    openPreflight,
    setPrefs,
    openBooth,
    openAudition,
    setLayout,
  } = input;
  switch (mode) {
    case 'write':
      return [
        {
          label: 'Write from premise…',
          hint:
            llm?.ok === false
              ? `Local model unavailable: ${llm.reason ?? 'not running'}`
              : 'Generate a draft with the local model. It lands unsaved.',
          disabled: llm ? !llm.ok : false,
          go: () => setWriting(true),
        },
        {
          label: 'Check',
          hint: 'Parse, direct and validate. Sub-second, renders nothing.',
          busy: busy === 'check',
          go: () => void runCheck(),
        },
        {
          label: 'Direct the script →',
          hint: 'Turn this draft into the shot list. The timeline, voices, animation, preview and render all read the shot list — this is what pushes your script into them. You confirm the diff first.',
          primary: true,
          busy: busy === 'direct',
          go: () => void runDirect(),
        },
      ];
    case 'direct':
      return [
        {
          label: 'Re-direct…',
          hint: 'Propose new direction from the current script and apply it to the timeline, voices, animation and preview. You confirm the diff before anything is written; locked beats survive.',
          busy: busy === 'direct',
          go: () => void runDirect(),
        },
        {
          label: 'Voices',
          hint: 'Synthesize dialogue and derive Rhubarb mouth cues.',
          busy: busy === 'voices',
          disabled: !shots,
          go: () => void runJob('voices'),
        },
        {
          label: 'Preflight',
          hint: 'Check voices, staging, animation, continuity, soundtrack freshness.',
          go: openPreflight,
        },
      ];
    case 'animate':
      return [
        {
          label: 'Onion',
          hint: 'Ghost the active controller either side of the playhead — count set in the Motion panel.',
          on: prefs.onion,
          go: () => setPrefs({ onion: !prefs.onion }),
        },
        {
          label: 'Motion path',
          hint: 'Show the authored A→B path with waypoints.',
          on: prefs.path,
          go: () => setPrefs({ path: !prefs.path }),
        },
        {
          label: 'Snap',
          hint: 'Snap body and prop drags to marks, seats and the walkable edges.',
          on: prefs.snap,
          go: () => setPrefs({ snap: !prefs.snap }),
        },
      ];
    case 'perform':
      return [
        {
          label: 'Line Booth',
          hint: 'Perform one line with context playback and count-in — in the Voice tab.',
          on: tab === 'voice',
          go: openBooth,
        },
        {
          label: 'Scene Run',
          hint: 'Perform every unlocked line for one character against the full guide track — in the Voice tab.',
          go: openBooth,
        },
        {
          label: 'Audition…',
          hint: 'The whole cast through the real synthesis path, side by side, with per-line verification verdicts.',
          go: openAudition,
        },
        {
          label: 'Voices',
          hint: `Synthesize all lines with the ${engine} engine.`,
          busy: busy === 'voices',
          disabled: !shots,
          go: () => void runJob('voices'),
        },
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
        {
          label: 'Voices',
          hint: `Synthesize any missing lines with ${engine} and remix.`,
          busy: busy === 'voices',
          disabled: !shots,
          go: () => void runJob('voices'),
        },
      ];
    case 'publish':
      return [
        { label: '16:9', hint: 'Horizontal master.', on: layout === '16:9', go: () => setLayout('16:9') },
        {
          label: '9:16',
          hint: 'Actor-aware portrait recompose.',
          on: layout === '9:16',
          go: () => setLayout('9:16'),
        },
        {
          label: 'Captions',
          hint: detail?.hasExport
            ? 'WebVTT / SRT sidecars. Not burned in.'
            : 'Sidecars are written at export time.',
          disabled: !detail?.hasExport,
          go: () => window.open(`/api/scenes/${scene}/captions.vtt`, '_blank'),
        },
        {
          label: 'Export manifest',
          hint: detail?.hasExport ? 'Hashes, provenance and identity stamp.' : 'Written by the render.',
          disabled: !detail?.hasExport,
          go: () => window.open(`/api/scenes/${scene}/export`, '_blank'),
        },
      ];
  }
}

export function useEditorKeyboard(input: {
  menuOpen: boolean;
  toggleCommand: () => void;
  closeOverlays: () => void;
  selectedMotionId: string | null;
  askDeleteMotion: (id: string) => void;
  stageRef: RefObject<StageHandle | null>;
  selected: number | null;
  beatCount: number;
  selectBeat: (index: number) => void;
}): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        input.toggleCommand();
        return;
      }
      if (event.key === 'Escape') {
        if (input.menuOpen) return;
        input.closeOverlays();
        return;
      }
      if (isTyping(event.target)) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && input.selectedMotionId) {
        event.preventDefault();
        input.askDeleteMotion(input.selectedMotionId);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        input.stageRef.current?.togglePlay();
      }
      if (event.shiftKey && event.key === 'ArrowLeft') {
        input.selectBeat(Math.max(0, (input.selected ?? 1) - 1));
      }
      if (event.shiftKey && event.key === 'ArrowRight') {
        input.selectBeat(Math.min(input.beatCount - 1, (input.selected ?? -1) + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input]);
}
