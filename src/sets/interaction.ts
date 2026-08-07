import { LAYERS, STAGE, geometryFor, type Layer, type PropInstance, type SetDescriptor } from './schema.ts';
import { getProp } from './props/index.ts';
import type { PropInteractionHandle, PropInteractionGeometry } from './props/types.ts';
import type { ShotList } from '../schema/script.ts';

/** A set instance with its authored transform and catalogue interaction data resolved. */
export interface ResolvedSetProp {
  id: string;
  /** True when the id was explicitly authored and is safe to reference across set edits. */
  stableId: boolean;
  prop: string;
  label: string;
  layer: Layer;
  index: number;
  instance: PropInstance;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  interaction: PropInteractionGeometry | null;
}

function safeIdPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'prop';
}

/**
 * Runtime identity for a prop instance.
 *
 * Explicit descriptor ids are the durable authoring contract. Legacy sets get
 * a deterministic layer/index fallback so a unique prop can still be used
 * immediately; validation tells authors to assign an id when disambiguation is
 * required.
 */
export function propInstanceId(instance: PropInstance, layer: Layer, index: number): string {
  return instance.id ?? `auto:${layer}:${index}:${safeIdPart(instance.prop)}`;
}

/** Resolve every non-spanning set instance into one shared compiler/renderer vocabulary. */
export function resolveSetProps(set: SetDescriptor): ResolvedSetProp[] {
  const geo = geometryFor(set.layout);
  const out: ResolvedSetProp[] = [];
  for (const layer of LAYERS) {
    set.layers[layer].forEach((instance, index) => {
      const def = getProp(instance.prop);
      if (def.spanning) return;
      out.push({
        id: propInstanceId(instance, layer, index),
        stableId: instance.id !== undefined,
        prop: instance.prop,
        label: def.label,
        layer,
        index,
        instance,
        x: instance.x ?? STAGE.width / 2,
        y: instance.y ?? geo.horizonY,
        scale: instance.scale,
        flip: instance.flip,
        interaction: def.interactionFor?.(instance.params) ?? def.interaction ?? null,
      });
    });
  }
  return out;
}

function normalizedReference(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function referenceMatches(reference: string, prop: ResolvedSetProp): boolean {
  const wanted = normalizedReference(reference);
  return wanted === normalizedReference(prop.prop) || wanted === normalizedReference(prop.label);
}

/**
 * Screenplay nouns that safely map to an existing registry kind.
 *
 * Direct kind/label matches are always tried first, and stable instance ids win
 * before either. If a true `table` prop is ever added, it therefore beats this
 * fallback; multiple desks remain ambiguous rather than being guessed.
 */
const SAFE_REFERENCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  table: ['desk'],
};

function aliasMatches(reference: string, prop: ResolvedSetProp): boolean {
  const aliases = SAFE_REFERENCE_ALIASES[normalizedReference(reference)] ?? [];
  return aliases.some((alias) => normalizedReference(alias) === normalizedReference(prop.prop));
}

/** Why a reference did not land on exactly one prop, with the message to say so. */
export type PropResolution =
  | { ok: true; prop: ResolvedSetProp }
  | { ok: false; reason: 'missing' | 'ambiguous'; message: string; matches: ResolvedSetProp[] };

/**
 * Resolve an authored prop reference without guessing.
 *
 * Exact stable ids win. A type/label is accepted only when it identifies one
 * instance. Ambiguity is a failure because choosing whichever happened to be
 * first in a set array would break continuity after an innocent set edit.
 *
 * This returns the verdict rather than throwing so the same rule can answer
 * "can this set host this scene?" ahead of time. `resolvePropReference` is the
 * compiler's throwing face of it — one rule, two callers, no drift.
 */
export function tryResolvePropReference(
  reference: string,
  props: readonly ResolvedSetProp[],
  context: string,
): PropResolution {
  const exact = props.find((prop) => prop.id === reference);
  if (exact) return { ok: true, prop: exact };

  const directMatches = props.filter((prop) => referenceMatches(reference, prop));
  const matches = directMatches.length
    ? directMatches
    : props.filter((prop) => aliasMatches(reference, prop));
  if (matches.length === 1) return { ok: true, prop: matches[0]! };
  if (!matches.length) {
    return {
      ok: false,
      reason: 'missing',
      message: `${context} references missing prop "${reference}"`,
      matches: [],
    };
  }
  const candidates = matches.map((prop) => prop.instance.id ?? `${prop.layer}[${prop.index}]`).join(', ');
  return {
    ok: false,
    reason: 'ambiguous',
    message:
      `${context} prop "${reference}" is ambiguous (${candidates}); assign stable instance ids and reference one`,
    matches,
  };
}

export function resolvePropReference(
  reference: string,
  props: readonly ResolvedSetProp[],
  context: string,
): ResolvedSetProp {
  const resolved = tryResolvePropReference(reference, props, context);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.prop;
}

export function propHasReference(prop: ResolvedSetProp, reference: string): boolean {
  return prop.id === reference || referenceMatches(reference, prop) || aliasMatches(reference, prop);
}

/** Pick a stable catalogue handle for one semantic interaction. */
export function interactionHandle(
  prop: ResolvedSetProp,
  kind: 'grip' | 'contact' | 'placement' | 'seat',
  context: string,
): PropInteractionHandle {
  const geometry = prop.interaction;
  if (!geometry) {
    throw new Error(`${context} targets "${prop.id}" (${prop.prop}), which has no interaction geometry`);
  }
  const preferred = geometry.handles.find((handle) => handle.kind === kind);
  const fallback = kind === 'contact'
    ? geometry.handles.find((handle) => handle.kind === 'control' || handle.kind === 'grip')
    : kind === 'placement'
      ? geometry.handles.find((handle) => handle.kind === 'contact')
      : kind === 'grip'
        ? geometry.handles.find((handle) => handle.kind === 'contact')
        : undefined;
  const handle = preferred ?? fallback;
  if (!handle) throw new Error(`${context} targets "${prop.id}" (${prop.prop}), which has no ${kind} handle`);
  return handle;
}

// --- can this set host this scene? ----------------------------------------

/**
 * One prop reference a shot list makes, with everything needed to judge it.
 *
 * Collected from the authored shot list rather than from a compile, because the
 * question is asked about sets the scene is *not* using yet — and a compile
 * stops at the first problem, which is exactly the behaviour that made changing
 * the set feel like the editor had broken.
 */
interface AuthoredPropReference {
  reference: string;
  handle: 'grip' | 'contact' | 'placement' | 'seat';
  /** The compiler refuses a non-portable prop for these. */
  portable: boolean;
  /** Seats in "fore" would occlude whoever sits on them, so they are refused. */
  seating: boolean;
  /** Initial staging must name an instance id that survives a set edit. */
  needsStableId: boolean;
  verb: string;
  beatIndex: number | null;
  actionIndex: number | null;
  actionType: string | null;
  field: 'target' | 'seat' | 'prop' | 'heldProp';
  actorId: string | null;
  label: string;
}

/** A prop in the candidate set that could take a reference the set cannot host. */
export interface PropSubstitute {
  /** What to write into the shot list, or null when it would need a stable id first. */
  reference: string | null;
  label: string;
  prop: string;
}

export interface PropReferenceIssue {
  /** The authored reference, exactly as the shot list wrote it. */
  reference: string;
  /** What the scene does with it, for a sentence a person can act on. */
  verb: string;
  /** Beat that made the reference, or null for a cast member's initial staging. */
  beatIndex: number | null;
  /** Position in that beat's `stage` array, so a repair edits the right action. */
  actionIndex: number | null;
  actionType: string | null;
  /** The field carrying the reference, on the action or on the cast member. */
  field: 'target' | 'seat' | 'prop' | 'heldProp';
  actorId: string | null;
  /** Beat text, or the actor id — whatever names the problem on screen. */
  label: string;
  status: 'missing' | 'ambiguous' | 'unusable';
  detail: string;
  substitutes: PropSubstitute[];
}

/** How well a set can host what a shot list asks of it. */
export interface SetFit {
  /** Every prop reference the shot list makes, whether or not it resolves. */
  references: number;
  issues: PropReferenceIssue[];
}

function authoredPropReferences(shots: ShotList): AuthoredPropReference[] {
  const out: AuthoredPropReference[] = [];
  shots.beats.forEach((beat, index) => {
    if (beat.kind !== 'action') return;
    const label = beat.text || `beat ${index}`;

    beat.stage.forEach((action, actionIndex) => {
      const ref = (
        reference: string | undefined,
        field: AuthoredPropReference['field'],
        handle: AuthoredPropReference['handle'],
        verb: string,
        extra: { portable?: boolean; seating?: boolean } = {},
      ) => {
        if (!reference) return;
        out.push({
          reference,
          handle,
          portable: extra.portable ?? false,
          seating: extra.seating ?? false,
          needsStableId: false,
          verb,
          beatIndex: index,
          actionIndex,
          actionType: action.type,
          field,
          actorId: null,
          label,
        });
      };

      switch (action.type) {
        case 'tap':
          ref(action.target, 'target', 'contact', 'tap');
          break;
        case 'reach':
          ref(action.target, 'target', 'contact', 'reach for');
          break;
        case 'sit':
          ref(action.seat, 'seat', 'seat', 'sit on', { seating: true });
          break;
        case 'pick_up':
          ref(action.prop, 'prop', 'grip', 'pick up', { portable: true });
          break;
        case 'put_down':
          ref(action.prop, 'prop', 'grip', 'put down', { portable: true });
          // The optional surface it lands on is a second, different requirement.
          ref(action.target, 'target', 'placement', 'put something on');
          break;
        default:
          break;
      }
    });
  });

  for (const member of shots.cast) {
    const initial = {
      portable: false,
      seating: false,
      needsStableId: true,
      beatIndex: null,
      actionIndex: null,
      actionType: null,
      actorId: member.id,
      label: member.id,
    } as const;
    if (member.seat) {
      out.push({
        ...initial,
        reference: member.seat,
        handle: 'seat',
        seating: true,
        field: 'seat',
        verb: 'start the scene sitting on',
      });
    }
    if (member.heldProp) {
      out.push({
        ...initial,
        reference: member.heldProp,
        handle: 'grip',
        portable: true,
        field: 'heldProp',
        verb: 'start the scene holding',
      });
    }
  }

  return out;
}

/** Whether one prop could stand in for a reference, by the compiler's own rules. */
function propCanHost(prop: ResolvedSetProp, want: AuthoredPropReference): boolean {
  if (want.portable && !prop.interaction?.portable) return false;
  if (want.seating && prop.layer === 'fore') return false;
  if (want.needsStableId && !prop.stableId) return false;
  try {
    interactionHandle(prop, want.handle, 'fit');
    return true;
  } catch {
    return false;
  }
}

/**
 * The reference to write when retargeting onto this prop.
 *
 * An authored instance id is durable. Failing that, a registry key is only
 * usable while it names exactly one instance — the same rule
 * `tryResolvePropReference` applies when reading it back.
 */
function substituteReference(prop: ResolvedSetProp, all: readonly ResolvedSetProp[]): string | null {
  if (prop.stableId) return prop.instance.id!;
  return all.filter((other) => other.prop === prop.prop).length === 1 ? prop.prop : null;
}

/**
 * Answer "can this set host this scene?" without compiling it.
 *
 * Every prop reference is judged independently, so the answer is the whole list
 * of problems rather than whichever one the compiler happened to hit first, and
 * each one carries the props in *this* set that could take it instead. That is
 * what lets the editor offer the fix at the moment someone changes the set,
 * instead of blanking the stage and quoting an exception at them.
 */
export function setFit(shots: ShotList, set: SetDescriptor | null): SetFit {
  const wanted = authoredPropReferences(shots);

  /** Everything that says *which* authored reference this is, for the repair. */
  const locate = (want: AuthoredPropReference) => ({
    reference: want.reference,
    verb: want.verb,
    beatIndex: want.beatIndex,
    actionIndex: want.actionIndex,
    actionType: want.actionType,
    field: want.field,
    actorId: want.actorId,
    label: want.label,
  });

  if (!set) {
    return {
      references: wanted.length,
      issues: wanted.map((want) => ({
        ...locate(want),
        status: 'missing' as const,
        detail: `a bare stage has no "${want.reference}" to ${want.verb}`,
        substitutes: [],
      })),
    };
  }

  const props = resolveSetProps(set);
  const issues: PropReferenceIssue[] = [];

  for (const want of wanted) {
    const substitutes = (): PropSubstitute[] =>
      props
        .filter((prop) => propCanHost(prop, want))
        .map((prop) => ({ reference: substituteReference(prop, props), label: prop.label, prop: prop.prop }));
    const issue = (status: PropReferenceIssue['status'], detail: string) =>
      issues.push({ ...locate(want), status, detail, substitutes: substitutes() });

    const resolved = tryResolvePropReference(want.reference, props, 'fit');
    if (!resolved.ok) {
      issue(
        resolved.reason,
        resolved.reason === 'missing'
          ? `"${set.name}" has no "${want.reference}"`
          : `"${want.reference}" matches ${resolved.matches.length} props in "${set.name}"`,
      );
      continue;
    }

    const prop = resolved.prop;
    if (want.needsStableId && !prop.stableId) {
      issue('unusable', `"${prop.label}" in "${set.name}" has no stable instance id to reference`);
      continue;
    }
    if (want.portable && !prop.interaction?.portable) {
      issue('unusable', `"${prop.label}" in "${set.name}" is not portable`);
      continue;
    }
    if (want.seating && prop.layer === 'fore') {
      issue('unusable', `"${prop.label}" is in front of the characters in "${set.name}"`);
      continue;
    }
    try {
      interactionHandle(prop, want.handle, 'fit');
    } catch {
      issue('unusable', `"${prop.label}" in "${set.name}" is not something you can ${want.verb}`);
    }
  }

  return { references: wanted.length, issues };
}

/** Apply a prop instance transform to one local catalogue handle. */
export function propHandlePoint(
  prop: Pick<ResolvedSetProp, 'x' | 'y' | 'scale' | 'flip'>,
  handle: Pick<PropInteractionHandle, 'x' | 'y'>,
): { x: number; y: number } {
  return {
    x: prop.x + handle.x * prop.scale * (prop.flip ? -1 : 1),
    y: prop.y + handle.y * prop.scale,
  };
}
