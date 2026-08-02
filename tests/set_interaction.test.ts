import { describe, expect, it } from 'vitest';
import { loadSet, renderSet, validateSet } from '../src/sets/index.ts';
import {
  interactionHandle,
  propHandlePoint,
  propHasReference,
  resolvePropReference,
  resolveSetProps,
} from '../src/sets/interaction.ts';
import { getProp } from '../src/sets/props/index.ts';
import { SetDescriptor } from '../src/sets/schema.ts';

describe('non-portable interaction surfaces', () => {
  it('gives desk and monitor deterministic contact geometry without making them carryable', () => {
    const desk = getProp('desk').interaction;
    const monitor = getProp('monitor').interaction;

    expect(desk).toMatchObject({
      portable: false,
      bounds: { x: -125, y: -96, width: 250, height: 96 },
    });
    expect(desk?.handles.map((handle) => handle.id)).toEqual(['work-surface', 'place-center']);
    expect(monitor?.portable).toBe(false);
    expect(monitor?.handles.some((handle) => handle.id === 'screen' && handle.kind === 'contact')).toBe(true);
    expect(monitor?.handles.some((handle) => handle.id === 'power' && handle.kind === 'control')).toBe(true);
  });

  it('resolves table to desk only as a fallback and never guesses between desks', () => {
    const oneDesk = resolveSetProps(SetDescriptor.parse({
      name: 'one-desk',
      layers: { mid: [{ id: 'desk-main', prop: 'desk' }] },
    }));
    const desk = resolvePropReference('the table', oneDesk, 'test action');
    expect(desk.id).toBe('desk-main');
    expect(propHasReference(desk, 'table')).toBe(true);

    const ambiguous = resolveSetProps(SetDescriptor.parse({
      name: 'two-desks',
      layers: {
        mid: [
          { id: 'desk-left', prop: 'desk' },
          { id: 'desk-right', prop: 'desk' },
        ],
      },
    }));
    expect(() => resolvePropReference('table', ambiguous, 'test action')).toThrow(/ambiguous.*desk-left.*desk-right/i);

    const exactIdWins = resolveSetProps(SetDescriptor.parse({
      name: 'exact-id',
      layers: {
        mid: [
          { id: 'desk-main', prop: 'desk' },
          { id: 'table', prop: 'mug' },
        ],
      },
    }));
    expect(resolvePropReference('table', exactIdWins, 'test action').prop).toBe('mug');
  });
});

describe('production office proof set', () => {
  it('ships as a separate valid set with stable useful targets and a real desk surface', async () => {
    const set = await loadSet('production-office');
    expect(set.name).toBe('production-office');
    expect(validateSet(set)).toEqual([]);

    const props = resolveSetProps(set);
    expect(props.every((prop) => prop.stableId)).toBe(true);
    const byId = new Map(props.map((prop) => [prop.id, prop]));
    for (const id of [
      'desk-main', 'mug-hero', 'laptop-main', 'monitor-main', 'chair-host', 'chair-guest',
    ]) {
      expect(byId.has(id), id).toBe(true);
    }

    const desk = resolvePropReference('table', props, 'production office action');
    expect(desk.id).toBe('desk-main');
    expect(desk.interaction?.portable).toBe(false);
    const surface = interactionHandle(desk, 'contact', 'production office action');
    expect(surface.id).toBe('work-surface');
    expect(propHandlePoint(desk, surface)).toEqual({ x: 640, y: 470 });

    expect(byId.get('mug-hero')?.interaction?.portable).toBe(true);
    expect(byId.get('laptop-main')?.interaction?.portable).toBe(true);
    expect(byId.get('monitor-main')?.interaction?.portable).toBe(false);

    const rendered = renderSet(set);
    expect(rendered.back).toContain('data-prop-id="desk-main"');
    expect(rendered.dynamic).toContain('dynamic-prop-mug-hero');
  });
});
