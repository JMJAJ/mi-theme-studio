// Guide: the lock screen & widget guide (docs/maml/*.md) inside the app, with
// its pictures, a search, copyable code, and a Try it page that works out any
// formula or date pattern live with the editor's own evaluator.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FlaskConical, LayoutGrid, Search, X } from 'lucide-react';
import { CopyButton, Formula, XmlCode } from './GuideCode';
import { RecipeGallery } from './GuideRecipes';
import { TryPlayground } from './TryPlayground';
import { parseInline, parseMarkdown, plainText, type Block, type Inline } from '../../lib/markdown';
import { openGuide, rememberGuidePage, tryFormula, useGuide } from '../../state/guide';
import starterManifest from '../../../docs/maml/examples/starter/manifest.xml?raw';

const SOURCES = import.meta.glob('../../../docs/maml/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const IMAGES = import.meta.glob('../../../docs/maml/img/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const ORDER = ['README', 'editor', 'text-and-dates', 'expressions', 'variables', 'layout', 'recipes', 'troubleshooting'];
const SHORT: Record<string, string> = { README: 'Overview', try: 'Try it', starter: 'Starter layout' };

interface Page {
  id: string;
  title: string;
  blocks: Block[];
  text: string;
}

const PAGES: Page[] = (() => {
  const byName = new Map(Object.entries(SOURCES).map(([path, src]) => [path.replace(/^.*\/(.+)\.md$/, '$1'), src]));
  const names = [...ORDER.filter((n) => byName.has(n)), ...[...byName.keys()].filter((n) => !ORDER.includes(n)).sort()];
  const pages = names.map((id) => {
    // The "← Guide" back links are for GitHub; the app has its own page list.
    const src = byName.get(id)!.replace(/^\[← Guide\]\(README\.md\)\s*$/m, '');
    const blocks = parseMarkdown(src);
    const h1 = blocks.find((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.level === 1);
    return { id, title: SHORT[id] ?? h1?.text ?? id, blocks, text: plainText(src) };
  });
  const starter = `# Starter layout\n\nA complete lock screen that uses the clock, \`d/M EE\` date, weather line, greeting and battery bar from this guide. Copy it into a lock screen's \`manifest.xml\` (Files tab) to start from it.\n\n\`\`\`xml\n${starterManifest.trimEnd()}\n\`\`\`\n`;
  pages.push({ id: 'starter', title: SHORT.starter, blocks: parseMarkdown(starter), text: plainText(starter) });
  return pages;
})();

const pageById = new Map(PAGES.map((p) => [p.id, p]));

// ---------- links, inline text and code ----------

/** Where a link in the guide goes. */
function follow(href: string, from: string) {
  if (href.startsWith('#')) return openGuide(from, href.slice(1));
  const m = /^(?:\.\/)?([\w-]+)\.md(?:#(.*))?$/.exec(href);
  if (m && pageById.has(m[1])) return openGuide(m[1], m[2] ?? null);
  if (/examples\/starter\/manifest\.xml$/.test(href)) return openGuide('starter');
}

const resolvable = (href: string) => href.startsWith('#') || /^(?:\.\/)?([\w-]+)\.md(#.*)?$/.test(href) || /examples\/starter\/manifest\.xml$/.test(href);
const imageUrl = (src: string) => IMAGES[`../../../docs/maml/${src.replace(/^\.\//, '')}`];
/** Inline code worth sending to Try it: a formula that reads variables. */
const looksLikeFormula = (code: string) => /[#@][a-z_]/i.test(code) && !/^</.test(code) && !/="/.test(code) && !/^#[0-9a-f]{6,8}$/i.test(code);

function Inlines({ nodes, page }: { nodes: Inline[]; page: string }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.v}</Fragment>;
          case 'code':
            return looksLikeFormula(n.v) ? (
              <code key={i} className="gd-try" title="Try this formula" role="button" tabIndex={0} onClick={() => tryFormula(n.v)} onKeyDown={(e) => e.key === 'Enter' && tryFormula(n.v)}>
                <Formula code={n.v} />
              </code>
            ) : (
              <code key={i}>{n.v}</code>
            );
          case 'b':
            return (
              <strong key={i}>
                <Inlines nodes={n.v} page={page} />
              </strong>
            );
          case 'i':
            return (
              <em key={i}>
                <Inlines nodes={n.v} page={page} />
              </em>
            );
          case 'a':
            return resolvable(n.href) ? (
              <a
                key={i}
                href={n.href}
                onClick={(e) => {
                  e.preventDefault();
                  follow(n.href, page);
                }}
              >
                <Inlines nodes={n.v} page={page} />
              </a>
            ) : (
              <span key={i} className="gd-ext" title={n.href}>
                <Inlines nodes={n.v} page={page} />
              </span>
            );
          case 'img': {
            const url = imageUrl(n.src);
            return url ? <img key={i} src={url} alt={n.alt} /> : null;
          }
        }
      })}
    </>
  );
}

const Text = ({ src, page }: { src: string; page: string }) => <Inlines nodes={parseInline(src)} page={page} />;

function Blocks({ page }: { page: Page }) {
  return (
    <>
      {page.blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = `h${Math.min(b.level, 4)}` as 'h1';
            return (
              <Tag key={i} id={`g-${b.id}`}>
                <Text src={b.text} page={page.id} />
              </Tag>
            );
          }
          case 'p':
            return (
              <p key={i}>
                <Text src={b.text} page={page.id} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Text src={item} page={page.id} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return (
              <div key={i} className="gd-code">
                <CopyButton text={b.text} />
                <pre className="selectable">{b.lang === 'xml' || b.text.trimStart().startsWith('<') ? <XmlCode code={b.text} /> : <Formula code={b.text} />}</pre>
              </div>
            );
          case 'table':
            return (
              <div key={i} className="gd-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>
                          <Text src={h} page={page.id} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((c, k) => (
                          <td key={k}>
                            <Text src={c} page={page.id} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'img': {
            const url = imageUrl(b.src);
            return url ? (
              <figure key={i} className="gd-figure">
                <img src={url} alt={b.alt} />
                {b.alt && <figcaption>{b.alt}</figcaption>}
              </figure>
            ) : null;
          }
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </>
  );
}

// ---------- the view ----------

interface Hit {
  page: Page;
  heading: string;
  id: string | null;
}

function search(query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  for (const page of PAGES) {
    let heading = page.title;
    let id: string | null = null;
    let buffer = '';
    const flush = () => {
      if (buffer.toLowerCase().includes(q) || heading.toLowerCase().includes(q)) hits.push({ page, heading, id });
    };
    for (const b of page.blocks) {
      if (b.t === 'h' && b.level <= 3) {
        flush();
        heading = plainText(b.text);
        id = b.level === 1 ? null : b.id;
        buffer = '';
      } else buffer += ` ${JSON.stringify(b)}`;
    }
    flush();
  }
  return hits.slice(0, 60);
}

let lastReference = 'README';

/** The written pages, with their page list and search (and Try it). */
function Reference() {
  const { page: pageId, anchor, nonce } = useGuide();
  const [query, setQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const page = pageById.get(pageId) ?? pageById.get('README');
  const hits = useMemo(() => search(query), [query]);
  const headings = page ? page.blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.level === 2) : [];

  useEffect(() => {
    rememberGuidePage(pageId);
    if (pageById.has(pageId)) lastReference = pageId;
    const el = body.current;
    if (!el) return;
    const target = anchor ? el.querySelector<HTMLElement>(`#g-${CSS.escape(anchor)}`) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else el.scrollTop = 0;
  }, [pageId, anchor, nonce]);

  return (
    <div className="guide">
      <nav className="guide-nav" aria-label="Guide pages">
        <div className="guide-search">
          <Search />
          <input className="input" placeholder="Search the guide" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the guide" />
          {query && (
            <button className="tb-icon" aria-label="Clear search" onClick={() => setQuery('')}>
              <X />
            </button>
          )}
        </div>
        {query ? (
          <div className="guide-list">
            {hits.length === 0 && <p className="muted guide-none">Nothing found.</p>}
            {hits.map((h, i) => (
              <button key={i} className="guide-item guide-hit" onClick={() => openGuide(h.page.id, h.id)}>
                <span className="ellipsis">{h.heading}</span>
                <span className="faint ellipsis">{h.page.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="guide-list">
            {PAGES.filter((p) => p.id !== 'starter').map((p) => (
              <Fragment key={p.id}>
                <button className={`guide-item ${p.id === pageId ? 'is-active' : ''}`} aria-current={p.id === pageId ? 'page' : undefined} onClick={() => openGuide(p.id)}>
                  {p.id === 'README' ? <BookOpen /> : <span className="guide-dot" />}
                  <span className="ellipsis">{p.title}</span>
                </button>
                {p.id === pageId &&
                  headings.map((h) => (
                    <button key={h.id} className={`guide-item guide-sub ${anchor === h.id ? 'is-on' : ''}`} onClick={() => openGuide(p.id, h.id)}>
                      <span className="ellipsis">{plainText(h.text)}</span>
                    </button>
                  ))}
              </Fragment>
            ))}
            <div className="guide-sep" />
            <button className={`guide-item ${pageId === 'starter' ? 'is-active' : ''}`} onClick={() => openGuide('starter')}>
              <span className="guide-dot" />
              <span>Starter layout</span>
            </button>
          </div>
        )}
      </nav>
      <div className="guide-body" ref={body}>
        <article className="guide-doc">{page ? <Blocks page={page} /> : null}</article>
      </div>
    </div>
  );
}

export function GuideView() {
  const pageId = useGuide((s) => s.page);
  const mode = pageId === 'recipes' ? 'recipes' : pageId === 'try' ? 'try' : 'reference';
  useEffect(() => rememberGuidePage(pageId), [pageId]);
  return (
    <div className="guide-shell">
      <div className="guide-modes">
        <div className="segmented" role="tablist" aria-label="Guide">
          <button role="tab" aria-pressed={mode === 'recipes'} onClick={() => openGuide('recipes')}>
            <LayoutGrid /> Widgets
          </button>
          <button role="tab" aria-pressed={mode === 'reference'} onClick={() => openGuide(lastReference)}>
            <BookOpen /> Reference
          </button>
          <button role="tab" aria-pressed={mode === 'try'} onClick={() => openGuide('try')}>
            <FlaskConical /> Try it
          </button>
        </div>
        <span className="muted guide-modes-hint">
          {mode === 'recipes' ? 'Ready-made widgets you adjust and add.' : mode === 'try' ? 'One thing per line: formulas, dates, conditions, names, elements. Results on the right.' : 'How lock screens work: formulas, dates, variables, layout.'}
        </span>
      </div>
      {mode === 'recipes' ? <RecipeGallery /> : mode === 'try' ? <TryPlayground /> : <Reference />}
    </div>
  );
}
