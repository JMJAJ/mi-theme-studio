// The home screen as a grid of slots for the generated preview pictures: the
// user fills each page and the dock from the theme's own icons, by dragging
// (pointer events, since the window's file drop handling swallows HTML drag
// and drop on Windows) or by picking a slot and clicking an icon.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Search, Wand2, X } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import type { FileInfo } from '../../lib/types';
import type { HomeIcon } from './PhoneMock';

export type LayoutPage = 'home' | 'apps' | 'icons0' | 'icons1';
export type Slots = (string | null)[];
export type HomeLayout = Record<LayoutPage | 'dock', Slots>;

export const LAYOUT_PAGES: [LayoutPage, string][] = [
  ['home', 'Home page'],
  ['apps', 'Apps page'],
  ['icons0', 'Icons 1'],
  ['icons1', 'Icons 2'],
];

/** How many slots a part of the layout has: the dock 4, the first home page 2 rows under its clock, other pages every row. */
export function slotCount(page: LayoutPage | 'dock', rows: number) {
  return page === 'dock' ? 4 : page === 'home' ? 8 : rows * 4;
}

function fit(slots: Slots | undefined, n: number): Slots {
  return Array.from({ length: n }, (_, i) => slots?.[i] ?? null);
}

/** The layout the generator starts with: the best-known apps in the dock and on the first pages. */
export function defaultLayout(order: string[], rows: number): HomeLayout {
  const n = rows * 4;
  const at = (from: number, count: number) => fit(order.slice(from, from + count), count);
  return { dock: at(0, 4), home: at(4, 8), apps: at(12, n), icons0: at(4, n), icons1: at(4 + n, n) };
}

/** A saved layout made to fit the current grid; unknown icons become empty slots. */
export function normalizeLayout(raw: unknown, rows: number, known: Set<string>): HomeLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out = {} as HomeLayout;
  for (const page of ['dock', 'home', 'apps', 'icons0', 'icons1'] as const) {
    const list = Array.isArray(src[page]) ? (src[page] as unknown[]) : [];
    out[page] = fit(
      list.map((p) => (typeof p === 'string' && known.has(p) ? p : null)),
      slotCount(page, rows),
    );
  }
  return out;
}

interface SlotRef {
  page: LayoutPage | 'dock';
  i: number;
}

export function HomeLayoutEditor({
  layout,
  onChange,
  candidates,
  defaults,
  rows,
  ratio,
  wallpaper,
  hasClock,
}: {
  layout: HomeLayout;
  onChange: (next: HomeLayout) => void;
  candidates: HomeIcon[];
  /** Icon paths in the default order, for auto-fill. */
  defaults: string[];
  rows: number;
  /** Screen height / width. */
  ratio: number;
  wallpaper: FileInfo | undefined;
  hasClock: boolean;
}) {
  const [page, setPage] = useState<LayoutPage>('home');
  const [selected, setSelected] = useState<SlotRef | null>(null);
  const [query, setQuery] = useState('');
  const [ghost, setGhost] = useState<{ path: string; x: number; y: number } | null>(null);
  const byPath = useMemo(() => new Map(candidates.map((c) => [c.file.path, c])), [candidates]);
  const used = useMemo(() => new Set(Object.values(layout).flat().filter(Boolean) as string[]), [layout]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => setSelected(null), [page]);

  const set = (ref: SlotRef, path: string | null, base = layoutRef.current) => {
    const next = { ...base, [ref.page]: [...base[ref.page]] };
    next[ref.page][ref.i] = path;
    return next;
  };
  const order: SlotRef[] = [...Array.from({ length: slotCount(page, rows) }, (_, i) => ({ page, i })), ...Array.from({ length: 4 }, (_, i) => ({ page: 'dock' as const, i }))];
  const nextEmpty = (after: SlotRef | null, l: HomeLayout) => {
    const start = after ? order.findIndex((r) => r.page === after.page && r.i === after.i) + 1 : 0;
    return order.slice(start).find((r) => !l[r.page][r.i]) ?? null;
  };

  // Clicking an icon in the catalogue puts it in the picked slot (or the first empty one) and moves on.
  const place = (path: string) => {
    const target = selected ?? nextEmpty(null, layout);
    if (!target) return;
    const next = set(target, path);
    onChange(next);
    setSelected(nextEmpty(target, next));
  };

  // Pointer dragging from the catalogue or between slots; dropping a slot's icon outside the grid removes it.
  const startDrag = (e: React.PointerEvent, path: string, from: SlotRef | null, onClick: () => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      setGhost({ path, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!moved) return onClick();
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-slot]');
      const l = layoutRef.current;
      if (!el) {
        if (from) onChange(set(from, null, l));
        return;
      }
      const [p, i] = (el.dataset.slot ?? '').split(':');
      const to: SlotRef = { page: p as SlotRef['page'], i: Number(i) };
      if (from && from.page === to.page && from.i === to.i) return;
      const previous = l[to.page][to.i];
      let next = set(to, path, l);
      if (from) next = set(from, previous, next);
      onChange(next);
      setSelected(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const fillPage = () => {
    let next = layout;
    const free = defaults.filter((p) => !used.has(p));
    for (const r of order) if (!next[r.page][r.i] && free.length) next = set(r, free.shift()!, next);
    onChange(next);
  };
  const clearPage = () => onChange({ ...layout, [page]: layout[page].map(() => null) });

  const slot = (ref: SlotRef) => {
    const path = layout[ref.page][ref.i];
    const icon = path ? byPath.get(path) : undefined;
    const isSel = selected?.page === ref.page && selected.i === ref.i;
    return (
      <div
        key={`${ref.page}:${ref.i}`}
        data-slot={`${ref.page}:${ref.i}`}
        className={`hl-slot ${icon ? 'is-filled' : ''} ${isSel ? 'is-selected' : ''}`}
        title={icon ? `${icon.label} · drag to move, drag out to remove` : 'Empty · click to pick, then click an icon'}
        onPointerDown={icon ? (e) => startDrag(e, icon.file.path, ref, () => setSelected(isSel ? null : ref)) : undefined}
        onClick={icon ? undefined : () => setSelected(isSel ? null : ref)}
      >
        {icon ? (
          <>
            <img src={resourceUrl('main', icon.file.path, icon.file.rev)} alt="" draggable={false} />
            {ref.page !== 'dock' && <span>{icon.label}</span>}
            <button
              type="button"
              className="hl-remove"
              title="Remove"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(set(ref, null));
              }}
            >
              <X />
            </button>
          </>
        ) : (
          <i />
        )}
      </div>
    );
  };

  const count = slotCount(page, rows);
  const lines = Array.from({ length: count / 4 }, (_, r) => Array.from({ length: 4 }, (_, c) => ({ page, i: r * 4 + c })));
  const filter = query.trim().toLowerCase();
  const shown = filter ? candidates.filter((c) => c.label.toLowerCase().includes(filter) || c.file.path.toLowerCase().includes(filter)) : candidates;
  const phoneW = 216;

  return (
    <div className="hl-editor">
      <div className="hl-left">
        <div className="segmented" role="group" aria-label="Page">
          {LAYOUT_PAGES.map(([id, label]) => (
            <button key={id} aria-pressed={page === id} onClick={() => setPage(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="hl-phone" style={{ width: phoneW, height: phoneW * ratio }}>
          {wallpaper && <img className="hl-wall" src={resourceUrl('main', wallpaper.path, wallpaper.rev)} alt="" draggable={false} />}
          <div className="hl-grid">
            {page === 'home' && hasClock && <div className="hl-clock">Theme clock widget</div>}
            <div className="hl-rows">
              {lines.map((line, r) => (
                <div key={r} className="hl-row">
                  {line.map(slot)}
                </div>
              ))}
            </div>
            <div className="hl-row hl-dock">{Array.from({ length: 4 }, (_, i) => slot({ page: 'dock', i }))}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" onClick={fillPage} title="Fill this page's empty slots and the dock with icons not used yet">
            <Wand2 /> Fill empty
          </button>
          <button className="btn btn-sm" onClick={clearPage} title="Empty this page (the dock stays)">
            <Eraser /> Clear page
          </button>
        </div>
      </div>
      <div className="hl-right">
        <label className="hl-search">
          <Search />
          <input className="input" placeholder={`Search ${candidates.length} icons`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          Drag icons onto the phone, or pick a slot and click an icon. Drag a placed icon to move it, or off the phone to remove it. The dock is shared by every page; recent apps shows the first four apps of the dock and home page.
        </p>
        <div className="hl-catalogue">
          {shown.map((c) => (
            <div
              key={c.file.path}
              className={`hl-item ${used.has(c.file.path) ? 'is-used' : ''}`}
              title={`${c.label} · ${c.file.path}`}
              onPointerDown={(e) => startDrag(e, c.file.path, null, () => place(c.file.path))}
            >
              <img src={resourceUrl('main', c.file.path, c.file.rev)} alt="" loading="lazy" draggable={false} />
              <span>{c.label}</span>
            </div>
          ))}
          {!shown.length && <p className="muted">No icons match.</p>}
        </div>
      </div>
      {ghost && byPath.get(ghost.path) && (
        <img className="hl-ghost" src={resourceUrl('main', ghost.path, byPath.get(ghost.path)!.file.rev)} alt="" style={{ left: ghost.x, top: ghost.y }} />
      )}
    </div>
  );
}
