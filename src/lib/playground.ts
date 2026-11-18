// The Try it playground: a little script where every line is worked out on its
// own, top to bottom. A line can be
//   a formula                    @weather_description+' '+@weather_temperature
//   a date pattern               date: d/M EE
//   a format with slots          fmt: %02d:%02d | #hour24,#minute
//   a show/hide condition        visible: eq(#battery_state,1)
//   a name for later lines       greeting = 'Hi, '+@name     (battery_level = 15 sets a phone value)
//   a MAML element               <Text textExp="…" size="60"/>   <Var name="…" expression="…"/>
//   a comment                    // anything
//   a block of MAML              <Group …> … </Group>, <ContentProviderBinder …> … </ContentProviderBinder>,
//                                <!-- comments -->, over as many lines as it needs
// so unrelated things can sit side by side, and the results appear next to each line.

import { evaluate, evalNumber, evalString, formatDate, formatWithParas, type Value, type Vars } from './maml';
import { formulaProblems } from './mamlHelp';
import { SAMPLE_COLUMNS } from './sampleData';

export type LineKind = 'empty' | 'comment' | 'value' | 'date' | 'format' | 'visible' | 'define' | 'element' | 'binder' | 'close';

export interface LineResult {
  kind: LineKind;
  /** What the phone would show (or the value). */
  text: string;
  /** Whether the value is text or a number. */
  type: 'text' | 'number' | null;
  /** For visible: and elements with visibility: whether it is shown. */
  shown?: boolean;
  /** define: the name that was set. */
  name?: string;
  /** Element: its tag, and number attributes worked out. */
  tag?: string;
  extras?: [string, string][];
  problems: string[];
  /** The line as MAML, to copy into a manifest. */
  xml?: string;
}

const ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITY[m]);
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const show = (v: Value) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))) : v);
const typeOf = (v: Value): 'text' | 'number' => (typeof v === 'number' ? 'number' : 'text');

export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4] ?? '');
  return out;
}

const NUMBER_ATTRS = ['x', 'y', 'w', 'h', 'size', 'alpha', 'rotation', 'sweep', 'startAngle', 'r', 'cornerRadius'];

/** A run of lines worked out together: one line, or a MAML block over several. */
export interface Unit {
  start: number;
  end: number;
  block: boolean;
}

/** Work out every line, top to bottom. `vars` is copied; names set by lines are visible to the lines after them. `columns` is what data providers return. */
export function runScript(source: string, base: Vars, now: Date, columns: Record<string, string[]> = SAMPLE_COLUMNS): { results: LineResult[]; vars: Vars; units: Unit[] } {
  const vars: Vars = new Map(base);
  const lines = source.split('\n');
  const results: LineResult[] = new Array(lines.length);
  const units: Unit[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].trim().startsWith('<')) {
      const end = blockEnd(lines, i);
      runBlock(lines.slice(i, end + 1), i, results, vars, now, columns);
      units.push({ start: i, end, block: true });
      i = end + 1;
    } else {
      results[i] = runLine(lines[i], vars, now);
      units.push({ start: i, end: i, block: false });
      i++;
    }
  }
  return { results, vars, units };
}

const TAG = /<!--[\s\S]*?-->|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** How deep the open elements go, and whether a tag or comment is still unfinished. */
function balance(text: string): { depth: number; open: boolean; stack: string[] } {
  const stack: string[] = [];
  let rest = '';
  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    rest += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1]) {
      if (stack[stack.length - 1] === m[1]) stack.pop();
    } else if (m[2] && !/\/\s*$/.test(m[3])) stack.push(m[2]);
  }
  rest += text.slice(last);
  const open = /<!--/.test(rest) || /<[A-Za-z_/!]/.test(rest);
  return { depth: stack.length, open, stack };
}

/** The last line of the block starting at `start`: where it balances, or where the code stops looking like MAML. */
function blockEnd(lines: string[], start: number): number {
  let text = '';
  for (let j = start; j < lines.length; j++) {
    text += (j > start ? '\n' : '') + lines[j];
    const b = balance(text);
    if (b.depth <= 0 && !b.open) return j;
    if (b.open) continue;
    let k = j + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k >= lines.length || !lines[k].trim().startsWith('<')) return j;
  }
  return lines.length - 1;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length - 1;
const blank = (kind: LineKind): LineResult => ({ kind, text: '', type: null, problems: [] });

function runBlock(lines: string[], offset: number, results: LineResult[], vars: Vars, now: Date, columns: Record<string, string[]>) {
  const text = lines.join('\n');
  let binders = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    const first = lineAt(text, m.index);
    const last = lineAt(text, m.index + m[0].length);
    if (m[0].startsWith('<!--')) {
      for (let l = first; l <= last; l++) results[offset + l] ??= blank('comment');
      continue;
    }
    if (m[1]) {
      if (m[1] === 'ContentProviderBinder') binders = Math.max(0, binders - 1);
      results[offset + first] ??= blank('close');
      continue;
    }
    const tagName = m[2];
    let r: LineResult;
    if (tagName === 'ContentProviderBinder') {
      r = runBinder(m[0], vars, columns);
      if (!/\/\s*>$/.test(m[0])) binders++;
    } else if (tagName === 'Variable' && binders > 0) r = runVariable(m[0], vars, columns);
    else r = runElement(m[0], vars, now);
    if (results[offset + first]) continue;
    results[offset + first] = r;
    for (let l = first + 1; l <= last; l++) results[offset + l] ??= blank('close');
  }
  for (let l = 0; l < lines.length; l++) results[offset + l] ??= blank(lines[l].trim() ? 'close' : 'empty');
  const b = balance(text);
  const head = results[offset];
  if (head && (b.depth > 0 || b.open)) {
    const name = b.stack[b.stack.length - 1];
    head.problems.unshift(b.open ? 'A tag or <!-- comment --> is not finished.' : `<${name}> is not closed: add </${name}>.`);
  }
}

/** A data source. Its <Variable>s get the provider's values (sample data, or live weather). */
function runBinder(tag: string, vars: Vars, columns: Record<string, string[]>): LineResult {
  const a = parseAttributes(tag);
  const uri = a.uri ?? '';
  const known = /weather|steps|health/i.test(uri);
  if (known && a.countName) vars.set(a.countName, 1);
  const what = /weather/i.test(uri) ? 'weather' : /steps|health/i.test(uri) ? 'steps' : uri.replace(/^content:\/\//, '').split('/')[0] || 'data';
  const live = /weather/i.test(uri) && columns.city_name?.[0] !== SAMPLE_COLUMNS.city_name[0];
  return {
    kind: 'binder',
    tag: 'ContentProviderBinder',
    text: known ? `${what} · ${live ? 'live' : 'sample'} data` : `${what} · no preview data`,
    type: 'text',
    problems: known ? [] : ['The preview has no data for this provider, so its variables stay empty here.'],
    extras: a.countName ? [[a.countName, known ? '1' : '0']] : [],
    xml: tag,
  };
}

function runVariable(tag: string, vars: Vars, columns: Record<string, string[]>): LineResult {
  const a = parseAttributes(tag);
  const name = a.name ?? '';
  const type = a.type ?? 'string';
  const values = columns[a.column ?? ''];
  const numeric = /^(int|long|float|double|number)/.test(type);
  const val = (x: string): Value => (numeric ? Number(x.replace(/[^\d.-]/g, '')) || 0 : x);
  let shown: Value = numeric ? 0 : '';
  if (name && values) {
    if (type.endsWith('[]')) values.forEach((x, i) => vars.set(`${name}[${i}]`, val(x)));
    shown = val(values[0]);
  }
  if (name) vars.set(name, shown);
  return {
    kind: 'define',
    tag: 'Variable',
    name,
    text: type.endsWith('[]') && values ? values.map((x) => show(val(x))).join(', ') : show(shown),
    type: typeOf(shown),
    problems: name ? [] : ['A <Variable> needs a name.'],
    xml: tag,
  };
}

function runLine(raw: string, vars: Vars, now: Date): LineResult {
  const line = raw.trim();
  if (!line) return { kind: 'empty', text: '', type: null, problems: [] };
  if (line.startsWith('//')) return { kind: 'comment', text: '', type: null, problems: [] };

  const prefixed = /^(date|fmt|visible)\s*:\s*(.*)$/i.exec(line);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const body = prefixed[2];
    if (kind === 'date') return { kind: 'date', text: formatDate(body, now), type: 'text', problems: [], xml: `<DateTime format="${encode(body)}"/>` };
    if (kind === 'fmt') {
      const cut = body.indexOf(' | ');
      const format = (cut === -1 ? body : body.slice(0, cut)).trim();
      const paras = cut === -1 ? '' : body.slice(cut + 3).trim();
      return { kind: 'format', text: formatWithParas(format, paras, vars), type: 'text', problems: paras ? formulaProblems(paras, vars) : [], xml: `<Text format="${encode(format)}" paras="${encode(paras)}"/>` };
    }
    const n = evalNumber(body, vars, 1);
    return { kind: 'visible', text: show(n), type: 'number', shown: n > 0, problems: formulaProblems(body, vars), xml: `visibility="${encode(body)}"` };
  }

  // name = formula  (not == )
  const def = /^([A-Za-z_][\w.]*)\s*=(?!=)\s*(.*)$/.exec(line);
  if (def) {
    const v = evaluate(def[2], vars, '');
    vars.set(def[1], v);
    const isString = typeof v === 'string';
    return { kind: 'define', name: def[1], text: show(v), type: typeOf(v), problems: formulaProblems(def[2], vars), xml: `<Var name="${def[1]}"${isString ? ' type="string"' : ''} expression="${encode(def[2])}"/>` };
  }

  const v = evaluate(line, vars, '');
  return { kind: 'value', text: show(v), type: typeOf(v), problems: formulaProblems(line, vars), xml: `<Text textExp="${encode(line)}"/>` };
}

function runElement(line: string, vars: Vars, now: Date): LineResult {
  const tag = /^<\s*([A-Za-z_][\w.:-]*)/.exec(line)?.[1] ?? '';
  const a = parseAttributes(line);
  const problems: string[] = [];
  const check = (code: string | undefined) => {
    if (code) for (const p of formulaProblems(code, vars)) if (!problems.includes(p)) problems.push(p);
  };

  if (tag === 'Var') {
    const name = a.name ?? '';
    const v = evaluate(a.expression, vars, a.type === 'string' ? '' : 0);
    const value: Value = a.type === 'string' ? show(v) : Number(v) || 0;
    if (name) vars.set(name, value);
    check(a.expression);
    if (!name) problems.push('A <Var> needs a name.');
    return { kind: 'define', name, tag, text: show(value), type: typeOf(value), problems, xml: line };
  }

  let text = '';
  let type: 'text' | 'number' | null = 'text';
  if (tag === 'DateTime' || tag === 'Time') {
    const pattern = a.formatExp !== undefined ? evalString(a.formatExp, vars) : (a.format ?? 'HH:mm');
    check(a.formatExp);
    text = formatDate(pattern, a.value !== undefined ? new Date(evalNumber(a.value, vars, now.getTime())) : now);
  } else if (a.textExp !== undefined) {
    text = evalString(a.textExp, vars);
    check(a.textExp);
  } else if (a.format !== undefined || a.formatExp !== undefined) {
    text = formatWithParas(a.formatExp !== undefined ? evalString(a.formatExp, vars) : a.format, a.paras ?? '', vars);
    check(a.paras);
  } else if (a.text !== undefined) {
    text = a.text;
  } else if (tag === 'ImageNumber') {
    text = String(Math.trunc(evalNumber(a.number ?? a.numberExp, vars)));
    type = 'number';
  } else if (tag === 'Image') {
    text = a.srcExp !== undefined ? evalString(a.srcExp, vars) : (a.src ?? '');
    check(a.srcExp);
  } else {
    type = null;
  }

  const extras: [string, string][] = [];
  for (const k of NUMBER_ATTRS)
    if (a[k] !== undefined && !/^-?\d+(\.\d+)?$/.test(a[k].trim())) {
      extras.push([k, show(evalNumber(a[k], vars))]);
      check(a[k]);
    }
  let shown: boolean | undefined;
  if (a.visibility !== undefined && a.visibility !== 'true') {
    shown = a.visibility === 'false' ? false : evalNumber(a.visibility, vars, 1) > 0;
    check(a.visibility);
  }
  return { kind: 'element', tag, text, type, shown, extras, problems, xml: line };
}

/**
 * The whole script as a lock screen: one-line elements and blocks as written
 * (data sources go into <VariableBinders>), everything else as a centred Text
 * or DateTime stacked down the screen, names as <Var>s. For the Phone view,
 * drawn by the editor's own preview.
 */
export function scriptToLockscreen(source: string, results: LineResult[], units?: Unit[]): string {
  const lines = source.split('\n');
  const list = units ?? lines.map((_, i) => ({ start: i, end: i, block: lines[i].trim().startsWith('<') }));
  const binders: string[] = [];
  const vars: string[] = [];
  const body: string[] = [];
  let y = 260;
  const next = (size: number) => {
    const at = y;
    y += Math.round(size * 1.45);
    return at;
  };
  for (const u of list) {
    const r = results[u.start];
    if (!r) continue;
    const line = lines[u.start].trim();
    if (u.block && u.end > u.start) {
      // A block over several lines: placed as written. Comments and closing tags are fine in XML.
      const text = lines
        .slice(u.start, u.end + 1)
        .join('\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      if (!text) continue;
      for (const part of text.split(/(?=<ContentProviderBinder\b)/)) {
        const m = /^<ContentProviderBinder\b[\s\S]*?<\/ContentProviderBinder>/.exec(part.trim());
        if (m) {
          binders.push(m[0]);
          const after = part.trim().slice(m[0].length).trim();
          if (after) body.push(after);
        } else if (part.trim()) body.push(part.trim());
      }
      continue;
    }
    if (r.kind === 'define') vars.push(r.tag === 'Var' ? line : (r.xml ?? ''));
    else if (r.kind === 'binder') binders.push(line);
    else if (r.kind === 'element') {
      const a = parseAttributes(line);
      let el = line.replace(/\s*\/>\s*$/, '');
      const size = Number(a.size) || 48;
      if (a.x === undefined) el += ` x="540"${a.align === undefined ? ' align="center"' : ''}`;
      if (a.y === undefined) el += ` y="${next(size)}"`;
      if (a.size === undefined && (r.tag === 'Text' || r.tag === 'DateTime')) el += ' size="48"';
      if (a.color === undefined && (r.tag === 'Text' || r.tag === 'DateTime')) el += ' color="#ffffffff"';
      body.push(/\/>\s*$/.test(line) ? `${el}/>` : line);
    } else if (r.kind === 'value' || r.kind === 'date' || r.kind === 'format') {
      const at = next(48);
      const attrs = (r.xml ?? '').replace(/^<(\w+)\s*/, '').replace(/\/>$/, '');
      const tagName = r.kind === 'date' ? 'DateTime' : 'Text';
      body.push(`<${tagName} x="540" y="${at}" align="center" size="48" color="#ffffffff" ${attrs}/>`);
    } else if (r.kind === 'visible') {
      const at = next(40);
      const cond = (r.xml ?? '').replace(/^visibility="/, '').replace(/"$/, '');
      body.push(`<Text x="540" y="${at}" align="center" size="40" color="#ffa8e6ff" text="visible: shown" visibility="${cond}"/>`);
    }
  }
  const head = binders.length ? `<VariableBinders>\n${binders.join('\n')}\n</VariableBinders>\n` : '';
  return `<Lockscreen version="1" screenWidth="1080">\n${head}${vars.join('\n')}\n${body.join('\n')}\n</Lockscreen>`;
}
