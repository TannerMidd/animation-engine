import { Ollama } from './ollama.ts';
import { activeIdentity } from '../show/context.ts';
import { PALETTES, getPalette, PALETTE_NAMES } from '../sets/palettes.ts';
import { geometryFor } from '../sets/schema.ts';
import {
  PropDocument, propFromDocument, PALETTE_SLOTS, BAKE_BUDGET, propKeys,
  type Primitive, type PropDef,
} from '../sets/props/index.ts';

/**
 * Description -> prop document.
 *
 * The same bargain as set generation next door: Ollama's structured output
 * takes a JSON Schema and constrains generation to match, so the model cannot
 * emit a shape that is not a shape or a colour that is not a palette slot. What
 * it can still do is draw something that looks nothing like a waste bin, which
 * is why nothing here saves anything — the result opens in the studio, where it
 * is a starting point rather than an answer.
 *
 * The model assembles primitives; it does not invent coordinates for a mesh.
 * That is the whole reason this is tractable for a model running on one card:
 * "a bin is a trapezoid with an ellipse on top" is a sentence, and the schema
 * turns it into geometry.
 *
 * Deliberately no expressions in the output. A model that has to keep `width`
 * consistent across nine fields gets it wrong in a way that is tedious to
 * unpick; a person adds the control afterwards in one click, and the studio
 * writes the arithmetic.
 */

/** What each slot is for, so a model picks by meaning rather than by sound. */
const SLOT_NOTES: Record<string, string> = {
  wall: 'the back wall', wallLower: 'a lower wall band or dado', wallTrim: 'wall trim and rails',
  ceiling: 'the ceiling', ceilingTrim: 'ceiling trim', light: 'a lit surface, a lamp, anything glowing',
  lightGlow: 'the soft halo around a light', floor: 'the floor', floorDark: 'floor shadow and seams',
  surface: 'a neutral mid-tone body — the default for most objects',
  surfaceDark: 'the shaded side of a neutral body', surfaceTrim: 'edging on a neutral body',
  wood: 'wood', woodDark: 'wood in shadow', metal: 'metal', metalDark: 'metal in shadow',
  fabric: 'upholstery and soft furnishing', fabricDark: 'upholstery in shadow',
  screen: 'a lit display', glass: 'glass and windows', foliage: 'leaves', foliageDark: 'leaves in shadow',
  clay: 'terracotta, pottery', accent: 'the show accent colour, used sparingly',
  accentGlow: 'the halo around an accent', line: 'the ink colour — outlines and text',
};

/**
 * A flat primitive, not a union.
 *
 * Constrained decoding is driven by a grammar, and a six-way `oneOf` gives
 * small models something to fall out of. One object with every field optional
 * and a `k` that says which of them matter is dull but it holds, and the
 * normaliser downstream is a dozen lines.
 */
export function propJsonSchema(): unknown {
  const number = { type: 'number' };
  return {
    type: 'object',
    properties: {
      label: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      primitives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            k: { type: 'string', enum: ['rect', 'ellipse', 'poly', 'line'] },
            f: { type: 'string', enum: PALETTE_SLOTS },
            outline: { type: 'boolean' },
            x: number, y: number, w: number, h: number,
            cx: number, cy: number, rx: number, ry: number,
            x1: number, y1: number, x2: number, y2: number,
            points: { type: 'array', items: number },
          },
          required: ['k', 'f'],
        },
      },
    },
    required: ['label', 'primitives'],
  };
}

export interface RawPrimitive {
  k?: string;
  f?: string;
  outline?: boolean;
  x?: number; y?: number; w?: number; h?: number;
  cx?: number; cy?: number; rx?: number; ry?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  points?: number[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Flat object to real primitive, dropping anything that is not one.
 *
 * Structured decoding guarantees the *shape* of what comes back, never that it
 * means anything: a model can emit `{k:"rect"}` with no width and satisfy the
 * schema. This is the line between what a model said and what the engine will
 * be asked to draw, so it is strict and silent — a shape that does not describe
 * itself is dropped rather than repaired into something nobody drew.
 */
export function normalisePrimitive(raw: RawPrimitive): Primitive | null {
  const slot = raw.f && (PALETTE_SLOTS as string[]).includes(raw.f) ? raw.f : 'surface';
  const l = raw.outline === false ? (0 as const) : (1 as const);

  if (raw.k === 'rect' && finite(raw.x) && finite(raw.y) && finite(raw.w) && finite(raw.h)) {
    if (raw.w <= 0 || raw.h <= 0) return null;
    return { k: 'rect', f: slot, l, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
  }
  if (raw.k === 'ellipse' && finite(raw.cx) && finite(raw.cy) && finite(raw.rx) && finite(raw.ry)) {
    if (raw.rx <= 0 || raw.ry <= 0) return null;
    return { k: 'ellipse', f: slot, l, cx: raw.cx, cy: raw.cy, rx: raw.rx, ry: raw.ry };
  }
  if (raw.k === 'line' && finite(raw.x1) && finite(raw.y1) && finite(raw.x2) && finite(raw.y2)) {
    return { k: 'line', f: slot, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2, sw: 3 };
  }
  if (raw.k === 'poly' && Array.isArray(raw.points)) {
    const p = raw.points.filter(finite);
    if (p.length < 6 || p.length % 2 !== 0) return null;
    return { k: 'poly', f: slot, l, c: 1, p };
  }
  return null;
}

function systemPrompt(): string {
  const identity = activeIdentity();
  const notes = identity.visual.setNotes.map((n) => `  - ${n}`).join('\n');
  const slots = PALETTE_SLOTS.map((s) => `  ${s} — ${SLOT_NOTES[s] ?? 'a palette colour'}`).join('\n');

  return `You draw props for a flat-vector animation engine by listing simple shapes.

COORDINATES. The prop's origin (0,0) is the middle of where it touches the
floor. NEGATIVE Y IS UP. So a table 90 units tall occupies y from -90 to 0, and
a shape at y=-200 is higher than one at y=-50. A standing character is about
500 units tall, which is the scale to judge everything against: a mug is ~40, a
chair ~180, a door ~400, a tree ~600. Things that hang on a wall still measure
from the floor, so a clock might sit around y=-380.

SHAPES. You have four:
  rect     x, y, w, h        — x,y is the TOP-LEFT corner (the smallest y)
  ellipse  cx, cy, rx, ry    — centre and radii
  poly     points [x,y,x,y…] — at least 3 points, in order around the outline
  line     x1, y1, x2, y2
They are drawn in the order you list them, so later shapes cover earlier ones.
Start with the big body of the object and add detail on top.

COLOUR is chosen by naming a palette SLOT, never a colour value. The same prop
then works in a bright office and a dive bar. The slots:
${slots}

Set "outline": false only for a shape that is an inner marking rather than a
part with an edge — a lit screen inside a monitor bezel, a shadow band. Almost
everything keeps its outline.

STYLE. This is a flat, hand-drawn look built from a few big shapes, not an
illustration. Six to twenty shapes is right; more than ${BAKE_BUDGET.warnShapes} reads as
scribble and is refused. No gradients, no tiny detail, no text.

THE SHOW'S VISUAL RULES:
${notes || '  - Plain, functional objects.'}`;
}

const EXAMPLES = `Here are two props in the format, to show the scale and the level of detail.

A mug, 46 units tall, sitting on a surface:
  {"k":"rect","f":"surface","x":-18,"y":-46,"w":36,"h":46}
  {"k":"ellipse","f":"surfaceDark","cx":0,"cy":-46,"rx":18,"ry":5}
  {"k":"line","f":"line","x1":18,"y1":-36,"x2":30,"y2":-24}
  {"k":"line","f":"line","x1":30,"y1":-24,"x2":18,"y2":-14}

A wooden crate, 90 units on a side:
  {"k":"rect","f":"wood","x":-45,"y":-90,"w":90,"h":90}
  {"k":"line","f":"woodDark","x1":-45,"y1":-90,"x2":45,"y2":0}
  {"k":"line","f":"woodDark","x1":45,"y1":-90,"x2":-45,"y2":0}`;

export interface GeneratePropOptions {
  description: string;
  model: string;
  key: string;
  host?: string;
}

export interface GeneratePropResult {
  document: PropDocument;
  attempts: number;
  /** Things that are odd but survivable. The studio shows these; nothing is saved. */
  warnings: string[];
}

/** Render the candidate everywhere it has to work, and say what broke. */
function problemsWith(def: PropDef): string[] {
  const geo = geometryFor({ horizonY: 566, ceilingY: 92, marginX: 420, marginY: 220 });
  const problems: string[] = [];

  for (const name of PALETTE_NAMES) {
    let svg: string;
    try {
      svg = def.render({ palette: getPalette(name), geo, params: {}, x: 640, y: 566 });
    } catch (err) {
      problems.push(`it fails to draw in the ${name} palette: ${(err as Error).message}`);
      continue;
    }
    if (!svg.length) problems.push(`it draws nothing at all in the ${name} palette`);
    if (svg.includes('NaN')) problems.push('some of the numbers are not numbers');
  }
  return [...new Set(problems)];
}

/** Obvious drawing mistakes, phrased as instructions rather than complaints. */
function critique(primitives: Primitive[]): string[] {
  const notes: string[] = [];
  let minY = 0;
  let maxY = 0;
  let maxAbsX = 0;

  for (const prim of primitives) {
    const ys: number[] = [];
    const xs: number[] = [];
    if (prim.k === 'rect') { ys.push(Number(prim.y), Number(prim.y) + Number(prim.h)); xs.push(Number(prim.x), Number(prim.x) + Number(prim.w)); }
    else if (prim.k === 'ellipse') { ys.push(Number(prim.cy) - Number(prim.ry), Number(prim.cy) + Number(prim.ry)); xs.push(Number(prim.cx) - Number(prim.rx), Number(prim.cx) + Number(prim.rx)); }
    else if (prim.k === 'line') { ys.push(Number(prim.y1), Number(prim.y2)); xs.push(Number(prim.x1), Number(prim.x2)); }
    else if (prim.k === 'poly') {
      for (let i = 0; i < prim.p.length; i += 2) { xs.push(Number(prim.p[i])); ys.push(Number(prim.p[i + 1])); }
    }
    for (const y of ys) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (const x of xs) maxAbsX = Math.max(maxAbsX, Math.abs(x));
  }

  const height = maxY - minY;
  if (primitives.length < 3) {
    notes.push('it is too plain — add a few more shapes so it reads as an object rather than a block');
  }
  if (height > 0 && height < 12) {
    notes.push('it is far too small; a mug is about 46 units tall and a chair about 180');
  }
  if (height > 900) {
    notes.push('it is far too big; a standing character is only about 500 units tall');
  }
  if (maxY > 40) {
    notes.push('parts of it are below the floor — the prop sits on y=0 and everything above the floor has NEGATIVE y');
  }
  if (minY > -8) {
    notes.push('it has no height at all — remember that up is negative y, so the top of the object is its most negative y');
  }
  if (maxAbsX > 900) {
    notes.push('it is much too wide — keep it within about 400 units either side of the centre');
  }
  return notes;
}

export async function generateProp(opts: GeneratePropOptions): Promise<GeneratePropResult> {
  const ollama = new Ollama(opts.host);
  let correction: string | undefined;
  let previous = '';

  if (propKeys().includes(opts.key)) {
    throw new Error(`there is already a prop called "${opts.key}"`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    let prompt = `Draw this prop: ${opts.description}

${EXAMPLES}

Now draw "${opts.description}". Give it a short human label and two or three
tags from: interior, exterior, office, home, bar, generic, structure.`;

    if (correction) {
      prompt +=
        `\n\nYou already drew this. Return it again with these corrections applied and ` +
        `NOTHING else changed — same shapes, same colours, unless a correction says otherwise:\n` +
        correction.split('\n').map((c) => `- ${c}`).join('\n') +
        `\n\nHere is what you produced:\n${previous}`;
    }

    const raw = await ollama.generate({
      model: opts.model,
      system: systemPrompt(),
      prompt,
      format: propJsonSchema(),
      // Lower than script writing: this is a drawing-to-spec task, and a
      // wandering model produces objects with their lids below the floor.
      temperature: 0.3,
    });
    previous = raw.slice(0, 3000);

    let parsed: { label?: string; tags?: string[]; primitives?: RawPrimitive[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (err) {
      correction = `it was not valid JSON: ${(err as Error).message.slice(0, 120)}`;
      continue;
    }

    const primitives = (parsed.primitives ?? []).map(normalisePrimitive).filter((p): p is Primitive => p !== null);
    if (!primitives.length) {
      correction = 'none of the shapes were usable — every shape needs its own fields (a rect needs x, y, w and h)';
      continue;
    }
    if (primitives.length > BAKE_BUDGET.maxShapes) {
      correction = `there were ${primitives.length} shapes, which is far too many — use no more than twenty`;
      continue;
    }

    const document: PropDocument = {
      format: 2,
      key: opts.key,
      label: humanLabel(parsed.label) || sentenceCase(opts.description.slice(0, 40)),
      tags: (parsed.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5),
      spanning: false,
      params: [],
      provenance: { blender: `none (described to ${opts.model})`, source: 'sha1:0', baked: today() },
      views: { default: { primitives } },
    };
    if (!document.tags.length) document.tags = ['generic'];

    let checked: PropDocument;
    let def: PropDef;
    try {
      checked = PropDocument.parse(document);
      def = propFromDocument(checked);
    } catch (err) {
      correction = `the engine refused it: ${(err as Error).message.slice(0, 200)}`;
      continue;
    }

    const broken = problemsWith(def);
    if (broken.length) {
      correction = broken.slice(0, 3).join('\n');
      continue;
    }

    // Composition is fed back once and then accepted. A prop that is merely
    // odd is a few drags from fixed in the studio, and refusing outright would
    // leave the person with nothing to drag.
    const notes = critique(primitives);
    if (notes.length && attempt === 1) {
      correction = notes.slice(0, 3).join('\n');
      continue;
    }

    return { document: checked, attempts: attempt, warnings: notes };
  }

  throw new Error(`model "${opts.model}" did not draw a usable prop: ${correction}`);
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A name a person would have written.
 *
 * Asked for a label, a model reliably answers with an identifier — `wasteBin`,
 * `waste_bin`, `WASTE BIN`. This is the one thing in the catalogue somebody
 * reads every time they open the prop palette, so it is worth fixing rather
 * than shrugging at.
 */
export function humanLabel(raw: string | undefined): string {
  const words = (raw ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? sentenceCase(words.join(' ')) : '';
}

/** Date is not available inside prop rendering, but this is authoring time. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Exposed for the tests: the slot vocabulary the schema constrains a model to. */
export const GENERATOR_SLOTS = PALETTE_SLOTS;
export const GENERATOR_PALETTES = Object.keys(PALETTES);
