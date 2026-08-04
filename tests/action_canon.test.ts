import { describe, it, expect } from 'vitest';
import { stageActionsFor } from '../src/direct/index.ts';
import {
  ACTION_TEMPLATES, MARK_PHRASES, DIRECTION_PHRASES, COUNT_PHRASES, fillTemplate,
  type ActionField,
} from '../src/direct/action-canon.ts';
import type { Mark } from '../src/schema/script.ts';

/**
 * The composer offers these sentences on a button. If the director stops
 * reading one of them, the button starts producing an action the engine calls
 * ambiguous — so every template is filled in and parsed back here.
 */

const NAMES = ['brent', 'paul'];
const marks = (): Map<string, Mark> => new Map<string, Mark>([['brent', 'SL'], ['paul', 'SR']]);

const SAMPLES: Record<ActionField, string> = {
  actor: 'Brent',
  targetActor: 'Paul',
  object: 'mug',
  target: 'desk',
  mark: MARK_PHRASES.FAR_L,
  direction: DIRECTION_PHRASES.left!,
  seat: 'chair',
  count: 'twice',
};

describe('canonical action wording', () => {
  for (const template of ACTION_TEMPLATES) {
    it(`"${template.label}" parses back as one ${template.type}`, () => {
      const text = fillTemplate(template.template, SAMPLES);
      expect(text, 'a placeholder was left unfilled').not.toMatch(/\{/);

      const parsed = stageActionsFor(text, NAMES, marks(), null);
      expect(parsed.unsupported, text).toEqual([]);
      expect(parsed.stage, text).toHaveLength(1);
      expect(parsed.stage[0]!.type, text).toBe(template.type);
      expect(parsed.stage[0]!.actor, text).toBe('brent');
    });
  }

  it('names every field its template asks for', () => {
    for (const template of ACTION_TEMPLATES) {
      const placeholders = [...template.template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(placeholders.sort(), template.id).toEqual([...template.fields].sort());
    }
  });

  it('carries the detail through, not just the verb', () => {
    const parse = (id: string, values: Partial<Record<ActionField, string>>) => {
      const template = ACTION_TEMPLATES.find((t) => t.id === id)!;
      return stageActionsFor(fillTemplate(template.template, { ...SAMPLES, ...values }), NAMES, marks(), null)
        .stage[0]!;
    };

    expect(parse('move', { mark: MARK_PHRASES.FAR_R })).toMatchObject({ to: { mark: 'FAR_R' } });
    expect(parse('sit', { seat: 'desk chair' })).toMatchObject({ seat: 'desk chair' });
    expect(parse('sit_floor', {})).toMatchObject({ floor: true });
    expect(parse('look_at', {})).toMatchObject({ target: 'paul' });
    expect(parse('look_dir', { direction: DIRECTION_PHRASES.front! })).toMatchObject({ direction: 'front' });
    expect(parse('turn_at', {})).toMatchObject({ target: 'paul' });
    expect(parse('reach', {})).toMatchObject({ target: 'mug' });
    expect(parse('pick_up', {})).toMatchObject({ prop: 'mug' });
    expect(parse('put_down', {})).toMatchObject({ prop: 'mug', target: 'desk' });
    expect(parse('tap', { count: 'twice' })).toMatchObject({ target: 'mug', count: 2 });
  });

  it('reads every mark phrase back as that mark', () => {
    const move = ACTION_TEMPLATES.find((t) => t.id === 'move')!;
    for (const [mark, phrase] of Object.entries(MARK_PHRASES)) {
      const text = fillTemplate(move.template, { ...SAMPLES, mark: phrase });
      expect(stageActionsFor(text, NAMES, marks(), null).stage[0], text).toMatchObject({ to: { mark } });
    }
  });

  it('reads every direction phrase back as that facing', () => {
    const look = ACTION_TEMPLATES.find((t) => t.id === 'look_dir')!;
    for (const [direction, phrase] of Object.entries(DIRECTION_PHRASES)) {
      const text = fillTemplate(look.template, { ...SAMPLES, direction: phrase });
      expect(stageActionsFor(text, NAMES, marks(), null).stage[0], text).toMatchObject({ direction });
    }
  });

  it('reads every tap count back', () => {
    const tap = ACTION_TEMPLATES.find((t) => t.id === 'tap')!;
    const expected: Record<string, number> = { once: 1, twice: 2, 'three times': 3 };
    for (const phrase of COUNT_PHRASES) {
      const text = fillTemplate(tap.template, { ...SAMPLES, count: phrase });
      expect(stageActionsFor(text, NAMES, marks(), null).stage[0], text)
        .toMatchObject({ count: expected[phrase] });
    }
  });
});
