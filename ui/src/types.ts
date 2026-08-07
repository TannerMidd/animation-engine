/** UI view models plus exact authored-domain contracts from the engine. */
import type {
  AnimationDocument,
  AnimationKey,
  AnimationTrack,
  Beat,
  CameraMove,
  CastMember,
  DialogueCue,
  DialogueDocument,
  Mark,
  MotionSegment,
  MotionValue,
  PropReferenceIssue,
  PropSubstitute,
  RecordedTake,
  SetDescriptor,
  SetFit,
  Shot,
  ShotList,
  ShotPurpose,
  StageAction,
  TimeAnchor,
  VoiceRender,
} from '../../src/contracts/domain.ts';

export type {
  AnimationDocument,
  AnimationKey,
  AnimationTrack,
  Beat,
  CameraMove,
  CastMember,
  DialogueCue,
  DialogueDocument,
  Mark,
  MotionSegment,
  MotionValue,
  PropReferenceIssue,
  PropSubstitute,
  RecordedTake,
  SetDescriptor,
  SetFit,
  Shot,
  ShotList,
  ShotPurpose,
  StageAction,
  TimeAnchor,
  VoiceRender,
};

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
  /**
   * Whether the rendered mix still belongs to this scene. `stale` means a
   * dialogue.wav exists but the server will not serve it — run Voices.
   */
  soundtrack: 'missing' | 'current' | 'stale' | 'error';
}

export interface Vocab {
  shots: Shot[];
  shotPurposes: ShotPurpose[];
  cameraMoves: CameraMove[];
  marks: Mark[];
  gestures: string[];
  /** Optional so an older server degrades to a plain parenthetical field. */
  emotions?: EmotionVocab;
  /** Optional for the same reason; without it the action card stays free text. */
  actions?: ActionVocab;
  palettes: string[];
  engines: string[];
  look: LookVocab;
  outfit: { choices: Record<OutfitKey, string[]>; accents: string[] };
  auditionLines: string[];
  referenceSeconds: { min: number; max: number };
}

/**
 * The director's parenthetical table, as data.
 *
 * `words` is ordered and first match wins, so the composer can show what a
 * hand-typed parenthetical will actually resolve to without reimplementing —
 * or drifting from — the rule in src/direct/emotions.ts.
 */
export interface EmotionVocab {
  words: Array<{ pattern: string; expression: string }>;
  /** Expression -> the word to write when the choice was made by picking. */
  canonical: Record<string, string>;
  /** Expression -> what a rig lacking it plays instead, in order. */
  fallbacks: Record<string, string[]>;
}

/**
 * Ways of writing an action the director is known to understand.
 *
 * The wording lives in src/direct/action-canon.ts and arrives as templates, so
 * the builder fills in blanks rather than inventing phrasing the prose parser
 * would reject.
 */
export interface ActionVocab {
  templates: ActionTemplateVocab[];
  /** Mark -> how to say it ("FAR_L" -> "far left"). */
  marks: Record<string, string>;
  /** Facing -> how to say it ("front" -> "toward camera"). */
  directions: Record<string, string>;
  counts: string[];
}

/** A stage action the builder can compose, and the fields it needs to do it. */
export interface ActionTemplateVocab {
  id: string;
  type: string;
  label: string;
  fields: ActionField[];
  /** Placeholders in {braces}, one per field. */
  template: string;
}

export type ActionField =
  | 'actor' | 'targetActor' | 'object' | 'target' | 'mark' | 'direction' | 'seat' | 'count';

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
  /** Absent on an older server, so treat a missing daemon block as "cannot offer to start". */
  daemon?: LlmDaemon;
}

/** Whether the local model daemon could simply be switched on. */
export interface LlmDaemon {
  running: boolean;
  startable: boolean;
  binary: string | null;
  /** Where a daemon started from here keeps its weights. */
  modelsDir: string;
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
  /**
   * Identity of the conversion runtime as it stands now. Renders carry the
   * fingerprint they were made with, so output from a build with a known
   * defect can be told apart from output this build would still produce.
   */
  voiceConversion: { fingerprint: string; packageRevision: string; modelRevision: string };
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

export type HandleKind = 'grip' | 'contact' | 'placement' | 'control' | 'seat';

export interface PropInteraction {
  portable: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  handles: Array<{
    id: string;
    label: string;
    kind: HandleKind;
    x: number;
    y: number;
    radius: number;
    normal?: { x: number; y: number };
  }>;
}

export interface PropDefInfo {
  key: string;
  label: string;
  tags: string[];
  spanning: boolean;
  params: ParamSpec[];
  interaction?: PropInteraction | null;
  /** A document can be edited in the studio; a builtin is still a render function. */
  source: 'document' | 'builtin';
}

// --- prop documents -------------------------------------------------------

/**
 * A number in a document is either a literal or arithmetic over the prop's own
 * params. The studio writes the expressions; a person can, but should not have
 * to.
 */
export type Num = number | string;

interface PrimBase {
  /** Palette slot, or null for an unfilled shape. On a line, the stroke colour. */
  f?: string | null;
  /** Outline. */
  l?: 0 | 1;
  /** At the edge of the world: square, unwobbled, fill only. */
  e?: 0 | 1;
  /** Draw crisply, keeping the outline. */
  sm?: 0 | 1;
  o?: Num;
  sw?: Num;
  rot?: Num;
  /** Expression; the primitive is omitted when it evaluates to zero. */
  show?: string;
}

export interface RectPrim extends PrimBase { k: 'rect'; x: Num; y: Num; w: Num; h: Num; rx?: Num }
export interface EllipsePrim extends PrimBase { k: 'ellipse'; cx: Num; cy: Num; rx: Num; ry: Num }
export interface PolyPrim extends PrimBase { k: 'poly'; p: Num[]; c?: 0 | 1 }
export interface LinePrim extends PrimBase { k: 'line'; x1: Num; y1: Num; x2: Num; y2: Num }
export interface TextPrim extends PrimBase {
  k: 'text';
  x: Num; y: Num; size: Num;
  /** `$key` interpolates a text param. */
  value: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: 'normal' | 'bold';
  st?: string | null;
}
export interface RepeatPrim { k: 'repeat'; n: Num; dx?: Num; dy?: Num; of: Primitive[]; show?: string }

export type Primitive = RectPrim | EllipsePrim | PolyPrim | LinePrim | TextPrim | RepeatPrim;
export type PrimitiveKind = Primitive['k'];

export interface PropView {
  primitives?: Primitive[];
  /** Format 1 geometry, still read so committed bakes keep working. */
  shapes?: Array<{ f?: string | null; l?: 0 | 1; c?: 0 | 1; e?: 0 | 1; p: number[] }>;
}

export interface PropDocument {
  format: 1 | 2;
  key: string;
  label: string;
  tags: string[];
  spanning: boolean;
  params: ParamSpec[];
  provenance: { blender: string; source: string; baked: string };
  frame?: { x0: number; y0: number; width: number; height: number; horizonY: number; ceilingY: number };
  interaction?: {
    portable: boolean;
    bounds: { x: Num; y: Num; width: Num; height: Num };
    handles: Array<{ id: string; label: string; kind: HandleKind; x: Num; y: Num; radius: Num; normal?: { x: number; y: number } }>;
  };
  views: Record<string, PropView>;
}

/** `GET /api/props/:key`. */
export interface PropDetail {
  key: string;
  label: string;
  tags: string[];
  spanning: boolean;
  params: ParamSpec[];
  interaction: PropInteraction | null;
  editable: boolean;
  document: PropDocument | null;
}

/** Where a primitive landed, so the canvas can put a handle on it. */
export interface PrimitiveBox {
  /** Index path into the view's primitives — the address of the authored shape. */
  path: number[];
  kind: PrimitiveKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which expansion of an enclosing repeat this is; empty for a plain primitive. */
  copy: number[];
}

/** `POST /api/props/render`. */
export interface PropRender {
  svg: string;
  extent: { x: number; y: number; width: number; height: number } | null;
  boxes: PrimitiveBox[];
  spanning: boolean;
  params: ParamSpec[];
  interaction: PropInteraction | null;
  warnings: string[];
}

export type Palette = Record<string, string>;

/** A ready-made Blender source, and the form it wants filled in. */
export interface Recipe {
  name: string;
  label: string;
  blurb: string;
  tags: string[];
  params: ParamSpec[];
  views: string[];
}

/** How much of the camera's travel a layer takes, per axis. 1 is locked to the stage. */
export interface ParallaxFactor {
  x: number;
  y: number;
}

export interface PropInstance {
  /** Stable set-local identity used by staging and prop contacts. */
  id?: string;
  prop: string;
  /** Overrides the layer's factor, for a prop at its own depth. */
  parallax?: ParallaxFactor;
  x?: number;
  y?: number;
  scale: number;
  flip: boolean;
  params: Record<string, ParamValue>;
}

export type LayerName = 'back' | 'mid' | 'fore';

export interface SetSummary {
  name: string;
  palette: string;
  builtin: boolean;
  propCount: number;
  /** Present when the list was fetched for a scene. */
  fit?: SetFit;
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
  schemaVersion?: 1;
  name: string;
  voice: string;
  voiceRate: number;
  voiceRef: string | null;
  voiceProvenance?: { source: 'minted' | 'recorded' | 'uploaded'; bankVoice?: string } | null;
  look?: Look;
  outfit?: Outfit;
  expressions: { name: string }[];
  poses: { name: string }[];
  anchor?: [number, number];
  parts?: Array<{ id: string; parent: string | null; pivot: [number, number]; z: number }>;
  [key: string]: unknown;
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

/** What a note is about, so a click can select it (mirrors src/pipeline/preflight.ts). */
export interface ProductionPreflightTarget {
  kind: 'beat' | 'cue' | 'actor' | 'motion' | 'set';
  id: string;
}

export interface ProductionPreflightNote {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  blocking?: boolean;
  target?: ProductionPreflightTarget;
}

export interface ProductionPreflightReport {
  ok: boolean;
  productionBlocked: boolean;
  renderEndpointBlocked: boolean;
  notes: ProductionPreflightNote[];
  warningReview: {
    required: boolean;
    current: boolean;
    acknowledgement: PreflightWarningAcknowledgement | null;
  };
}

/** One expression drawn as a standalone SVG, cropped to the face. */
export interface FacePlate {
  label: string;
  svg: string;
}

// --- system report (mirrors src/pipeline/doctor.ts) -------------------------

export interface DoctorReport {
  ffmpeg: { version: string | null; path: string; old: boolean };
  chromium: { ok: boolean; version: string | null; error: string | null };
  rhubarb: { ok: boolean; path: string | null };
  models: {
    root: string;
    onSystemDrive: boolean;
    caches: Array<{ name: string; dir: string; bytes: number }>;
    strays: Array<{ label: string; dir: string; bytes: number; fix: string }>;
    manifest: {
      path: string;
      ok: boolean;
      checkedHashes: boolean;
      models: Array<{
        id: string;
        revision: string;
        license: string;
        ok: boolean;
        missing: string[];
        mismatched: string[];
      }>;
    };
  };
  llm: { ok: boolean; models: string[]; reason: string | null };
  engines: Array<{ name: string; ok: boolean; reason: string | null; checking?: boolean }>;
  asr: { ok: boolean; reason: string | null };
  cast: string[];
  blender: { ok: boolean; version: string | null; path: string | null; reason: string | null };
  bakedProps: {
    count: number;
    shapes: number;
    points: number;
    stale: string[];
    errors: Array<{ file: string; error: string }>;
  };
}

export interface ProfileValidation {
  id: string;
  ok: boolean;
  version: string | null;
  hash: string | null;
  error: string | null;
}

export interface MigrationInfo {
  identity: { id: string; version: string; hash: string; name: string };
  createProfile: boolean;
  changes: Array<{ kind: 'profile' | 'rig' | 'set' | 'shotlist'; target: string; actions: string[] }>;
}

// --- cast tools (mirrors src/pipeline/cast-tools.ts) ------------------------

export interface RigCheckResult {
  name: string;
  ok: boolean;
  errors: string[];
}

// --- voice bench and conversion check (mirrors src/pipeline/bench.ts) -------

export interface BenchLine {
  expression: string;
  text: string;
  file: string;
  qa: { passed: boolean; wer: number; transcript: string } | null;
}

export interface BenchCharacter {
  name: string;
  badge: string;
  refFile: string;
  lines: BenchLine[];
}

export interface BenchResult {
  engine: string;
  characters: BenchCharacter[];
  renderedAt: string;
}

export interface ConversionCheckRow {
  name: string;
  ok: boolean;
  missing: boolean;
  failures: string[];
  targetMedianPitchHz: number | null;
  conditioningLiftSemitones: number | null;
  outputMedianPitchHz: number | null;
  voicedRetention: number | null;
  pitchErrorSemitones: number | null;
  file: string | null;
}

export interface ConversionCheckResult {
  source: string;
  rows: ConversionCheckRow[];
  failures: number;
  checkedAt: string;
}

// --- sound mode (mirrors src/pipeline/sound.ts) -----------------------------

export type StemId = 'dialogue' | 'ambience' | 'foley' | 'stings';

export interface FoleyEventInfo {
  id: string;
  type: string;
  actor: string;
  beatIndex: number;
  placementMs: number;
  gainDb: number;
  renderedDurationMs: number;
  contact?: { propId?: string } | null;
}

export interface SceneSoundInfo {
  available: boolean;
  current: boolean;
  engine: string;
  durationMs: number | null;
  stems: Array<{ id: StemId; exists: boolean; bytes: number }>;
  foley: { count: number; events: FoleyEventInfo[] };
  ambience: { enabled: boolean; profile: string; levelDb: number };
  quality: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    targetIntegratedLufs: number | null;
    truePeakCeilingDbtp: number | null;
    loudnessPassed: boolean;
    truePeakPassed: boolean;
    passed: boolean;
    speakerLeveling: Array<{ speaker: string; measuredLufs: number; adjustmentDb: number; levelledLufs: number }>;
  } | null;
  guides: string[];
}

/** A flat field-by-field identity diff, from POST /api/show/compare. */
export interface ProfileDiff {
  path: string;
  a: unknown;
  b: unknown;
}
