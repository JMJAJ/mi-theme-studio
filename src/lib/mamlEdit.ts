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

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
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
