import { describe, it, expect } from 'vitest';
import { Rig } from '../src/schema/index.ts';
import { buildPlaceholderRig } from '../src/cast/placeholder.ts';

/**
 * Schema evolution.
 *
 * Characters are files a user accumulates and hand-edits. Adding a field to the
 * rig schema must never make yesterday's saved cast unopenable — that is a bug
 * that only shows up long after the change, on someone else's machine.
 */
describe('rig schema tolerates older files', () => {
  const current = () => JSON.parse(JSON.stringify(buildPlaceholderRig('steve'))) as Record<string, unknown>;

  it('fills in focus when a file predates it', () => {
    const old = current();
    delete old['focus'];
    const parsed = Rig.parse(old);
    // Somewhere in the upper part of the puppet — good enough to frame a
    // close-up on until the character is regenerated.
    expect(parsed.focus[0]).toBeCloseTo(parsed.canvas.width / 2, 5);
    expect(parsed.focus[1]).toBeGreaterThan(0);
    expect(parsed.focus[1]).toBeLessThan(parsed.canvas.height / 2);
  });

  it('keeps an explicit focus untouched', () => {
    const rig = current();
    rig['focus'] = [42, 17];
    expect(Rig.parse(rig).focus).toEqual([42, 17]);
  });

  it('fills in voice fields when a file predates them', () => {
    const old = current();
    delete old['voiceRef'];
    delete old['voiceRate'];
    const parsed = Rig.parse(old);
    expect(parsed.voiceRef).toBeNull();
    expect(parsed.voiceRate).toBe(0);
  });

  it('still rejects a file that is genuinely broken', () => {
    const bad = current();
    delete bad['parts'];
    expect(() => Rig.parse(bad)).toThrow();
  });
});
