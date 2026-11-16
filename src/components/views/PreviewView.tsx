import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, Info, Maximize, RefreshCw, Save, Smartphone } from 'lucide-react';
import { resourceUrl, screenshotUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import { formatTime } from '../../lib/format';
import type { FileInfo } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { useDeviceSummary } from '../shell/deviceSummary';

type Screen = 'lock' | 'home' | 'previews' | 'screenshot';

const PRESETS = [
  { id: '1080x2400', label: '1080 × 2400 (20:9)', w: 1080, h: 2400 },
  { id: '1220x2712', label: '1220 × 2712 (20:9, 1.5K)', w: 1220, h: 2712 },
  { id: '1440x3200', label: '1440 × 3200 (20:9, 2K)', w: 1440, h: 3200 },
  { id: '1080x2340', label: '1080 × 2340 (19.5:9)', w: 1080, h: 2340 },
];

// Public Android package names → labels for the static home mockup.
const HOME_APPS: [string, string][] = [
  ['com.android.contacts', 'Contacts'],
  ['com.android.mms', 'Messages'],
  ['com.android.camera', 'Camera'],
  ['com.miui.gallery', 'Gallery'],
  ['com.android.settings', 'Settings'],
  ['com.android.thememanager', 'Themes'],
  ['com.android.deskclock', 'Clock'],
  ['com.miui.calculator', 'Calculator'],
  ['com.android.calendar', 'Calendar'],
  ['com.miui.weather2', 'Weather'],
  ['com.miui.notes', 'Notes'],
  ['com.miui.securitycenter', 'Security'],
  ['com.mi.android.globalFileexplorer', 'Files'],
  ['com.android.fileexplorer', 'Files'],
  ['com.miui.player', 'Music'],
  ['com.miui.videoplayer', 'Video'],
  ['com.android.browser', 'Browser'],
  ['com.mi.globalbrowser', 'Browser'],
  ['com.android.vending', 'Play Store'],
  ['com.android.soundrecorder', 'Recorder'],
];

function stem(path: string) {
  return fileName(path).replace(/\.(png|webp|jpg|jpeg)$/i, '');
}

function pickIcons(files: FileInfo[]) {
  const icons = files.filter((f) => f.component === 'icons' && f.kind === 'image' && !f.ninePatch);
  const byStem = new Map<string, FileInfo>();
  // Prefer the highest density variant of each icon.
  const rank = (f: FileInfo) => ['xxxhdpi', 'xxhdpi', 'nxhdpi', 'xhdpi', 'hdpi', 'mdpi'].indexOf(f.density ?? '') + 1 || 9;
  for (const f of icons) {
    const key = stem(f.path);
    const current = byStem.get(key);
    if (!current || rank(f) < rank(current)) byStem.set(key, f);
  }
  const matched: { file: FileInfo; label: string }[] = [];
  const used = new Set<string>();
  for (const [pkg, label] of HOME_APPS) {
    const hit = [...byStem.entries()].find(([key]) => key === pkg || key.startsWith(`${pkg}.`));
    if (hit && !used.has(hit[0]) && !matched.some((m) => m.label === label)) {
      matched.push({ file: hit[1], label });
      used.add(hit[0]);
    }
  }
  for (const [key, file] of byStem) {
    if (matched.length >= 24) break;
    if (!used.has(key) && key.startsWith('com.')) {
      matched.push({ file, label: key.split('.').slice(-1)[0] });
      used.add(key);
    }
  }
  return matched;
}

function findWallpaper(files: FileInfo[], lock: boolean) {
  const walls = files.filter((f) => f.kind === 'image' && f.component === 'wallpapers');
  const pick = (re: RegExp) => walls.find((f) => re.test(fileName(f.path)));
  return lock ? pick(/lock/i) ?? pick(/default_wallpaper/i) ?? walls[0] : pick(/^default_wallpaper/i) ?? walls.find((f) => !/lock/i.test(f.path)) ?? walls[0];
}

export function PreviewView() {
  const project = useStore((s) => s.project);
  const screenshots = useStore((s) => s.screenshots);
  const details = useStore((s) => (s.selectedSerial ? s.deviceDetails[s.selectedSerial] : undefined));
  const device = useDeviceSummary();
  const files = useMemo(() => project?.files ?? [], [project]);
  const previews = useMemo(() => files.filter((f) => f.component === 'previews' && f.kind === 'image'), [files]);
  const walls = useMemo(() => files.filter((f) => f.component === 'wallpapers' && f.kind === 'image'), [files]);

  const [screen, setScreen] = useState<Screen>(project ? 'home' : 'screenshot');
  const [profile, setProfile] = useState<string>('auto');
  const [frame, setFrame] = useState(true);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [wallPath, setWallPath] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [shotId, setShotId] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 600, h: 700 });

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shot = screenshots.find((s) => s.id === shotId) ?? screenshots[screenshots.length - 1];

  // Periodic screenshots — explicitly not a live stream.
  useEffect(() => {
    if (!autoRefresh || screen !== 'screenshot' || !device.ready) return;
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        setCapturing(true);
        const next = await A.captureScreenshot(true);
        setCapturing(false);
        if (next) setShotId(next.id);
        else {
          setAutoRefresh(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [autoRefresh, screen, device.ready]);

  const capture = async () => {
    setCapturing(true);
    const next = await A.captureScreenshot();
    setCapturing(false);
    if (next) setShotId(next.id);
  };

  // Resolution: screenshot pixels, connected device, or preset.
  const deviceSize = details?.screenOverride ?? details?.screen ?? null;
  let res = PRESETS[0];
  if (screen === 'screenshot' && shot?.width && shot.height) res = { id: 'shot', label: 'Screenshot', w: shot.width, h: shot.height };
  else if (profile === 'auto' && deviceSize) res = { id: 'device', label: 'Device', w: deviceSize.width, h: deviceSize.height };
  else res = PRESETS.find((p) => p.id === profile) ?? PRESETS[0];

  const pad = frame ? 22 : 0;
  const fit = Math.min((stageSize.h - 110) / (res.h + pad * 4), (stageSize.w - 80) / (res.w + pad * 4));
  const scale = zoom === 'fit' ? Math.max(0.08, fit) : zoom;
  const screenW = res.w * scale;
  const screenH = res.h * scale;
  const s = screenW / 360; // UI scale relative to a 360dp-wide phone

  const wallpaper = (wallPath && files.find((f) => f.path === wallPath)) || findWallpaper(files, screen === 'lock');
  const icons = useMemo(() => pickIcons(files), [files]);
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  let label: React.ReactNode;
  let content: React.ReactNode;
  if (screen === 'screenshot') {
    if (shot) {
      content = <img className="fill" src={screenshotUrl(shot.id)} alt="Device screenshot" style={{ objectFit: 'contain' }} />;
      label = (
        <span className="badge badge-info">
          <Camera /> Screenshot from {shot.model ?? 'device'} · captured {formatTime(shot.atMs)}
          {autoRefresh ? ' · refreshing every 5 s (not a live mirror)' : ' · not live'}
        </span>
      );
    } else {
      content = (
        <div className="empty" style={{ height: '100%', color: '#999' }}>
          <Camera />
          <p>{device.ready ? 'Capture a screenshot from the connected phone.' : 'No screenshot yet. Connect an authorized device to capture one.'}</p>
        </div>
      );
      label = <span className="badge badge-outline">No screenshot</span>;
    }
  } else if (screen === 'previews') {
    const current = previews[Math.min(previewIndex, previews.length - 1)];
    content = current ? (
      <img className="fill" src={resourceUrl('main', current.path, current.rev)} alt={current.path} />
    ) : (
      <div className="empty" style={{ height: '100%' }}>
        <Info />
        <p>This package has no preview/ images.</p>
      </div>
    );
    label = <span className="badge badge-outline">Package preview image{current ? ` · ${fileName(current.path)}` : ''}</span>;
  } else {
    const lock = screen === 'lock';
    content = (
      <>
        {wallpaper ? (
          <img className="fill" src={resourceUrl('main', wallpaper.path, wallpaper.rev)} alt="" />
        ) : (
          <div className="fill" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #2b2f3a, #141519)' }} />
        )}
        <div className="mock-status" style={{ fontSize: 12 * s, color: '#fff' }}>
          <span>{time}</span>
          <span>▮▮▮ ◔ 87%</span>
        </div>
        {lock ? (
          <div className="mock-clock" style={{ color: '#fff' }}>
            <div className="t" style={{ fontSize: 74 * s }}>{time}</div>
            <div style={{ fontSize: 14 * s, marginTop: 6 * s }}>{date}</div>
          </div>
        ) : (
          <>
            <div className="mock-icons" style={{ rowGap: 18 * s }}>
              {icons.slice(4, 24).map((icon) => (
                <div key={icon.file.path} className="mock-icon" title={icon.file.path}>
                  <div className="img">
                    <img src={resourceUrl('main', icon.file.path, icon.file.rev)} alt="" loading="lazy" />
                  </div>
                  <div className="lbl" style={{ fontSize: 10.5 * s }}>{icon.label}</div>
                </div>
              ))}
            </div>
            <div className="mock-dock">
              {icons.slice(0, 4).map((icon) => (
                <div key={icon.file.path} className="mock-icon">
                  <div className="img">
                    <img src={resourceUrl('main', icon.file.path, icon.file.rev)} alt="" loading="lazy" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
    label = (
      <span className="badge badge-warn" title="Wallpaper and icon images from the package placed on a generic layout. Lock screen MAML, fonts, clocks and system UI resources are not rendered.">
        Static mockup · {wallpaper ? fileName(wallpaper.path) : 'no wallpaper'}
        {!lock ? ` · ${icons.length} icons` : ''} · MAML not rendered
      </span>
    );
  }

  return (
    <div className="preview-layout">
      <div className="center-body" style={{ minWidth: 0, flex: 1 }}>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Preview mode">
            <button aria-pressed={screen === 'home'} onClick={() => setScreen('home')} disabled={!project}>
              Home mockup
            </button>
            <button aria-pressed={screen === 'lock'} onClick={() => setScreen('lock')} disabled={!project}>
              Lock mockup
            </button>
            <button aria-pressed={screen === 'previews'} onClick={() => setScreen('previews')} disabled={!project}>
              Package previews{previews.length ? ` (${previews.length})` : ''}
            </button>
            <button aria-pressed={screen === 'screenshot'} onClick={() => setScreen('screenshot')}>
              <Camera /> Device screenshot
            </button>
          </div>
          <span className="sep" />
          <div className="segmented" role="group" aria-label="Zoom">
            <button aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
              <Maximize /> Fit
            </button>
            <button aria-pressed={zoom === 0.25} onClick={() => setZoom(0.25)}>25%</button>
            <button aria-pressed={zoom === 0.5} onClick={() => setZoom(0.5)}>50%</button>
            <button aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} /> Device frame
          </label>
          <span className="grow" />
          {screen === 'screenshot' && (
            <>
              <label className="check" title="Captures a new screenshot every 5 seconds while this view is open. This is not a live video mirror.">
                <input type="checkbox" checked={autoRefresh} disabled={!device.ready} onChange={(e) => setAutoRefresh(e.target.checked)} /> Refresh every 5 s
              </label>
              {shot && (
                <button className="btn btn-sm" onClick={() => void A.saveScreenshot(shot.id)}>
                  <Save /> Save PNG
                </button>
              )}
              <button className="btn btn-sm btn-primary" disabled={!device.ready || capturing} onClick={() => void capture()}>
                {capturing ? <RefreshCw className="spin" /> : <Camera />} Capture
              </button>
            </>
          )}
        </div>
        <div ref={stage} className="preview-stage">
          <div style={{ position: 'relative' }}>
            <div className={`phone ${frame ? '' : 'no-frame'}`} style={{ ['--s' as string]: s }}>
              {frame && screen !== 'screenshot' && screen !== 'previews' && <div className="phone-camera" />}
              <div className="phone-screen" style={{ width: screenW, height: screenH }}>
                {content}
              </div>
            </div>
            <div className="preview-label">{label}</div>
          </div>
        </div>
      </div>

      <aside className="preview-side" aria-label="Preview settings">
        <div className="insp-section">
          <h3>Resolution</h3>
          {screen === 'screenshot' ? (
            <p className="muted">{shot?.width ? `${shot.width} × ${shot.height} from the captured screenshot.` : 'Uses the screenshot size.'}</p>
          ) : (
            <select className="select" style={{ width: '100%' }} value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Device profile">
              <option value="auto">{deviceSize ? `Connected device (${deviceSize.width} × ${deviceSize.height})` : 'Connected device (not available)'}</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {(screen === 'home' || screen === 'lock') && (
          <div className="insp-section">
            <h3>Wallpaper</h3>
            {walls.length ? (
              <div className="thumb-strip">
                {walls.map((w) => (
                  <button key={w.path} aria-pressed={wallpaper?.path === w.path} onClick={() => setWallPath(w.path)} title={w.path}>
                    <img src={resourceUrl('main', w.path, w.rev)} alt={w.path} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">No wallpaper/ images in this package.</p>
            )}
            <p className="faint" style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.5 }}>
              The mockup places package images on a generic layout. It does not run lock screen MAML, theme fonts or system UI overlays, so the phone will look different.
            </p>
          </div>
        )}
        {screen === 'previews' && previews.length > 0 && (
          <div className="insp-section">
            <h3>Preview images</h3>
            <div className="thumb-strip">
              {previews.map((p, i) => (
                <button key={p.path} aria-pressed={i === previewIndex} onClick={() => setPreviewIndex(i)} title={p.path}>
                  <img src={resourceUrl('main', p.path, p.rev)} alt={p.path} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}
        {screen === 'screenshot' && (
          <div className="insp-section">
            <h3>Device</h3>
            <p className="row">
              <span className={`dot dot-${device.tone}`} /> <Smartphone width={13} /> {device.label}
            </p>
            {!device.ready && (
              <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => A.openSingleton('device')}>
                Open device manager
              </button>
            )}
            {screenshots.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Captured this session</h3>
                <div className="thumb-strip">
                  {[...screenshots].reverse().map((x) => (
                    <button key={x.id} aria-pressed={x.id === shot?.id} onClick={() => setShotId(x.id)} title={`${x.model ?? x.serial} · ${formatTime(x.atMs)}`}>
                      <img src={screenshotUrl(x.id)} alt={`Screenshot ${formatTime(x.atMs)}`} loading="lazy" />
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="faint" style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.5 }}>
              Screenshots are captured with <code>adb exec-out screencap</code>. A black image usually means the screen is off or the app blocks capture.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
