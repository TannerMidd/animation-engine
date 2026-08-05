import { useState } from 'react';
import { Button, Spinner } from './ui.tsx';

/**
 * A premise in, generated content out.
 *
 * Used for both script writing and set design. Deliberately a modal rather than
 * an inline field: generation takes tens of seconds on a local model, and it
 * replaces what you were looking at, so it should feel like a decision.
 */
export function GenerateDialog({
  title, label, placeholder, hint, examples, busy, error, disabled, disabledReason, onGenerate, onClose,
  startable, starting, startError, onStart,
}: {
  title: string;
  label: string;
  placeholder: string;
  hint?: string;
  examples?: string[];
  busy: boolean;
  error: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  /** The daemon is installed and merely switched off, so it can be offered. */
  startable?: boolean;
  starting?: boolean;
  startError?: string | null;
  onStart?: () => void;
  onGenerate: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-full bg-panel border border-edge rounded-lg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-edge flex items-center justify-between">
          <span className="text-[12px] uppercase tracking-wider text-ink-faint">{title}</span>
          <Button variant="ghost" onClick={onClose}>✕</Button>
        </div>

        <div className="p-4">
          {disabled ? (
            <div className="text-[12px] text-ink-dim leading-relaxed">
              <p className="mb-2 text-bad">The local model is not running.</p>
              {/*
                * The remedy belongs where you hit the wall, not in a paragraph
                * telling somebody to go and find a terminal. It is also the only
                * safe way to start it: the daemon takes its model directory from
                * the environment it was launched with, and this one sets it.
                */}
              {startable ? (
                <>
                  <p className="mb-3">
                    It is installed and can be switched on. Weights stay in the project’s model
                    directory rather than on the system drive.
                  </p>
                  <Button variant="primary" disabled={starting} onClick={onStart}>
                    {starting ? 'Starting…' : 'Start the local model'}
                  </Button>
                  {starting && <span className="ml-2 inline-block align-middle"><Spinner /></span>}
                  {startError && <p className="mt-2 text-[11px] text-bad whitespace-pre-wrap">{startError}</p>}
                </>
              ) : (
                <p className="whitespace-pre-wrap">{disabledReason}</p>
              )}
            </div>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">{label}</div>
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={placeholder}
                rows={4}
                className="w-full bg-panel-2 border border-edge rounded px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent resize-y"
              />
              {hint && <div className="text-[11px] text-ink-faint mt-1.5">{hint}</div>}

              {examples && examples.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] text-ink-faint mb-1">Try:</div>
                  <div className="flex flex-wrap gap-1">
                    {examples.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => setText(ex)}
                        className="px-2 py-1 rounded bg-panel-2 hover:bg-edge text-[11px] text-ink-dim hover:text-ink text-left"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {error && <div className="mt-3 text-[11px] text-bad whitespace-pre-wrap">{error}</div>}
            </>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-edge flex items-center gap-2 justify-end">
          {busy && <span className="text-[11px] text-ink-faint mr-auto">this can take a minute on a local model…</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={disabled || busy || !text.trim()}
            onClick={() => onGenerate(text.trim())}
          >
            {busy ? <Spinner /> : 'Generate'}
          </Button>
        </div>
      </div>
    </div>
  );
}
