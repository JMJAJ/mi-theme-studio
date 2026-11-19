// Small, formatting-preserving edits to a MAML manifest: change attributes of
// the n-th element (in document order) without re-serializing the file, so
// comments, indentation and attribute order stay exactly as the designer wrote them.

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/[^>]*>|<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** Where the start tag of the element with this document-order index sits. */
export function findStartTag(text: string, ordinal: number): { start: number; end: number; name: string } | null {
  TOKEN.lastIndex = 0;
  let n = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (m[1] === undefined) continue;
    if (n++ === ordinal) return { start: m.index, end: m.index + m[0].length, name: m[1] };
  }
  return null;
}

/** 1-based line and column of an offset, for jumping to the code. */
export function lineOf(text: string, offset: number) {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

/**
 * The phone's parser shrugs off mistakes a strict XML parser refuses: an attribute
 * written twice (the first one counts), a bare `&` or `<` inside a value, and two
 * attributes with no space between them (`align="left"alpha="1"`).
 * Repairs only those, inside start tags, so element order (and every ordinal) is unchanged.
 */
export function lenientXml(text: string): string {
  TOKEN.lastIndex = 0;
  return text.replace(TOKEN, (whole, name: string | undefined, attrs: string | undefined) => {
    if (name === undefined || !attrs) return whole;
    // A repeated attribute: the phone keeps the last value (seen on a real device), at the first one's place.
    const ATTR = /(\s*)([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;
    const last = new Map<string, string>();
    for (const m of attrs.matchAll(ATTR)) last.set(m[2], m[3]);
    const seen = new Set<string>();
    const fixed = attrs.replace(ATTR, (_m, space: string, key: string) => {
      if (seen.has(key)) return '';
      seen.add(key);
      const value = last.get(key)!;
      const q = value[0];
      const inner = value.slice(1, -1).replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;');
      return `${space || ' '}${key}=${q}${inner}${q}`;
    });
    return `<${name}${fixed}>`;
  });
}

const escapeAttr =(v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Set (string) or remove (null) attributes on one element's start tag. */
export function setAttributes(text: string, ordinal: number, attrs: Record<string, string | null>): string {
  const tag = findStartTag(text, ordinal);
  if (!tag) return text;
  let body = text.slice(tag.start, tag.end);
  for (const [name, value] of Object.entries(attrs)) {
    const re = new RegExp(`(\\s)${escapeRe(name)}\\s*=\\s*("[^"]*"|'[^']*')`);
    if (value === null) {
      body = body.replace(new RegExp(`\\s+${escapeRe(name)}\\s*=\\s*("[^"]*"|'[^']*')`), '');
    } else if (re.test(body)) {
      body = body.replace(re, (_m, space: string) => `${space}${name}="${escapeAttr(value)}"`);
    } else {
      const close = body.endsWith('/>') ? body.length - 2 : body.length - 1;
      const head = body.slice(0, close).replace(/\s+$/, '');
      body = `${head} ${name}="${escapeAttr(value)}"${body.endsWith('/>') ? ' />' : '>'}`;
    }
  }
  return text.slice(0, tag.start) + body + text.slice(tag.end);
}

/** Where the element with this document-order index sits, from its start tag through its end tag. */
export function elementRange(text: string, ordinal: number): { start: number; end: number } | null {
  const tag = findStartTag(text, ordinal);
  if (!tag) return null;
  if (/\/\s*>$/.test(text.slice(tag.start, tag.end))) return { start: tag.start, end: tag.end };
  TOKEN.lastIndex = tag.end;
  let depth = 1;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (m[1] !== undefined) {
      if (!/\/\s*>$/.test(m[0])) depth++;
    } else if (m[0].startsWith('</') && --depth === 0) return { start: tag.start, end: m.index + m[0].length };
  }
  return null;
}

/**
 * Remove elements (by document-order index) with everything inside them. A piece
 * inside another removed one goes with its parent; the line each one sat on is
 * removed too when nothing else is on it.
 */
export function removeElements(text: string, ordinals: number[]): string {
  const ranges = [...new Set(ordinals)]
    .map((o) => elementRange(text, o))
    .filter((r): r is { start: number; end: number } => !!r)
    .sort((a, b) => a.start - b.start)
    .filter((r, i, all) => !all.slice(0, i).some((p) => p.start <= r.start && r.end <= p.end));
  let out = text;
  for (const r of ranges.reverse()) {
    let { start, end } = r;
    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const nl = out.indexOf('\n', end);
    const lineEnd = nl === -1 ? out.length : nl + 1;
    if (!out.slice(lineStart, start).trim() && !out.slice(end, lineEnd).trim()) {
      start = lineStart;
      end = lineEnd;
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** How many start tags begin before this offset: the ordinal of an element starting there. */
function ordinalAt(text: string, offset: number) {
  TOKEN.lastIndex = 0;
  let n = 0;
  for (let m = TOKEN.exec(text); m && m.index < offset; m = TOKEN.exec(text)) if (m[1] !== undefined) n++;
  return n;
}

/** An element's range widened to its whole line(s) when nothing else is on them. */
function lineRange(text: string, r: { start: number; end: number }) {
  const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
  const nl = text.indexOf('\n', r.end);
  const lineEnd = nl === -1 ? text.length : nl + 1;
  const own = !text.slice(lineStart, r.start).trim() && !text.slice(r.end, lineEnd).trim();
  return own ? { start: lineStart, end: lineEnd, own } : { ...r, own };
}

/** The indent step a file uses (a tab, or its smallest run of leading spaces, at least 2). */
function indentUnit(text: string) {
  if (/^\t/m.test(text)) return '\t';
  let best = 0;
  for (const m of text.matchAll(/^( +)</gm)) if (!best || m[1].length < best) best = m[1].length;
  return ' '.repeat(Math.max(2, Math.min(best || 2, 4)));
}

/**
 * Wrap elements (by document-order index, all with the same parent) in a new
 * `<Group>` placed where the first of them was, keeping their order. Pieces inside
 * another wrapped one go with it. Returns the new text and the group's ordinal.
 */
export function groupElements(text: string, ordinals: number[], attrs: Record<string, string>): { text: string; ord: number } | null {
  const ranges = [...new Set(ordinals)]
    .map((o) => elementRange(text, o))
    .filter((r): r is { start: number; end: number } => !!r)
    .sort((a, b) => a.start - b.start)
    .filter((r, i, all) => !all.slice(0, i).some((p) => p.start <= r.start && r.end <= p.end));
  if (!ranges.length) return null;
  const unit = indentUnit(text);
  const first = lineRange(text, ranges[0]);
  const base = first.own ? (/^[ \t]*/.exec(text.slice(first.start))?.[0] ?? '') : '';
  const pieces = ranges.map((r) => {
    const body = text.slice(r.start, r.end);
    const lead = text.slice(text.lastIndexOf('\n', r.start - 1) + 1, r.start);
    const own = !lead.trim() ? lead : base;
    // Re-indent one step deeper than the group, keeping each piece's own inner indentation.
    return body
      .split('\n')
      .map((line, i) => (i === 0 ? `${base}${unit}${line}` : line.startsWith(own) ? `${base}${unit}${line.slice(own.length)}` : `${base}${unit}${line.trimStart()}`))
      .join('\n');
  });
  const open = `<Group${Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}>`;
  const block = first.own ? `${base}${open}\n${pieces.join('\n')}\n${base}</Group>\n` : `${open}${pieces.map((p) => p.trim()).join('')}</Group>`;
  let out = text;
  for (const r of [...ranges].reverse()) {
    const w = lineRange(out, r);
    out = out.slice(0, w.start) + out.slice(w.end);
  }
  const at = first.start;
  out = out.slice(0, at) + block + out.slice(at);
  return { text: out, ord: ordinalAt(out, at + block.indexOf('<Group')) };
}

/** Take a group's contents out of it, in its place, dropping the group itself. */
export function ungroupElement(text: string, ordinal: number): string {
  const tag = findStartTag(text, ordinal);
  const r = elementRange(text, ordinal);
  if (!tag || !r) return text;
  if (r.end === tag.end) return removeElements(text, [ordinal]);
  const closeAt = text.lastIndexOf('</', r.end);
  const inner = text.slice(tag.end, closeAt);
  const unit = indentUnit(text);
  const w = lineRange(text, r);
  let body: string;
  if (w.own) {
    const lines = inner.split('\n');
    // Drop the empty remainders of the group's own start and end lines.
    if (!lines[0].trim()) lines.shift();
    if (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    body = lines.map((l) => (l.startsWith(unit) ? l.slice(unit.length) : l)).join('\n');
    body = body ? `${body}\n` : '';
  } else body = inner;
  return text.slice(0, w.start) + body + text.slice(w.end);
}
