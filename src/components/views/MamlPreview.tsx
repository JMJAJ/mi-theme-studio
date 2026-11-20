// Live preview of a MAML layout (lock screen, clock, widget): reads the part's
// manifest.xml and draws its images, text, clocks and shapes where the
// manifest puts them, with the current time and its animations playing. On the
// Lock screen page you can click any piece to edit it, or drag it to move it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, AlignCenterVertical, ArrowLeftRight, BatteryCharging, CalendarDays, Circle as CircleIcon, CircleDashed, Clock, ClipboardPaste, Copy, CopyPlus, Footprints, Group as GroupIcon, Ungroup as UngroupIcon, FileArchive, Image as ImageIcon, Info, Loader2, Minus, Package, PackagePlus, Pause, Play, Plus, RectangleHorizontal, Sparkles, Trash2, Type, X, Zap, CloudSun, BatteryMedium } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { evalNumber, evalString, evaluate, formatDate, formatWithParas, systemVars, type Vars } from '../../lib/maml';
import { BASIC_BLOCKS, LOCK_BLOCKS, imageBlock, insertBlock, pageGroupOrdinal, type LockBlock } from '../../lib/mamlBlocks';
import { openGuide } from '../../state/guide';
import { BLOCK_IDS } from '../../lib/mamlRecipes';
import { SAMPLE_COLUMNS } from '../../lib/sampleData';
import { usePendingBlock } from '../../state/guide';
import { absOffset, extractSnippet, pasteSnippet, type Snippet } from '../../lib/mamlCopy';
import { groupElements, lenientXml, removeElements, setAttributes, ungroupElement } from '../../lib/mamlEdit';
import { openContextMenu } from '../common/Menu';
import type { FileInfo, Slot } from '../../lib/types';
import * as A from '../../state/actions';
import { toast, useStore } from '../../state/store';
import { previewDate, previewVariableOverrides, usePreviewGlobals } from '../../state/previewGlobals';
import { itemReader, saveToInventory, slotReader, useInventory, type ByteReader, type InventoryItem } from '../../state/inventory';
import { refreshDownloads, useThemeStore } from '../../state/themeStore';
import { InventoryPanel } from './LockKit';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { findWallpaper } from './PreviewView';
import { MamlInspector } from './MamlInspector';
import { KeyCast } from './KeyCast';

const SKIP = new Set(['Var', 'VariableBinders', 'ExternalCommands', 'Trigger', 'Triggers', 'MusicControl', 'Pressed', 'PressedState', 'ReachedState', 'EndPoint', 'Path', 'FolmeState', 'FolmeConfig', 'Function', 'Array', 'Slider', 'Permanence', 'Sound', 'Item', 'AniFrame', 'Position', 'Alpha', 'Rotation', 'Size', 'Source', 'Mask', 'VarArray', 'Vars', 'Items']);
const CONTAINERS = new Set(['Group', 'Button', 'Unlocker', 'StartPoint', 'Normal', 'NormalState', 'Layer', 'FramerateController', 'AutoScaleGroup', 'ScreenElementsGroup']);
/** Elements a person can click and edit; groups are reached from a child. */
export const DRAWABLE = new Set(['Video', 'Image', 'Text', 'DateTime', 'Time', 'ImageNumber', 'Rectangle', 'Circle', 'Ellipse', 'Arc', 'Line', 'Wallpaper']);

export function argb(value: string | null, fallback = '#ffffff') {
  const v = (value ?? '').trim();
  const m = /^#([0-9a-f]{8})$/i.exec(v);
  if (m) return `#${m[1].slice(2)}${m[1].slice(0, 2)}`;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback;
}

interface Ctx {
  vars: Vars;
  dir: string;
  files: Map<string, FileInfo>;
  wallpaper?: FileInfo;
  now: Date;
  /** Milliseconds into the animations, or null for the resting pose (editing). */
  t: number | null;
  slot: Slot;
  ord: Map<Element, number>;
  unknown: Set<string>;
  /** Where a file is loaded from (the theme by default; inventory pictures are in memory). */
  url?: (f: FileInfo) => string;
}

const urlOf = (ctx: Ctx, f: FileInfo): string => (ctx.url ? ctx.url(f) : resourceUrl(ctx.slot, f.path, f.rev));

function fileFor(ctx: Pick<Ctx, 'dir' | 'files'>, src: string) {
  const clean = src.replace(/^\/+/, '');
  return ctx.files.get(`${ctx.dir}${clean}`) ?? ctx.files.get(`${ctx.dir}${clean}`.toLowerCase());
}

// ---------- animations ----------

interface Frame {
  time: number;
  v: Record<string, string>;
}

/** Keyframe value at time t: numbers are interpolated, everything else steps. */
function frameValue(frames: Frame[], t: number, key: string, ctx: Ctx): number | string | undefined {
  const withKey = frames.filter((f) => key in f.v);
  if (!withKey.length) return undefined;
  let i = withKey.findIndex((f) => f.time > t);
  if (i === -1) i = withKey.length;
  const a = withKey[Math.max(0, i - 1)];
  const b = withKey[Math.min(withKey.length - 1, i)];
  if (key === 'src') return a.v.src;
  const va = evalNumber(a.v[key], ctx.vars);
  const vb = evalNumber(b.v[key], ctx.vars);
  if (a === b || b.time === a.time) return va;
  const p = Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time)));
  return va + (vb - va) * p;
}

function framesOf(anim: Element): { frames: Frame[]; total: number; loop: boolean; delay: number } {
  const frames: Frame[] = [];
  for (const k of Array.from(anim.children)) {
    if (!k.hasAttribute('time')) continue;
    const v: Record<string, string> = {};
    for (const at of Array.from(k.attributes)) if (at.name !== 'time') v[at.name] = at.value;
    if (k.tagName === 'Alpha' && v.a === undefined && v.value !== undefined) v.a = v.value;
    frames.push({ time: Number(k.getAttribute('time')) || 0, v });
  }
  frames.sort((a, b) => a.time - b.time);
  const total = frames.length ? frames[frames.length - 1].time : 0;
  const loop = !['false', '0'].includes(anim.getAttribute('loop') ?? '') && anim.getAttribute('repeat') !== 'false';
  return { frames, total, loop, delay: Number(anim.getAttribute('delay')) || 0 };
}

function animTime(anim: ReturnType<typeof framesOf>, t: number | null) {
  if (!anim.total) return 0;
  // Resting pose: where a one-off animation ends, the start of a looping one.
  if (t === null) return anim.loop ? 0 : anim.total;
  const tt = t - anim.delay;
  if (tt <= 0) return 0;
  return anim.loop ? tt % anim.total : Math.min(tt, anim.total);
}

interface Anim {
  dx: number;
  dy: number;
  alpha?: number;
  angle?: number;
  w?: number;
  h?: number;
  src?: string;
}

function animate(el: Element, ctx: Ctx): Anim {
  const out: Anim = { dx: 0, dy: 0 };
  for (const child of Array.from(el.children)) {
    if (!child.tagName.endsWith('Animation') || child.tagName === 'VariableAnimation') continue;
    const anim = framesOf(child);
    if (!anim.frames.length) continue;
    const t = animTime(anim, ctx.t);
    const num = (k: string) => {
      const v = frameValue(anim.frames, t, k, ctx);
      return typeof v === 'number' ? v : undefined;
    };
    switch (child.tagName) {
      case 'PositionAnimation':
        out.dx += num('x') ?? 0;
        out.dy += num('y') ?? 0;
        break;
      case 'AlphaAnimation':
        out.alpha = num('a') ?? num('alpha') ?? out.alpha;
        break;
      case 'RotationAnimation':
        out.angle = num('angle') ?? out.angle;
        break;
      case 'SizeAnimation':
        out.w = num('w') ?? out.w;
        out.h = num('h') ?? out.h;
        break;
      case 'SourcesAnimation': {
        const v = frameValue(anim.frames, t, 'src', ctx);
        if (typeof v === 'string') out.src = v;
        break;
      }
    }
  }
  return out;
}

// ---------- drawing ----------

/** x/y plus align → CSS position (the element's own size is not needed). */
function place(el: Element, ctx: Ctx, anim: Anim): CSSProperties {
  const n = (name: string, alt?: string) => evalNumber(el.getAttribute(name) ?? (alt ? el.getAttribute(alt) : null), ctx.vars);
  const has = (name: string) => el.hasAttribute(name);
  const style: CSSProperties = { position: 'absolute', left: n('x') + anim.dx, top: n('y') + anim.dy };
  if (anim.w !== undefined) style.width = anim.w;
  else if (has('w') || has('width')) style.width = n('w', 'width');
  if (anim.h !== undefined) style.height = anim.h;
  else if (has('h') || has('height')) style.height = n('h', 'height');
  const tx = el.getAttribute('align') === 'center' ? '-50%' : el.getAttribute('align') === 'right' ? '-100%' : '0';
  const ty = el.getAttribute('alignV') === 'center' ? '-50%' : el.getAttribute('alignV') === 'bottom' ? '-100%' : '0';
  const angle = anim.angle ?? n('rotation', 'angle');
  // scale multiplies scaleX / scaleY, about the pivot (the element's top-left when none is given).
  const s = has('scale') ? evalNumber(el.getAttribute('scale'), ctx.vars, 1) : 1;
  const sx = s * (has('scaleX') ? evalNumber(el.getAttribute('scaleX'), ctx.vars, 1) : 1);
  const sy = s * (has('scaleY') ? evalNumber(el.getAttribute('scaleY'), ctx.vars, 1) : 1);
  const scaled = sx !== 1 || sy !== 1;
  const transforms = [tx !== '0' || ty !== '0' ? `translate(${tx}, ${ty})` : '', angle ? `rotate(${angle}deg)` : '', scaled ? `scale(${sx}, ${sy})` : ''].filter(Boolean);
  if (transforms.length) style.transform = transforms.join(' ');
  if (has('pivotX') || has('pivotY')) style.transformOrigin = `${n('pivotX')}px ${n('pivotY')}px`;
  else if (scaled) style.transformOrigin = '0 0';
  const alpha = (has('alpha') ? n('alpha') : 255) * (anim.alpha === undefined ? 1 : anim.alpha / 255);
  if (alpha < 255) style.opacity = Math.min(1, Math.max(0, alpha / 255));
  const blur = has('blur') ? n('blur') : 0;
  if (blur > 0) style.filter = `blur(${blurPx(blur)}px)`;
  return style;
}

function visible(el: Element, ctx: Ctx) {
  const v = el.getAttribute('visibility');
  if (v === null) return true;
  if (v === 'true' || v === 'false') return v === 'true';
  return evalNumber(v, ctx.vars, 1) > 0;
}

const formatParas = (format: string, paras: string | null, ctx: Ctx) => formatWithParas(format, paras, ctx.vars);

function imageSource(el: Element, ctx: Ctx, anim: Anim) {
  let src = anim.src ?? (el.hasAttribute('srcExp') ? evalString(el.getAttribute('srcExp'), ctx.vars) : el.hasAttribute('srcFormat') ? formatParas(el.getAttribute('srcFormat')!, el.getAttribute('srcParas'), ctx) : (el.getAttribute('src') ?? ''));
  if (el.hasAttribute('srcid') && src) src = src.replace(/(\.[a-z0-9]+)$/i, `_${Math.trunc(evalNumber(el.getAttribute('srcid'), ctx.vars))}$1`);
  return src;
}

// ---------- layers and blending ----------

/** Android PorterDuff.Mode by ordinal (MAML's xfermodeNum) → canvas composite operation. */
const XFER_NUM: (GlobalCompositeOperation | null)[] = [null, 'copy', null, 'source-over', 'destination-over', 'source-in', 'destination-in', 'source-out', 'destination-out', 'source-atop', 'destination-atop', 'xor', 'darken', 'lighten', 'multiply', 'screen', 'lighter', 'overlay'];
const XFER_NAME: Record<string, GlobalCompositeOperation> = { src: 'copy', src_over: 'source-over', dst_over: 'destination-over', src_in: 'source-in', dst_in: 'destination-in', src_out: 'source-out', dst_out: 'destination-out', src_atop: 'source-atop', dst_atop: 'destination-atop', xor: 'xor', darken: 'darken', lighten: 'lighten', multiply: 'multiply', screen: 'screen', add: 'lighter', overlay: 'overlay' };

/** How a piece is blended into its layer, and its blur, as data attributes the layer reads. */
function fx(el: Element, ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  if (el.hasAttribute('xfermodeNum')) out['data-xf'] = XFER_NUM[Math.trunc(evalNumber(el.getAttribute('xfermodeNum'), ctx.vars, 3))] ?? 'skip';
  else if (el.hasAttribute('xfermode')) out['data-xf'] = XFER_NAME[(el.getAttribute('xfermode') ?? '').toLowerCase()] ?? 'source-over';
  const blur = el.hasAttribute('blur') ? evalNumber(el.getAttribute('blur'), ctx.vars) : 0;
  if (blur > 0) out['data-blur'] = String(blur);
  return out;
}
/** MAML blur radius → CSS / canvas blur (standard deviation). */
const blurPx = (radius: number) => radius / 2.5;
/** MAML's built-in font names (mipro-demibold, miui-medium…) → a weight. */
function fontWeightOf(el: Element, bold: boolean) {
  const f = (el.getAttribute('fontFamily') ?? '').toLowerCase();
  if (bold || /heavy|black/.test(f)) return 700;
  if (/semi|demi/.test(f)) return 600;
  if (/bold/.test(f)) return 700;
  if (/medium/.test(f)) return 500;
  if (/light|thin/.test(f)) return 300;
  return 400;
}

/**
 * A group drawn into its own layer (layered="true", or holding pieces with an
 * xfermode), as the phone does: the pieces are composited in order onto a
 * transparent canvas with their Porter-Duff mode, so a blurred <Wallpaper
 * xfermodeNum="5"/> shows only inside the digits drawn before it. The pieces
 * stay in the page, invisible, so they can still be clicked and outlined.
 */
function LayeredGroup({ style, mk, tag, children }: { style: CSSProperties; mk: number; tag: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const pieces = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [, setLoaded] = useState(0);
  useLayoutEffect(() => {
    const host = box.current;
    const wrap = pieces.current;
    const cv = canvas.current;
    const root = host?.closest<HTMLElement>('.maml-canvas');
    if (!host || !wrap || !cv || !root) return;
    const W = root.offsetWidth;
    const H = root.offsetHeight;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    // The canvas covers the whole screen, from the screen's origin.
    const rr = root.getBoundingClientRect();
    const k = rr.width / W || 1;
    const hr = host.getBoundingClientRect();
    cv.style.left = `${-(hr.left - rr.left) / k}px`;
    cv.style.top = `${-(hr.top - rr.top) / k}px`;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    const cr = cv.getBoundingClientRect();
    const ck = cr.width / W || 1;
    const waiting: HTMLImageElement[] = [];
    const alphaOf = (n: HTMLElement) => {
      let a = 1;
      for (let e: HTMLElement | null = n; e && e !== wrap; e = e.parentElement) if (e.style.opacity !== '') a *= Number(e.style.opacity);
      return a;
    };
    for (const n of Array.from(wrap.querySelectorAll<HTMLElement>('img, [data-mt="Text"], [data-mt="DateTime"], [data-mt="Rectangle"], [data-mt="Circle"], [data-mt="Ellipse"]'))) {
      const piece = n.closest<HTMLElement>('[data-mk]') ?? n;
      const op = (piece.dataset.xf ?? 'source-over') as GlobalCompositeOperation | 'skip';
      if (op === 'skip') continue;
      const r = n.getBoundingClientRect();
      const x = (r.left - cr.left) / ck;
      const y = (r.top - cr.top) / ck;
      const w = r.width / ck;
      const h = r.height / ck;
      const blur = Number(piece.dataset.blur ?? 0);
      const wall = piece.dataset.mt === 'Wallpaper';
      g.save();
      g.globalAlpha = alphaOf(n);
      g.filter = blur > 0 ? `blur(${blurPx(blur)}px)` : 'none';
      // Android blends only where a piece draws; keep canvas modes from clearing the rest.
      if (!wall && op !== 'source-over') {
        g.beginPath();
        g.rect(x, y, w, h);
        g.clip();
      }
      g.globalCompositeOperation = op;
      if (n.tagName === 'IMG') {
        const img = n as HTMLImageElement;
        if (!img.complete || !img.naturalWidth) waiting.push(img);
        else if (wall) {
          // The wallpaper covers the screen, centred.
          const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
          g.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
        } else g.drawImage(img, x, y, w, h);
      } else if (n.dataset.mt === 'Text' || n.dataset.mt === 'DateTime') {
        const cs = getComputedStyle(n);
        g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        g.fillStyle = cs.color;
        g.textBaseline = 'middle';
        g.fillText(n.textContent ?? '', x, y + h / 2);
      } else {
        const cs = getComputedStyle(n);
        g.fillStyle = cs.backgroundColor;
        g.beginPath();
        if (n.dataset.mt === 'Rectangle') g.roundRect(x, y, w, h, parseFloat(cs.borderTopLeftRadius) || 0);
        else g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
    if (waiting.length) {
      const again = () => setLoaded((v) => v + 1);
      waiting.forEach((img) => img.addEventListener('load', again, { once: true }));
      return () => waiting.forEach((img) => img.removeEventListener('load', again));
    }
  });
  return (
    <div ref={box} data-mk={mk} data-mt={tag} style={style}>
      <canvas ref={canvas} style={{ position: 'absolute', pointerEvents: 'none' }} />
      <div ref={pieces} style={{ opacity: 0 }}>
        {children}
      </div>
    </div>
  );
}

const digitFile = (base: string, ch: string) => base.replace(/(\.[a-z0-9]+)$/i, `_${/[0-9]/.test(ch) ? ch : ch === '-' ? 'minus' : 'dot'}$1`);

function renderNodes(parent: Element, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  for (const el of Array.from(parent.children)) {
    const tag = el.tagName;
    if (SKIP.has(tag) || /Animation$|Command$|Binder$|Commands$/.test(tag)) continue;
    if (!visible(el, ctx)) continue;
    const mk = ctx.ord.get(el) ?? -1;
    const key = mk;
    const anim = animate(el, ctx);
    if (tag === 'Wallpaper') {
      const b = el.hasAttribute('blur') ? evalNumber(el.getAttribute('blur'), ctx.vars) : 0;
      const a = el.hasAttribute('alpha') ? Math.min(1, Math.max(0, evalNumber(el.getAttribute('alpha'), ctx.vars, 255) / 255)) : 1;
      if (ctx.wallpaper) out.push(<img key={key} data-mk={mk} data-mt={tag} {...fx(el, ctx)} src={urlOf(ctx, ctx.wallpaper)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: b > 0 ? `blur(${blurPx(b)}px)` : undefined, opacity: a < 1 ? a : undefined }} draggable={false} />);
      continue;
    }
    if (CONTAINERS.has(tag)) {
      if (el.getAttribute('layered') === 'true' || Array.from(el.children).some((c) => c.hasAttribute('xfermodeNum') || c.hasAttribute('xfermode'))) {
        out.push(
          <LayeredGroup key={key} mk={mk} tag={tag} style={place(el, ctx, anim)}>
            {renderNodes(el, ctx)}
          </LayeredGroup>,
        );
        continue;
      }
      // A Button's x / y / w / h is only its touch area: what it draws is placed in the parent's coordinates.
      const style = tag === 'Button' ? { ...place(el, ctx, anim), left: 0, top: 0, width: undefined, height: undefined, transform: undefined } : place(el, ctx, anim);
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} style={style}>
          {renderNodes(el, ctx)}
        </div>,
      );
      continue;
    }
    if (tag === 'Image') {
      const src = imageSource(el, ctx, anim);
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<img key={key} data-mk={mk} data-mt={tag} {...fx(el, ctx)} src={urlOf(ctx, file)} alt="" style={place(el, ctx, anim)} draggable={false} />);
      continue;
    }
    if (tag === 'Video') {
      const src = el.getAttribute('src') ?? '';
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<video key={key} data-mk={mk} data-mt={tag} src={urlOf(ctx, file)} muted loop autoPlay playsInline style={{ ...place(el, ctx, anim), objectFit: 'cover' }} />);
      continue;
    }
    if (tag === 'Rectangle' || tag === 'Circle' || tag === 'Ellipse') {
      const style = place(el, ctx, anim);
      const fill = el.getAttribute('fillColor');
      const stroke = el.getAttribute('strokeColor');
      if (fill) style.background = argb(fill, 'transparent');
      if (stroke) style.border = `${evalNumber(el.getAttribute('weight'), ctx.vars, 1)}px solid ${argb(stroke)}`;
      if (tag === 'Circle') {
        const r = evalNumber(el.getAttribute('r'), ctx.vars);
        // x / y is the centre; align / alignV do not move a circle.
        if (typeof style.transform === 'string') style.transform = style.transform.replace(/translate\([^)]*\)\s*/, '') || undefined;
        Object.assign(style, { width: r * 2, height: r * 2, borderRadius: '50%', marginLeft: -r, marginTop: -r });
      } else if (tag === 'Ellipse') style.borderRadius = '50%';
      else if (el.hasAttribute('cornerRadius')) style.borderRadius = evalNumber((el.getAttribute('cornerRadius') ?? '0').split(',')[0], ctx.vars);
      out.push(<div key={key} data-mk={mk} data-mt={tag} {...fx(el, ctx)} style={style} />);
      continue;
    }
    if (tag === 'Arc') {
      // Part of the ellipse in x/y/w/h: from startAngle (0 = 3 o'clock, clockwise) through sweep degrees.
      const style = place(el, ctx, anim);
      const w = Number(style.width) || 0;
      const h = Number(style.height) || 0;
      const weight = el.hasAttribute('strokeColor') ? evalNumber(el.getAttribute('weight'), ctx.vars, 1) : 0;
      const inset = el.getAttribute('strokeAlign') === 'inner' ? weight / 2 : el.getAttribute('strokeAlign') === 'outer' ? -weight / 2 : 0;
      const rx = Math.max(0, w / 2 - inset);
      const ry = Math.max(0, h / 2 - inset);
      const start = evalNumber(el.getAttribute('startAngle'), ctx.vars);
      const sweep = Math.max(-360, Math.min(360, evalNumber(el.getAttribute('sweep'), ctx.vars)));
      const pie = el.getAttribute('close') === 'true';
      const pt = (deg: number) => `${w / 2 + rx * Math.cos((deg * Math.PI) / 180)} ${h / 2 + ry * Math.sin((deg * Math.PI) / 180)}`;
      let d = '';
      if (Math.abs(sweep) >= 360) d = `M ${pt(start)} A ${rx} ${ry} 0 1 1 ${pt(start + 180)} A ${rx} ${ry} 0 1 1 ${pt(start)}${pie ? ' Z' : ''}`;
      else if (sweep !== 0) d = `${pie ? `M ${w / 2} ${h / 2} L ${pt(start)}` : `M ${pt(start)}`} A ${rx} ${ry} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 1 : 0} ${pt(start + sweep)}${pie ? ' Z' : ''}`;
      const cap = el.getAttribute('cap');
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} style={style}>
          {d && (
            <svg width={w} height={h} style={{ overflow: 'visible', display: 'block' }}>
              <path d={d} fill={argb(el.getAttribute('fillColor'), 'transparent')} stroke={weight ? argb(el.getAttribute('strokeColor')) : 'none'} strokeWidth={weight} strokeLinecap={cap === 'round' ? 'round' : cap === 'square' ? 'square' : 'butt'} />
            </svg>
          )}
        </div>,
      );
      continue;
    }
    if (tag === 'Line') {
      const x =evalNumber(el.getAttribute('x'), ctx.vars) + anim.dx;
      const y = evalNumber(el.getAttribute('y'), ctx.vars) + anim.dy;
      const x1 = evalNumber(el.getAttribute('x1'), ctx.vars, x);
      const y1 = evalNumber(el.getAttribute('y1'), ctx.vars, y);
      const len = Math.hypot(x1 - x, y1 - y);
      const weight = evalNumber(el.getAttribute('weight'), ctx.vars, 1);
      out.push(<div key={key} data-mk={mk} data-mt={tag} style={{ position: 'absolute', left: x, top: y - weight / 2, width: len, height: weight, background: argb(el.getAttribute('strokeColor') ?? el.getAttribute('color')), transformOrigin: '0 50%', transform: `rotate(${Math.atan2(y1 - y, x1 - x)}rad)` }} />);
      continue;
    }
    if (tag === 'Text' || tag === 'DateTime') {
      let text: string;
      if (tag === 'DateTime') {
        const at = el.hasAttribute('value') ? new Date(evalNumber(el.getAttribute('value'), ctx.vars, ctx.now.getTime())) : ctx.now;
        text = formatDate(el.hasAttribute('formatExp') ? evalString(el.getAttribute('formatExp'), ctx.vars) : (el.getAttribute('format') ?? 'HH:mm'), at);
      } else if (el.hasAttribute('textExp')) text = evalString(el.getAttribute('textExp'), ctx.vars);
      else if (el.hasAttribute('format') || el.hasAttribute('formatExp')) text = formatParas(el.hasAttribute('formatExp') ? evalString(el.getAttribute('formatExp'), ctx.vars) : el.getAttribute('format')!, el.getAttribute('paras'), ctx);
      else text = el.getAttribute('text') ?? '';
      const style = place(el, ctx, anim);
      const shadow = el.getAttribute('shadowColor');
      Object.assign(style, {
        fontSize: evalNumber(el.getAttribute('size'), ctx.vars, 18),
        color: argb(el.getAttribute('color')),
        fontWeight: fontWeightOf(el, el.getAttribute('bold') === 'true'),
        whiteSpace: el.getAttribute('multiLine') === 'true' ? 'pre-wrap' : 'nowrap',
        lineHeight: 1.2,
        textAlign: (el.getAttribute('align') as 'left' | 'center' | 'right' | null) ?? 'left',
        textShadow: shadow ? `${evalNumber(el.getAttribute('shadowDx'), ctx.vars)}px ${evalNumber(el.getAttribute('shadowDy'), ctx.vars)}px ${evalNumber(el.getAttribute('shadowRadius'), ctx.vars)}px ${argb(shadow)}` : undefined,
        letterSpacing: el.hasAttribute('spacing') ? evalNumber(el.getAttribute('spacing'), ctx.vars) : undefined,
      });
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} {...fx(el, ctx)} style={style}>
          {text}
        </div>,
      );
      continue;
    }
    if (tag === 'Time' || tag === 'ImageNumber') {
      // Digit images: time.png → time_0.png … time_9.png and time_dot.png.
      const base = el.getAttribute('src') ?? (tag === 'Time' ? 'time.png' : 'number.png');
      const text = tag === 'Time' ? formatDate(el.hasAttribute('formatExp') ? evalString(el.getAttribute('formatExp'), ctx.vars) : (el.getAttribute('format') ?? 'HH:mm'), ctx.now) : String(Math.trunc(evalNumber(el.getAttribute('number') ?? el.getAttribute('numberExp'), ctx.vars)));
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} {...fx(el, ctx)} style={{ ...place(el, ctx, anim), display: 'flex', gap: evalNumber(el.getAttribute('space'), ctx.vars) }}>
          {[...text].map((ch, j) => {
            const f = fileFor(ctx, digitFile(base, ch));
            return f ? <img key={j} src={urlOf(ctx, f)} alt="" draggable={false} /> : null;
          })}
        </div>,
      );
      continue;
    }
    ctx.unknown.add(tag);
  }
  return out;
}


/**
 * Fills the variables a layout reads from content providers (<VariableBinders>):
 * weather gets sample values by column, everything else (notifications, music)
 * stays empty, as on a phone with nothing playing and no notifications.
 */
function bindSampleData(root: Element, ctx: Ctx, columns: Record<string, string[]> = SAMPLE_COLUMNS) {
  for (const binder of Array.from(root.getElementsByTagName('ContentProviderBinder'))) {
    if (!/weather|steps/i.test(binder.getAttribute('uri') ?? '')) continue;
    const count = binder.getAttribute('countName');
    if (count) ctx.vars.set(count, 1);
    for (const v of Array.from(binder.getElementsByTagName('Variable'))) {
      const name = v.getAttribute('name');
      const values = columns[v.getAttribute('column') ?? ''];
      if (!name || !values) continue;
      const type = v.getAttribute('type') ?? 'string';
      const val = (x: string) => (/^(int|long|float|double|number)/.test(type) ? Number(x.replace(/[^\d.-]/g, '')) || 0 : x);
      if (type.endsWith('[]')) values.forEach((x, i) => ctx.vars.set(`${name}[${i}]`, val(x)));
      ctx.vars.set(name, val(values[0]));
    }
    // What the layout works out when the data arrives (air quality wording, icon ids…).
    for (const trigger of Array.from(binder.children).filter((c) => c.tagName === 'Trigger'))
      for (const cmd of Array.from(trigger.getElementsByTagName('VariableCommand'))) {
        const name = cmd.getAttribute('name');
        if (!name || (cmd.hasAttribute('condition') && evalNumber(cmd.getAttribute('condition'), ctx.vars) <= 0)) continue;
        const expr = cmd.getAttribute('expression');
        ctx.vars.set(name, cmd.getAttribute('type') === 'string' ? evalString(expr, ctx.vars) : evalNumber(expr, ctx.vars));
      }
  }
}

/**
 * The theme's own settings (config.xml next to the manifest: switches, numbers,
 * choices) at their defaults, as on a phone where nobody changed them.
 */
export function configDefaults(text: string | null): [string, string | number][] {
  if (!text) return [];
  const doc = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  const out: [string, string | number][] = [];
  for (const el of Array.from(doc.querySelectorAll('[id][default]'))) {
    const id = el.getAttribute('id')!;
    const raw = el.getAttribute('default') ?? '';
    const numeric = el.tagName !== 'StringInput' && el.tagName !== 'StringChoice' && raw.trim() !== '' && !Number.isNaN(Number(raw));
    out.push([id, numeric ? Number(raw) : raw]);
  }
  return out;
}

/** Declared variables, in document order; two passes so later ones can feed earlier ones. */
function collectVars(root: Element, ctx: Ctx) {
  const vars = Array.from(root.getElementsByTagName('Var'));
  const arrays = Array.from(root.getElementsByTagName('VarArray'));
  for (let pass = 0; pass < 2; pass++) {
    // VarArray: each <Var index="…"> picks one of the <Items> (week day names and the like).
    for (const arr of arrays) {
      const asString = arr.getAttribute('type') === 'string';
      const items = Array.from(arr.getElementsByTagName('Item'));
      for (const v of Array.from(arr.getElementsByTagName('Var'))) {
        const name = v.getAttribute('name');
        if (!name) continue;
        const item = items[Math.trunc(evalNumber(v.getAttribute('index'), ctx.vars))];
        if (!item) continue;
        const raw = item.hasAttribute('expression') ? evaluate(item.getAttribute('expression'), ctx.vars, asString ? '' : 0) : (item.getAttribute('value') ?? '');
        ctx.vars.set(name, asString ? String(raw) : Number(raw) || 0);
      }
    }
    for (const v of vars) {
      const name = v.getAttribute('name');
      if (!name || v.parentElement?.tagName === 'Vars') continue;
      const animEl = Array.from(v.children).find((c) => c.tagName === 'VariableAnimation');
      if (animEl) {
        const anim = framesOf(animEl);
        const value = frameValue(anim.frames, animTime(anim, ctx.t), 'value', ctx);
        if (value !== undefined) ctx.vars.set(name, value);
        continue;
      }
      if (!v.hasAttribute('expression')) continue;
      ctx.vars.set(name, evaluate(v.getAttribute('expression'), ctx.vars, v.getAttribute('type') === 'string' ? '' : 0));
    }
  }
  for (const el of Array.from(root.querySelectorAll('Image[name]'))) {
    const src = el.hasAttribute('srcExp') ? evalString(el.getAttribute('srcExp'), ctx.vars) : (el.getAttribute('src') ?? '');
    const f = src ? fileFor(ctx, src) : undefined;
    if (f) {
      ctx.vars.set(`${el.getAttribute('name')}.bmp_width`, f.width ?? 0);
      ctx.vars.set(`${el.getAttribute('name')}.bmp_height`, f.height ?? 0);
    }
  }
}

/**
 * What the phone does when the screen wakes: the VariableCommands in
 * <ExternalCommands><Trigger action="init|resume">, each after its delay.
 * Layouts use them to switch on their resting state (and start intro
 * animations from `#time`). When playing, commands fire at their delay after
 * the preview starts; for the still pose the screen woke a while ago.
 * Returns whether any variable was set.
 */
function runWakeCommands(root: Element, ctx: Ctx) {
  const ext = Array.from(root.children).find((c) => c.tagName === 'ExternalCommands');
  if (!ext) return false;
  const now = ctx.now.getTime();
  const wokeAt = ctx.t === null ? now - 600_000 : now - ctx.t;
  const cmds: { el: Element; delay: number; i: number }[] = [];
  let i = 0;
  for (const trigger of Array.from(ext.children)) {
    if (trigger.tagName !== 'Trigger' || !/(^|,)\s*(init|resume)\s*(,|$)/.test(trigger.getAttribute('action') ?? '')) continue;
    for (const el of Array.from(trigger.getElementsByTagName('VariableCommand'))) {
      const delay = Number(el.getAttribute('delay')) || 0;
      if (ctx.t === null || delay <= ctx.t) cmds.push({ el, delay, i: i++ });
    }
  }
  if (!cmds.length) return false;
  cmds.sort((a, b) => a.delay - b.delay || a.i - b.i);
  const time = ctx.vars.get('time');
  for (const { el, delay } of cmds) {
    const name = el.getAttribute('name');
    if (!name) continue;
    ctx.vars.set('time', wokeAt + delay);
    if (el.hasAttribute('condition') && evalNumber(el.getAttribute('condition'), ctx.vars) <= 0) continue;
    const expr = el.getAttribute('expression');
    ctx.vars.set(name, el.getAttribute('type') === 'string' ? evalString(expr, ctx.vars) : evalNumber(expr, ctx.vars));
  }
  if (time !== undefined) ctx.vars.set('time', time);
  return true;
}

// ---------- pages a swipe or tap switches between ----------

/** A lock screen with several pages: the variable that picks one, and its values. */
export interface LockPages {
  name: string;
  values: number[];
}

/**
 * Finds the pages of a lock screen that has more than one: a variable that a
 * touch changes (a Button's VariableCommand) and that switches big groups on
 * and off with visibility="eq(#var,N)". The busiest such variable wins.
 */
export function findPages(doc: Document | null): LockPages | null {
  const root = doc?.documentElement;
  if (!root || root.tagName !== 'Lockscreen') return null;
  const touched = new Set<string>();
  for (const button of Array.from(root.getElementsByTagName('Button')))
    for (const cmd of Array.from(button.getElementsByTagName('VariableCommand'))) {
      const name = cmd.getAttribute('name');
      if (name) touched.add(name);
    }
  const weight = new Map<string, Map<number, number>>();
  for (const group of Array.from(root.getElementsByTagName('Group'))) {
    const vis = group.getAttribute('visibility');
    if (!vis) continue;
    const size = group.getElementsByTagName('*').length + 1;
    for (const m of vis.matchAll(/eq\(\s*#([\w.]+)\s*,\s*(\d+)\s*\)|#([\w.]+)\s*==\s*(\d+)/g)) {
      const name = m[1] ?? m[3];
      const value = Number(m[2] ?? m[4]);
      if (!touched.has(name)) continue;
      const byValue = weight.get(name) ?? new Map<number, number>();
      byValue.set(value, (byValue.get(value) ?? 0) + size);
      weight.set(name, byValue);
    }
  }
  let best: LockPages | null = null;
  let bestWeight = 0;
  for (const [name, byValue] of weight) {
    // Each page has to be a real screenful, not a small toggle.
    const values = [...byValue.entries()].filter(([, n]) => n >= 8).map(([v]) => v);
    if (!values.includes(0)) values.push(0);
    if (values.length < 2) continue;
    const total = [...byValue.values()].reduce((a, b) => a + b, 0);
    if (total > bestWeight) {
      best = { name, values: values.sort((a, b) => a - b) };
      bestWeight = total;
    }
  }
  return best;
}

/** The pages of the theme's lock screen (null for a single-page one), without drawing it. */
export function useLockPages() {
  const manifest = useStore((s) => (s.project ? partManifests(s.project.files, 'lockscreen')[0] : undefined));
  const draft = useStore((s) => (manifest ? s.drafts[manifest.path]?.text : undefined));
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!manifest) return setSaved(null);
    let cancelled = false;
    api
      .fileText(manifest.path, 'main')
      .then((r) => !cancelled && setSaved(r.text))
      .catch(() => !cancelled && setSaved(null));
    return () => {
      cancelled = true;
    };
  }, [manifest?.path, manifest?.rev]);
  const text = draft ?? saved;
  return useMemo(() => {
    if (!text) return null;
    let doc = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'text/xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(lenientXml(text.replace(/^\uFEFF/, '')), 'text/xml');
    return doc.querySelector('parsererror') ? null : findPages(doc);
  }, [text]);
}

/** What some pieces cover on the screen, in layout pixels. */
export function measurePieces(canvas: HTMLElement, ords: number[], scale: number) {
  const box = unionBox(ords.map((o) => canvas.querySelector<HTMLElement>(`[data-mk="${o}"]`)).map((n) => (n ? visibleBox(n, canvas, scale) : null)));
  return box ? { x: Math.round(box.l), y: Math.round(box.t), w: Math.round(box.w), h: Math.round(box.h) } : null;
}

// ---------- the hook ----------

export interface SceneOptions {
  /** Phone height / width, for lock screens. */
  phone: number;
  aspect?: number;
  dir: string;
  files: Map<string, FileInfo>;
  wallpaper?: FileInfo;
  now: Date;
  t: number | null;
  slot: Slot;
  config?: [string, string | number][];
  overrides?: Record<string, number | string> | null;
  /** Variables supplied by the editor's Globals panel. */
  globals?: Record<string, number | string>;
  /** Content provider columns (live weather) instead of the sample ones. */
  columns?: Record<string, string[]>;
  url?: (f: FileInfo) => string;
}

/** Lay a parsed layout out and draw it: what the phone shows right now. */
export function buildScene(doc: Document, ord: Map<Element, number>, o: SceneOptions) {
  const root = doc.documentElement;
  const lock = root.tagName === 'Lockscreen';
  const sw = Number(root.getAttribute('screenWidth')) || 1080;
  const w = lock ? sw : Number(root.getAttribute('width')) || Number(root.getAttribute('w')) || sw;
  const h = lock ? Math.round(sw * o.phone) : o.aspect ? Math.round(w * o.aspect) : Number(root.getAttribute('height')) || Number(root.getAttribute('h')) || Math.round(sw * 0.46);
  const ctx: Ctx = { vars: systemVars(w, h, o.now), dir: o.dir, files: o.files, wallpaper: o.wallpaper, now: o.now, t: o.t, slot: o.slot, ord, unknown: new Set(), url: o.url };
  if (ctx.wallpaper) {
    ctx.vars.set('wall.bmp_width', ctx.wallpaper.width ?? w);
    ctx.vars.set('wall.bmp_height', ctx.wallpaper.height ?? h);
  }
  for (const [id, value] of o.config ?? []) ctx.vars.set(id, value);
  bindSampleData(root, ctx, o.columns);
  collectVars(root, ctx);
  // Variables the wake-up commands set, then everything that depends on them.
  if (runWakeCommands(root, ctx)) collectVars(root, ctx);
  if (o.globals) {
    for (const [name, value] of Object.entries(o.globals)) ctx.vars.set(name, value);
  }
  // A page or state picked in the editor (what a swipe or tap switches to on the phone).
  if (o.overrides) {
    for (const [name, value] of Object.entries(o.overrides)) ctx.vars.set(name, value);
  }
  if (o.globals || o.overrides) {
    collectVars(root, ctx);
    if (o.globals) {
      for (const [name, value] of Object.entries(o.globals)) ctx.vars.set(name, value);
    }
    if (o.overrides) {
      for (const [name, value] of Object.entries(o.overrides)) ctx.vars.set(name, value);
    }
  }
  const nodes = renderNodes(root, ctx);
  const hasWallpaper = lock && root.getElementsByTagName('Wallpaper').length > 0;
  return { w, h, lock, nodes, unknown: [...ctx.unknown], hasWallpaper, wallpaper: ctx.wallpaper, slot: o.slot, vars: ctx.vars };
}

/** Manifests of a part, the main one first (the lock screen's advance/manifest.xml). */
function partManifests(files: FileInfo[], componentId: string) {
  const list = files.filter((f) => f.component === componentId && /(^|\/|!\/)manifest\.xml$/i.test(f.path));
  const score = (f: FileInfo) => (/advance\/manifest\.xml$/i.test(f.path) ? 0 : 1) + f.path.split('/').length / 100;
  return list.sort((a, b) => score(a) - score(b));
}

/** The piece selected on the Lock screen page (shared with the side phone, which can pick one). */
export const useMamlSelection = create<{ path: string | null; ord: number | null; extra: number[] }>(() => ({ path: null, ord: null, extra: [] }));

/**
 * Parses a part's layout and builds the scene. Re-runs whenever the manifest
 * (saved or still being typed), any file it draws, the wallpaper or the clock
 * changes, so every edit shows straight away. `animate` plays the animations.
 */
export function useMamlScene(
  componentId: string,
  opts: {
    path?: string | null;
    slot?: Slot;
    animate?: boolean;
    ratio?: number;
    aspect?: number;
    overrides?: Record<string, number | string> | null;
    /** Draw a changed copy of the layout (a widget added for a look), never saved. */
    transform?: ((text: string) => string) | null;
    /** A fixed moment instead of the clock. */
    now?: Date;
    /** Content provider columns (live weather) instead of the sample ones. */
    columns?: Record<string, string[]>;
  } = {},
) {
  const slot = opts.slot ?? 'main';
  const snapshot = useStore((s) => (slot === 'ref' ? s.reference : s.project));
  const screen = useStore((s) => (s.selectedSerial ? (s.deviceDetails[s.selectedSerial]?.screenOverride ?? s.deviceDetails[s.selectedSerial]?.screen) : null));
  const projectFiles = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const manifests = useMemo(() => partManifests(projectFiles, componentId), [projectFiles, componentId]);
  const manifest = manifests.find((m) => m.path === opts.path) ?? manifests[0];
  const draft = useStore((s) => (slot === 'main' && manifest ? s.drafts[manifest.path]?.text : undefined));
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [t, setT] = useState(0);
  const globalTime = usePreviewGlobals((s) => s.timeMinutes);
  const globalVariables = usePreviewGlobals((s) => s.variables);
  const customVariables = usePreviewGlobals((s) => s.customVariables);
  const globalOverrides = useMemo(() => previewVariableOverrides(globalVariables, customVariables), [globalVariables, customVariables]);

  // Clock, and the animation clock when playing.
  useEffect(() => {
    if (opts.animate) {
      let raf = 0;
      let last = 0;
      const start = performance.now();
      const frame = (ts: number) => {
        if (ts - last > 33) {
          last = ts;
          setT(ts - start);
          setNow(new Date());
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(raf);
    }
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [opts.animate]);

  useEffect(() => {
    if (!manifest) {
      setSaved(null);
      return;
    }
    let cancelled = false;
    api
      .fileText(manifest.path, slot)
      .then((r) => {
        if (cancelled) return;
        setSaved(r.text.replace(/^﻿/, ''));
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [manifest?.path, manifest?.rev, slot]);

  // The theme's settings file next to the manifest (advance/config.xml).
  const configFile = useMemo(() => (manifest ? projectFiles.find((f) => f.path.toLowerCase() === manifest.path.replace(/manifest\.xml$/i, 'config.xml').toLowerCase()) : undefined), [manifest, projectFiles]);
  const [configText, setConfigText] = useState<string | null>(null);
  useEffect(() => {
    if (!configFile) return setConfigText(null);
    let cancelled = false;
    api
      .fileText(configFile.path, slot)
      .then((r) => !cancelled && setConfigText(r.text))
      .catch(() => !cancelled && setConfigText(null));
    return () => {
      cancelled = true;
    };
  }, [configFile?.path, configFile?.rev, slot]);
  const config = useMemo(() => configDefaults(configText), [configText]);

  const own = draft ?? saved;
  const transform = opts.transform;
  const shown = useMemo(() => (own !== null && transform ? transform(own) : own), [own, transform]);
  const text = own;
  const parsed = useMemo(() => {
    const text = shown;
    if (text === null) return null;
    let doc = new DOMParser().parseFromString(text, 'text/xml');
    // Draw what the phone draws: retry with the slips its parser forgives (a repeated attribute, a bare &).
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(lenientXml(text), 'text/xml');
    if (doc.querySelector('parsererror')) return { doc: null, elements: [] as Element[] };
    const elements = Array.from(doc.getElementsByTagName('*'));
    return { doc, elements, ord: new Map(elements.map((e, i) => [e, i])) };
  }, [shown]);
  // Keep the last good drawing while a half-typed edit is not valid XML.
  const lastGood = useRef<typeof parsed>(null);
  if (parsed?.doc) lastGood.current = parsed;
  const good = parsed?.doc ? parsed : lastGood.current;

  const files = useMemo(() => new Map(projectFiles.map((f) => [f.path, f])), [projectFiles]);
  const overrideKey = opts.overrides ? JSON.stringify(opts.overrides) : '';
  const overrides = useMemo(() => (overrideKey ? (JSON.parse(overrideKey) as Record<string, number | string>) : null), [overrideKey]);
  const pages = useMemo(() => findPages(good?.doc ?? null), [good]);
  const scene = useMemo(() => {
    if (!good?.doc || !manifest || !('ord' in good) || !good.ord) return null;
    const phone = opts.ratio && opts.ratio > 1 ? opts.ratio : screen && screen.width && screen.height ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height) : 20 / 9;
    return buildScene(good.doc, good.ord, { phone, aspect: opts.aspect, dir: manifest.path.replace(/manifest\.xml$/i, ''), files, wallpaper: findWallpaper(projectFiles, true), now: opts.now ?? previewDate(now, globalTime), t: opts.animate ? t : null, slot, config, globals: globalOverrides, overrides, columns: opts.columns });
  }, [good, manifest, files, now, opts.now, opts.columns, t, screen, projectFiles, opts.animate, opts.ratio, opts.aspect, slot, config, overrideKey, globalTime, globalOverrides]);

  /** Write a new manifest text: shown at once, then saved (undoable). */
  const apply = async (next: string) => {
    if (!manifest || slot !== 'main') return false;
    setSaved(next);
    return A.writeText(manifest.path, next);
  };

  return { manifests, manifest, scene, pages, config, error: parsed && !parsed.doc && !lastGood.current ? 'The manifest is not valid XML, so it cannot be drawn.' : error, text, elements: good?.elements ?? [], apply };
}

export type Scene = NonNullable<ReturnType<typeof useMamlScene>['scene']>;

// ---------- picking, outlines, resize and rotate on the canvas ----------

/** A box in layout (manifest) pixels. */
export interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}

/** What a drag on the canvas did, in manifest pixels. */
export type CanvasEdit =
  | { kind: 'move'; dx: number; dy: number; ords?: number[] }
  | { kind: 'resize'; sx: number; sy: number; fixed: { x: number; y: number }; box: Box; items?: { ord: number; box: Box }[] }
  | { kind: 'rotate'; delta: number; pivot: { x: number; y: number } }
  | { kind: 'delete'; ords: number[] };

/** Pieces whose size can be dragged (groups take their size from what is inside them). */
const RESIZABLE = new Set(['Image', 'Rectangle', 'Ellipse', 'Arc', 'Circle', 'Video', 'Text', 'DateTime', 'Time', 'ImageNumber']);
const UNIFORM = new Set(['Text', 'DateTime', 'Circle', 'Time', 'ImageNumber']);
/** Whether several selected pieces can be resized together, and if only proportionally. */
type GroupResize = 'none' | 'uniform' | 'free';
/** Drawn from fixed-size digit pictures: resized with MAML's `scale`, not w / h. */
const SCALED = new Set(['Time', 'ImageNumber']);

// Transparency of pictures, so a mostly-empty full-screen PNG is picked and
// outlined by what it shows, not by its whole size.
interface Mask {
  w: number;
  h: number;
  a: Uint8ClampedArray;
  bbox: { l: number; t: number; r: number; b: number };
}
const masks = new Map<string, Mask | 'loading' | 'none'>();
const maskWaiters = new Set<() => void>();

function maskFor(url: string): Mask | null {
  const known = masks.get(url);
  if (known && typeof known === 'object') return known;
  if (known) return null;
  masks.set(url, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const k = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k));
      const h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, w, h);
      const a = g.getImageData(0, 0, w, h).data;
      let l = w;
      let t = h;
      let r = -1;
      let b = -1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (a[(y * w + x) * 4 + 3] > 16) {
            if (x < l) l = x;
            if (x > r) r = x;
            if (y < t) t = y;
            if (y > b) b = y;
          }
      masks.set(url, r < 0 ? { w, h, a, bbox: { l: 0, t: 0, r: 0, b: 0 } } : { w, h, a, bbox: { l: l / w, t: t / h, r: (r + 1) / w, b: (b + 1) / h } });
    } catch {
      masks.set(url, 'none');
    }
    maskWaiters.forEach((f) => f());
  };
  img.onerror = () => masks.set(url, 'none');
  img.src = `${url}${url.includes('?') ? '&' : '?'}mask`;
  return null;
}

const srcOf = (node: HTMLElement) => (node.tagName === 'IMG' ? (node as HTMLImageElement).getAttribute('src') : null);

/** Is the picture solid at this screen point (with a little slack for thin strokes)? */
function solidAt(node: HTMLElement, x: number, y: number) {
  const src = srcOf(node);
  if (!src) return true;
  const m = maskFor(src);
  if (!m) return true;
  const r = node.getBoundingClientRect();
  const cx = Math.floor(((x - r.left) / r.width) * m.w);
  const cy = Math.floor(((y - r.top) / r.height) * m.h);
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px >= 0 && py >= 0 && px < m.w && py < m.h && m.a[(py * m.w + px) * 4 + 3] > 16) return true;
    }
  return false;
}

/** A node's layout position inside the canvas (transforms ignored), in manifest pixels. */
function layoutOrigin(node: HTMLElement, canvas: HTMLElement) {
  let x = 0;
  let y = 0;
  let el: HTMLElement | null = node;
  while (el && el !== canvas) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/** What a node visibly covers, in manifest pixels: transparent edges of pictures trimmed, groups as the union of their pieces. */
function visibleBox(node: HTMLElement, canvas: HTMLElement, scale: number, trim = true): Box | null {
  const c = canvas.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  if (r.width * r.height < 1) {
    let u: { l: number; t: number; r: number; b: number } | null = null;
    for (const child of Array.from(node.querySelectorAll<HTMLElement>('[data-mk]'))) {
      const b = child.getBoundingClientRect().width > 0 ? visibleBox(child, canvas, scale, trim) : null;
      if (!b || b.w * b.h < 1) continue;
      u = u ? { l: Math.min(u.l, b.l), t: Math.min(u.t, b.t), r: Math.max(u.r, b.l + b.w), b: Math.max(u.b, b.t + b.h) } : { l: b.l, t: b.t, r: b.l + b.w, b: b.t + b.h };
    }
    return u ? { l: u.l, t: u.t, w: u.r - u.l, h: u.b - u.t } : null;
  }
  const box = { l: (r.left - c.left) / scale, t: (r.top - c.top) / scale, w: r.width / scale, h: r.height / scale };
  const src = trim ? srcOf(node) : null;
  const m = src ? maskFor(src) : null;
  if (m && m.bbox.r > m.bbox.l) return { l: box.l + m.bbox.l * box.w, t: box.t + m.bbox.t * box.h, w: box.w * (m.bbox.r - m.bbox.l), h: box.h * (m.bbox.b - m.bbox.t) };
  return box;
}

/**
 * Every piece under a point, best first: visible pieces (text, clock,
 * pictures where they are not transparent) before full-screen layers,
 * invisible boxes (groups, unlock areas) and the wallpaper.
 */
function piecesRanked(canvas: HTMLElement, x: number, y: number) {
  const box = canvas.getBoundingClientRect();
  const full = box.width * box.height;
  const hits: { n: HTMLElement; see: boolean }[] = [];
  for (const el of document.elementsFromPoint(x, y)) {
    if (!canvas.contains(el) || (el as HTMLElement).closest('.maml-sel')) continue;
    const node = (el as HTMLElement).closest<HTMLElement>('[data-mk]');
    if (!node || !canvas.contains(node) || hits.some((h) => h.n === node)) continue;
    hits.push({ n: node, see: solidAt(el as HTMLElement, x, y) });
  }
  const rank = ({ n, see }: { n: HTMLElement; see: boolean }) => {
    const tag = n.dataset.mt ?? '';
    if (tag === 'Wallpaper') return 5;
    if (CONTAINERS.has(tag)) return 4;
    if (!see) return 3;
    const r = n.getBoundingClientRect();
    return r.width * r.height > full * 0.6 && !srcOf(n) ? 2 : 0;
  };
  return hits.map((h, i) => ({ h, i, r: rank(h) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => ({ n: x.h.n, r: x.r }));
}
const piecesAt = (canvas: HTMLElement, x: number, y: number) => piecesRanked(canvas, x, y).map((p) => p.n);

/** Pieces a drag-box selects: touched by it, or fully inside it for screen-sized layers. */
function piecesIn(canvas: HTMLElement, scale: number, w: number, h: number, m: Box) {
  const out: number[] = [];
  const full = w * h;
  for (const el of Array.from(canvas.querySelectorAll<HTMLElement>('[data-mk]'))) {
    const tag = el.dataset.mt ?? '';
    if (!DRAWABLE.has(tag) || tag === 'Wallpaper' || getComputedStyle(el).opacity === '0') continue;
    const b = visibleBox(el, canvas, scale);
    if (!b || b.w * b.h < 1) continue;
    const inside = b.l >= m.l && b.t >= m.t && b.l + b.w <= m.l + m.w && b.t + b.h <= m.t + m.h;
    const touches = b.l < m.l + m.w && b.l + b.w > m.l && b.t < m.t + m.h && b.t + b.h > m.t;
    if (b.w * b.h > full * 0.6 ? inside : touches) out.push(Number(el.dataset.mk));
  }
  return out;
}

function unionBox(list: (Box | null)[]): Box | null {
  let u: { l: number; t: number; r: number; b: number } | null = null;
  for (const b of list) {
    if (!b) continue;
    u = u ? { l: Math.min(u.l, b.l), t: Math.min(u.t, b.t), r: Math.max(u.r, b.l + b.w), b: Math.max(u.b, b.t + b.h) } : { l: b.l, t: b.t, r: b.l + b.w, b: b.t + b.h };
  }
  return u ? { l: u.l, t: u.t, w: u.r - u.l, h: u.b - u.t } : null;
}

const NO_EXTRA: number[] = [];

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Lines a dragged piece snaps to: the screen's edges and centre, and every other visible piece's edges and centre. */
interface Snaps {
  xs: number[];
  ys: number[];
}
function snapTargets(canvas: HTMLElement, node: HTMLElement | HTMLElement[], scale: number, w: number, h: number): Snaps {
  const moving = Array.isArray(node) ? node : [node];
  const xs = [0, w / 2, w];
  const ys = [0, h / 2, h];
  const full = w * h;
  for (const el of Array.from(canvas.querySelectorAll<HTMLElement>('[data-mk]'))) {
    if (moving.some((n) => el === n || el.contains(n) || n.contains(el))) continue;
    const tag = el.dataset.mt ?? '';
    if (tag === 'Wallpaper' || CONTAINERS.has(tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1) continue;
    const b = visibleBox(el, canvas, scale);
    if (!b || b.w * b.h < 1 || b.w * b.h > full * 0.6) continue;
    xs.push(b.l, b.l + b.w / 2, b.l + b.w);
    ys.push(b.t, b.t + b.h / 2, b.t + b.h);
  }
  return { xs, ys };
}
/** The smallest shift that puts one of `vals` on one of `lines`, if within `thr`. */
function snap1(vals: number[], lines: number[], thr: number) {
  let best = 0;
  let dist = thr;
  for (const v of vals)
    for (const t of lines) {
      const d = Math.abs(t - v);
      if (d < dist) {
        dist = d;
        best = t - v;
      }
    }
  return best;
}
/** Which snap lines a box now sits on. */
function guidesFor(b: Box, s: Snaps) {
  const on = (vals: number[], lines: number[]) => [...new Set(lines.filter((t) => vals.some((v) => Math.abs(v - t) < 0.5)))];
  return { x: on([b.l, b.l + b.w / 2, b.l + b.w], s.xs), y: on([b.t, b.t + b.h / 2, b.t + b.h], s.ys) };
}

type ResizePart = { ord: number; node: HTMLElement; origin: { x: number; y: number }; oldOrigin: string };

type DragState =
  | { kind: 'move'; ord: number; ords: number[]; nodes: HTMLElement[]; x: number; y: number; moved: boolean; box: Box | null; snaps: Snaps; dx: number; dy: number; click?: () => void }
  | { kind: 'marquee'; x: number; y: number; additive: boolean; base: number[]; moved: boolean; hits: number[]; click: () => void }
  | { kind: 'resize'; ord: number; parts: ResizePart[]; handle: Handle; x: number; y: number; box: Box; uniform: boolean; sx: number; sy: number; fixed: { x: number; y: number }; snaps: Snaps }
  | { kind: 'rotate'; ord: number; node: HTMLElement; cx: number; cy: number; start: number; delta: number; origin: { x: number; y: number }; oldOrigin: string };

/**
 * The scene drawn at its own size and scaled. With `onSelect`, clicking a piece
 * selects it; with `onEdit`, the selected piece can be dragged, resized and rotated.
 */
export function MamlCanvas({
  scene,
  scale,
  font,
  selected = null,
  extra = NO_EXTRA,
  onSelect,
  onSelectMany,
  onEdit,
  onContext,
  lift,
  moveOnly = false,
}: {
  scene: Scene;
  scale: number;
  font?: string;
  selected?: number | null;
  /** More selected pieces besides `selected` (drag-box or Shift+click). */
  extra?: number[];
  onSelect?: (ord: number | null) => void;
  /** Select several pieces at once; the first one is shown in the inspector. */
  onSelectMany?: (ords: number[]) => void;
  onEdit?: (ord: number, edit: CanvasEdit) => void;
  /** Right-click: the pieces it is about (the selection, or the piece under the pointer) and where they sit on the screen. */
  onContext?: (ords: number[], box: { x: number; y: number; w: number; h: number } | null, e: React.MouseEvent) => void;
  /**
   * The piece a click on `ord` picks: the group it was grouped into, unless the
   * selection is already inside that group. With `deep` (a double-click), one level in.
   */
  lift?: (ord: number, deep?: boolean) => number;
  /** Pieces can be picked and moved, not resized or turned (the Guide's try-out phones). */
  moveOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  // Clicking the same spot again goes one piece deeper (what is underneath).
  const lastClick = useRef<{ x: number; y: number; ords: number[]; at: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box | null; hover: Box | null; tag: string; items: Box[]; groupResize: GroupResize }>({ sel: null, hover: null, tag: '', items: [], groupResize: 'none' });
  const [marquee, setMarquee] = useState<{ box: Box; hits: Box[] } | null>(null);
  const all = selected === null ? extra : [selected, ...extra.filter((o) => o !== selected)];
  const multi = all.length > 1;
  const [, setMaskTick] = useState(0);
  const [live, setLive] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] } | null>(null);
  const editable = !!onSelect;
  const up = (o: number, deep = false) => (lift ? lift(o, deep) : o);
  /** Lifted pieces in order, each once. */
  const upAll = (ords: number[], deep = false) => [...new Set(ords.map((o) => up(o, deep)))];

  useEffect(() => {
    if (!editable) return;
    const wake = () => setMaskTick((n) => n + 1);
    maskWaiters.add(wake);
    return () => void maskWaiters.delete(wake);
  }, [editable]);

  // Measure the outlines after every draw (pieces move with animations and edits).
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!editable || !canvas) return;
    const find = (ord: number | null) => (ord === null ? null : canvas.querySelector<HTMLElement>(`[data-mk="${ord}"]`));
    const box = (ord: number) => {
      const n = find(ord);
      return n ? visibleBox(n, canvas, scale) : null;
    };
    const selNode = find(selected);
    const items = multi ? all.map(box).filter((b): b is Box => !!b) : [];
    const sel = multi ? unionBox(items) : selNode ? visibleBox(selNode, canvas, scale) : null;
    const hov = hover !== null && !all.includes(hover) ? find(hover) : null;
    const hb = hov ? visibleBox(hov, canvas, scale) : null;
    const tag = multi ? '' : (selNode?.dataset.mt ?? '');
    // Several pieces resize together when every one of them can be resized.
    const tags = multi ? all.map((o) => find(o)?.dataset.mt ?? '') : [];
    const groupResize: GroupResize = !multi || !tags.every((t) => RESIZABLE.has(t)) ? 'none' : tags.some((t) => UNIFORM.has(t) || t === 'Image' || t === 'Video') ? 'uniform' : 'free';
    const same = (a: Box | null, b: Box | null) => (!a && !b) || (!!a && !!b && Math.abs(a.l - b.l) + Math.abs(a.t - b.t) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) < 0.5);
    const sameItems = items.length === boxes.items.length && items.every((b, i) => same(b, boxes.items[i]));
    if (!same(sel, boxes.sel) || !same(hb, boxes.hover) || tag !== boxes.tag || !sameItems || groupResize !== boxes.groupResize) setBoxes({ sel, hover: hb, tag, items, groupResize });
  });

  const nodeOf = (ord: number) => ref.current?.querySelector<HTMLElement>(`[data-mk="${ord}"]`) ?? null;

  // Esc clears the selection, Delete removes the selected pieces, arrow keys nudge them (Shift: 10 px).
  useEffect(() => {
    if (!onEdit || !onSelectMany) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!all.length || !ref.current?.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && t !== document.body && (!t.closest('.maml, .maml-movable') || t.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return;
      const step = e.shiftKey ? 10 : 1;
      const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Escape') {
        e.preventDefault();
        onSelect?.(null);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        onEdit(all[0], { kind: 'delete', ords: all });
      } else if (dir[e.key]) {
        e.preventDefault();
        onEdit(all[0], { kind: 'move', dx: dir[e.key][0], dy: dir[e.key][1], ords: all });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Right-button drag on a handle moves the selection, so tiny pieces covered by their handles can still be dragged. */
  const rightDrag = useRef(false);
  const handleMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    rightDrag.current = true;
    const canvas = ref.current;
    if (!canvas || !onEdit) return;
    const nodes = all.map(nodeOf).filter((n): n is HTMLElement => !!n);
    if (!nodes.length) return;
    drag.current = { kind: 'move', ord: all[0], ords: all, nodes, x: e.clientX, y: e.clientY, moved: false, box: unionBox(nodes.map((n) => visibleBox(n, canvas, scale))), snaps: snapTargets(canvas, nodes, scale, scene.w, scene.h), dx: 0, dy: 0 };
    canvas.setPointerCapture(e.pointerId);
  };
  const handleDown = (e: React.PointerEvent, left: () => void) => {
    if (e.button === 2) handleMove(e);
    else if (e.button === 0) left();
    else e.stopPropagation();
  };
  // No context menu after a right-drag on a handle.
  const noMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const startResize = (handle: Handle, e: React.PointerEvent) => {
    e.stopPropagation();
    const canvas = ref.current;
    if (selected === null || !canvas || !boxes.sel) return;
    const parts: ResizePart[] = [];
    for (const ord of all) {
      const node = nodeOf(ord);
      if (node) parts.push({ ord, node, origin: layoutOrigin(node, canvas), oldOrigin: node.style.transformOrigin });
    }
    if (!parts.length) return;
    const first = parts[0].node;
    // Corner handles keep the proportions (Shift: free); text, circles, pictures and digit clocks always do.
    const uniform = multi
      ? boxes.groupResize === 'uniform' || (handle.length === 2 && !e.shiftKey)
      : UNIFORM.has(first.dataset.mt ?? '') || (handle.length === 2 && !e.shiftKey && !!srcOf(first));
    const nodes = parts.map((p) => p.node);
    drag.current = { kind: 'resize', ord: selected, parts, handle, x: e.clientX, y: e.clientY, box: boxes.sel, uniform, sx: 1, sy: 1, fixed: { x: 0, y: 0 }, snaps: snapTargets(canvas, nodes.length > 1 ? nodes : first, scale, scene.w, scene.h) };
    canvas.setPointerCapture(e.pointerId);
  };
  const startRotate = (e: React.PointerEvent) => {
    e.stopPropagation();
    const canvas = ref.current;
    if (selected === null || !canvas || !boxes.sel) return;
    const node = nodeOf(selected);
    if (!node) return;
    const c = canvas.getBoundingClientRect();
    const cx = boxes.sel.l + boxes.sel.w / 2;
    const cy = boxes.sel.t + boxes.sel.h / 2;
    const at = (Math.atan2((e.clientY - c.top) / scale - cy, (e.clientX - c.left) / scale - cx) * 180) / Math.PI;
    drag.current = { kind: 'rotate', ord: selected, node, cx, cy, start: at, delta: 0, origin: layoutOrigin(node, canvas), oldOrigin: node.style.transformOrigin };
    canvas.setPointerCapture(e.pointerId);
  };

  const hoverFrame = useRef(0);
  const sel = boxes.sel;
  const inv = 1 / scale;
  const canResize = !moveOnly && (multi ? boxes.groupResize !== 'none' : RESIZABLE.has(boxes.tag));
  const edgeHandles = multi ? boxes.groupResize === 'free' : !UNIFORM.has(boxes.tag);

  return (
    <div
      ref={ref}
      className={`maml-canvas ${editable ? 'is-edit' : ''}`}
      style={{ width: scene.w, height: scene.h, transform: `scale(${scale})`, fontFamily: font }}
      onContextMenu={
        onContext
          ? (e) => {
              e.preventDefault();
              const canvas = ref.current;
              if (rightDrag.current) {
                rightDrag.current = false;
                return;
              }
              if (!canvas) return;
              const ranked = piecesRanked(canvas, e.clientX, e.clientY);
              const under = upAll(ranked.map((p) => Number(p.n.dataset.mk)));
              const top = ranked.length && ranked[0].r < 2 ? under[0] : null;
              let ords = all;
              if (!under.some((o) => all.includes(o)) && top !== null) {
                ords = [top];
                onSelect?.(top);
              }
              onContext(ords, measurePieces(canvas, ords, scale), e);
            }
          : undefined
      }
      onPointerDown={
        editable
          ? (e) => {
              if (e.button !== 0) return;
              const canvas = e.currentTarget as HTMLElement;
              const ranked = piecesRanked(canvas, e.clientX, e.clientY);
              const raw = ranked.map((p) => Number(p.n.dataset.mk));
              const ords = upAll(raw);
              const additive = e.shiftKey || e.ctrlKey || e.metaKey;
              // Nothing visible under the pointer: groups, transparent pixels, the wallpaper.
              const empty = !ranked.length || ranked[0].r >= 2;
              const chosen = new Set(all);
              const startMove = (moveOrds: number[], click?: () => void) => {
                const nodes = moveOrds.map(nodeOf).filter((n): n is HTMLElement => !!n);
                if (!nodes.length || !onEdit) return click?.();
                // Measure now: boxes.sel may still be the previous selection.
                drag.current = { kind: 'move', ord: moveOrds[0], ords: moveOrds, nodes, x: e.clientX, y: e.clientY, moved: false, box: unionBox(nodes.map((n) => visibleBox(n, canvas, scale))), snaps: snapTargets(canvas, nodes, scale, scene.w, scene.h), dx: 0, dy: 0, click };
                canvas.setPointerCapture(e.pointerId);
              };
              // A plain click: pick the top piece, or the next one down when clicking the same spot again.
              const pick = () => {
                const last = lastClick.current;
                const again = !!last && Math.abs(last.x - e.clientX) < 4 && Math.abs(last.y - e.clientY) < 4 && last.ords.join() === ords.join();
                lastClick.current = { x: e.clientX, y: e.clientY, ords, at: e.timeStamp };
                // Double-clicking a group picks the piece inside it.
                if (again && e.timeStamp - last!.at < 450 && !empty && selected === ords[0]) {
                  const deeper = up(raw[0], true);
                  if (deeper !== ords[0]) return deeper;
                }
                let index = 0;
                if (again && selected !== null && ords.includes(selected)) index = (ords.indexOf(selected) + 1) % ords.length;
                return ords[index] ?? null;
              };

              if (onSelectMany && additive && !empty) {
                // Shift/Ctrl+click adds the piece to the selection, or takes it out.
                const o = ords[0];
                onSelectMany(chosen.has(o) ? all.filter((x) => x !== o) : [...all, o]);
                return;
              }
              const grabbed = ords.find((o) => chosen.has(o));
              const full = scene.w * scene.h;
              const grabbable = (o: number) => {
                const n = nodeOf(o);
                const b = n ? visibleBox(n, canvas, scale) : null;
                return !!n && n.dataset.mt !== 'Wallpaper' && !!b && b.w * b.h <= full * 0.6;
              };
              if (multi && grabbed !== undefined && (!empty ? chosen.has(ords[0]) : grabbable(grabbed))) {
                // Drag the whole selection; a click without moving keeps just that piece.
                startMove(all, () => onSelect!(empty ? grabbed : ords[0]));
                return;
              }
              if (onSelectMany && empty && !(grabbed !== undefined && grabbable(grabbed))) {
                // Drag a box to select several pieces; a click without moving picks as before.
                const c = canvas.getBoundingClientRect();
                drag.current = {
                  kind: 'marquee',
                  x: (e.clientX - c.left) / scale,
                  y: (e.clientY - c.top) / scale,
                  additive,
                  base: all,
                  moved: false,
                  hits: [],
                  click: () => (additive ? undefined : onSelect!(pick())),
                };
                canvas.setPointerCapture(e.pointerId);
                return;
              }
              if (empty && grabbed !== undefined) {
                // Pressing inside the selected piece's empty area still drags it.
                startMove([grabbed], () => onSelect!(pick()));
                return;
              }
              const ord = pick();
              onSelect!(ord);
              if (ord !== null) startMove([ord]);
            }
          : undefined
      }
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) {
          if (!editable) return;
          const canvas = e.currentTarget as HTMLElement;
          const { clientX, clientY } = e;
          cancelAnimationFrame(hoverFrame.current);
          hoverFrame.current = requestAnimationFrame(() => {
            const top = piecesAt(canvas, clientX, clientY)[0];
            const tag = top?.dataset.mt ?? '';
            const seen = top && (!srcOf(top) || solidAt(top, clientX, clientY));
            setHover(top && seen && !CONTAINERS.has(tag) && tag !== 'Wallpaper' ? up(Number(top.dataset.mk)) : null);
          });
          return;
        }
        if (d.kind === 'marquee') {
          const c = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = (e.clientX - c.left) / scale;
          const y = (e.clientY - c.top) / scale;
          if (!d.moved && Math.abs(x - d.x) + Math.abs(y - d.y) < 4 / scale) return;
          d.moved = true;
          const box = { l: Math.min(x, d.x), t: Math.min(y, d.y), w: Math.abs(x - d.x), h: Math.abs(y - d.y) };
          const canvas = e.currentTarget as HTMLElement;
          d.hits = upAll(piecesIn(canvas, scale, scene.w, scene.h, box));
          setHover(null);
          setMarquee({
            box,
            hits: d.hits.map((o) => {
              const n = nodeOf(o);
              return n ? visibleBox(n, canvas, scale) : null;
            }).filter((b): b is Box => !!b),
          });
          return;
        }
        // Snap within 6 screen pixels when align lines are on; Alt does the opposite for this drag.
        const thr = useAlignLines.getState().on !== e.altKey ? 6 / scale : 0;
        if (d.kind === 'move') {
          let dx = (e.clientX - d.x) / scale;
          let dy = (e.clientY - d.y) / scale;
          if (Math.abs(dx) + Math.abs(dy) > 3 / scale) d.moved = true;
          if (d.moved) {
            const b = d.box;
            if (b) {
              dx += snap1([b.l + dx, b.l + b.w / 2 + dx, b.l + b.w + dx], d.snaps.xs, thr);
              dy += snap1([b.t + dy, b.t + b.h / 2 + dy, b.t + b.h + dy], d.snaps.ys, thr);
            }
            d.dx = dx;
            d.dy = dy;
            for (const n of d.nodes) n.style.translate = `${dx}px ${dy}px`;
            if (b) {
              const nb = { ...b, l: b.l + dx, t: b.t + dy };
              setLive(nb);
              setGuides(thr ? guidesFor(nb, d.snaps) : null);
            }
          }
        } else if (d.kind === 'resize') {
          const dx = (e.clientX - d.x) / scale;
          const dy = (e.clientY - d.y) / scale;
          const b = d.box;
          let l = b.l;
          let t = b.t;
          let r = b.l + b.w;
          let bt = b.t + b.h;
          if (d.handle.includes('w')) l += dx + snap1([l + dx], d.snaps.xs, thr);
          if (d.handle.includes('e')) r += dx + snap1([r + dx], d.snaps.xs, thr);
          if (d.handle.includes('n')) t += dy + snap1([t + dy], d.snaps.ys, thr);
          if (d.handle.includes('s')) bt += dy + snap1([bt + dy], d.snaps.ys, thr);
          let sx = Math.max(4, r - l) / b.w;
          let sy = Math.max(4, bt - t) / b.h;
          if (!d.handle.includes('w') && !d.handle.includes('e')) sx = d.uniform ? sy : 1;
          if (!d.handle.includes('n') && !d.handle.includes('s')) sy = d.uniform ? sx : 1;
          if (d.uniform && d.handle.length === 2) sx = sy = (sx + sy) / 2;
          const fx = d.handle.includes('w') ? b.l + b.w : d.handle.includes('e') ? b.l : b.l + b.w / 2;
          const fy = d.handle.includes('n') ? b.t + b.h : d.handle.includes('s') ? b.t : b.t + b.h / 2;
          d.sx = sx;
          d.sy = sy;
          d.fixed = { x: fx, y: fy };
          for (const part of d.parts) {
            part.node.style.transformOrigin = `${fx - part.origin.x}px ${fy - part.origin.y}px`;
            part.node.style.scale = `${sx} ${sy}`;
          }
          const nb = { l: fx + (b.l - fx) * sx, t: fy + (b.t - fy) * sy, w: b.w * sx, h: b.h * sy };
          setLive(nb);
          setGuides(thr ? guidesFor(nb, d.snaps) : null);
        } else {
          const c = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const at = (Math.atan2((e.clientY - c.top) / scale - d.cy, (e.clientX - c.left) / scale - d.cx) * 180) / Math.PI;
          let delta = at - d.start;
          if (e.shiftKey) delta = Math.round(delta / 15) * 15;
          d.delta = delta;
          d.node.style.transformOrigin = `${d.cx - d.origin.x}px ${d.cy - d.origin.y}px`;
          d.node.style.rotate = `${delta}deg`;
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setLive(null);
        setGuides(null);
        setMarquee(null);
        if (!d) return;
        if (d.kind === 'marquee') {
          if (!d.moved) d.click();
          else onSelectMany!(d.additive ? [...d.base, ...d.hits.filter((o) => !d.base.includes(o))] : d.hits);
        } else if (d.kind === 'move') {
          for (const n of d.nodes) n.style.translate = '';
          if (!d.moved) d.click?.();
          else if (Math.round(d.dx) || Math.round(d.dy)) onEdit!(d.ord, { kind: 'move', dx: Math.round(d.dx), dy: Math.round(d.dy), ords: d.ords });
        } else if (d.kind === 'resize') {
          for (const part of d.parts) {
            part.node.style.scale = '';
            part.node.style.transformOrigin = part.oldOrigin;
          }
          if (Math.abs(d.sx - 1) > 0.002 || Math.abs(d.sy - 1) > 0.002) {
            const canvas = ref.current!;
            const items = d.parts.map((part) => ({ ord: part.ord, box: visibleBox(part.node, canvas, scale, false) ?? d.box }));
            onEdit!(d.ord, { kind: 'resize', sx: d.sx, sy: d.sy, fixed: d.fixed, box: items[0].box, items: items.length > 1 ? items : undefined });
          }
        } else {
          d.node.style.rotate = '';
          d.node.style.transformOrigin = d.oldOrigin;
          if (Math.abs(d.delta) > 0.5) onEdit!(d.ord, { kind: 'rotate', delta: d.delta, pivot: { x: Math.round(d.cx - d.origin.x), y: Math.round(d.cy - d.origin.y) } });
        }
      }}
      onPointerLeave={() => !drag.current && setHover(null)}
    >
      {scene.lock && !scene.hasWallpaper && scene.wallpaper && (
        <img src={resourceUrl(scene.slot, scene.wallpaper.path, scene.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} draggable={false} />
      )}
      {scene.nodes}
      {editable && boxes.hover && !drag.current && <div className="maml-hover" style={{ left: boxes.hover.l, top: boxes.hover.t, width: boxes.hover.w, height: boxes.hover.h, borderWidth: 1.5 * inv }} />}
      {guides?.x.map((x) => <div key={`x${x}`} className={`maml-guide is-v ${Math.abs(x - scene.w / 2) < 0.5 ? 'is-mid' : ''}`} style={{ left: x, borderLeftWidth: inv }} />)}
      {guides?.y.map((y) => <div key={`y${y}`} className={`maml-guide is-h ${Math.abs(y - scene.h / 2) < 0.5 ? 'is-mid' : ''}`} style={{ top: y, borderTopWidth: inv }} />)}
      {editable && multi && boxes.items.map((b, i) => <div key={i} className="maml-sel-item" style={{ left: b.l, top: b.t, width: b.w, height: b.h, borderWidth: 1.5 * inv }} />)}
      {marquee?.hits.map((b, i) => <div key={`m${i}`} className="maml-sel-item" style={{ left: b.l, top: b.t, width: b.w, height: b.h, borderWidth: 1.5 * inv }} />)}
      {marquee && <div className="maml-marquee" style={{ left: marquee.box.l, top: marquee.box.t, width: marquee.box.w, height: marquee.box.h, borderWidth: inv }} />}
      {editable && (live ?? sel) && (
        <div className={`maml-sel ${multi ? 'is-group' : ''}`} style={{ left: (live ?? sel)!.l, top: (live ?? sel)!.t, width: (live ?? sel)!.w, height: (live ?? sel)!.h, borderWidth: (multi ? 1 : 2) * inv, ['--inv' as string]: inv }}>
          {multi && !live && <span className="maml-count">{all.length}</span>}
          {onEdit && !live && (
            <>
              {canResize && HANDLES.filter((h) => edgeHandles || h.length === 2).map((h) => <span key={h} className={`maml-h h-${h}`} onPointerDown={(e) => handleDown(e, () => startResize(h, e))} onContextMenu={noMenu} />)}
              {!multi && !moveOnly && <span className="maml-rot" title="Drag to rotate (Shift: 15° steps) · right-drag to move" onPointerDown={(e) => handleDown(e, () => startRotate(e))} onContextMenu={noMenu} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The theme's real lock screen for the phone mock-ups, filling a screen of
 * `width` × `height`, animations playing. `onPick` makes its pieces clickable.
 */
export function PhoneLockScreen({ width, height, font, onPick, page }: { width: number; height: number; font?: string; onPick?: (path: string, ord: number | null) => void; page?: { name: string; value: number } | null }) {
  // Lay the layout out for this screen's shape, as the phone does (screen_height follows the aspect ratio).
  const { scene, manifest } = useMamlScene('lockscreen', { animate: true, ratio: width ? Math.round((height / width) * 1e4) / 1e4 : undefined, overrides: page ? { [page.name]: page.value } : null });
  if (!scene || !scene.lock || !width) return null;
  const scale = Math.max(width / scene.w, height / scene.h);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} className={onPick ? 'pp-pickable' : undefined}>
      <div style={{ position: 'absolute', left: (width - scene.w * scale) / 2, top: (height - scene.h * scale) / 2 }}>
        <MamlCanvas scene={scene} scale={scale} font={font} onSelect={onPick && manifest ? (ord) => onPick(manifest.path, ord) : undefined} />
      </div>
    </div>
  );
}

/** Another page of the lock screen, small and read-only; clicking it edits that page. */
function LockPageThumb({ path, page, label, scale, font, onOpen }: { path: string; page: { name: string; value: number }; label: string; scale: number; font?: string; onOpen: () => void }) {
  const { scene } = useMamlScene('lockscreen', { path, overrides: { [page.name]: page.value } });
  if (!scene || !scale) return null;
  return (
    <button type="button" className="maml-page-thumb" onClick={onOpen} title={`Edit ${label}`}>
      <div className="maml-frame is-phone is-small" style={{ width: scene.w * scale, height: scene.h * scale, pointerEvents: 'none' }}>
        <MamlCanvas scene={scene} scale={scale} font={font} />
      </div>
      <span>{label}</span>
    </button>
  );
}

/** The theme's 4x2 clock widget (clock_2x4), if it has one. */
export function useClockWidgetPath() {
  return useStore((s) => {
    const files = s.project?.files ?? [];
    const exact = files.find((f) => f.component === 'widgets' && /^clock_2x4!\/manifest\.xml$/i.test(f.path));
    return (exact ?? files.find((f) => f.component === 'widgets' && /^clock_2x4!\/.*manifest\.xml$/i.test(f.path)))?.path ?? null;
  });
}

/** A home screen widget's layout drawn into its cells (`width` x `height` on screen). */
export function PhoneWidget({ path, width, height, font }: { path: string; width: number; height: number; font?: string }) {
  const { scene } = useMamlScene('widgets', { path, aspect: width ? height / width : undefined });
  if (!scene || scene.lock || !width) return null;
  return <MamlCanvas scene={scene} scale={width / scene.w} font={font} />;
}

/** A part's layout scaled to fit its box (Swap dialog previews), main or reference package. */
export function MamlFit({ componentId, slot = 'main' }: { componentId: string; slot?: Slot }) {
  const { scene } = useMamlScene(componentId, { slot });
  const snapshot = useStore((s) => (slot === 'ref' ? s.reference : s.project));
  const font = usePackageFont(useMemo(() => themeFontFile(snapshot?.files ?? []), [snapshot]), slot).family ?? undefined;
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // clientWidth/Height include the 10px padding on each side.
  const scale = scene && fit.w > 20 && fit.h > 20 ? Math.min((fit.w - 20) / scene.w, (fit.h - 20) / scene.h) : 0;
  return (
    <div ref={box} className="maml-fit">
      {scene && scale > 0 ? (
        <div className={`maml-frame ${scene.lock ? 'is-phone is-small' : ''}`} style={{ width: scene.w * scale, height: scene.h * scale }}>
          <MamlCanvas scene={scene} scale={scale} font={font} />
        </div>
      ) : (
        <Loader2 className="spin" />
      )}
    </div>
  );
}

/**
 * The theme's own lock screen (wallpaper, font and all) with something added on
 * top just for a look, fitted into its box. Nothing is saved. Shows `fallback`
 * when the theme has no lock screen layout yet.
 */
export function ThemePhone({
  transform,
  now,
  overrides,
  columns,
  fallback,
  pick,
}: {
  transform: (text: string) => string;
  now?: Date;
  columns?: Record<string, string[]>;
  overrides?: Record<string, number | string> | null;
  fallback?: ReactNode;
  /** Lets pieces be picked and dragged: the canvas props for this layout's elements. */
  pick?: (elements: Element[]) => Partial<Parameters<typeof MamlCanvas>[0]>;
}) {
  const has = useHasLockLayout();
  const { scene, elements } = useMamlScene('lockscreen', { transform, now, overrides, columns });
  const project = useStore((s) => s.project);
  const font = usePackageFont(useMemo(() => themeFontFile(project?.files ?? []), [project])).family ?? undefined;
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = scene && fit.w > 0 && fit.h > 0 ? Math.min(fit.w / scene.w, fit.h / scene.h) : 0;
  return (
    <div ref={box} className="theme-phone">
      {!has ? (
        fallback
      ) : scene && scale > 0 ? (
        <div className={`maml-frame is-phone is-small ${pick ? 'maml-movable' : ''}`} style={{ width: scene.w * scale, height: scene.h * scale }}>
          <MamlCanvas scene={scene} scale={scale} font={font} {...pick?.(elements)} />
        </div>
      ) : (
        <Loader2 className="spin" />
      )}
    </div>
  );
}

/**
 * The open theme's lock screen as Try it sees it: its folder and files (so
 * src="sj.png" finds the theme's picture) and the variables its layout works
 * out (#qq, #AQI…), so lines pasted from it read the same values.
 */
export function useThemeLock(now?: Date, columns?: Record<string, string[]>) {
  const project = useStore((s) => s.project);
  const list = useMemo(() => project?.files ?? [], [project]);
  const manifest = useMemo(() => partManifests(list, 'lockscreen')[0] ?? null, [list]);
  const dir = manifest ? manifest.path.replace(/manifest\.xml$/i, '') : '';
  const files = useMemo(() => new Map(list.map((f) => [f.path, f])), [list]);
  const { scene } = useMamlScene('lockscreen', { now, columns });
  const vars = useMemo(() => {
    const out: Record<string, number | string> = {};
    if (!scene?.vars) return out;
    const system = systemVars(1080, 2400, new Date());
    for (const [k, v] of scene.vars) if (!system.has(k) && !k.startsWith('wall.')) out[k] = v;
    return out;
  }, [scene]);
  const find = useCallback((src: string) => (manifest && src ? fileFor({ dir, files }, src) : undefined), [manifest, dir, files]);
  return { manifest: manifest?.path ?? null, dir, files, vars, find };
}

/** True when the theme has a lock screen layout the phone mock-ups can draw. */
export function useHasLockLayout() {
  return useStore((s) => !!s.project?.files.some((f) => f.component === 'lockscreen' && /(^|\/|!\/)manifest\.xml$/i.test(f.path)));
}

/** New attributes for one piece scaled by sx / sy about the point p; e is its box before. */
function resizeAttrs(el: Element, vars: Vars, sx: number, sy: number, p: { x: number; y: number }, e: Box): Record<string, string | null> {
  const tag = el.tagName;
  const next = { l: p.x + (e.l - p.x) * sx, t: p.y + (e.t - p.y) * sy, w: e.w * sx, h: e.h * sy };
  if (SCALED.has(tag)) return scaleAttrs(el, vars, sx, e, next);
  const centered = tag === 'Circle';
  const align = centered ? 'center' : (el.getAttribute('align') ?? 'left');
  const alignV = centered ? 'center' : (el.getAttribute('alignV') ?? 'top');
  const ax = (b: Box) => (align === 'center' ? b.l + b.w / 2 : align === 'right' ? b.l + b.w : b.l);
  const ay = (b: Box) => (alignV === 'center' ? b.t + b.h / 2 : alignV === 'bottom' ? b.t + b.h : b.t);
  const dx = Math.round(ax(next) - ax(e));
  const dy = Math.round(ay(next) - ay(e));
  const attrs: Record<string, string | null> = {};
  if (dx) attrs.x = nudge(el.getAttribute('x'), dx);
  if (dy) attrs.y = nudge(el.getAttribute('y'), dy);
  const scaled = (name: string, alt: string | null, f: number, fallback: number) => {
    const n = alt && el.hasAttribute(alt) && !el.hasAttribute(name) ? alt : name;
    const cur = el.getAttribute(n)?.trim() ?? '';
    attrs[n] = !cur ? String(Math.round(fallback * f)) : /^-?\d+(\.\d+)?$/.test(cur) ? String(Math.round(Number(cur) * f)) : `(${cur})*${+f.toFixed(4)}`;
  };
  if (tag === 'Text' || tag === 'DateTime') scaled('size', null, sy, 18);
  else if (tag === 'Circle') scaled('r', null, sx, e.w / 2);
  else {
    if (Math.abs(sx - 1) > 0.002) scaled('w', 'width', sx, e.w);
    if (Math.abs(sy - 1) > 0.002) scaled('h', 'height', sy, e.h);
  }
  return attrs;
}

/**
 * Resize a digit-picture piece with `scale`. The phone scales about pivotX / pivotY
 * (the element's top-left by default), so a pivot at the align point is stored when
 * there is none, and x / y are moved so the box lands where it was dragged to.
 */
function scaleAttrs(el: Element, vars: Vars, f: number, e: Box, next: Box): Record<string, string | null> {
  const old = el.hasAttribute('scale') ? evalNumber(el.getAttribute('scale'), vars, 1) || 1 : 1;
  const cur = el.getAttribute('scale')?.trim() ?? '';
  const now = old * f;
  const attrs: Record<string, string | null> = {
    scale: !cur || /^-?\d+(\.\d+)?$/.test(cur) ? String(Math.round(now * 1000) / 1000) : `(${cur})*${+f.toFixed(4)}`,
  };
  // Unscaled size, and where x / y sit in it (align / alignV).
  const w = e.w / old;
  const h = e.h / old;
  const fa = { left: 0, center: 0.5, right: 1 }[el.getAttribute('align') ?? 'left'] ?? 0;
  const fv = { top: 0, center: 0.5, bottom: 1 }[el.getAttribute('alignV') ?? 'top'] ?? 0;
  let px: number;
  let py: number;
  if (el.hasAttribute('pivotX') || el.hasAttribute('pivotY')) {
    px = evalNumber(el.getAttribute('pivotX'), vars);
    py = evalNumber(el.getAttribute('pivotY'), vars);
  } else {
    px = Math.round(fa * w);
    py = Math.round(fv * h);
    attrs.pivotX = String(px);
    attrs.pivotY = String(py);
  }
  // Visible left = x - fa·w + px·(1 - scale); solve for the x that puts it at next.l.
  const x = evalNumber(el.getAttribute('x'), vars);
  const y = evalNumber(el.getAttribute('y'), vars);
  const dx = Math.round(next.l + fa * w - px * (1 - now) - x);
  const dy = Math.round(next.t + fv * h - py * (1 - now) - y);
  if (dx) attrs.x = nudge(el.getAttribute('x'), dx);
  if (dy) attrs.y = nudge(el.getAttribute('y'), dy);
  return attrs;
}

// ---------- align lines ----------

const ALIGN_KEY = 'mts.alignLines.v1';
function loadAlign() {
  try {
    return localStorage.getItem(ALIGN_KEY) !== '0';
  } catch {
    return true;
  }
}
/** Snap to other pieces and the screen's edges and middle while dragging, with lines showing it. Shared by every editable phone. */
export const useAlignLines = create<{ on: boolean }>(() => ({ on: loadAlign() }));
export function setAlignLines(on: boolean) {
  useAlignLines.setState({ on });
  try {
    localStorage.setItem(ALIGN_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/** The on/off button for align lines. */
export function AlignToggle({ small = true }: { small?: boolean }) {
  const on = useAlignLines((s) => s.on);
  return (
    <button className={`btn ${small ? 'btn-sm' : ''}`} aria-pressed={on} onClick={() => setAlignLines(!on)} title={on ? 'Pieces snap to each other and to the screen’s edges and middle, with lines showing it. Click to drag freely (or hold Alt).' : 'Pieces move freely. Click to snap them into line with each other and the screen (or hold Alt while dragging).'}>
      <AlignCenterVertical /> Align lines
    </button>
  );
}

/** Groups made with Group (Ctrl+G): a click on any piece in one picks the whole group. */
const GROUP_NAME = /^mts_group_\d+$/;
export const isUserGroup = (el: Element | undefined | null) => !!el && el.tagName === 'Group' && GROUP_NAME.test(el.getAttribute('name') ?? '');

/** Add a pixel offset to an x/y value, keeping formulas as formulas. */
export function nudge(value: string | null, d: number) {
  const v = (value ?? '0').trim() || '0';
  if (/^-?\d+(\.\d+)?$/.test(v)) return String(Math.round(Number(v) + d));
  const m = /^(.*?)\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (m) {
    const n = (m[2] === '-' ? -1 : 1) * Number(m[3]) + d;
    return n === 0 ? m[1] : `${m[1]}${n < 0 ? '-' : '+'}${Math.abs(Math.round(n))}`;
  }
  return d < 0 ? `${v}-${Math.abs(d)}` : `${v}+${d}`;
}

export function MamlPreview({ componentId }: { componentId: string }) {
  const project = useStore((s) => s.project)!;
  const [path, setPath] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // The page being edited, for lock screens a swipe or tap switches between.
  const [page, setPage] = useState<{ name: string; value: number } | null>(null);
  // Show the layout as while charging (battery_state 1), for charging rings and the like.
  const [charging, setCharging] = useState(false);
  const overrides = page || charging ? { ...(page ? { [page.name]: page.value } : {}), ...(charging ? { battery_state: 1 } : {}) } : null;
  const live = useMamlScene(componentId, { path, animate: playing, overrides });
  const { manifests, manifest, scene, error, elements, text, pages } = live;
  const pageValue = pages ? (page && page.name === pages.name && pages.values.includes(page.value) ? page.value : pages.values[0]) : null;
  const sel = useMamlSelection();
  const selected = manifest && sel.path === manifest.path ? sel.ord : null;
  const extra = manifest && sel.path === manifest.path ? sel.extra : NO_EXTRA;
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const font = usePackageFont(useMemo(() => themeFontFile(project.files), [project])).family ?? undefined;

  // Another theme opened beside this one, to copy pieces from.
  const reference = useStore((s) => s.reference);
  const downloads = useThemeStore((s) => s.downloads);
  const [beside, setBeside] = useState(false);
  const [refPage, setRefPage] = useState<{ name: string; value: number } | null>(null);
  const ref = useMamlScene(componentId, { slot: 'ref', overrides: refPage ? { [refPage.name]: refPage.value } : null });
  const refPageValue = ref.pages ? (refPage && refPage.name === ref.pages.name && ref.pages.values.includes(refPage.value) ? refPage.value : ref.pages.values[0]) : null;
  const [refSel, setRefSel] = useState<number[]>([]);
  useEffect(() => setRefSel([]), [reference?.sourcePath, refPageValue]);
  const showRef = beside && !!reference && !!ref.scene;
  const refFont = usePackageFont(useMemo(() => (reference ? themeFontFile(reference.files) : undefined), [reference]), 'ref').family ?? undefined;
  // The inventory, beside the lock screen.
  const [invOpen, setInvOpen] = useState(() => {
    try {
      return localStorage.getItem('mts.inventory.open') !== '0';
    } catch {
      return true;
    }
  });
  const clip = useInventory((s) => s.clip);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // The side phone can pick a piece in another layout of this part.
  useEffect(() => {
    if (sel.path && sel.path !== manifest?.path && manifests.some((m) => m.path === sel.path)) setPath(sel.path);
  }, [sel.path]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setFit({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [!!manifest]);

  // A widget sent from the Guide's recipe gallery: add it once the lock screen is drawn.
  const pending = usePendingBlock((s) => s.block);
  const addRef = useRef<((block: LockBlock, at?: { x: number; y: number }) => void) | null>(null);
  useEffect(() => {
    if (!pending || componentId !== 'lockscreen' || !scene?.lock || text === null || !addRef.current) return;
    const { title: named, at } = usePendingBlock.getState();
    const title = named || pending.label;
    usePendingBlock.setState({ block: null, title: '', at: undefined });
    addRef.current(pending, at);
    toast('success', `Added “${title}” to the lock screen`, 'Drag it into place, or change it in the side panel.');
  }, [pending, componentId, scene, text]);

  if (!manifests.length) {
    return (
      <div className="empty">
        <Info />
        <h3>Nothing to draw yet</h3>
        <p>This part has no manifest.xml layout. Take one from another theme with Swap, or add the files.</p>
      </div>
    );
  }
  // The other pages sit beside the one being edited, smaller.
  const others = pages && scene?.lock ? pages.values.filter((v) => v !== pageValue) : [];
  const thumbK = others.length ? Math.min(0.42, 0.94 / others.length) : 0;
  const refScene = showRef ? ref.scene : null;
  const scale =
    scene && fit.w && fit.h
      ? refScene
        ? Math.min((fit.w - 72) / (scene.w + refScene.w), (fit.h - 32) / scene.h, (fit.h - 72) / refScene.h)
        : Math.min((fit.w - 32 - (others.length ? 20 : 0)) / (scene.w * (1 + thumbK)), (fit.h - 32) / scene.h)
      : 0;
  const select = (ord: number | null) => useMamlSelection.setState({ path: manifest.path, ord, extra: [] });
  // Add a working piece (battery, weather, steps, charging) to the page being edited.
  const addBlock = (block: LockBlock, at?: { x: number; y: number }) => {
    if (text === null || !scene) return;
    const group = pages && pageValue !== null ? pageGroupOrdinal(elements, pages.name, pageValue) : null;
    const k = scene.w / 1080;
    // Below the pieces added before on this page, so they don't land on top of each other.
    const parent = elements[group ?? 0];
    const added = elements.filter((el) => el.parentElement === parent && /^[a-z]+_\d+$/.test(el.getAttribute('name') ?? '') && BLOCK_IDS.has((el.getAttribute('name') ?? '').replace(/_\d+$/, '')));
    const below = Math.max(scene.h * 0.3, ...added.map((el) => Number(el.getAttribute('y')) + Number(el.getAttribute('h')) + 30 * k).filter(Number.isFinite));
    const y = below + block.h * k > scene.h * 0.9 ? scene.h * 0.3 : below;
    const done = at ? insertBlock(text, block, group ?? 0, scene.w, at.y, at.x) : insertBlock(text, block, group ?? 0, scene.w, y);
    if (!done) return;
    let next = done.text;
    // No group for this page: show the piece only on it.
    if (pages && pageValue !== null && group === null) {
      const own = block.id === 'charging' ? 'eq(#battery_state,1)+eq(#battery_state,3)' : null;
      const only = `eq(#${pages.name},${pageValue})`;
      next = setAttributes(next, done.ord, { visibility: own ? `(${own})*${only}` : only });
    }
    if (block.id === 'charging') setCharging(true);
    void live.apply(next).then(() => select(done.ord));
  };
  addRef.current = addBlock;
  /** Pick a picture on the computer, copy it next to the manifest and place it on the page. */
  const addPicture = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !scene) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const bitmap = await createImageBitmap(file);
        const k = scene.w / 1080;
        // At most 60% of the width or 40% of the height, in 1080-wide units.
        const fit = Math.min(1, (648 * k) / bitmap.width, (scene.h * 0.4) / bitmap.height);
        const w = Math.max(1, Math.round((bitmap.width / k) * fit));
        const h = Math.max(1, Math.round((bitmap.height / k) * fit));
        bitmap.close();
        const taken = mainFiles().sizes;
        const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
        const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'picture';
        let rel = `mts_images/${stem}.${ext}`;
        for (let n = 2; taken.has(rel); n++) rel = `mts_images/${stem}_${n}.${ext}`;
        const ok = await A.writeGenerated([{ path: dir + rel, bytes }], `Add picture ${file.name}`);
        if (!ok) return;
        addBlock(imageBlock(rel, w, h));
      } catch (e) {
        toast('error', `Could not add “${file.name}”`, errorMessage(e));
      }
    };
    input.click();
  };
  const BASIC_ICON: Record<string, typeof Type> = { text: Type, clock: Clock, date: CalendarDays, level: BatteryMedium, rect: RectangleHorizontal, circle: CircleIcon, ring: CircleDashed, line: Minus };
  const WIDGET_ICON: Record<string, typeof Type> = { battery: BatteryMedium, weather: CloudSun, steps: Footprints, charging: Zap };
  const openAdd = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const basics = BASIC_BLOCKS.filter((b) => b.id !== 'level' && b.id !== 'clock' && b.id !== 'date');
    const info = BASIC_BLOCKS.filter((b) => b.id === 'clock' || b.id === 'date' || b.id === 'level');
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { heading: `Add to ${pageLabel}` },
      ...basics.map((b) => ({ label: b.label, icon: BASIC_ICON[b.id], onSelect: () => addBlock(b) })),
      { label: 'Picture from computer…', icon: ImageIcon, onSelect: addPicture },
      { heading: 'Live info' },
      ...info.map((b) => ({ label: b.label, icon: BASIC_ICON[b.id], onSelect: () => addBlock(b) })),
      { heading: 'Widgets' },
      ...LOCK_BLOCKS.map((b) => ({ label: b.label, icon: WIDGET_ICON[b.id] ?? Package, onSelect: () => addBlock(b) })),
      'separator',
      { label: 'More widgets in the recipe gallery…', icon: Sparkles, onSelect: () => openGuide('recipes') },
    ]);
  };
  const dir = manifest.path.replace(/manifest\.xml$/i, '');
  const pageLabel = pages && pageValue !== null ? `page ${pages.values.indexOf(pageValue) + 1}` : 'the lock screen';
  const mainFiles = () => slotReader(project.files, 'main', dir);
  const refDir = ref.manifest ? ref.manifest.path.replace(/manifest\.xml$/i, '') : '';
  const refFiles = () => slotReader(reference?.files ?? [], 'ref', refDir);
  const canvasOf = (which: 'main' | 'ref') => box.current?.querySelector<HTMLElement>(`.maml-frame.is-${which} .maml-canvas`) ?? null;

  /** Take pieces (with the code and pictures behind them) out of this theme or the one beside it. */
  const take = (which: 'main' | 'ref', ords: number[], area?: Snippet['box']): { snippet: Snippet; read: ByteReader; sizes: Map<string, number> } | null => {
    const src = which === 'main' ? live : ref;
    if (src.text === null || !src.scene || !ords.length) return null;
    const files = which === 'main' ? mainFiles() : refFiles();
    const canvas = canvasOf(which);
    const snippet = extractSnippet(src.text, src.elements, ords, {
      files: files.rels,
      vars: src.scene.vars,
      config: src.config,
      pageVar: src.pages?.name ?? null,
      box: area ?? (canvas ? measurePieces(canvas, ords, scale) : null),
      source: which === 'main' ? project.title : (reference?.title ?? undefined),
    });
    return snippet ? { snippet, read: files.read, sizes: files.sizes } : null;
  };

  /** Paste pieces into the page being edited (same place on the screen), copying their pictures. */
  const paste = async (snippet: Snippet, read: ByteReader, sizes: Map<string, number>) => {
    if (text === null || !scene) return;
    const group = pages && pageValue !== null ? pageGroupOrdinal(elements, pages.name, pageValue) : null;
    const done = pasteSnippet(text, snippet, {
      target: group ?? 0,
      targetOffset: group !== null ? absOffset(elements[group], scene.vars) : { x: 0, y: 0 },
      targetFiles: mainFiles().sizes,
      sourceSizes: sizes,
      visibility: pages && pageValue !== null && group === null ? `eq(#${pages.name},${pageValue})` : null,
      targetConfig: new Set((live.config ?? []).map(([id]) => id)),
    });
    if (!done) return toast('error', `Could not add “${snippet.name}” here`);
    if (done.writes.length) {
      try {
        const bytes = await Promise.all(done.writes.map((w) => read(w.from)));
        const ok = await A.writeGenerated(done.writes.map((w, i) => ({ path: dir + w.to, bytes: bytes[i] })), `Copy pictures of ${snippet.name}`);
        if (!ok) return;
      } catch (e) {
        return toast('error', `Could not copy the pictures of “${snippet.name}”`, errorMessage(e));
      }
    }
    await live.apply(done.text);
    select(done.ord);
    const notes = [
      done.writes.length ? `${done.writes.length} picture${done.writes.length === 1 ? '' : 's'} copied${done.writes.some((w) => w.to !== w.from) ? ' into their own folder (names were taken)' : ''}` : '',
      done.renamed ? `${done.renamed} name${done.renamed === 1 ? '' : 's'} changed so nothing clashes` : '',
    ].filter(Boolean);
    toast('success', `Added “${snippet.name}” to ${pageLabel}`, notes.join(' · ') || undefined);
  };
  const addItem = async (item: InventoryItem) => {
    const r = itemReader(item);
    try {
      await paste(item, r.read, await r.sizes);
    } catch (e) {
      toast('error', `Could not add “${item.name}”`, errorMessage(e));
    }
  };
  const copy = (which: 'main' | 'ref', ords: number[], area?: Snippet['box']) => {
    const got = take(which, ords, area);
    if (!got) return;
    useInventory.setState({ clip: got });
    toast('info', `Copied “${got.snippet.name}”`, 'Paste it into any lock screen page with Ctrl+V or right-click › Paste.');
  };
  const save = (which: 'main' | 'ref', ords: number[], area?: Snippet['box']) => {
    const got = take(which, ords, area);
    if (got) void saveToInventory(got.snippet, got.read).then((item) => item && setInvOpen(true));
  };
  const toggleInv = (open: boolean) => {
    setInvOpen(open);
    try {
      localStorage.setItem('mts.inventory.open', open ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  };
  const mainContext = (ords: number[], area: Snippet['box'], e: React.MouseEvent) => {
    const canUngroup = ords.length === 1 && isUserGroup(elements[ords[0]]);
    openContextMenu(e, [
      ...(ords.length > 1 ? [{ label: 'Group', icon: GroupIcon, shortcut: 'Ctrl+G', onSelect: () => groupSel(ords) }] : []),
      ...(canUngroup ? [{ label: 'Ungroup', icon: UngroupIcon, shortcut: 'Ctrl+Shift+G', onSelect: () => ungroupSel(ords[0]) }] : []),
      ...(ords.length > 1 || canUngroup ? ['separator' as const] : []),
      ...(ords.length
        ? [
            { label: 'Save to inventory', icon: PackagePlus, onSelect: () => save('main', ords, area) },
            { label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', onSelect: () => copy('main', ords, area) },
            { label: 'Duplicate', icon: CopyPlus, onSelect: () => (take('main', ords, area) ? void paste(take('main', ords, area)!.snippet, mainFiles().read, mainFiles().sizes) : undefined) },
          ]
        : []),
      ...(clip ? [{ label: `Paste “${clip.snippet.name}” on ${pageLabel}`, icon: ClipboardPaste, shortcut: 'Ctrl+V', onSelect: () => void paste(clip.snippet, clip.read, clip.sizes) }] : []),
      ...(ords.length ? ['separator' as const, { label: 'Delete', icon: Trash2, danger: true, shortcut: 'Del', onSelect: () => edit(ords[0], { kind: 'delete', ords }) }] : []),
    ]);
  };
  const refContext = (ords: number[], area: Snippet['box'], e: React.MouseEvent) => {
    if (!ords.length) return;
    openContextMenu(e, [
      { heading: `${ords.length === 1 ? 'This piece' : `${ords.length} pieces`} from ${reference?.title ?? 'the other theme'}` },
      { label: `Copy over to ${pageLabel} of my theme`, icon: ArrowLeftRight, onSelect: () => (take('ref', ords, area) ? void paste(take('ref', ords, area)!.snippet, refFiles().read, refFiles().sizes) : undefined) },
      { label: 'Save to inventory', icon: PackagePlus, onSelect: () => save('ref', ords, area) },
      { label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', onSelect: () => copy('ref', ords, area) },
    ]);
  };
  const openBeside = (e: React.MouseEvent<HTMLButtonElement>) => {
    void refreshDownloads();
    const r = e.currentTarget.getBoundingClientRect();
    const themes = downloads.filter((d) => d.kind === 'theme').slice(0, 14);
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {} }, [
      ...(reference ? [{ heading: 'Open now' }, { label: reference.title, icon: ArrowLeftRight, onSelect: () => setBeside(true) }] : []),
      ...(themes.length ? [{ heading: 'Your downloaded themes' }, ...themes.filter((t) => t.path !== reference?.sourcePath).map((t) => ({ label: t.name, onSelect: () => void A.openDownloadAsReference(t, false).then((snap) => snap && setBeside(true)) }))] : []),
      'separator' as const,
      { label: 'Open a theme file…', icon: FileArchive, onSelect: () => void A.openReference(false).then((snap) => snap && setBeside(true)) },
    ]);
  };
  keys.current = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && t !== document.body && (!t.closest('.maml') || t.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return;
    const key = e.key.toLowerCase();
    const mine = selected === null ? extra : [selected, ...extra.filter((o) => o !== selected)];
    if (key === 'g' && scene?.lock) {
      // Ctrl+G groups the selection, Ctrl+Shift+G takes a group apart.
      e.preventDefault();
      if (e.shiftKey) mine.filter((o) => isUserGroup(elements[o])).slice(0, 1).forEach(ungroupSel);
      else if (mine.length > 1) groupSel(mine);
      return;
    }
    if (e.shiftKey) return;
    if (key === 'c' && (mine.length || refSel.length)) {
      e.preventDefault();
      if (mine.length) copy('main', mine);
      else copy('ref', refSel);
    } else if (key === 'v' && clip) {
      e.preventDefault();
      void paste(clip.snippet, clip.read, clip.sizes);
    }
  };
  const selectMany = (ords: number[]) => useMamlSelection.setState({ path: manifest.path, ord: ords[0] ?? null, extra: ords.slice(1) });
  const selAll = selected === null ? extra : [selected, ...extra];
  /** A click picks the outermost group made with Group, unless the selection is already inside it. */
  const lift = (ord: number, deep = false) => {
    const chain: number[] = [];
    for (let p = elements[ord]?.parentElement; p; p = p.parentElement) if (isUserGroup(p)) chain.unshift(elements.indexOf(p));
    for (const g of chain) {
      const inside = selAll.some((o) => o !== g && elements[g]?.contains(elements[o] ?? null));
      if (inside || (deep && selAll.includes(g))) continue;
      return g;
    }
    return ord;
  };
  /** Wrap the selected pieces in a group that keeps them together for later moves. */
  const groupSel = (ords: number[]) => {
    if (text === null) return;
    // A piece inside another selected one goes with it.
    const top = ords.filter((o) => !ords.some((p) => p !== o && elements[p]?.contains(elements[o] ?? null)));
    if (top.length < 2) return;
    const parent = elements[top[0]]?.parentElement;
    if (!parent || top.some((o) => elements[o]?.parentElement !== parent)) {
      toast('error', 'Those pieces can’t be grouped', 'They sit in different groups of the layout. Pick pieces from the same one.');
      return;
    }
    const taken = new Set(elements.map((el) => el.getAttribute('name')));
    let n = 1;
    while (taken.has(`mts_group_${n}`)) n++;
    const done = groupElements(text, top, { name: `mts_group_${n}` });
    if (!done) return;
    void live.apply(done.text).then((ok) => ok !== false && select(done.ord));
  };
  /** Put a group's pieces back on their own, where they show now. */
  const ungroupSel = (ord: number) => {
    const g = elements[ord];
    if (text === null || !isUserGroup(g)) return;
    const vars = scene?.vars ?? new Map();
    const dx = Math.round(evalNumber(g.getAttribute('x'), vars));
    const dy = Math.round(evalNumber(g.getAttribute('y'), vars));
    const kids = Array.from(g.children).map((c) => elements.indexOf(c));
    let next = text;
    // The group's offset moves onto its pieces, so nothing jumps.
    for (const k of kids) {
      const el = elements[k];
      if (!el || !(DRAWABLE.has(el.tagName) || CONTAINERS.has(el.tagName))) continue;
      next = setAttributes(next, k, { ...(dx ? { x: nudge(el.getAttribute('x'), dx) } : {}), ...(dy ? { y: nudge(el.getAttribute('y'), dy) } : {}) });
    }
    next = ungroupElement(next, ord);
    // Every piece after the group's start tag moves up by one.
    void live.apply(next).then((ok) => ok !== false && selectMany(kids.filter((k) => DRAWABLE.has(elements[k]?.tagName ?? '') || CONTAINERS.has(elements[k]?.tagName ?? '')).map((k) => k - 1)));
  };
  const commit = (ord: number, attrs: Record<string, string | null>) => (text === null ? Promise.resolve(false) : live.apply(setAttributes(text, ord, attrs)));
  const edit = (ord: number, change: CanvasEdit) => {
    const el = elements[ord];
    if (!el) return;
    if (change.kind === 'move') {
      if (text === null) return;
      // Move every selected piece in one undoable write; a piece inside another selected one moves with it.
      const ords = change.ords ?? [ord];
      const inside = (o: number) => {
        for (let p = elements[o]?.parentElement; p; p = p.parentElement) if (ords.includes(elements.indexOf(p))) return true;
        return false;
      };
      let next = text;
      for (const o of ords) {
        const e = elements[o];
        if (!e || inside(o)) continue;
        next = setAttributes(next, o, { ...(change.dx ? { x: nudge(e.getAttribute('x'), change.dx) } : {}), ...(change.dy ? { y: nudge(e.getAttribute('y'), change.dy) } : {}) });
      }
      if (next !== text) void live.apply(next);
      return;
    }
    if (change.kind === 'delete') {
      if (text === null) return;
      const next = removeElements(text, change.ords);
      if (next === text) return;
      select(null);
      void live.apply(next);
      return;
    }
    const vars = scene?.vars ?? new Map();
    if (change.kind === 'rotate') {
      const name = el.hasAttribute('angle') && !el.hasAttribute('rotation') ? 'angle' : 'rotation';
      const current = evalNumber(el.getAttribute(name), vars);
      const next = Math.round((current + change.delta) * 10) / 10;
      const attrs: Record<string, string | null> = { [name]: next % 360 === 0 ? null : String(next) };
      if (!el.hasAttribute('pivotX') && !el.hasAttribute('pivotY')) Object.assign(attrs, { pivotX: String(change.pivot.x), pivotY: String(change.pivot.y) });
      void commit(ord, attrs);
      return;
    }
    // Resize: scale every piece about the handle opposite the one dragged, in one undoable write.
    if (text === null) return;
    const items = change.items ?? [{ ord, box: change.box }];
    const ords = items.map((it) => it.ord);
    const inside = (o: number) => {
      for (let p = elements[o]?.parentElement; p; p = p.parentElement) if (ords.includes(elements.indexOf(p))) return true;
      return false;
    };
    let next = text;
    for (const it of items) {
      const piece = elements[it.ord];
      if (!piece || inside(it.ord)) continue;
      next = setAttributes(next, it.ord, resizeAttrs(piece, vars, change.sx, change.sy, change.fixed, it.box));
    }
    if (next !== text) void live.apply(next);
  };

  return (
    <div className="maml">
      <div className="maml-bar">
        {manifests.length > 1 && (
          <select className="select" value={manifest.path} onChange={(e) => (setPath(e.target.value), select(null))} aria-label="Layout">
            {manifests.map((m) => (
              <option key={m.path} value={m.path}>
                {m.path.replace(/!?\/?manifest\.xml$/i, '').replace('!/', ' › ')}
              </option>
            ))}
          </select>
        )}
        {pages && scene?.lock && (
          <div className="segmented" role="group" aria-label="Lock screen page" title="This lock screen has several pages (a swipe or tap switches between them on the phone). Pick the one to edit.">
            {pages.values.map((v, i) => (
              <button key={v} aria-pressed={pageValue === v} onClick={() => (setPage({ name: pages.name, value: v }), select(null))}>
                Page {i + 1}
              </button>
            ))}
          </div>
        )}
        {scene?.lock && (
          <>
            <button className="btn btn-sm btn-primary" onClick={openAdd} title="Add text, a clock, shapes, a picture or a widget to this page">
              <Plus /> Add
            </button>
            <button className="btn btn-sm" aria-pressed={invOpen} onClick={() => toggleInv(!invOpen)} title="Pieces you saved from any theme, and working widgets (battery, weather, steps, charging). Click one to add it to this page.">
              <Package /> Inventory
            </button>
            <button className="btn btn-sm" aria-pressed={showRef} onClick={(e) => (showRef ? setBeside(false) : openBeside(e))} title="Open another theme next to this one. Right-click its pieces to copy them over, code and pictures included.">
              <ArrowLeftRight /> {showRef ? 'Close theme beside' : 'Open theme beside…'}
            </button>
            <button className="btn btn-sm" aria-pressed={charging} onClick={() => setCharging((c) => !c)} title="Show the lock screen as while the phone is charging">
              <BatteryCharging /> Charging
            </button>
          </>
        )}
        <button className="btn btn-sm" onClick={() => setPlaying((p) => !p)} title={playing ? 'Stop animations to edit in the resting pose' : 'Play the layout’s animations'}>
          {playing ? <Pause /> : <Play />} {playing ? 'Stop animations' : 'Play animations'}
        </button>
        {scene?.lock && <AlignToggle />}
        <span className="muted">Click a piece to edit it, drag to move it (Alt flips snapping). Drag on an empty spot or Shift+click to select several, Ctrl+G to group them (double-click a group to reach a piece inside). Right-click to save, copy or paste.{scene ? ` ${scene.w} × ${scene.h}` : ''}</span>
        {scene && scene.unknown.length > 0 && (
          <span className="badge badge-warn" title={`Drawn on the phone but not here: ${scene.unknown.join(', ')}`}>
            <AlertTriangle /> {scene.unknown.join(', ')} not drawn here
          </span>
        )}
      </div>
      <div className="maml-body">
        {scene?.lock && invOpen && <InventoryPanel target={pageLabel} onAdd={(item) => void addItem(item)} onAddBlock={addBlock} onClose={() => toggleInv(false)} />}
        <div className="maml-stage" ref={box}>
          {scene?.lock && <KeyCast area={box} />}
          {error ? (
            <div className="banner banner-err">{error}</div>
          ) : !scene || !scale ? (
            <Loader2 className="spin" />
          ) : (
            <div className="maml-pages">
              <div className={`maml-frame is-main ${scene.lock ? 'is-phone' : ''}`} style={{ width: scene.w * scale, height: scene.h * scale }}>
                <MamlCanvas scene={scene} scale={scale} font={font} selected={selected} extra={extra} onSelect={select} onSelectMany={selectMany} onEdit={edit} onContext={scene.lock ? mainContext : undefined} lift={lift} />
              </div>
              {refScene && reference && (
                <div className="maml-ref">
                  <div className="maml-ref-head" title="Right-click a piece to copy it over to your lock screen or save it to the inventory. Shift+click or drag to pick several.">
                    <ArrowLeftRight />
                    <strong className="ellipsis" title={reference.title}>
                      {reference.title}
                    </strong>
                    {ref.pages && (
                      <div className="segmented" role="group" aria-label="Page of the other theme">
                        {ref.pages.values.map((v, i) => (
                          <button key={v} aria-pressed={refPageValue === v} onClick={() => setRefPage({ name: ref.pages!.name, value: v })}>
                            {i + 1}
                          </button>
                        ))}
                      </div>
                    )}
                    <button className="tb-icon" aria-label="Close the theme beside" onClick={() => setBeside(false)}>
                      <X />
                    </button>
                  </div>
                  <div className="maml-frame is-ref is-phone" style={{ width: refScene.w * scale, height: refScene.h * scale }}>
                    <MamlCanvas
                      scene={refScene}
                      scale={scale}
                      font={refFont}
                      selected={refSel[0] ?? null}
                      extra={refSel.slice(1)}
                      onSelect={(o) => setRefSel(o === null ? [] : [o])}
                      onSelectMany={setRefSel}
                      onContext={refContext}
                    />
                  </div>
                </div>
              )}
              {!refScene && pages && others.length > 0 && (
                <div className="maml-page-thumbs">
                  {others.map((v) => (
                    <LockPageThumb
                      key={v}
                      path={manifest.path}
                      page={{ name: pages.name, value: v }}
                      label={`Page ${pages.values.indexOf(v) + 1}`}
                      scale={scale * thumbK}
                      font={font}
                      onOpen={() => (setPage({ name: pages.name, value: v }), select(null))}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <MamlInspector manifest={manifest} text={text} elements={elements} selected={selected} extra={extra} scene={scene} onSelect={select} onSelectMany={selectMany} onCommit={commit} onSave={scene?.lock ? (ords) => save('main', ords) : undefined} onGroup={scene?.lock ? groupSel : undefined} onUngroup={scene?.lock ? ungroupSel : undefined} />
      </div>
    </div>
  );
}
