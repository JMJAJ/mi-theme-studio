// The keys and clicks just used on the lock screen editor, shown in its bottom-right
// corner (newest at the bottom, the last three), each fading out after a moment.
import { useEffect, useRef, useState, type RefObject } from 'react';

const LIFE = 2600;
const MERGE = 500;
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
const NAMED: Record<string, string> = { ' ': 'Space', Escape: 'Esc', Delete: 'Del', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Enter: 'Enter', Tab: 'Tab' };
const BUTTONS = ['LMB', 'MMB', 'RMB'];

interface Cast {
  id: number;
  keys: string[];
  count: number;
  at: number;
}

const mods = (e: KeyboardEvent | PointerEvent) => [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter((m): m is string => !!m);

function keyName(e: KeyboardEvent) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return NAMED[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

/** Typing in a field is not an editor shortcut, so it is not shown. */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"], .cm-editor');

export function KeyCast({ area }: { area: RefObject<HTMLElement | null> }) {
  const [list, setList] = useState<Cast[]>([]);
  const next = useRef(1);

  useEffect(() => {
    const push = (keys: string[]) =>
      setList((old) => {
        const now = performance.now();
        const last = old[old.length - 1];
        // The same key or click again right away counts up instead of adding a line.
        if (last && last.keys.join('+') === keys.join('+') && now - last.at < MERGE) return [...old.slice(0, -1), { ...last, count: last.count + 1, at: now }];
        return [...old, { id: next.current++, keys, count: 1, at: now }].slice(-3);
      });
    const onKey = (e: KeyboardEvent) => {
      if (MODS.has(e.key) || typing(e.target) || !area.current?.isConnected) return;
      push([...mods(e), keyName(e)]);
    };
    const onPointer = (e: PointerEvent) => {
      if (!area.current?.contains(e.target as Node) || e.pointerType === 'touch') return;
      push([...mods(e), BUTTONS[e.button] ?? `Mouse ${e.button + 1}`]);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [area]);

  // Drop each one once it has faded.
  useEffect(() => {
    if (!list.length) return;
    const oldest = Math.min(...list.map((c) => c.at));
    const t = window.setTimeout(() => setList((l) => l.filter((c) => performance.now() - c.at < LIFE)), Math.max(0, oldest + LIFE - performance.now()) + 20);
    return () => window.clearTimeout(t);
  }, [list]);

  if (!list.length) return null;
  return (
    <div className="keycast" aria-hidden="true">
      {list.map((c) => (
        <div key={`${c.id}.${c.count}`} className="keycast-row" style={{ animationDuration: `${LIFE}ms` }}>
          {c.keys.map((k, i) => (
            <span key={i} className="keycast-part">
              {i > 0 && <span className="keycast-plus">+</span>}
              <kbd>{k}</kbd>
            </span>
          ))}
          {c.count > 1 && <span className="keycast-count">×{c.count}</span>}
        </div>
      ))}
    </div>
  );
}
