// A small Markdown reader for the in-app guide (docs/maml/*.md). It covers what
// those pages use: headings, paragraphs, lists, fenced code, tables, images,
// rules, and inline code / bold / italic / links. Not a general Markdown parser.

export type Block =
  | { t: 'h'; level: number; text: string; id: string }
  | { t: 'p'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'img'; alt: string; src: string }
  | { t: 'hr' };

export type Inline = { t: 'text'; v: string } | { t: 'code'; v: string } | { t: 'b'; v: Inline[] } | { t: 'i'; v: Inline[] } | { t: 'a'; href: string; v: Inline[] } | { t: 'img'; alt: string; src: string };

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const unescape = (s: string) => s.replace(/&#124;/g, '|').replace(/&#160;/g, ' ');

/** Table cells: split on | outside backticks. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  let code = false;
  for (const c of body) {
    if (c === '`') code = !code;
    if (c === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out.map(unescape);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  const used = new Map<string, number>();
  let i = 0;
  const isTable = (l: string | undefined) => !!l && /^\s*\|/.test(l);
  const startsBlock = (l: string) => /^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\||!\[[^\]]*\]\([^)]*\)\s*$|---+\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = h[2].trim();
      let id = slug(text);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      out.push({ t: 'h', level: h[1].length, text, id });
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)]*)\)\s*$/.exec(line);
    if (img) {
      out.push({ t: 'img', alt: img[1], src: img[2] });
      i++;
      continue;
    }
    if (isTable(line)) {
      const head = cells(line);
      i++;
      if (i < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i])) i++;
      const rows: string[][] = [];
      while (isTable(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[2]);
        else if (startsBlock(lines[i])) break;
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      out.push({ t: ordered ? 'ol' : 'ul', items: items.map(unescape) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim());
    out.push({ t: 'p', text: unescape(para.join(' ')) });
  }
  return out;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === '`' && (m = /^`([^`]*)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1] });
      i += m[0].length;
    } else if (rest.startsWith('![') && (m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(rest))) {
      flush();
      out.push({ t: 'img', alt: m[1], src: m[2] });
      i += m[0].length;
    } else if (rest[0] === '[' && (m = /^\[((?:[^\]`]|`[^`]*`)*)\]\(([^)]*)\)/.exec(rest))) {
      flush();
      out.push({ t: 'a', href: m[2], v: parseInline(m[1]) });
      i += m[0].length;
    } else if (rest.startsWith('**') && (m = /^\*\*((?:[^*`]|`[^`]*`|\*(?!\*))+)\*\*/.exec(rest))) {
      flush();
      out.push({ t: 'b', v: parseInline(m[1]) });
      i += m[0].length;
    } else if (rest[0] === '*' && (m = /^\*([^*\s](?:[^*`]|`[^`]*`)*?)\*/.exec(rest))) {
      flush();
      out.push({ t: 'i', v: parseInline(m[1]) });
      i += m[0].length;
    } else {
      text += src[i++];
    }
  }
  flush();
  return out;
}

/** Plain text of some Markdown, for search. */
export function plainText(src: string): string {
  return src.replace(/[`*]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}
