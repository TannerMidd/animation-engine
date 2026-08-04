import { Ollama } from './ollama.ts';
import { activeIdentity } from '../show/context.ts';
import { SetDescriptor } from '../sets/schema.ts';
import { validateSet, lintSet, tidySet } from '../sets/index.ts';
import { propKeys, propManifest } from '../sets/props/index.ts';
import { PALETTE_NAMES } from '../sets/palettes.ts';
import type { SetDescriptor as SetDescriptorType } from '../sets/schema.ts';

/**
 * Description -> set descriptor.
 *
 * Ollama's structured output takes a JSON Schema and constrains generation to
 * match it, so the model *cannot* emit a malformed descriptor. The prop and
 * palette lists are baked into that schema as enums straight from the registry
 * — the same guard the director has, for the same reason: whatever writes a
 * descriptor should be unable to name something that doesn't exist.
 */

/** Built from the live registry, so adding a prop automatically offers it. */
export function setJsonSchema(): unknown {
  const propInstance = {
    type: 'object',
    properties: {
      prop: { type: 'string', enum: propKeys() },
      x: { type: 'number' },
      y: { type: 'number' },
      scale: { type: 'number' },
      flip: { type: 'boolean' },
      params: { type: 'object' },
    },
    required: ['prop'],
  };

  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      palette: { type: 'string', enum: PALETTE_NAMES },
      layout: {
        type: 'object',
        properties: {
          horizonY: { type: 'number' },
          ceilingY: { type: 'number' },
          marginX: { type: 'number' },
          marginY: { type: 'number' },
        },
        required: ['horizonY', 'ceilingY', 'marginX', 'marginY'],
      },
      layers: {
        type: 'object',
        properties: {
          back: { type: 'array', items: propInstance },
          mid: { type: 'array', items: propInstance },
          fore: { type: 'array', items: propInstance },
        },
        required: ['back', 'mid', 'fore'],
      },
    },
    required: ['name', 'palette', 'layout', 'layers'],
  };
}

function catalogue(): string {
  return propManifest()
    .map((p) => {
      const params = p.params.map((s) => `${s.key}=${JSON.stringify(s.default)}`).join(' ');
      return `  ${p.key}${p.spanning ? ' [spans the whole set, ignores x]' : ''} — ${p.label}${params ? `; params: ${params}` : ''}`;
    })
    .join('\n');
}

function systemPrompt(): string {
  const identity = activeIdentity();
  const notes = identity.visual.setNotes.map((n) => `  - ${n}`).join('\n');

  return `You design flat-vector stage sets for a limited-animation engine by
emitting a JSON descriptor. You never draw; you place props from a fixed catalogue.

THE STAGE is 1280 wide by 720 tall. Characters stand on the floor at about y=698,
roughly 500 units tall, and are usually positioned around x=400 and x=880.

LAYERS ARE DEPTH. Characters render between "mid" and "fore":
  back — walls, ceiling, floor, sky, and anything flat against the wall
  mid  — furniture characters stand in front of
  fore — things that should pass IN FRONT of the characters
Put the room shell in "back" first, in this order: the wall/sky prop, then ceiling
(interiors only), then floor. Everything else follows.

LAYOUT: interiors use horizonY 560-580 and ceilingY 70-95. Exteriors use the "sky"
prop and ceilingY 0. Always use marginX 420 and marginY 220 — the camera moves off
centre for close-ups and needs artwork beyond the frame.

COMPOSITION: leave the middle of the stage (x 350-950) reasonably clear so the
characters are not buried. Six to twelve props is plenty. Do not stack props at the
same x.

THE SHOW'S VISUAL RULES — design every room to these:
${notes || '  - Plain, functional rooms.'}`;
}

const propCount = (s: SetDescriptorType): number =>
  s.layers.back.length + s.layers.mid.length + s.layers.fore.length;

export interface GenerateSetOptions {
  description: string;
  model: string;
  name: string;
  host?: string;
}

export interface GenerateSetResult {
  set: SetDescriptorType;
  attempts: number;
  /** Composition problems that survived the retry. Renderable, just awkward. */
  warnings: string[];
}

export async function generateSet(opts: GenerateSetOptions): Promise<GenerateSetResult> {
  const ollama = new Ollama(opts.host);
  let correction: string | undefined;
  let previous = '';
  /** The last descriptor that parsed, kept so a bad correction can be rejected. */
  let previousSet: SetDescriptorType | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let prompt = `Design this set: ${opts.description}

Available props:
${catalogue()}

Palettes: ${PALETTE_NAMES.join(', ')}
Name the set "${opts.name}". Pick the palette that best matches the mood.`;

    // Framed as an edit rather than a retry. Told only what was wrong, a model
    // rewrites from scratch and loses everything that was already right — the
    // first version of this feedback turned a six-prop office into a one-prop
    // one, because deleting the offending props satisfied the complaint.
    if (correction) {
      prompt +=
        `\n\nYou already designed this set. Return it again with the following corrections applied ` +
        `and NOTHING else changed — same props, same palette, same layout values, unless a ` +
        `correction says otherwise:\n${correction}\n\nHere is what you produced:\n${previous}`;
    }

    const raw = await ollama.generate({
      model: opts.model,
      system: systemPrompt(),
      prompt,
      format: setJsonSchema(),
      // Lower than script writing: this is a layout task, not a creative one,
      // and a wandering model produces sets with the floor in front of the wall.
      temperature: 0.4,
    });

    previous = raw.slice(0, 4000);

    let parsed: SetDescriptorType;
    try {
      parsed = SetDescriptor.parse(JSON.parse(raw));
    } catch (err) {
      correction = `- It was not valid against the schema: ${(err as Error).message.slice(0, 200)}`;
      continue;
    }

    parsed.name = opts.name;
    // Repair the mechanical problems before judging the result. Asking the model
    // to fix things the engine can fix itself wastes the one retry on work that
    // has a right answer, and leaves less room for it to make things worse.
    parsed = tidySet(parsed);

    const errors = validateSet(parsed);
    if (errors.length) {
      correction = errors.slice(0, 4).map((e) => `- ${e}`).join('\n');
      continue;
    }

    // Structured output guarantees the descriptor is *valid*, never that it is
    // well composed — so on the first pass, feed composition problems back the
    // same way. Accept whatever the retry gives us rather than failing outright:
    // an awkward set still renders and is a few drags from fixed in the designer.
    const notes = lintSet(parsed);
    if (notes.length && attempt === 1) {
      correction = notes.slice(0, 4).map((n) => `- ${n.fix}`).join('\n');
      previousSet = parsed;
      continue;
    }

    // A retry that made things worse is worse. Keeping the better of the two is
    // the only honest way to use a corrector that cannot be trusted to improve
    // monotonically — and losing half the furniture is a bigger problem than
    // whatever the linter was complaining about.
    if (previousSet && notes.length && propCount(parsed) < propCount(previousSet) * 0.6) {
      return {
        set: previousSet,
        attempts: attempt,
        warnings: lintSet(previousSet).map((n) => n.message),
      };
    }

    return { set: parsed, attempts: attempt, warnings: notes.map((n) => n.message) };
  }

  throw new Error(`model "${opts.model}" did not produce a usable set: ${correction}`);
}
