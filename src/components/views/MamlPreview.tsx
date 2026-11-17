// Still preview of a MAML layout (lock screen, clock, widget): reads the
// part's manifest.xml and draws its images, text, clock and shapes where the
// manifest puts them, with the current time. Animations, touch and live phone
// data (weather, notifications, music) are not run.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { evalNumber, evalString, evaluate, formatDate, systemVars, type Vars } from '../../lib/maml';
import type { FileInfo } from '../../lib/types';
import { useStore } from '../../state/store';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { findWallpaper } from './PreviewView';

const SKIP = new Set(['Var', 'VariableBinders', 'ExternalCommands', 'Trigger', 'Triggers', 'MusicControl', 'Pressed', 'PressedState', 'ReachedState', 'EndPoint', 'Path', 'FolmeState', 'FolmeConfig', 'Function', 'Array', 'Slider']);
const CONTAINERS = new Set(['Group', 'Button', 'Unlocker', 'StartPoint', 'Normal', 'NormalState', 'Layer', 'FramerateController', 'AutoScaleGroup']);

function argb(value: string | null, fallback = '#ffffff') {
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
  unknown: Set<string>;
}

function fileFor(ctx: Ctx, src: string) {
  const clean = src.replace(/^\/+/, '');
  return ctx.files.get(`${ctx.dir}${clean}`) ?? ctx.files.get(`${ctx.dir}${clean}`.toLowerCase());
}

/** x/y plus align → CSS position (the element's own size is not needed). */
function place(el: Element, ctx: Ctx): CSSProperties {
  const n = (name: string, alt?: string) => evalNumber(el.getAttribute(name) ?? (alt ? el.getAttribute(alt) : null), ctx.vars);
  const has = (name: string) => el.hasAttribute(name);
  const style: CSSProperties = { position: 'absolute', left: n('x'), top: n('y') };
  if (has('w') || has('width')) style.width = n('w', 'width');
  if (has('h') || has('height')) style.height = n('h', 'height');
  const tx = el.getAttribute('align') === 'center' ? '-50%' : el.getAttribute('align') === 'right' ? '-100%' : '0';
  const ty = el.getAttribute('alignV') === 'center' ? '-50%' : el.getAttribute('alignV') === 'bottom' ? '-100%' : '0';
  const angle = n('rotation', 'angle');
  const transforms = [tx !== '0' || ty !== '0' ? `translate(${tx}, ${ty})` : '', angle ? `rotate(${angle}deg)` : ''].filter(Boolean);
  if (transforms.length) style.transform = transforms.join(' ');
  if (has('pivotX') || has('pivotY')) style.transformOrigin = `${n('pivotX')}px ${n('pivotY')}px`;
  if (has('alpha')) style.opacity = Math.min(1, Math.max(0, n('alpha') / 255));
  return style;
}

function visible(el: Element, ctx: Ctx) {
  const v = el.getAttribute('visibility');
  if (v === null) return true;
  if (v === 'true' || v === 'false') return v === 'true';
  return evalNumber(v, ctx.vars, 1) > 0;
}

function renderNodes(parent: Element, ctx: Ctx, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const el of Array.from(parent.children)) {
    const key = `${keyBase}.${i++}`;
    const tag = el.tagName;
    if (SKIP.has(tag) || /Animation$|Command$|Binder$/.test(tag)) continue;
    if (!visible(el, ctx)) continue;
    if (tag === 'Wallpaper') {
      if (ctx.wallpaper) out.push(<img key={key} src={resourceUrl('main', ctx.wallpaper.path, ctx.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />);
      continue;
    }
    if (CONTAINERS.has(tag)) {
      const style = place(el, ctx);
      out.push(
        <div key={key} style={style}>
          {renderNodes(el, ctx, key)}
        </div>,
      );
      continue;
    }
    if (tag === 'Image') {
      let src = el.hasAttribute('srcExp') ? evalString(el.getAttribute('srcExp'), ctx.vars) : (el.getAttribute('src') ?? '');
      if (el.hasAttribute('srcid') && src) src = src.replace(/(\.[a-z0-9]+)$/i, `_${Math.trunc(evalNumber(el.getAttribute('srcid'), ctx.vars))}$1`);
      const file = src ? fileFor(ctx, src) : undefined;
      if (file) out.push(<img key={key} src={resourceUrl('main', file.path, file.rev)} alt="" style={place(el, ctx)} draggable={false} />);
      continue;
    }
    if (tag === 'Rectangle' || tag === 'Circle' || tag === 'Ellipse') {
      const style = place(el, ctx);
      const fill = el.getAttribute('fillColor');
      const stroke = el.getAttribute('strokeColor');
      if (fill) style.background = argb(fill, 'transparent');
      if (stroke) style.border = `${evalNumber(el.getAttribute('weight'), ctx.vars, 1)}px solid ${argb(stroke)}`;
      if (tag === 'Circle') {
        const r = evalNumber(el.getAttribute('r'), ctx.vars);
        Object.assign(style, { width: r * 2, height: r * 2, borderRadius: '50%', marginLeft: -r, marginTop: -r });
      } else if (tag === 'Ellipse') style.borderRadius = '50%';
      else if (el.hasAttribute('cornerRadius')) style.borderRadius = evalNumber((el.getAttribute('cornerRadius') ?? '0').split(',')[0], ctx.vars);
      out.push(<div key={key} style={style} />);
      continue;
    }
    if (tag === 'Text' || tag === 'DateTime') {
      let text: string;
      if (tag === 'DateTime') text = formatDate(el.hasAttribute('formatExp') ? evalString(el.getAttribute('formatExp'), ctx.vars) : (el.getAttribute('format') ?? 'HH:mm'), ctx.now);
      else if (el.hasAttribute('textExp')) text = evalString(el.getAttribute('textExp'), ctx.vars);
      else {
        text = el.getAttribute('text') ?? '';
        const paras = (el.getAttribute('paras') ?? '').split(',').filter(Boolean);
        const format = el.getAttribute('format');
        if (format) {
          let p = 0;
          text = format.replace(/%[-0-9.]*[dsf]/g, () => evalString(paras[p++], ctx.vars));
        }
      }
      const style = place(el, ctx);
      Object.assign(style, {
        fontSize: evalNumber(el.getAttribute('size'), ctx.vars, 18),
        color: argb(el.getAttribute('color')),
        fontWeight: el.getAttribute('bold') === 'true' ? 700 : 400,
        whiteSpace: el.getAttribute('multiLine') === 'true' ? 'pre-wrap' : 'nowrap',
        lineHeight: 1.2,
        textAlign: (el.getAttribute('align') as 'left' | 'center' | 'right' | null) ?? 'left',
      });
      out.push(
        <div key={key} style={style}>
          {text}
        </div>,
      );
      continue;
    }
    if (tag === 'Time') {
      // Digit images: time.png → time_0.png … time_9.png and time_dot.png.
      const base = el.getAttribute('src') ?? 'time.png';
      const text = formatDate(el.getAttribute('format') ?? 'HH:mm', ctx.now);
      const style = place(el, ctx);
      out.push(
        <div key={key} style={{ ...style, display: 'flex', gap: evalNumber(el.getAttribute('space'), ctx.vars) }}>
          {[...text].map((ch, j) => {
            const f = fileFor(ctx, base.replace(/(\.[a-z0-9]+)$/i, `_${/[0-9]/.test(ch) ? ch : 'dot'}$1`));
            return f ? <img key={j} src={resourceUrl('main', f.path, f.rev)} alt="" draggable={false} /> : null;
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
      if (!name || !v.hasAttribute('expression')) continue;
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

export function MamlPreview({ componentId }: { componentId: string }) {
  const project = useStore((s) => s.project)!;
  const screen = useStore((s) => (s.selectedSerial ? (s.deviceDetails[s.selectedSerial]?.screenOverride ?? s.deviceDetails[s.selectedSerial]?.screen) : null));
  const manifests = useMemo(() => project.files.filter((f) => f.component === componentId && /(^|\/|!\/)manifest\.xml$/i.test(f.path)), [project, componentId]);
  const [path, setPath] = useState<string | null>(null);
  const manifest = manifests.find((m) => m.path === path) ?? manifests[0];
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const font = usePackageFont(useMemo(() => themeFontFile(project.files), [project])).family ?? undefined;

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setFit({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [!!manifest]);
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    api
      .fileText(manifest.path)
      .then((t) => {
        if (cancelled) return;
        const parsed = new DOMParser().parseFromString(t.text.replace(/^﻿/, ''), 'text/xml');
        if (parsed.querySelector('parsererror')) setError('The manifest is not valid XML, so it cannot be drawn.');
        else setDoc(parsed);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [manifest?.path, manifest?.rev]);

  const files = useMemo(() => new Map(project.files.map((f) => [f.path, f])), [project]);
  const scene = useMemo(() => {
    if (!doc || !manifest) return null;
    const root = doc.documentElement;
    const lock = root.tagName === 'Lockscreen';
    const sw = Number(root.getAttribute('screenWidth')) || 1080;
    const phone = screen && screen.width && screen.height ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height) : 20 / 9;
    const w = lock ? sw : Number(root.getAttribute('width')) || Number(root.getAttribute('w')) || sw;
    const h = lock ? Math.round(sw * phone) : Number(root.getAttribute('height')) || Number(root.getAttribute('h')) || Math.round(sw * 0.46);
    const ctx: Ctx = { vars: systemVars(w, h, now), dir: manifest.path.replace(/manifest\.xml$/i, ''), files, wallpaper: findWallpaper(project.files, true), now, unknown: new Set() };
    if (ctx.wallpaper) {
      ctx.vars.set('wall.bmp_width', ctx.wallpaper.width ?? w);
      ctx.vars.set('wall.bmp_height', ctx.wallpaper.height ?? h);
    }
    collectVars(root, ctx);
    const nodes = renderNodes(root, ctx, 'n');
    const hasWallpaper = lock && root.getElementsByTagName('Wallpaper').length > 0;
    return { w, h, lock, nodes, unknown: [...ctx.unknown], hasWallpaper, wallpaper: ctx.wallpaper };
  }, [doc, manifest, files, now, screen, project]);

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

  return (
    <div className="maml">
      <div className="maml-bar">
        {manifests.length > 1 && (
          <select className="select" value={manifest.path} onChange={(e) => setPath(e.target.value)} aria-label="Layout">
            {manifests.map((m) => (
              <option key={m.path} value={m.path}>
                {m.path.replace(/!?\/?manifest\.xml$/i, '').replace('!/', ' › ')}
              </option>
            ))}
          </select>
        )}
        <span className="muted">
          Still preview at the current time{scene ? ` · ${scene.w} × ${scene.h}` : ''}. Animations, touch and live data (weather, notifications, music) only run on the phone.
        </span>
        {scene && scene.unknown.length > 0 && (
          <span className="badge badge-warn" title={`Not drawn: ${scene.unknown.join(', ')}`}>
            <AlertTriangle /> {scene.unknown.length} element type{scene.unknown.length > 1 ? 's' : ''} not drawn
          </span>
        )}
      </div>
      <div className="maml-stage" ref={box}>
        {error ? (
          <div className="banner banner-err">{error}</div>
        ) : !scene || !scale ? (
          <Loader2 className="spin" />
        ) : (
          <div className={`maml-frame ${scene.lock ? 'is-phone' : ''}`} style={{ width: scene.w * scale, height: scene.h * scale }}>
            <div className="maml-canvas" style={{ width: scene.w, height: scene.h, transform: `scale(${scale})`, fontFamily: font }}>
              {scene.lock && !scene.hasWallpaper && scene.wallpaper && (
                <img src={resourceUrl('main', scene.wallpaper.path, scene.wallpaper.rev)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
              )}
              {scene.nodes}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
