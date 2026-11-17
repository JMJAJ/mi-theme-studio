// Always-visible phone on the right: the theme being edited rendered on a
// phone frame, or the real connected phone (screenshot / live mirror).
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Circle, ExternalLink, Loader2, Lock, MonitorPlay, MonitorSmartphone, Send, Smartphone, Sparkles, Square, Usb, X } from 'lucide-react';
import { resourceUrl, screenshotUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import { findWallpaper, pickIcons } from '../views/PreviewView';
import { TryOnButton } from '../common/TryOnButton';
import { attachCanvas, startStream, stopStream, streamKey, streamScroll, streamTouch, useMirrorStream } from '../../state/mirrorStream';
import * as A from '../../state/actions';
import { updateLayout, useStore } from '../../state/store';
import { useDeviceSummary } from './deviceSummary';

type Mode = 'theme' | 'live';
type Screen = 'lock' | 'home' | 'previews';

function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 320, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

function Frame({ ratio, box, children, camera = true }: { ratio: number; box: { w: number; h: number }; children: React.ReactNode; camera?: boolean }) {
  const maxW = Math.max(120, box.w - 72);
  const maxH = Math.max(200, box.h - 40);
  const w = Math.min(maxW, maxH / ratio);
  const h = w * ratio;
  const s = w / 360;
  return (
    <div className="pp-phone" style={{ ['--s' as string]: s }}>
      {camera && <div className="phone-camera" />}
      <div className="phone-screen" style={{ width: w, height: h }}>
        {children}
      </div>
    </div>
  );
}

function ThemeScreen({ screen, box, ratio, previewIndex }: { screen: Screen; box: { w: number; h: number }; ratio: number; previewIndex: number }) {
  const project = useStore((s) => s.project);
  const files = useMemo(() => project?.files ?? [], [project]);
  const icons = useMemo(() => pickIcons(files), [files]);
  const previews = useMemo(() => files.filter((f) => f.component === 'previews' && f.kind === 'image'), [files]);
  const themeFont = usePackageFont(useMemo(() => themeFontFile(files), [files])).family ?? undefined;
  const w = Math.min(Math.max(120, box.w - 72), Math.max(200, box.h - 40) / ratio);
  const s = w / 360;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  if (screen === 'previews') {
    const current = previews[Math.min(previewIndex, previews.length - 1)];
    return (
      <Frame ratio={ratio} box={box} camera={false}>
        {current ? (
          <img className="fill" src={resourceUrl('main', current.path, current.rev)} alt={current.path} style={{ objectFit: 'contain', background: '#000' }} />
        ) : (
          <div className="pp-empty">No preview/ images in this theme yet.</div>
        )}
      </Frame>
    );
  }
  const lock = screen === 'lock';
  const wallpaper = findWallpaper(files, lock);
  return (
    <Frame ratio={ratio} box={box}>
      {wallpaper ? (
        <img className="fill" src={resourceUrl('main', wallpaper.path, wallpaper.rev)} alt="" />
      ) : (
        <div className="fill" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #2b2f3a, #121317)' }} />
      )}
      <div className="mock-status" style={{ fontSize: 12 * s, color: '#fff', fontFamily: themeFont }}>
        <span>{time}</span>
        <span>▮▮▮ ◔ 87%</span>
      </div>
      {lock ? (
        <div className="mock-clock" style={{ color: '#fff', fontFamily: themeFont }}>
          <div className="t" style={{ fontSize: 74 * s }}>
            {time}
          </div>
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
                <div className="lbl" style={{ fontSize: 10.5 * s }}>
                  {icon.label}
                </div>
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
    </Frame>
  );
}

/** The decoded mirror; pointer and wheel input go back to the phone as touches and scrolls. */
function LiveCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const down = useRef(false);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  useEffect(() => {
    attachCanvas(ref.current);
    return () => attachCanvas(null);
  }, []);
  const toVideo = (e: { clientX: number; clientY: number }) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const { width, height } = useMirrorStream.getState();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };
  const release = (e: React.PointerEvent) => {
    if (!down.current) return;
    down.current = false;
    const p = toVideo(e);
    streamTouch(1, p.x, p.y);
  };
  return (
    <canvas
      ref={ref}
      className="fill pp-canvas"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        down.current = true;
        const p = toVideo(e);
        streamTouch(0, p.x, p.y);
      }}
      onPointerMove={(e) => {
        if (!down.current) return;
        pending.current = toVideo(e);
        if (!raf.current) {
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            if (pending.current) streamTouch(2, pending.current.x, pending.current.y);
          });
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onWheel={(e) => {
        const p = toVideo(e);
        streamScroll(p.x, p.y, -Math.sign(e.deltaY) * Math.min(3, Math.max(1, Math.abs(e.deltaY) / 100)));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        streamKey('back');
      }}
    />
  );
}

export function PhonePanel() {
  const project = useStore((s) => s.project);
  const screenshots = useStore((s) => s.screenshots);
  const details = useStore((s) => (s.selectedSerial ? s.deviceDetails[s.selectedSerial] : undefined));
  const busy = useStore((s) => s.busy);
  const device = useDeviceSummary();
  const [mode, setMode] = useState<Mode>('theme');
  const [screen, setScreen] = useState<Screen>('lock');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [stageRef, box] = useBox();
  const section = useStore((s) => s.section);
  // On the Phone page the panel shows the real phone; elsewhere the theme.
  useEffect(() => {
    setMode(section === 'phone' ? 'live' : 'theme');
  }, [section]);
  // Follow the part being edited so changes show on the right screen.
  const part = useStore((s) => s.part);
  useEffect(() => {
    if (part === 'icons' || part === 'home' || part === 'wallpapers') setScreen('home');
    else if (part === 'lockscreen') setScreen('lock');
    else if (part === 'previews') setScreen('previews');
  }, [part]);
  const previews = useMemo(() => (project?.files ?? []).filter((f) => f.component === 'previews' && f.kind === 'image'), [project]);

  const deviceSize = details?.screenOverride ?? details?.screen ?? null;
  const ratio = deviceSize ? deviceSize.height / deviceSize.width : 2400 / 1080;
  const shot = screenshots[screenshots.length - 1];
  const effectiveMode: Mode = project ? mode : 'live';
  const stream = useMirrorStream();
  const streaming = stream.status === 'live' || stream.status === 'starting';
  // A running mirror always shows here.
  useEffect(() => {
    if (streaming) setMode('live');
  }, [streaming]);

  // Show the real screen right away instead of an empty frame.
  const autoShot = useRef(false);
  useEffect(() => {
    if (effectiveMode === 'live' && device.ready && !shot && !autoShot.current && !busy) {
      autoShot.current = true;
      void A.captureScreenshot(true);
    }
  }, [effectiveMode, device.ready, shot, busy]);

  const capture = async () => {
    setCapturing(true);
    await A.captureScreenshot();
    setCapturing(false);
  };

  return (
    <aside className="phone-panel" aria-label="Phone preview">
      <div className="pp-head">
        <div className="segmented pp-modes" role="group" aria-label="Phone preview mode">
          <button aria-pressed={effectiveMode === 'theme'} disabled={!project} onClick={() => setMode('theme')}>
            <Sparkles /> Theme
          </button>
          <button aria-pressed={effectiveMode === 'live'} onClick={() => setMode('live')}>
            <Smartphone /> Live phone
          </button>
        </div>
        <button className="tb-icon" aria-label="Hide phone preview" title="Hide phone preview (Ctrl+Alt+P)" onClick={() => updateLayout({ phone: false })}>
          <X />
        </button>
      </div>

      {effectiveMode === 'theme' ? (
        <>
          <div className="pp-screens" role="tablist" aria-label="Screen">
            <button role="tab" aria-selected={screen === 'lock'} onClick={() => setScreen('lock')}>
              <Lock /> Lock
            </button>
            <button role="tab" aria-selected={screen === 'home'} onClick={() => setScreen('home')}>
              <MonitorSmartphone /> Home
            </button>
            <button role="tab" aria-selected={screen === 'previews'} onClick={() => setScreen('previews')} disabled={!previews.length}>
              Previews{previews.length ? ` ${previews.length}` : ''}
            </button>
          </div>
          <div className="pp-stage" ref={stageRef}>
            <ThemeScreen screen={screen} box={box} ratio={ratio} previewIndex={previewIndex} />
          </div>
          <div className="pp-foot">
            {screen === 'previews' && previews.length > 0 ? (
              <div className="pp-pager">
                <button className="tb-icon" aria-label="Previous preview" onClick={() => setPreviewIndex((i) => (i - 1 + previews.length) % previews.length)}>
                  <ChevronLeft />
                </button>
                <span className="ellipsis grow" title={previews[previewIndex % previews.length]?.path}>
                  {fileName(previews[previewIndex % previews.length]?.path ?? '')}
                </span>
                <span className="faint">
                  {(previewIndex % previews.length) + 1}/{previews.length}
                </span>
                <button className="tb-icon" aria-label="Next preview" onClick={() => setPreviewIndex((i) => (i + 1) % previews.length)}>
                  <ChevronRight />
                </button>
              </div>
            ) : (
              <span className="faint pp-note">Live mockup of your wallpaper{screen === 'home' ? ' and icons' : ' and clock'}. Lock screen layouts (MAML) render on the real phone.</span>
            )}
          </div>
          {device.ready && (
            <div className="pp-actions">
              <span className="faint pp-note grow">See it on {device.label}</span>
              <TryOnButton />
            </div>
          )}
        </>
      ) : (
        <>
          <div className={`pp-device tone-${device.tone}`}>
            <span className={`dot dot-${device.tone}`} />
            <span className="grow ellipsis">
              <strong>{device.ready ? device.label : device.label === 'No device' ? 'No phone connected' : device.label}</strong>
              <span className="faint">
                {device.ready ? ` · ${details?.hyperosVersion ? `HyperOS ${details.hyperosVersion}` : details?.miuiVersion ? `MIUI ${details.miuiVersion}` : 'connected'}` : ''}
              </span>
            </span>
            {streaming && <span className="pp-live">{stream.status === 'live' ? `Live · ${stream.fps} fps` : 'Starting…'}</span>}
          </div>
          <div className="pp-stage" ref={stageRef}>
            {device.ready ? (
              streaming ? (
                <Frame ratio={stream.width && stream.height ? stream.height / stream.width : ratio} box={box} camera={false}>
                  <LiveCanvas />
                  {stream.status === 'starting' && (
                    <div className="pp-empty pp-overlay">
                      <Loader2 className="spin" />
                      Starting the mirror on the phone…
                    </div>
                  )}
                </Frame>
              ) : (
                <Frame ratio={shot?.width && shot.height ? shot.height / shot.width : ratio} box={box} camera={false}>
                  {shot && <img className="fill" src={screenshotUrl(shot.id)} alt="Phone screenshot" style={{ objectFit: 'contain' }} />}
                  <div className={`pp-empty ${shot ? 'pp-overlay is-soft' : ''}`}>
                    {stream.status === 'error' && <span className="err pp-note">{stream.error}</span>}
                    <button className="btn btn-primary" onClick={() => void startStream()}>
                      <MonitorPlay /> Mirror live
                    </button>
                    <span className="pp-note">See and use the phone right here.</span>
                  </div>
                </Frame>
              )
            ) : (
              <div className="pp-connect">
                <Usb />
                <h3>Connect your phone</h3>
                <ol>
                  <li>Settings → About phone → tap OS version 7 times.</li>
                  <li>Additional settings → Developer options → USB debugging on.</li>
                  <li>Plug in the cable and accept the prompt on the phone.</li>
                </ol>
                <button className="btn btn-sm" onClick={() => void A.refreshAdb(false, true)}>
                  Check again
                </button>
              </div>
            )}
          </div>
          {device.ready && (
            <div className="pp-actions">
              {streaming ? (
                <>
                  <div className="pp-nav" role="group" aria-label="Phone buttons">
                    <button className="tb-icon" title="Back" aria-label="Back" onClick={() => streamKey('back')}>
                      <ChevronLeft />
                    </button>
                    <button className="tb-icon" title="Home" aria-label="Home" onClick={() => streamKey('home')}>
                      <Circle />
                    </button>
                    <button className="tb-icon" title="Recent apps" aria-label="Recent apps" onClick={() => streamKey('recents')}>
                      <Square />
                    </button>
                  </div>
                  <span className="grow" />
                  <button className="btn btn-sm" disabled={capturing || !!busy} onClick={() => void capture()} title="Save a full-resolution screenshot" aria-label="Screenshot">
                    <Camera />
                  </button>
                  <button className="btn btn-sm" onClick={() => void stopStream()} title="Stop mirroring">
                    <X /> Stop
                  </button>
                  <TryOnButton compact />
                </>
              ) : (
                <>
                  <button className="btn btn-sm" disabled={capturing || !!busy} onClick={() => void capture()}>
                    <Camera /> {capturing ? 'Capturing…' : 'Screenshot'}
                  </button>
                  <button className="btn btn-sm btn-ghost btn-icon" onClick={() => void A.startMirror()} title="Open the phone in a separate window" aria-label="Open the phone in a separate window">
                    <ExternalLink />
                  </button>
                  {project && (
                    <button className="btn btn-sm btn-ghost btn-icon" disabled={!!busy} onClick={() => void A.addToThemeManager()} title="Add to Theme Manager on the phone without applying" aria-label="Add to Theme Manager">
                      <Send />
                    </button>
                  )}
                  <span className="grow" />
                  <TryOnButton />
                </>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
