/**
 * Arithmetic over a prop's own parameters.
 *
 * A prop document describes shapes as data, but a *parametric* prop needs its
 * geometry to answer to its controls — a desk's legs move when the desk gets
 * wider. Every hand-written `render()` in the catalogue does that with ordinary
 * arithmetic (`-w / 2`, `h * 0.55`), so a data format without arithmetic is
 * simply a weaker version of the thing it replaces.
 *
 * This is that arithmetic and nothing else. The grammar has no strings, no
 * assignment, no property access, no calls other than a fixed numeric set, and
 * — critically — no way to name anything outside the prop's declared params and
 * the loop variables of an enclosing repeat. There is no clock and no random,
 * not because they are blocked but because they cannot be written: determinism
 * is a property of the grammar rather than a rule someone has to remember.
 *
 * Identifiers are resolved when the expression is compiled, not when it runs,
 * so a typo is a save-time rejection naming the offending word rather than a
 * `NaN` discovered in a rendered frame.
 *
 * The user is not expected to type these. The studio writes them from direct
 * manipulation — drag a rect's edge onto the Width control and it emits
 * `width / 2`. The raw field exists for the case the affordances don't cover.
 */

/** Values in scope: numeric params, booleans as 0/1, and repeat indices. */
export type Scope = Record<string, number>;

export class ExprError extends Error {
  constructor(message: string, readonly source: string, readonly at: number) {
    super(message);
    this.name = 'ExprError';
  }
}

/** The only functions an expression may call. `sin`/`cos` take degrees. */
const FUNCTIONS: Record<string, { arity: number | 'variadic'; fn: (...a: number[]) => number }> = {
  min: { arity: 'variadic', fn: Math.min },
  max: { arity: 'variadic', fn: Math.max },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  sqrt: { arity: 1, fn: Math.sqrt },
  sin: { arity: 1, fn: (d) => Math.sin((d * Math.PI) / 180) },
  cos: { arity: 1, fn: (d) => Math.cos((d * Math.PI) / 180) },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

// --- lexer ----------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number; i: number }
  | { t: 'id'; v: string; i: number }
  | { t: 'op'; v: string; i: number }
  | { t: 'end'; v: ''; i: number };

/** Longest first, so `<=` never lexes as `<` then `=`. */
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',', '?', ':'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), i });
      i += m[0].length;
      continue;
    }

    // A leading `.` would be ambiguous with property access, which this grammar
    // does not have and must not appear to have. Numbers are written `0.5`.
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], i });
      i += m[0].length;
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character "${ch}"`, src, i);
    out.push({ t: 'op', v: op, i });
    i += op.length;
  }

  out.push({ t: 'end', v: '', i });
  return out;
}

// --- parser ---------------------------------------------------------------

/** Binding powers, loosest first. Everything is left-associative bar the ternary. */
const BP: Record<string, number> = {
  '||': 2, '&&': 3,
  '==': 4, '!=': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

type Node = (scope: Scope) => number;

const bool = (v: boolean): number => (v ? 1 : 0);

class Parser {
  private pos = 0;
  readonly refs = new Set<string>();

  constructor(private readonly toks: Tok[], private readonly src: string, private readonly allowed: ReadonlySet<string>) {}

  private peek(): Tok {
    return this.toks[this.pos]!;
  }

  private next(): Tok {
    return this.toks[this.pos++]!;
  }

  private expect(op: string): void {
    const tok = this.next();
    if (tok.t !== 'op' || tok.v !== op) {
      throw new ExprError(`expected "${op}"`, this.src, tok.i);
    }
  }

  parse(): Node {
    const node = this.expr(0);
    const tail = this.peek();
    if (tail.t !== 'end') throw new ExprError(`unexpected "${tail.v}"`, this.src, tail.i);
    return node;
  }

  private expr(minBp: number): Node {
    let left = this.unary();

    for (;;) {
      const tok = this.peek();
      if (tok.t !== 'op') break;

      // The ternary binds looser than every binary operator and associates
      // right, so it is handled here rather than in the precedence table.
      if (tok.v === '?' && minBp <= 1) {
        this.next();
        const then = this.expr(0);
        this.expect(':');
        const otherwise = this.expr(1);
        const cond = left;
        left = (s) => (cond(s) ? then(s) : otherwise(s));
        continue;
      }

      const bp = BP[tok.v];
      if (bp === undefined || bp < minBp) break;
      this.next();
      const right = this.expr(bp + 1);
      left = this.binary(tok.v, left, right);
    }

    return left;
  }

  private binary(op: string, l: Node, r: Node): Node {
    switch (op) {
      case '+': return (s) => l(s) + r(s);
      case '-': return (s) => l(s) - r(s);
      case '*': return (s) => l(s) * r(s);
      case '/': return (s) => l(s) / r(s);
      case '%': return (s) => l(s) % r(s);
      case '<': return (s) => bool(l(s) < r(s));
      case '<=': return (s) => bool(l(s) <= r(s));
      case '>': return (s) => bool(l(s) > r(s));
      case '>=': return (s) => bool(l(s) >= r(s));
      case '==': return (s) => bool(l(s) === r(s));
      case '!=': return (s) => bool(l(s) !== r(s));
      // Kept numeric rather than short-circuiting to a value: every expression
      // in this language returns a number, so `a || b` is a predicate, not a
      // default-value idiom that would quietly return the wrong type.
      case '&&': return (s) => bool(l(s) !== 0 && r(s) !== 0);
      case '||': return (s) => bool(l(s) !== 0 || r(s) !== 0);
      default: throw new ExprError(`unknown operator "${op}"`, this.src, 0);
    }
  }

  private unary(): Node {
    const tok = this.peek();
    if (tok.t === 'op' && tok.v === '-') {
      this.next();
      const operand = this.unary();
      return (s) => -operand(s);
    }
    if (tok.t === 'op' && tok.v === '+') {
      this.next();
      return this.unary();
    }
    if (tok.t === 'op' && tok.v === '!') {
      this.next();
      const operand = this.unary();
      return (s) => bool(operand(s) === 0);
    }
    return this.primary();
  }

  private primary(): Node {
    const tok = this.next();

    if (tok.t === 'num') {
      const v = tok.v;
      return () => v;
    }

    if (tok.t === 'op' && tok.v === '(') {
      const inner = this.expr(0);
      this.expect(')');
      return inner;
    }

    if (tok.t === 'id') {
      const name = tok.v;
      const after = this.peek();

      if (after.t === 'op' && after.v === '(') {
        const fn = FUNCTIONS[name];
        if (!fn) {
          throw new ExprError(
            `unknown function "${name}". Available: ${FUNCTION_NAMES.join(', ')}`,
            this.src, tok.i,
          );
        }
        this.next();
        const args: Node[] = [];
        if (!(this.peek().t === 'op' && this.peek().v === ')')) {
          for (;;) {
            args.push(this.expr(0));
            const sep = this.peek();
            if (sep.t === 'op' && sep.v === ',') { this.next(); continue; }
            break;
          }
        }
        this.expect(')');
        if (fn.arity !== 'variadic' && args.length !== fn.arity) {
          throw new ExprError(`${name}() takes ${fn.arity} argument(s), got ${args.length}`, this.src, tok.i);
        }
        if (fn.arity === 'variadic' && args.length === 0) {
          throw new ExprError(`${name}() needs at least one argument`, this.src, tok.i);
        }
        const call = fn.fn;
        return (s) => call(...args.map((a) => a(s)));
      }

      // Resolved now, not at render time. An expression that survives compilation
      // can only name things that exist.
      if (!this.allowed.has(name)) {
        const known = [...this.allowed].sort();
        throw new ExprError(
          `unknown name "${name}"${known.length ? `. Available: ${known.join(', ')}` : ' — this prop declares no parameters'}`,
          this.src, tok.i,
        );
      }
      this.refs.add(name);
      // `typeof` rather than `??`: a scope is an ordinary object, so a param
      // called `constructor` would otherwise resolve to a function and reach
      // the geometry as NaN. Names are validated, but this costs nothing.
      return (s) => {
        const v = s[name];
        return typeof v === 'number' ? v : 0;
      };
    }

    throw new ExprError(tok.t === 'end' ? 'expression ended early' : `unexpected "${tok.v}"`, this.src, tok.i);
  }
}

// --- public surface -------------------------------------------------------

export interface CompiledExpr {
  /** The text as authored, kept so the studio round-trips what it wrote. */
  source: string;
  /** Names actually referenced, for "which shapes move with this param". */
  refs: ReadonlySet<string>;
  eval(scope: Scope): number;
}

/**
 * Compile an expression against the names it is allowed to use.
 *
 * Throws `ExprError` on a syntax error or an unknown name. Callers validating
 * a document should let that reach the user with its message intact — it names
 * the offending word and lists what was available instead.
 */
export function compileExpr(source: string, allowed: Iterable<string>): CompiledExpr {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  const parser = new Parser(lex(source), source, set);
  const fn = parser.parse();
  return { source, refs: parser.refs, eval: (scope) => fn(scope) };
}

/**
 * A field that is either a literal number or an expression over the params.
 *
 * Stored in a document as `250` or `"width / 2"`; both compile to the same
 * thing, so nothing downstream has to care which one an author used.
 */
export type NumberField = number | string;

export function compileField(field: NumberField, allowed: Iterable<string>): CompiledExpr {
  if (typeof field === 'number') {
    if (!Number.isFinite(field)) throw new ExprError(`${field} is not a finite number`, String(field), 0);
    return { source: String(field), refs: new Set(), eval: () => field };
  }
  return compileExpr(field, allowed);
}

/** True when the value is meant as a condition — repeat counts, `show`. */
export function truthy(v: number): boolean {
  return v !== 0 && !Number.isNaN(v);
}
