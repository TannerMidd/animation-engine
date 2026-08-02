import { z } from 'zod';

/**
 * What a character wears — split from what they *are*.
 *
 * `Look` is structure: build, head, face. `Outfit` is costume, and the split
 * is what makes costume changes safe — a scene can put someone in a different
 * shirt without touching the body underneath, and regenerating wardrobe can
 * never accidentally reshape a face. The rig carries the character's default
 * outfit; a shot list may override it per scene.
 */

export const SLEEVES = ['short', 'long'] as const;
export const COLLARS = ['none', 'flat', 'pointed', 'turtleneck'] as const;
export const NECKWEAR = ['none', 'tie', 'bowtie', 'lanyard'] as const;
export const PATTERNS = ['solid', 'stripes', 'pocket'] as const;
export const HATS = ['none', 'cap', 'beanie', 'brim'] as const;
export const SHOE_STYLES = ['round', 'flat', 'boot'] as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'expected a hex colour like #c98d5e');

export const Outfit = z.object({
  sleeves: z.enum(SLEEVES).default('short'),
  collar: z.enum(COLLARS).default('none'),
  neckwear: z.enum(NECKWEAR).default('none'),
  pattern: z.enum(PATTERNS).default('solid'),
  hat: z.enum(HATS).default('none'),
  shoes: z.enum(SHOE_STYLES).default('round'),
  /** Tie, hat band, stripe, lanyard cord — the one colour allowed to pop. */
  accent: hex.default('#a04f4f'),
});
export type Outfit = z.infer<typeof Outfit>;

/** Editor plumbing: every categorical outfit choice, keyed by field. */
export const OUTFIT_CHOICES = {
  sleeves: SLEEVES,
  collar: COLLARS,
  neckwear: NECKWEAR,
  pattern: PATTERNS,
  hat: HATS,
  shoes: SHOE_STYLES,
} as const;

export const ACCENTS = [
  '#a04f4f', '#c9803f', '#8c7a3f', '#4f7a5c', '#3f6b6b', '#4a5f8c', '#6b4f7a', '#8a5b6e', '#2b2f36',
];

/**
 * An outfit family: a named wardrobe archetype the visual bible owns.
 *
 * Families are how a cast reads as designed rather than independently rolled —
 * the ensemble assigner distributes families across characters, and each
 * character rolls their variation *inside* their family's ranges.
 */
export const OutfitFamily = z.object({
  name: z.string().min(1),
  /** Fields with a fixed value in this family (a suit family fixes the collar). */
  fixed: Outfit.partial().default({}),
  /** Fields the character may vary, with the options narrowed. */
  options: z
    .object({
      sleeves: z.array(z.enum(SLEEVES)).optional(),
      collar: z.array(z.enum(COLLARS)).optional(),
      neckwear: z.array(z.enum(NECKWEAR)).optional(),
      pattern: z.array(z.enum(PATTERNS)).optional(),
      hat: z.array(z.enum(HATS)).optional(),
      shoes: z.array(z.enum(SHOE_STYLES)).optional(),
    })
    .default({}),
  /** Relative share of the cast this family wants. */
  weight: z.number().positive().default(1),
  /** At most this many cast members per scene may wear this family. */
  maxPerScene: z.number().int().positive().optional(),
});
export type OutfitFamily = z.infer<typeof OutfitFamily>;
