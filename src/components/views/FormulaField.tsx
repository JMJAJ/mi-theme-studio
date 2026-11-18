// A formula field for the lock screen side panel: autocomplete for @text and
// #number variables (with what each holds right now) and for functions, what
// the formula shows right now, hints for common mistakes, a date-pattern picker
// with live results, and ready-made snippets to insert.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FlaskConical, Sparkles } from 'lucide-react';
import { evalNumber, evalString, formatDate, type Value, type Vars } from '../../lib/maml';
import { DATE_PATTERNS, FUNC_INFO, SNIPPETS, VAR_INFO, formulaProblems, tokenAt } from '../../lib/mamlHelp';
import { openGuide, tryFormula } from '../../state/guide';

export type FormulaKind = 'text' | 'number' | 'visibility' | 'date';

type Option = { key: string; label: string; detail: string; insert: string; start: number; end: number; caret?: number };

const GUIDE_PAGE: Record<FormulaKind, [string, string | null]> = {
  text: ['expressions', null],
  number: ['layout', 'formulas-in-numbers'],
  visibility: ['layout', 'showing-and-hiding'],
  date: ['text-and-dates', 'date-and-time-patterns'],
};

const show = (v: Value | undefined) => (v === undefined ? '' : typeof v === 'number' ? String(+v.toFixed(2)) : v);

/** Colour a formula: #numbers, @text, 'quoted', functions. */
export function FormulaText({ code }: { code: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(/('[^']*'?)|([#@][\w.]+)|([A-Za-z_]\w*)(?=\()|(\d+(?:\.\d+)?)/g)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    out.push(
      <span key={m.index} className={m[1] ? 'tok-str' : m[2] ? (m[2][0] === '#' ? 'tok-num' : 'tok-text') : m[3] ? 'tok-fn' : 'tok-lit'}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return <>{out}</>;
}

export function FormulaField({ value, label, kind, vars, onCommit }: { value: string; label: string; kind: FormulaKind; vars: Vars; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState<'ac' | 'pat' | 'snip' | null>(null);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const wantCaret = useRef<number | null>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (wantCaret.current === null || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(wantCaret.current, wantCaret.current);
    wantCaret.current = null;
  });

  const now = useMemo(() => new Date(Number(vars.get('time')) || Date.now()), [vars]);

  // Every variable the layout has right now (phone, binders, its own <Var>s, settings), plus documented ones.
  const names = useMemo(() => {
    const set = new Set<string>();
    for (const k of vars.keys()) if (/^[A-Za-z_][\w.]*$/.test(k) && !k.endsWith('.bmp_width') && !k.endsWith('.bmp_height') && !k.startsWith('raw_') && !k.startsWith('view_')) set.add(k);
    for (const k of Object.keys(VAR_INFO)) if (!k.startsWith('mts_')) set.add(k);
    return [...set];
  }, [vars]);

  const options: Option[] = useMemo(() => {
    if (open !== 'ac' || kind === 'date') return [];
    const tok = tokenAt(draft, caret);
    if (!tok) return [];
    const p = tok.prefix.toLowerCase();
    if (tok.kind === 'var') {
      // Names that start with what was typed first, then ones of the kind the sigil reads (@ text, # numbers), then documented ones.
      const isText = (n: string) => {
        const v = vars.get(n);
        return typeof v === 'string' && v !== '' && Number.isNaN(Number(v));
      };
      const score = (n: string) => (n.toLowerCase().startsWith(p) ? 0 : 4) + ((tok.sigil === '@') === isText(n) ? 0 : 2) + (n in VAR_INFO ? 0 : 1);
      return names
        .filter((n) => !p || n.toLowerCase().includes(p))
        .sort((a, b) => score(a) - score(b) || a.length - b.length || a.localeCompare(b))
        .slice(0, 9)
        .map((n) => {
          const v = vars.get(n);
          // Text is read with @, numbers with #: insert the right one whatever was typed.
          const sigil = typeof v === 'string' && v !== '' && Number.isNaN(Number(v)) ? '@' : v === undefined ? tok.sigil : typeof v === 'string' ? tok.sigil : '#';
          return { key: n, label: `${sigil}${n}`, detail: [show(v) || (v === '' ? 'empty now' : ''), VAR_INFO[n] ?? ''].filter(Boolean).join(' · '), insert: `${sigil}${n}`, start: tok.start, end: caret };
        });
    }
    return FUNC_INFO.filter((f) => f.name.toLowerCase().startsWith(p) && f.name.toLowerCase() !== p)
      .slice(0, 6)
      .map((f) => ({ key: f.name, label: f.sig, detail: f.desc, insert: f.insert, start: tok.start, end: caret }));
  }, [open, kind, draft, caret, names, vars]);

  const result = useMemo(() => {
    if (kind === 'date') return formatDate(draft, now);
    if (kind === 'text') return evalString(draft, vars);
    const n = evalNumber(draft, vars, kind === 'visibility' ? 1 : 0);
    return kind === 'visibility' ? (n > 0 ? 'shown' : 'hidden') : String(+n.toFixed(2));
  }, [kind, draft, vars, now]);
  const problems = kind === 'date' ? [] : formulaProblems(draft, vars);
  const snippets = SNIPPETS.filter((s) => s.kind === (kind === 'date' ? 'text' : kind));

  const commit = (next = draft) => {
    if (next.trim() !== value.trim()) onCommit(next.trim());
  };
  const pick = (o: Option) => {
    const next = draft.slice(0, o.start) + o.insert + draft.slice(o.end);
    setDraft(next);
    wantCaret.current = o.start + o.insert.length;
    setCaret(wantCaret.current);
    setOpen(null);
  };
  const sync = (el: HTMLInputElement) => {
    setDraft(el.value);
    setCaret(el.selectionStart ?? el.value.length);
    setIdx(0);
    setOpen(kind === 'date' ? 'pat' : tokenAt(el.value, el.selectionStart ?? el.value.length) ? 'ac' : null);
  };

  const [page, anchor] = GUIDE_PAGE[kind];
  return (
    <div className="ff">
      <div className="ff-head">
        <span>{label}</span>
        <button className={`ff-snip-btn ${open === 'snip' ? 'is-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(open === 'snip' ? null : 'snip')} title="Ready-made formulas">
          <Sparkles /> {kind === 'date' ? 'Patterns' : 'Snippets'}
        </button>
      </div>
      <input
        ref={input}
        className="input ff-input"
        value={draft}
        spellCheck={false}
        autoComplete="off"
        placeholder={kind === 'text' ? "e.g. @mts_weather_desc+' '+#battery_level+'%'" : undefined}
        onChange={(e) => sync(e.target)}
        onClick={(e) => {
          setCaret(e.currentTarget.selectionStart ?? 0);
          if (kind === 'date') setOpen('pat');
        }}
        onFocus={() => kind === 'date' && setOpen('pat')}
        onBlur={() => {
          setOpen(null);
          commit();
        }}
        onKeyDown={(e) => {
          const list = open === 'ac' ? options : [];
          if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
          } else if (list.length && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            pick(list[Math.min(idx, list.length - 1)]);
          } else if (e.key === 'Escape') {
            if (open) setOpen(null);
            else {
              setDraft(value);
              e.currentTarget.blur();
            }
          } else if (e.key === 'Enter') {
            setOpen(null);
            e.currentTarget.blur();
          } else if (e.key === ' ' && e.ctrlKey && kind !== 'date') {
            e.preventDefault();
            setOpen('ac');
          }
        }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
      />

      {open === 'ac' && options.length > 0 && (
        <div className="ff-pop" role="listbox">
          <div className="ff-pophead">{options[0].label.startsWith('#') || options[0].label.startsWith('@') ? 'Variables · value now' : 'Functions'}</div>
          {options.map((o, i) => (
            <button key={o.key} role="option" aria-selected={i === idx} className={`ff-opt ${i === idx ? 'is-on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setIdx(i)}>
              <code>
                <FormulaText code={o.label} />
              </code>
              <span>{o.detail}</span>
            </button>
          ))}
          <div className="ff-pophead ff-keys">↑↓ choose · Enter insert · Esc close</div>
        </div>
      )}

      {open === 'pat' && kind === 'date' && (
        <div className="ff-pop">
          <div className="ff-pophead">Patterns · shown now</div>
          {DATE_PATTERNS.map(([p, name]) => (
            <button
              key={p}
              className={`ff-opt ${p === draft ? 'is-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft(p);
                setOpen(null);
                commit(p);
              }}
            >
              <code>{p}</code>
              <span>
                <strong>{formatDate(p, now)}</strong> · {name}
              </span>
            </button>
          ))}
          <div className="ff-pophead ff-keys">d day · M month · y year · E weekday · H/h hour · m minute · a AM/PM · 'words'</div>
        </div>
      )}

      {open === 'snip' && (
        <div className="ff-pop ff-snips">
          {kind === 'date'
            ? DATE_PATTERNS.map(([p, name]) => (
                <div key={p} className="ff-snip">
                  <div>
                    <strong>{formatDate(p, now)}</strong> <span className="faint">{name}</span>
                    <code>{p}</code>
                  </div>
                  <button
                    className="btn btn-sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setDraft(p);
                      setOpen(null);
                      commit(p);
                    }}
                  >
                    Use
                  </button>
                </div>
              ))
            : snippets.map((s) => (
                <div key={s.code} className="ff-snip">
                  <div>
                    <strong>{s.title}</strong> <span className="faint">{s.desc}</span>
                    <code>
                      <FormulaText code={s.code} />
                    </code>
                    <span className="ff-snip-now">→ {kind === 'text' ? evalString(s.code, vars) || 'empty' : kind === 'visibility' ? (evalNumber(s.code, vars, 1) > 0 ? 'shown now' : 'hidden now') : String(+evalNumber(s.code, vars).toFixed(2))}</span>
                  </div>
                  <button
                    className="btn btn-sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setDraft(s.code);
                      setOpen(null);
                      commit(s.code);
                    }}
                  >
                    Insert
                  </button>
                </div>
              ))}
          <button className="ff-guide" onMouseDown={(e) => e.preventDefault()} onClick={() => openGuide(page, anchor)}>
            <BookOpen /> Open the guide
          </button>
        </div>
      )}

      <div className="ff-now">
        <span>Shows now</span>
        <b className={result === '' ? 'is-empty' : ''}>{result === '' ? 'empty' : result}</b>
        {kind !== 'date' && (
          <button className="ff-try" onMouseDown={(e) => e.preventDefault()} onClick={() => tryFormula(draft)} title="Try this formula at other times, battery levels and weather">
            <FlaskConical /> Try
          </button>
        )}
      </div>
      {problems.map((p) => (
        <div key={p} className="ff-hint">
          {p}
        </div>
      ))}
      {kind !== 'date' && !draft.trim() && <div className="ff-tip">Type @ for text or # for numbers to see the phone’s values.</div>}
    </div>
  );
}
