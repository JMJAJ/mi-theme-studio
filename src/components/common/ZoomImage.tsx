// Image viewer that fits the whole image, with wheel zoom (around the cursor),
// drag to pan, and buttons for zoom out / in, fit and actual size.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 32;

interface View {
  zoom: number; // 1 = fit
  x: number; // pan offset in px
  y: number;
}

export function ZoomImage({ src, alt, minHeight = 160, maxHeight = 420 }: { src: string; alt: string; minHeight?: number; maxHeight?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [boxW, setBoxW] = useState(0);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    setView({ zoom: 1, x: 0, y: 0 });
    setNatural(null);
  }, [src]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The box takes the image's aspect ratio, within limits.
  const boxH = natural && boxW ? Math.round(Math.min(maxHeight, Math.max(minHeight, (boxW * natural.h) / natural.w))) : minHeight;
  const fit = natural && boxW ? Math.min(boxW / natural.w, boxH / natural.h) : 1;
  const baseW = natural ? natural.w * fit : 0;
  const baseH = natural ? natural.h * fit : 0;

  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setView((v) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
        const k = zoom / v.zoom;
        // Keep the point under the cursor (relative to the box centre) fixed.
        const px = cx ?? 0;
        const py = cy ?? 0;
        return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    },
    [],
  );

  // Non-passive wheel listener so the page doesn't scroll while zooming.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // Ctrl+wheel stays the app-wide zoom
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const actual = fit ? 1 / fit : 1; // zoom value that shows 1 image px per screen px
  const percent = Math.round(view.zoom * fit * 100);

  return (
    <div className="zoom-image">
      <div
        ref={boxRef}
        className="zoom-box checker"
        style={{ height: boxH, cursor: drag.current ? 'grabbing' : view.zoom > 1 ? 'grab' : 'zoom-in' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setView({ zoom: 1, x: 0, y: 0 })}
        title="Scroll to zoom, drag to move, double-click to fit"
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{
            width: baseW || undefined,
            height: baseH || undefined,
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            imageRendering: view.zoom * fit >= 2 ? 'pixelated' : 'auto',
            visibility: natural ? 'visible' : 'hidden',
          }}
        />
      </div>
      <div className="zoom-bar">
        <button className="tb-icon" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25)}>
          <Minus />
        </button>
        <span className="zoom-pct">{percent}%</span>
        <button className="tb-icon" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(1.25)}>
          <Plus />
        </button>
        <span className="grow" />
        {natural && (
          <span className="faint">
            {natural.w} × {natural.h}
          </span>
        )}
        <button className="btn btn-ghost btn-sm" title="Show the whole image" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
          <Maximize /> Fit
        </button>
        <button className="btn btn-ghost btn-sm" title="Actual size" onClick={() => setView({ zoom: actual, x: 0, y: 0 })}>
          1:1
        </button>
      </div>
    </div>
  );
}
