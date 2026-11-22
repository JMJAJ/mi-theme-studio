// The system UI drawn around a theme in the phone mock-ups: status bar, the
// HyperOS launcher grid and the lock screen's bottom shortcuts. Every size and
// position is measured from real HyperOS screenshots (home and lock screen at
// 1156 px wide) and expressed as a fraction of the screen width, so the mock-up
// lines up with the phone at any resolution. Nothing device-specific is drawn. Positions on the home screen are
// counted from the bottom edge, like the launcher lays them out.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, resourceUrl } from '../../lib/api';
import type { FileInfo } from '../../lib/types';
import { argb, PhoneWidget } from './MamlPreview';

/** Measured on HyperOS, in screen widths. */
const M = {
  statusY: 0.0706, // status bar text centre, from the top
  statusPadL: 0.098,
  statusPadR: 0.09,
  statusFont: 0.041,
  icon: 0.152, // launcher icon box (theme icons carry their own transparent margin)
  cols: [0.149, 0.382, 0.617, 0.851], // column centres
  lastRow: 0.617, // centre of the bottom grid row, from the bottom
  rowPitch: 0.255,
  label: 0.105, // label centre below the icon centre
  labelFont: 0.032,
  dockY: 0.2085, // dock icon centres, from the bottom
  dotsY: 0.36, // page indicator, from the bottom
};

const SYSTEM_FONT = 'MiSans, "Mi Sans", Roboto, "Segoe UI", system-ui, sans-serif';

// ---------- wallpaper brightness (the phone switches to dark text on light wallpapers) ----------

export interface Tone {
  /** The strip behind the status bar is light. */
  top: boolean;
  /** The area behind the icons is light. */
  body: boolean;
}
const tones = new Map<string, Tone>();

export function useWallpaperTone(file: FileInfo | undefined, ratio: number): Tone {
  const url = file ? resourceUrl('main', file.path, file.rev) : null;
  const key = url ? `${url}|${ratio.toFixed(3)}` : '';
  const [tone, setTone] = useState<Tone>(() => tones.get(key) ?? { top: false, body: false });
  useEffect(() => {
    if (!url) return setTone({ top: false, body: false });
    const known = tones.get(key);
    if (known) return setTone(known);
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        // Draw it the way the screen crops it (cover, centred), small.
        const W = 36;
        const H = Math.round(W * ratio);
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        const k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        g.drawImage(img, (W - img.naturalWidth * k) / 2, (H - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
        const lum = (y0: number, y1: number) => {
          const d = g.getImageData(0, y0, W, Math.max(1, y1 - y0)).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          return sum / (d.length / 4);
        };
        const next = { top: lum(0, Math.round(W * 0.14)) > 0.62, body: lum(Math.round(H * 0.45), H) > 0.62 };
        tones.set(key, next);
        if (!cancelled) setTone(next);
      } catch {
        /* unreadable: keep light text */
      }
    };
    img.src = `${url}${url.includes('?') ? '&' : '?'}tone`;
    return () => {
      cancelled = true;
    };
  }, [key]);
  return tone;
}

// ---------- launcher colours from com.miui.home/theme_values.xml ----------

export interface HomeColors {
  label: string;
  labelDark: string;
  shadow: string | null;
  shadowLight: string | null;
}
const DEFAULT_HOME: HomeColors = { label: '#ffffff', labelDark: 'rgba(0,0,0,0.8)', shadow: 'rgba(0,0,0,0.3)', shadowLight: null };

export function useHomeColors(files: FileInfo[]): HomeColors {
  const source = useMemo(() => files.find((f) => f.component === 'home' && /(^|\/|!\/)theme_values\.xml$/i.test(f.path) && !/nightmode/i.test(f.path)), [files]);
  const [colors, setColors] = useState<HomeColors>(DEFAULT_HOME);
  useEffect(() => {
    if (!source) return setColors(DEFAULT_HOME);
    let cancelled = false;
    api
      .fileText(source.path, 'main')
      .then(({ text }) => {
        if (cancelled) return;
        const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'text/xml');
        const get = (name: string) => doc.querySelector(`color[name="${name}"]`)?.textContent?.trim() ?? null;
        const shadow = (v: string | null, fallback: string | null) => (v === null ? fallback : /^#00/i.test(v) ? null : argb(v));
        setColors({
          label: get('icon_title_text') ? argb(get('icon_title_text')) : DEFAULT_HOME.label,
          labelDark: get('icon_title_text_dark') ? argb(get('icon_title_text_dark')) : DEFAULT_HOME.labelDark,
          shadow: shadow(get('icon_title_text_shadow'), DEFAULT_HOME.shadow),
          shadowLight: shadow(get('icon_title_text_shadow_light'), null),
        });
      })
      .catch(() => !cancelled && setColors(DEFAULT_HOME));
    return () => {
      cancelled = true;
    };
  }, [source?.path, source?.rev]);
  return colors;
}

// ---------- status bar ----------

function Signal({ h, color }: { h: number; color: string }) {
  return (
    <svg width={h * 1.25} height={h} viewBox="0 0 20 16" fill={color} aria-hidden="true">
      <rect x="0" y="11" width="3.2" height="5" rx="1" />
      <rect x="5.6" y="7.5" width="3.2" height="8.5" rx="1" />
      <rect x="11.2" y="4" width="3.2" height="12" rx="1" />
      <rect x="16.8" y="0" width="3.2" height="16" rx="1" />
    </svg>
  );
}

function Wifi({ h, color }: { h: number; color: string }) {
  return (
    <svg width={h * 1.3} height={h} viewBox="0 0 26 20" fill={color} aria-hidden="true">
      <path d="M13 20 L8.6 15.2 a6.4 6.4 0 0 1 8.8 0 Z" />
      <path d="M5.9 12.3 a10.3 10.3 0 0 1 14.2 0 L18.2 14.4 a7.6 7.6 0 0 0 -10.4 0 Z" />
      <path d="M2.4 8.6 a15.3 15.3 0 0 1 21.2 0 L21.7 10.7 a12.6 12.6 0 0 0 -17.4 0 Z" />
      <path d="M0 5 a19.5 19.5 0 0 1 26 0 L24.1 7.1 a16.8 16.8 0 0 0 -22.2 0 Z" opacity="0.98" />
    </svg>
  );
}

function Battery({ w, level, color }: { w: number; level: number; color: string }) {
  return (
    <svg width={w} height={w * 0.54} viewBox="0 0 26 14" aria-hidden="true">
      <rect x="0.8" y="0.8" width="21.4" height="12.4" rx="3.6" fill="none" stroke={color} strokeWidth="1.6" opacity="0.55" />
      <rect x="2.8" y="2.8" width={17.4 * level} height="8.4" rx="1.8" fill={color} />
      <path d="M23.6 4.6 h0.6 a1.4 1.4 0 0 1 1.4 1.4 v2 a1.4 1.4 0 0 1 -1.4 1.4 h-0.6 Z" fill={color} opacity="0.55" />
    </svg>
  );
}

export function StatusBar({ w, left, font, dark, onClick }: { w: number; left: string; font?: string; dark?: boolean; onClick?: () => void }) {
  const color = dark ? 'rgba(0,0,0,0.88)' : '#fff';
  const fs = w * M.statusFont;
  const style: CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    top: w * M.statusY - fs,
    height: fs * 2,
    paddingLeft: w * M.statusPadL,
    paddingRight: w * M.statusPadR,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color,
    fontFamily: font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT,
    fontSize: fs,
    fontWeight: 500,
    lineHeight: 1,
    zIndex: 4,
    background: 'none',
    border: 0,
    margin: 0,
    textAlign: 'left',
    cursor: onClick ? 'pointer' : undefined,
  };
  const body = (
    <>
      <span style={{ whiteSpace: 'nowrap' }}>{left}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: w * 0.016 }}>
        <Signal h={w * 0.033} color={color} />
        <Wifi h={w * 0.031} color={color} />
        <span style={{ display: 'flex', alignItems: 'center', gap: w * 0.008, marginLeft: w * 0.006 }}>
          <Battery w={w * 0.058} level={0.82} color={color} />
          <span style={{ fontSize: w * 0.035 }}>82%</span>
        </span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="pm-status pp-click" title="Status bar, notifications and control center (System UI)" style={style} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="pm-status" style={style}>
      {body}
    </div>
  );
}

// ---------- home screen ----------

export interface HomeIcon {
  file: FileInfo;
  label: string;
}

export type HomePage = 'home' | 'apps';

/** The theme's page indicator dots (com.miui.home workspace_seekpoint_*), dark ones over light wallpapers. */
export function usePageDots(files: FileInfo[], dark: boolean) {
  return useMemo(() => {
    const rank = (f: FileInfo) => ['xxxhdpi', 'xxhdpi', 'nxhdpi', 'xhdpi', 'hdpi', 'mdpi'].indexOf(f.density ?? '') + 1 || 9;
    const find = (name: string) =>
      files
        .filter((f) => f.component === 'home' && f.kind === 'image' && f.path.toLowerCase().endsWith(`/${name}.png`))
        .sort((x, y) => rank(x) - rank(y))[0];
    const on = (dark && find('workspace_seekpoint_highlight_dark')) || find('workspace_seekpoint_highlight');
    const off = (dark && find('workspace_seekpoint_normal_dark')) || find('workspace_seekpoint_normal');
    return on && off ? { on, off } : null;
  }, [files, dark]);
}

/** How many icon rows fit on a launcher page of this shape (6 on a 20:9 phone). */
export function gridRows(w: number, h: number) {
  let rows = 1;
  while (h - w * (M.lastRow + rows * M.rowPitch) > w * 0.2) rows++;
  return rows;
}

/**
 * The theme on the HyperOS launcher grid: 4 columns, rows counted up from the
 * dock, four dock icons without labels. The first page has the theme's own
 * clock widget on the top two rows and two rows of icons at the bottom; the
 * second page is a full page of icons. Only what the theme provides is drawn
 * (wallpaper, icons, clock widget, page dots, label colours, font).
 */
export function HomeScreen({
  w,
  h,
  icons,
  font,
  tone,
  colors,
  page = 'home',
  clock,
  dots,
  onIcon,
  grid: gridOverride,
}: {
  w: number;
  h: number;
  icons: HomeIcon[];
  font?: string;
  tone: Tone;
  colors: HomeColors;
  page?: HomePage;
  clock?: string | null;
  dots?: { on: FileInfo; off: FileInfo } | null;
  onIcon?: (path: string) => void;
  /** Icons for the grid instead of the page's usual slice (the dock keeps the first four). */
  grid?: HomeIcon[];
}) {
  const size = w * M.icon;
  const rows = gridRows(w, h);
  const dock = icons.slice(0, 4);
  const rest = icons.slice(12, 12 + rows * 4);
  const grid = gridOverride ? gridOverride.slice(0, (page === 'home' ? 2 : rows) * 4) : page === 'home' ? icons.slice(4, 12) : rest.length ? rest : icons.slice(4, 4 + rows * 4);
  // Centre of a row counted from the top of the page.
  const rowY = (row: number) => h - w * M.lastRow - (rows - 1 - row) * w * M.rowPitch;
  const firstRow = page === 'home' ? rows - 2 : 0;
  const label = tone.body ? colors.labelDark : colors.label;
  const shadow = tone.body ? colors.shadowLight : colors.shadow;
  const fontFamily = font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT;

  const iconAt = (icon: HomeIcon, cx: number, cy: number, withLabel: boolean, key: string) => {
    const img = <img src={resourceUrl('main', icon.file.path, icon.file.rev)} alt="" draggable={false} style={{ width: size, height: size, display: 'block', objectFit: 'contain' }} />;
    const lbl = withLabel ? (
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: size / 2 + w * M.label,
          transform: 'translate(-50%, -50%)',
          width: w * 0.23,
          textAlign: 'center',
          fontSize: w * M.labelFont,
          lineHeight: 1.2,
          color: label,
          textShadow: shadow ? `0 ${w * 0.003}px ${w * 0.008}px ${shadow}` : 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {icon.label}
      </span>
    ) : null;
    const style: CSSProperties = { position: 'absolute', left: cx - size / 2, top: cy - size / 2, width: size, height: size, padding: 0, border: 0, background: 'none', zIndex: 3, pointerEvents: 'auto' };
    return onIcon ? (
      <button key={key} type="button" className="pm-icon pp-click" title={`Change this icon · ${icon.file.path}`} style={style} onClick={() => onIcon(icon.file.path)}>
        {img}
        {lbl}
      </button>
    ) : (
      <div key={key} className="pm-icon" title={icon.file.path} style={style}>
        {img}
        {lbl}
      </div>
    );
  };

  const nodes: ReactNode[] = [];
  if (page === 'home' && clock && rows >= 4) {
    // The 4x2 widget fills the cells of the top two rows.
    const height = w * M.rowPitch * 2;
    nodes.push(
      <div key="clock" style={{ position: 'absolute', left: 0, top: rowY(0) - (w * M.rowPitch) / 2, width: w, height }}>
        <PhoneWidget path={clock} width={w} height={height} font={font} />
      </div>,
    );
  }
  grid.forEach((icon, i) => nodes.push(iconAt(icon, w * M.cols[i % 4], rowY(firstRow + Math.floor(i / 4)), true, `g${i}`)));
  dock.forEach((icon, i) => nodes.push(iconAt(icon, w * M.cols[i], h - w * M.dockY, false, `d${i}`)));
  if (dots) {
    const k = w / 1080;
    const dot = (f: FileInfo, i: number) => (
      <img key={i} src={resourceUrl('main', f.path, f.rev)} alt="" draggable={false} style={{ width: (f.width ?? 24) * k, height: (f.height ?? 24) * k, display: 'block' }} />
    );
    nodes.push(
      <div key="dots" aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: h - w * M.dotsY, transform: 'translateY(-50%)', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: w * 0.012 }}>
        {dot(page === 'home' ? dots.on : dots.off, 0)}
        {dot(page === 'apps' ? dots.on : dots.off, 1)}
      </div>,
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily, pointerEvents: 'none', zIndex: 3 }}>
      {nodes}
    </div>
  );
}

// ---------- lock screen ----------

/** HyperOS's own lock screen clock, for themes without a lock screen layout. */
export function SystemLockClock({ w, now, font, dark }: { w: number; now: Date; font?: string; dark?: boolean }) {
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: w * 0.3, textAlign: 'center', color: dark ? 'rgba(0,0,0,0.85)' : '#fff', fontFamily: font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT, zIndex: 3 }}>
      <div style={{ fontSize: w * 0.2, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.02em' }}>{time}</div>
      <div style={{ fontSize: w * 0.04, marginTop: w * 0.025, fontWeight: 500 }}>{date}</div>
    </div>
  );
}
