import type { Mark, StageAction } from '../schema/script.ts';

/**
 * Ways of writing an action that the director is known to understand.
 *
 * The prose parser in this directory is deliberately conservative: anything it
 * cannot name becomes a preflight error rather than an invented performance.
 * That is the right call for scripts written by hand, and a terrible experience
 * for someone guessing at phrasing in an editor. So these are the sentences
 * that provably survive the round trip — a test fills every one of them and
 * requires stageActionsFor to give back exactly the action it describes.
 *
 * They are templates rather than a builder because the composer needs the
 * wording too, and one copy of it is the only way the button and the parser
 * can't disagree.
 */

export type ActionField =
  | 'actor' | 'targetActor' | 'object' | 'target' | 'mark' | 'direction' | 'seat' | 'count';

export interface ActionTemplate {
  /** Distinguishes the two ways to look at something; not the action type. */
  id: string;
  type: StageAction['type'];
  label: string;
  fields: ActionField[];
  /** Placeholders in {braces}, one per field. */
  template: string;
}

/** How to say each mark so markIn() reads it back. */
export const MARK_PHRASES: Record<Mark, string> = {
  FAR_L: 'far left',
  SL: 'left',
  CENTER: 'centre',
  SR: 'right',
  FAR_R: 'far right',
};

/** How to say each facing so directionIn() reads it back. */
export const DIRECTION_PHRASES: Record<string, string> = {
  left: 'left',
  right: 'right',
  front: 'toward camera',
};

/** Tap counts the parser recognises. Anything else reads as once. */
export const COUNT_PHRASES = ['once', 'twice', 'three times'];

export const ACTION_TEMPLATES: ActionTemplate[] = [
  { id: 'enter', type: 'enter', label: 'enters', fields: ['actor'], template: '{actor} enters.' },
  { id: 'exit', type: 'exit', label: 'exits', fields: ['actor'], template: '{actor} exits.' },
  { id: 'move', type: 'move', label: 'moves to', fields: ['actor', 'mark'], template: '{actor} moves to the {mark}.' },
  { id: 'sit', type: 'sit', label: 'sits in', fields: ['actor', 'seat'], template: '{actor} sits in the {seat}.' },
  { id: 'sit_floor', type: 'sit', label: 'sits on the floor', fields: ['actor'], template: '{actor} sits on the floor.' },
  { id: 'stand', type: 'stand', label: 'stands up', fields: ['actor'], template: '{actor} stands up.' },
  { id: 'look_at', type: 'look', label: 'looks at', fields: ['actor', 'targetActor'], template: '{actor} looks at {targetActor}.' },
  { id: 'look_dir', type: 'look', label: 'looks', fields: ['actor', 'direction'], template: '{actor} looks {direction}.' },
  { id: 'turn_at', type: 'turn', label: 'turns to', fields: ['actor', 'targetActor'], template: '{actor} turns to {targetActor}.' },
  { id: 'turn_dir', type: 'turn', label: 'turns', fields: ['actor', 'direction'], template: '{actor} turns {direction}.' },
  { id: 'reach', type: 'reach', label: 'reaches for', fields: ['actor', 'object'], template: '{actor} reaches for the {object}.' },
  { id: 'pick_up', type: 'pick_up', label: 'picks up', fields: ['actor', 'object'], template: '{actor} picks up the {object}.' },
  {
    id: 'put_down',
    type: 'put_down',
    label: 'puts down',
    fields: ['actor', 'object', 'target'],
    template: '{actor} puts down the {object} on the {target}.',
  },
  { id: 'tap', type: 'tap', label: 'taps', fields: ['actor', 'object', 'count'], template: '{actor} taps the {object} {count}.' },
];

/** Fill a template. Anything left unfilled keeps its placeholder, visibly. */
export function fillTemplate(template: string, values: Partial<Record<ActionField, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, field: string) => {
    const value = values[field as ActionField]?.trim();
    return value || whole;
  });
}
