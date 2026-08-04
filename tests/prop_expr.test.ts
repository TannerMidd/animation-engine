import { describe, it, expect } from 'vitest';
import { compileExpr, compileField, truthy, ExprError, FUNCTION_NAMES } from '../src/sets/props/expr.ts';

/**
 * The expression language props use to answer to their own parameters.
 *
 * Two properties matter more than the arithmetic. First, an expression can
 * only name declared parameters — everything else is a compile-time rejection,
 * so a typo cannot become a `NaN` in a rendered frame. Second, there is no way
 * to reach a clock, a random source, or anything else outside that scope, which
 * is what keeps a data-defined prop as deterministic as a coded one.
 */

const PARAMS = ['width', 'height', 'drawers', 'on', 'i', 'j'];
const ev = (src: string, scope: Record<string, number> = {}) => compileExpr(src, PARAMS).eval(scope);

describe('arithmetic', () => {
  it('applies the usual precedence', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('10 - 2 - 3')).toBe(5);
    expect(ev('12 / 3 / 2')).toBe(2);
    expect(ev('7 % 4')).toBe(3);
  });

  it('reads decimals and negatives', () => {
    expect(ev('0.5 * 8')).toBe(4);
    expect(ev('-6')).toBe(-6);
    expect(ev('-width / 2', { width: 250 })).toBe(-125);
    expect(ev('- -3')).toBe(3);
  });

  it('resolves parameters from the scope', () => {
    expect(ev('width', { width: 250 })).toBe(250);
    expect(ev('width * 0.55', { width: 200 })).toBeCloseTo(110);
    expect(ev('height / drawers', { height: 180, drawers: 3 })).toBe(60);
  });

  it('treats a missing value as zero rather than NaN', () => {
    // A param the caller forgot is a bug, but a hole in the geometry is a
    // better failure than a shape that vanishes into NaN.
    expect(ev('width + 5')).toBe(5);
  });
});

describe('conditions', () => {
  it('yields 1 or 0 from comparisons', () => {
    expect(ev('3 < 4')).toBe(1);
    expect(ev('3 > 4')).toBe(0);
    expect(ev('4 >= 4')).toBe(1);
    expect(ev('4 == 4')).toBe(1);
    expect(ev('4 != 4')).toBe(0);
  });

  it('combines them', () => {
    expect(ev('1 && 0')).toBe(0);
    expect(ev('1 || 0')).toBe(1);
    expect(ev('!0')).toBe(1);
    expect(ev('!on', { on: 1 })).toBe(0);
  });

  it('supports a right-associative ternary', () => {
    expect(ev('1 ? 10 : 20')).toBe(10);
    expect(ev('0 ? 10 : 20')).toBe(20);
    expect(ev('0 ? 1 : 0 ? 2 : 3')).toBe(3);
    expect(ev('width > 200 ? 12 : 6', { width: 250 })).toBe(12);
  });

  it('expresses the deterministic lit-window pattern', () => {
    // facade's "some lights on" rule, which is the reason repeat indices are in
    // scope at all. No RNG, and identical on every render.
    const lit = (i: number, j: number) => ev('(i * 3 + j) % 3 != 1', { i, j });
    expect([0, 1, 2].map((j) => lit(0, j))).toEqual([1, 0, 1]);
    expect([0, 1, 2].map((j) => lit(1, j))).toEqual([1, 0, 1]);
  });
});

describe('functions', () => {
  it('computes the fixed numeric set', () => {
    expect(ev('min(46, 80)')).toBe(46);
    expect(ev('max(1, 2, 3)')).toBe(3);
    expect(ev('abs(-4)')).toBe(4);
    expect(ev('round(2.6)')).toBe(3);
    expect(ev('floor(2.9)')).toBe(2);
    expect(ev('ceil(2.1)')).toBe(3);
    expect(ev('sqrt(9)')).toBe(3);
  });

  it('takes degrees for the trigonometric ones', () => {
    // Prop geometry is authored in degrees everywhere else; radians here would
    // be a trap nobody would find twice.
    expect(ev('sin(90)')).toBeCloseTo(1);
    expect(ev('cos(0)')).toBeCloseTo(1);
    expect(ev('cos(180)')).toBeCloseTo(-1);
  });

  it('nests', () => {
    expect(ev('min(46, width / drawers * 0.5)', { width: 320, drawers: 2 })).toBe(46);
    expect(ev('min(46, width / drawers * 0.5)', { width: 100, drawers: 2 })).toBe(25);
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => compileExpr('abs(1, 2)', PARAMS)).toThrow(/takes 1 argument/);
    expect(() => compileExpr('min()', PARAMS)).toThrow(/at least one/);
  });

  it('names the available functions when one is unknown', () => {
    const err = (() => { try { compileExpr('tan(1)', PARAMS); } catch (e) { return e as ExprError; } })()!;
    expect(err.message).toMatch(/unknown function "tan"/);
    for (const name of FUNCTION_NAMES) expect(err.message).toContain(name);
  });
});

describe('the scope is the whole world', () => {
  it('rejects a name the prop does not declare, and says what it could have used', () => {
    const err = (() => { try { compileExpr('depth * 2', PARAMS); } catch (e) { return e as ExprError; } })()!;
    expect(err).toBeInstanceOf(ExprError);
    expect(err.message).toMatch(/unknown name "depth"/);
    expect(err.message).toContain('width');
  });

  it.each(['Math', 'Date', 'random', 'globalThis', 'process', 'window', 'constructor', '__proto__', 'require'])(
    'cannot reach %s',
    (name) => {
      expect(() => compileExpr(name, PARAMS)).toThrow(ExprError);
      expect(() => compileExpr(`${name}.now()`, PARAMS)).toThrow(ExprError);
    },
  );

  it('has no syntax for property access, calls on values, or strings', () => {
    expect(() => compileExpr('width.length', PARAMS)).toThrow(ExprError);
    expect(() => compileExpr('width(3)', PARAMS)).toThrow(/unknown function/);
    expect(() => compileExpr('"abc"', PARAMS)).toThrow(ExprError);
    expect(() => compileExpr('width = 3', PARAMS)).toThrow(ExprError);
    expect(() => compileExpr('width; height', PARAMS)).toThrow(ExprError);
  });

  it('resolves a param named like a prototype member as a number, never a function', () => {
    const compiled = compileExpr('constructor + 1', ['constructor']);
    expect(compiled.eval({})).toBe(1);
    expect(compiled.eval({ constructor: 4 })).toBe(5);
  });

  it('says so when a prop declares no parameters at all', () => {
    expect(() => compileExpr('width', [])).toThrow(/declares no parameters/);
  });
});

describe('syntax errors', () => {
  it.each([
    ['1 +', 'ended early'],
    ['(1 + 2', 'expected ")"'],
    ['1 ? 2', 'expected ":"'],
    ['1 @ 2', 'unexpected character'],
    ['', 'ended early'],
  ])('rejects %s', (src, message) => {
    expect(() => compileExpr(src, PARAMS)).toThrow(new RegExp(message.replace(/[()]/g, '\\$&')));
  });

  it('reports where the problem was', () => {
    const err = (() => { try { compileExpr('width + @', PARAMS); } catch (e) { return e as ExprError; } })()!;
    expect(err.at).toBe(8);
    expect(err.source).toBe('width + @');
  });
});

describe('compiled expressions', () => {
  it('reports the names it actually references', () => {
    expect([...compileExpr('width / 2 + height', PARAMS).refs].sort()).toEqual(['height', 'width']);
    expect([...compileExpr('12', PARAMS).refs]).toEqual([]);
  });

  it('accepts a literal number as a field without parsing it', () => {
    const f = compileField(250, PARAMS);
    expect(f.eval({})).toBe(250);
    expect([...f.refs]).toEqual([]);
    expect(compileField('width / 2', PARAMS).eval({ width: 80 })).toBe(40);
  });

  it('refuses a non-finite literal', () => {
    expect(() => compileField(Number.NaN, PARAMS)).toThrow(ExprError);
    expect(() => compileField(Number.POSITIVE_INFINITY, PARAMS)).toThrow(ExprError);
  });

  it('is a pure function of its scope', () => {
    const compiled = compileExpr('width * 0.55 + height', PARAMS);
    const scope = { width: 200, height: 30 };
    const first = compiled.eval(scope);
    for (let n = 0; n < 50; n++) expect(compiled.eval(scope)).toBe(first);
  });
});

describe('truthy', () => {
  it('treats zero and NaN as false', () => {
    expect(truthy(1)).toBe(true);
    expect(truthy(-1)).toBe(true);
    expect(truthy(0)).toBe(false);
    expect(truthy(Number.NaN)).toBe(false);
  });
});
