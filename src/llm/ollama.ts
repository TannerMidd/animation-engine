/**
 * Ollama client.
 *
 * Two jobs only: turning a premise into a script, and a description into a set
 * descriptor. Both are creative tasks where variety is a feature. The director
 * deliberately stays deterministic — it is instant, reproducible, and costs no
 * VRAM.
 *
 * **Every call unloads the model when it finishes.** Chatterbox wants ~4.5GB
 * during synthesis and a 14-22B model at Q4 wants 9-14GB; both resident on a
 * 16GB card is where a machine starts thrashing. They never need to be at once,
 * because writing happens before rendering — so this enforces it rather than
 * hoping.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize: string | null;
  quantization: string | null;
}

export type LlmAvailability =
  | { ok: true; models: OllamaModel[] }
  | { ok: false; reason: string };

export interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  /** JSON Schema. Ollama constrains output to match, so it cannot emit garbage. */
  format?: unknown;
  temperature?: number;
  /** Milliseconds. Generation on a local model is slow; the default is generous. */
  timeoutMs?: number;
}

export class Ollama {
  constructor(readonly host: string = process.env['OLLAMA_HOST'] ?? DEFAULT_HOST) {}

  private url(path: string): string {
    return `${this.host.replace(/\/$/, '')}${path}`;
  }

  async available(): Promise<LlmAvailability> {
    try {
      const models = await this.models();
      if (!models.length) {
        return {
          ok: false,
          reason: `Ollama is running but has no models. Pull one, e.g.:  ollama pull mistral-small`,
        };
      }
      return { ok: true, models };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: `Ollama not reachable at ${this.host} (${msg}). Install from https://ollama.com, then:  ollama pull mistral-small`,
      };
    }
  }

  async models(): Promise<OllamaModel[]> {
    const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }>;
    };
    return (body.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
    }));
  }

  /** Models currently resident in memory. */
  async loaded(): Promise<string[]> {
    try {
      const res = await fetch(this.url('/api/ps'), { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const res = await fetch(this.url('/api/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        system: opts.system,
        format: opts.format,
        stream: false,
        // Unload as soon as this response is done. See the note at the top.
        keep_alive: 0,
        options: { temperature: opts.temperature ?? 0.8 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama generate failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as { response?: string; error?: string };
    if (body.error) throw new Error(`Ollama: ${body.error}`);
    return body.response ?? '';
  }

  /** Evict a model. With no name, evicts everything currently resident. */
  async unload(model?: string): Promise<void> {
    const targets = model ? [model] : await this.loaded();
    await Promise.all(
      targets.map((name) =>
        fetch(this.url('/api/generate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Empty prompt plus keep_alive 0 is Ollama's documented way to evict.
          body: JSON.stringify({ model: name, prompt: '', keep_alive: 0, stream: false }),
          signal: AbortSignal.timeout(15_000),
        }).catch(() => undefined),
      ),
    );
  }
}

/**
 * Free VRAM before something else needs it.
 *
 * Called before every render job. Deliberately never throws: Ollama being
 * absent or unreachable must not stop a render that does not need it.
 */
export async function freeVramForRender(): Promise<string[]> {
  try {
    const ollama = new Ollama();
    const loaded = await ollama.loaded();
    if (loaded.length) await ollama.unload();
    return loaded;
  } catch {
    return [];
  }
}

/** Rough pick order for a fresh install, best first. */
export const SUGGESTED_MODELS = [
  'mistral-small',
  'qwen3:14b',
  'gemma3:12b',
  'llama3.1:8b',
] as const;

/** Prefer an installed model that looks suited to prose. */
export function pickModel(models: OllamaModel[], preferred?: string): string | null {
  if (preferred && models.some((m) => m.name === preferred)) return preferred;
  for (const want of SUGGESTED_MODELS) {
    const hit = models.find((m) => m.name === want || m.name.startsWith(`${want}:`));
    if (hit) return hit.name;
  }
  return models[0]?.name ?? null;
}
