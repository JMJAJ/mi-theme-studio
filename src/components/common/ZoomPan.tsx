// A view that always starts showing the whole content, and lets you zoom with
// the wheel or the buttons and move around by dragging. Double-click resets.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

const MIN = 1;
const MAX = 8;

export function ZoomPan({ children, className = '' }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const clamp = (z: number, x: number, y: number) => {
    const el = box.current;
    if (!el || z <= 1) return { z: 1, x: 0, y: 0 };
    const w = el.clientWidth;
    const h = el.clientHeight;
    return { z, x: Math.min(0, Math.max(w - w * z, x)), y: Math.min(0, Math.max(h - h * z, y)) };
  };
  const zoomAt = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const el = box.current;
      const z = Math.min(MAX, Math.max(MIN, v.z * factor));
      const px = cx ?? (el ? el.clientWidth / 2 : 0);
      const py = cy ?? (el ? el.clientHeight / 2 : 0);
      // Keep the point under the cursor in place.
      return clamp(z, px - ((px - v.x) * z) / v.z, py - ((py - v.y) * z) / v.z);
    });

  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Non-passive so the wheel zooms the picture instead of scrolling the dialog.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={box}
      className={`zoompan ${view.z > 1 ? 'is-zoomed' : ''} ${className}`}
      onPointerDown={(e) => {
        if (view.z <= 1 || (e.target as HTMLElement).closest('button, input, audio')) return;
        drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => clamp(v.z, d.x + e.clientX - d.px, d.y + e.clientY - d.py));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setView({ z: 1, x: 0, y: 0 })}
    >
      <div className="zoompan-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {children}
      </div>
      <div className="zoompan-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" disabled={view.z <= 1} onClick={() => zoomAt(1 / 1.5)}>
          <Minus />
        </button>
        <span>{Math.round(view.z * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={view.z >= MAX} onClick={() => zoomAt(1.5)}>
          <Plus />
        </button>
        <button type="button" aria-label="Show the whole picture" title="Whole picture (double-click)" disabled={view.z <= 1} onClick={() => setView({ z: 1, x: 0, y: 0 })}>
          <Maximize />
        </button>
      </div>
    </div>
  );
}
