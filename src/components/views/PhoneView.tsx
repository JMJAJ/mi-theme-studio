// Phone: the connected device first (what it is, what you can do with it),
// then the themes already on it, then connection details for when ADB needs
// attention.
import { TryOnButton } from '../common/TryOnButton';
import { useEffect, useState } from 'react';
import { AlertTriangle, Bug, Camera, Check, ChevronDown, ChevronRight, Copy, Info, Loader2, MonitorPlay, Palette, RotateCcw, Send, Settings2, ShieldCheck, Smartphone, Sparkles, Usb } from 'lucide-react';
import { api, screenshotUrl } from '../../lib/api';
import type { ThemeManagerSupport } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { MirrorButton } from '../common/MirrorButton';
import { useDeviceSummary } from '../shell/deviceSummary';
import { formatVersion, useThemeCompatibility } from '../../state/compat';
import { DeviceThemes } from './DeviceThemes';
import { DeviceView } from './DeviceView';

function useThemeSupport(serial: string | null, ready: boolean, nonce = 0) {
  const [support, setSupport] = useState<ThemeManagerSupport | null>(null);
  useEffect(() => {
    if (!serial || !ready) {
      setSupport(null);
      return;
    }
    let cancelled = false;
    api
      .adbThemeSupport(serial)
      .then((s) => !cancelled && setSupport(s))
      .catch(() => !cancelled && setSupport(null));
    return () => {
      cancelled = true;
    };
  }, [serial, ready, nonce]);
  return support;
}

const STEPS = [
  { icon: Settings2, title: 'Turn on Developer options', text: 'Settings → About phone → tap “OS version” 7 times until it says you are a developer.' },
  { icon: Bug, title: 'Turn on USB debugging', text: 'Settings → Additional settings → Developer options → USB debugging. On HyperOS also turn on “USB debugging (Security settings)” to copy themes.' },
  { icon: Usb, title: 'Plug in and allow', text: 'Use a data cable, keep the phone unlocked and tap Allow on “Allow USB debugging?”. Tick “Always allow from this computer”.' },
];

const PERKS = [
  { icon: Sparkles, title: 'Try on phone', text: 'Apply the theme you are editing in one click' },
  { icon: MonitorPlay, title: 'Mirror the screen', text: 'See and control the phone live, right here' },
  { icon: Camera, title: 'Screenshots', text: 'Grab the screen for previews and covers' },
  { icon: Copy, title: 'Themes on the phone', text: 'Open or copy parts from installed themes' },
];

/** Not connected yet: what to do, live status, and fixes when the phone does not show up. */
function ConnectGuide() {
  const device = useDeviceSummary();
  const adb = useStore((s) => s.adb);
  const busy = useStore((s) => s.busy);
  const [checking, setChecking] = useState(false);
  const unauthorized = device.tone === 'warn';
  const noAdb = !!adb && !adb.location;
  // Which step the person is on, as far as the computer can tell.
  const current = unauthorized ? 2 : 0;
  const check = async () => {
    setChecking(true);
    await A.refreshAdb(false, true);
    setChecking(false);
  };
  return (
    <>
      <section className="connect">
        <div className="connect-art" aria-hidden="true">
          <div className={`connect-phone tone-${device.tone}`}>
            <span className="connect-cam" />
            {unauthorized ? <ShieldCheck /> : <Smartphone />}
          </div>
          <div className="connect-cable" />
          <div className="connect-plug" />
        </div>
        <div className="connect-body">
          <div className={`connect-status tone-${device.tone}`}>
            <span className={`dot dot-${device.tone} ${device.tone === 'faint' ? 'is-pulse' : ''}`} />
            {noAdb ? 'ADB is not installed or not found' : unauthorized ? 'Phone found: tap Allow on the phone' : device.label === 'No device' ? 'Waiting for your phone…' : device.label}
          </div>
          <h1>{unauthorized ? 'Allow this computer on your phone' : 'Connect your Xiaomi phone'}</h1>
          <p className="muted connect-lead">
            {unauthorized
              ? 'The phone is plugged in but has not trusted this computer yet. Unlock it and accept the USB debugging prompt.'
              : 'A one-time setup over USB. After that the phone is picked up automatically whenever you plug it in.'}
          </p>
          <ol className="connect-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className={i < current ? 'is-done' : i === current ? 'is-current' : ''}>
                <span className="connect-num">{i < current ? <Check /> : i + 1}</span>
                <step.icon className="connect-icon" />
                <div>
                  <strong>{step.title}</strong>
                  <span className="muted">{step.text}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="hero-actions">
            <button className="btn btn-primary" disabled={checking} onClick={() => void check()}>
              {checking ? <Loader2 className="spin" /> : <RotateCcw />} Check again
            </button>
            <button className="btn" disabled={!!busy} onClick={() => void A.restartAdb()}>
              Restart ADB
            </button>
            <span className="faint connect-auto">Checks automatically every few seconds</span>
          </div>
        </div>
      </section>

      <section className="connect-perks">
        {PERKS.map((p) => (
          <div key={p.title} className="connect-perk">
            <p.icon />
            <strong>{p.title}</strong>
            <span className="muted">{p.text}</span>
          </div>
        ))}
      </section>

      <details className="connect-help">
        <summary>Phone still not showing up?</summary>
        <ul>
          <li>
            <strong>Charging-only cable.</strong> Many cables only charge. Try the one that came with the phone, or another USB port (not a hub).
          </li>
          <li>
            <strong>USB mode.</strong> Pull down the notification shade on the phone, tap the USB notification and pick “File transfer”.
          </li>
          <li>
            <strong>No prompt on the phone.</strong> Developer options → “Revoke USB debugging authorizations”, unplug, plug back in.
          </li>
          <li>
            <strong>“Offline” or stuck.</strong> Press Restart ADB above, or unplug and replug.
          </li>
          <li>
            <strong>Windows does not see the phone at all.</strong> Install the Google USB driver or Xiaomi’s driver, then replug.
          </li>
        </ul>
      </details>
    </>
  );
}

export function PhoneView() {
  const device = useDeviceSummary();
  const serial = useStore((s) => s.selectedSerial);
  const details = useStore((s) => (s.selectedSerial ? s.deviceDetails[s.selectedSerial] : undefined));
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const shot = useStore((s) => s.screenshots[s.screenshots.length - 1]);
  const [supportNonce, setSupportNonce] = useState(0);
  const support = useThemeSupport(serial, device.ready, supportNonce);
  const compat = useThemeCompatibility();
  const [advanced, setAdvanced] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [keepAlive, setKeepAlive] = useState(false);

  useEffect(() => {
    if (!serial || !device.ready) return;
    let cancelled = false;
    api
      .adbKeepaliveStatus(serial)
      .then((running) => !cancelled && setKeepAlive(running))
      .catch(() => !cancelled && setKeepAlive(false));
    return () => {
      cancelled = true;
    };
  }, [serial, device.ready]);

  async function prepareThemeManager() {
    const next = await A.prepareThemeManager();
    if (next) setSupportNonce((n) => n + 1);
  }

  async function installThemeManagerApk() {
    const next = await A.installThemeManagerApk();
    if (next) setSupportNonce((n) => n + 1);
  }

  async function toggleKeepAlive() {
    const next = await A.keepThemeApplied(!keepAlive);
    if (next !== null) setKeepAlive(next);
  }

  const system = details
    ? [details.hyperosVersion ? `HyperOS ${details.hyperosVersion}` : details.miuiVersion ? `MIUI ${details.miuiVersion}` : null, details.androidVersion ? `Android ${details.androidVersion}` : null].filter(Boolean).join(' · ')
    : '';
  const screen = details?.screenOverride ?? details?.screen;

  return (
    <div className="view">
      <div className="phone-page">
        {device.ready ? (
          <section className="phone-hero">
            <div className="ph-shot">{shot ? <img src={screenshotUrl(shot.id)} alt="Last screenshot" /> : <Smartphone />}</div>
            <div className="ph-body">
              <div className="hero-kicker">Connected phone</div>
              <h1>{device.label}</h1>
              <div className="hero-meta">
                {system && <span>{system}</span>}
                {screen && (
                  <span>
                    {screen.width} × {screen.height}
                  </span>
                )}
                {support?.version && <span>Theme Manager {support.version}</span>}
                {compat?.deviceFormat != null && <span>Theme format {formatVersion(compat.deviceFormat)}</span>}
              </div>
              {project && compat && (
                <div className={`compat ${compat.supported ? 'is-ok' : 'is-newer'}`}>
                  {compat.supported ? <ShieldCheck /> : <AlertTriangle />}
                  <div>
                    <strong>{compat.supported ? `“${project.title}” fits this phone` : `“${project.title}” is made for a newer system than this phone`}</strong>
                    <span>
                      {compat.themeUiVersion !== null && compat.deviceFormat !== null
                        ? `Theme format ${compat.themeUiVersion} · phone supports up to ${formatVersion(compat.deviceFormat)}. `
                        : ''}
                      {compat.supported
                        ? 'Try on phone should apply every part.'
                        : 'Parts built for the newer format may be refused or look wrong. Try on phone still works, at your own risk.'}
                    </span>
                  </div>
                  <button className="btn btn-sm btn-ghost" onClick={() => A.goTo('design', 'info')}>
                    Theme details
                  </button>
                </div>
              )}
              <div className="hero-actions">
                <TryOnButton className="btn btn-primary" />
                {project && support?.canApply && !support.rooted && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => void A.tryOnPhone(true)}
                    title="Mark the staged copy as the newest theme format so Theme Manager copies every part, even parts built for another format. Risky on older builds."
                  >
                    <AlertTriangle /> Force apply
                  </button>
                )}
                {project && support?.canApply && !support.rooted && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => void toggleKeepAlive()}
                    title="Keep reapplying this theme after the framework’s periodic licence check. No root; a reboot stops it."
                  >
                    <ShieldCheck /> {keepAlive ? 'Stop keep-alive' : 'Keep applied'}
                  </button>
                )}
                <MirrorButton className="btn" />
                <button className="btn" disabled={!!busy} onClick={() => void A.captureScreenshot()}>
                  <Camera /> Screenshot
                </button>
                <button className="btn" disabled={!project || !!busy} onClick={() => void A.addToThemeManager()} title={project ? 'Put the theme into Theme Manager on the phone (My themes) without applying it' : 'Open a theme first'}>
                  <Send /> Add to Theme Manager
                </button>
                {support?.canOpenStore && (
                  <button className="btn btn-ghost" disabled={!!busy} onClick={() => void A.openThemeSettingsOnDevice()}>
                    <Palette /> Open Theme Manager
                  </button>
                )}
              </div>
              {support?.installed && !support.canApply && !support.rooted && (
                <div className="compat is-newer">
                  <AlertTriangle />
                  <div>
                    <strong>One-click apply needs Theme Manager’s factory build</strong>
                    <span>This build removed the editor entry point. Removing the update restores the system-partition build — no root, no APK patching. Theme Manager’s local data may reset.</span>
                  </div>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => void prepareThemeManager()}>
                    Enable non-root apply
                  </button>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => void installThemeManagerApk()} title="Install a same-version or newer Xiaomi-signed Theme Manager APK (cannot downgrade a factory 3.0.5.19)">
                    Install APK…
                  </button>
                </div>
              )}
              {project && (
                <p className="ph-note">
                  <Info /> Try on phone adds the theme to Theme Manager and applies it; each try replaces the previous one. On global HyperOS, Theme Manager wants a Xiaomi-signed licence for every part except wallpapers and sounds. Try-on reuses the licences already on the phone, so mixes of unmodified store parts apply; parts you edited have no licence and Xiaomi will not issue one.
                </p>
              )}
            </div>
          </section>
        ) : (
          <ConnectGuide />
        )}

        {device.ready && (
          <section className="section">
            <div className="section-head">
              <h2>Themes on this phone</h2>
              <span className="muted">Open one to edit a copy, or as a reference to copy parts from</span>
              <div className="actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setRefreshKey((k) => k + 1)}>
                  Refresh
                </button>
              </div>
            </div>
            <DeviceThemes refreshKey={refreshKey} compact />
          </section>
        )}

        <section className="section">
          <button className="disclosure" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            {advanced ? <ChevronDown /> : <ChevronRight />} Connection and ADB
            <span className="muted">{device.title}</span>
          </button>
          {advanced && (
            <div className="phone-advanced">
              <DeviceView embedded />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
