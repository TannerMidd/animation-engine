import path from 'node:path';
import { ROOT } from './paths.ts';

/**
 * Where downloaded model weights live.
 *
 * Every ML library defaults to a cache under the user profile — which on
 * Windows means the system drive. Model weights are measured in gigabytes
 * (Chatterbox alone is ~3GB, a 14B LLM is 9GB+), and a system drive is exactly
 * the wrong place for them.
 *
 * The root is derived from the drive the project is on, so it follows the
 * checkout rather than needing to be configured. Override with ANIM_MODELS_ROOT.
 */
export const MODELS_ROOT = process.env['ANIM_MODELS_ROOT'] ?? path.join(path.parse(ROOT).root, 'ai-models');

export const HF_CACHE = path.join(MODELS_ROOT, 'huggingface');
export const TORCH_CACHE = path.join(MODELS_ROOT, 'torch');
export const OLLAMA_MODELS = path.join(MODELS_ROOT, 'ollama');
/** OpenAI Whisper checkpoints (ASR line verification), e.g. small.en.pt. */
export const WHISPER_CACHE = path.join(MODELS_ROOT, 'whisper');

/**
 * Environment for any Python worker we spawn.
 *
 * Set explicitly on the child rather than relying on the user having exported
 * them: an ambient variable that isn't there means a silent 3GB download to the
 * system drive, and the failure only shows up when that drive fills.
 *
 * Workers are deliberately offline. Installing or prefetching a model is a
 * separate, explicit command; synthesis and conversion must either find the
 * requested files in the governed cache or fail. This also prevents a render
 * from changing model bytes because a remote repository moved.
 */
export function modelEnv(): Record<string, string> {
  return {
    HF_HOME: HF_CACHE,
    HUGGINGFACE_HUB_CACHE: path.join(HF_CACHE, 'hub'),
    TRANSFORMERS_CACHE: path.join(HF_CACHE, 'hub'),
    TORCH_HOME: TORCH_CACHE,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
  };
}

/** The drive Windows is installed on. */
export function systemDriveRoot(): string {
  return path.parse(process.env['SystemRoot'] ?? 'C:\\').root;
}

/**
 * Places a stray multi-gigabyte cache is known to appear.
 *
 * Ollama is the dangerous one: it is a *separate daemon*, so we cannot set its
 * environment the way we do for the Python we spawn. If it was started without
 * OLLAMA_MODELS it silently writes to the user profile — which is how ~9GB
 * landed on a system drive that had 3GB spare. Detecting it is the only
 * defence available from inside this process.
 */
export function strayCacheLocations(): Array<{ label: string; dir: string; fix: string }> {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  if (!home) return [];
  return [
    {
      label: 'ollama',
      dir: path.join(home, '.ollama', 'models'),
      fix: `set OLLAMA_MODELS to ${OLLAMA_MODELS} and restart the Ollama daemon from a shell that has it`,
    },
    {
      label: 'huggingface',
      dir: path.join(home, '.cache', 'huggingface'),
      fix: `set HF_HOME to ${HF_CACHE}`,
    },
    {
      label: 'torch',
      dir: path.join(home, '.cache', 'torch'),
      fix: `set TORCH_HOME to ${TORCH_CACHE}`,
    },
  ];
}
