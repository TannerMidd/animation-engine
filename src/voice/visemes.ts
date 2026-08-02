import type { MouthShape } from '../schema/index.ts';

/**
 * Windows SAPI viseme ids (0-21) mapped onto Rhubarb's mouth shape alphabet.
 *
 * Both describe the same thing — the visible position of the mouth — but SAPI
 * distinguishes 22 positions where Rhubarb uses 9. Collapsing to Rhubarb's set
 * keeps one mouth vocabulary across the whole engine, so a rig drawn for
 * Rhubarb output works with SAPI timing and vice versa. At the frame rates
 * this style runs at, the extra SAPI distinctions would not survive
 * quantisation anyway.
 *
 * SAPI's ids follow the Microsoft Speech API viseme table:
 *   0 silence · 1 ae/ax/ah · 2 aa · 3 ao · 4 eh/uh · 5 er · 6 y/iy/ih · 7 w/uw
 *   8 ow · 9 aw · 10 oy · 11 ay · 12 h · 13 r · 14 l · 15 s/z · 16 sh/ch/jh/zh
 *   17 th/dh · 18 f/v · 19 d/t/n · 20 k/g/ng · 21 p/b/m
 */
const SAPI_TO_MOUTH: Record<number, MouthShape> = {
  0: 'X', // silence — rest position
  1: 'C', // ae, ax, ah  -> open
  2: 'D', // aa          -> wide open
  3: 'E', // ao          -> rounded
  4: 'C', // eh, uh      -> open
  5: 'E', // er          -> rounded
  6: 'B', // y, iy, ih   -> narrow, teeth close
  7: 'F', // w, uw       -> puckered
  8: 'E', // ow          -> rounded
  9: 'D', // aw          -> wide open
  10: 'E', // oy         -> rounded
  11: 'D', // ay         -> wide open
  12: 'C', // h          -> open, breathy
  13: 'E', // r          -> rounded
  14: 'H', // l          -> tongue
  15: 'B', // s, z       -> narrow
  16: 'B', // sh, ch, jh -> narrow
  17: 'B', // th, dh     -> narrow, tongue to teeth
  18: 'G', // f, v       -> teeth on lip
  19: 'B', // d, t, n    -> narrow
  20: 'B', // k, g, ng   -> narrow
  21: 'A', // p, b, m    -> closed
};

export function sapiVisemeToMouth(id: number): MouthShape {
  return SAPI_TO_MOUTH[id] ?? 'X';
}

/** One mouth position, held from `ms` until the next cue. */
export interface MouthCue {
  ms: number;
  shape: MouthShape;
}

/** A line's audio and the mouth track that goes with it. */
export interface LineTiming {
  /** Absolute path to the WAV. */
  audio: string;
  durationMs: number;
  cues: MouthCue[];
}

/**
 * Parse the TSV emitted by sapi.ps1 into a mouth cue track.
 *
 * Consecutive cues resolving to the same shape are collapsed, since holding a
 * shape is what actually happens and it keeps the IR (and the dedup) tighter.
 */
export function parseSapiOutput(tsv: string): { durationMs: number; cues: MouthCue[] } {
  let durationMs = 0;
  const cues: MouthCue[] = [];

  for (const line of tsv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [a, b] = line.split('\t');
    if (a === 'duration') {
      durationMs = Number(b) || 0;
      continue;
    }
    const ms = Number(a);
    const id = Number(b);
    if (!Number.isFinite(ms) || !Number.isFinite(id)) continue;

    const shape = sapiVisemeToMouth(id);
    const prev = cues[cues.length - 1];
    if (prev && prev.shape === shape) continue;
    cues.push({ ms, shape });
  }

  // Always start from rest so a line can't inherit the previous line's mouth.
  if (!cues.length || cues[0]!.ms > 0) cues.unshift({ ms: 0, shape: 'X' });
  return { durationMs, cues };
}

/** The mouth shape in effect at a given time within a line. */
export function mouthAt(cues: MouthCue[], ms: number): MouthShape {
  let shape: MouthShape = 'X';
  for (const cue of cues) {
    if (cue.ms > ms) break;
    shape = cue.shape;
  }
  return shape;
}
