/** Types mirroring the engine's schemas, narrowed to what the UI touches. */

export type Shot = 'WIDE' | 'MID' | 'CU' | 'ECU' | 'OTS' | 'TWO_SHOT';
export type CameraMove = 'HOLD' | 'PUSH_IN' | 'PULL_OUT' | 'PAN_L' | 'PAN_R' | 'SHAKE';
export type Mark = 'FAR_L' | 'SL' | 'CENTER' | 'SR' | 'FAR_R';

export interface CastMember {
  id: string;
  rig: string;
  mark: Mark;
  flip: boolean;
  scale: number;
  resting: string;
}

interface BeatCommon {
  shot: Shot;
  focus: string[];
  camera: CameraMove;
  reactions: Record<string, string>;
}

export type Beat =
  | (BeatCommon & { kind: 'line'; speaker: string; text: string; expression: string; gesture: string })
  | (BeatCommon & { kind: 'pause'; ms: number })
  | (BeatCommon & { kind: 'action'; text: string; ms: number });

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
  beatStarts: number[];
  estimated: boolean;
}

export interface Vocab {
  shots: Shot[];
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
}

export interface PropInstance {
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
  layout: { horizonY: number; ceilingY: number; marginX: number; marginY: number };
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
  [key: string]: unknown;
}

/** One expression drawn as a standalone SVG, cropped to the face. */
export interface FacePlate {
  label: string;
  svg: string;
}
