import crypto from 'node:crypto';
import { z } from 'zod';
import { OutfitFamily } from './outfit.ts';

/**
 * ShowIdentity v1 — the show's identity as data.
 *
 * Everything that makes output recognisable as *this* show lives here: the line
 * treatment, the writing register, the pacing rules, the audio character, and
 * the policy for how much randomness is allowed to vary within it. Renderers,
 * directors and prompts consume the profile; none of them carry identity
 * opinions of their own.
 *
 * v1 deliberately specifies only what the engine consumes today. Each bible is
 * a named home that later milestones extend with optional fields — extending is
 * non-breaking, because older profiles simply lack the new options and fall
 * back to their zod defaults.
 *
 * Precedence, everywhere a setting can come from more than one place:
 *
 *   show defaults → character/set overrides → scene overrides → beat overrides
 *
 * with locks freezing a value against *regeneration* — a locked property never
 * loses to a reroll, a migration, or a model proposal, whatever layer it sits
 * in.
 */

// --- visual ---------------------------------------------------------------

/**
 * Line and print treatment. These are the fields the wobble renderer consumes;
 * they used to live in a hardcoded style table selected by env var.
 */
export const StyleTreatment = z.object({
  /** Base outline weight, in puppet/set units. */
  lineWidth: z.number().positive().default(4.4),
  /** How much weight varies shape to shape, 0-1. */
  lineWidthJitter: z.number().min(0).max(1).default(0.32),
  /** Perpendicular outline displacement, in units. 0 disables wobble. */
  wobble: z.number().min(0).default(2.6),
  /** Subdivisions per edge. */
  wobbleSegments: z.number().int().min(1).default(3),
  /** Fill offset from its outline — the misprint. */
  fillOffset: z.tuple([z.number(), z.number()]).default([2.6, -1.9]),
  /** Paper grain over the whole frame, 0-1. */
  grain: z.number().min(0).max(1).default(0.05),
});
export type StyleTreatment = z.infer<typeof StyleTreatment>;

/**
 * Card typography and layout, profile-owned.
 *
 * Type renders through the engine's own vector glyphs — no machine fonts, so a
 * card looks identical on any machine and the letterforms carry the show's
 * line treatment like everything else does.
 */
export const CardTemplates = z.object({
  /** Card background; text and rule colours. */
  paper: z.string().default('#171717'),
  ink: z.string().default('#e9e3d6'),
  accent: z.string().default('#b4744a'),
  /** Title frames prepended to a scene. 0 disables the title card. */
  titleFrames: z.number().int().min(0).max(240).default(42),
  /** End-card frames appended after the smash cut. 0 disables. */
  endFrames: z.number().int().min(0).max(240).default(30),
  /** Text of the end card. The genre tradition is abrupt. */
  endText: z.string().max(24).default('THE END'),
});
export type CardTemplates = z.infer<typeof CardTemplates>;

export const VisualBible = z.object({
  style: StyleTreatment.default({}),
  /**
   * Compositional rules for environments, in the show's own words. Fed to the
   * set designer (human-readable docs and the LLM prompt alike). These replace
   * the prose that used to be hardcoded in the generation prompt.
   */
  setNotes: z.array(z.string()).default([]),
  /**
   * Wardrobe archetypes the ensemble assigner distributes across the cast.
   * Empty means "no wardrobe opinion": characters roll independently, which is
   * the pre-M19 behaviour.
   */
  outfitFamilies: z.array(OutfitFamily).default([]),
  /** Accent colours wardrobe may draw from. */
  accents: z.array(z.string()).default([]),
  /** Title and end card treatment. */
  cards: CardTemplates.default({}),
});
export type VisualBible = z.infer<typeof VisualBible>;

// --- performance ----------------------------------------------------------

export const PerformanceBible = z.object({
  /**
   * The writing register, as rules — never as the name of another show.
   * Consumed by the writer prompt and shown in docs.
   */
  register: z.array(z.string()).default([]),
  /** Baseline expression when a line carries no parenthetical. */
  restingExpression: z.string().default('DEADPAN'),
  /**
   * The show's acting envelope. Characters roll their personal values inside
   * these ranges, so a restrained show and a twitchy show differ before any
   * individual character does.
   */
  acting: z
    .object({
      /** How long a listener takes to visibly react to a line, in ms. */
      reaction: z
        .object({ minMs: z.number().min(0).default(140), maxMs: z.number().max(1500).default(480) })
        .default({}),
      /** A gesture holds at least this long before it may release. */
      gestureMinHoldMs: z.number().min(200).default(900),
      /** Fraction of the line after which a held gesture drops back to talking. */
      gestureReleaseFraction: z.number().min(0.3).max(1).default(0.68),
      /** Idle weight-shift while not speaking: amplitude and cadence. */
      fidget: z
        .object({
          amp: z.number().min(0).max(6).default(2.2),
          minMs: z.number().min(800).default(2800),
          maxMs: z.number().default(5200),
        })
        .default({}),
      /** Whether listeners look at whoever is speaking. */
      gaze: z.boolean().default(true),
    })
    .default({}),
});
export type PerformanceBible = z.infer<typeof PerformanceBible>;

// --- editorial ------------------------------------------------------------

export const EditorialBible = z.object({
  /** Cutting and rhythm rules, in the show's own words. Consumed by prompts. */
  pacing: z.array(z.string()).default([]),
  /**
   * The snap zoom: an instant stepped punch-in on a dramatic beat. Quota'd and
   * cooled down because it is punctuation — a show that snaps on everything is
   * shouting, and shouting constantly is silence.
   */
  snapIn: z
    .object({
      enabled: z.boolean().default(true),
      /** Total tightening across the move, as a fraction of frame size. */
      amount: z.number().min(0.05).max(0.5).default(0.24),
      /** Instant steps the tightening lands in. */
      steps: z.number().int().min(1).max(4).default(2),
      /** Beats that must pass between snaps. */
      cooldownBeats: z.number().int().min(0).default(6),
      maxPerScene: z.number().int().min(0).default(2),
    })
    .default({}),
  /** Deterministic rhythm heuristics the director applies. */
  rhythm: z
    .object({
      /** Stretch the pause after an ANGRY/SHOCKED line, and put a CU on its target. */
      aftershockBoost: z.number().min(1).max(2).default(1.25),
      /** Cut runs of very short lines as alternating close-ups. */
      pingPongCu: z.boolean().default(true),
    })
    .default({}),
});
export type EditorialBible = z.infer<typeof EditorialBible>;

// --- audio ----------------------------------------------------------------

export const AudioBible = z.object({
  /**
   * Room tone under every scene. `setProfiles` overrides the palette-derived
   * acoustic profile per set name — the axis that keeps sound and picture
   * independently ownable.
   */
  ambience: z
    .object({
      enabled: z.boolean().default(true),
      /** Bed loudness as RMS dBFS. Room tone that gets noticed has failed. */
      levelDb: z.number().min(-60).max(-8).default(-30),
      setProfiles: z.record(z.string(), z.string()).default({}),
    })
    .default({}),
  /** Card punctuation. Synthesized, seeded, bumper-minimal. */
  stings: z
    .object({
      enabled: z.boolean().default(true),
      levelDb: z.number().min(-40).max(0).default(-6),
    })
    .default({}),
  /** Master bus targets. Old profiles retain targetRmsDb as a migration alias. */
  mix: z
    .object({
      targetIntegratedLufs: z.number().min(-36).max(-8).default(-16),
      /** @deprecated Parsed for old identity files; new mastering uses LUFS. */
      targetRmsDb: z.number().min(-40).max(-6).default(-20),
      /** Inter-sample ceiling measured after four-times oversampling, in dBTP. */
      ceilingDb: z.number().min(-6).max(0).default(-1),
    })
    .default({}),
});
export type AudioBible = z.infer<typeof AudioBible>;

// --- variation policy -----------------------------------------------------

export const VariationPolicy = z.object({
  /**
   * Show-level locks, as dotted paths (e.g. "visual.style.grain").
   * Character-level locks live on the rig; both are honoured by every
   * regeneration path.
   */
  locks: z.array(z.string()).default([]),
  // Extended as consumed: allowed ranges, exclusions, compatibility rules.
});
export type VariationPolicy = z.infer<typeof VariationPolicy>;

// --- the profile ----------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+$/;

export const ShowIdentity = z.object({
  /** Stable slug. Renaming the show means changing `name`, never this. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1),
  version: z.string().regex(SEMVER, 'version must be semver, e.g. 1.0.0'),
  /** Root seed for every named variation stream in the project. */
  seed: z.number().int(),
  description: z.string().default(''),

  visual: VisualBible.default({}),
  performance: PerformanceBible.default({}),
  editorial: EditorialBible.default({}),
  audio: AudioBible.default({}),
  variation: VariationPolicy.default({}),
});
export type ShowIdentity = z.infer<typeof ShowIdentity>;

/** What gets stamped into rigs, sets, shot lists and IR: enough to detect drift. */
export const IdentityStamp = z.object({
  id: z.string(),
  version: z.string(),
  hash: z.string(),
});
export type IdentityStamp = z.infer<typeof IdentityStamp>;

// --- hashing --------------------------------------------------------------

/** JSON with every object's keys sorted, so the same content always serialises identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Content hash of a profile.
 *
 * Everything cache-relevant flows from this: two profiles with the same hash
 * render identically, and a hash mismatch on a stamped artifact means the
 * profile changed since the artifact was made.
 */
export function identityHash(identity: ShowIdentity): string {
  return crypto.createHash('sha1').update(canonicalJson(identity)).digest('hex').slice(0, 12);
}

export function stampOf(identity: ShowIdentity): IdentityStamp {
  return { id: identity.id, version: identity.version, hash: identityHash(identity) };
}

// --- locks ----------------------------------------------------------------

/**
 * Is a dotted path frozen by a lock list?
 *
 * A lock covers itself and everything beneath it: locking "look" freezes every
 * look field, locking "look.hair" freezes just the hair. Regeneration honours
 * this by copying locked values from the existing entity over whatever the
 * reroll produced — the reroll happens, the locked field just doesn't move.
 */
export function isLocked(locks: readonly string[], path: string): boolean {
  return locks.some((lock) => path === lock || path.startsWith(`${lock}.`));
}

/**
 * The default identity: the house look and register as they stood when
 * identity became data. Loading a project with no show profile gets exactly
 * this, so pre-identity projects render unchanged.
 */
export const DEFAULT_IDENTITY: ShowIdentity = ShowIdentity.parse({
  id: 'house',
  name: 'House',
  version: '1.0.0',
  seed: 7,
  description:
    'The default identity: marker-and-misprint linework, deadpan register, unhurried cutting.',
  visual: {
    style: {},
    setNotes: [
      'Asymmetry: a set with a matching prop either side of centre reads as a stage flat. Weight one side and leave the other sparse.',
      'Too few, too big: three large props beat nine small ones. Small props read as clutter at this line weight.',
      'One wrong object: every room gets a single item that does not belong — a lone traffic cone indoors, a plant beside a filing cabinet. That object is the joke.',
      'Rooms that have been used: push things off centre and off the grid. Nothing is aligned, nothing is new, nobody tidied up.',
      'Depth by layer, not by detail: get the read from back versus mid versus fore, not from adding more objects.',
    ],
    // The workplace ensemble: mostly drones, a manager or two, some off-dress
    // staff, and at most one person who is a walking wrong object.
    outfitFamilies: [
      {
        name: 'drone',
        weight: 5,
        fixed: { hat: 'none' },
        options: {
          collar: ['flat', 'pointed'],
          neckwear: ['none', 'tie', 'lanyard'],
          pattern: ['solid', 'pocket', 'stripes'],
          shoes: ['round', 'flat'],
        },
      },
      {
        name: 'management',
        weight: 2,
        maxPerScene: 2,
        fixed: { collar: 'pointed', neckwear: 'tie', sleeves: 'long', hat: 'none', pattern: 'solid' },
        options: { shoes: ['flat', 'round'] },
      },
      {
        name: 'off-dress',
        weight: 3,
        fixed: { collar: 'none', neckwear: 'none' },
        options: {
          pattern: ['solid', 'stripes'],
          hat: ['none', 'none', 'cap', 'beanie'],
          shoes: ['round', 'boot'],
        },
      },
      {
        name: 'wrong-object',
        weight: 1,
        maxPerScene: 1,
        options: {
          collar: ['turtleneck'],
          neckwear: ['bowtie', 'none'],
          hat: ['brim', 'none'],
          pattern: ['stripes', 'solid'],
          shoes: ['boot'],
        },
      },
    ],
    accents: ['#a04f4f', '#c9803f', '#8c7a3f', '#4f7a5c', '#3f6b6b', '#4a5f8c', '#6b4f7a'],
  },
  performance: {
    register: [
      'Deadpan is the baseline. Characters under-react to enormous things.',
      'Dialogue is mundane, absurd, and unhurried; the absurdity is treated as paperwork.',
      'Never explain the joke. End on an understatement, not a summary.',
      'Characters speak in ordinary workplace language, whatever is happening to them.',
    ],
    restingExpression: 'DEADPAN',
  },
  editorial: {
    pacing: [
      'The pause is where the joke lands; do not write a punchline where a silence would do.',
      'Vary pause lengths; let long silences sit on the person the line landed on.',
    ],
  },
});
