import { Rng, deriveSeed } from '../core/rng.ts';
import { activeIdentity } from '../show/context.ts';
import { stampOf } from '../schema/identity.ts';
import type { LoadedRig } from '../cast/store.ts';
import {
  SHOTS,
  CAMERA_MOVES,
  MARKS,
  type Screenplay,
  type ShotList,
  type ShotBeat,
  type ShotCastMember,
  type Shot,
  type Mark,
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
  return { shots: SHOTS, cameraMoves: CAMERA_MOVES, marks: Object.keys(MARKS), characters };
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

function gestureFor(text: string, expression: string, rng: Rng): string {
  if (SHRUG_WORDS.test(text)) return 'SHRUG';
  if (POINT_WORDS.test(text)) return 'POINT';

  const words = text.split(/\s+/).length;
  // Stillness is funnier than gesticulating. A deadpan character delivering a
  // short line should just stand there.
  if (expression === 'DEADPAN' && words <= 8) return rng.chance(0.75) ? 'NONE' : 'TALK';
  if (words <= 4) return rng.chance(0.5) ? 'NONE' : 'TALK';
  return 'TALK';
}

/** Two characters face each other from the sides; a third takes centre. */
function assignMarks(names: string[]): Mark[] {
  if (names.length === 1) return ['CENTER'];
  if (names.length === 2) return ['SL', 'SR'];
  if (names.length === 3) return ['SL', 'CENTER', 'SR'];
  return names.map((_, i) => (['FAR_L', 'SL', 'CENTER', 'SR', 'FAR_R'] as Mark[])[i % 5]!);
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

  const marks = assignMarks(names);
  const midpoint = (names.length - 1) / 2;

  const cast: ShotCastMember[] = names.map((id, i) => ({
    id,
    rig: id,
    mark: marks[i]!,
    // Everyone turns toward the middle of the stage.
    flip: names.length > 1 && i > midpoint,
    scale: 1.25,
    resting,
  }));

  const beats: ShotBeat[] = [];
  let lastSpeaker: string | null = null;
  /** Who spoke before them — i.e. whoever is being spoken *to*. */
  let priorSpeaker: string | null = null;
  let sameSpeakerRun = 0;
  let lastShot: Shot | null = null;

  /** Everyone who isn't speaking, for reaction shots. */
  const others = (speaker: string) => names.filter((n) => n !== speaker);

  for (const el of screenplay.elements) {
    switch (el.kind) {
      case 'heading':
        // Headings set the location; with one set per scene there is nothing to
        // stage from them yet, but they stay in the screenplay for reference.
        break;

      case 'action': {
        const words = el.text.split(/\s+/).length;
        beats.push({
          kind: 'action',
          text: el.text,
          // Roughly reading speed, floored so a short beat still registers.
          ms: Math.max(900, Math.min(3200, words * 260)),
          shot: 'WIDE',
          focus: [],
          camera: 'HOLD',
          reactions: {},
        });
        lastShot = 'WIDE';
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
          (priorSpeaker && priorSpeaker !== lastSpeaker ? priorSpeaker : null) ??
          (lastSpeaker ? others(lastSpeaker)[0] : names[0]);
        beats.push({
          kind: 'pause',
          ms: el.ms,
          shot: el.ms >= 1200 ? 'CU' : 'MID',
          focus: target ? [target] : [],
          // A slow push on a long pause makes the awkwardness worse, correctly.
          camera: el.ms >= 1500 ? 'PUSH_IN' : 'HOLD',
          reactions: {},
        });
        lastShot = 'CU';
        break;
      }

      case 'dialogue': {
        // Every speaker is in `names` by construction — the cast is derived
        // from the same screenplay — and their rig was checked above.
        const speaker = el.speaker.toLowerCase();
        sameSpeakerRun = speaker === lastSpeaker ? sameSpeakerRun + 1 : 0;

        const expression = face(speaker, expressionFor(el.parenthetical, resting));
        const words = el.text.split(/\s+/).length;

        let shot: Shot;
        if (words <= 4) shot = 'CU';
        else if (words >= 22) shot = 'MID';
        else if (sameSpeakerRun >= 1 && lastShot === 'MID') shot = rng.chance(0.6) ? 'CU' : 'OTS';
        else if (names.length >= 2 && rng.chance(0.15)) shot = 'TWO_SHOT';
        else shot = 'MID';

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
          expression,
          gesture: gestureFor(el.text, expression, rng),
          shot,
          focus: shot === 'TWO_SHOT' ? [] : [speaker],
          camera: expression === 'ANGRY' && /!$/.test(el.text) ? 'SHAKE' : 'HOLD',
          reactions,
        });

        lastShot = shot;
        if (speaker !== lastSpeaker) priorSpeaker = lastSpeaker;
        lastSpeaker = speaker;
        break;
      }
    }
  }

  if (!beats.length) throw new Error('script produced no beats — is it empty?');

  return {
    scene: opts.scene,
    identity: stampOf(activeIdentity()),
    set: opts.set ?? null,
    fps: opts.fps ?? 24,
    characterFps: opts.characterFps ?? 12,
    seed,
    width: 1280,
    height: 720,
    cast,
    beats,
  };
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

  for (const member of shots.cast) {
    const caps = manifest.characters[member.rig];
    if (!caps) {
      errors.push(`cast member "${member.id}" uses rig "${member.rig}", which is not loaded`);
      continue;
    }
    if (!caps.expressions.includes(member.resting)) {
      errors.push(`"${member.id}" resting expression "${member.resting}" does not exist on rig "${member.rig}"`);
    }
  }

  const capsFor = (actorId: string) => {
    const member = shots.cast.find((c) => c.id === actorId);
    return member ? manifest.characters[member.rig] : undefined;
  };

  shots.beats.forEach((beat, i) => {
    const at = `beat ${i} (${beat.kind})`;

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
    }
  });

  return errors;
}
