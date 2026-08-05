import { useCallback, useState } from 'react';
import { api } from '../api.ts';
import type { LlmStatus } from '../types.ts';

/**
 * "The local model is not running" plus the button that fixes it.
 *
 * Every surface that offers generation needs the same three things — whether it
 * is running, whether it could simply be switched on, and a way to do that — so
 * they share this rather than each threading daemon state down from the app.
 *
 * It re-reads the status itself after starting rather than waiting for the next
 * health poll, because the person is standing in front of a dialog they want to
 * use now.
 */
export function useLlmStart(llm: LlmStatus | null) {
  const [started, setStarted] = useState<LlmStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const status = started ?? llm;

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api.startLlm();
      setStarted(await api.llm());
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }, []);

  return {
    status,
    /** Installed but switched off — worth offering a button for. */
    startable: Boolean(status?.daemon?.startable),
    starting,
    startError,
    start,
  };
}
