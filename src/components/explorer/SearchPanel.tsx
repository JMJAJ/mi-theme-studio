// Find and replace across the project's text files (including files inside
// component archives). Replacements are one undoable change.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CaseSensitive, ChevronDown, ChevronRight, Loader2, Regex, Replace, ReplaceAll, WholeWord, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { displayFolder, fileName, parentOf } from '../../lib/paths';
import type { ReplaceTarget, SearchFile, SearchMatch, SearchOptions, SearchResult } from '../../lib/types';
import * as A from '../../state/actions';
import { confirmDialog, log, toast, useStore } from '../../state/store';

function Toggle({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`search-toggle ${on ? 'is-on' : ''}`} aria-pressed={on} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function MatchLine({ match }: { match: SearchMatch }) {
  const chars = [...match.preview];
  const before = chars.slice(0, match.previewStart).join('');
  const hit = chars.slice(match.previewStart, match.previewStart + match.length).join('');
  const after = chars.slice(match.previewStart + match.length).join('');
  return (
    <span className="match-text">
      {before}
      <mark>{hit}</mark>
      {after}
    </span>
  );
}

export function SearchPanel() {
  const project = useStore((s) => s.project);
  const drafts = useStore((s) => s.drafts);
  const [options, setOptions] = useState<SearchOptions>({ query: '', regex: false, caseSensitive: false, wholeWord: false, include: '' });
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const request = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const run = async (opts = options) => {
    const id = ++request.current;
    if (!opts.query) {
      setResult(null);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const r = await api.projectSearch(opts);
      if (id === request.current) {
        setResult(r);
        setError(null);
      }
    } catch (e) {
      if (id === request.current) {
        setResult(null);
        setError(errorMessage(e));
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  };

  // Debounced live search; re-run when the project content changes.
  const revKey = useMemo(() => project?.files.reduce((n, f) => n + f.rev, 0) ?? 0, [project]);
  useEffect(() => {
    const timer = window.setTimeout(() => void run(options), 220);
    return () => window.clearTimeout(timer);
  }, [options, revKey]);

  const update = (patch: Partial<SearchOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const drafted = (path: string) => !!drafts[path];

  const doReplace = async (targets: ReplaceTarget[], what: string) => {
    const blocked = targets.filter((t) => drafted(t.path));
    const usable = targets.filter((t) => !drafted(t.path));
    if (blocked.length) toast('warning', `${plural(blocked.length, 'file')} with unapplied edits skipped. Apply or revert them first.`);
    if (!usable.length) return;
    if (usable.length > 1) {
      const count = result?.files.filter((f) => usable.some((t) => t.path === f.path)).reduce((n, f) => n + f.matches.length, 0) ?? 0;
      const ok = await confirmDialog({
        title: 'Replace in files',
        message: `Replace ${plural(count, 'match', 'matches')} in ${plural(usable.length, 'file')} with “${replacement}”?`,
        detail: ['This is one change you can undo with Ctrl+Z.'],
        confirmLabel: 'Replace',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { result: r, snapshot } = await api.projectReplace(options, replacement, usable);
      A.applySnapshot(snapshot);
      const notes: string[] = [];
      if (r.invalidXml.length) notes.push(`${plural(r.invalidXml.length, 'file')} skipped (result would not be valid XML)`);
      if (r.stale.length) notes.push(`${plural(r.stale.length, 'file')} changed since the search`);
      toast(r.invalidXml.length || r.stale.length ? 'warning' : 'success', `Replaced ${r.replacements} in ${plural(r.files.length, 'file')}${notes.length ? ` · ${notes.join(', ')}` : ''}`);
      for (const path of r.invalidXml) log('warning', `Replace skipped ${path}: the result would not be well-formed XML`);
      log('info', `${what}: ${r.replacements} replacements`);
    } catch (e) {
      toast('error', `Replace: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const fileTarget = (f: SearchFile): ReplaceTarget => ({ path: f.path, rev: f.rev, offsets: null });
  const toggleFile = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (!project) return <div className="tree-empty">Open a theme to search its files.</div>;

  return (
    <div className="search-panel">
      <div className="search-form">
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            title={showReplace ? 'Hide replace' : 'Show replace'}
            aria-label="Toggle replace"
            onClick={() => setShowReplace((v) => !v)}
          >
            {showReplace ? <ChevronDown /> : <ChevronRight />}
          </button>
          <div className="search-field grow">
            <input
              ref={input}
              className="input"
              placeholder="Search"
              value={options.query}
              onChange={(e) => update({ query: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
              aria-label="Search text"
              spellCheck={false}
            />
            <Toggle on={options.caseSensitive} title="Match case" onClick={() => update({ caseSensitive: !options.caseSensitive })}>
              <CaseSensitive />
            </Toggle>
            <Toggle on={options.wholeWord} title="Match whole word" onClick={() => update({ wholeWord: !options.wholeWord })}>
              <WholeWord />
            </Toggle>
            <Toggle on={options.regex} title="Use regular expression" onClick={() => update({ regex: !options.regex })}>
              <Regex />
            </Toggle>
          </div>
        </div>
        {showReplace && (
          <div className="row" style={{ gap: 4, paddingLeft: 31 }}>
            <input
              className="input grow"
              placeholder={options.regex ? 'Replace ($1 for groups)' : 'Replace'}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              aria-label="Replacement text"
              spellCheck={false}
            />
            <button
              className="btn btn-sm"
              title="Replace all"
              aria-label="Replace all"
              disabled={!result?.files.length || busy}
              onClick={() => void doReplace(result!.files.map(fileTarget), 'Replace all')}
            >
              <ReplaceAll />
            </button>
          </div>
        )}
        <div className="row" style={{ paddingLeft: 31 }}>
          <button type="button" className="link-btn" onClick={() => setShowFilter((v) => !v)}>
            {showFilter ? 'Hide filters' : 'Files to include…'}
          </button>
          {options.include && !showFilter && <span className="faint ellipsis">{options.include}</span>}
        </div>
        {showFilter && (
          <div style={{ paddingLeft: 31 }}>
            <input
              className="input"
              placeholder="e.g. *.xml, lockscreen, icons!/"
              value={options.include}
              onChange={(e) => update({ include: e.target.value })}
              aria-label="Files to include"
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="search-summary">
        {busy && <Loader2 className="spin" width={13} />}
        {error ? (
          <span className="err">
            <AlertTriangle width={13} /> {error}
          </span>
        ) : result ? (
          <span className="muted">
            {result.total
              ? `${plural(result.total, 'result')} in ${plural(result.files.length, 'file')}${result.truncated ? ' (first 5000)' : ''}`
              : `No results in ${plural(result.searchedFiles, 'text file')}`}
          </span>
        ) : (
          <span className="faint">Searches text and XML files, including inside component archives. Images and binary XML are skipped.</span>
        )}
      </div>

      <div className="search-results" role="tree" aria-label="Search results">
        {result?.files.map((f) => {
          const open = !collapsed.has(f.path);
          return (
            <div key={f.path} role="treeitem" aria-expanded={open}>
              <div className="result-file" onClick={() => toggleFile(f.path)} title={f.path}>
                {open ? <ChevronDown width={13} /> : <ChevronRight width={13} />}
                <span className="name">{fileName(f.path)}</span>
                <span className="folder ellipsis">{displayFolder(parentOf(f.path))}</span>
                {drafted(f.path) && (
                  <span className="badge badge-warn" title="This file has unapplied edits; results reflect the package version">
                    edits
                  </span>
                )}
                <span className="count">{f.matches.length}</span>
                {showReplace && (
                  <button
                    className="btn btn-ghost btn-icon btn-sm row-action"
                    title="Replace in this file"
                    aria-label="Replace in this file"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void doReplace([fileTarget(f)], `Replace in ${f.path}`);
                    }}
                  >
                    <ReplaceAll />
                  </button>
                )}
              </div>
              {open &&
                f.matches.map((m) => (
                  <div
                    key={m.offset}
                    className="result-match"
                    onClick={() => A.revealInFile(f.path, m.line, m.column, m.length)}
                    title={`Line ${m.line}, column ${m.column}`}
                  >
                    <span className="line">{m.line}</span>
                    <MatchLine match={m} />
                    {showReplace && (
                      <button
                        className="btn btn-ghost btn-icon btn-sm row-action"
                        title="Replace this match"
                        aria-label="Replace this match"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void doReplace([{ path: f.path, rev: f.rev, offsets: [m.offset] }], `Replace in ${f.path}`);
                        }}
                      >
                        <Replace />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
        })}
        {options.query && result && result.total > 0 && (
          <button className="link-btn" style={{ margin: '8px 12px' }} onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(result.files.map((f) => f.path)))}>
            {collapsed.size ? 'Expand all' : 'Collapse all'}
          </button>
        )}
        {options.query && (
          <button
            className="link-btn"
            style={{ margin: '0 12px 12px' }}
            onClick={() => {
              update({ query: '' });
              setResult(null);
            }}
          >
            <X width={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}
