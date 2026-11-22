// Makes the theme's preview/ pictures (the covers Theme Manager shows) from the
// same mock-ups as the Preview view: launcher pages, lock screen pages, icon
// pages, the recent apps screen ("statusbar" in Theme Manager's naming) and
// Messaging ("mms"). Each screen is laid out off-screen at full resolution,
// rasterized to JPEG, shown for review, and only saved when asked.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { toJpeg } from 'html-to-image';
import { Check, Images, Loader2, RefreshCw } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import type { FileInfo } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { Modal } from '../common/Modal';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { PhoneLockScreen, useClockWidgetPath, useHasLockLayout, useLockPages } from './MamlPreview';
import { gridRows, HomeScreen, StatusBar, SystemLockClock, useHomeColors, usePageDots, useWallpaperTone, type HomeIcon } from './PhoneMock';
import { findWallpaper, pickIcons, useClock } from './PreviewView';

const SYSTEM_FONT = 'MiSans, "Mi Sans", Roboto, "Segoe UI", system-ui, sans-serif';

interface Shot {
  /** File name stem after the language prefix, e.g. launcher_0. */
  id: string;
  group: string;
  label: string;
  node: ReactNode;
}

const GROUPS: [string, string][] = [
  ['launcher', 'Home screen'],
  ['lockscreen', 'Lock screen'],
  ['icons', 'Icons'],
  ['statusbar', 'Recent apps (status bar)'],
  ['mms', 'Messages'],
];

// ---------- small helpers ----------

/** A strong colour from an icon (its most saturated pixels on average), for app accents. */
function useIconAccent(file: FileInfo | undefined, fallback: string) {
  const [color, setColor] = useState(fallback);
  useEffect(() => {
    setColor(fallback);
    if (!file) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(img, 0, 0, 32, 32);
        const d = g.getImageData(0, 0, 32, 32).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 160) continue;
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          if (max < 60 || (max - min) / max < 0.35) continue;
          r += d[i];
          gg += d[i + 1];
          b += d[i + 2];
          n++;
        }
        if (n > 12 && !cancelled) setColor(`rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`);
      } catch {
        /* keep the fallback */
      }
    };
    img.src = `${resourceUrl('main', file.path, file.rev)}&accent`;
    return () => {
      cancelled = true;
    };
  }, [file?.path, file?.rev, fallback]);
  return color;
}

/** Waits until a screen's pictures are loaded and its layout has stopped adding pieces. */
async function settle(node: HTMLElement) {
  const start = performance.now();
  let last = -1;
  let stable = 0;
  while (performance.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 200));
    const imgs = [...node.querySelectorAll('img')];
    const count = imgs.length + node.querySelectorAll('canvas, video').length;
    if (!imgs.some((i) => !i.complete) && count === last) {
      if (++stable >= 3) break;
    } else stable = 0;
    last = count;
  }
  await document.fonts.ready;
  await Promise.all([...node.querySelectorAll('img')].map((i) => i.decode().catch(() => undefined)));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** @font-face for the theme font as a data URL: pictures drawn from the DOM cannot reach the app's loaded fonts. */
async function themeFontCss(file: FileInfo | undefined, family: string | undefined) {
  if (!file || !family) return '';
  try {
    const response = await fetch(`${resourceUrl('main', file.path, file.rev)}&font`);
    if (!response.ok) return '';
    const blob = await response.blob();
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return `@font-face { font-family: ${family}; src: url(${url}); }`;
  } catch {
    return '';
  }
}

function iconFor(icons: HomeIcon[], label: string, index: number) {
  return icons.find((i) => i.label === label) ?? icons[index % Math.max(1, icons.length)];
}

function Wallpaper({ file, blur = 0, dim = 0 }: { file: FileInfo | undefined; blur?: number; dim?: number }) {
  return (
    <>
      {file ? (
        <img
          src={resourceUrl('main', file.path, file.rev)}
          alt=""
          style={{ position: 'absolute', inset: blur ? -blur * 2 : 0, width: blur ? `calc(100% + ${blur * 4}px)` : '100%', height: blur ? `calc(100% + ${blur * 4}px)` : '100%', objectFit: 'cover', filter: blur ? `blur(${blur}px)` : undefined }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #2b2f3a, #141519)' }} />
      )}
      {dim > 0 && <div style={{ position: 'absolute', inset: 0, background: `rgba(0,0,0,${dim})` }} />}
    </>
  );
}

function GestureBar({ w, h, dark }: { w: number; h: number; dark?: boolean }) {
  return <div style={{ position: 'absolute', left: w * 0.345, width: w * 0.31, top: h - w * 0.025, height: w * 0.011, borderRadius: w, background: dark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)', zIndex: 6 }} />;
}

// ---------- recent apps ----------

function RecentCard({ w, title, kind, font }: { w: number; title: string; kind: 'clock' | 'list' | 'search'; font: string }) {
  const u = w / 360;
  const row: CSSProperties = { background: '#fff', borderRadius: 14 * u, padding: `${10 * u}px ${12 * u}px`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
  const line = (width: string, h = 7, color = '#e4e4e7') => <div style={{ width, height: h * u, borderRadius: h * u, background: color }} />;
  let body: ReactNode;
  if (kind === 'clock') {
    body = ['06:00', '07:00', '08:00'].map((t) => (
      <div key={t} style={row}>
        <div>
          <div style={{ fontSize: 19 * u, color: '#555', fontWeight: 300 }}>{t}</div>
          {line(`${30 * u}px`, 5)}
        </div>
        <div style={{ width: 28 * u, height: 16 * u, borderRadius: 16 * u, background: '#e4e4e7', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 2 * u, top: 2 * u, width: 12 * u, height: 12 * u, borderRadius: '50%', background: '#fff' }} />
        </div>
      </div>
    ));
  } else if (kind === 'list') {
    body = [0.7, 0.55, 0.62, 0.48, 0.66].map((k, i) => (
      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 * u, padding: `${4 * u}px 0` }}>
        <div style={{ width: 24 * u, height: 24 * u, borderRadius: '50%', background: '#e4e4e7', flex: 'none' }} />
        {line(`${k * 100}%`, 8, '#d4d4d8')}
      </div>
    ));
  } else {
    body = (
      <>
        <div style={{ height: 30 * u, borderRadius: 30 * u, background: '#ececee', display: 'flex', alignItems: 'center', paddingLeft: 12 * u, gap: 8 * u }}>
          <div style={{ width: 9 * u, height: 9 * u, borderRadius: '50%', border: `${1.5 * u}px solid #888` }} />
          {line('45%', 6, '#bdbdc2')}
        </div>
        {[0.6, 0.45, 0.7, 0.5].map((k, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 * u, padding: `${6 * u}px 0` }}>
            <div style={{ width: 18 * u, height: 18 * u, borderRadius: 6 * u, background: '#e4e4e7', flex: 'none' }} />
            {line(`${k * 100}%`, 7, '#d4d4d8')}
          </div>
        ))}
      </>
    );
  }
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#f7f7f8', borderRadius: 24 * u, overflow: 'hidden', fontFamily: font, padding: `${34 * u}px ${12 * u}px`, display: 'flex', flexDirection: 'column', gap: 8 * u }}>
      <div style={{ fontSize: 22 * u, color: '#222', fontWeight: 400, padding: `0 ${4 * u}px ${6 * u}px` }}>{title}</div>
      {body}
    </div>
  );
}

function RecentsScreen({ w, h, icons, wallpaper, font, time, clearIcon }: { w: number; h: number; icons: HomeIcon[]; wallpaper: FileInfo | undefined; font?: string; time: string; clearIcon: HomeIcon | undefined }) {
  const family = font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT;
  const apps: { label: string; title: string; kind: 'clock' | 'list' | 'search' }[] = [
    { label: 'Clock', title: 'Alarm', kind: 'clock' },
    { label: 'Contacts', title: 'Contacts', kind: 'list' },
    { label: 'Messages', title: 'Messaging', kind: 'search' },
    { label: 'Settings', title: 'Settings', kind: 'search' },
  ];
  const cardW = w * 0.433;
  const cardH = h * 0.425;
  const cols = [w * 0.044, w * 0.523];
  const rows = [h * 0.355, h * 0.872];
  const icon = w * 0.053;
  const clear = w * 0.124;
  return (
    <>
      <Wallpaper file={wallpaper} blur={w * 0.03} dim={0.35} />
      <StatusBar w={w} left={time} font={font} />
      {apps.map((app, i) => {
        const x = cols[i % 2];
        const y = rows[Math.floor(i / 2)];
        const ic = iconFor(icons, app.label, i);
        return (
          <div key={app.label} style={{ position: 'absolute', left: x, top: y - icon * 1.6, width: cardW, fontFamily: family, zIndex: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: w * 0.028, height: icon, marginLeft: w * 0.027, marginBottom: icon * 0.6 }}>
              {ic && <img src={resourceUrl('main', ic.file.path, ic.file.rev)} alt="" style={{ width: icon, height: icon, objectFit: 'contain' }} />}
              <span style={{ color: '#fff', fontSize: w * 0.032 }}>{ic?.label === app.label ? app.label : ic?.label ?? app.label}</span>
            </div>
            <div style={{ position: 'relative', width: cardW, height: cardH }}>
              <RecentCard w={w} title={app.title} kind={app.kind} font={family} />
            </div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: (w - clear) / 2, top: h * 0.911 - clear / 2, width: clear, height: clear, borderRadius: '50%', background: clearIcon ? 'none' : '#fff', display: 'grid', placeItems: 'center', boxShadow: clearIcon ? undefined : `0 ${w * 0.006}px ${w * 0.03}px rgba(0,0,0,0.25)`, zIndex: 5 }}>
        {clearIcon ? (
          <img src={resourceUrl('main', clearIcon.file.path, clearIcon.file.rev)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <svg width={clear * 0.36} height={clear * 0.36} viewBox="0 0 24 24" stroke="#111" strokeWidth="2.4" strokeLinecap="round">
            <path d="M4 4 L20 20 M20 4 L4 20" />
          </svg>
        )}
      </div>
      <GestureBar w={w} h={h} />
    </>
  );
}

// ---------- messages ----------

const CHATS = [
  { name: 'Alex', text: 'See you at 7 then!', time: '18:42' },
  { name: 'Mum', text: 'Did you get home okay?', time: '17:05' },
  { name: 'Sam', text: 'Sent you the photos 📷', time: '14:20' },
  { name: 'Jordan', text: 'Thanks, that works for me', time: 'Yesterday' },
  { name: 'Taylor', text: 'Happy birthday! 🎉', time: 'Mon' },
  { name: 'Robin', text: 'On my way', time: 'Sun' },
];

function GearIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function MessagesList({ w, h, font, time, accent }: { w: number; h: number; font?: string; time: string; accent: string }) {
  const u = w / 360;
  const family = font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fbfbfb', fontFamily: family, color: '#111' }}>
      <StatusBar w={w} left={time} font={font} dark />
      <div style={{ position: 'absolute', right: 22 * u, top: 34 * u }}>
        <GearIcon size={22 * u} color="#222" />
      </div>
      <div style={{ position: 'absolute', left: 22 * u, top: 72 * u, fontSize: 32 * u, fontWeight: 300 }}>Messaging</div>
      <div style={{ position: 'absolute', left: 20 * u, right: 20 * u, top: 122 * u, height: 36 * u, borderRadius: 36 * u, background: '#efefef', display: 'flex', alignItems: 'center', gap: 10 * u, paddingLeft: 16 * u, color: '#666', fontSize: 14 * u }}>
        <svg width={15 * u} height={15 * u} viewBox="0 0 24 24" fill="none" stroke="#777" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="7" />
          <path d="M16 16 L21 21" />
        </svg>
        Search messages
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 176 * u }}>
        {CHATS.map((c, i) => (
          <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 14 * u, padding: `${11 * u}px ${22 * u}px` }}>
            <div style={{ width: 44 * u, height: 44 * u, borderRadius: '50%', background: accent, opacity: 0.25 + ((i * 37) % 60) / 100, flex: 'none', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 18 * u, fontWeight: 500 }}>
              {c.name[0]}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 16 * u, fontWeight: 500 }}>{c.name}</span>
                <span style={{ fontSize: 11.5 * u, color: '#999' }}>{c.time}</span>
              </div>
              <div style={{ fontSize: 13 * u, color: '#888', marginTop: 3 * u, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.text}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 22 * u, top: h - 96 * u, width: 56 * u, height: 56 * u, borderRadius: '50%', background: accent, display: 'grid', placeItems: 'center', boxShadow: `0 ${4 * u}px ${14 * u}px rgba(0,0,0,0.18)` }}>
        <svg width={24 * u} height={24 * u} viewBox="0 0 24 24" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <path d="M12 4v16M4 12h16" />
        </svg>
      </div>
      <GestureBar w={w} h={h} dark />
    </div>
  );
}

function MessagesChat({ w, h, font, time, accent }: { w: number; h: number; font?: string; time: string; accent: string }) {
  const u = w / 360;
  const family = font ? `${font}, ${SYSTEM_FONT}` : SYSTEM_FONT;
  const bubbles: { me: boolean; text: string }[] = [
    { me: false, text: 'Hey! Are we still on for dinner tonight?' },
    { me: true, text: 'Yes! Booked a table for 7 🍝' },
    { me: false, text: 'Perfect. Should I bring anything?' },
    { me: true, text: 'Just yourself 😄' },
    { me: false, text: 'See you at 7 then!' },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fbfbfb', fontFamily: family, color: '#111' }}>
      <StatusBar w={w} left={time} font={font} dark />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 44 * u, height: 52 * u, display: 'flex', alignItems: 'center', gap: 14 * u, padding: `0 ${18 * u}px` }}>
        <svg width={20 * u} height={20 * u} viewBox="0 0 24 24" fill="none" stroke="#222" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 4 7 12l8 8" />
        </svg>
        <span style={{ fontSize: 19 * u, fontWeight: 500, flex: 1 }}>Alex</span>
      </div>
      <div style={{ position: 'absolute', left: 16 * u, right: 16 * u, top: 120 * u, display: 'flex', flexDirection: 'column', gap: 12 * u }}>
        <div style={{ alignSelf: 'center', fontSize: 11.5 * u, color: '#999', marginBottom: 4 * u }}>Today 18:30</div>
        {bubbles.map((b, i) => (
          <div
            key={i}
            style={{
              alignSelf: b.me ? 'flex-end' : 'flex-start',
              maxWidth: '74%',
              padding: `${11 * u}px ${15 * u}px`,
              borderRadius: 20 * u,
              background: b.me ? accent : '#ececee',
              color: b.me ? '#fff' : '#222',
              fontSize: 15 * u,
              lineHeight: 1.35,
            }}
          >
            {b.text}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 14 * u, right: 14 * u, top: h - 76 * u, height: 46 * u, borderRadius: 46 * u, background: '#efefef', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `0 ${6 * u}px 0 ${18 * u}px`, color: '#999', fontSize: 14 * u }}>
        Text message
        <div style={{ width: 36 * u, height: 36 * u, borderRadius: '50%', background: accent, display: 'grid', placeItems: 'center' }}>
          <svg width={17 * u} height={17 * u} viewBox="0 0 24 24" fill="#fff">
            <path d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z" />
          </svg>
        </div>
      </div>
      <GestureBar w={w} h={h} dark />
    </div>
  );
}

// ---------- the dialog ----------

export function PreviewGenerator({ res, wallPath, onClose, onSaved }: { res: { w: number; h: number }; wallPath: string | null; onClose: () => void; onSaved?: () => void }) {
  const project = useStore((s) => s.project);
  const files = useMemo(() => project?.files ?? [], [project]);
  const fontFile = useMemo(() => themeFontFile(files), [files]);
  const font = usePackageFont(fontFile).family ?? undefined;
  const { w, h } = res;

  const homeWall = (wallPath && files.find((f) => f.path === wallPath)) || findWallpaper(files, false);
  const lockWall = (wallPath && files.find((f) => f.path === wallPath)) || findWallpaper(files, true);
  const icons = useMemo(() => pickIcons(files), [files]);
  const colors = useHomeColors(files);
  const tone = useWallpaperTone(homeWall, h / w);
  const lockTone = useWallpaperTone(lockWall, h / w);
  const clock = useClockWidgetPath();
  const dots = usePageDots(files, tone.body);
  const lockPages = useLockPages();
  const hasLock = useHasLockLayout();
  const now = useClock();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const accent = useIconAccent(iconFor(icons, 'Messages', 1)?.file, '#f5a623');
  const clearIcon = useMemo(() => {
    const hit = files.find((f) => f.kind === 'image' && (f.component === 'home' || f.component === 'systemui') && /(clear_all|recent[^/]*clear|clear[^/]*recent|btn_clear)[^/]*\.png$/i.test(f.path) && !/(pressed|_p\.png$)/i.test(f.path));
    return hit ? { file: hit, label: 'clear' } : undefined;
  }, [files]);

  const prefix = useMemo(() => {
    const names = files.filter((f) => f.component === 'previews').map((f) => fileName(f.path));
    if (names.some((n) => /^en_US_/i.test(n))) return 'en_US_';
    if (names.some((n) => /^preview_/i.test(n))) return 'preview_';
    return 'en_US_';
  }, [files]);

  const shots = useMemo<Shot[]>(() => {
    const out: Shot[] = [];
    const home = (page: 'home' | 'apps', grid?: HomeIcon[]) => (
      <>
        <Wallpaper file={homeWall} />
        <StatusBar w={w} left={time} font={font} dark={tone.top} />
        <HomeScreen w={w} h={h} icons={icons} font={font} tone={tone} colors={colors} page={page} clock={grid ? null : clock} dots={dots} grid={grid} />
      </>
    );
    out.push({ id: 'launcher_0', group: 'launcher', label: 'Home · first page', node: home('home') });
    out.push({ id: 'launcher_1', group: 'launcher', label: 'Home · apps page', node: home('apps') });

    const lock = (value: number | null) =>
      hasLock ? (
        <>
          <PhoneLockScreen width={w} height={h} font={font} page={value !== null && lockPages ? { name: lockPages.name, value } : null} />
          <StatusBar w={w} left="" font={font} />
        </>
      ) : (
        <>
          <Wallpaper file={lockWall} />
          <StatusBar w={w} left="" font={font} dark={lockTone.top} />
          <SystemLockClock w={w} now={now} font={font} dark={lockTone.top} />
        </>
      );
    if (hasLock && lockPages) lockPages.values.forEach((value, i) => out.push({ id: `lockscreen_${i}`, group: 'lockscreen', label: `Lock screen · page ${i + 1}`, node: lock(value) }));
    else out.push({ id: 'lockscreen_0', group: 'lockscreen', label: 'Lock screen', node: lock(null) });

    if (icons.length) {
      const perPage = gridRows(w, h) * 4;
      const rest = icons.slice(4);
      for (let i = 0; i < 2 && i * perPage < rest.length; i++) {
        const grid = rest.slice(i * perPage, (i + 1) * perPage);
        if (i > 0 && grid.length < 4) break;
        out.push({ id: `icons_${i}`, group: 'icons', label: `Icons · page ${i + 1}`, node: home('apps', grid) });
      }
    }

    out.push({ id: 'statusbar_0', group: 'statusbar', label: 'Recent apps', node: <RecentsScreen w={w} h={h} icons={icons} wallpaper={homeWall} font={font} time={time} clearIcon={clearIcon} /> });
    out.push({ id: 'mms_0', group: 'mms', label: 'Messages · list', node: <MessagesList w={w} h={h} font={font} time={time} accent={accent} /> });
    out.push({ id: 'mms_1', group: 'mms', label: 'Messages · chat', node: <MessagesChat w={w} h={h} font={font} time={time} accent={accent} /> });
    return out;
  }, [w, h, homeWall, lockWall, time, now, font, tone, lockTone, icons, colors, clock, dots, hasLock, lockPages, clearIcon, accent]);

  // Rendering: every screen mounted off-screen, captured one after another.
  const [run, setRun] = useState(0);
  const [rendering, setRendering] = useState(true);
  const [progress, setProgress] = useState(0);
  const [images, setImages] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [removeOld, setRemoveOld] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    setProgress(0);
    setError(null);
    (async () => {
      // Let the font and the lock screen layout load before the first capture.
      await new Promise((r) => setTimeout(r, 300));
      const fontCss = await themeFontCss(fontFile, font);
      const next: Record<string, string> = {};
      let failed = 0;
      const list = shotsRef.current;
      for (let i = 0; i < list.length; i++) {
        if (cancelled) return;
        const node = nodes.current.get(list[i].id);
        if (!node) continue;
        try {
          await settle(node);
          next[list[i].id] = await toJpeg(node, { width: w, height: h, canvasWidth: w, canvasHeight: h, pixelRatio: 1, quality: 0.9, backgroundColor: '#000', fontEmbedCSS: fontCss, cacheBust: false });
        } catch (err) {
          console.error('Preview capture failed', list[i].id, err);
          failed++;
        }
        if (!cancelled) setProgress(i + 1);
      }
      if (cancelled) return;
      setImages(next);
      setChosen(new Set(Object.keys(next)));
      if (failed) setError(`${failed} screen${failed === 1 ? '' : 's'} could not be drawn.`);
      setRendering(false);
    })();
    return () => {
      cancelled = true;
    };
    // Re-render only on request or a new size; the screens read their latest content when captured.
  }, [run, w, h, font]);

  const save = async () => {
    const picked = shots.filter((s) => chosen.has(s.id) && images[s.id]);
    if (!picked.length) return;
    setSaving(true);
    try {
      const out: { path: string; bytes: Uint8Array }[] = [];
      for (const s of picked) out.push({ path: `preview/${prefix}${s.id}.jpg`, bytes: new Uint8Array(await (await fetch(images[s.id])).arrayBuffer()) });
      const ok = await A.savePreviewImages(out, removeOld);
      if (ok) {
        onSaved?.();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const existing = files.filter((f) => f.component === 'previews' && f.kind === 'image').length;
  const thumbW = 132;

  return (
    <Modal
      wide
      title="Generate preview pictures"
      icon={<Images width={16} className="muted" />}
      onClose={onClose}
      footer={
        <>
          <label className="check" style={{ marginRight: 'auto' }} title="Deletes every other picture in preview/, e.g. covers that still show the theme this one was remixed from.">
            <input type="checkbox" checked={removeOld} disabled={!existing} onChange={(e) => setRemoveOld(e.target.checked)} /> Remove the other {existing || ''} preview picture{existing === 1 ? '' : 's'}
          </label>
          <button className="btn" disabled={rendering || saving} onClick={() => setRun((r) => r + 1)}>
            <RefreshCw /> Draw again
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={rendering || saving || !chosen.size} onClick={() => void save()}>
            {saving ? <Loader2 className="spin" /> : <Check />} Add {chosen.size} to theme
          </button>
        </>
      }
    >
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
        Drawn at {w} × {h} from the theme's wallpaper, icons, font, launcher colours and lock screen, saved as preview/{prefix}*.jpg. Files with the same names are replaced. The recent apps and Messages screens are generic stand-ins showing the theme's icons, font and wallpaper.
      </p>
      {rendering ? (
        <div className="row" style={{ gap: 8, padding: '24px 0', justifyContent: 'center' }}>
          <Loader2 className="spin" /> Drawing {Math.min(progress + 1, shots.length)} of {shots.length}…
        </div>
      ) : (
        <>
          {error && <p className="badge badge-warning" style={{ alignSelf: 'flex-start' }}>{error}</p>}
          {GROUPS.map(([group, title]) => {
            const list = shots.filter((s) => s.group === group && images[s.id]);
            if (!list.length) return null;
            return (
              <div key={group}>
                <h3 style={{ fontSize: 'var(--fs-sm)', margin: '4px 0 8px' }}>{title}</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {list.map((s) => {
                    const on = chosen.has(s.id);
                    return (
                      <label key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 5, width: thumbW, cursor: 'pointer', opacity: on ? 1 : 0.45 }} title={`preview/${prefix}${s.id}.jpg`}>
                        <img src={images[s.id]} alt={s.label} style={{ width: thumbW, height: (thumbW * h) / w, objectFit: 'cover', borderRadius: 8, outline: on ? '2px solid var(--accent)' : '1px solid var(--line)' }} />
                        <span className="check" style={{ fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              setChosen((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                return next;
                              })
                            }
                          />
                          {s.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
      {rendering && (
        // Off-screen stage at full resolution; each child is captured as it is laid out.
        <div aria-hidden="true" style={{ position: 'fixed', left: -100000, top: 0, pointerEvents: 'none', zIndex: -1 }}>
          {shots.map((s) => (
            <div
              key={`${run}-${s.id}`}
              ref={(el) => {
                if (el) nodes.current.set(s.id, el);
                else nodes.current.delete(s.id);
              }}
              style={{ position: 'relative', width: w, height: h, overflow: 'hidden', background: '#000' }}
            >
              {s.node}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
