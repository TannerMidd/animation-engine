/** Types mirroring the engine's schemas, narrowed to what the UI touches. */

export type Shot = 'WIDE' | 'MID' | 'CU' | 'ECU' | 'OTS' | 'TWO_SHOT';
export type CameraMove = 'HOLD' | 'PUSH_IN' | 'PULL_OUT' | 'PAN_L' | 'PAN_R' | 'SHAKE' | 'SNAP_IN';
export type ShotPurpose = 'coverage' | 'establishing' | 'reaction' | 'action' | 'emphasis' | 'button';
export type Mark = 'FAR_L' | 'SL' | 'CENTER' | 'SR' | 'FAR_R';

export interface CastMember {
  id: string;
  rig: string;
  mark: Mark;
  flip: boolean;
  scale: number;
  visible?: boolean;
  position?: { x: number; y: number } | null;
  depth?: number;
  pose?: string;
  seat?: string | null;
  heldProp?: string | null;
  heldHand?: 'left' | 'right' | null;
  resting: string;
}

interface BeatCommon {
  id: string;
  purpose: ShotPurpose;
  shot: Shot;
  focus: string[];
  camera: CameraMove;
  reactions: Record<string, string>;
  locked?: boolean;
}

export type Beat =
  | (BeatCommon & { kind: 'line'; speaker: string; text: string; expression: string; gesture: string })
  | (BeatCommon & { kind: 'pause'; ms: number })
  | (BeatCommon & { kind: 'action'; text: string; ms: number; stage?: StageAction[]; unsupported?: string[] });

export interface StageAction {
  type: 'enter' | 'exit' | 'move' | 'sit' | 'stand' | 'look' | 'turn' | 'reach' | 'pick_up' | 'put_down' | 'tap';
  actor: string;
  durationFrames?: number;
  from?: { mark?: Mark; x?: number; y?: number; depth?: number };
  to?: { mark?: Mark; x?: number; y?: number; depth?: number };
  target?: string;
  /** Addressable set prop with a semantic seat handle. */
  seat?: string;
  /** Explicit intentional floor-seating. */
  floor?: boolean;
  direction?: 'left' | 'right' | 'front';
  prop?: string;
  count?: number;
  [key: string]: unknown;
}

export interface ShotList {
  scene: string;
  set: string | null;
  fps: number;
  characterFps: number;
  seed: number;
  width: number;
  height: number;
  cast: CastMember[];
  beats: Beat[];
}

export interface SceneSummary {
  name: string;
  directed: boolean;
  beats: number;
  set: string | null;
  hasVideo: boolean;
}

export interface SceneDetail {
  name: string;
  source: string;
  shots: ShotList | null;
  summary: { estimateMs: number; beatCounts: { line: number; pause: number; action: number } } | null;
  hasAudio: boolean;
  hasVideo: boolean;
  hasVertical?: boolean;
  hasExport?: boolean;
}

export interface CheckResult {
  characters: string[];
  newCharacters: string[];
  errors: string[];
  estimateMs: number;
  beatCounts: { line: number; pause: number; action: number };
  beats: Beat[];
  cast: CastMember[];
}

export interface PreviewInfo {
  previewId: string;
  durationMs: number;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  layout: 'horizontal' | 'vertical';
  beatStarts: number[];
  estimated: boolean;
}

export interface Vocab {
  shots: Shot[];
  shotPurposes: ShotPurpose[];
  cameraMoves: CameraMove[];
  marks: Mark[];
  gestures: string[];
  palettes: string[];
  engines: string[];
  look: LookVocab;
  outfit: { choices: Record<OutfitKey, string[]>; accents: string[] };
  auditionLines: string[];
  referenceSeconds: { min: number; max: number };
}

export type OutfitKey = 'sleeves' | 'collar' | 'neckwear' | 'pattern' | 'hat' | 'shoes';

export type Outfit = Record<OutfitKey, string> & { accent: string };

/**
 * Everything the appearance editor needs to build its own controls.
 *
 * Sent by the server rather than hardcoded here, so adding a hairstyle to the
 * generator makes it appear in the UI without touching the UI.
 */
export interface LookVocab {
  choices: Record<LookChoiceKey, string[]>;
  swatches: Record<'skin' | 'shirt' | 'hairColour' | 'trousers', string[]>;
  sliders: Array<{ key: LookSliderKey; label: string; min: number; max: number }>;
}

export type LookChoiceKey =
  | 'build' | 'head' | 'nose' | 'ears' | 'hair' | 'facialHair' | 'glasses' | 'eyes' | 'brows';
export type LookSwatchKey = 'skin' | 'shirt' | 'hairColour' | 'trousers';
export type LookSliderKey =
  | 'headSize' | 'bodyWidth' | 'bodyHeight' | 'limbLength' | 'limbWidth' | 'eyeSize' | 'eyeSpread';

export type Look =
  & Record<LookChoiceKey, string>
  & Record<LookSwatchKey, string>
  & Record<LookSliderKey, number>
  & { line: string };

export interface LlmStatus {
  ok: boolean;
  reason?: string | null;
  models: string[];
  recommended: string | null;
}

/** The active identity profile and the alternatives on disk. */
export interface ShowInfo {
  active: { id: string; version: string; hash: string; name: string };
  profiles: Array<{ id: string; name: string; version: string; hash: string }>;
}

export interface Health {
  ffmpeg: string | null;
  rhubarb: string | null;
  engines: Record<string, { ok: boolean; reason?: string; checking?: boolean }>;
  llm: LlmStatus;
  sapiVoices: string[];
  sets: string[];
  cast: string[];
  activeJob: JobSummary | null;
}

export interface JobEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  stage?: string;
  done?: number;
  total?: number;
  message?: string;
  result?: unknown;
}

export interface JobSummary {
  id: string;
  kind: string;
  scene: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  result?: unknown;
  error?: string;
  lastEvent: JobEvent | null;
}

// --- sets ---

export type ParamValue = number | string | boolean;

export interface ParamSpec {
  key: string;
  label: string;
  type: 'number' | 'text' | 'boolean' | 'choice';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
}

export interface PropDefInfo {
  key: string;
  label: string;
  tags: string[];
  spanning: boolean;
  params: ParamSpec[];
  interaction?: {
    portable: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    handles: Array<{
      id: string;
      label: string;
      kind: 'grip' | 'contact' | 'placement' | 'control' | 'seat';
      x: number;
      y: number;
      radius: number;
      normal?: { x: number; y: number };
    }>;
  } | null;
}

export interface PropInstance {
  /** Stable set-local identity used by staging and prop contacts. */
  id?: string;
  prop: string;
  x?: number;
  y?: number;
  scale: number;
  flip: boolean;
  params: Record<string, ParamValue>;
}

export type LayerName = 'back' | 'mid' | 'fore';

export interface SetDescriptor {
  name: string;
  palette: string;
  layout: {
    horizonY: number;
    ceilingY: number;
    marginX: number;
    marginY: number;
    /** Set-authored valid area for visible actor root motion. */
    walkable: { x: number; y: number; width: number; height: number };
  };
  layers: Record<LayerName, PropInstance[]>;
}

export interface SetSummary {
  name: string;
  palette: string;
  builtin: boolean;
  propCount: number;
}

// --- cast ---

export interface CastSummary {
  name: string;
  voice: string;
  voiceRate: number;
  voiceRef: string | null;
  look: Look;
  expressions: string[];
  poses: string[];
}

export interface RigDoc {
  name: string;
  voice: string;
  voiceRate: number;
  voiceRef: string | null;
  voiceProvenance?: { source: 'minted' | 'recorded' | 'uploaded' } | null;
  look?: Look;
  outfit?: Outfit;
  expressions: { name: string }[];
  poses: { name: string }[];
  anchor?: [number, number];
  parts?: Array<{ id: string; parent: string | null; pivot: [number, number]; z: number }>;
  [key: string]: unknown;
}

// --- dialogue performance -------------------------------------------------

export interface AudioAsset {
  file: string;
  checksum: string;
  byteLength: number;
  mediaType: string;
  sampleRate: number;
  channels: number;
  sampleCount: number;
  durationMs: number;
}

export interface RecordedTake {
  id: string;
  cueId: string | null;
  speaker: string;
  displayText: string;
  spokenText: string;
  audio: AudioAsset;
  quality?: {
    verdict: 'pass' | 'warn' | 'reject';
    peakDb: number | null;
    rmsDb: number | null;
    speechRatio: number;
    flags: string[];
  } | null;
  capture: {
    mode: 'line-booth' | 'scene-run' | 'imported';
    recordedAt: string;
    performerId: string | null;
    latencyCompensationMs: number;
    consentId: string | null;
  };
  provenance: {
    notes: string[];
    sceneRunSegments?: Array<{
      cueId: string;
      scriptTextHash: string;
      inMs: number;
      outMs: number;
      speechOnsetMs: number;
      speechEndMs: number;
      quality: {
        verdict: 'pass' | 'warn' | 'reject';
        peakDb: number | null;
        rmsDb: number | null;
        speechRatio: number;
        flags: string[];
      } | null;
    }>;
  };
}

export interface VoiceRender {
  id: string;
  source: { kind: string; takeId?: string; targetVoiceId?: string };
  state: 'ready' | 'failed' | 'stale' | 'rejected';
  audio: AudioAsset | null;
  model: {
    engine: string;
    model: string;
    revision: string;
    settings: Record<string, unknown>;
    generatedAt: string;
  };
  alignment: {
    sourceToOutput: Array<{ sourceMs: number; outputMs: number }>;
    words: Array<{ text: string; startMs: number; endMs: number; confidence: number | null }>;
    phonemes: Array<{ text: string; startMs: number; endMs: number; confidence: number | null }>;
  };
  quality: {
    verdict: 'pass' | 'warn' | 'reject';
    transcriptMatch: number | null;
    speechRatio: number | null;
    clippedSampleRatio: number | null;
    stretchRatio: number | null;
    speakerSimilarity: number | null;
    cadenceSimilarity: number | null;
    flags: string[];
  };
}

export interface CueOverlap {
  withCueId: string;
  mode: 'pickup' | 'overlap' | 'interruption';
  ms: number;
  interruptAtMs: number | null;
}

export interface CueDelivery {
  expression: string;
  intent: string;
  energy: number;
  pace: number;
  notes: string[];
  emphasis: Array<{ startChar: number; endChar: number; level: 'light' | 'strong' }>;
  pronunciations: Array<{ written: string; spoken: string }>;
}

export interface DialogueCue {
  id: string;
  beatIndex: number;
  speaker: string;
  displayText: string;
  spokenText: string;
  selectedTakeId: string | null;
  selectedRenderId: string | null;
  trim: { inMs: number; outMs: number; speechOnsetMs: number; speechEndMs: number } | null;
  startFrame: number;
  durationFrames: number | null;
  pickupMs: number;
  turnGapMs: number;
  pauseAfterMs: number;
  overlap: CueOverlap | null;
  durationPolicy: {
    mode: 'follow-performance' | 'fit-locked-window' | 'rerecord-to-picture';
    targetFrames: number | null;
    warnVoicedStretchRatio: number;
    maxVoicedStretchRatio: number;
    downstream: 'ripple' | 'retime-attached-motion' | 'preserve-absolute';
  };
  delivery: CueDelivery;
  approval: { state: 'draft' | 'candidate' | 'approved' | 'rejected' | 'stale' | 'unresolved'; notes: string[]; by: string | null; at: string | null };
  locked: boolean;
  lockedFields: string[];
  provenance: Record<string, unknown>;
}

export interface DialogueDocument {
  schemaVersion: 1;
  scene: string;
  revision: number;
  fps: number;
  scriptHash: string | null;
  consents: Array<{
    id: string;
    subject: string;
    basis: 'self-owned' | 'written-license' | 'performer-contract' | 'synthetic-owned';
    scope: 'target-voice' | 'performance' | 'both';
    referenceChecksum: string | null;
    permits: { voiceConversion: boolean; distribution: boolean; training: boolean };
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    notes: string[];
  }>;
  recordedTakes: RecordedTake[];
  voiceRenders: VoiceRender[];
  cues: DialogueCue[];
}

export interface PreflightWarningAcknowledgement {
  schemaVersion: 1;
  id: string;
  scene: string;
  policyId: string;
  fingerprint: string;
  warnings: Array<{ code: string; message: string }>;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export interface ProductionPreflightReport {
  ok: boolean;
  productionBlocked: boolean;
  renderEndpointBlocked: boolean;
  notes: Array<{
    level: 'error' | 'warn' | 'info';
    code: string;
    message: string;
    blocking?: boolean;
  }>;
  warningReview: {
    required: boolean;
    current: boolean;
    acknowledgement: PreflightWarningAcknowledgement | null;
  };
}

// --- editable animation ---------------------------------------------------

export type TimeAnchor =
  | { kind: 'absolute'; ms: number }
  | { kind: 'beat'; beatId: string; edge: 'start' | 'end'; offsetMs: number }
  | { kind: 'speech'; beatId: string; edge: 'start' | 'end'; offsetMs: number }
  | { kind: 'word'; beatId: string; wordId: string; edge: 'start' | 'end'; offsetMs: number };

export type AnimationValue = [number, number] | number | boolean | { rot: number; x: number; y: number; scale: number };
export interface AnimationKey {
  id: string;
  time: TimeAnchor;
  value: AnimationValue;
  interpolation: 'hold' | 'linear';
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  locked: boolean;
}

export interface AnimationTrack {
  id: string;
  layerId: string;
  actorId: string;
  channel: 'root.position' | 'root.scale' | 'root.flip' | 'visibility' | 'part.transform';
  partId?: string;
  blend: 'override' | 'additive';
  enabled: boolean;
  locked: boolean;
  keys: AnimationKey[];
}

export type MotionValue = [number, number] | number | { rot: number; x: number; y: number; scale: number };
export interface MotionControl<T extends MotionValue = MotionValue> {
  id: string;
  time?: TimeAnchor;
  at?: number;
  value: T;
  locked: boolean;
}

interface MotionSegmentBase<T extends MotionValue> {
  id: string;
  layerId: string;
  actorId: string;
  blend: 'override' | 'additive';
  enabled: boolean;
  locked: boolean;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  path: { shape: 'linear' | 'smooth' | 'arc'; curvature: number };
  assist: { anticipation: number; overshoot: number; hold: number; recovery: number };
  source: 'drag' | 'puppeteering' | 'imported';
  from: MotionControl<T> & { time: TimeAnchor };
  to: MotionControl<T> & { time: TimeAnchor };
  waypoints: Array<MotionControl<T> & { at: number }>;
}

export type MotionSegment =
  | (MotionSegmentBase<[number, number]> & { channel: 'root.position' })
  | (MotionSegmentBase<number> & { channel: 'root.scale' })
  | (MotionSegmentBase<{ rot: number; x: number; y: number; scale: number }> & {
      channel: 'part.transform';
      partId: string;
    });

export interface AnimationDocument {
  schemaVersion: 1;
  scene: string;
  revision: number;
  layers: Array<{ id: string; name: string; ownership: 'generated' | 'manual' | 'system'; priority: number; enabled: boolean; locked: boolean }>;
  tracks: AnimationTrack[];
  segments: MotionSegment[];
  events: unknown[];
}

/** One expression drawn as a standalone SVG, cropped to the face. */
export interface FacePlate {
  label: string;
  svg: string;
}
