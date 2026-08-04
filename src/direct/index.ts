import { Rng, deriveSeed } from '../core/rng.ts';
import { activeIdentity } from '../show/context.ts';
import { stampOf } from '../schema/identity.ts';
import type { LoadedRig } from '../cast/store.ts';
import {
  SHOTS,
  SHOT_PURPOSES,
  CAMERA_MOVES,
  MARKS,
  SUPPORTED_STAGE_ACTIONS,
  ShotList,
  type Screenplay,
  type ShotBeat,
  type ShotCastMember,
  type Shot,
  type ShotPurpose,
  type Mark,
  type StageAction,
  type StagePosition,
  type CapabilityManifest,
} from '../schema/script.ts';

/**
 * The director: screenplay -> shot list.
 *
 * This is the stage the plan flagged as least predictable, so its output is a
 * readable file you can edit and re-render rather than an internal
 * intermediate. What follows is a heuristic director — deterministic, free, and
 * good at exactly the kind of scene this engine is for: two people standing in
 * a room talking. An LLM adapter can be dropped in later; it writes the same
 * JSON and is validated against the same capability manifest.
 */

/** What the loaded cast can actually do. Anything not in here can't be directed. */
export function buildCapabilityManifest(rigs: Map<string, LoadedRig>): CapabilityManifest {
  const characters: CapabilityManifest['characters'] = {};
  for (const [name, { rig }] of rigs) {
    characters[name] = {
      expressions: rig.expressions.map((e) => e.name),
      poses: rig.poses.map((p) => p.name),
    };
  }
  return {
    shots: SHOTS,
    shotPurposes: SHOT_PURPOSES,
    cameraMoves: CAMERA_MOVES,
    marks: Object.keys(MARKS),
    stageActions: SUPPORTED_STAGE_ACTIONS,
    characters,
  };
}

/**
 * Parenthetical keywords to expressions.
 *
 * Longest match wins, so "not angry" doesn't trip the "angry" rule by accident
 * — checked against the whole parenthetical, lowercased.
 */
const EMOTION_WORDS: Array<[RegExp, string]> = [
  [/dead ?pan|flat|monotone|blank|no ?emotion|beat\b/, 'DEADPAN'],
  [/angry|annoyed|irritat|snap|furious|shout|yell|mad\b/, 'ANGRY'],
  [/shock|surpris|alarm|startl|horrifi|panic/, 'SHOCKED'],
  [/suspic|sceptic|skeptic|doubt|wary|dubious|unconvinced|side-?eye/, 'SUSPICIOUS'],
  [/smug|pleased|satisfi|smir|superior|proud/, 'SMUG'],
  [/exhaust|weary|drain|worn ?out|tired|hollow|beyond caring/, 'EXHAUSTED'],
  [/sad|defeat|deflat|quiet|small|resign|defl|miserab|glum/, 'SAD'],
  [/confus|puzzl|uncertain|lost|baffl|unsure/, 'CONFUSED'],
  [/delight|thrill|beam|grin|laugh|joy|gleeful|cheer|bright|happy|excited/, 'JOY'],
  [/warm|friendly|calm|even/, 'NEUTRAL'],
];

/**
 * Where to go when a rig lacks the expression a line asked for.
 *
 * A puppet drawn before an expression existed — or a hand-drawn one with a
 * deliberately small face set — should still get something in the spirit of the
 * line. Without this the compiler throws on a rig it has every right to accept,
 * which turns "I added a new expression" into "everyone's old characters are
 * broken".
 */
const EXPRESSION_FALLBACKS: Record<string, string[]> = {
  JOY: ['SMUG', 'NEUTRAL'],
  SUSPICIOUS: ['SMUG', 'CONFUSED', 'DEADPAN'],
  EXHAUSTED: ['SAD', 'DEADPAN'],
  SHOCKED: ['CONFUSED', 'NEUTRAL'],
  SMUG: ['NEUTRAL'],
  ANGRY: ['NEUTRAL'],
  SAD: ['DEADPAN', 'NEUTRAL'],
  CONFUSED: ['NEUTRAL'],
  DEADPAN: ['NEUTRAL'],
};

function expressionFor(parenthetical: string | null, fallback: string): string {
  if (!parenthetical) return fallback;
  const p = parenthetical.toLowerCase();
  for (const [re, expr] of EMOTION_WORDS) {
    if (re.test(p)) return expr;
  }
  return fallback;
}

/** Narrow a wanted expression to one the character can actually pull. */
function supportable(want: string, available: Set<string>, resting: string): string {
  if (available.has(want)) return want;
  for (const alt of EXPRESSION_FALLBACKS[want] ?? []) {
    if (available.has(alt)) return alt;
  }
  if (available.has(resting)) return resting;
  return [...available][0] ?? want;
}

const SHRUG_WORDS = /\b(i don'?t know|dunno|whatever|i guess|no idea|beats me|somehow)\b/i;
const POINT_WORDS = /\b(you'?re|you need|you have to|go ahead and|make sure|remember to|listen)\b/i;

interface GestureActingProfile {
  gestureBias: number;
  fidgetAmp: number;
}

const DEFAULT_GESTURE_ACTING: GestureActingProfile = { gestureBias: 1, fidgetAmp: 2 };
const GENERATED_GESTURE_HISTORY = 2;

/** Pick from the rig vocabulary without repeating the character's recent active choice. */
function freshGesture(
  wanted: readonly string[],
  available: ReadonlySet<string>,
  recent: readonly string[],
  rng: Rng,
): string {
  const supported = [...new Set(wanted)].filter((gesture) =>
    gesture === 'TALK' || gesture === 'NONE' || available.has(gesture));
  if (!supported.length) return 'TALK';

  const activeHistory = new Set(recent.slice(-GENERATED_GESTURE_HISTORY));
  let choices = supported.filter((gesture) => !activeHistory.has(gesture));
  // A small custom rig may exhaust the full history. Avoid an immediate repeat
  // before admitting an older one back into the pool.
  if (!choices.length) choices = supported.filter((gesture) => gesture !== recent.at(-1));
  if (!choices.length) choices = supported;
  return rng.pick(choices);
}

function gestureFor(
  text: string,
  expression: string,
  rng: Rng,
  available: ReadonlySet<string>,
  recent: readonly string[],
  acting: GestureActingProfile = DEFAULT_GESTURE_ACTING,
): string {
  if (SHRUG_WORDS.test(text)) {
    return freshGesture(['SHRUG', 'LEAN_IN', 'TALK'], available, recent, rng);
  }
  if (POINT_WORDS.test(text)) {
    return freshGesture(['POINT', 'LEAN_IN', 'TALK'], available, recent, rng);
  }

  const words = text.split(/\s+/).length;
  // Stillness is funnier than gesticulating. A deadpan character delivering a
  // short line should just stand there — but *how* still is the character's
  // own trait: a high gesture bias erodes the stand-there probabilities, a low
  // one raises them.
  const bias = acting.gestureBias;
  const fidget = acting.fidgetAmp;
  const still = (p: number) => Math.min(0.95, Math.max(0.05, p / bias + (2 - fidget) * 0.035));
  if (expression === 'DEADPAN' && words <= 8) return rng.chance(still(0.75)) ? 'NONE' : 'TALK';
  if (words <= 4) return rng.chance(still(0.5)) ? 'NONE' : 'TALK';
  const expressive: string[] = expression === 'ANGRY'
    ? ['LEAN_IN', 'POINT', 'ARMS_UP', 'TALK']
    : expression === 'SHOCKED'
      ? ['ARMS_UP', 'SHRUG', 'TALK', 'LEAN_IN']
      : expression === 'CONFUSED' || expression === 'SUSPICIOUS'
        ? ['SHRUG', 'LEAN_IN', 'TALK']
        : expression === 'JOY'
          ? ['ARMS_UP', 'LEAN_IN', 'TALK']
          : ['TALK', 'LEAN_IN'];

  const poseProbability = Math.min(0.9, Math.max(0.12,
    0.28 + (bias - 1) * 0.45 + (fidget - 2) * 0.07));
  const candidates = rng.chance(poseProbability)
    ? expressive
    : ['TALK', 'NONE', 'LEAN_IN'];
  return freshGesture(candidates, available, recent, rng);
}

/** Two characters face each other from the sides; a third takes centre. */
function assignMarks(names: string[]): Mark[] {
  if (names.length === 1) return ['CENTER'];
  if (names.length === 2) return ['SL', 'SR'];
  if (names.length === 3) return ['SL', 'CENTER', 'SR'];
  return names.map((_, i) => (['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R'] as Mark[])[i % 5]!);
}

interface ParsedStageActions {
  stage: StageAction[];
  unsupported: string[];
}

/** Physical geography needs context; contained acting needs the performer. */
function actionCoverage(actions: ParsedStageActions): { shot: Shot; focus: string[] } {
  const actors = [...new Set(actions.stage.map((action) => action.actor))];
  const spatial = actions.stage.some((action) =>
    action.type === 'enter' || action.type === 'exit' || action.type === 'move' ||
    action.type === 'sit' || action.type === 'stand');
  if (actions.unsupported.length || spatial || actors.length !== 1) {
    return { shot: 'WIDE', focus: [] };
  }
  return { shot: 'MID', focus: [actors[0]!] };
}

type StageActionType = StageAction['type'];

const ACTION_PATTERNS: Array<{ type: StageActionType; re: RegExp }> = [
  { type: 'enter', re: /\b(?:enters?|arrives?|comes? in|walks? in)\b/gi },
  { type: 'exit', re: /\b(?:exits?|leaves?|walks? out)\b/gi },
  { type: 'sit', re: /\b(?:sits? down|sits?)\b/gi },
  { type: 'stand', re: /\b(?:stands? up|stands?)\b/gi },
  { type: 'look', re: /\b(?:looks?|glances?|stares?)\b/gi },
  { type: 'turn', re: /\bturns?\b/gi },
  { type: 'reach', re: /\breaches?\b/gi },
  { type: 'pick_up', re: /\b(?:picks? up|grabs?|takes?|retrieves?)\b/gi },
  { type: 'put_down', re: /\b(?:puts? down|sets? down|places?)\b/gi },
  { type: 'tap', re: /\b(?:taps?|knocks?)\b/gi },
  // Keep generic movement last so "walks in/out" is claimed by enter/exit.
  { type: 'move', re: /\b(?:approaches?|crosses?|moves?|walks?|goes?)\b(?!\s+(?:in|out)\b)/gi },
];

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actorMentions(text: string, names: string[]): Array<{ actor: string; index: number }> {
  const mentions: Array<{ actor: string; index: number }> = [];
  for (const actor of names) {
    const re = new RegExp(`\\b${escapeRe(actor)}\\b`, 'gi');
    for (const match of text.matchAll(re)) mentions.push({ actor, index: match.index ?? 0 });
  }
  return mentions.sort((a, b) => a.index - b.index || a.actor.localeCompare(b.actor));
}

function directionIn(text: string): 'left' | 'right' | 'front' | undefined {
  if (/\b(?:front|forward|camera)\b/i.test(text)) return 'front';
  if (/\b(?:stage\s+)?left\b/i.test(text)) return 'left';
  if (/\b(?:stage\s+)?right\b/i.test(text)) return 'right';
  return undefined;
}

function markIn(text: string): Mark | undefined {
  if (/\bfar\s+left\b/i.test(text)) return 'FAR_L';
  if (/\bfar\s+right\b/i.test(text)) return 'FAR_R';
  if (/\b(?:centre|center|middle)\b/i.test(text)) return 'CENTER';
  if (/\bleft\b/i.test(text)) return 'SL';
  if (/\bright\b/i.test(text)) return 'SR';
  return undefined;
}

function coordinatesIn(text: string): StagePosition | undefined {
  const pair = text.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (pair) return { x: Number(pair[1]), y: Number(pair[2]) };
  const x = text.match(/\bx\s*=?\s*(-?\d+(?:\.\d+)?)/i);
  const y = text.match(/\by\s*=?\s*(-?\d+(?:\.\d+)?)/i);
  const depth = text.match(/\bdepth\s*=?\s*(-?\d+(?:\.\d+)?)/i);
  if (!x && !y && !depth) return undefined;
  return {
    ...(x ? { x: Number(x[1]) } : {}),
    ...(y ? { y: Number(y[1]) } : {}),
    ...(depth ? { depth: Number(depth[1]) } : {}),
  };
}

function objectIn(tail: string): string {
  const cleaned = tail
    .replace(/^\s*(?:(?:at|for|toward|towards|to|in|into|the|a|an|his|her|their|down|up|on)\s+)+/i, '')
    .split(/[.,;!?]/, 1)[0]!
    // Placement language describes where the object goes, not part of its
    // identity. "puts down the mug on the desk" must still resolve `mug`.
    .split(/\s+\b(?:on|onto|at|beside|near|by)\b\s+/i, 1)[0]!
    .replace(/\b(?:twice|three times|once)\b.*$/i, '')
    .trim();
  return cleaned.split(/\s+/).slice(0, 5).join(' ') || 'object';
}

function seatingIn(tail: string): Pick<Extract<StageAction, { type: 'sit' }>, 'seat' | 'floor'> {
  if (/\b(?:floor|ground)\b/i.test(tail)) return { floor: true };
  if (!/\b(?:in|into|on|at)\b/i.test(tail)) return {};
  const seat = objectIn(tail);
  return seat === 'object' ? {} : { seat };
}

function placementTargetIn(tail: string): string | undefined {
  const match = tail.match(/\b(?:on|onto|at)\s+(.+?)(?=\s+(?:and|then)\b|[.,;!?]|$)/i);
  if (!match?.[1]) return undefined;
  const target = objectIn(match[1]);
  return target === 'object' ? undefined : target;
}

/**
 * Deterministically lower obvious screenplay prose into structured stage
 * actions. It is deliberately conservative: anything it cannot name becomes a
 * preflight error rather than an invented physical performance.
 */
export function stageActionsFor(
  text: string,
  names: string[],
  marks: Map<string, Mark>,
  defaultActor: string | null = null,
): ParsedStageActions {
  const mentions = actorMentions(text, names);
  const matches: Array<{ type: StageActionType; index: number; length: number }> = [];

  for (const spec of ACTION_PATTERNS) {
    spec.re.lastIndex = 0;
    for (const match of text.matchAll(spec.re)) {
      matches.push({ type: spec.type, index: match.index ?? 0, length: match[0]!.length });
    }
  }
  matches.sort((a, b) => a.index - b.index || ACTION_PATTERNS.findIndex((p) => p.type === a.type) - ACTION_PATTERNS.findIndex((p) => p.type === b.type));

  // An enter/exit expression owns "walks in/out" at the same position.
  const claimed = new Set<number>();
  const unique = matches.filter((m) => {
    const key = m.index;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });

  if (!unique.length) return { stage: [], unsupported: [text] };

  const stage: StageAction[] = [];
  const unsupported: string[] = [];
  for (let i = 0; i < unique.length; i++) {
    const match = unique[i]!;
    const prior = mentions.filter((m) => m.index <= match.index).at(-1);
    const actor = prior?.actor ?? defaultActor;
    if (!actor) {
      unsupported.push(`Cannot identify who performs: ${text}`);
      continue;
    }

    const nextAt = unique[i + 1]?.index ?? text.length;
    const tail = text.slice(match.index + match.length, nextAt);
    const targetActor = actorMentions(tail, names).find((m) => m.actor !== actor)?.actor;
    const direction = directionIn(tail);

    switch (match.type) {
      case 'enter':
        stage.push({ type: 'enter', actor, to: { mark: marks.get(actor) ?? 'CENTER' } });
        break;
      case 'exit':
        stage.push({ type: 'exit', actor });
        break;
      case 'move': {
        const coordinates = coordinatesIn(tail);
        const toward = targetActor ? marks.get(targetActor) : undefined;
        const current = marks.get(actor) ?? 'CENTER';
        const mark = markIn(tail) ?? toward ?? (current === 'CENTER' ? 'SL' : 'CENTER');
        stage.push({ type: 'move', actor, to: coordinates ?? { mark } });
        if (!coordinates) marks.set(actor, mark);
        break;
      }
      case 'sit':
        stage.push({ type: 'sit', actor, ...seatingIn(tail) });
        break;
      case 'stand':
        stage.push({ type: 'stand', actor });
        break;
      case 'look':
      case 'turn':
        if (targetActor) stage.push({ type: match.type, actor, target: targetActor });
        else if (direction) stage.push({ type: match.type, actor, direction });
        else unsupported.push(`Cannot resolve what ${actor} ${match.type}s toward: ${text}`);
        break;
      case 'reach':
        stage.push({ type: 'reach', actor, target: objectIn(tail) });
        break;
      case 'pick_up':
        stage.push({ type: 'pick_up', actor, prop: objectIn(tail) });
        break;
      case 'put_down': {
        const to = coordinatesIn(tail);
        const target = to ? undefined : placementTargetIn(tail);
        stage.push({
          type: 'put_down',
          actor,
          prop: objectIn(tail),
          ...(target ? { target } : {}),
          ...(to ? { to } : {}),
        });
        break;
      }
      case 'tap':
        stage.push({
          type: 'tap',
          actor,
          target: objectIn(tail),
          count: /\b(?:twice|two times)\b/i.test(tail) ? 2 : /\bthree times\b/i.test(tail) ? 3 : 1,
        });
        break;
    }
  }

  return { stage, unsupported };
}

/** Three beats is enough to feel intentional without turning coverage inert. */
export const COVERAGE_RUN_MAX_BEATS = 3;
/**
 * The longest line that may play off-camera as a reaction inside a focused
 * run. Four words is the same terseness the CU-rally rule uses: a quip reads
 * as a beat for the listener's face, while anything longer is content — an
 * audience that cannot see the speaker of a substantial line experiences a
 * missing cut, not a stylish hold.
 */
export const REACTION_MAX_WORDS = 4;
/** Ordinary coverage cannot recrop again before the current framing has lived. */
export const SHOT_CHANGE_COOLDOWN_BEATS = 2;
/** Different signature moves also need air between them. */
export const SIGNATURE_MOVE_GLOBAL_COOLDOWN_BEATS = 2;

const SPECIAL_SHOT_COOLDOWN_BEATS = 4;
const SHAKE_COOLDOWN_BEATS = 5;
const PUSH_COOLDOWN_BEATS = 5;
const MAX_SHAKES_PER_SCENE = 1;
const MAX_PUSHES_PER_SCENE = 2;
const REVEAL_WORDS = /\b(?:actually|except|turns? out|the truth is|the problem is|but here'?s|one more thing)\b/i;
const MOTIVATED_CUT_PURPOSES = new Set<ShotPurpose>(['reaction', 'action', 'emphasis', 'button']);

type LineBeat = Extract<ShotBeat, { kind: 'line' }>;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function lineIsEmphasis(beat: LineBeat): boolean {
  return beat.expression === 'ANGRY' || beat.expression === 'SHOCKED' || REVEAL_WORDS.test(beat.text);
}

/** Partition coverage without leaving a one-beat tail that would cause a junk cut. */
function coverageRunSizes(count: number): number[] {
  if (count <= 0) return [];
  const out: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    let size = Math.min(COVERAGE_RUN_MAX_BEATS, remaining);
    if (remaining - size === 1 && size > 1) size--;
    out.push(size);
    remaining -= size;
  }
  if (out.length > 1 && out.at(-1) === 1) {
    out[out.length - 2] = out[out.length - 2]! + 1;
    out.pop();
  }
  return out;
}

function framingSignature(beat: ShotBeat): string {
  return `${beat.shot}|${[...beat.focus].sort().join(',')}`;
}

/**
 * Plan coverage in short runs rather than picking a fresh crop for every line.
 * Ensemble and focused coverage alternate by run; a focused run deliberately
 * stays on one performer while the other replies, giving reactions somewhere
 * to live instead of mechanically chasing whoever is speaking.
 *
 * One visibility rule outranks the rhythm: only a quip may play off-camera.
 * A focused run holds on the group's *dominant* speaker, and if anyone else
 * in the group has a line past REACTION_MAX_WORDS the whole group falls back
 * to ensemble framing — the audience never watches a listener while
 * substantial dialogue happens somewhere off-screen.
 */
function planDialogueShotRuns(beats: ShotBeat[], names: string[], pingPongCu: boolean): void {
  let seenDialogue = false;
  let coverageRun = 0;
  let lastSpecialShotAt = -Infinity;

  for (let start = 0; start < beats.length;) {
    if (beats[start]!.kind !== 'line') {
      start++;
      continue;
    }
    let end = start;
    while (end < beats.length && beats[end]!.kind === 'line') end++;

    const rally = new Set<number>();
    if (pingPongCu) {
      for (let cursor = start; cursor < end;) {
        if (wordCount((beats[cursor] as LineBeat).text) > 4) {
          cursor++;
          continue;
        }
        let runEnd = cursor;
        while (runEnd < end && wordCount((beats[runEnd] as LineBeat).text) <= 4) runEnd++;
        // The first terse line establishes the rally; the answering cuts are
        // its motivated rhythm. Two isolated short lines stay in coverage.
        if (runEnd - cursor >= 3) {
          for (let i = cursor + 1; i < runEnd; i++) rally.add(i);
        }
        cursor = runEnd;
      }
    }

    let cursor = start;
    while (cursor < end) {
      const beat = beats[cursor] as LineBeat;
      if (lineIsEmphasis(beat)) {
        beat.purpose = 'emphasis';
        beat.shot = cursor - lastSpecialShotAt >= SPECIAL_SHOT_COOLDOWN_BEATS ? 'ECU' : 'CU';
        if (beat.shot === 'ECU') lastSpecialShotAt = cursor;
        beat.focus = [beat.speaker];
        seenDialogue = true;
        cursor++;
        continue;
      }
      if (rally.has(cursor)) {
        beat.purpose = 'button';
        beat.shot = 'CU';
        beat.focus = [beat.speaker];
        seenDialogue = true;
        cursor++;
        continue;
      }

      const ordinary: LineBeat[] = [];
      while (cursor < end) {
        const candidate = beats[cursor] as LineBeat;
        if (lineIsEmphasis(candidate) || rally.has(cursor)) break;
        ordinary.push(candidate);
        cursor++;
      }

      let offset = 0;
      for (const size of coverageRunSizes(ordinary.length)) {
        const group = ordinary.slice(offset, offset + size);
        let ensemble = names.length > 1 && coverageRun % 2 === 0;
        let focus: string[] = [];

        if (!ensemble) {
          // The held single belongs to whoever carries the group, not to
          // whoever happens to speak first in it.
          const spoken = new Map<string, number>();
          for (const line of group) {
            spoken.set(line.speaker, (spoken.get(line.speaker) ?? 0) + wordCount(line.text));
          }
          const dominant = [...spoken.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
          const substantialOffCamera = group.some(
            (line) => line.speaker !== dominant && wordCount(line.text) > REACTION_MAX_WORDS,
          );
          if (substantialOffCamera && names.length > 1) ensemble = true;
          else focus = [dominant];
        }

        const shot: Shot = ensemble
          ? (names.length === 2 ? 'TWO_SHOT' : 'WIDE')
          : 'MID';
        if (ensemble) focus = [];
        for (let i = 0; i < group.length; i++) {
          const line = group[i]!;
          line.purpose = !seenDialogue && i === 0 ? 'establishing' : 'coverage';
          line.shot = shot;
          line.focus = focus;
          seenDialogue = true;
        }
        coverageRun++;
        offset += size;
      }
    }
    start = end;
  }

  // A final guard for future heuristics: ordinary framing cannot change again
  // before the existing shot has survived the minimum run. Motivated cuts are
  // exempt by definition.
  let activeSignature: string | null = null;
  let activeRun = 0;
  let previous: ShotBeat | null = null;
  for (const beat of beats) {
    const signature = framingSignature(beat);
    if (activeSignature === null || signature === activeSignature) {
      activeSignature = signature;
      activeRun++;
      previous = beat;
      continue;
    }
    const motivated = MOTIVATED_CUT_PURPOSES.has(beat.purpose) ||
      (previous !== null && MOTIVATED_CUT_PURPOSES.has(previous.purpose));
    if (!motivated && activeRun < SHOT_CHANGE_COOLDOWN_BEATS && previous) {
      beat.shot = previous.shot;
      beat.focus = [...previous.focus];
      activeRun++;
    } else {
      activeSignature = framingSignature(beat);
      activeRun = 1;
    }
    previous = beat;
  }
}

function planCameraPunctuation(
  beats: ShotBeat[],
  snap: { enabled: boolean; cooldownBeats: number; maxPerScene: number },
): void {
  const lastUsed = new Map<ShotBeat['camera'], number>();
  const uses = new Map<ShotBeat['camera'], number>();
  let lastSignatureAt = -Infinity;

  const allowed = (
    move: ShotBeat['camera'],
    at: number,
    cooldown: number,
    maximum: number,
  ): boolean => (
    (uses.get(move) ?? 0) < maximum &&
    at - (lastUsed.get(move) ?? -Infinity) >= cooldown &&
    at - lastSignatureAt >= SIGNATURE_MOVE_GLOBAL_COOLDOWN_BEATS
  );

  const use = (move: ShotBeat['camera'], at: number): void => {
    beats[at]!.camera = move;
    uses.set(move, (uses.get(move) ?? 0) + 1);
    lastUsed.set(move, at);
    lastSignatureAt = at;
  };

  for (const beat of beats) beat.camera = 'HOLD';
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!;
    if (beat.kind === 'line' && beat.purpose === 'emphasis') {
      if (
        beat.expression === 'ANGRY' && /!\s*$/.test(beat.text) &&
        allowed('SHAKE', i, SHAKE_COOLDOWN_BEATS, MAX_SHAKES_PER_SCENE)
      ) {
        use('SHAKE', i);
      } else if (
        snap.enabled && beat.expression === 'SHOCKED' && /[!?]\s*$/.test(beat.text) &&
        allowed('SNAP_IN', i, snap.cooldownBeats, snap.maxPerScene)
      ) {
        use('SNAP_IN', i);
      }
      continue;
    }
    if (beat.kind !== 'pause' || beat.purpose !== 'reaction') continue;
    const before = i > 0 && beats[i - 1]!.kind === 'line' ? beats[i - 1] as LineBeat : null;
    const aftershock = before?.expression === 'ANGRY' || before?.expression === 'SHOCKED';
    const meaningfulHold = aftershock || beat.ms >= 1800;
    if (meaningfulHold && allowed('PUSH_IN', i, PUSH_COOLDOWN_BEATS, MAX_PUSHES_PER_SCENE)) {
      use('PUSH_IN', i);
    }
  }
}

export interface DirectOptions {
  scene: string;
  seed?: number;
  fps?: number;
  characterFps?: number;
  /** Baseline expression when a line carries no parenthetical. */
  resting?: string;
  set?: string | null;
}

export function autoDirect(
  screenplay: Screenplay,
  rigs: Map<string, LoadedRig>,
  opts: DirectOptions,
): ShotList {
  const seed = opts.seed ?? 7;
  const rng = new Rng(deriveSeed(seed, 'director'));
  // The baseline face comes from the show, not from a hardcoded engine
  // preference — a warm show and a deadpan show differ here before any
  // parenthetical is written.
  const resting = opts.resting ?? activeIdentity().performance.restingExpression;

  const names = screenplay.characters.map((c) => c.toLowerCase());

  // Fail here, naming the character, rather than letting a shot list that
  // references a nonexistent rig fall through to a vaguer error downstream.
  const missing = names.filter((n) => !rigs.has(n));
  if (missing.length) {
    throw new Error(
      `script names ${missing.map((m) => `"${m}"`).join(', ')} but no rig is loaded for them. ` +
        `Loaded: ${[...rigs.keys()].join(', ') || '(none)'}. Create one with: anim cast new ${missing[0]}`,
    );
  }

  // What each character's face can actually do. Every expression the director
  // chooses is put through this, so a shot list can never name a state its own
  // puppet doesn't have.
  const faces = new Map<string, Set<string>>(
    names.map((n) => [n, new Set(rigs.get(n)!.rig.expressions.map((e) => e.name))]),
  );
  const face = (who: string, want: string) => supportable(want, faces.get(who) ?? new Set(), resting);
  const poses = new Map<string, Set<string>>(
    names.map((n) => [n, new Set(rigs.get(n)!.rig.poses.map((pose) => pose.name))]),
  );
  // A character owns both the RNG stream and recent history for their acting.
  // Adding a new cast member or intercutting another speaker therefore cannot
  // reshuffle gestures already chosen for this performer.
  const gestureRngs = new Map(names.map((name) => {
    const rig = rigs.get(name)!.rig;
    return [name, new Rng(deriveSeed(seed, `gesture:${rig.charId ?? name}`))] as const;
  }));
  const gestureHistory = new Map(names.map((name) => [name, [] as string[]] as const));

  const marks = assignMarks(names);
  const midpoint = (names.length - 1) / 2;

  const cast: ShotCastMember[] = names.map((id, i) => ({
    id,
    rig: id,
    mark: marks[i]!,
    // Everyone turns toward the middle of the stage.
    flip: names.length > 1 && i > midpoint,
    scale: 1.25,
    visible: true,
    position: null,
    depth: 0,
    pose: 'IDLE',
    seat: null,
    heldProp: null,
    heldHand: null,
    resting,
  }));
  /** Mutable authored mark while obvious move actions are lowered. */
  const authoredMarks = new Map(cast.map((member) => [member.id, member.mark]));
  /** Actors seen before an ENTER; used to derive correct initial visibility. */
  const appeared = new Set<string>();
  /** Visibility after the most recently directed stage action. */
  const visibleNow = new Set(names);

  const beats: ShotBeat[] = [];
  let lastSpeaker: string | null = null;
  /** Who spoke before them — i.e. whoever is being spoken *to*. */
  let priorSpeaker: string | null = null;
  /** The profile supplies SNAP_IN's quota; the sequence planner enforces it. */
  const snap = activeIdentity().editorial.snapIn;
  const rhythm = activeIdentity().editorial.rhythm;
  /** The expression of the previous line beat, for the aftershock pause. */
  let lastLineExpression: string | null = null;
  /** On-screen listeners only; exited cast must not receive reaction coverage. */
  const others = (speaker: string) => names.filter((n) => n !== speaker && visibleNow.has(n));

  for (const el of screenplay.elements) {
    switch (el.kind) {
      case 'heading':
        // Headings set the location; with one set per scene there is nothing to
        // stage from them yet, but they stay in the screenplay for reference.
        break;

      case 'action': {
        const words = el.text.split(/\s+/).length;
        const parsed = stageActionsFor(el.text, names, authoredMarks, lastSpeaker);
        const coverage = actionCoverage(parsed);
        for (const action of parsed.stage) {
          if (action.type === 'enter' && !appeared.has(action.actor)) {
            const member = cast.find((c) => c.id === action.actor);
            if (member) member.visible = false;
          }
          if (action.type === 'enter') visibleNow.add(action.actor);
          if (action.type === 'exit') visibleNow.delete(action.actor);
          appeared.add(action.actor);
        }
        beats.push({
          kind: 'action',
          text: el.text,
          purpose: 'action',
          // Roughly reading speed, floored so a short beat still registers.
          ms: Math.max(900, Math.min(3200, words * 260)),
          shot: coverage.shot,
          focus: coverage.focus,
          camera: 'HOLD',
          stage: parsed.stage,
          unsupported: parsed.unsupported,
          reactions: {},
          locked: false,
        });
        lastLineExpression = null;
        break;
      }

      case 'beat': {
        // The reaction shot. Cutting to whoever is *not* talking during a pause
        // is the single most useful move in this style — the silence only plays
        // if you can see it land on someone.
        //
        // Which someone matters once there are more than two people in the
        // room. The person being spoken *to* is the one who spoke immediately
        // before the current speaker, so prefer them; picking any non-speaker
        // lands the reaction on a bystander instead of on the target.
        const target =
          (priorSpeaker && priorSpeaker !== lastSpeaker && visibleNow.has(priorSpeaker) ? priorSpeaker : null) ??
          (lastSpeaker ? (others(lastSpeaker)[0] ?? (visibleNow.has(lastSpeaker) ? lastSpeaker : null)) : names.find((name) => visibleNow.has(name)));

        // The aftershock: a pause following a loud line stretches, and the
        // camera goes to whoever the line landed on. The silence after the
        // shout is where the shout actually happens.
        const aftershock = lastLineExpression === 'ANGRY' || lastLineExpression === 'SHOCKED';
        const ms = aftershock ? Math.round(el.ms * rhythm.aftershockBoost) : el.ms;

        beats.push({
          kind: 'pause',
          ms,
          purpose: 'reaction',
          shot: aftershock || ms >= 1200 ? 'CU' : 'MID',
          focus: target ? [target] : [],
          // Signature moves are planned across the whole sequence below.
          camera: 'HOLD',
          reactions: {},
          locked: false,
        });
        lastLineExpression = null;
        break;
      }

      case 'dialogue': {
        // Every speaker is in `names` by construction — the cast is derived
        // from the same screenplay — and their rig was checked above.
        const speaker = el.speaker.toLowerCase();
        appeared.add(speaker);

        const expression = face(speaker, expressionFor(el.parenthetical, resting));
        const recentGestures = gestureHistory.get(speaker)!;
        const acting = rigs.get(speaker)!.rig.acting ?? DEFAULT_GESTURE_ACTING;
        const gesture = gestureFor(
          el.text,
          expression,
          gestureRngs.get(speaker)!,
          poses.get(speaker)!,
          recentGestures,
          acting,
        );
        recentGestures.push(gesture);
        if (recentGestures.length > GENERATED_GESTURE_HISTORY) recentGestures.shift();

        // Framing waits until every beat exists so this line participates in a
        // planned run instead of making an isolated crop decision here.

        // Reactions: the listener holds the baseline unless the line is loud,
        // in which case they get something to do about it.
        const reactions: Record<string, string> = {};
        for (const other of others(speaker)) {
          let want: string;
          if (expression === 'ANGRY') want = rng.chance(0.6) ? 'SHOCKED' : 'SAD';
          else if (expression === 'JOY') want = rng.chance(0.5) ? 'SUSPICIOUS' : resting;
          else if (/\?$/.test(el.text)) want = rng.chance(0.5) ? 'CONFUSED' : resting;
          else want = resting;
          reactions[other] = face(other, want);
        }

        beats.push({
          kind: 'line',
          speaker,
          text: el.text,
          purpose: expression === 'ANGRY' || expression === 'SHOCKED' || REVEAL_WORDS.test(el.text)
            ? 'emphasis'
            : 'coverage',
          expression,
          gesture,
          // Placeholder coverage; the sequence planner below owns the cut.
          shot: 'MID',
          focus: [speaker],
          camera: 'HOLD',
          reactions,
          locked: false,
        });

        lastLineExpression = expression;
        if (speaker !== lastSpeaker) priorSpeaker = lastSpeaker;
        lastSpeaker = speaker;
        break;
      }
    }
  }

  if (!beats.length) throw new Error('script produced no beats — is it empty?');

  planDialogueShotRuns(beats, names, rhythm.pingPongCu);
  planCameraPunctuation(beats, snap);

  return ShotList.parse({
    scene: opts.scene,
    identity: stampOf(activeIdentity()),
    cards: true,
    // The screenplay's own words: its title on the card, the first heading as
    // the subtitle. Both editable in the shot list afterwards.
    title: screenplay.title || opts.scene.replace(/-/g, ' '),
    subtitle: screenplay.elements.find((e) => e.kind === 'heading')?.text ?? null,
    set: opts.set ?? null,
    fps: opts.fps ?? 24,
    characterFps: opts.characterFps ?? 12,
    seed,
    width: 1280,
    height: 720,
    cast,
    beats,
  });
}

/**
 * Check a shot list against what the rigs can actually do.
 *
 * This is what makes the director stage safe to hand to an LLM later: whatever
 * writes the shot list, nothing renders until every expression, pose, mark and
 * shot in it is known to exist.
 */
export function validateShotList(shots: ShotList, manifest: CapabilityManifest): string[] {
  const errors: string[] = [];
  const ids = new Set(shots.cast.map((c) => c.id));
  const beatIds = new Set<string>();
  const visible = new Map(shots.cast.map((c) => [c.id, c.visible]));

  for (const member of shots.cast) {
    const caps = manifest.characters[member.rig];
    if (!caps) {
      errors.push(`cast member "${member.id}" uses rig "${member.rig}", which is not loaded`);
      continue;
    }
    if (!caps.expressions.includes(member.resting)) {
      errors.push(`"${member.id}" resting expression "${member.resting}" does not exist on rig "${member.rig}"`);
    }
    if (member.pose === 'SIT') {
      if (!member.seat) errors.push(`"${member.id}" starts in SIT without an initial seat target`);
    } else if (member.seat) {
      errors.push(`"${member.id}" has initial seat "${member.seat}" but pose "${member.pose}" is not SIT`);
    } else if (!caps.poses.includes(member.pose)) {
      errors.push(`"${member.id}" initial pose "${member.pose}" does not exist on rig "${member.rig}"`);
    }
  }

  const capsFor = (actorId: string) => {
    const member = shots.cast.find((c) => c.id === actorId);
    return member ? manifest.characters[member.rig] : undefined;
  };

  shots.beats.forEach((beat, i) => {
    const at = `beat ${i} (${beat.kind})`;

    if (beatIds.has(beat.id)) errors.push(`${at} repeats beat id "${beat.id}"`);
    beatIds.add(beat.id);

    for (const actor of beat.focus) {
      if (!ids.has(actor)) errors.push(`${at} focuses on "${actor}", who is not in the cast`);
    }

    for (const [actor, expr] of Object.entries(beat.reactions)) {
      const caps = capsFor(actor);
      if (!caps) errors.push(`${at} reaction for "${actor}", who is not in the cast`);
      else if (!caps.expressions.includes(expr)) {
        errors.push(`${at} reaction "${expr}" does not exist on "${actor}"`);
      }
    }

    if (beat.kind === 'line') {
      const caps = capsFor(beat.speaker);
      if (!caps) {
        errors.push(`${at} is spoken by "${beat.speaker}", who is not in the cast`);
      } else {
        if (!caps.expressions.includes(beat.expression)) {
          errors.push(`${at} expression "${beat.expression}" does not exist on "${beat.speaker}"`);
        }
        // TALK and NONE are compiler concepts, not poses on the rig.
        if (beat.gesture !== 'NONE' && beat.gesture !== 'TALK' && !caps.poses.includes(beat.gesture)) {
          errors.push(`${at} gesture "${beat.gesture}" is not a pose on "${beat.speaker}"`);
        }
      }
      if (visible.get(beat.speaker) === false) {
        errors.push(`${at} is spoken by hidden actor "${beat.speaker}"; add ENTER before the line`);
      }
    }

    if (beat.kind === 'action') {
      for (const note of beat.unsupported) errors.push(`${at} has unsupported action: ${note}`);
      if (!beat.stage.length && !beat.unsupported.length) {
        errors.push(`${at} has prose but no structured stage action; direct or annotate it before rendering`);
      }

      const maxFrames = Math.max(1, Math.round((beat.ms / 1000) * shots.fps));
      for (const action of beat.stage) {
        const actionAt = `${at} ${action.type.toUpperCase()}`;
        if (!ids.has(action.actor)) {
          errors.push(`${actionAt} references "${action.actor}", who is not in the cast`);
          continue;
        }
        if (action.durationFrames && action.durationFrames > maxFrames) {
          errors.push(`${actionAt} lasts ${action.durationFrames} frames but its beat has only ${maxFrames}`);
        }

        if ((action.type === 'look' || action.type === 'turn')) {
          if (!action.target && !action.direction) {
            errors.push(`${actionAt} needs a cast target or direction`);
          } else if (action.target && !ids.has(action.target)) {
            errors.push(`${actionAt} targets "${action.target}", who is not in the cast`);
          }
        }

        if (action.type === 'sit') {
          if (action.seat && action.floor) {
            errors.push(`${actionAt} cannot target both seat "${action.seat}" and the floor`);
          } else if (!action.seat && !action.floor) {
            errors.push(`${actionAt} needs an explicit seat target or floor=true`);
          }
        }

        if (!manifest.stageActions.includes(action.type)) {
          errors.push(
            `${actionAt} is understood but not renderable yet; replace it or add a renderer capability`,
          );
          continue;
        }

        const isVisible = visible.get(action.actor) ?? true;
        if (action.type === 'enter') {
          if (isVisible) errors.push(`${actionAt} tries to enter while already visible`);
          visible.set(action.actor, true);
        } else if (action.type === 'exit') {
          if (!isVisible) errors.push(`${actionAt} tries to exit while already hidden`);
          visible.set(action.actor, false);
        } else if (!isVisible) {
          errors.push(`${actionAt} acts while hidden; add ENTER first`);
        }
      }
    }
  });

  return errors;
}
