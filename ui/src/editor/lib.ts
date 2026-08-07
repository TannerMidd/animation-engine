import type { AnimationDocument, Beat, DialogueCue, DialogueDocument, ShotList, TimeAnchor } from '../types.ts';

/** Editor modes, in the order they appear in the mode switcher. */
export type Mode = 'write' | 'direct' | 'animate' | 'perform' | 'sound' | 'publish';
export type InspectorTab = 'beat' | 'character' | 'motion' | 'rig' | 'camera' | 'prop' | 'voice' | 'scene';

/** Semantic palette (mirrors the CSS theme; used where styles are computed). */
export const C = {
  ink: '#e6e3dc',
  dim: '#9aa1ab',
  faint: '#6b737d',
  ghost: '#4c545e',
  edge: '#363d46',
  panel: '#252a31',
  p2: '#2b3138',
  well: '#141619',
  deep: '#1a1d21',
  accent: '#c8834a',
  good: '#6f9b5a',
  bad: '#c8595a',
  info: '#73a6c7',
  lock: '#a89050',
  gen: '#7a8fc0',
  mauve: '#b06a8f',
} as const;

/** Speaker identity colours, assigned by cast order (design-system rule). */
const SPEAKER_COLOURS = ['#c8834a', '#6f9b5a', '#7a8fc0', '#b06a8f', '#a89050', '#73a6c7', '#5e8f8a'];

export function speakerColour(castIds: string[], speaker: string): string {
  const i = castIds.indexOf(speaker);
  return i === -1 ? '#5f6772' : SPEAKER_COLOURS[i % SPEAKER_COLOURS.length]!;
}

/** Staging marks as fractions of stage width (mirrors src/schema/script.ts). */
export const MARK_X: Record<string, number> = {
  FAR_L: 0.16,
  SL: 0.31,
  CENTER: 0.5,
  SR: 0.69,
  FAR_R: 0.84,
};

/** `mm:ss.d`, the transport/status timecode format. */
export function fmtTimecode(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * Per-beat start times in ms.
 *
 * The preview's beatStarts are authoritative (they come from the same timing
 * the render uses). Before a preview exists, estimate from the shot list so
 * the timeline still has a shape: pauses and actions carry their own ms,
 * lines get a word-count estimate.
 */
export function beatStartsFor(shots: ShotList | null, previewStarts: number[] | undefined): number[] {
  if (previewStarts?.length) return previewStarts;
  if (!shots) return [];
  const out: number[] = [];
  let t = 0;
  for (const beat of shots.beats) {
    out.push(t);
    t += estimateBeatMs(beat);
  }
  return out;
}

export function estimateBeatMs(beat: Beat): number {
  if (beat.kind === 'pause') return beat.ms;
  if (beat.kind === 'action') return beat.ms || 2000;
  const words = beat.text.trim().split(/\s+/).filter(Boolean).length;
  return 400 + words * 280;
}

export function totalMsFor(shots: ShotList | null, starts: number[], previewDurationMs: number | undefined): number {
  if (previewDurationMs) return previewDurationMs;
  if (!shots || !starts.length) return 0;
  const last = shots.beats[shots.beats.length - 1];
  return (starts[starts.length - 1] ?? 0) + (last ? estimateBeatMs(last) : 0);
}

/**
 * The script-owned spine of a beat list (mirrors `matchKey` and `beatSpine` in
 * src/pipeline/propose.ts).
 *
 * Shot, camera, focus and pause duration are deliberately absent: those are
 * edited by hand in the inspector, and a retimed pause must never read as the
 * script having moved.
 */
export function beatSpine(beats: readonly Beat[]): string[] {
  return beats.map((beat) => {
    if (beat.kind === 'line') return `line:${beat.speaker}:${beat.text}`;
    if (beat.kind === 'action') return `action:${beat.text}`;
    return 'pause';
  });
}

/** How far the shot list has fallen behind the script, in beats. 0 is in sync. */
export function spineDrift(script: readonly string[], shotList: readonly string[]): number {
  let drift = Math.abs(script.length - shotList.length);
  for (let i = 0; i < Math.min(script.length, shotList.length); i++) {
    if (script[i] !== shotList[i]) drift++;
  }
  return drift;
}

// --- readiness repair hints -----------------------------------------------

/**
 * What to actually do about each preflight code, in creator words.
 *
 * Preflight states what is wrong; without this a blocker is a dead end — you
 * are told the export is refused and left to guess which of six modes owns the
 * remedy. Every code the engine can raise must have an entry, and a test over
 * `PREFLIGHT_CODES` holds this file to it.
 *
 * Order matters: the first matching pattern wins, so put specific codes above
 * the prefixes that would also match them.
 */
const HUMAN_HINTS: Array<{ test: RegExp; hint: string }> = [
  // --- script and direction ---
  { test: /^shotlist-script-stale$/, hint: 'Your script has moved ahead of the shot list. Press “Apply direction” in the bar at the top — the timeline, voices, animation, preview and render all read the shot list, not the script.' },
  { test: /^script-unreadable$/, hint: 'The scene has a shot list but its Fountain source cannot be read. Nothing is lost — the shot list still renders — but Direct cannot run until the script is back.' },
  { test: /^scene-undirected$/, hint: 'Nothing has been staged yet. Write the scene, then press “Direct the script”.' },
  { test: /^shotlist-invalid$/, hint: 'The shot list on disk does not match what the engine expects. Re-direct the scene to rebuild it from the script.' },
  { test: /^action-unstructured$|^action-unsupported$|^continuity-invalid$/, hint: 'Select the beat in Direct and stage it with structured actions in the inspector. Prose the director cannot lower into a known action has to be replaced or annotated.' },
  { test: /^director-locks$/, hint: 'Nothing to do — locked beats are reported so you know what a re-direct will leave alone.' },
  { test: /^identity-drift$/, hint: 'The scene was directed under a different show identity. Re-direct to pick up the current one, or switch the identity back in the app bar.' },
  { test: /^title-undrawable$/, hint: 'The title card alphabet cannot draw these characters. Change the scene title, or turn cards off in the scene inspector.' },

  // --- cast, sets and props ---
  { test: /^rig-invalid$/, hint: 'This character’s rig file is corrupt. Open them in the cast editor and regenerate, or restore the file.' },
  { test: /^rig-missing$/, hint: 'A placeholder puppet will be cast at render time. Open the character in the cast editor to draw a real one first.' },
  { test: /^set-missing$|^set-unavailable$/, hint: 'The scene names a set that is not on disk. Pick an existing set in the scene inspector, or create one in the set designer.' },
  { test: /^set-invalid$/, hint: 'The set file cannot be read. Open it in the set designer and fix or regenerate it.' },
  { test: /^prop-action-set-missing$/, hint: 'A beat handles a prop but the scene has no set to take it from. Assign a set in the scene inspector.' },
  { test: /^prop-action-invalid$/, hint: 'The beat names a prop the set does not have, or names one ambiguously when several match. Give the instance a stable id in the set designer, or point the action at a specific one.' },

  // --- animation ---
  { test: /^animation-target-invalid$/, hint: 'This motion was authored for a character who is no longer in the scene — usually because a re-direct changed the cast. In Animate: select the clip on the timeline and press Delete. The preview cannot build until these are gone.' },
  { test: /^animation-scene-mismatch$/, hint: 'The animation document belongs to a different scene. It has to be removed or replaced before this one can render.' },
  { test: /^animation-invalid$/, hint: 'The animation document cannot be read. Restore it, or delete it to start from generated motion only.' },
  { test: /^animation-resolve-failed$/, hint: 'Two motions fight over the same controller at the same moment, or one is anchored outside the scene. Open Animate and move or delete one of them.' },
  { test: /^animation-outside-walkable$/, hint: 'The motion leaves the floor area the set defines. Drag the endpoint back inside the walkable region, or widen it in the set designer.' },
  { test: /^animation-long-pose-hold$/, hint: 'A pose is held long enough to read as a frozen frame. Shorten it in Animate, or accept it and acknowledge the warning.' },
  { test: /^animation-contact-set-missing$|^animation-contact-invalid$/, hint: 'A contact or attach event names a set handle that does not exist. Re-point it at a real prop handle in Animate, or add the handle in the set designer.' },
  { test: /^animation-timing-deferred$/, hint: 'This motion is anchored to a label the planning clock cannot resolve yet. It will be timed exactly at render; no action needed unless the placement looks wrong.' },

  // --- dialogue selection and approval ---
  { test: /^dialogue-selection-unresolved$/, hint: 'This line has no audio chosen. In Perform: record a take, pick an existing one, or press “Use character voice” to approve the generated voice.' },
  { test: /^dialogue-unapproved$/, hint: 'Approve each line once you are happy with its audio — the big button in the Voice tab approves and locks in one step.' },
  { test: /^dialogue-unlocked$/, hint: 'Locking freezes a line against reruns. “Approve and lock performance” in the Voice tab does both.' },
  { test: /^dialogue-approval-/, hint: 'This line’s approval no longer stands — the audio or the text changed under it. Re-listen in the Voice tab and approve again.' },
  { test: /^dialogue-editorial-missing$/, hint: 'The scene has no dialogue document yet. Re-direct the scene; the cues are created from the shot list.' },
  { test: /^dialogue-invalid$/, hint: 'The dialogue document cannot be read. Restore it from disk, or re-direct to rebuild the cues (recorded takes on disk are not touched).' },
  { test: /^dialogue-scene-mismatch$/, hint: 'The dialogue document belongs to a different scene and cannot be used here.' },
  { test: /^dialogue-script-stale$/, hint: 'Your voice selections were made against a different version of the script. Re-direct, then review the affected lines in Perform.' },
  { test: /^dialogue-take-stale$|^dialogue-cue-stale$/, hint: 'The script line changed after this was recorded. Re-record the line, or revert the script text.' },
  { test: /^dialogue-asset-missing$/, hint: 'The audio file this line points at is gone. Select a different take, or re-record it.' },
  { test: /^dialogue-asset-stale$/, hint: 'The audio file changed on disk after it was recorded, so it no longer matches its checksum. Re-record the line or select a different take.' },
  { test: /^dialogue-trim-unreviewed$/, hint: 'Nobody has set where speech starts and ends in this recording. Open the waveform in the Voice tab and drag the trim handles.' },
  { test: /^dialogue-identity-drift$/, hint: 'These voice decisions were made under a different show identity. Re-listen before release, or acknowledge the warning.' },
  { test: /^dialogue-fps-drift$/, hint: 'The dialogue was timed at a different frame rate than the scene now uses. Run Voices to retime it.' },

  // --- capture quality ---
  { test: /^capture-qc-rejected$|^scene-run-segment-qc-rejected$/, hint: 'The selected recording failed capture checks (usually silence or clipping). Select a different take, re-record, or discard it.' },
  { test: /^capture-qc-warning$|^scene-run-segment-qc-warning$/, hint: 'The recording passed but something looked off — usually level or background noise. Listen in the Voice tab, then acknowledge the warning.' },
  { test: /^capture-qc-missing$|^scene-run-segment-qc-missing$/, hint: 'This take predates capture quality checks. Re-record it, or select a newer take.' },

  // --- rights ---
  { test: /^performance-consent-missing$/, hint: 'Your recordings need a rights record. In the Voice tab: tick the confirmation under Voice and performance rights and press Register permission — one self-owned record covers your recordings, including ones already made.' },
  { test: /^performance-consent-revoked$|^voice-consent-revoked$/, hint: 'The permission covering this audio was withdrawn. Select different audio, or register a new record if the rights are yours to give.' },
  { test: /^performance-consent-expired$|^voice-consent-expired$/, hint: 'The permission covering this audio has run out. Register a current record in the Voice tab.' },
  { test: /^performance-consent-scope$|^voice-consent-scope$/, hint: 'The rights record on file does not cover this use. Register one that permits distribution — and voice conversion, if a character voice is involved.' },
  { test: /^performance-consent-fallback$/, hint: 'Nothing to do — an older recording is covered by your document-level rights record rather than its own.' },
  { test: /^voice-consent-missing$/, hint: 'This converted line names a rights record that no longer exists. Re-convert it in the Voice tab, or select your original recording instead.' },
  { test: /^voice-consent-reference-stale$|^voice-target-reference-stale$/, hint: 'The character’s voice reference changed after this line was converted. Re-convert it in the Voice tab.' },
  { test: /^voice-conversion-source-/, hint: 'This converted line is no longer tied to the recording it came from. Re-convert it from the take you want in the Voice tab.' },

  // --- voices ---
  { test: /^voice-line-unintelligible$/, hint: 'Every seeded attempt at this generated line failed speech verification — the audio does not say the script line. Reroll the line’s seed in the Perform strip, reword the line, or record it yourself.' },
  { test: /^voice-reference-draft-only$/, hint: 'This character speaks with a machine-invented voice and some lines have no decision yet. Approve the generated voice per line, approve a conversion of your own take into it, or give the character a recorded reference in the cast editor.' },
  { test: /^voice-reference-minted-in-use$/, hint: 'This character speaks with a machine-invented voice you approved — as generated lines, or as your performance converted into it. Audition it, then acknowledge this warning in the readiness report.' },
  { test: /^voice-reference-missing$/, hint: 'Nothing to do — a voice is minted automatically the next time Voices runs.' },
  { test: /^voice-render-qc-warning$/, hint: 'A converted line passed the automatic checks but nothing verified the words. Use A / B in the Perform strip to hear your recording against the character voice, then acknowledge this warning in the readiness report.' },
  { test: /^voice-render-not-ready$/, hint: 'This conversion has not finished, or it failed. Re-run it from the Voice tab.' },
  { test: /^voice-render-rejected$/, hint: 'This converted line failed quality review. Re-convert it, or select your original recording instead.' },
  { test: /^voice-render-draft-only$/, hint: 'This line is still draft synthesis, not production dialogue. Approve the character voice for it, or record and select a take.' },

  // --- sound ---
  { test: /^soundtrack-stale$/, hint: 'The mixed audio predates your latest edits. Run Voices to rebuild it.' },
  { test: /^soundtrack-missing$/, hint: 'No audio has been mixed yet. Run Voices.' },
  { test: /^soundtrack-unverifiable$/, hint: 'The mix on disk cannot be checked against the scene. Run Voices to rebuild it.' },
  { test: /^soundtrack-loudness-failed$|^soundtrack-true-peak-failed$/, hint: 'The programme is outside the delivery loudness target. Run Voices to re-normalise; if it persists, a take is clipping — check the loudest lines in Perform.' },
  { test: /^soundtrack-qc-missing$/, hint: 'This mix predates loudness and peak measurement. Run Voices before release.' },
  { test: /^soundtrack-qc-passed$|^soundtrack-intentional-silence$/, hint: 'Nothing to do — reported so the measurement is on the record.' },

  // --- publish ---
  { test: /^caption-safe-area-failed$/, hint: 'A caption is too long for the mobile safe area and was not split into sequential cues — which normally happens automatically, so something upstream failed to compile. Check the other blockers first; this usually clears with them.' },
  { test: /^caption-reading-rate$/, hint: 'This caption goes by faster than it can comfortably be read. Shorten the line, or accept it and acknowledge the warning.' },
  { test: /^portrait-safe-area-failed$/, hint: 'In the 9:16 recompose a character drifts outside the safe area. Move them toward centre in Animate, or adjust their mark in Direct.' },
  { test: /^render-stale$/, hint: 'The last video predates your latest edits. Re-render once the blockers clear.' },
];

export function humanHint(code: string): string | null {
  return HUMAN_HINTS.find((h) => h.test.test(code))?.hint ?? null;
}

// --- captions (mirrors src/compile/captions.ts) ---------------------------

export const CAPTION_LINE_CHARACTERS = 32;
export const CAPTION_MAX_LINES = 2;

/** Wrap to the mobile caption width, breaking a word only if it cannot fit. */
export function wrapCaptionLines(text: string, maxCharacters = CAPTION_LINE_CHARACTERS): string[] {
  const words = text.replace(/[\r\n\0]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxCharacters) {
      if (current) lines.push(current);
      let rest = word;
      while (rest.length > maxCharacters) {
        lines.push(rest.slice(0, maxCharacters));
        rest = rest.slice(maxCharacters);
      }
      current = rest;
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharacters) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * The cues a line of dialogue actually displays as, with the fraction of the
 * line's own duration each one occupies.
 *
 * The compiler splits an over-long caption across its speech window; this is
 * the same division expressed against the beat, so the preview overlay shows
 * what the sidecar will show rather than one caption nothing can display.
 */
export function captionChunks(
  text: string,
  maxCharacters = CAPTION_LINE_CHARACTERS,
  maxLines = CAPTION_MAX_LINES,
): Array<{ text: string; from: number; to: number }> {
  const lines = wrapCaptionLines(text, maxCharacters);
  if (lines.length <= maxLines) return [{ text: text.trim(), from: 0, to: 1 }];

  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }
  const total = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.length), 0);
  let consumed = 0;
  return chunks.map((chunk, i) => {
    const from = consumed / total;
    consumed += Math.max(1, chunk.length);
    return { text: chunk, from, to: i === chunks.length - 1 ? 1 : consumed / total };
  });
}

/** The chunk on screen at `progress` (0–1) through the line. */
export function captionAt(text: string, progress: number): string {
  const chunks = captionChunks(text);
  const clamped = Math.max(0, Math.min(0.999999, progress));
  return (chunks.find((chunk) => clamped >= chunk.from && clamped < chunk.to) ?? chunks[chunks.length - 1]!).text;
}

/** Resolve an animation time anchor to ms, given beat ids and starts. */
export function resolveAnchor(
  anchor: TimeAnchor,
  beats: Beat[],
  starts: number[],
  durations: (i: number) => number,
): number {
  if (anchor.kind === 'absolute') return anchor.ms;
  const i = beats.findIndex((b) => b.id === anchor.beatId);
  if (i === -1) return anchor.offsetMs;
  const base = anchor.edge === 'end' ? (starts[i] ?? 0) + durations(i) : starts[i] ?? 0;
  return base + anchor.offsetMs;
}

/** Voice state of a line beat, resolved through the dialogue document. */
export function cueApproval(cue: DialogueCue | undefined): 'approved' | 'generated' | 'candidate' | 'missing' {
  if (!cue) return 'missing';
  if (cue.voiceSource === 'generated' && cue.approval.state === 'approved') return 'generated';
  if (cue.approval.state === 'approved') return 'approved';
  if (cue.selectedTakeId || cue.selectedRenderId || cue.approval.state === 'candidate') return 'candidate';
  return 'missing';
}

/** True when the line still needs a creator decision (record, select, or choose generated). */
export function cueUndecided(cue: DialogueCue | undefined): boolean {
  const state = cueApproval(cue);
  return state === 'missing' || state === 'candidate';
}

export function cueForBeat(dialogue: DialogueDocument | null, beat: Beat | null): DialogueCue | null {
  if (!dialogue || !beat || beat.kind !== 'line') return null;
  return dialogue.cues.find((cue) => cue.id === beat.id) ?? null;
}

/**
 * The cues that belong to the script as it stands, in beat order.
 *
 * A dialogue document keeps cues whose beat no longer exists, deliberately: a
 * rewrite that deletes a line must not destroy the takes recorded for it, and
 * restoring the line restores the work. That retention is correct on disk and
 * wrong on screen — showing them makes lines from a previous, unrelated script
 * look like lines of this one, complete with whatever run-on text the old
 * parse produced.
 *
 * So every surface that means "the lines of this scene" resolves through the
 * shot list, exactly as the engine does when it renders.
 */
export function sceneCues(dialogue: DialogueDocument | null, shots: ShotList | null): DialogueCue[] {
  if (!dialogue) return [];
  if (!shots) return dialogue.cues;
  const byId = new Map(dialogue.cues.map((cue) => [cue.id, cue]));
  const out: DialogueCue[] = [];
  for (const beat of shots.beats) {
    if (beat.kind !== 'line') continue;
    const cue = byId.get(beat.id);
    if (cue) out.push(cue);
  }
  return out;
}

/** Cues the script has left behind: kept on disk for their takes, shown apart. */
export function orphanedCues(dialogue: DialogueDocument | null, shots: ShotList | null): DialogueCue[] {
  if (!dialogue || !shots) return [];
  const live = new Set(shots.beats.flatMap((beat) => (beat.kind === 'line' ? [beat.id] : [])));
  return dialogue.cues.filter((cue) => !live.has(cue.id));
}

/** Why a timeline motion clip cannot currently be deleted, or null when safe. */
export function motionDeletionBlocker(document: AnimationDocument, segmentId: string): string | null {
  const segment = document.segments.find((item) => item.id === segmentId);
  if (!segment) return 'That motion no longer exists.';
  const layer = document.layers.find((item) => item.id === segment.layerId);
  if (layer?.locked) return `Unlock the ${layer.name} layer before deleting this motion.`;
  if (segment.locked) return 'Unlock this motion before deleting it.';
  const lockedControl = [segment.from, segment.to, ...segment.waypoints].find((control) => control.locked);
  if (lockedControl) return `Unlock motion control ${lockedControl.id} before deleting this motion.`;
  return null;
}

/** Remove exactly one unlocked motion segment while preserving every other animation item. */
export function withoutMotionSegment(document: AnimationDocument, segmentId: string): AnimationDocument {
  const blocker = motionDeletionBlocker(document, segmentId);
  if (blocker) throw new Error(blocker);
  return { ...document, segments: document.segments.filter((segment) => segment.id !== segmentId) };
}

/** Deterministic 4-swatch strip from an identity hash, for the app-bar chip. */
export function identitySwatches(hash: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const chunk = hash.slice(i * 3, i * 3 + 3) || 'abc';
    const n = parseInt(chunk, 16);
    const value = Number.isNaN(n) ? (chunk.charCodeAt(0) ?? 97) * 7 : n;
    out.push(`hsl(${value % 360} ${34 + (value % 22)}% ${44 + (value % 18)}%)`);
  }
  return out;
}

export const MODE_DEFS: Array<{ id: Mode; label: string; hint: string; planned?: boolean }> = [
  { id: 'write', label: 'Write', hint: 'Screenplay editing. Fountain subset — cues, parentheticals, [BEAT ms].' },
  { id: 'direct', label: 'Direct', hint: 'Shot proposal, beat direction, staging. Locked beats survive reruns.' },
  { id: 'animate', label: 'Animate', hint: 'Blocking, rig controls, Point A → Point B motion paths.' },
  { id: 'perform', label: 'Perform', hint: 'Line Booth and Scene Run capture, takes, trims, voice conversion.' },
  { id: 'sound', label: 'Sound', hint: 'Production stems, Foley events, room tone and the loudness gate.' },
  { id: 'publish', label: 'Publish', hint: 'Production readiness, 16:9 / 9:16 masters, captions, export manifest.' },
];

export const MODE_BLURBS: Record<Mode, string> = {
  write: 'Script is the source of truth. Beats are explicit — the pause is the joke.',
  direct: 'Direction is propose-then-apply. Locked beats survive every rerun.',
  animate: 'Pause on a frame, drag a handle. Generated motion stays underneath.',
  perform: 'Follow Performance keeps your timing, pauses and cadence. Only identity converts.',
  sound: 'One mix path: dialogue, Foley, room tone and stings — the stems are what the master is made of.',
  publish: 'Production render is stricter than preview. Blockers are listed, not guessed at.',
};

/** The inspector tab each mode lands on. */
export function defaultTabFor(mode: Mode): InspectorTab {
  if (mode === 'animate') return 'motion';
  if (mode === 'perform') return 'voice';
  if (mode === 'publish' || mode === 'sound') return 'scene';
  return 'beat';
}

// --- pointer and keyboard chrome ------------------------------------------

/**
 * Whether text is being edited at `target`.
 *
 * Three separate features defer to this: shortcuts must not fire while you are
 * typing, right-click must keep the browser's own menu where Paste and
 * spell-check live, and a drag has to blur the script editor by hand now that
 * it prevents the default focus move.
 */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || el.isContentEditable || Boolean(el.closest?.('.cm-editor'));
}

/**
 * Where a context menu lands, given the pointer, the menu's measured size and
 * the viewport.
 *
 * Flip before clamping. Flipping is what keeps the pointer on a corner of the
 * menu the way a native one does; clamping is the fallback for when neither
 * orientation fits, and doing it first would slide the menu out from under the
 * cursor at every edge instead of only the impossible ones. `maxHeight` is
 * returned rather than applied so a menu taller than the screen scrolls
 * instead of overflowing off it.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gutter = 8,
): { left: number; top: number; maxHeight: number } {
  const maxHeight = Math.min(size.h, Math.max(0, viewport.h - gutter * 2));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const left = at.x + size.w + gutter <= viewport.w ? at.x : at.x - size.w;
  const top = at.y + maxHeight + gutter <= viewport.h ? at.y : at.y - maxHeight;
  return {
    left: clamp(left, gutter, Math.max(gutter, viewport.w - size.w - gutter)),
    top: clamp(top, gutter, Math.max(gutter, viewport.h - maxHeight - gutter)),
    maxHeight,
  };
}
