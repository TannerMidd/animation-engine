import { LAYERS, STAGE, geometryFor, type Layer, type PropInstance, type SetDescriptor } from './schema.ts';
import { getProp } from './props/index.ts';
import type { PropInteractionHandle, PropInteractionGeometry } from './props/types.ts';

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

/**
 * Resolve an authored prop reference without guessing.
 *
 * Exact stable ids win. A type/label is accepted only when it identifies one
 * instance. Ambiguity is an error because choosing whichever happened to be
 * first in a set array would break continuity after an innocent set edit.
 */
export function resolvePropReference(
  reference: string,
  props: readonly ResolvedSetProp[],
  context: string,
): ResolvedSetProp {
  const exact = props.find((prop) => prop.id === reference);
  if (exact) return exact;

  const directMatches = props.filter((prop) => referenceMatches(reference, prop));
  const matches = directMatches.length
    ? directMatches
    : props.filter((prop) => aliasMatches(reference, prop));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    throw new Error(`${context} references missing prop "${reference}"`);
  }
  const candidates = matches.map((prop) => prop.instance.id ?? `${prop.layer}[${prop.index}]`).join(', ');
  throw new Error(
    `${context} prop "${reference}" is ambiguous (${candidates}); assign stable instance ids and reference one`,
  );
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
