import { z } from 'zod';

/**
 * What a character looks like, as data.
 *
 * Appearance used to be rolled from the name inside the drawing code, which
 * meant the only way to change how someone looked was to rename them. Pulling it
 * out into a descriptor makes every choice addressable: the roll becomes a
 * *default*, the cast editor edits the result, and the puppet generator becomes
 * a pure function of this object.
 *
 * Everything here is a discrete choice rather than a continuous parameter,
 * because a slider that can produce anything mostly produces mush. A short list
 * of strong options is what keeps a cast looking like it came from one show.
 */

export const BUILDS = ['squat', 'lanky', 'boxy', 'round', 'pear'] as const;
export const HEAD_SHAPES = ['round', 'square', 'long', 'egg', 'wide', 'pointed'] as const;
export const NOSES = ['button', 'bulb', 'beak', 'hook', 'wide', 'pointed', 'none'] as const;
export const EARS = ['small', 'large', 'stuck-out', 'none'] as const;
export const HAIR_STYLES = [
  'bald', 'receding', 'combover', 'crop', 'mop', 'tall', 'side-part', 'spikes', 'bun', 'ponytail', 'curly',
] as const;
export const FACIAL_HAIR = ['none', 'stubble', 'moustache', 'goatee', 'beard', 'chops'] as const;
export const GLASSES = ['none', 'round', 'square', 'halfrim'] as const;
export const EYE_STYLES = ['round', 'oval', 'dot', 'beady', 'hooded', 'googly'] as const;
export const BROW_STYLES = ['thin', 'thick', 'bushy', 'sparse', 'angled'] as const;

export type Build = (typeof BUILDS)[number];
export type HeadShape = (typeof HEAD_SHAPES)[number];

/** Flat and slightly grubby. Saturated primaries read as too clean for this style. */
export const SKINS = ['#e8b98a', '#c98d5e', '#8d5a3b', '#f0d0a8', '#a86f4a', '#d9a066', '#b8825c'];
export const SHIRTS = [
  '#5b7c99', '#8a5b6e', '#6b8f5a', '#a8683c', '#4a4f6b', '#7d6b8a', '#996b5b',
  '#3f6b6b', '#8c7a3f', '#6b4f7a', '#a04f4f', '#4f7a5c',
];
export const HAIRS = ['#2b2118', '#4a3520', '#6b4423', '#171717', '#8a6a3f', '#5a2f22', '#767268', '#c4a86b'];
export const TROUSERS = ['#3a3f4a', '#4a4438', '#2f3a44', '#514540', '#3d3d4d', '#45403a'];

/** Every swatch the editor offers, keyed by the field it fills. */
export const LOOK_SWATCHES = {
  skin: SKINS,
  shirt: SHIRTS,
  hairColour: HAIRS,
  trousers: TROUSERS,
} as const;

/** Every categorical choice the editor offers, keyed by field. */
export const LOOK_CHOICES = {
  build: BUILDS,
  head: HEAD_SHAPES,
  nose: NOSES,
  ears: EARS,
  hair: HAIR_STYLES,
  facialHair: FACIAL_HAIR,
  glasses: GLASSES,
  eyes: EYE_STYLES,
  brows: BROW_STYLES,
} as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'expected a hex colour like #c98d5e');

export const Look = z.object({
  build: z.enum(BUILDS).default('boxy'),
  head: z.enum(HEAD_SHAPES).default('round'),
  nose: z.enum(NOSES).default('button'),
  ears: z.enum(EARS).default('small'),
  hair: z.enum(HAIR_STYLES).default('crop'),
  facialHair: z.enum(FACIAL_HAIR).default('none'),
  glasses: z.enum(GLASSES).default('none'),
  eyes: z.enum(EYE_STYLES).default('round'),
  brows: z.enum(BROW_STYLES).default('thin'),

  skin: hex.default('#e8b98a'),
  shirt: hex.default('#5b7c99'),
  hairColour: hex.default('#2b2118'),
  trousers: hex.default('#3a3f4a'),
  line: hex.default('#1a1a1a'),

  /**
   * Continuous knobs, as multipliers around 1. These exist so the editor can
   * nudge a rolled character rather than only reroll them — the categorical
   * choices above are what actually carry the design.
   */
  headSize: z.number().min(0.6).max(1.6).default(1),
  bodyWidth: z.number().min(0.6).max(1.6).default(1),
  bodyHeight: z.number().min(0.6).max(1.5).default(1),
  limbLength: z.number().min(0.6).max(1.5).default(1),
  limbWidth: z.number().min(0.6).max(1.6).default(1),
  eyeSize: z.number().min(0.5).max(1.8).default(1),
  eyeSpread: z.number().min(0.5).max(1.6).default(1),
});
export type Look = z.infer<typeof Look>;

/** Numeric look fields, with the ranges the editor should offer. */
export const LOOK_SLIDERS: Array<{ key: keyof Look; label: string; min: number; max: number }> = [
  { key: 'headSize', label: 'Head size', min: 0.6, max: 1.6 },
  { key: 'bodyWidth', label: 'Body width', min: 0.6, max: 1.6 },
  { key: 'bodyHeight', label: 'Body height', min: 0.6, max: 1.5 },
  { key: 'limbLength', label: 'Limb length', min: 0.6, max: 1.5 },
  { key: 'limbWidth', label: 'Limb width', min: 0.6, max: 1.6 },
  { key: 'eyeSize', label: 'Eye size', min: 0.5, max: 1.8 },
  { key: 'eyeSpread', label: 'Eye spacing', min: 0.5, max: 1.6 },
];
