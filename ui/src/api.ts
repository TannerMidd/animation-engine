import type {
  AnimationDocument, CastSummary, CheckResult, DialogueCue, DialogueDocument, FacePlate, Health, JobEvent,
  JobSummary, LlmStatus, Look, PreviewInfo, Outfit, ProductionPreflightReport, PropDefInfo, RecordedTake, RigDoc, SceneDetail,
  SceneSummary, SetDescriptor, SetSummary, ShotList, ShowInfo, Vocab,
} from './types.ts';

/** Thin typed wrappers over the engine server. */

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(url: string, body?: unknown) =>
  call<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(url: string, body: unknown) =>
  call<T>(url, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(url: string) => call<T>(url, { method: 'DELETE' });

export const api = {
  health: () => call<Health>('/api/health'),
  vocab: () => call<Vocab>('/api/vocab'),
  show: () => call<ShowInfo>('/api/show'),
  setActiveShow: (id: string) => put<{ ok: true }>('/api/show/active', { id }),

  scenes: () => call<SceneSummary[]>('/api/scenes'),
  scene: (name: string) => call<SceneDetail>(`/api/scenes/${name}`),
  saveScript: (name: string, source: string) => put<{ ok: true }>(`/api/scenes/${name}`, { source }),

  check: (name: string, body: { source?: string; seed?: number; resting?: string; set?: string | null }) =>
    post<CheckResult>(`/api/scenes/${name}/check`, body),

  direct: (name: string, body: { source?: string; seed?: number; resting?: string; set?: string | null }) =>
    post<{
      proposed: ShotList;
      diff: Array<{ index: number; kind: string; change: string; summary: string }>;
      keptLocked: number;
      droppedLocked: number;
      errors: string[];
      newCharacters: string[];
    }>(`/api/scenes/${name}/direct`, body),
  applyDirect: (name: string, shots: ShotList) =>
    post<{ ok: true }>(`/api/scenes/${name}/direct/apply`, { shots }),
  preflight: (name: string) => call<ProductionPreflightReport>(`/api/scenes/${name}/preflight`),
  acknowledgePreflightWarnings: (name: string, acknowledgedBy = 'local-creator') =>
    post<ProductionPreflightReport>(`/api/scenes/${name}/preflight/acknowledge`, { acknowledgedBy }),

  saveShotList: (name: string, shots: ShotList) =>
    put<{ ok: true }>(`/api/scenes/${name}/shotlist`, { shots }),

  dialogue: (name: string) => call<DialogueDocument>(`/api/scenes/${name}/dialogue`),
  saveDialogue: (name: string, document: DialogueDocument) =>
    put<{ ok: true; revision: number }>(`/api/scenes/${name}/dialogue`, { document }),
  saveDialogueCue: (name: string, cue: DialogueCue, expectedRevision?: number) =>
    put<{ ok: true; revision: number; cue: DialogueCue }>(
      `/api/scenes/${name}/dialogue/cues/${encodeURIComponent(cue.id)}`, { cue, expectedRevision },
    ),
  registerVoiceConsent: (
    name: string,
    cueId: string,
    body: {
      id: string;
      subject: string;
      basis: 'self-owned' | 'written-license' | 'performer-contract' | 'synthetic-owned';
      scope?: 'target-voice' | 'performance' | 'both';
      distribution?: boolean;
      training?: boolean;
      expiresAt?: string | null;
      notes?: string[];
      confirmed: boolean;
    },
  ) => post<{ ok: true; revision: number }>(
    `/api/scenes/${name}/dialogue/${encodeURIComponent(cueId)}/consents`, body,
  ),
  revokeVoiceConsent: (name: string, consentId: string) => post<{ ok: true; revision: number }>(
    `/api/scenes/${name}/dialogue/consents/${encodeURIComponent(consentId)}/revoke`, {},
  ),
  uploadPerformance: (
    name: string,
    cueId: string,
    body: {
      dataBase64: string;
      filename?: string;
      mode?: 'line-booth' | 'scene-run' | 'imported';
      performerId?: string | null;
      consentId?: string | null;
      inputDevice?: string | null;
      latencyCompensationMs?: number;
      countInMs?: number;
    },
  ) => post<{ ok: true; revision: number; take: RecordedTake; capture: { warnings: string[] } }>(
    `/api/scenes/${name}/dialogue/${encodeURIComponent(cueId)}/takes`, body,
  ),
  uploadSceneRun: (
    name: string,
    body: {
      dataBase64: string;
      filename?: string;
      speaker: string;
      segments: Array<{ cueId: string; inMs: number; outMs: number; speechOnsetMs?: number; speechEndMs?: number }>;
      performerId?: string | null;
      consentId?: string | null;
      inputDevice?: string | null;
      latencyCompensationMs?: number;
      countInMs?: number;
    },
  ) => post<{
    ok: true;
    revision: number;
    take: RecordedTake;
    capture: { warnings: string[] };
    segments: Array<{ cueId: string; inMs: number; outMs: number; speechOnsetMs: number; speechEndMs: number }>;
  }>(`/api/scenes/${name}/dialogue/scene-runs`, body),
  convertPerformance: (
    name: string,
    cueId: string,
    body: { takeId?: string; consentId: string; registerPolicy?: 'preserve-performer' | 'adapt-to-character'; seed?: number },
  ) => post<JobSummary>(`/api/scenes/${name}/dialogue/${encodeURIComponent(cueId)}/convert`, body),

  animation: (name: string) => call<AnimationDocument>(`/api/scenes/${name}/animation`),
  saveAnimation: (name: string, document: AnimationDocument) =>
    put<{ ok: true; revision: number; document: AnimationDocument }>(`/api/scenes/${name}/animation`, { document }),

  preview: (name: string, withAudio: boolean, layout: 'horizontal' | 'vertical' = 'horizontal') =>
    post<PreviewInfo>(`/api/scenes/${name}/preview`, { withAudio, layout }),

  voices: (name: string) => post<JobSummary>(`/api/scenes/${name}/voices`),
  render: (name: string, engine?: string) => post<JobSummary>(`/api/scenes/${name}/render`, { engine }),
  job: (id: string) => call<JobSummary>(`/api/jobs/${id}`),

  cast: () => call<CastSummary[]>('/api/cast'),
  rig: (name: string) => call<{ rig: RigDoc; svg: string; look: Look }>(`/api/cast/${name}`),
  saveRig: (name: string, rig: RigDoc) => put<{ ok: true }>(`/api/cast/${name}`, { rig }),
  newCharacter: (name: string) => post<{ name: string; look: Look }>('/api/cast', { name }),
  regenerateRig: (name: string) => post<{ rig: RigDoc; look: Look }>(`/api/cast/${name}/regenerate`),

  saveLook: (name: string, look: Look, outfit?: Outfit) =>
    put<{ rig: RigDoc; look: Look }>(`/api/cast/${name}/look`, { look, outfit }),
  rollLook: (name: string, salt: string) =>
    call<{ look: Look }>(`/api/cast/${name}/look/roll?salt=${encodeURIComponent(salt)}`),

  castPreview: (name: string, pose: string, expression: string, look?: Look, outfit?: Outfit) =>
    post<{ previewId: string }>(`/api/cast/${name}/preview`, { pose, expression, look, outfit }),
  faces: (name: string, look?: Look, outfit?: Outfit) =>
    post<{ plates: FacePlate[] }>(`/api/cast/${name}/faces`, { look, outfit }),

  uploadRef: (name: string, filename: string, dataBase64: string) =>
    put<{ ok: true; voiceRef: string; durationMs: number; warnings: string[] }>(
      `/api/cast/${name}/ref`, { filename, dataBase64 },
    ),
  clearRef: (name: string) => del<{ ok: true; voiceRef: null }>(`/api/cast/${name}/ref`),
  audition: (name: string, body: { text?: string; expression?: string; engine?: string; seed?: number; candidate?: string }) =>
    post<JobSummary>(`/api/cast/${name}/audition`, body),

  mintVoices: (name: string, count = 3) => post<JobSummary>(`/api/cast/${name}/voices/mint`, { count }),
  commitVoice: (name: string, salt: string) =>
    post<{ ok: true; voiceRef: string }>(`/api/cast/${name}/voices/commit`, { salt }),
  discardVoices: (name: string) => post<{ ok: true }>(`/api/cast/${name}/voices/discard`),
  prepareVoices: (scene: string) => post<JobSummary>(`/api/scenes/${scene}/voices/prepare`),

  sets: () => call<SetSummary[]>('/api/sets'),
  set: (name: string) => call<SetDescriptor>(`/api/sets/${name}`),
  saveSet: (name: string, set: SetDescriptor) => put<{ ok: true }>(`/api/sets/${name}`, { set }),
  setPreview: (name: string, set?: SetDescriptor, cast?: string[]) =>
    post<{ previewId: string; notes: string[] }>(`/api/sets/${name}/preview`, { set, cast }),

  tidySet: (name: string, set: SetDescriptor) =>
    post<{ set: SetDescriptor; notes: string[] }>(`/api/sets/${name}/tidy`, { set }),

  props: () => call<{ props: PropDefInfo[]; tags: string[] }>('/api/props'),

  llm: () => call<LlmStatus & { suggested: string[] }>('/api/llm'),
  generateScript: (premise: string, opts: { characters?: number; targetSeconds?: number } = {}) =>
    post<{ source: string; characters: string[]; lineCount: number; attempts: number; model: string }>(
      '/api/llm/script',
      { premise, ...opts },
    ),
  generateSet: (description: string, name: string) =>
    post<{ set: SetDescriptor; attempts: number; model: string }>('/api/llm/set', { description, name }),
};

/**
 * Follow a job's progress.
 *
 * Renders take minutes, so the UI streams events rather than polling — the
 * server replays anything missed on connect, so a late subscriber still sees
 * the whole run.
 */
export function followJob(
  id: string,
  onEvent: (e: JobEvent) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as JobEvent);
    } catch {
      // A malformed frame should not kill the stream.
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}

/**
 * A blob as base64, for JSON upload.
 *
 * Chunked rather than one `String.fromCharCode(...bytes)` call: spreading a
 * multi-megabyte array into an argument list overflows the call stack, and a
 * thirty-second recording is comfortably large enough to do it.
 */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fmtMs(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
