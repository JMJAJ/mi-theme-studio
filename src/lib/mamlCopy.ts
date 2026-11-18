// Copying lock screen pieces between themes (and into the inventory) with the
// code behind them: the variables they read (<Var>), the data sources that fill
// those (<ContentProviderBinder> and friends), the theme's settings they use
// (config.xml, turned into fixed variables) and every picture they draw,
// including digit sets (time_0.png…) and pictures picked by a formula.
// Pasting renames whatever would clash with the target theme.

import { evalNumber, type Vars } from './maml';
import { elementRange, setAttributes } from './mamlEdit';
import { addBinders, insertInto } from './mamlBlocks';

export interface Snippet {
  name: string;
  /** The copied pieces, as written in the source (dedented). */
  elements: string[];
  /** Variable definitions they need, in source order. */
  defs: string[];
  /** Data sources (children of <VariableBinders>) they need. */
  binders: string[];
  /** Pictures and fonts, relative to the manifest's folder. */
  files: string[];
  /** Where the pieces' parent sits on the source screen. */
  offset: { x: number; y: number };
  /** What they cover on the source screen (for thumbnails). */
  box: { x: number; y: number; w: number; h: number } | null;
  /** The source layout's width (1080 for nearly every theme). */
  width: number;
  /** The theme it came from. */
  source?: string;
}

const NAME_ATTRS = /\b(name|countName)\s*=\s*"([^"]+)"/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const IMAGE_EXT = /\.(png|webp|jpe?g|gif|9\.png|mp4|ttf|otf)$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeXml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const norm = (xml: string) => xml.replace(/\s+/g, ' ').replace(/\s*(\/?>)/g, '$1').replace(/>\s+</g, '><').trim();

/** Attributes holding one file path, a %d pattern, or a formula with quoted path parts. */
type PathKind = 'literal' | 'format' | 'expr' | null;
function pathKind(attr: string): PathKind {
  const a = attr.toLowerCase();
  if (a === 'srcid' || a === 'srcparas' || a.endsWith('paras')) return null;
  if (/src.*exp$|srcexp|exp$/.test(a) && a.includes('src')) return 'expr';
  if (a.includes('src') && a.includes('format')) return 'format';
  if (a === 'src' || a.endsWith('src') || a === 'fontpath' || a === 'mask') return 'literal';
  return null;
}

/** Strip the source indentation of every line after the first. */
function dedent(xml: string, text: string, start: number) {
  const indent = /[ \t]*$/.exec(text.slice(text.lastIndexOf('\n', start - 1) + 1, start))?.[0] ?? '';
  if (!indent) return xml;
  return xml
    .split('\n')
    .map((l, i) => (i && l.startsWith(indent) ? l.slice(indent.length) : l))
    .join('\n');
}

/** Names a piece of code reads: #var, @var, and the targets of its commands. */
export function references(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/[#@]([A-Za-z_]\w*)/g)) out.add(m[1]);
  for (const m of xml.matchAll(/<(?:VariableCommand|VarCommand)\b[^>]*\bname\s*=\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of xml.matchAll(/\b(?:target|dependency)\s*=\s*"([A-Za-z_]\w*)/g)) out.add(m[1]);
  return out;
}

/** Names a piece of code defines (its elements, variables and data sources). */
export function definedNames(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(NAME_ATTRS)) out.add(m[2]);
  return out;
}

/** The files (relative paths) a piece of code draws, out of the theme's files. */
export function referencedFiles(xml: string, files: string[]): string[] {
  const lower = files.map((f) => f.toLowerCase());
  const hit = new Set<number>();
  const exact = (p: string) => {
    const clean = p.replace(/^\/+/, '').toLowerCase();
    if (!clean) return;
    const m = /^(.*?)(\.9\.png|\.[a-z0-9]+)$/i.exec(clean);
    // The picture, and its numbered / suffixed set (time_0.png…, time_dot.png, srcid variants).
    const set = m ? new RegExp(`^${escapeRe(m[1])}(_[^/]*)?${escapeRe(m[2])}$`) : null;
    lower.forEach((f, i) => (f === clean || set?.test(f)) && hit.add(i));
  };
  const prefixed = (prefix: string, suffix = '') => {
    const p = prefix.replace(/^\/+/, '').toLowerCase();
    const s = suffix.toLowerCase();
    if (!p && !s) return;
    lower.forEach((f, i) => f.startsWith(p) && f.endsWith(s) && hit.add(i));
  };
  for (const m of xml.matchAll(ATTR)) {
    const kind = pathKind(m[1]);
    const value = m[2];
    if (!kind || !value) continue;
    if (kind === 'literal') exact(value);
    else if (kind === 'format') {
      const parts = value.split(/%[-0-9.]*[dsf]/);
      if (parts.length > 1) prefixed(parts[0], parts[parts.length - 1]);
      else exact(value);
    } else
      for (const lit of value.matchAll(/'([^']*)'/g)) {
        const l = lit[1];
        if (IMAGE_EXT.test(l) && !l.startsWith('.')) exact(l);
        else if (l.length >= 2 && !l.startsWith('.')) prefixed(l);
      }
  }
  return [...hit].map((i) => files[i]);
}

/** Where an element's own origin sits on the screen (its and its groups' x / y). */
export function absOffset(el: Element | null, vars: Vars): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let e = el; e && e.parentElement; e = e.parentElement) {
    x += evalNumber(e.getAttribute('x'), vars);
    y += evalNumber(e.getAttribute('y'), vars);
  }
  return { x, y };
}

export interface ExtractOptions {
  /** Theme files relative to the manifest folder. */
  files: string[];
  vars: Vars;
  /** The theme's settings (config.xml defaults). */
  config?: [string, string | number][];
  /** The variable that switches pages, so a piece copied off one page shows anywhere. */
  pageVar?: string | null;
  box?: Snippet['box'];
  name?: string;
  source?: string;
}

/** Take pieces (by document-order index) out of a layout with everything they need. */
export function extractSnippet(text: string, elements: Element[], ords: number[], opts: ExtractOptions): Snippet | null {
  const ordOf = new Map(elements.map((e, i) => [e, i]));
  const root = elements[0];
  if (!root) return null;
  const inside = (e: Element, set: Element[]) => {
    for (let p = e.parentElement; p; p = p.parentElement) if (set.includes(p)) return true;
    return false;
  };
  const picked = [...new Set(ords)]
    .sort((a, b) => a - b)
    .map((o) => elements[o])
    .filter((e): e is Element => !!e && e !== root);
  const tops = picked.filter((e) => !inside(e, picked));
  if (!tops.length) return null;
  const within = (e: Element) => tops.includes(e) || inside(e, tops);

  const outer = (e: Element) => {
    const r = elementRange(text, ordOf.get(e)!);
    return r ? dedent(text.slice(r.start, r.end), text, r.start) : null;
  };

  // The pieces, placed relative to the first one's parent.
  const offset = absOffset(tops[0].parentElement, opts.vars);
  const pageRef = opts.pageVar ? new RegExp(`[#@]${escapeRe(opts.pageVar)}(?!\\w)`) : null;
  const pieces: string[] = [];
  for (const e of tops) {
    let xml = outer(e);
    if (!xml) continue;
    // Shown only on one page of the source: show it wherever it is pasted.
    if (pageRef && pageRef.test(e.getAttribute('visibility') ?? '')) xml = setAttributes(xml, 0, { visibility: null });
    const own = absOffset(e.parentElement, opts.vars);
    const dx = Math.round(own.x - offset.x);
    const dy = Math.round(own.y - offset.y);
    pieces.push(dx || dy ? `<Group x="${dx}" y="${dy}">\n${indentAll(xml, '    ')}\n</Group>` : xml);
  }
  if (!pieces.length) return null;

  // Where everything outside the pieces is defined.
  const varDef = new Map<string, Element>();
  for (const v of Array.from(root.getElementsByTagName('Var'))) {
    const name = v.getAttribute('name');
    if (!name || within(v)) continue;
    const arr = v.closest('VarArray');
    if (!varDef.has(name)) varDef.set(name, arr ?? v);
  }
  const binderDef = new Map<string, Element>();
  for (const binders of Array.from(root.getElementsByTagName('VariableBinders')))
    for (const b of Array.from(binders.children)) {
      for (const n of [b.getAttribute('name'), b.getAttribute('countName')]) if (n) binderDef.set(n, b);
      for (const v of Array.from(b.getElementsByTagName('Variable'))) {
        const n = v.getAttribute('name');
        if (n) binderDef.set(n, b);
      }
    }
  const config = new Map(opts.config ?? []);

  const internal = definedNames(pieces.join('\n'));
  const defs = new Set<Element>();
  const binders = new Set<Element>();
  const synthetic: string[] = [];
  const seen = new Set<string>();
  const queue = [...references(pieces.join('\n'))];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || internal.has(name)) continue;
    seen.add(name);
    const v = varDef.get(name);
    const b = binderDef.get(name);
    let more: string | null = null;
    if (v && !defs.has(v)) {
      defs.add(v);
      more = outer(v);
    } else if (b && !binders.has(b)) {
      binders.add(b);
      more = outer(b);
    } else if (!v && !b && config.has(name)) {
      const value = config.get(name)!;
      synthetic.push(
        typeof value === 'number'
          ? `<Var name="${name}" expression="${value}" const="true"/>`
          : `<Var name="${name}" type="string" expression="'${escapeXml(String(value).replace(/'/g, '’'))}'" const="true"/>`,
      );
    }
    if (more) queue.push(...references(more));
  }
  const byOrder = (set: Set<Element>) => [...set].sort((a, b) => ordOf.get(a)! - ordOf.get(b)!).map(outer).filter((x): x is string => !!x);
  const defXml = [...synthetic, ...byOrder(defs)];
  const binderXml = byOrder(binders);
  const files = referencedFiles([...pieces, ...defXml, ...binderXml].join('\n'), opts.files);

  const first = tops[0];
  const name = opts.name ?? first.getAttribute('name') ?? first.tagName;
  return {
    name,
    elements: pieces,
    defs: defXml,
    binders: binderXml,
    files,
    offset,
    box: opts.box ?? null,
    width: Number(root.getAttribute('screenWidth')) || 1080,
    source: opts.source,
  };
}

const indentAll = (xml: string, pad: string) =>
  xml
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');

/** Rename names (variables, elements, data sources) everywhere in a piece of code. */
export function renameAll(xml: string, map: Map<string, string>): string {
  if (!map.size) return xml;
  const names = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  return xml
    .replace(new RegExp(`([#@])(${names})(?!\\w)`, 'g'), (_m, sigil: string, n: string) => sigil + map.get(n))
    .replace(new RegExp(`\\b(name|countName|target|dependency)(\\s*=\\s*")(${names})(?=["."])`, 'g'), (_m, a: string, eq: string, n: string) => a + eq + map.get(n));
}

/** Put copied pictures in another folder: rewrite the paths that point at them. */
export function prefixPaths(xml: string, prefix: string, files: string[]): string {
  const lower = files.map((f) => f.toLowerCase());
  return xml.replace(ATTR, (whole, attr: string, value: string) => {
    const kind = pathKind(attr);
    if (!kind || !value) return whole;
    if (kind === 'literal' || kind === 'format') return `${attr}="${prefix}${value.replace(/^\/+/, '')}"`;
    const next = value.replace(/'([^']*)'/g, (lit, l: string) => {
      const clean = l.replace(/^\/+/, '').toLowerCase();
      return clean && !l.startsWith('.') && lower.some((f) => f.startsWith(clean)) ? `'${prefix}${l.replace(/^\/+/, '')}'` : lit;
    });
    return `${attr}="${next}"`;
  });
}

export interface PasteOptions {
  /** Document-order index of the group to paste into (0: the root). */
  target: number;
  /** Where that group's origin sits on the screen. */
  targetOffset: { x: number; y: number };
  /** The target theme's files (relative to its manifest folder) with their sizes. */
  targetFiles: Map<string, number>;
  /** The snippet's files with their sizes. */
  sourceSizes: Map<string, number>;
  /** Extra condition to show the pasted piece only on one page. */
  visibility?: string | null;
  /** Settings the target theme has itself (config.xml): those stay adjustable instead of fixed copies. */
  targetConfig?: Set<string>;
}

export interface PasteResult {
  text: string;
  ord: number;
  /** Files to copy: from the snippet's path to the target's. */
  writes: { from: string; to: string }[];
  renamed: number;
}

/** Paste a snippet into a layout. Returns the new text, what to select, and the files to copy. */
export function pasteSnippet(text: string, snip: Snippet, opts: PasteOptions): PasteResult | null {
  const targetNames = definedNames(text);
  const targetDefs = new Map<string, string>();
  for (const m of text.matchAll(/<Var\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/Var>)/g)) targetDefs.set(m[1], norm(m[0]));
  const targetBinders = new Set<string>();
  for (const m of text.matchAll(/<(\w*Binder)\b(?:[^>"]|"[^"]*")*?(?:\/>|>[\s\S]*?<\/\1>)/g)) targetBinders.add(norm(m[0]));

  // The same definition is already there: use it. Otherwise rename what clashes.
  const defs = snip.defs.filter((d) => {
    const name = /\bname\s*=\s*"([^"]+)"/.exec(d)?.[1];
    if (name && opts.targetConfig?.has(name) && /\bconst\s*=\s*"true"/.test(d)) return false;
    return !(name && targetDefs.get(name) === norm(d));
  });
  const binders = snip.binders.filter((b) => !targetBinders.has(norm(b)));
  const kept = new Set([...definedNames(defs.join('\n')), ...definedNames(binders.join('\n')), ...definedNames(snip.elements.join('\n'))]);
  const reused = new Set([...definedNames(snip.defs.join('\n')), ...definedNames(snip.binders.join('\n'))].filter((n) => !kept.has(n)));
  const map = new Map<string, string>();
  const taken = new Set([...targetNames, ...kept]);
  for (const n of kept) {
    if (!targetNames.has(n) || reused.has(n)) continue;
    let k = 2;
    while (taken.has(`${n}_${k}`)) k++;
    map.set(n, `${n}_${k}`);
    taken.add(`${n}_${k}`);
  }

  // Pictures: the same file already there is shared; any clash moves this snippet's pictures to their own folder.
  const lowerTarget = new Map([...opts.targetFiles].map(([p, s]) => [p.toLowerCase(), s]));
  const clash = snip.files.some((f) => {
    const there = lowerTarget.get(f.toLowerCase());
    return there !== undefined && there !== opts.sourceSizes.get(f);
  });
  let prefix = '';
  if (clash) {
    let k = 1;
    while ([...lowerTarget.keys()].some((p) => p.startsWith(`copied_${k}/`))) k++;
    prefix = `copied_${k}/`;
  }
  const writes = snip.files.filter((f) => prefix || !lowerTarget.has(f.toLowerCase())).map((f) => ({ from: f, to: prefix + f }));
  const fix = (xml: string) => (prefix ? prefixPaths(renameAll(xml, map), prefix, snip.files) : renameAll(xml, map));

  const pieces = snip.elements.map(fix);
  const body = defs.map(fix);
  const dx = Math.round(snip.offset.x - opts.targetOffset.x);
  const dy = Math.round(snip.offset.y - opts.targetOffset.y);
  let xml: string;
  const single = pieces.length === 1 && !body.length;
  const numeric = (v: string | undefined) => v !== undefined && /^-?\d+(\.\d+)?$/.test(v.trim());
  const head = single ? /^<[^>]*>/.exec(pieces[0])?.[0] ?? '' : '';
  const x0 = /\bx\s*=\s*"([^"]*)"/.exec(head)?.[1];
  const y0 = /\by\s*=\s*"([^"]*)"/.exec(head)?.[1];
  if (single && (!dx || x0 === undefined || numeric(x0)) && (!dy || y0 === undefined || numeric(y0))) {
    // One piece at plain coordinates: move it, no extra group.
    const attrs: Record<string, string | null> = {};
    if (dx) attrs.x = String(Math.round(Number(x0 ?? 0) + dx));
    if (dy) attrs.y = String(Math.round(Number(y0 ?? 0) + dy));
    if (opts.visibility) {
      const own = /\bvisibility\s*=\s*"([^"]*)"/.exec(head)?.[1];
      attrs.visibility = own ? `(${own})*${opts.visibility}` : opts.visibility;
    }
    xml = Object.keys(attrs).length ? setAttributes(pieces[0], 0, attrs) : pieces[0];
  } else {
    const slug = snip.name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'copied';
    let k = 1;
    while (taken.has(`${slug}_${k}`)) k++;
    const vis = opts.visibility ? ` visibility="${escapeXml(opts.visibility)}"` : '';
    xml = `<Group name="${slug}_${k}" x="${dx}" y="${dy}"${vis}>\n${[...body, ...pieces].map((p) => indentAll(p, '    ')).join('\n')}\n</Group>`;
  }

  const placed = insertInto(text, opts.target, xml);
  if (!placed) return null;
  let out = placed.text;
  let at = placed.start;
  if (binders.length) {
    const added = addBinders(out, binders.map(fix));
    if (!added) return null;
    if (added.at <= at) at += added.text.length - out.length;
    out = added.text;
  }
  return { text: out, ord: ordinalAt(out, at), writes, renamed: map.size };
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/[^>]*>|<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
/** Document-order index of the element whose start tag begins at this offset. */
export function ordinalAt(text: string, offset: number) {
  TOKEN.lastIndex = 0;
  let n = 0;
  for (let m = TOKEN.exec(text); m && m.index < offset; m = TOKEN.exec(text)) if (m[1] !== undefined) n++;
  return n;
}
