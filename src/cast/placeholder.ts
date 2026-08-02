import { Rng, deriveSeed } from '../core/rng.ts';
import { MOUTH_SHAPES, Outfit, type Rig, type Part, type Pose, type Expression } from '../schema/index.ts';
import { activeStyle } from '../style/index.ts';
import { activeIdentity } from '../show/context.ts';
import { drawShape, drawStroke, rectPoints, ellipsePoints, type Point } from '../style/wobble.ts';
import { BUILD_SPECS, rollLook, type Look } from './look.ts';
import { defaultOutfit } from './ensemble.ts';
import { torsoPattern, collar, neckwear, hat, shoe, hatHeadroom, type WardrobeGeometry } from './wardrobe.ts';

/**
 * Placeholder puppet generator.
 *
 * Produces a character — shapes, a face, a full A-X mouth set — that satisfies
 * the same rig manifest a hand-drawn puppet will. The point is that the engine
 * never knows the difference: swapping in real artwork later is a file
 * replacement, not a code change.
 *
 * Appearance comes entirely from a `Look` descriptor. Pass one to draw a
 * character the editor has adjusted; omit it and one is rolled from the name,
 * so an undirected cast is still visually distinct without anyone choosing.
 */

/** Puppet-local drawing box. All coordinates below are in this space. */
const W = 200;
const H = 400;

/** Mouth variants beyond the lipsync alphabet — held while a character is silent. */
export const REST_MOUTHS = ['smile', 'frown', 'smirk', 'grimace', 'oh'] as const;

export const EYE_VARIANTS = ['open', 'half', 'wide', 'closed', 'squint', 'side'] as const;
export const BROW_VARIANTS = [
  'neutral', 'flat', 'angry', 'raised', 'sad', 'confused', 'worried', 'single',
] as const;

interface Proportions {
  look: Look;
  headR: number;
  headCx: number;
  headCy: number;
  /** Head half-width at the hairline, eye line and jaw, as fractions of headR. */
  crownW: number;
  sideW: number;
  jawW: number;
  halfH: number;
  neckTop: number;
  bodyTop: number;
  bodyBottom: number;
  bodyHalfW: number;
  shoulderY: number;
  hipY: number;
  armUpperLen: number;
  armForeLen: number;
  legLen: number;
  limbW: number;
  eyeSpread: number;
  eyeR: number;
  eyeCy: number;
  browY: number;
  noseCy: number;
  mouthCy: number;
}

/**
 * Head silhouettes, and the widths that everything else hangs off.
 *
 * Ears, hair and beards all need to know how wide the head is at their own
 * height. Deriving that from the outline for each shape independently is how
 * you end up with ears floating beside a narrow head — so each shape declares
 * its own measurements once, here.
 */
const HEAD_METRICS: Record<Look['head'], { crownW: number; sideW: number; jawW: number; halfH: number }> = {
  round: { crownW: 0.92, sideW: 1.0, jawW: 0.86, halfH: 0.99 },
  wide: { crownW: 1.06, sideW: 1.16, jawW: 1.0, halfH: 0.84 },
  long: { crownW: 0.72, sideW: 0.8, jawW: 0.7, halfH: 1.2 },
  square: { crownW: 0.94, sideW: 0.94, jawW: 0.94, halfH: 0.96 },
  egg: { crownW: 0.78, sideW: 1.0, jawW: 0.9, halfH: 1.0 },
  pointed: { crownW: 0.9, sideW: 1.02, jawW: 0.62, halfH: 1.02 },
};

function headPoints(p: Proportions): Point[] {
  const cx = p.headCx;
  const cy = p.headCy;
  const r = p.headR;

  switch (p.look.head) {
    case 'wide':
      return ellipsePoints(cx, cy, r * 1.16, r * 0.84, 18);
    case 'long':
      return ellipsePoints(cx, cy, r * 0.8, r * 1.2, 18);
    case 'square':
      return rectPoints(cx - r * 0.94, cy - r * 0.96, r * 1.88, r * 1.92, r * 0.3);
    case 'egg':
      // Narrow crown, heavy jaw. Reads as jowly.
      return [
        [cx - r * 0.72, cy - r * 0.86], [cx + r * 0.72, cy - r * 0.86],
        [cx + r * 1.0, cy - r * 0.1], [cx + r * 0.92, cy + r * 0.7],
        [cx + r * 0.44, cy + r * 1.0], [cx - r * 0.44, cy + r * 1.0],
        [cx - r * 0.92, cy + r * 0.7], [cx - r * 1.0, cy - r * 0.1],
      ];
    case 'pointed':
      // Wide crown tapering to a chin. Reads as sly.
      return [
        [cx - r * 0.88, cy - r * 0.8], [cx + r * 0.88, cy - r * 0.8],
        [cx + r * 1.02, cy - r * 0.05], [cx + r * 0.66, cy + r * 0.66],
        [cx + r * 0.2, cy + r * 1.02], [cx - r * 0.2, cy + r * 1.02],
        [cx - r * 0.66, cy + r * 0.66], [cx - r * 1.02, cy - r * 0.05],
      ];
    case 'round':
    default:
      return ellipsePoints(cx, cy, r, r * 0.99, 18);
  }
}

/**
 * Clip a closed polygon against a horizontal line.
 *
 * Hair caps and beards are the head's own outline with the rest cut away, which
 * means they follow whatever silhouette the character has instead of each
 * hairstyle needing a variant per head shape.
 */
function clipY(points: Point[], y: number, keep: 'above' | 'below'): Point[] {
  const inside = (pt: Point) => (keep === 'above' ? pt[1] <= y : pt[1] >= y);
  const out: Point[] = [];
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const ain = inside(a);
    if (ain) out.push(a);
    // Only crossing edges need a cut point, and a crossing edge always spans
    // two different y values, so this never divides by zero.
    if (ain !== inside(b)) {
      const t = (y - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, y]);
    }
  }
  return out;
}

/**
 * The crown height above a given column of the head.
 *
 * Hair decorations — spikes, curls, a topknot — have to sit *on* the skull, and
 * the skull is a different height at every x and a different shape for every
 * character. Placing them at a fixed fraction of the head radius floats them off
 * a narrow head and buries them in a wide one, so they ask the outline instead.
 */
function outlineTop(points: Point[], x: number): number {
  let best = Infinity;
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
    // A vertical edge contributes its own endpoint; the edges meeting it supply
    // the rest, so the minimum is still correct.
    const t = a[0] === b[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
    const y = a[1] + (b[1] - a[1]) * t;
    if (y < best) best = y;
  }
  return Number.isFinite(best) ? best : points[0]![1];
}

/** Half-width of the outline at a given height. Ears and sideburns hang off this. */
function outlineHalf(points: Point[], y: number, cx: number): number {
  let best = 0;
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (y < Math.min(a[1], b[1]) || y > Math.max(a[1], b[1])) continue;
    const t = a[1] === b[1] ? 0 : (y - a[1]) / (b[1] - a[1]);
    const d = Math.abs(a[0] + (b[0] - a[0]) * t - cx);
    if (d > best) best = d;
  }
  return best;
}

/** Blend two hex colours. `t` of 0 gives `a`, 1 gives `b`. */
function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(a) as [number, number, number];
  const [r2, g2, b2] = parse(b) as [number, number, number];
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/**
 * Joint positions, derived in one place.
 *
 * The rig manifest and the SVG both need these, and if they ever disagree the
 * puppet rotates about points that aren't where its joints are drawn — limbs
 * detach and swing from empty space. Computing them once removes that whole
 * class of bug.
 */
function joints(p: Proportions) {
  return {
    shoulderL: W / 2 - p.bodyHalfW + 6,
    shoulderR: W / 2 + p.bodyHalfW - 6,
    hipL: W / 2 - p.bodyHalfW * 0.42,
    hipR: W / 2 + p.bodyHalfW * 0.42,
    elbowY: p.shoulderY + p.armUpperLen,
    wristY: p.shoulderY + p.armUpperLen + p.armForeLen,
  };
}

/** Look -> geometry. Pure, so the same look always draws the same puppet. */
function proportionsFor(look: Look): Proportions {
  const spec = BUILD_SPECS[look.build];
  const m = HEAD_METRICS[look.head];

  const headR = 52 * spec.head * look.headSize;
  const headCy = headR * m.halfH + 12;
  // Torso top sits just below the head with a short neck showing between them,
  // and every other joint is placed *inside* the neighbouring shape so the
  // pieces overlap rather than merely abut.
  const bodyTop = headCy + headR * m.halfH * 0.86;
  // Builds stretch the torso about its top, so the feet stay near the anchor and
  // characters of different builds still stand on the same floor.
  const bodyBottom = bodyTop + (282 - bodyTop) * spec.bodyHeight * look.bodyHeight;
  const bodyHalfW = 43 * spec.bodyWidth * look.bodyWidth;
  const hipY = bodyBottom - 24;

  return {
    look,
    headR,
    headCx: W / 2,
    headCy,
    crownW: m.crownW,
    sideW: m.sideW,
    jawW: m.jawW,
    halfH: m.halfH,
    neckTop: headCy + headR * m.halfH * 0.55,
    bodyTop,
    bodyBottom,
    bodyHalfW,
    shoulderY: bodyTop + 24,
    hipY,
    armUpperLen: 62 * spec.limbLength * look.limbLength,
    armForeLen: 53 * spec.limbLength * look.limbLength,
    legLen: H - hipY - 6,
    limbW: 18 * spec.limbWidth * look.limbWidth,
    eyeSpread: headR * 0.41 * look.eyeSpread,
    eyeR: headR * 0.19 * look.eyeSize,
    eyeCy: headCy - headR * m.halfH * 0.1,
    // Far enough above the eye to clear a spectacle frame, since a brow trapped
    // inside a lens rim stops reading as a brow.
    browY: headCy - headR * m.halfH * 0.1 - headR * 0.19 * look.eyeSize * 1.75 - headR * 0.05,
    noseCy: headCy + headR * m.halfH * 0.18,
    mouthCy: headCy + headR * m.halfH * 0.52,
  };
}

/**
 * A viewBox tight around the head.
 *
 * Used to crop a full-body puppet down to a face plate. Derived from the look
 * where there is one; a hand-drawn puppet only advertises its `focus` point, so
 * that gets a generous guess instead — too wide is survivable, too tight cuts
 * someone's hair off.
 */
export function faceBox(rig: {
  canvas: { width: number; height: number };
  focus?: [number, number];
  look?: Look;
  outfit?: Outfit;
}): { x: number; y: number; w: number; h: number } {
  if (rig.look) {
    const p = proportionsFor(rig.look);
    // Wide enough for stuck-out ears and a ponytail, tall enough for a topknot
    // — and taller again when a hat adds real height above the crown.
    const half = p.headR * Math.max(p.sideW + 0.34, p.halfH + 0.5);
    const above = rig.outfit ? hatHeadroom(rig.outfit, p.headR) : 0;
    return { x: p.headCx - half, y: p.headCy - half - above, w: half * 2, h: half * 2 + above };
  }
  const [fx, fy] = rig.focus ?? [rig.canvas.width / 2, rig.canvas.height * 0.16];
  const half = rig.canvas.width * 0.5;
  return { x: fx - half, y: fy - half, w: half * 2, h: half * 2 };
}

/** Part tree. Nesting mirrors the SVG group nesting, so transforms cascade for free. */
function buildParts(p: Proportions): Part[] {
  const j = joints(p);

  return [
    { id: 'torso', parent: null, pivot: [W / 2, p.hipY], z: 0 },
    { id: 'leg_L', parent: 'torso', pivot: [j.hipL, p.hipY], z: -1 },
    { id: 'leg_R', parent: 'torso', pivot: [j.hipR, p.hipY], z: -1 },
    { id: 'arm_L_upper', parent: 'torso', pivot: [j.shoulderL, p.shoulderY], z: 1 },
    { id: 'arm_L_fore', parent: 'arm_L_upper', pivot: [j.shoulderL, j.elbowY], z: 1 },
    { id: 'arm_R_upper', parent: 'torso', pivot: [j.shoulderR, p.shoulderY], z: 1 },
    { id: 'arm_R_fore', parent: 'arm_R_upper', pivot: [j.shoulderR, j.elbowY], z: 1 },
    // Head rotates about the base of the neck, not the top of the torso.
    { id: 'head', parent: 'torso', pivot: [W / 2, p.bodyTop], z: 2 },
  ];
}

/**
 * Static body poses. Deliberately few and deliberately broad — limited animation
 * snaps between held poses rather than blending through a continuum, so a small
 * vocabulary is a feature.
 */
function buildPoses(): Pose[] {
  const t = (rot: number, x = 0, y = 0, scale = 1) => ({ rot, x, y, scale });
  return [
    { name: 'IDLE', parts: { arm_L_upper: t(6), arm_R_upper: t(-6), arm_L_fore: t(4), arm_R_fore: t(-4) } },
    // Bent at the elbow and angled slightly down. A straight horizontal arm
    // reads as a zombie rather than as someone making a point.
    { name: 'POINT', parts: { arm_R_upper: t(-68), arm_R_fore: t(-34), arm_L_upper: t(8), arm_L_fore: t(6) } },
    { name: 'SHRUG', parts: { arm_L_upper: t(38), arm_R_upper: t(-38), arm_L_fore: t(58), arm_R_fore: t(-58), head: t(0, 0, 4) } },
    { name: 'ARMS_UP', parts: { arm_L_upper: t(148), arm_R_upper: t(-148), arm_L_fore: t(18), arm_R_fore: t(-18) } },
    { name: 'LEAN_IN', parts: { torso: t(-7, 0, 6), head: t(4), arm_L_upper: t(14), arm_R_upper: t(-10) } },
    // Two talk poses the compiler alternates between while a character speaks.
    { name: 'TALK_A', parts: { arm_L_upper: t(16), arm_L_fore: t(38), arm_R_upper: t(-8), arm_R_fore: t(-12) } },
    { name: 'TALK_B', parts: { arm_L_upper: t(9), arm_L_fore: t(20), arm_R_upper: t(-18), arm_R_fore: t(-42) } },
  ];
}

/**
 * Face states.
 *
 * Each drives three slots rather than two: the resting mouth is part of the
 * expression, so a silent character holds a smirk or a grimace instead of the
 * same neutral line on every face. The lipsync stage overrides the mouth only
 * while they are actually speaking, so this costs nothing during dialogue and
 * does all the work during the pauses — which in this genre is where the joke
 * usually is.
 *
 * DEADPAN is separate from NEUTRAL on purpose: the blank unimpressed stare is
 * the single most-used expression in the style and deserves to be directly
 * requestable.
 */
export const EXPRESSION_NAMES = [
  'NEUTRAL', 'DEADPAN', 'ANGRY', 'SHOCKED', 'SMUG', 'SAD',
  'CONFUSED', 'JOY', 'SUSPICIOUS', 'EXHAUSTED',
] as const;

function buildExpressions(): Expression[] {
  const e = (
    name: string,
    eyes: string,
    brows: string,
    mouth: string,
    parts: Expression['parts'] = {},
    suppressBlink = false,
  ): Expression => ({
    name,
    swaps: { eyes: `eyes_${eyes}`, brows: `brows_${brows}`, mouth: `mouth_${mouth}` },
    parts,
    suppressBlink,
  });

  return [
    e('NEUTRAL', 'open', 'neutral', 'X'),
    e('DEADPAN', 'half', 'flat', 'X'),
    e('ANGRY', 'squint', 'angry', 'grimace'),
    e('SHOCKED', 'wide', 'raised', 'oh', {}, true),
    e('SMUG', 'half', 'single', 'smirk', { head: { rot: -4, x: 0, y: 0, scale: 1 } }),
    e('SAD', 'half', 'sad', 'frown', { head: { rot: 0, x: 0, y: 3, scale: 1 } }),
    e('CONFUSED', 'open', 'confused', 'X', { head: { rot: 7, x: 0, y: 0, scale: 1 } }),
    e('JOY', 'squint', 'raised', 'smile', { head: { rot: 0, x: 0, y: -2, scale: 1 } }),
    e('SUSPICIOUS', 'side', 'single', 'flat', { head: { rot: -3, x: 0, y: 0, scale: 1 } }),
    e('EXHAUSTED', 'half', 'worried', 'frown', { head: { rot: 2, x: 0, y: 5, scale: 1 } }),
  ];
}

export function buildPlaceholderRig(name: string, look?: Look, outfit?: Outfit): Rig {
  const resolved = look ?? rollLook(name);
  const wardrobe = outfit ?? defaultOutfit(activeIdentity(), name);
  const p = proportionsFor(resolved);
  // Separate stream from the look, so changing the palette later can't silently
  // recast everyone's voice.
  const voiceRng = new Rng(deriveSeed(0x0173, name.toLowerCase()));

  return {
    name,
    canvas: { width: W, height: H },
    anchor: [W / 2, H],
    focus: [p.headCx, p.headCy],
    look: resolved,
    outfit: wardrobe,
    locks: [],
    parts: buildParts(p),
    swapSets: [
      {
        slot: 'mouth',
        variants: [
          ...MOUTH_SHAPES.map((s) => `mouth_${s}`),
          ...REST_MOUTHS.map((s) => `mouth_${s}`),
          'mouth_flat',
        ],
        default: 'mouth_X',
      },
      {
        slot: 'eyes',
        variants: EYE_VARIANTS.map((v) => `eyes_${v}`),
        default: 'eyes_open',
      },
      {
        slot: 'brows',
        variants: BROW_VARIANTS.map((v) => `brows_${v}`),
        default: 'brows_neutral',
      },
    ],
    poses: buildPoses(),
    expressions: buildExpressions(),
    idle: { breathAmplitude: 3, breathPeriod: 4, blinkRateHz: 0.45, blinkDuration: 0.12 },
    // Voice is rolled from the name like everything else, so two characters in
    // a scene don't sound identical by default.
    voice: voiceRng.pick(['David', 'Zira']),
    voiceRate: voiceRng.int(-2, 1),
    // No reference clip by default. Minting (or a recording) attaches one; a
    // cloning engine then makes the character sound like that.
    voiceRef: null,
    voiceProvenance: null,
    // Delivery personality: how hot and how quick this character runs relative
    // to the expression's baseline. Small ranges — a persona is a voice, not a
    // different show.
    voicePersona: {
      energy: Math.round(voiceRng.range(0.85, 1.2) * 100) / 100,
      pace: Math.round(voiceRng.range(0.88, 1.15) * 100) / 100,
    },
    svg: `${name}.svg`,
  };
}

// --- face -----------------------------------------------------------------

/**
 * Mouth geometry, keyed by Rhubarb letter plus the resting shapes.
 *
 * Every articulation stays wider than it is tall, except the deliberate pucker.
 * A near-circular mouth reads as a permanent cartoon "OH" rather than as speech,
 * and at conversational speed that is what the eye latches onto.
 */
function mouthShape(shape: string, p: Proportions): string {
  const c = p.look;
  const cx = p.headCx;
  const cy = p.mouthCy;
  const r = p.headR;
  const dark = '#4a1f1f';
  const teeth = '#f2ede4';
  const tongue = '#c96a6a';
  const w = r * 0.5;
  const lip = `stroke="${c.line}" stroke-width="4" fill="none" stroke-linecap="round"`;

  switch (shape) {
    // A: closed, for M/B/P. A pressed line, slightly wider than rest.
    case 'A':
      return `<path d="M ${cx - w} ${cy} Q ${cx} ${cy + 3} ${cx + w} ${cy}" ${lip}/>`;
    // B: slightly open, teeth nearly together — K, S, T, EE.
    case 'B':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.78}" ry="${r * 0.09}" fill="${dark}"/>`;
    // C: open — EH, AE.
    case 'C':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.74}" ry="${r * 0.18}" fill="${dark}"/>`;
    // D: wide open — AA. The big one, but still an oval, not a hole.
    case 'D':
      return `<ellipse cx="${cx}" cy="${cy + 2}" rx="${w * 0.82}" ry="${r * 0.3}" fill="${dark}"/><ellipse cx="${cx}" cy="${cy + r * 0.22}" rx="${w * 0.42}" ry="${r * 0.1}" fill="${tongue}"/>`;
    // E: rounded, part open — AO, ER.
    case 'E':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.46}" ry="${r * 0.19}" fill="${dark}"/>`;
    // F: puckered — UW, OW, W. The one shape allowed to be tall and narrow.
    case 'F':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.3}" ry="${r * 0.16}" fill="${dark}"/>`;
    // G: F/V — upper teeth resting on lower lip.
    case 'G':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.66}" ry="${r * 0.12}" fill="${dark}"/><rect x="${cx - w * 0.52}" y="${cy - r * 0.12}" width="${w * 1.04}" height="${r * 0.08}" fill="${teeth}"/>`;
    // H: L — tongue tip visible behind the upper teeth.
    case 'H':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.62}" ry="${r * 0.21}" fill="${dark}"/><ellipse cx="${cx}" cy="${cy + r * 0.04}" rx="${w * 0.24}" ry="${r * 0.11}" fill="${tongue}"/>`;

    // --- resting shapes: held while silent, never produced by lipsync ---
    case 'smile':
      return `<path d="M ${cx - w * 0.92} ${cy - r * 0.06} Q ${cx} ${cy + r * 0.2} ${cx + w * 0.92} ${cy - r * 0.06}" ${lip}/>`;
    case 'frown':
      return `<path d="M ${cx - w * 0.82} ${cy + r * 0.08} Q ${cx} ${cy - r * 0.14} ${cx + w * 0.82} ${cy + r * 0.08}" ${lip}/>`;
    // Asymmetric on purpose — a symmetrical smirk is just a small smile.
    case 'smirk':
      return `<path d="M ${cx - w * 0.78} ${cy + r * 0.04} Q ${cx + w * 0.1} ${cy + r * 0.08} ${cx + w * 0.86} ${cy - r * 0.12}" ${lip}/>`;
    // Clenched teeth. The white band has to stay a band — let it fill the
    // opening and the mouth reads as a bright slot rather than as a snarl.
    case 'grimace': {
      const gw = w * 0.9;
      const gh = r * 0.13;
      let out =
        `<path d="M ${cx - gw} ${cy - gh * 0.5} L ${cx + gw} ${cy - gh * 0.5} ` +
        `L ${cx + gw * 0.84} ${cy + gh} L ${cx - gw * 0.84} ${cy + gh} Z" ` +
        `fill="${dark}" stroke="${c.line}" stroke-width="2.5" stroke-linejoin="round"/>` +
        `<rect x="${cx - gw * 0.96}" y="${cy - gh * 0.5}" width="${gw * 1.92}" height="${gh * 0.52}" fill="${teeth}"/>`;
      for (let i = -2; i <= 2; i++) {
        const tx = cx + i * gw * 0.34;
        out += `<path d="M ${tx} ${cy - gh * 0.5} L ${tx} ${cy + gh * 0.02}" stroke="${c.line}" stroke-width="1.2" opacity="0.5"/>`;
      }
      return out;
    }
    case 'oh':
      return `<ellipse cx="${cx}" cy="${cy + 2}" rx="${w * 0.44}" ry="${r * 0.26}" fill="${dark}"/>`;
    case 'flat':
      return `<path d="M ${cx - w * 0.86} ${cy} L ${cx + w * 0.86} ${cy}" stroke="${c.line}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;

    // X: rest. Distinct from A — this is the silent idle mouth, not an articulation.
    case 'X':
    default:
      return `<path d="M ${cx - w * 0.8} ${cy} L ${cx + w * 0.8} ${cy}" stroke="${c.line}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  }
}

/** Base eye geometry per style, as multipliers on the rolled eye radius. */
const EYE_GEOM: Record<Look['eyes'], { rx: number; ry: number; pupil: number; white: boolean }> = {
  round: { rx: 1.0, ry: 1.0, pupil: 0.42, white: true },
  oval: { rx: 1.24, ry: 0.84, pupil: 0.34, white: true },
  dot: { rx: 0.46, ry: 0.46, pupil: 1.0, white: false },
  beady: { rx: 0.66, ry: 0.66, pupil: 0.5, white: true },
  hooded: { rx: 1.08, ry: 0.76, pupil: 0.4, white: true },
  googly: { rx: 1.34, ry: 1.34, pupil: 0.26, white: true },
};

function eyeSet(variant: string, p: Proportions): string {
  const c = p.look;
  const g = EYE_GEOM[c.eyes];
  const lx = p.headCx - p.eyeSpread;
  const rx = p.headCx + p.eyeSpread;
  const cy = p.eyeCy;
  const base = p.eyeR;

  // Closed reads the same whatever the eye style: a lid is a lid.
  if (variant === 'closed') {
    const w = base * g.rx;
    const arc = (x: number) =>
      `<path d="M ${x - w} ${cy} Q ${x} ${cy + w * 0.7} ${x + w} ${cy}" stroke="${c.line}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    return arc(lx) + arc(rx);
  }

  // Styles without a white are just pupils, so lids would have nothing to cover:
  // they narrow instead.
  if (!g.white) {
    const squash = variant === 'half' ? 0.45 : variant === 'squint' ? 0.28 : variant === 'wide' ? 1.5 : 1;
    const shift = variant === 'side' ? base * 0.5 : 0;
    const dot = (x: number) =>
      `<ellipse cx="${x + shift}" cy="${cy}" rx="${base * g.rx}" ry="${base * g.ry * squash}" fill="${c.line}"/>`;
    return dot(lx) + dot(rx);
  }

  let rxE = base * g.rx;
  let ryE = base * g.ry;
  let pupil = base * g.pupil;
  let pupilDx = 0;
  let pupilDy = 0;

  switch (variant) {
    case 'wide':
      ryE *= 1.35;
      pupil *= 0.72;
      break;
    case 'squint':
      ryE *= 0.42;
      pupil *= 0.9;
      break;
    case 'side':
      // Pupils cut to one side without the head turning: the shifty look, and
      // the cheapest way to show a character checking whether anyone noticed.
      pupilDx = rxE * 0.46;
      break;
    case 'half':
      pupilDy = ryE * 0.18;
      break;
  }

  const eye = (x: number) =>
    `<ellipse cx="${x}" cy="${cy}" rx="${rxE}" ry="${ryE}" fill="#ffffff" stroke="${c.line}" stroke-width="2"/>` +
    `<circle cx="${x + pupilDx}" cy="${cy + pupilDy}" r="${pupil}" fill="${c.line}"/>`;

  let out = eye(lx) + eye(rx);

  // A lid is drawn as a skin-coloured cap over the top of the white, plus a lash
  // line where it lands — which is what actually sells it as a lid rather than
  // as a smaller eye.
  const lid = (x: number, drop: number) =>
    `<rect x="${x - rxE - 1}" y="${cy - ryE - 2}" width="${rxE * 2 + 2}" height="${ryE + 2 - drop}" fill="${c.skin}"/>` +
    `<path d="M ${x - rxE} ${cy - drop} L ${x + rxE} ${cy - drop}" stroke="${c.line}" stroke-width="2.5" stroke-linecap="round"/>`;

  if (variant === 'half') out += lid(lx, 0) + lid(rx, 0);
  if (variant === 'squint') {
    out += lid(lx, ryE * 0.5) + lid(rx, ryE * 0.5);
    // A lower lid too — squinting closes from both sides, and without the bottom
    // edge it reads as sleepy rather than as sceptical.
    const under = (x: number) =>
      `<path d="M ${x - rxE} ${cy + ryE * 0.55} L ${x + rxE} ${cy + ryE * 0.55}" stroke="${c.line}" stroke-width="2.2" stroke-linecap="round"/>`;
    out += under(lx) + under(rx);
  }
  // Hooded eyes carry a permanent heavy lid, whatever they are doing.
  if (c.eyes === 'hooded' && variant !== 'half' && variant !== 'squint') {
    const hood = (x: number) =>
      `<path d="M ${x - rxE * 1.05} ${cy - ryE * 0.55} Q ${x} ${cy - ryE * 1.25} ${x + rxE * 1.05} ${cy - ryE * 0.55}" ` +
      `stroke="${c.line}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    out += hood(lx) + hood(rx);
  }

  return out;
}

/** [left tilt, right tilt, vertical offset] — positive tilt lowers the inner end. */
const BROW_SHAPES: Record<string, [number, number, number]> = {
  neutral: [0, 0, 0],
  flat: [0, 0, 3],
  angry: [10, -10, 4],
  raised: [-6, 6, -7],
  sad: [-11, 11, 1],
  confused: [-12, 3, -4],
  worried: [-7, 7, -2],
  // One brow steeply up: scepticism, and the only face that reads as a question
  // without a question mark.
  single: [-16, 2, -5],
};

function browSet(variant: string, p: Proportions): string {
  const c = p.look;
  const lx = p.headCx - p.eyeSpread;
  const rx = p.headCx + p.eyeSpread;
  const y = p.browY;
  const [lt, rt, dy] = BROW_SHAPES[variant] ?? BROW_SHAPES['neutral']!;

  // Brows are the loudest thing on the face and have to read at every size.
  // Drawing them in the raw hair colour loses them entirely on a blond
  // character — sandy hair on tan skin is nearly the same value — so they are
  // pulled most of the way toward the line colour first.
  const ink = mix(c.hairColour, c.line, 0.55);

  const spec = {
    thin: { w: 4, len: 1.2 },
    thick: { w: 6.5, len: 1.25 },
    bushy: { w: 0, len: 1.4 },
    sparse: { w: 3, len: 1.0 },
    angled: { w: 5, len: 1.35 },
  }[c.brows];

  const hw = p.eyeR * spec.len;
  const style = activeStyle();

  // Bushy brows are a filled shape rather than a stroke — at this line weight a
  // thick stroke just reads as a thicker line, not as hair.
  if (spec.w === 0) {
    const th = p.eyeR * 0.44;
    const brow = (x: number, tilt: number): Point[] => [
      [x - hw, y + dy + tilt - th / 2],
      [x + hw, y + dy - tilt - th / 2],
      [x + hw, y + dy - tilt + th / 2],
      [x - hw, y + dy + tilt + th / 2],
    ];
    return drawShape(brow(lx, lt), style, ink, c.line) + drawShape(brow(rx, rt), style, ink, c.line);
  }

  const stroke = `stroke="${ink}" stroke-width="${spec.w}" fill="none" stroke-linecap="round"`;
  return (
    `<path d="M ${lx - hw} ${y + dy + lt} L ${lx + hw} ${y + dy - lt}" ${stroke}/>` +
    `<path d="M ${rx - hw} ${y + dy + rt} L ${rx + hw} ${y + dy - rt}" ${stroke}/>`
  );
}

function nose(p: Proportions): string {
  const c = p.look;
  const cx = p.headCx;
  const cy = p.noseCy;
  const r = p.headR;
  const style = activeStyle();

  switch (c.nose) {
    case 'none':
      return '';
    case 'button':
      return drawShape(ellipsePoints(cx, cy, r * 0.11, r * 0.09, 10), style, c.skin, c.line);
    case 'bulb':
      return drawShape(ellipsePoints(cx, cy + r * 0.02, r * 0.17, r * 0.15, 12), style, c.skin, c.line);
    case 'wide':
      return drawShape(ellipsePoints(cx, cy, r * 0.22, r * 0.09, 12), style, c.skin, c.line);
    case 'pointed':
      return drawShape(
        [[cx, cy - r * 0.18], [cx + r * 0.12, cy + r * 0.1], [cx - r * 0.12, cy + r * 0.1]],
        style, c.skin, c.line,
      );
    case 'beak':
      return drawShape(
        [[cx - r * 0.09, cy - r * 0.22], [cx + r * 0.09, cy - r * 0.22], [cx + r * 0.05, cy + r * 0.22], [cx - r * 0.05, cy + r * 0.22]],
        style, c.skin, c.line,
      );
    case 'hook':
    default:
      return (
        drawShape(
          [[cx - r * 0.06, cy - r * 0.2], [cx + r * 0.1, cy - r * 0.14], [cx + r * 0.17, cy + r * 0.12], [cx - r * 0.02, cy + r * 0.14]],
          style, c.skin, c.line,
        ) +
        drawStroke([[cx + r * 0.17, cy + r * 0.12], [cx + r * 0.04, cy + r * 0.18]], style, c.line, 2.5)
      );
  }
}

function ears(p: Proportions, head: Point[]): string {
  const c = p.look;
  if (c.ears === 'none') return '';

  const style = activeStyle();
  const y = p.eyeCy + p.headR * 0.06;
  const size = { small: 0.15, large: 0.22, 'stuck-out': 0.19 }[c.ears];
  // Anchored to the silhouette at ear height, so they touch a narrow head
  // instead of floating beside it.
  const x = outlineHalf(head, y, p.headCx) + (c.ears === 'stuck-out' ? p.headR * 0.1 : 0);

  const ear = (sx: number) =>
    drawShape(
      ellipsePoints(p.headCx + sx * x, y, p.headR * size * 0.72, p.headR * size, 10),
      style, c.skin, c.line,
    );

  return ear(-1) + ear(1);
}

/**
 * Hair, in two pieces: what falls behind the head and what sits on top of it.
 *
 * The cap is the head's own outline clipped at the hairline, so every style
 * follows whatever silhouette the character has rather than needing a variant
 * per head shape.
 */
function hair(p: Proportions, head: Point[], underHat = false): { back: string; front: string } {
  const c = p.look;
  const style = activeStyle();
  const r = p.headR;
  const cx = p.headCx;
  const cy = p.headCy;
  const fill = c.hairColour;

  if (c.hair === 'bald') return { back: '', front: '' };

  /**
   * No hairstyle may come down past the brows.
   *
   * Brows are drawn over the hair, so an overhanging fringe doesn't hide them —
   * it lands *on* them, and a brow sitting exactly on the cap's bottom edge
   * reads as part of the cap. Every expression then looks identical from a
   * distance, which is the whole game lost. Clamping here means a forehead
   * always exists, whatever the style asked for.
   *
   * The wobble is subtracted because the clip line is where the geometry ends
   * and the *drawn* edge is what has to clear the brows — the style displaces
   * outlines by up to a full amplitude, which is easily enough to close a gap
   * this small.
   */
  const limit = p.browY - r * 0.16 - style.wobble;
  // The cap is grouped separately from the decorations because only the cap is
  // subject to the clamp. A curl or a sideburn hanging past the brow line at the
  // temple is hair behaving like hair; a fringe doing it across the forehead is
  // the bug.
  const cap = (atY: number) =>
    `<g id="hair_cap">${drawShape(clipY(head, Math.min(atY, limit), 'above'), style, fill, c.line)}</g>`;
  const line = Math.min(cy - r * p.halfH * 0.44, limit);
  // Where the skull actually is, rather than where a circle would put it.
  const crown = (x: number) => outlineTop(head, x);
  const side = (y: number) => outlineHalf(head, y, cx);
  // Decorations stay well inside the widest part of the crown, so a narrow head
  // doesn't wear its spikes beside its ears.
  const span = r * p.crownW * 0.38;

  let back = '';
  let front = '';

  // A hat covers the crown, so styles whose identity lives in decorations
  // above it fall back to the plain cap — curls poking out around a beanie
  // read as animal ears, not as hair. Side and back pieces (sideburns,
  // ponytail) survive; they hang below the hat line.
  const style_ = c.hair;
  const hatted = underHat && ['spikes', 'bun', 'tall', 'curly', 'combover'].includes(style_)
    ? 'crop'
    : style_;

  switch (hatted) {
    case 'receding': {
      front = cap(cy - r * p.halfH * 0.68);
      // Two temple wedges, which is what actually reads as receding — a high
      // fringe on its own just looks like a smaller cap.
      const y1 = cy - r * p.halfH * 0.62;
      const y2 = cy - r * p.halfH * 0.14;
      const wedge = (sx: number): Point[] => [
        [cx + sx * side(y1) * 0.98, y1],
        [cx + sx * side(y2) * 0.96, y2],
        [cx + sx * side(y2) * 0.58, y2 - r * 0.06],
        [cx + sx * side(y1) * 0.5, y1],
      ];
      front += drawShape(wedge(-1), style, fill, c.line) + drawShape(wedge(1), style, fill, c.line);
      break;
    }
    case 'combover': {
      front = cap(line);
      // A single sweep across the top, which is the entire comedy of the thing.
      const lx = cx - span * 2.2;
      const rx = cx + span * 2.2;
      front += drawShape(
        [
          [lx, crown(lx) + r * 0.3],
          [rx, crown(rx) + r * 0.02],
          [rx, crown(rx) + r * 0.22],
          [lx, crown(lx) + r * 0.5],
        ],
        style, fill, c.line,
      );
      break;
    }
    case 'mop': {
      front = cap(cy - r * p.halfH * 0.28);
      // Sideburns down past the ears — the fringe alone reads as a helmet.
      const y1 = cy - r * p.halfH * 0.44;
      const y2 = cy + r * p.halfH * 0.2;
      const chunk = (sx: number): Point[] => [
        [cx + sx * side(y1), y1],
        [cx + sx * side(y2) * 0.99, y2],
        [cx + sx * side(y2) * 0.6, y2 - r * 0.12],
        [cx + sx * side(y1) * 0.62, y1],
      ];
      front += drawShape(chunk(-1), style, fill, c.line) + drawShape(chunk(1), style, fill, c.line);
      break;
    }
    case 'tall': {
      front = cap(line);
      const w = span * 1.7;
      const base = crown(cx) + r * 0.16;
      front += drawShape(
        rectPoints(cx - w, base - r * 0.62, w * 2, r * 0.78, r * 0.12),
        style, fill, c.line,
      );
      break;
    }
    case 'side-part': {
      front = cap(line);
      // The parting itself: a narrow strip of scalp, drawn as a stroke so it
      // can never poke out past the silhouette the way a polygon could.
      const px = cx - span * 0.8;
      front += drawStroke(
        [[px, crown(px) + r * 0.12], [px - r * 0.05, line - r * 0.02]],
        style, c.skin, r * 0.11,
      );
      break;
    }
    case 'spikes': {
      front = cap(line);
      for (let i = -2; i <= 2; i++) {
        const bx = cx + i * span;
        const base = crown(bx) + r * 0.14;
        front += drawShape(
          [[bx - r * 0.15, base], [bx, base - r * 0.52], [bx + r * 0.15, base]],
          style, fill, c.line,
        );
      }
      break;
    }
    case 'bun': {
      front = cap(line);
      front += drawShape(
        ellipsePoints(cx, crown(cx) - r * 0.08, r * 0.3, r * 0.28, 12),
        style, fill, c.line,
      );
      break;
    }
    case 'ponytail': {
      // Behind the head, so it reads as hanging rather than as a growth.
      const y1 = cy - r * p.halfH * 0.2;
      const y2 = cy + r * p.halfH * 0.55;
      const w = side(y1);
      back = drawShape(
        [
          [cx + w * 0.7, y1 - r * 0.1],
          [cx + w * 1.42, y1 + r * 0.05],
          [cx + w * 1.5, y2],
          [cx + w * 1.12, y2 - r * 0.05],
          [cx + w * 0.98, y1 + r * 0.05],
        ],
        style, fill, c.line,
      );
      front = cap(line);
      break;
    }
    case 'curly': {
      front = cap(cy - r * p.halfH * 0.38);
      for (let i = -2; i <= 2; i++) {
        const bx = cx + i * span;
        // Alternating heights, so the crown reads as clumps rather than as a
        // row of identical beads.
        const by = crown(bx) + r * (i % 2 === 0 ? 0.02 : 0.14);
        front += drawShape(ellipsePoints(bx, by, r * 0.23, r * 0.21, 10), style, fill, c.line);
      }
      break;
    }
    case 'crop':
    default:
      front = cap(cy - r * p.halfH * 0.46);
      break;
  }

  return { back, front };
}

function facialHair(p: Proportions, head: Point[]): string {
  const c = p.look;
  if (c.facialHair === 'none') return '';

  const style = activeStyle();
  const r = p.headR;
  const cx = p.headCx;
  const cy = p.headCy;
  const fill = c.hairColour;

  switch (c.facialHair) {
    case 'stubble':
      // Fill only, no outline: an outlined jaw patch reads as a chinstrap.
      return `<g opacity="0.3">${drawShape(clipY(head, p.mouthCy - r * 0.06, 'below'), style, fill, null)}</g>`;
    case 'moustache': {
      const y = p.mouthCy - r * 0.16;
      const w = r * 0.34;
      return drawShape(
        [
          [cx - w, y - r * 0.07], [cx + w, y - r * 0.07],
          [cx + w * 1.06, y + r * 0.09], [cx, y + r * 0.03], [cx - w * 1.06, y + r * 0.09],
        ],
        style, fill, c.line,
      );
    }
    case 'goatee': {
      const y = p.mouthCy + r * 0.14;
      return drawShape(
        [
          [cx - r * 0.2, y], [cx + r * 0.2, y],
          [cx + r * 0.15, y + r * 0.3], [cx - r * 0.15, y + r * 0.3],
        ],
        style, fill, c.line,
      );
    }
    case 'chops': {
      const y1 = p.eyeCy - r * 0.1;
      const y2 = p.mouthCy;
      const w1 = outlineHalf(head, y1, cx);
      const w2 = outlineHalf(head, y2, cx);
      const strip = (sx: number): Point[] => [
        [cx + sx * w1, y1],
        [cx + sx * w1 * 0.78, y1],
        [cx + sx * w2 * 0.7, y2],
        [cx + sx * w2 * 0.97, y2],
      ];
      return drawShape(strip(-1), style, fill, c.line) + drawShape(strip(1), style, fill, c.line);
    }
    case 'beard':
    default:
      // The jaw, clipped from the head's own outline so it fits any silhouette.
      return drawShape(clipY(head, p.noseCy + r * 0.06, 'below'), style, fill, c.line);
  }
}

function glasses(p: Proportions, head: Point[]): string {
  const c = p.look;
  if (c.glasses === 'none') return '';

  const lx = p.headCx - p.eyeSpread;
  const rx = p.headCx + p.eyeSpread;
  const cy = p.eyeCy;
  const rr = Math.max(p.eyeR * 1.55, p.headR * 0.2);
  const frame = c.line;
  const sw = 3;
  const temple = outlineHalf(head, cy, p.headCx);

  const bridge =
    `<path d="M ${lx + rr} ${cy} L ${rx - rr} ${cy}" stroke="${frame}" stroke-width="${sw}" fill="none"/>`;
  // Arms out to the temples: without them the frames float in front of the face.
  const arms =
    `<path d="M ${lx - rr} ${cy} L ${p.headCx - temple} ${cy - p.headR * 0.04}" stroke="${frame}" stroke-width="${sw}" fill="none"/>` +
    `<path d="M ${rx + rr} ${cy} L ${p.headCx + temple} ${cy - p.headR * 0.04}" stroke="${frame}" stroke-width="${sw}" fill="none"/>`;

  switch (c.glasses) {
    case 'square': {
      const lens = (x: number) =>
        `<rect x="${x - rr}" y="${cy - rr * 0.82}" width="${rr * 2}" height="${rr * 1.64}" rx="${rr * 0.2}" ` +
        `fill="#dfe9ef" fill-opacity="0.18" stroke="${frame}" stroke-width="${sw}"/>`;
      return lens(lx) + lens(rx) + bridge + arms;
    }
    case 'halfrim': {
      // Rim under the eye only. Reads as reading glasses, and as management.
      const lens = (x: number) =>
        `<path d="M ${x - rr} ${cy - rr * 0.2} A ${rr} ${rr} 0 0 0 ${x + rr} ${cy - rr * 0.2}" ` +
        `stroke="${frame}" stroke-width="${sw}" fill="none"/>`;
      return lens(lx) + lens(rx) + bridge + arms;
    }
    case 'round':
    default: {
      const lens = (x: number) =>
        `<circle cx="${x}" cy="${cy}" r="${rr}" fill="#dfe9ef" fill-opacity="0.18" stroke="${frame}" stroke-width="${sw}"/>`;
      return lens(lx) + lens(rx) + bridge + arms;
    }
  }
}

/** Torso silhouette, which is most of what distinguishes one build from another. */
function torsoPoints(p: Proportions): Point[] {
  const cx = W / 2;
  const hw = p.bodyHalfW;
  const top = p.bodyTop;
  const bot = p.bodyBottom;

  switch (BUILD_SPECS[p.look.build].torso) {
    case 'boxy':
      // Square shoulders with a slight ledge past the arms — reads as a crate
      // in silhouette, which is the point of being boxy.
      return [
        [cx - hw * 1.06, top], [cx + hw * 1.06, top],
        [cx + hw, top + (bot - top) * 0.2], [cx + hw, bot],
        [cx - hw, bot], [cx - hw, top + (bot - top) * 0.2],
      ];
    case 'round':
      return ellipsePoints(cx, (top + bot) / 2, hw, (bot - top) / 2, 16);
    case 'pear':
      // Genuinely narrow at the shoulders, hips wider than the nominal width —
      // the old 0.68/1.0 version flattened into a rectangle at thumbnail size.
      return [
        [cx - hw * 0.5, top], [cx + hw * 0.5, top],
        [cx + hw * 1.14, bot - (bot - top) * 0.24], [cx + hw * 0.95, bot],
        [cx - hw * 0.95, bot], [cx - hw * 1.14, bot - (bot - top) * 0.24],
      ];
    default:
      return rectPoints(cx - hw, top, hw * 2, bot - top, hw * 0.42);
  }
}

export function buildPlaceholderSvg(name: string, look?: Look, outfit?: Outfit): string {
  const c = look ?? rollLook(name);
  const o = outfit ?? defaultOutfit(activeIdentity(), name);
  const p = proportionsFor(c);
  const j = joints(p);
  const lw = p.limbW;
  const style = activeStyle();
  const head = headPoints(p);

  // Everything wardrobe needs to fit this particular body, measured once.
  const geometry: WardrobeGeometry = {
    look: c,
    outfit: o,
    headCx: p.headCx,
    headCy: p.headCy,
    headR: p.headR,
    halfH: p.halfH,
    neckTop: p.neckTop,
    bodyTop: p.bodyTop,
    bodyBottom: p.bodyBottom,
    bodyHalfW: p.bodyHalfW,
    hipY: p.hipY,
    legLen: p.legLen,
    limbW: p.limbW,
    browY: p.browY,
    torso: torsoPoints(p),
    crownAt: (x) => outlineTop(head, x),
  };

  // Limbs are drawn from half a limb-width above the joint and run half a
  // limb-width past the end, so the rounded caps sit centred on the pivots and
  // consecutive segments overlap instead of leaving a visible seam.
  const limb = (x: number, jointY: number, len: number, fill: string) =>
    drawShape(rectPoints(x - lw / 2, jointY - lw / 2, lw, len + lw, lw / 2), style, fill, c.line);

  const hand = (x: number) =>
    drawShape(ellipsePoints(x, j.wristY, lw * 0.62, lw * 0.62, 10), style, c.skin, c.line);

  // Long sleeves put the shirt on the forearm; the hand stays skin either way.
  const foreFill = o.sleeves === 'long' ? c.shirt : c.skin;

  const mouths = [...MOUTH_SHAPES, ...REST_MOUTHS, 'flat']
    .map((s) => `        <g id="mouth_${s}">${mouthShape(s, p)}</g>`)
    .join('\n');

  const eyes = EYE_VARIANTS.map((v) => `        <g id="eyes_${v}">${eyeSet(v, p)}</g>`).join('\n');
  const brows = BROW_VARIANTS.map((v) => `        <g id="brows_${v}">${browSet(v, p)}</g>`).join('\n');

  const h = hair(p, head, o.hat !== 'none');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-rig="${name}" data-build="${c.build}">
  <g id="torso">
    <g id="leg_L">${limb(j.hipL, p.hipY, p.legLen, c.trousers)}${shoe(geometry, j.hipL)}</g>
    <g id="leg_R">${limb(j.hipR, p.hipY, p.legLen, c.trousers)}${shoe(geometry, j.hipR)}</g>
    ${drawShape(rectPoints(W / 2 - lw * 0.6, p.neckTop, lw * 1.2, p.bodyTop - p.neckTop + 18), style, c.skin, c.line)}
    ${drawShape(torsoPoints(p), style, c.shirt, c.line)}
    ${torsoPattern(geometry)}
    ${collar(geometry)}
    ${neckwear(geometry)}
    <g id="arm_L_upper">
      ${limb(j.shoulderL, p.shoulderY, p.armUpperLen, c.shirt)}
      <g id="arm_L_fore">
        ${limb(j.shoulderL, j.elbowY, p.armForeLen, foreFill)}
        ${hand(j.shoulderL)}
      </g>
    </g>
    <g id="arm_R_upper">
      ${limb(j.shoulderR, p.shoulderY, p.armUpperLen, c.shirt)}
      <g id="arm_R_fore">
        ${limb(j.shoulderR, j.elbowY, p.armForeLen, foreFill)}
        ${hand(j.shoulderR)}
      </g>
    </g>
    <g id="head">
      <g id="hair_back">${h.back}</g>
      ${ears(p, head)}
      ${drawShape(head, style, c.skin, c.line)}
      <g id="hair_front">${h.front}</g>
      <g id="headwear">${hat(geometry)}</g>
      ${facialHair(p, head)}
      ${nose(p)}
${brows}
${eyes}
      ${glasses(p, head)}
${mouths}
    </g>
  </g>
</svg>
`;
}
