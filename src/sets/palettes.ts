/**
 * Named palettes.
 *
 * Props never hardcode a colour — they pull from these slots. That is what lets
 * one prop library cover an office, a dive bar and a roadside at dusk: the same
 * `bar-counter` generator reads `wood` and `line`, and the palette decides
 * whether that means varnished pine under strip lights or something darker.
 *
 * Retinting an entire set is therefore a one-word change in its descriptor.
 */

export interface Palette {
  /** Outline colour. Heavy and near-black in every palette — it is the style. */
  line: string;

  ceiling: string;
  ceilingTrim: string;
  light: string;
  lightGlow: string;

  /** Wall, or sky in an exterior. */
  wall: string;
  /** Lower wall band, or distant ground haze outdoors. */
  wallLower: string;
  wallTrim: string;

  floor: string;
  floorDark: string;

  /** Partitions, counters, large flat built-ins. */
  surface: string;
  surfaceDark: string;
  surfaceTrim: string;

  wood: string;
  woodDark: string;
  metal: string;
  metalDark: string;
  fabric: string;
  fabricDark: string;

  screen: string;
  glass: string;
  foliage: string;
  foliageDark: string;
  clay: string;

  /** Signage, neon, anything meant to draw the eye. */
  accent: string;
  accentGlow: string;
}

export const PALETTES: Record<string, Palette> = {
  /**
   * The original office. Values carried over verbatim from the hardcoded set so
   * the migration is a like-for-like rebuild rather than a redesign.
   */
  'office-fluorescent': {
    line: '#26282c',
    ceiling: '#43474f',
    ceilingTrim: '#383c43',
    light: '#d8d2b4',
    lightGlow: '#b9b696',
    wall: '#8d8a76',
    wallLower: '#7c7a68',
    wallTrim: '#5d5c50',
    floor: '#4a4e54',
    floorDark: '#42464c',
    surface: '#9a9382',
    surfaceDark: '#867f70',
    surfaceTrim: '#5a564c',
    wood: '#6b5a48',
    woodDark: '#5a4c3c',
    metal: '#2f333a',
    metalDark: '#23262b',
    fabric: '#6f6a5c',
    fabricDark: '#5c584c',
    screen: '#5a6b6d',
    glass: '#7f8f92',
    foliage: '#4f6b42',
    foliageDark: '#3d5334',
    clay: '#7a5546',
    accent: '#b4744a',
    accentGlow: '#d69a6c',
  },

  /**
   * The same office after everyone has gone.
   *
   * Added because there was no dim interior that wasn't a bar: asked for an
   * empty lobby at night, the model had to choose between a lit office and
   * magenta neon, and picked the lit office. A "night" version of a workplace is
   * one of the two or three most useful environments in this genre — the room
   * that should have people in it and doesn't.
   */
  'office-night': {
    line: '#1a1c20',
    ceiling: '#26292f',
    ceilingTrim: '#1f2227',
    // One strip left on somewhere off-frame, rather than full lighting.
    light: '#6f7566',
    lightGlow: '#565b4d',
    wall: '#3f4243',
    wallLower: '#35383a',
    wallTrim: '#2a2c2e',
    floor: '#2b2f34',
    floorDark: '#25282d',
    surface: '#43443f',
    surfaceDark: '#383935',
    surfaceTrim: '#2b2c29',
    wood: '#3f362c',
    woodDark: '#332b23',
    metal: '#262a30',
    metalDark: '#1d2025',
    fabric: '#3a3830',
    fabricDark: '#2e2d27',
    // A monitor left on is often the only real light source in the shot.
    screen: '#3d5a5e',
    glass: '#5a686c',
    foliage: '#33452c',
    foliageDark: '#263521',
    clay: '#4c382e',
    accent: '#7a8f6a',
    accentGlow: '#9db487',
  },

  'bar-night': {
    line: '#17151a',
    ceiling: '#241f2b',
    ceilingTrim: '#1c1822',
    light: '#c8905a',
    lightGlow: '#9a6a3e',
    wall: '#3b3242',
    wallLower: '#312938',
    wallTrim: '#241d2c',
    floor: '#2a2431',
    floorDark: '#221d29',
    surface: '#4a3d4e',
    surfaceDark: '#3b3140',
    surfaceTrim: '#241d2c',
    wood: '#4f3626',
    woodDark: '#3c281c',
    metal: '#2b2a33',
    metalDark: '#1f1e26',
    fabric: '#5c2f38',
    fabricDark: '#46242c',
    screen: '#3f5257',
    glass: '#6d7f86',
    foliage: '#3c5238',
    foliageDark: '#2d3e2a',
    clay: '#5c3f33',
    accent: '#e0518a',
    accentGlow: '#ff7fb0',
  },

  'home-warm': {
    line: '#2a2119',
    ceiling: '#c8bba4',
    ceilingTrim: '#b3a68f',
    light: '#f0dcb0',
    lightGlow: '#d6bc8a',
    wall: '#c2ab8c',
    wallLower: '#ac9576',
    wallTrim: '#8a7458',
    floor: '#7a5b3f',
    floorDark: '#684c34',
    surface: '#b09371',
    surfaceDark: '#93795c',
    surfaceTrim: '#6d5940',
    wood: '#8a6340',
    woodDark: '#6f4e31',
    metal: '#5b5750',
    metalDark: '#454239',
    fabric: '#8a5a52',
    fabricDark: '#6f463f',
    screen: '#4a5558',
    glass: '#9fb0b4',
    foliage: '#5b7a46',
    foliageDark: '#456037',
    clay: '#9a6547',
    accent: '#c9803f',
    accentGlow: '#e8a765',
  },

  'exterior-day': {
    line: '#23282a',
    // Outdoors, "ceiling" is the upper sky band and "wall" the lower one.
    ceiling: '#7fa8c4',
    ceilingTrim: '#6f97b2',
    light: '#f5e9c4',
    lightGlow: '#e6d29a',
    wall: '#9cc0d6',
    wallLower: '#b3c9ae',
    wallTrim: '#7d9a7a',
    floor: '#7d8a63',
    floorDark: '#6c7855',
    surface: '#b0a894',
    surfaceDark: '#96907d',
    surfaceTrim: '#6f6a5a',
    wood: '#8a6a45',
    woodDark: '#6d5335',
    metal: '#6a7075',
    metalDark: '#52585c',
    fabric: '#8a7f6a',
    fabricDark: '#6f6555',
    screen: '#5a6b6d',
    glass: '#a9c4cc',
    foliage: '#4f7a3c',
    foliageDark: '#3b5e2c',
    clay: '#9a6547',
    accent: '#d4553f',
    accentGlow: '#ee7d63',
  },

  'exterior-dusk': {
    line: '#1b1a22',
    ceiling: '#3d3a5c',
    ceilingTrim: '#33314f',
    light: '#f0c07a',
    lightGlow: '#d19a52',
    wall: '#6a5675',
    wallLower: '#7d5f66',
    wallTrim: '#4d3d4a',
    floor: '#3c3742',
    floorDark: '#332f39',
    surface: '#5a4f5c',
    surfaceDark: '#48404a',
    surfaceTrim: '#332c36',
    wood: '#5c4530',
    woodDark: '#453324',
    metal: '#454a52',
    metalDark: '#33373d',
    fabric: '#5e4750',
    fabricDark: '#493740',
    screen: '#42555a',
    glass: '#7b8b96',
    foliage: '#33492f',
    foliageDark: '#263723',
    clay: '#6b4636',
    accent: '#e0754a',
    accentGlow: '#ffa070',
  },

  /** Flat and featureless. Useful for testing a rig against nothing. */
  void: {
    line: '#1a1a1a',
    ceiling: '#2b2f36',
    ceilingTrim: '#262a30',
    light: '#3a3f46',
    lightGlow: '#33383e',
    wall: '#2b2f36',
    wallLower: '#282c32',
    wallTrim: '#22262b',
    floor: '#24282e',
    floorDark: '#202329',
    surface: '#33383f',
    surfaceDark: '#2c3037',
    surfaceTrim: '#22262b',
    wood: '#3a332c',
    woodDark: '#2e2822',
    metal: '#33373d',
    metalDark: '#282c31',
    fabric: '#35313a',
    fabricDark: '#2b2830',
    screen: '#3a4548',
    glass: '#4d585c',
    foliage: '#33452e',
    foliageDark: '#273524',
    clay: '#4a382e',
    accent: '#6a6f78',
    accentGlow: '#828892',
  },
};

export const PALETTE_NAMES = Object.keys(PALETTES);

export function getPalette(name: string): Palette {
  const p = PALETTES[name];
  if (!p) {
    throw new Error(`unknown palette "${name}". Options: ${PALETTE_NAMES.join(', ')}`);
  }
  return p;
}
