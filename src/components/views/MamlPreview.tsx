// Live preview of a MAML layout (lock screen, clock, widget): reads the part's
// manifest.xml and draws its images, text, clocks and shapes where the
// manifest puts them, with the current time and its animations playing. On the
// Lock screen page you can click any piece to edit it, or drag it to move it.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Info, Loader2, Pause, Play } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { evalNumber, evalString, evaluate, formatDate, systemVars, type Vars } from '../../lib/maml';
import { setAttributes } from '../../lib/mamlEdit';
import type { FileInfo, Slot } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { findWallpaper } from './PreviewView';
import { MamlInspector } from './MamlInspector';

const SKIP = new Set(['Var', 'VariableBinders', 'ExternalCommands', 'Trigger', 'Triggers', 'MusicControl', 'Pressed', 'PressedState', 'ReachedState', 'EndPoint', 'Path', 'FolmeState', 'FolmeConfig', 'Function', 'Array', 'Slider', 'Permanence', 'Sound', 'Item', 'AniFrame', 'Position', 'Alpha', 'Rotation', 'Size', 'Source', 'Mask']);
const CONTAINERS = new Set(['Group', 'Button', 'Unlocker', 'StartPoint', 'Normal', 'NormalState', 'Layer', 'FramerateController', 'AutoScaleGroup', 'ScreenElementsGroup']);
/** Elements a person can click and edit; groups are reached from a child. */
export const DRAWABLE = new Set(['Image', 'Text', 'DateTime', 'Time', 'ImageNumber', 'Rectangle', 'Circle', 'Ellipse', 'Line', 'Wallpaper']);

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
  const transforms = [tx !== '0' || ty !== '0' ? `translate(${tx}, ${ty})` : '', angle ? `rotate(${angle}deg)` : ''].filter(Boolean);
  if (transforms.length) style.transform = transforms.join(' ');
  if (has('pivotX') || has('pivotY')) style.transformOrigin = `${n('pivotX')}px ${n('pivotY')}px`;
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
      if (ctx.wallpaper) out.push(<img key={key} data-mk={mk} src={resourceUrl(ctx.slot, ctx.wallpaper.path, ctx.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />);
      continue;
    }
    if (CONTAINERS.has(tag)) {
      out.push(
        <div key={key} data-mk={mk} style={place(el, ctx, anim)}>
          {renderNodes(el, ctx)}
        </div>,
      );
      continue;
    }
    if (tag === 'Image') {
      const src = imageSource(el, ctx, anim);
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<img key={key} data-mk={mk} src={resourceUrl(ctx.slot, file.path, file.rev)} alt="" style={place(el, ctx, anim)} draggable={false} />);
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
      out.push(<div key={key} data-mk={mk} style={style} />);
      continue;
    }
    if (tag === 'Line') {
      const x = evalNumber(el.getAttribute('x'), ctx.vars) + anim.dx;
      const y = evalNumber(el.getAttribute('y'), ctx.vars) + anim.dy;
      const x1 = evalNumber(el.getAttribute('x1'), ctx.vars, x);
      const y1 = evalNumber(el.getAttribute('y1'), ctx.vars, y);
      const len = Math.hypot(x1 - x, y1 - y);
      const weight = evalNumber(el.getAttribute('weight'), ctx.vars, 1);
      out.push(<div key={key} data-mk={mk} style={{ position: 'absolute', left: x, top: y - weight / 2, width: len, height: weight, background: argb(el.getAttribute('strokeColor') ?? el.getAttribute('color')), transformOrigin: '0 50%', transform: `rotate(${Math.atan2(y1 - y, x1 - x)}rad)` }} />);
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
        <div key={key} data-mk={mk} style={style}>
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
        <div key={key} data-mk={mk} style={{ ...place(el, ctx, anim), display: 'flex', gap: evalNumber(el.getAttribute('space'), ctx.vars) }}>
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
  for (let pass = 0; pass < 2; pass++) {
    for (const v of vars) {
      const name = v.getAttribute('name');
      if (!name) continue;
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
export const useMamlSelection = create<{ path: string | null; ord: number | null }>(() => ({ path: null, ord: null }));

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
    const doc = new DOMParser().parseFromString(text, 'text/xml');
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

/**
 * The scene drawn at its own size and scaled. With `onSelect`, clicking a piece
 * selects it; with `onMove`, dragging the selected piece moves it.
 */
export function MamlCanvas({
  scene,
  scale,
  font,
  selected = null,
  onSelect,
  onMove,
}: {
  scene: Scene;
  scale: number;
  font?: string;
  selected?: number | null;
  onSelect?: (ord: number | null) => void;
  onMove?: (ord: number, dx: number, dy: number) => void;
}) {
  const drag = useRef<{ ord: number; node: HTMLElement; x: number; y: number; moved: boolean } | null>(null);
  const editable = !!onSelect;
  return (
    <div
      className={`maml-canvas ${editable ? 'is-edit' : ''}`}
      style={{ width: scene.w, height: scene.h, transform: `scale(${scale})`, fontFamily: font }}
      onPointerDown={
        editable
          ? (e) => {
              const node = (e.target as HTMLElement).closest<HTMLElement>('[data-mk]');
              const ord = node ? Number(node.dataset.mk) : null;
              onSelect!(ord);
              if (node && ord !== null && onMove) {
                drag.current = { ord, node, x: e.clientX, y: e.clientY, moved: false };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }
            }
          : undefined
      }
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) / scale;
        const dy = (e.clientY - d.y) / scale;
        if (Math.abs(dx) + Math.abs(dy) > 3 / scale) d.moved = true;
        if (d.moved) d.node.style.translate = `${dx}px ${dy}px`;
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        d.node.style.translate = '';
        if (d.moved) onMove!(d.ord, Math.round((e.clientX - d.x) / scale), Math.round((e.clientY - d.y) / scale));
      }}
    >
      {editable && (
        <style>{`.maml-canvas.is-edit [data-mk]:hover{outline:${1.5 / scale}px dashed rgba(255,138,61,.75)}.maml-canvas.is-edit [data-mk="${selected ?? -2}"]{outline:${2.5 / scale}px solid #ff6a14;outline-offset:${2 / scale}px}`}</style>
      )}
      {scene.lock && !scene.hasWallpaper && scene.wallpaper && (
        <img src={resourceUrl(scene.slot, scene.wallpaper.path, scene.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} draggable={false} />
      )}
      {scene.nodes}
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
  const select = (ord: number | null) => useMamlSelection.setState({ path: manifest.path, ord });
  const commit = (ord: number, attrs: Record<string, string | null>) => (text === null ? Promise.resolve(false) : live.apply(setAttributes(text, ord, attrs)));
  const move = (ord: number, dx: number, dy: number) => {
    const el = elements[ord];
    if (!el) return;
    void commit(ord, { ...(dx ? { x: nudge(el.getAttribute('x'), dx) } : {}), ...(dy ? { y: nudge(el.getAttribute('y'), dy) } : {}) });
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
        <span className="muted">Click any piece to edit it, drag it to move it.{scene ? ` ${scene.w} × ${scene.h}` : ''}</span>
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
              <MamlCanvas scene={scene} scale={scale} font={font} selected={selected} onSelect={select} onMove={move} />
            </div>
          )}
        </div>
        <MamlInspector manifest={manifest} text={text} elements={elements} selected={selected} scene={scene} onSelect={select} onCommit={commit} />
      </div>
    </div>
  );
}
