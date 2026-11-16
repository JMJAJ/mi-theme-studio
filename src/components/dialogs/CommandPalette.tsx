import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { COMMANDS, isEnabled } from '../../state/commands';
import { setState, useStore } from '../../state/store';
import { openFile } from '../../state/actions';
import { fileName } from '../../lib/paths';
import { kindIcon } from '../common/icons';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ComponentType<{ width?: number }>;
  run: () => void;
}

function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const index = t.indexOf(q);
  if (index !== -1) return 100 - index;
  // subsequence match
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return 0;
    ti += 1;
  }
  return 10;
}

export function CommandPalette() {
  const mode = useStore((s) => s.palette);
  const files = useStore((s) => s.project?.files);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(mode === 'commands' ? '>' : '');
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [mode]);

  const commandMode = query.startsWith('>');
  const q = (commandMode ? query.slice(1) : query).trim();

  const entries = useMemo<Entry[]>(() => {
    if (!mode) return [];
    if (commandMode) {
      const state = useStore.getState();
      return COMMANDS.filter((c) => isEnabled(c, state))
        .map((c) => ({ c, s: score(`${c.group} ${c.label}`, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
        .map(({ c }) => ({ id: c.id, label: `${c.group}: ${c.label}`, hint: c.shortcut, icon: c.icon, run: () => void c.run() }));
    }
    return (files ?? [])
      .map((f) => ({ f, s: Math.max(score(fileName(f.path), q) * 2, score(f.path, q)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.path.length - b.f.path.length)
      .slice(0, 80)
      .map(({ f }) => ({ id: f.path, label: fileName(f.path), hint: f.path, icon: kindIcon(f.kind), run: () => openFile(f.path) }));
  }, [mode, commandMode, q, files]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!mode) return null;
  const close = () => setState({ palette: null });
  const choose = (entry?: Entry) => {
    if (!entry) return;
    close();
    entry.run();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={commandMode ? 'Command palette' : 'Go to file'}>
        <input
          ref={inputRef}
          className="input"
          value={query}
          placeholder={commandMode ? 'Type a command' : 'Search files by name or path — type > for commands'}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
          aria-controls="palette-list"
          aria-activedescendant={entries[active] ? `palette-${active}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') setActive((a) => Math.min(entries.length - 1, a + 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
            else if (e.key === 'Enter') choose(entries[active]);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {entries.length === 0 && <div className="tree-empty">{commandMode ? 'No matching commands.' : files ? 'No matching files.' : 'Open a package to search files. Type > for commands.'}</div>}
          {entries.map((entry, i) => {
            const Icon = entry.icon;
            return (
              <div
                key={entry.id}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                className={`palette-item ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(entry)}
              >
                {Icon ? <Icon width={14} /> : <CornerDownLeft width={14} />}
                <span className="ellipsis">{entry.label}</span>
                {entry.hint && <span className="hint mono">{entry.hint}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
