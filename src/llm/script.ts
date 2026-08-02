import { Ollama } from './ollama.ts';
import { parseScript } from '../parse/index.ts';
import { activeIdentity } from '../show/context.ts';
import type { ShowIdentity } from '../schema/identity.ts';

/**
 * Premise -> script.
 *
 * The constraints in the prompt matter more than they look. This engine
 * animates people standing in a room talking; ask it for a car chase and you
 * get two people *describing* a car chase. Writing to what it does well is the
 * difference between a scene that plays and one that doesn't.
 *
 * The *voice* of the writing — register and pacing — comes from the show's
 * identity profile, in the show's own words. Deliberately never "write like
 * <existing show>": imitation prompts produce imitation, and the profile is
 * where a show states what it actually is.
 */

function systemPrompt(identity: ShowIdentity): string {
  const register = identity.performance.register.map((r) => `- ${r}`).join('\n');
  const pacing = identity.editorial.pacing.map((r) => `- ${r}`).join('\n');

  return `You write short scripts for a limited-animation engine.

FORMAT — output the script and nothing else. No preamble, no commentary, no code fences.

  # TITLE                    once, at the top
  INT. PLACE - TIME          scene heading
  NAME                       character cue: ALL CAPS, alone on its line
  (deadpan)                  parenthetical, directly under a cue
  Dialogue goes here.        the line itself
  [BEAT 1200]                a pause, in milliseconds
  Plain prose lines          action

PARENTHETICALS drive both the drawn face and the vocal performance, so put one on
most lines. They are matched by keyword — use these:
  deadpan, flat, monotone, blank
  exhausted, weary, drained
  sad, defeated, deflated, quiet
  suspicious, sceptical, doubtful
  confused, puzzled, unsure
  warm, friendly, calm
  smug, pleased, satisfied
  delighted, grinning, excited
  angry, annoyed, irritated, snaps
  shocked, surprised, alarmed

THE SHOW'S REGISTER — every line obeys these:
${register || '- Plain, natural dialogue.'}

PACING:
${pacing || '- Use [BEAT ...] where a pause serves the scene.'}
- Use [BEAT ...] liberally and vary the lengths, 800 to 2000.

HARD CONSTRAINTS (engine limits, not style):
- The characters can only stand in one room and talk. No action, no props being
  handled, no movement between places, no physical comedy. If something happens,
  a character mentions it.
- Everyone stays in the room for the whole scene.`;
}

export interface WriteOptions {
  premise: string;
  model: string;
  /** Rough target; the model is told, not forced. */
  characters?: number;
  targetSeconds?: number;
  host?: string;
}

export interface WriteResult {
  source: string;
  characters: string[];
  lineCount: number;
  attempts: number;
}

function buildPrompt(opts: WriteOptions, correction?: string): string {
  const chars = opts.characters ?? 2;
  const secs = opts.targetSeconds ?? 75;
  // Roughly measured against Chatterbox: ~2.7 words/sec, plus beats.
  const lines = Math.max(8, Math.round(secs / 3.5));

  let prompt = `PREMISE: ${opts.premise}

Write the scene. ${chars} characters. About ${lines} lines of dialogue, aiming for
roughly ${secs} seconds of screen time. Give the characters ordinary, unremarkable
names.`;

  if (correction) {
    prompt += `\n\nYour previous attempt was rejected: ${correction}\nOutput only the script, in the format described.`;
  }
  return prompt;
}

/**
 * Generate and validate.
 *
 * Validation is the same parser the engine uses, so "did the model produce
 * something renderable" is answered by actually trying to render-parse it
 * rather than by inspecting the text. One retry, with the failure fed back.
 */
export async function generateScript(opts: WriteOptions): Promise<WriteResult> {
  const ollama = new Ollama(opts.host);
  let correction: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await ollama.generate({
      model: opts.model,
      system: systemPrompt(activeIdentity()),
      prompt: buildPrompt(opts, correction),
      temperature: 0.9,
    });

    const source = cleanup(raw);
    const screenplay = parseScript(source, 'generated');
    const lineCount = screenplay.elements.filter((e) => e.kind === 'dialogue').length;

    if (!screenplay.characters.length) {
      correction = 'it contained no character cues. A cue must be ALL CAPS alone on its line, with the dialogue on the next line.';
      continue;
    }
    if (lineCount < 4) {
      correction = `it only produced ${lineCount} dialogue lines. Write a full scene.`;
      continue;
    }

    return { source, characters: screenplay.characters, lineCount, attempts: attempt };
  }

  throw new Error(`model "${opts.model}" did not produce a usable script: ${correction}`);
}

/** Models like to wrap output in fences or add a preamble regardless of instructions. */
export function cleanup(raw: string): string {
  let text = raw.trim();

  const fence = /^```(?:\w+)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  // Drop anything before the title or first scene heading.
  const start = text.search(/^(#|INT\.|EXT\.)/m);
  if (start > 0) text = text.slice(start);

  return text.replace(/\r\n/g, '\n').trimEnd() + '\n';
}
