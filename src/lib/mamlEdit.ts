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
