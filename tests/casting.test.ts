import { describe, it, expect, vi, afterEach } from 'vitest';
import { bankPreference, resolveBankAssignments } from '../src/voice/casting.ts';

/**
 * The mint contract: a character's voice preference is pure in (charId, salt),
 * and assignment resolves preferences into a cast with no two characters
 * sharing a bank voice while voices remain. The old pitch-shift mint had
 * neither property — both new characters in a cast could land on the same
 * SAPI base, and did.
 */

afterEach(() => vi.restoreAllMocks());

describe('bankPreference', () => {
  it('is pure in (charId, salt)', () => {
    expect(bankPreference('greg', '')).toEqual(bankPreference('greg', ''));
    expect(bankPreference('greg', '2')).toEqual(bankPreference('greg', '2'));
  });

  it('shuffles the whole bank into a valid permutation', () => {
    const { order, speed, seed } = bankPreference('greg', '');
    expect(order.length).toBeGreaterThanOrEqual(10);
    expect(new Set(order).size).toBe(order.length);
    for (const voice of order) expect(voice).toMatch(/^(af|am|bf|bm)_[a-z]+$/);
    // Speed is a duration nudge, never a register transform.
    expect(speed).toBeGreaterThanOrEqual(0.95);
    expect(speed).toBeLessThanOrEqual(1.05);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(1);
  });

  it('rerolls to a different preference under a new salt', () => {
    // Distinct salts must offer genuinely different candidates, or the reroll
    // button is a placebo. Orders are 14-element shuffles; collision across
    // three salts would point straight at a broken stream derivation.
    const orders = ['', '1', '2'].map((salt) => bankPreference('greg', salt).order.join(','));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('differs between characters', () => {
    const a = bankPreference('greg', '');
    const b = bankPreference('paula', '');
    expect(a.order.join(',')).not.toBe(b.order.join(','));
  });
});

describe('resolveBankAssignments', () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ charId: `char-${i}`, salt: '' }));

  it('never assigns the same voice twice while the bank has voices to spare', () => {
    const assigned = resolveBankAssignments(tasks(14), new Set());
    expect(new Set(assigned.map((a) => a.bankVoice)).size).toBe(assigned.length);
  });

  it('respects voices already committed on other rigs', () => {
    const free = resolveBankAssignments(tasks(3), new Set());
    const taken = new Set([free[0]!.bankVoice, free[1]!.bankVoice]);
    const assigned = resolveBankAssignments(tasks(3), taken);
    for (const a of assigned) {
      // Bank is large enough that nothing needs to fall back here.
      expect(taken.has(a.bankVoice)).toBe(false);
    }
  });

  it('is deterministic for the same tasks and taken set', () => {
    const taken = new Set(['af_heart', 'bm_george']);
    expect(resolveBankAssignments(tasks(5), taken)).toEqual(resolveBankAssignments(tasks(5), taken));
  });

  it('falls back to the raw first preference, loudly, once the bank is exhausted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assigned = resolveBankAssignments(tasks(15), new Set());
    const unique = new Set(assigned.map((a) => a.bankVoice));
    expect(unique.size).toBeLessThan(assigned.length);
    expect(warn).toHaveBeenCalled();
    // The overflow character reuses its own first preference, not a random slot.
    const overflow = assigned[14]!;
    expect(overflow.bankVoice).toBe(bankPreference('char-14', '').order[0]);
  });
});
