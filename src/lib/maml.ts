// A small evaluator for MAML expressions (the language Xiaomi lock screens,
// clocks and widgets are written in). It covers arithmetic, comparisons,
// strings and the common functions; anything it does not know evaluates to 0
// so a still preview can be drawn. It is not the phone's runtime.

export type Value = number | string;
export type Vars = Map<string, Value>;

// In XML attributes MAML writes < as { and > as }, and && as **.
type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'var'; v: string; s: boolean } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const two = ['**', '||', '==', '!=', '}=', '{=', '>=', '<=', '&&'];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?/i.exec(src.slice(i)) ?? ['0'];
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length || 1;
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      out.push({ t: 'str', v: src.slice(i + 1, end === -1 ? src.length : end) });
      i = end === -1 ? src.length : end + 1;
    } else if (c === '#' || c === '@') {
      const m = /^[\w.]+/.exec(src.slice(i + 1)) ?? [''];
      out.push({ t: 'var', v: m[0], s: c === '@' });
      i += 1 + m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[\w.]+/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (two.includes(src.slice(i, i + 2))) {
      out.push({ t: 'op', v: src.slice(i, i + 2) });
      i += 2;
    } else {
      out.push({ t: 'op', v: c });
      i++;
    }
  }
  return out;
}

const num = (v: Value) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: Value) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))) : v);

const FUNCS: Record<string, (a: Value[]) => Value> = {
  int: (a) => Math.trunc(num(a[0] ?? 0)),
  round: (a) => Math.round(num(a[0] ?? 0)),
  floor: (a) => Math.floor(num(a[0] ?? 0)),
  ceil: (a) => Math.ceil(num(a[0] ?? 0)),
  abs: (a) => Math.abs(num(a[0] ?? 0)),
  sqrt: (a) => Math.sqrt(num(a[0] ?? 0)),
  sin: (a) => Math.sin(num(a[0] ?? 0)),
  cos: (a) => Math.cos(num(a[0] ?? 0)),
  tan: (a) => Math.tan(num(a[0] ?? 0)),
  pow: (a) => Math.pow(num(a[0] ?? 0), num(a[1] ?? 1)),
  max: (a) => Math.max(...a.map(num)),
  min: (a) => Math.min(...a.map(num)),
  rand: () => 0.5,
  not: (a) => (num(a[0] ?? 0) > 0 ? 0 : 1),
  eq: (a) => (num(a[0] ?? 0) === num(a[1] ?? 0) ? 1 : 0),
  ne: (a) => (num(a[0] ?? 0) !== num(a[1] ?? 0) ? 1 : 0),
  ge: (a) => (num(a[0] ?? 0) >= num(a[1] ?? 0) ? 1 : 0),
  gt: (a) => (num(a[0] ?? 0) > num(a[1] ?? 0) ? 1 : 0),
  le: (a) => (num(a[0] ?? 0) <= num(a[1] ?? 0) ? 1 : 0),
  lt: (a) => (num(a[0] ?? 0) < num(a[1] ?? 0) ? 1 : 0),
  isnull: (a) => (a[0] === undefined || a[0] === '' || a[0] === 0 ? 1 : 0),
  len: (a) => str(a[0] ?? '').length,
  digit: (a) => {
    const d = String(Math.abs(Math.trunc(num(a[0] ?? 0))));
    const i = num(a[1] ?? 1);
    return i <= d.length ? Number(d[d.length - i]) : -1;
  },
  substr: (a) => (a[2] === undefined ? str(a[0] ?? '').slice(num(a[1] ?? 0)) : str(a[0] ?? '').slice(num(a[1] ?? 0), num(a[1] ?? 0) + num(a[2]))),
  strContains: (a) => (str(a[0] ?? '').includes(str(a[1] ?? '')) ? 1 : 0),
  strIsEmpty: (a) => (str(a[0] ?? '') === '' ? 1 : 0),
  strToLowerCase: (a) => str(a[0] ?? '').toLowerCase(),
  strToUpperCase: (a) => str(a[0] ?? '').toUpperCase(),
  strTrim: (a) => str(a[0] ?? '').trim(),
  formatDate: (a) => formatDate(str(a[0] ?? ''), a[1] === undefined ? new Date() : new Date(num(a[1]))),
  ifelse: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (num(a[i]) > 0) return a[i + 1];
    return a.length % 2 ? a[a.length - 1] : 0;
  },
};

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private vars: Vars,
  ) {}
  private peek(v?: string) {
    const t = this.toks[this.i];
    return !!t && t.t === 'op' && (v === undefined || t.v === v);
  }
  private take(...ops: string[]) {
    const t = this.toks[this.i];
    if (t && t.t === 'op' && ops.includes(t.v)) {
      this.i++;
      return t.v;
    }
    return null;
  }
  parse(): Value {
    return this.or();
  }
  private or(): Value {
    let l = this.and();
    while (this.take('||')) {
      const r = this.and();
      l = num(l) > 0 || num(r) > 0 ? 1 : 0;
    }
    return l;
  }
  private and(): Value {
    let l = this.cmp();
    while (this.take('**', '&&')) {
      const r = this.cmp();
      l = num(l) > 0 && num(r) > 0 ? 1 : 0;
    }
    return l;
  }
  private cmp(): Value {
    let l = this.add();
    for (;;) {
      const op = this.take('==', '!=', '}=', '{=', '>=', '<=', '}', '{', '>', '<');
      if (!op) return l;
      const r = this.add();
      const text = typeof l === 'string' || typeof r === 'string';
      const eq = text ? str(l) === str(r) : num(l) === num(r);
      l = op === '==' ? +eq : op === '!=' ? +!eq : op === '}=' || op === '>=' ? +(num(l) >= num(r)) : op === '{=' || op === '<=' ? +(num(l) <= num(r)) : op === '}' || op === '>' ? +(num(l) > num(r)) : +(num(l) < num(r));
    }
  }
  private add(): Value {
    let l = this.mul();
    for (;;) {
      const op = this.take('+', '-');
      if (!op) return l;
      const r = this.mul();
      l = op === '-' ? num(l) - num(r) : typeof l === 'string' || typeof r === 'string' ? str(l) + str(r) : num(l) + num(r);
    }
  }
  private mul(): Value {
    let l = this.unary();
    for (;;) {
      const op = this.take('*', '/', '%');
      if (!op) return l;
      const r = num(this.unary());
      l = op === '*' ? num(l) * r : r === 0 ? 0 : op === '/' ? num(l) / r : num(l) % r;
    }
  }
  private unary(): Value {
    if (this.take('-')) return -num(this.unary());
    if (this.take('+')) return num(this.unary());
    if (this.take('!')) return num(this.unary()) > 0 ? 0 : 1;
    return this.primary();
  }
  private primary(): Value {
    const t = this.toks[this.i];
    if (!t) return 0;
    if (t.t === 'num' || t.t === 'str') {
      this.i++;
      return t.v;
    }
    if (t.t === 'var') {
      this.i++;
      return this.vars.get(t.v) ?? (t.s ? '' : 0);
    }
    if (t.t === 'id') {
      this.i++;
      if (this.take('(')) {
        const args: Value[] = [];
        while (this.i < this.toks.length && !this.peek(')')) {
          args.push(this.or());
          if (!this.take(',')) break;
        }
        this.take(')');
        const fn = FUNCS[t.v];
        return fn ? fn(args) : 0;
      }
      return t.v === 'true' ? 1 : t.v === 'false' ? 0 : (this.vars.get(t.v) ?? 0);
    }
    if (this.take('(')) {
      const v = this.or();
      this.take(')');
      return v;
    }
    this.i++;
    return 0;
  }
}

const cache = new Map<string, Tok[]>();

export function evaluate(expression: string | null | undefined, vars: Vars, fallback: Value = 0): Value {
  if (expression === null || expression === undefined || expression.trim() === '') return fallback;
  try {
    let toks = cache.get(expression);
    if (!toks) cache.set(expression, (toks = lex(expression)));
    const v = new Parser(toks, vars).parse();
    return typeof v === 'number' && !Number.isFinite(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

export const evalNumber = (e: string | null | undefined, vars: Vars, fallback = 0) => num(evaluate(e, vars, fallback));
export const evalString = (e: string | null | undefined, vars: Vars, fallback = '') => str(evaluate(e, vars, fallback));

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Java-style date pattern (yyyy MM dd HH mm EEEE…) → text. */
export function formatDate(pattern: string, d: Date) {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return pattern.replace(/'([^']*)'|y+|M+|d+|E+|H+|h+|k+|m+|s+|a+|N+|e+|c+/g, (m, quoted: string | undefined) => {
    if (quoted !== undefined) return quoted;
    const n = m.length;
    switch (m[0]) {
      case 'y':
        return n === 2 ? pad(d.getFullYear() % 100, 2) : String(d.getFullYear());
      case 'M':
        return n >= 4 ? MONTHS[d.getMonth()] : n === 3 ? MONTHS[d.getMonth()].slice(0, 3) : pad(d.getMonth() + 1, n);
      case 'd':
        return pad(d.getDate(), n);
      case 'E':
      case 'c':
        return n >= 4 ? DAYS[d.getDay()] : DAYS[d.getDay()].slice(0, 3);
      case 'H':
      case 'k':
        return pad(d.getHours(), n);
      case 'h':
        return pad(d.getHours() % 12 || 12, n);
      case 'm':
        return pad(d.getMinutes(), n);
      case 's':
        return pad(d.getSeconds(), n);
      case 'a':
        return d.getHours() < 12 ? 'AM' : 'PM';
      default:
        return '';
    }
  });
}

/** The variables the phone provides (clock, screen, a full battery, nothing unread). */
export function systemVars(screenWidth: number, screenHeight: number, now: Date): Vars {
  return new Map<string, Value>([
    ['screen_width', screenWidth],
    ['screen_height', screenHeight],
    ['raw_screen_width', screenWidth],
    ['raw_screen_height', screenHeight],
    ['view_width', screenWidth],
    ['view_height', screenHeight],
    ['time', now.getTime()],
    ['time_sys', now.getTime()],
    ['year', now.getFullYear()],
    ['month', now.getMonth()],
    ['month1', now.getMonth() + 1],
    ['date', now.getDate()],
    ['day_of_week', now.getDay() + 1],
    ['hour12', now.getHours() % 12 || 12],
    ['hour24', now.getHours()],
    ['minute', now.getMinutes()],
    ['second', now.getSeconds()],
    ['ampm', now.getHours() < 12 ? 0 : 1],
    ['time_format', 1],
    ['battery_level', 82],
    ['battery_state', 0],
    ['music_state', 0],
    ['sms_unread_count', 0],
    ['call_missed_count', 0],
    ['frame_rate', 30],
  ]);
}
