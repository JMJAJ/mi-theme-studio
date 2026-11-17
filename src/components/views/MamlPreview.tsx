// Live preview of a MAML layout (lock screen, clock, widget): reads the part's
// manifest.xml and draws its images, text, clocks and shapes where the
// manifest puts them, with the current time and its animations playing. On the
// Lock screen page you can click any piece to edit it, or drag it to move it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Info, Loader2, Pause, Play } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { evalNumber, evalString, evaluate, formatDate, systemVars, type Vars } from '../../lib/maml';
import { lenientXml, removeElements, setAttributes } from '../../lib/mamlEdit';
import type { FileInfo, Slot } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { findWallpaper } from './PreviewView';
import { MamlInspector } from './MamlInspector';

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
}

function fileFor(ctx: Ctx, src: string) {
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
  return style;
}

function visible(el: Element, ctx: Ctx) {
  const v = el.getAttribute('visibility');
  if (v === null) return true;
  if (v === 'true' || v === 'false') return v === 'true';
  return evalNumber(v, ctx.vars, 1) > 0;
}

/** "%d"-style format with comma-separated expression arguments. */
function formatParas(format: string, paras: string | null, ctx: Ctx) {
  const args = (paras ?? '').split(',').filter(Boolean);
  let p = 0;
  return format.replace(/%[-0-9.]*([dsf])/g, (m, kind: string) => {
    const v = evaluate(args[p++], ctx.vars, '');
    if (kind === 'd') return String(Math.trunc(Number(v) || 0)).padStart(/%0(\d)d/.exec(m)?.[1] ? Number(/%0(\d)d/.exec(m)![1]) : 0, '0');
    return String(v);
  });
}

function imageSource(el: Element, ctx: Ctx, anim: Anim) {
  let src = anim.src ?? (el.hasAttribute('srcExp') ? evalString(el.getAttribute('srcExp'), ctx.vars) : el.hasAttribute('srcFormat') ? formatParas(el.getAttribute('srcFormat')!, el.getAttribute('srcParas'), ctx) : (el.getAttribute('src') ?? ''));
  if (el.hasAttribute('srcid') && src) src = src.replace(/(\.[a-z0-9]+)$/i, `_${Math.trunc(evalNumber(el.getAttribute('srcid'), ctx.vars))}$1`);
  return src;
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
      if (ctx.wallpaper) out.push(<img key={key} data-mk={mk} data-mt={tag} src={resourceUrl(ctx.slot, ctx.wallpaper.path, ctx.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />);
      continue;
    }
    if (CONTAINERS.has(tag)) {
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} style={place(el, ctx, anim)}>
          {renderNodes(el, ctx)}
        </div>,
      );
      continue;
    }
    if (tag === 'Image') {
      const src = imageSource(el, ctx, anim);
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<img key={key} data-mk={mk} data-mt={tag} src={resourceUrl(ctx.slot, file.path, file.rev)} alt="" style={place(el, ctx, anim)} draggable={false} />);
      continue;
    }
    if (tag === 'Video') {
      const src = el.getAttribute('src') ?? '';
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<video key={key} data-mk={mk} data-mt={tag} src={resourceUrl(ctx.slot, file.path, file.rev)} muted loop autoPlay playsInline style={{ ...place(el, ctx, anim), objectFit: 'cover' }} />);
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
        Object.assign(style, { width: r * 2, height: r * 2, borderRadius: '50%', marginLeft: -r, marginTop: -r });
      } else if (tag === 'Ellipse') style.borderRadius = '50%';
      else if (el.hasAttribute('cornerRadius')) style.borderRadius = evalNumber((el.getAttribute('cornerRadius') ?? '0').split(',')[0], ctx.vars);
      out.push(<div key={key} data-mk={mk} data-mt={tag} style={style} />);
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
        fontWeight: el.getAttribute('bold') === 'true' ? 700 : 400,
        whiteSpace: el.getAttribute('multiLine') === 'true' ? 'pre-wrap' : 'nowrap',
        lineHeight: 1.2,
        textAlign: (el.getAttribute('align') as 'left' | 'center' | 'right' | null) ?? 'left',
        textShadow: shadow ? `${evalNumber(el.getAttribute('shadowDx'), ctx.vars)}px ${evalNumber(el.getAttribute('shadowDy'), ctx.vars)}px ${evalNumber(el.getAttribute('shadowRadius'), ctx.vars)}px ${argb(shadow)}` : undefined,
        letterSpacing: el.hasAttribute('spacing') ? evalNumber(el.getAttribute('spacing'), ctx.vars) : undefined,
      });
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} style={style}>
          {text}
        </div>,
      );
      continue;
    }
    if (tag === 'Time' || tag === 'ImageNumber') {
      // Digit images: time.png → time_0.png … time_9.png and time_dot.png.
      const base = el.getAttribute('src') ?? (tag === 'Time' ? 'time.png' : 'number.png');
      const text = tag === 'Time' ? formatDate(el.getAttribute('format') ?? 'HH:mm', ctx.now) : String(Math.trunc(evalNumber(el.getAttribute('number') ?? el.getAttribute('numberExp'), ctx.vars)));
      out.push(
        <div key={key} data-mk={mk} data-mt={tag} style={{ ...place(el, ctx, anim), display: 'flex', gap: evalNumber(el.getAttribute('space'), ctx.vars) }}>
          {[...text].map((ch, j) => {
            const f = fileFor(ctx, digitFile(base, ch));
            return f ? <img key={j} src={resourceUrl(ctx.slot, f.path, f.rev)} alt="" draggable={false} /> : null;
          })}
        </div>,
      );
      continue;
    }
    ctx.unknown.add(tag);
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

// ---------- the hook ----------

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
export function useMamlScene(componentId: string, opts: { path?: string | null; slot?: Slot; animate?: boolean } = {}) {
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

  const text = draft ?? saved;
  const parsed = useMemo(() => {
    if (text === null) return null;
    let doc = new DOMParser().parseFromString(text, 'text/xml');
    // Draw what the phone draws: retry with the slips its parser forgives (a repeated attribute, a bare &).
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(lenientXml(text), 'text/xml');
    if (doc.querySelector('parsererror')) return { doc: null, elements: [] as Element[] };
    const elements = Array.from(doc.getElementsByTagName('*'));
    return { doc, elements, ord: new Map(elements.map((e, i) => [e, i])) };
  }, [text]);
  // Keep the last good drawing while a half-typed edit is not valid XML.
  const lastGood = useRef<typeof parsed>(null);
  if (parsed?.doc) lastGood.current = parsed;
  const good = parsed?.doc ? parsed : lastGood.current;

  const files = useMemo(() => new Map(projectFiles.map((f) => [f.path, f])), [projectFiles]);
  const scene = useMemo(() => {
    if (!good?.doc || !manifest || !('ord' in good) || !good.ord) return null;
    const root = good.doc.documentElement;
    const lock = root.tagName === 'Lockscreen';
    const sw = Number(root.getAttribute('screenWidth')) || 1080;
    const phone = screen && screen.width && screen.height ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height) : 20 / 9;
    const w = lock ? sw : Number(root.getAttribute('width')) || Number(root.getAttribute('w')) || sw;
    const h = lock ? Math.round(sw * phone) : Number(root.getAttribute('height')) || Number(root.getAttribute('h')) || Math.round(sw * 0.46);
    const ctx: Ctx = { vars: systemVars(w, h, now), dir: manifest.path.replace(/manifest\.xml$/i, ''), files, wallpaper: findWallpaper(projectFiles, true), now, t: opts.animate ? t : null, slot, ord: good.ord, unknown: new Set() };
    if (ctx.wallpaper) {
      ctx.vars.set('wall.bmp_width', ctx.wallpaper.width ?? w);
      ctx.vars.set('wall.bmp_height', ctx.wallpaper.height ?? h);
    }
    collectVars(root, ctx);
    const nodes = renderNodes(root, ctx);
    const hasWallpaper = lock && root.getElementsByTagName('Wallpaper').length > 0;
    return { w, h, lock, nodes, unknown: [...ctx.unknown], hasWallpaper, wallpaper: ctx.wallpaper, slot, vars: ctx.vars };
  }, [good, manifest, files, now, t, screen, projectFiles, opts.animate, slot]);

  /** Write a new manifest text: shown at once, then saved (undoable). */
  const apply = async (next: string) => {
    if (!manifest || slot !== 'main') return false;
    setSaved(next);
    return A.writeText(manifest.path, next);
  };

  return { manifests, manifest, scene, error: parsed && !parsed.doc && !lastGood.current ? 'The manifest is not valid XML, so it cannot be drawn.' : error, text, elements: good?.elements ?? [], apply };
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
  | { kind: 'resize'; sx: number; sy: number; fixed: { x: number; y: number }; box: Box }
  | { kind: 'rotate'; delta: number; pivot: { x: number; y: number } }
  | { kind: 'delete'; ords: number[] };

/** Pieces whose size can be dragged (groups take their size from what is inside them). */
const RESIZABLE = new Set(['Image', 'Rectangle', 'Ellipse', 'Arc', 'Circle', 'Video', 'Text', 'DateTime', 'Time', 'ImageNumber']);
const UNIFORM = new Set(['Text', 'DateTime', 'Circle', 'Time', 'ImageNumber']);
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

type DragState =
  | { kind: 'move'; ord: number; ords: number[]; nodes: HTMLElement[]; x: number; y: number; moved: boolean; box: Box | null; snaps: Snaps; dx: number; dy: number; click?: () => void }
  | { kind: 'marquee'; x: number; y: number; additive: boolean; base: number[]; moved: boolean; hits: number[]; click: () => void }
  | { kind: 'resize'; ord: number; node: HTMLElement; handle: Handle; x: number; y: number; box: Box; origin: { x: number; y: number }; uniform: boolean; sx: number; sy: number; fixed: { x: number; y: number }; oldOrigin: string; snaps: Snaps }
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  // Clicking the same spot again goes one piece deeper (what is underneath).
  const lastClick = useRef<{ x: number; y: number; ords: number[] } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [boxes, setBoxes] = useState<{ sel: Box | null; hover: Box | null; tag: string; items: Box[] }>({ sel: null, hover: null, tag: '', items: [] });
  const [marquee, setMarquee] = useState<{ box: Box; hits: Box[] } | null>(null);
  const all = selected === null ? extra : [selected, ...extra.filter((o) => o !== selected)];
  const multi = all.length > 1;
  const [, setMaskTick] = useState(0);
  const [live, setLive] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] } | null>(null);
  const editable = !!onSelect;

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
    const same = (a: Box | null, b: Box | null) => (!a && !b) || (!!a && !!b && Math.abs(a.l - b.l) + Math.abs(a.t - b.t) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) < 0.5);
    const sameItems = items.length === boxes.items.length && items.every((b, i) => same(b, boxes.items[i]));
    if (!same(sel, boxes.sel) || !same(hb, boxes.hover) || tag !== boxes.tag || !sameItems) setBoxes({ sel, hover: hb, tag, items });
  });

  const nodeOf = (ord: number) => ref.current?.querySelector<HTMLElement>(`[data-mk="${ord}"]`) ?? null;

  // Esc clears the selection, Delete removes the selected pieces, arrow keys nudge them (Shift: 10 px).
  useEffect(() => {
    if (!onEdit || !onSelectMany) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!all.length || !ref.current?.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && t !== document.body && (!t.closest('.maml') || t.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return;
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

  const startResize = (handle: Handle, e: React.PointerEvent) => {
    e.stopPropagation();
    const canvas = ref.current;
    if (selected === null || !canvas || !boxes.sel) return;
    const node = nodeOf(selected);
    if (!node) return;
    const uniform = UNIFORM.has(node.dataset.mt ?? '') || (handle.length === 2 && !e.shiftKey && !!srcOf(node));
    drag.current = { kind: 'resize', ord: selected, node, handle, x: e.clientX, y: e.clientY, box: boxes.sel, origin: layoutOrigin(node, canvas), uniform, sx: 1, sy: 1, fixed: { x: 0, y: 0 }, oldOrigin: node.style.transformOrigin, snaps: snapTargets(canvas, node, scale, scene.w, scene.h) };
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
  const canResize = RESIZABLE.has(boxes.tag);

  return (
    <div
      ref={ref}
      className={`maml-canvas ${editable ? 'is-edit' : ''}`}
      style={{ width: scene.w, height: scene.h, transform: `scale(${scale})`, fontFamily: font }}
      onPointerDown={
        editable
          ? (e) => {
              if (e.button !== 0) return;
              const canvas = e.currentTarget as HTMLElement;
              const ranked = piecesRanked(canvas, e.clientX, e.clientY);
              const pieces = ranked.map((p) => p.n);
              const ords = pieces.map((n) => Number(n.dataset.mk));
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
                let index = 0;
                if (last && Math.abs(last.x - e.clientX) < 4 && Math.abs(last.y - e.clientY) < 4 && selected !== null && ords.includes(selected) && last.ords.join() === ords.join()) {
                  index = (ords.indexOf(selected) + 1) % ords.length;
                }
                lastClick.current = { x: e.clientX, y: e.clientY, ords };
                return pieces[index] ? ords[index] : null;
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
            setHover(top && seen && !CONTAINERS.has(tag) && tag !== 'Wallpaper' ? Number(top.dataset.mk) : null);
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
          d.hits = piecesIn(canvas, scale, scene.w, scene.h, box);
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
        // Snap within 6 screen pixels; hold Alt to place freely.
        const thr = e.altKey ? 0 : 6 / scale;
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
          d.node.style.transformOrigin = `${fx - d.origin.x}px ${fy - d.origin.y}px`;
          d.node.style.scale = `${sx} ${sy}`;
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
          d.node.style.scale = '';
          d.node.style.transformOrigin = d.oldOrigin;
          if (Math.abs(d.sx - 1) > 0.002 || Math.abs(d.sy - 1) > 0.002) {
            const canvas = ref.current!;
            onEdit!(d.ord, { kind: 'resize', sx: d.sx, sy: d.sy, fixed: d.fixed, box: visibleBox(d.node, canvas, scale, false) ?? d.box });
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
          {onEdit && !live && !multi && (
            <>
              {canResize && HANDLES.filter((h) => !UNIFORM.has(boxes.tag) || h.length === 2).map((h) => <span key={h} className={`maml-h h-${h}`} onPointerDown={(e) => startResize(h, e)} />)}
              <span className="maml-rot" title="Rotate (Shift: 15° steps)" onPointerDown={startRotate} />
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
export function PhoneLockScreen({ width, height, font, onPick }: { width: number; height: number; font?: string; onPick?: (path: string, ord: number | null) => void }) {
  const { scene, manifest } = useMamlScene('lockscreen', { animate: true });
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

/** True when the theme has a lock screen layout the phone mock-ups can draw. */
export function useHasLockLayout() {
  return useStore((s) => !!s.project?.files.some((f) => f.component === 'lockscreen' && /(^|\/|!\/)manifest\.xml$/i.test(f.path)));
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

/** Add a pixel offset to an x/y value, keeping formulas as formulas. */
function nudge(value: string | null, d: number) {
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
  const live = useMamlScene(componentId, { path, animate: playing });
  const { manifests, manifest, scene, error, elements, text } = live;
  const sel = useMamlSelection();
  const selected = manifest && sel.path === manifest.path ? sel.ord : null;
  const extra = manifest && sel.path === manifest.path ? sel.extra : NO_EXTRA;
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const font = usePackageFont(useMemo(() => themeFontFile(project.files), [project])).family ?? undefined;

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

  if (!manifests.length) {
    return (
      <div className="empty">
        <Info />
        <h3>Nothing to draw yet</h3>
        <p>This part has no manifest.xml layout. Take one from another theme with Swap, or add the files.</p>
      </div>
    );
  }
  const scale = scene && fit.w && fit.h ? Math.min((fit.w - 32) / scene.w, (fit.h - 32) / scene.h) : 0;
  const select = (ord: number | null) => useMamlSelection.setState({ path: manifest.path, ord, extra: [] });
  const selectMany = (ords: number[]) => useMamlSelection.setState({ path: manifest.path, ord: ords[0] ?? null, extra: ords.slice(1) });
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
    // Resize: scale the piece about the handle opposite the one dragged.
    const { sx, sy, fixed: p, box: e } = change;
    const tag = el.tagName;
    const next = { l: p.x + (e.l - p.x) * sx, t: p.y + (e.t - p.y) * sy, w: e.w * sx, h: e.h * sy };
    if (SCALED.has(tag)) {
      void commit(ord, scaleAttrs(el, vars, sx, e, next));
      return;
    }
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
    void commit(ord, attrs);
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
        <button className="btn btn-sm" onClick={() => setPlaying((p) => !p)} title={playing ? 'Stop animations to edit in the resting pose' : 'Play the layout’s animations'}>
          {playing ? <Pause /> : <Play />} {playing ? 'Stop animations' : 'Play animations'}
        </button>
        <span className="muted">Click a piece to edit it, drag to move it (hold Alt to skip snapping). Drag on an empty spot or Shift+click to select several. Delete removes the selection.{scene ? ` ${scene.w} × ${scene.h}` : ''}</span>
        {scene && scene.unknown.length > 0 && (
          <span className="badge badge-warn" title={`Drawn on the phone but not here: ${scene.unknown.join(', ')}`}>
            <AlertTriangle /> {scene.unknown.join(', ')} not drawn here
          </span>
        )}
      </div>
      <div className="maml-body">
        <div className="maml-stage" ref={box}>
          {error ? (
            <div className="banner banner-err">{error}</div>
          ) : !scene || !scale ? (
            <Loader2 className="spin" />
          ) : (
            <div className={`maml-frame ${scene.lock ? 'is-phone' : ''}`} style={{ width: scene.w * scale, height: scene.h * scale }}>
              <MamlCanvas scene={scene} scale={scale} font={font} selected={selected} extra={extra} onSelect={select} onSelectMany={selectMany} onEdit={edit} />
            </div>
          )}
        </div>
        <MamlInspector manifest={manifest} text={text} elements={elements} selected={selected} extra={extra} scene={scene} onSelect={select} onSelectMany={selectMany} onCommit={commit} />
      </div>
    </div>
  );
}
