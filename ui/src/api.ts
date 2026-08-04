import type {
  AnimationDocument, BenchResult, CastSummary, CheckResult, ConversionCheckResult, DialogueCue, DialogueDocument,
  DoctorReport, FacePlate, Health, JobEvent, JobSummary, LlmStatus, Look, MigrationInfo, PreviewInfo, Outfit,
  ProductionPreflightReport, ProfileDiff, ProfileValidation, PropDefInfo, PropDetail, PropDocument, PropRender,
  Palette, ParamValue, RecordedTake, RigCheckResult, RigDoc,
  SceneDetail, SceneSoundInfo, SceneSummary, SetDescriptor, SetSummary, ShotList, ShowInfo, StemId, Vocab,
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
  doctor: () => call<DoctorReport>('/api/doctor'),
  show: () => call<ShowInfo>('/api/show'),
  setActiveShow: (id: string) => put<{ ok: true }>('/api/show/active', { id }),
  validateShow: () => call<{ ok: boolean; results: ProfileValidation[] }>('/api/show/validate'),
  compareShow: (a: string, b: string) => post<{ diffs: ProfileDiff[] }>('/api/show/compare', { a, b }),
  renderReel: (body: { script?: string; a?: string; b?: string; engine?: string } = {}) =>
    post<JobSummary>('/api/show/reel', body),
  migrationPlan: () => call<MigrationInfo>('/api/migrate'),
  applyMigration: () => post<{ ok: true; applied: number; changes: MigrationInfo['changes'] }>('/api/migrate'),

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
  revokeTake: (name: string, takeId: string) => post<{ ok: true; revision: number; revokedAt: string }>(
    `/api/scenes/${name}/dialogue/takes/${encodeURIComponent(takeId)}/revoke`, {},
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

  voices: (name: string, engine?: string) => post<JobSummary>(`/api/scenes/${name}/voices`, { engine }),
  render: (name: string, opts: { engine?: string; draft?: boolean } = {}) =>
    post<JobSummary>(`/api/scenes/${name}/render`, opts),
  job: (id: string) => call<JobSummary>(`/api/jobs/${id}`),

  sound: (name: string) => call<SceneSoundInfo>(`/api/scenes/${name}/sound`),
  rebuildStems: (name: string, engine?: string) =>
    post<JobSummary>(`/api/scenes/${name}/sound/rebuild`, { engine }),
  stemUrl: (name: string, stem: StemId) => `/api/scenes/${name}/stems/${stem}`,

  cast: () => call<CastSummary[]>('/api/cast'),
  rig: (name: string) => call<{ rig: RigDoc; svg: string; look: Look }>(`/api/cast/${name}`),
  saveRig: (name: string, rig: RigDoc) => put<{ ok: true }>(`/api/cast/${name}`, { rig }),
  newCharacter: (name: string) => post<{ name: string; look: Look }>('/api/cast', { name }),
  regenerateRig: (name: string, reroll = false) =>
    post<{ rig: RigDoc; look: Look }>(`/api/cast/${name}/regenerate`, { reroll }),

  checkCast: (names?: string[]) =>
    post<{ ok: boolean; results: RigCheckResult[] }>('/api/cast/check', { names }),
  castSheet: (body: { names?: string[]; expression?: string } = {}) =>
    post<JobSummary>('/api/cast/sheet', body),
  still: (name: string, body: { pose?: string; expression?: string; scale?: number; seed?: number } = {}) =>
    post<JobSummary>(`/api/cast/${name}/still`, body),
  idle: (name: string, body: { seconds?: number; fps?: number; characterFps?: number; seed?: number } = {}) =>
    post<JobSummary>(`/api/cast/${name}/idle`, body),

  bench: () => call<{ result: BenchResult | null }>('/api/voices/bench'),
  runBench: (only?: string[]) => post<JobSummary>('/api/voices/bench', { only }),
  benchAudioUrl: (character: string, file: string) =>
    `/api/voices/bench/${encodeURIComponent(character)}/${encodeURIComponent(file)}`,
  voicesCheck: (body: { scene?: string; takeId?: string; source?: string; only?: string[] }) =>
    post<JobSummary>('/api/voices/check', body),
  voicesCheckAudioUrl: (file: string) => `/api/voices/check/audio/${encodeURIComponent(file)}`,

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
  palettes: () => call<Record<string, Palette>>('/api/palettes'),

  // --- prop authoring ---
  prop: (key: string) => call<PropDetail>(`/api/props/${key}`),
  /** `renames` carries saved sets across a param rename; without it the old value is dropped. */
  saveProp: (key: string, document: PropDocument, renames?: Record<string, string>) =>
    put<{ ok: true; path: string; migratedSets: string[]; warnings: string[] }>(
      `/api/props/${key}`, { document, renames },
    ),
  deleteProp: (key: string) => del<{ ok: true }>(`/api/props/${key}`),
  propUsage: (key: string) => call<{ sets: string[] }>(`/api/props/${key}/usage`),
  /**
   * Render one prop. Takes the document rather than the key so the canvas shows
   * what is being drawn rather than what was last saved.
   */
  renderProp: (body: {
    document?: PropDocument;
    key?: string;
    params?: Record<string, ParamValue>;
    palette?: string;
    view?: string;
  }) => post<PropRender>('/api/props/render', body),
  checkProp: (body: { document?: PropDocument; key?: string }) =>
    post<{ ok: boolean; problems: string[] }>('/api/props/check', body),

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
  let settled = false;
  source.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as JobEvent;
      if (event.type === 'done' || event.type === 'error') settled = true;
      onEvent(event);
    } catch {
      // A malformed frame should not kill the stream.
    }
  };
  // The server ends the stream normally once a job reports its outcome, and
  // EventSource surfaces that as an error too — so only a drop *before* an
  // outcome is a real failure. Reporting it matters: staying silent left the
  // caller waiting on a job that would never speak again.
  source.onerror = () => {
    source.close();
    if (settled) return;
    settled = true;
    onEvent({ type: 'error', message: 'lost the connection to the engine while the job was running' });
  };
  return () => {
    settled = true;
    source.close();
  };
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
