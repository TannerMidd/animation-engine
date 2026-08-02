import fs from 'node:fs/promises';
import path from 'node:path';
import { BUS_RATE, db, fadeEdges, toBusSamples, type BusClip } from './bus.ts';
import { bodySha256, fileSha256 } from './files.ts';
import { SHOW_DIR } from '../core/paths.ts';
import { Rng, deriveSeed } from '../core/rng.ts';
import { readWav } from '../voice/wav.ts';
import type { CompiledStageAction } from '../compile/scene.ts';

export const FOLEY_EVENT_VERSION = 2 as const;
export const FOLEY_GENERATOR_VERSION = 2 as const;
export const FOLEY_ACTIONS = [
  'enter', 'move', 'sit', 'stand', 'exit', 'pick_up', 'put_down', 'tap',
] as const;
export type FoleyAction = (typeof FOLEY_ACTIONS)[number];

const FOLEY_ACTION_SET = new Set<string>(FOLEY_ACTIONS);
const CONTACT_FOLEY_ACTION_SET = new Set<FoleyAction>(['pick_up', 'put_down', 'tap']);
const DEFAULT_GAIN_DB: Record<FoleyAction, number> = {
  enter: -19,
  move: -19,
  sit: -21,
  stand: -21,
  exit: -19,
  pick_up: -22,
  put_down: -20,
  tap: -20,
};

export interface FoleyContactPlan {
  id: string;
  kind: 'grasp' | 'release' | 'tap';
  hand: 'left' | 'right';
  ordinal: number;
  total: number;
  targetId: string;
  targetProp: string;
  targetHandle: string;
  point: { x: number; y: number };
}

export interface FoleyEventPlan {
  id: string;
  type: FoleyAction;
  actor: string;
  beatId: string;
  beatIndex: number;
  actionIndex: number;
  transitionStartMs: number;
  transitionEndMs: number;
  /** Where the rendered one-shot or movement sequence is placed. */
  placementMs: number;
  seed: number;
  /** Exact semantic contact that produced this sound, when applicable. */
  contact?: FoleyContactPlan;
}

export interface FoleyAssetRequest {
  event: FoleyEventPlan;
}

export interface FoleyAsset {
  /** Stable, library-relative identity written to provenance. */
  id: string;
  /** Existing local PCM WAV. Libraries never download on resolution. */
  file: string;
  gainDb?: number;
}

/**
 * Pluggable authored sound source.
 *
 * Resolution is deliberately local-only: a library either returns an existing
 * WAV or null. There is no network or implicit acquisition path hidden behind
 * this interface.
 */
export interface FoleyAssetLibrary {
  id: string;
  resolve(request: FoleyAssetRequest): Promise<FoleyAsset | null>;
}

export class LocalFoleyAssetLibrary implements FoleyAssetLibrary {
  readonly id: string;

  constructor(
    readonly root = path.join(SHOW_DIR, 'foley'),
    id = 'show-foley-v1',
  ) {
    this.id = id;
  }

  async resolve({ event }: FoleyAssetRequest): Promise<FoleyAsset | null> {
    if (!/^[A-Za-z0-9._-]+$/.test(event.actor)) return null;
    const targetProp = event.contact?.targetProp;
    if (targetProp && !/^[A-Za-z0-9._-]+$/.test(targetProp)) return null;
    const candidates = [
      ...(targetProp ? [
        path.join(this.root, 'props', targetProp, `${event.type}.wav`),
        path.join(this.root, targetProp, `${event.type}.wav`),
      ] : []),
      path.join(this.root, event.actor, `${event.type}.wav`),
      path.join(this.root, `${event.type}.wav`),
    ];
    for (const file of candidates) {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        return {
          id: path.relative(this.root, file).replace(/\\/g, '/'),
          file,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  }
}

/** Useful for tests and callers that explicitly want synthesized-only Foley. */
export const SYNTHESIZED_ONLY_FOLEY_LIBRARY: FoleyAssetLibrary = {
  id: 'synthesized-only',
  async resolve() { return null; },
};

export type FoleySourceProvenance =
  | {
      kind: 'authored-local';
      libraryId: string;
      assetId: string;
      assetPath: string;
      assetSha256: string;
    }
  | {
      kind: 'synthesized';
      generator: 'deterministic-foley';
      generatorVersion: typeof FOLEY_GENERATOR_VERSION;
      seed: number;
    };

export interface FoleyEvent extends FoleyEventPlan {
  gainDb: number;
  renderedDurationMs: number;
  source: FoleySourceProvenance;
  /** Hash of timing, action and source provenance for editorial auditing. */
  eventSha256: string;
}

export interface RenderedFoley {
  clips: BusClip[];
  events: FoleyEvent[];
}

export interface FoleyEventsDocument {
  schemaVersion: typeof FOLEY_EVENT_VERSION;
  scene: string;
  fps: number;
  durationMs: number;
  events: FoleyEvent[];
}

function triggerFor(type: FoleyAction, startMs: number, endMs: number): number {
  if (type === 'sit') return startMs + (endMs - startMs) * 0.62;
  if (type === 'stand') return startMs + (endMs - startMs) * 0.42;
  return startMs;
}

/** Lower validated compiler transitions into deterministic sound events. */
export function deriveFoleyEvents(
  actions: readonly CompiledStageAction[],
  sceneSeed: number,
): FoleyEventPlan[] {
  const events: FoleyEventPlan[] = [];
  for (const action of actions) {
    if (
      !Number.isFinite(action.startMs) || !Number.isFinite(action.endMs) ||
      action.startMs < 0 || action.endMs <= action.startMs
    ) {
      throw new Error(`Foley action "${action.id}" has invalid compiled transition timing`);
    }

    if (FOLEY_ACTION_SET.has(action.type) && !CONTACT_FOLEY_ACTION_SET.has(action.type as FoleyAction)) {
      const type = action.type as FoleyAction;
      const seed = deriveSeed(sceneSeed, `foley:${action.id}:${type}:${action.actor}`);
      events.push({
        id: `${action.id}:foley`,
        type,
        actor: action.actor,
        beatId: action.beatId,
        beatIndex: action.beatIndex,
        actionIndex: action.actionIndex,
        transitionStartMs: action.startMs,
        transitionEndMs: action.endMs,
        placementMs: triggerFor(type, action.startMs, action.endMs),
        seed,
      });
    }

    for (const contact of action.contacts) {
      const type: FoleyAction | null = contact.kind === 'grasp'
        ? 'pick_up'
        : contact.kind === 'release'
          ? 'put_down'
          : contact.kind === 'tap'
            ? 'tap'
            : null;
      if (!type) continue;
      if (!Number.isFinite(contact.atMs) || contact.atMs < action.startMs || contact.atMs > action.endMs) {
        throw new Error(`Foley contact "${contact.id}" is outside compiled action "${action.id}"`);
      }
      const contactPlan: FoleyContactPlan = {
        id: contact.id,
        kind: contact.kind,
        hand: contact.hand,
        ordinal: contact.ordinal,
        total: contact.total,
        targetId: contact.target.id,
        targetProp: contact.target.prop,
        targetHandle: contact.target.handle,
        point: { ...contact.point },
      };
      const seed = deriveSeed(
        sceneSeed,
        `foley:${contact.id}:${type}:${action.actor}:${contact.target.id}:${contact.ordinal}`,
      );
      events.push({
        id: `${contact.id}:foley`,
        type,
        actor: action.actor,
        beatId: action.beatId,
        beatIndex: action.beatIndex,
        actionIndex: action.actionIndex,
        transitionStartMs: action.startMs,
        transitionEndMs: action.endMs,
        placementMs: contact.atMs,
        seed,
        contact: contactPlan,
      });
    }
  }

  return events.sort((a, b) => a.placementMs - b.placementMs || a.id.localeCompare(b.id));
}

function addPulse(
  target: Float64Array,
  rng: Rng,
  at: number,
  length: number,
  frequency: number,
  noise: number,
): void {
  const end = Math.min(target.length, at + length);
  const phase = rng.range(0, Math.PI * 2);
  for (let i = Math.max(0, at); i < end; i++) {
    const local = i - at;
    const t = local / BUS_RATE;
    const attack = Math.min(1, local / Math.max(1, BUS_RATE * 0.003));
    const envelope = attack * Math.exp(-t * 32);
    const body = Math.sin(2 * Math.PI * frequency * t + phase) * 0.72;
    const grit = (rng.next() * 2 - 1) * noise;
    target[i]! += (body + grit) * envelope;
  }
}

function movementFallback(event: FoleyEventPlan): Float64Array {
  const durationMs = Math.max(140, event.transitionEndMs - event.transitionStartMs);
  const out = new Float64Array(Math.max(1, Math.round((durationMs / 1_000) * BUS_RATE)));
  const rng = new Rng(event.seed);
  const strideMs = event.type === 'move' ? 310 : 350;
  const steps = Math.max(1, Math.round(durationMs / strideMs));
  const usable = out.length * 0.78;
  const base = out.length * 0.1;
  for (let step = 0; step < steps; step++) {
    const position = steps === 1 ? 0.5 : step / (steps - 1);
    const jitter = rng.range(-0.025, 0.025) * out.length;
    const at = Math.round(base + usable * position + jitter);
    addPulse(out, rng, at, Math.round(BUS_RATE * rng.range(0.07, 0.11)), rng.range(62, 92), 0.24);
  }
  return fadeEdges(out, 3);
}

function postureFallback(event: FoleyEventPlan): Float64Array {
  const durationMs = event.type === 'sit' ? 390 : 330;
  const out = new Float64Array(Math.round((durationMs / 1_000) * BUS_RATE));
  const rng = new Rng(event.seed);
  const creakStart = Math.round(BUS_RATE * 0.025);
  const creakLength = Math.round(BUS_RATE * 0.22);
  for (let i = 0; i < creakLength && creakStart + i < out.length; i++) {
    const t = i / BUS_RATE;
    const sweep = (event.type === 'sit' ? 190 : 145) + (event.type === 'sit' ? -80 : 90) * (i / creakLength);
    const env = Math.sin(Math.PI * (i / creakLength));
    out[creakStart + i]! += (
      Math.sin(2 * Math.PI * sweep * t + rng.range(-0.01, 0.01)) * 0.34 +
      (rng.next() * 2 - 1) * 0.16
    ) * env;
  }
  const contact = event.type === 'sit' ? Math.round(out.length * 0.61) : Math.round(out.length * 0.32);
  addPulse(out, rng, contact, Math.round(BUS_RATE * 0.09), event.type === 'sit' ? 72 : 86, 0.18);
  return fadeEdges(out, 4);
}

function contactFallback(event: FoleyEventPlan): Float64Array {
  const durationMs = event.type === 'put_down' ? 240 : event.type === 'pick_up' ? 180 : 130;
  const out = new Float64Array(Math.round((durationMs / 1_000) * BUS_RATE));
  const rng = new Rng(event.seed);
  if (event.type === 'tap') {
    addPulse(out, rng, Math.round(BUS_RATE * 0.006), Math.round(BUS_RATE * 0.075), rng.range(170, 260), 0.3);
    addPulse(out, rng, Math.round(BUS_RATE * 0.018), Math.round(BUS_RATE * 0.06), rng.range(520, 760), 0.12);
  } else if (event.type === 'pick_up') {
    addPulse(out, rng, Math.round(BUS_RATE * 0.01), Math.round(BUS_RATE * 0.09), rng.range(360, 520), 0.17);
    addPulse(out, rng, Math.round(BUS_RATE * 0.045), Math.round(BUS_RATE * 0.11), rng.range(680, 940), 0.08);
  } else {
    addPulse(out, rng, Math.round(BUS_RATE * 0.006), Math.round(BUS_RATE * 0.11), rng.range(75, 115), 0.26);
    addPulse(out, rng, Math.round(BUS_RATE * 0.02), Math.round(BUS_RATE * 0.15), rng.range(320, 480), 0.13);
  }
  return fadeEdges(out, 3);
}

/** Public synthesized fallback for deterministic tests and custom libraries. */
export function synthesizeFoley(event: FoleyEventPlan): Float64Array {
  if (CONTACT_FOLEY_ACTION_SET.has(event.type)) return contactFallback(event);
  return event.type === 'sit' || event.type === 'stand'
    ? postureFallback(event)
    : movementFallback(event);
}

function withEventHash(event: Omit<FoleyEvent, 'eventSha256'>): FoleyEvent {
  return {
    ...event,
    eventSha256: bodySha256(JSON.stringify(event)),
  };
}

/** Resolve authored local assets, falling back to the seeded engine recipe. */
export async function renderFoleyEvents(
  plans: readonly FoleyEventPlan[],
  library: FoleyAssetLibrary = new LocalFoleyAssetLibrary(),
): Promise<RenderedFoley> {
  const clips: BusClip[] = [];
  const events: FoleyEvent[] = [];

  for (const plan of plans) {
    const asset = await library.resolve({ event: plan });
    if (asset) {
      const samples = fadeEdges(toBusSamples(await readWav(asset.file), asset.file), 4);
      const gainDb = asset.gainDb ?? DEFAULT_GAIN_DB[plan.type];
      const source: FoleySourceProvenance = {
        kind: 'authored-local',
        libraryId: library.id,
        assetId: asset.id,
        assetPath: asset.id,
        assetSha256: await fileSha256(asset.file),
      };
      clips.push({ samples, startMs: plan.placementMs, gain: db(gainDb) });
      events.push(withEventHash({
        ...plan,
        gainDb,
        renderedDurationMs: (samples.length / BUS_RATE) * 1_000,
        source,
      }));
      continue;
    }

    const samples = synthesizeFoley(plan);
    const gainDb = DEFAULT_GAIN_DB[plan.type];
    const source: FoleySourceProvenance = {
      kind: 'synthesized',
      generator: 'deterministic-foley',
      generatorVersion: FOLEY_GENERATOR_VERSION,
      seed: plan.seed,
    };
    clips.push({ samples, startMs: plan.placementMs, gain: db(gainDb) });
    events.push(withEventHash({
      ...plan,
      gainDb,
      renderedDurationMs: (samples.length / BUS_RATE) * 1_000,
      source,
    }));
  }

  return { clips, events };
}
