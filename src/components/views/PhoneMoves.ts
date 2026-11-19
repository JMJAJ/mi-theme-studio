// Pick and drag pieces on the Guide's try-out phones (Widgets and Try it, blank
// or on the theme) to see where things fit. Only the drawing moves: the moves
// are laid over the layout's text before it is drawn and never saved.
import { useEffect, useMemo, useRef, useState } from 'react';
import { findStartTag, setAttributes } from '../../lib/mamlEdit';
import { isUserGroup, nudge, type CanvasEdit } from './MamlPreview';

/** How far each piece (by document-order index) has been dragged, in layout pixels. */
export type Moves = Record<number, [number, number]>;

/** The layout text with every dragged piece shifted by its move. */
export function applyMoves(text: string, moves: Moves): string {
  let out = text;
  for (const [key, [dx, dy]] of Object.entries(moves)) {
    if (!dx && !dy) continue;
    const ord = Number(key);
    const tag = findStartTag(out, ord);
    if (!tag) continue;
    const head = out.slice(tag.start, tag.end);
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(head)?.[1] ?? null;
    const attrs: Record<string, string> = {};
    if (dx) attrs.x = nudge(attr('x'), dx);
    if (dy) attrs.y = nudge(attr('y'), dy);
    out = setAttributes(out, ord, attrs);
  }
  return out;
}

/** A Guide widget's own group (date_1, battery_2…) or a group made with Ctrl+G. */
const isPiece = (el: Element | null) => !!el && el.tagName === 'Group' && (isUserGroup(el) || /^[a-z]+_\d+$/.test(el.getAttribute('name') ?? ''));

/**
 * Selection and moves for one try-out phone. Everything starts over when
 * `resetKey` changes (another widget, another phone, an edited script), since
 * the pieces it points at are then different ones.
 */
export function usePhoneMoves(resetKey: string, onMove?: (ords: number[], dx: number, dy: number, elements: Element[]) => number[]) {
  const [moves, setMoves] = useState<Moves>({});
  // Pieces the owner writes into its own code; the rest are only moved in the drawing.
  const write = useRef(onMove);
  write.current = onMove;
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => {
    setMoves({});
    setSel([]);
  }, [resetKey]);

  return useMemo(() => {
    /** What the canvas needs to pick and drag pieces of a layout whose elements are `elements`. */
    const canvas = (elements: Element[]) => ({
      moveOnly: true,
      selected: sel[0] ?? null,
      extra: sel.slice(1),
      onSelect: (ord: number | null) => setSel(ord === null ? [] : [ord]),
      onSelectMany: (ords: number[]) => setSel(ords),
      // A click picks a whole widget; a double-click (or a piece already inside the selection) goes one level in.
      lift: (ord: number, deep = false) => {
        const chain: number[] = [];
        for (let p = elements[ord]?.parentElement ?? null; p; p = p.parentElement) if (isPiece(p)) chain.unshift(elements.indexOf(p));
        for (const g of chain) {
          if (g < 0) continue;
          const inside = sel.some((o) => o !== g && elements[g]?.contains(elements[o] ?? null));
          if (inside || (deep && sel.includes(g))) continue;
          return g;
        }
        return ord;
      },
      onEdit: (_ord: number, change: CanvasEdit) => {
        if (change.kind !== 'move') return;
        const ords = change.ords ?? [_ord];
        // A piece inside another moved one goes with it already.
        let top = ords.filter((o) => !ords.some((p) => p !== o && elements[p]?.contains(elements[o] ?? null)));
        const done = write.current?.(top, Math.round(change.dx), Math.round(change.dy), elements) ?? [];
        top = top.filter((o) => !done.includes(o));
        if (!top.length) return;
        setMoves((m) => {
          const next = { ...m };
          for (const o of top) {
            const [x, y] = next[o] ?? [0, 0];
            next[o] = [Math.round(x + change.dx), Math.round(y + change.dy)];
          }
          return next;
        });
      },
    });
    const reset = () => {
      setMoves({});
      setSel([]);
    };
    return { moves, moved: Object.keys(moves).length > 0, canvas, reset };
  }, [moves, sel]);
}
