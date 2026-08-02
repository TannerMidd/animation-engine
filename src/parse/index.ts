import type { Screenplay, ScreenplayElement } from '../schema/script.ts';

/**
 * A loose Fountain subset — enough that scripts can be written naturally in any
 * text editor without learning a format.
 *
 *   INT. CUBICLE FARM - DAY      scene heading
 *   LUMBERGH                     character cue (all caps, on its own line)
 *   (deadpan)                    parenthetical — read as an emotion hint
 *   Yeahhh. Hi, Peterson.        dialogue
 *   [BEAT 900]                   an explicit pause, in milliseconds
 *   Milton stares at the wall.   action
 *
 * Beats are explicit rather than inferred. In this genre the pause *is* the
 * joke, and its exact length is a writing decision, not something to guess at.
 */

const HEADING = /^(INT|EXT|EST|I\/E|INT\.?\/EXT)[.\s]/i;
const BEAT = /^\[\s*BEAT(?:\s+(\d+))?\s*(?:ms)?\s*\]$/i;
const PARENTHETICAL = /^\((.+)\)$/;
const SECTION = /^#+\s*(.*)$/;
/** Notes to yourself. Stripped before anything else looks at the line. */
const COMMENT = /^\/\//;

/** Default pause when [BEAT] is written without a duration. */
const DEFAULT_BEAT_MS = 800;

/** The next line that isn't blank or a comment, or '' if there isn't one. */
function nextMeaningful(lines: string[], from: number): string {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (COMMENT.test(line)) continue;
    return line;
  }
  return '';
}

/** A cue is an all-caps line with at least one letter and no lowercase. */
function isCharacterCue(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;
  // Headings and beats are also uppercase; they are matched before this runs,
  // but guard anyway so ordering changes can't silently reclassify them.
  return !HEADING.test(t) && !BEAT.test(t);
}

export function parseScript(source: string, fallbackTitle = 'untitled'): Screenplay {
  const lines = source.split(/\r?\n/);
  const elements: ScreenplayElement[] = [];
  const characters: string[] = [];
  let title = fallbackTitle;

  let speaker: string | null = null;
  let parenthetical: string | null = null;
  let dialogue: string[] = [];

  /** A wordless "line" is a silence, and beats are how silence is expressed. */
  const WORDLESS_BEAT_MS = 900;

  const flushDialogue = () => {
    if (speaker && dialogue.length) {
      const text = dialogue.join(' ').replace(/\s+/g, ' ').trim();

      // A line with nothing speakable in it — "...", "—", "?!" — is a pause the
      // writer wrote as dialogue. Sending it to a TTS engine produces silence of
      // unpredictable length and a mouth that flaps at nothing, so turn it into
      // the thing it actually is. LLM-written scripts do this constantly.
      if (/[\p{L}\p{N}]/u.test(text)) {
        elements.push({ kind: 'dialogue', speaker, parenthetical, text });
      } else {
        elements.push({ kind: 'beat', ms: WORDLESS_BEAT_MS });
      }
    }
    speaker = null;
    parenthetical = null;
    dialogue = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();

    if (COMMENT.test(line)) continue;

    if (!line) {
      flushDialogue();
      continue;
    }

    const section = SECTION.exec(line);
    if (section) {
      flushDialogue();
      // The first section heading titles the piece.
      if (title === fallbackTitle && section[1]?.trim()) title = section[1].trim();
      continue;
    }

    const beat = BEAT.exec(line);
    if (beat) {
      flushDialogue();
      elements.push({ kind: 'beat', ms: beat[1] ? Number(beat[1]) : DEFAULT_BEAT_MS });
      continue;
    }

    if (HEADING.test(line)) {
      flushDialogue();
      elements.push({ kind: 'heading', text: line });
      continue;
    }

    // Mid-dialogue: a parenthetical on its own line, or more dialogue text.
    if (speaker) {
      const paren = PARENTHETICAL.exec(line);
      if (paren && !dialogue.length) {
        parenthetical = paren[1]!.trim();
        continue;
      }
      dialogue.push(line);
      continue;
    }

    // A cue only counts if something follows it — otherwise it is action
    // shouted in caps, which is a real thing scripts do. Comments are skipped
    // when looking ahead, so a note between a cue and its dialogue doesn't
    // silently demote the cue to action.
    if (isCharacterCue(line) && nextMeaningful(lines, i)) {
      speaker = line.replace(/\s*\(.*\)$/, '').trim();
      if (!characters.includes(speaker)) characters.push(speaker);
      continue;
    }

    elements.push({ kind: 'action', text: line });
  }

  flushDialogue();
  return { title, characters, elements };
}
