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
 * written twice (the first one counts) and a bare `&` or `<` inside a value.
 * Repairs only those, inside start tags, so element order (and every ordinal) is unchanged.
 */
export function lenientXml(text: string): string {
  TOKEN.lastIndex = 0;
  return text.replace(TOKEN, (whole, name: string | undefined, attrs: string | undefined) => {
    if (name === undefined || !attrs) return whole;
    const seen = new Set<string>();
    const fixed = attrs.replace(/(\s*)([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g, (_m, space: string, key: string, value: string) => {
      if (seen.has(key)) return '';
      seen.add(key);
      const q = value[0];
      const inner = value.slice(1, -1).replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;');
      return `${space}${key}=${q}${inner}${q}`;
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
