import { describe, expect, it } from 'vitest';
import { isTyping, placeMenu } from '../ui/src/editor/lib.ts';

const VIEWPORT = { w: 1280, h: 800 };
const MENU = { w: 236, h: 200 };

describe('placeMenu', () => {
  it('opens down and to the right when there is room', () => {
    const place = placeMenu({ x: 300, y: 200 }, MENU, VIEWPORT);
    expect(place).toEqual({ left: 300, top: 200, maxHeight: 200 });
  });

  it('flips left rather than sliding, so the pointer stays on a corner', () => {
    const place = placeMenu({ x: 1200, y: 200 }, MENU, VIEWPORT);
    expect(place.left).toBe(1200 - MENU.w);
    expect(place.top).toBe(200);
  });

  it('flips up at the bottom edge', () => {
    const place = placeMenu({ x: 300, y: 760 }, MENU, VIEWPORT);
    expect(place.left).toBe(300);
    expect(place.top).toBe(760 - MENU.h);
  });

  it('flips both ways in the bottom-right corner', () => {
    const place = placeMenu({ x: 1270, y: 790 }, MENU, VIEWPORT);
    expect(place.left).toBe(1270 - MENU.w);
    expect(place.top).toBe(790 - MENU.h);
  });

  it('clamps into the gutter when neither orientation fits', () => {
    // A menu wider and taller than the viewport it is opening in.
    const place = placeMenu({ x: 40, y: 30 }, { w: 400, h: 300 }, { w: 320, h: 240 }, 8);
    expect(place.left).toBe(8);
    expect(place.top).toBe(8);
  });

  it('caps its height to the viewport so a long menu scrolls instead of overflowing', () => {
    const place = placeMenu({ x: 100, y: 400 }, { w: 236, h: 2000 }, VIEWPORT, 8);
    expect(place.maxHeight).toBe(VIEWPORT.h - 16);
    expect(place.top).toBe(8);
  });

  it('never places the menu off the top or left edge', () => {
    const place = placeMenu({ x: 2, y: 3 }, MENU, VIEWPORT);
    expect(place.left).toBeGreaterThanOrEqual(8);
    expect(place.top).toBeGreaterThanOrEqual(8);
  });

  it('keeps a custom gutter clear on every side', () => {
    const gutter = 20;
    const place = placeMenu({ x: 1279, y: 799 }, MENU, VIEWPORT, gutter);
    expect(place.left).toBeGreaterThanOrEqual(gutter);
    expect(place.top).toBeGreaterThanOrEqual(gutter);
    expect(place.left + MENU.w).toBe(VIEWPORT.w - gutter);
    expect(place.top + place.maxHeight).toBe(VIEWPORT.h - gutter);
  });
});

describe('isTyping', () => {
  it('is false for nothing', () => {
    expect(isTyping(null)).toBe(false);
  });

  it('recognises the editable tags by name', () => {
    // No DOM in this suite, so stand in for the element shape isTyping reads.
    const like = (tag: string) => ({ tagName: tag, isContentEditable: false, closest: () => null });
    expect(isTyping(like('INPUT') as unknown as EventTarget)).toBe(true);
    expect(isTyping(like('TEXTAREA') as unknown as EventTarget)).toBe(true);
    expect(isTyping(like('SELECT') as unknown as EventTarget)).toBe(true);
    expect(isTyping(like('DIV') as unknown as EventTarget)).toBe(false);
  });

  it('recognises contenteditable and anything inside the script editor', () => {
    const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null };
    const inCodeMirror = { tagName: 'SPAN', isContentEditable: false, closest: (s: string) => (s === '.cm-editor' ? {} : null) };
    expect(isTyping(editable as unknown as EventTarget)).toBe(true);
    expect(isTyping(inCodeMirror as unknown as EventTarget)).toBe(true);
  });
});
