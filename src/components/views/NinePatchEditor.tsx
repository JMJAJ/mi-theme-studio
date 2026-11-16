// Nine-patch editor: shows stretch areas and content padding over the image,
// lets you drag on the rulers to define them, and previews the stretched
// result. Compiled nine-patches (npTc chunk) keep their pixels byte-for-byte.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Info, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import type { FileInfo, NinePatch, Slot } from '../../lib/types';
import * as A from '../../state/actions';
import { toast } from '../../state/store';

type Range = [number, number];
type Padding = [number, number, number, number];

/** Sort, clamp and merge overlapping or touching ranges. */
export function normalizeRanges(ranges: Range[], size: number): Range[] {
  const clean = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(size, Math.max(a, b))] as Range)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of clean) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Destination sizes of each source segment when stretched to `target`. */
export function stretchSegments(ranges: Range[], size: number, target: number) {
  const bounds = [0, ...ranges.flat(), size].filter((v, i, all) => i === 0 || v !== all[i - 1]);
  const segs: { from: number; to: number; stretch: boolean }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (to > from) segs.push({ from, to, stretch: ranges.some(([a, b]) => from >= a && to <= b) });
  }
  const fixed = segs.filter((s) => !s.stretch).reduce((n, s) => n + s.to - s.from, 0);
  const stretchSrc = segs.filter((s) => s.stretch).reduce((n, s) => n + s.to - s.from, 0);
  const free = Math.max(0, target - fixed);
  // Fixed parts shrink proportionally only when the target is smaller than them.
  const fixedScale = target < fixed ? target / fixed : 1;
  let at = 0;
  return segs.map((s) => {
    const len = s.to - s.from;
    const out = s.stretch ? (stretchSrc ? (free * len) / stretchSrc : 0) : len * fixedScale;
    const seg = { ...s, dest: at, destLen: out };
    at += out;
    return seg;
  });
}

function Ruler({
  axis,
  size,
  scale,
  ranges,
  tone,
  onAdd,
  onRemove,
  disabled,
}: {
  axis: 'x' | 'y';
  size: number;
  scale: number;
  ranges: Range[];
  tone: 'stretch' | 'padding';
  onAdd: (r: Range, replace: boolean) => void;
  onRemove?: (index: number) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Range | null>(null);
  const pos = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const v = axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top;
    return Math.max(0, Math.min(size, Math.floor(v / scale)));
  };
  const length = size * scale;
  return (
    <div
      ref={ref}
      className={`np-ruler np-ruler-${axis} ${tone}`}
      style={axis === 'x' ? { width: length } : { height: length }}
      title={
        disabled
          ? undefined
          : tone === 'stretch'
            ? 'Drag to add a stretch area (Shift+drag replaces all). Alt+click an area to remove it.'
            : 'Drag to set the content area'
      }
      onPointerDown={(e) => {
        if (disabled) return;
        e.stopPropagation();
        const p = pos(e);
        if (e.altKey && onRemove) {
          const i = ranges.findIndex(([a, b]) => p >= a && p < b);
          if (i >= 0) onRemove(i);
          return;
        }
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag([p, Math.min(size, p + 1)]);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = pos(e);
        setDrag([drag[0], p >= drag[0] ? Math.max(p, drag[0] + 1) : p]);
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const [a, b] = drag;
        setDrag(null);
        onAdd([Math.min(a, b), Math.max(a, b)], e.shiftKey || tone === 'padding');
      }}
    >
      {[...ranges, ...(drag ? [[Math.min(...drag), Math.max(...drag)] as Range] : [])].map(([a, b], i) => (
        <span
          key={i}
          className={`np-mark ${drag && i === ranges.length ? 'is-drag' : ''}`}
          style={axis === 'x' ? { left: a * scale, width: (b - a) * scale } : { top: a * scale, height: (b - a) * scale }}
        />
      ))}
    </div>
  );
}

function RangeList({
  label,
  ranges,
  size,
  onChange,
  disabled,
}: {
  label: string;
  ranges: Range[];
  size: number;
  onChange: (r: Range[]) => void;
  disabled: boolean;
}) {
  const set = (i: number, k: 0 | 1, v: number) => {
    const next = ranges.map((r) => [...r] as Range);
    next[i][k] = Number.isFinite(v) ? v : 0;
    onChange(next);
  };
  return (
    <div className="field">
      <div className="row">
        <span className="field-label grow">{label}</span>
        <button
          className="btn btn-ghost btn-sm"
          disabled={disabled}
          onClick={() => onChange(normalizeRanges([...ranges, [Math.floor(size / 3), Math.max(Math.floor(size / 3) + 1, Math.ceil((2 * size) / 3))]], size))}
        >
          <Plus /> Add
        </button>
      </div>
      {ranges.length === 0 && <span className="field-error">None. Drag on the ruler or click Add.</span>}
      {ranges.map(([a, b], i) => (
        <div key={i} className="row np-range">
          <input className="input" type="number" min={0} max={size} value={a} disabled={disabled} aria-label={`${label} ${i + 1} start`} onChange={(e) => set(i, 0, e.target.valueAsNumber)} />
          <span className="faint">to</span>
          <input className="input" type="number" min={0} max={size} value={b} disabled={disabled} aria-label={`${label} ${i + 1} end`} onChange={(e) => set(i, 1, e.target.valueAsNumber)} />
          <span className="faint nowrap">{Math.max(0, b - a)}px</span>
          <button className="btn btn-ghost btn-icon btn-sm" disabled={disabled} aria-label="Remove" title="Remove" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  );
}

function StretchPreview({ src, info, x, y, padding, border }: { src: string; info: NinePatch; x: Range[]; y: Range[]; padding: Padding | null; border: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [w, setW] = useState(Math.max(info.width * 2, 120));
  const [h, setH] = useState(Math.max(info.height * 2, 80));
  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = src;
  }, [src]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    const xs = stretchSegments(x, info.width, w);
    const ys = stretchSegments(y, info.height, h);
    for (const sy of ys) {
      for (const sx of xs) {
        if (sx.destLen <= 0 || sy.destLen <= 0) continue;
        ctx.drawImage(image, sx.from + border, sy.from + border, sx.to - sx.from, sy.to - sy.from, sx.dest, sy.dest, sx.destLen + 0.5, sy.destLen + 0.5);
      }
    }
    const pad = padding ?? [x[0]?.[0] ?? 0, y[0]?.[0] ?? 0, info.width - (x[x.length - 1]?.[1] ?? info.width), info.height - (y[y.length - 1]?.[1] ?? info.height)];
    ctx.strokeStyle = 'rgba(76, 183, 130, 0.95)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(pad[0] + 0.5, pad[1] + 0.5, Math.max(0, w - pad[0] - pad[2] - 1), Math.max(0, h - pad[1] - pad[3] - 1));
  }, [image, w, h, x, y, padding, info.width, info.height, border]);
  const max = (n: number) => Math.max(n * 6, 400);
  return (
    <div className="field">
      <span className="field-label">Stretched preview</span>
      <div className="row np-size">
        <span className="faint">W</span>
        <input type="range" className="grow" min={1} max={max(info.width)} value={w} onChange={(e) => setW(Number(e.target.value))} aria-label="Preview width" />
        <span className="mono faint">{w}</span>
      </div>
      <div className="row np-size">
        <span className="faint">H</span>
        <input type="range" className="grow" min={1} max={max(info.height)} value={h} onChange={(e) => setH(Number(e.target.value))} aria-label="Preview height" />
        <span className="mono faint">{h}</span>
      </div>
      <div className="np-preview checker">
        <canvas ref={canvas} style={{ width: w, height: h }} />
      </div>
      <span className="field-hint">Dashed green box: where content (text, icons) is placed.</span>
    </div>
  );
}

export function NinePatchEditor({ file, slot }: { file: FileInfo; slot: Slot }) {
  const [info, setInfo] = useState<NinePatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [x, setX] = useState<Range[]>([]);
  const [y, setY] = useState<Range[]>([]);
  const [padding, setPadding] = useState<Padding | null>(null);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState({ w: 600, h: 400 });
  const stage = useRef<HTMLDivElement>(null);
  const readOnly = slot === 'ref';

  const reset = (np: NinePatch) => {
    setX(np.xDivs.map((d) => [d[0], d[1]]));
    setY(np.yDivs.map((d) => [d[0], d[1]]));
    setPadding(np.padding ? [...np.padding] : null);
  };

  useEffect(() => {
    let cancelled = false;
    api
      .ninepatchInfo(slot, file.path)
      .then((np) => {
        if (cancelled) return;
        setInfo(np);
        reset(np);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [file.path, file.rev, slot]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth - 90, h: el.clientHeight - 90 }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [info !== null]);

  const dirty = useMemo(() => {
    if (!info) return false;
    return JSON.stringify([x, y, padding]) !== JSON.stringify([info.xDivs, info.yDivs, info.padding]);
  }, [info, x, y, padding]);

  if (error) {
    return (
      <div className="empty">
        <AlertTriangle />
        <h3>Cannot read nine-patch data</h3>
        <p>{error}</p>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
      </div>
    );
  }

  const border = info.kind === 'source' ? 1 : 0;
  const scale = Math.max(1, Math.min(24, Math.floor(Math.min(box.w / info.width, box.h / info.height) * 4) / 4 || 1));
  const src = resourceUrl(slot, file.path, file.rev);
  const W = info.width * scale;
  const H = info.height * scale;
  const pad: Padding | null = padding;
  const padX: Range[] = pad ? [[pad[0], info.width - pad[2]]] : [];
  const padY: Range[] = pad ? [[pad[1], info.height - pad[3]]] : [];

  const apply = async () => {
    setBusy(true);
    try {
      const snapshot = await api.ninepatchUpdate(file.path, {
        xDivs: normalizeRanges(x, info.width),
        yDivs: normalizeRanges(y, info.height),
        padding: pad,
      });
      A.applySnapshot(snapshot);
      toast('success', `Updated nine-patch ${file.path.split('/').pop()}`);
    } catch (e) {
      toast('error', `Nine-patch: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="np-editor">
      <div className="np-stage checker" ref={stage}>
        <div className="np-canvas" style={{ width: W + 40, height: H + 40 }}>
          <div className="np-corner" />
          <div style={{ position: 'absolute', left: 20, top: 0 }}>
            <Ruler axis="x" size={info.width} scale={scale} ranges={x} tone="stretch" disabled={readOnly} onAdd={(r, replace) => setX(normalizeRanges(replace ? [r] : [...x, r], info.width))} onRemove={(i) => setX(x.filter((_, j) => j !== i))} />
          </div>
          <div style={{ position: 'absolute', left: 0, top: 20 }}>
            <Ruler axis="y" size={info.height} scale={scale} ranges={y} tone="stretch" disabled={readOnly} onAdd={(r, replace) => setY(normalizeRanges(replace ? [r] : [...y, r], info.height))} onRemove={(i) => setY(y.filter((_, j) => j !== i))} />
          </div>
          <div style={{ position: 'absolute', left: 20, top: 20 + H + 6 }}>
            <Ruler
              axis="x"
              size={info.width}
              scale={scale}
              ranges={padX}
              tone="padding"
              disabled={readOnly}
              onAdd={([a, b]) => setPadding([a, pad?.[1] ?? 0, info.width - b, pad?.[3] ?? 0])}
            />
          </div>
          <div style={{ position: 'absolute', left: 20 + W + 6, top: 20 }}>
            <Ruler
              axis="y"
              size={info.height}
              scale={scale}
              ranges={padY}
              tone="padding"
              disabled={readOnly}
              onAdd={([a, b]) => setPadding([pad?.[0] ?? 0, a, pad?.[2] ?? 0, info.height - b])}
            />
          </div>
          <div className="np-image" style={{ left: 20, top: 20, width: W, height: H }}>
            <img
              src={src}
              alt={file.path}
              draggable={false}
              className={scale >= 3 ? 'pixelated' : ''}
              style={{ width: (info.width + border * 2) * scale, height: (info.height + border * 2) * scale, left: -border * scale, top: -border * scale }}
            />
            {x.map(([a, b], i) => (
              <span key={`x${i}`} className="np-band np-band-x" style={{ left: a * scale, width: (b - a) * scale }} />
            ))}
            {y.map(([a, b], i) => (
              <span key={`y${i}`} className="np-band np-band-y" style={{ top: a * scale, height: (b - a) * scale }} />
            ))}
            {pad && (
              <span
                className="np-padding"
                style={{ left: pad[0] * scale, top: pad[1] * scale, width: Math.max(0, info.width - pad[0] - pad[2]) * scale, height: Math.max(0, info.height - pad[1] - pad[3]) * scale }}
              />
            )}
          </div>
        </div>
      </div>

      <aside className="np-side">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="badge badge-info">
            {info.kind === 'compiled' ? 'Compiled (npTc chunk)' : info.kind === 'source' ? 'Source (1px border)' : 'No nine-patch data yet'}
          </span>
          <span className="faint">
            {info.width} × {info.height}px · {scale}×
          </span>
        </div>
        {info.kind === 'none' && (
          <div className="banner banner-info">
            <Info />
            <span>This PNG has no nine-patch data. Define stretch areas and apply to add a compiled nine-patch chunk; pixels stay unchanged.</span>
          </div>
        )}
        {info.layoutBounds && (
          <div className="banner banner-info">
            <Info />
            <span>Layout bounds are present and are kept as they are.</span>
          </div>
        )}
        <RangeList label="Horizontal stretch (top)" ranges={x} size={info.width} disabled={readOnly} onChange={setX} />
        <RangeList label="Vertical stretch (left)" ranges={y} size={info.height} disabled={readOnly} onChange={setY} />
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={!!pad}
              disabled={readOnly}
              onChange={(e) => setPadding(e.target.checked ? [x[0]?.[0] ?? 0, y[0]?.[0] ?? 0, info.width - (x[x.length - 1]?.[1] ?? info.width), info.height - (y[y.length - 1]?.[1] ?? info.height)] : null)}
            />
            Content padding
          </label>
          {pad ? (
            <div className="np-pad-grid">
              {(['Left', 'Top', 'Right', 'Bottom'] as const).map((label, i) => (
                <label key={label} className="row" style={{ gap: 6 }}>
                  <span className="faint" style={{ width: 46 }}>
                    {label}
                  </span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={pad[i]}
                    disabled={readOnly}
                    onChange={(e) => {
                      const next = [...pad] as Padding;
                      next[i] = Math.max(0, e.target.valueAsNumber || 0);
                      setPadding(next);
                    }}
                  />
                </label>
              ))}
            </div>
          ) : (
            <span className="field-hint">{info.kind === 'source' ? 'Not set: Android uses the stretch area.' : 'Uses the stretch area.'}</span>
          )}
        </div>
        <StretchPreview src={src} info={info} x={normalizeRanges(x, info.width)} y={normalizeRanges(y, info.height)} padding={pad} border={border} />
        {!readOnly && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 'auto', paddingTop: 8 }}>
            <button className="btn btn-sm" disabled={!dirty || busy} onClick={() => reset(info)}>
              <RotateCcw /> Revert
            </button>
            <button className="btn btn-sm btn-primary" disabled={!dirty || busy || !x.length || !y.length} onClick={() => void apply()}>
              {busy ? <Loader2 className="spin" /> : <Check />} Apply
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
