// Phone: the connected device first (what it is, what you can do with it),
// then the themes already on it, then connection details for when ADB needs
// attention.
import { TryOnButton } from '../common/TryOnButton';
import { useEffect, useState } from 'react';
import { Camera, ChevronDown, ChevronRight, Info, Palette, Send, Smartphone, Usb } from 'lucide-react';
import { api, screenshotUrl } from '../../lib/api';
import type { ThemeManagerSupport } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { MirrorButton } from '../common/MirrorButton';
import { useDeviceSummary } from '../shell/deviceSummary';
import { DeviceThemes } from './DeviceThemes';
import { DeviceView } from './DeviceView';

function useThemeSupport(serial: string | null, ready: boolean) {
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
  }, [serial, ready]);
  return support;
}

export function PhoneView() {
  const device = useDeviceSummary();
  const serial = useStore((s) => s.selectedSerial);
  const details = useStore((s) => (s.selectedSerial ? s.deviceDetails[s.selectedSerial] : undefined));
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const shot = useStore((s) => s.screenshots[s.screenshots.length - 1]);
  const support = useThemeSupport(serial, device.ready);
  const [advanced, setAdvanced] = useState(!device.ready);
  const [refreshKey, setRefreshKey] = useState(0);

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
              </div>
              <div className="hero-actions">
                <TryOnButton className="btn btn-primary" />
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
              {project && (
                <p className="ph-note">
                  <Info /> Try on phone adds the theme to Theme Manager and applies it; each try replaces the previous one. On global HyperOS, Theme Manager wants a Xiaomi license for icons, lock screen and system UI, which Xiaomi only gives to unchanged store themes.
                </p>
              )}
            </div>
          </section>
        ) : (
          <section className="phone-hero is-empty">
            <div className="ph-shot">
              <Usb />
            </div>
            <div className="ph-body">
              <div className="hero-kicker">Phone</div>
              <h1>{device.label === 'No device' ? 'Connect your phone' : device.label}</h1>
              <ol className="ph-steps">
                <li>On the phone: Settings → About phone → tap the OS version 7 times.</li>
                <li>Settings → Additional settings → Developer options → turn on USB debugging.</li>
                <li>Connect the cable and allow debugging when the phone asks.</li>
              </ol>
              <div className="hero-actions">
                <button className="btn btn-primary" onClick={() => void A.refreshAdb(false, true)}>
                  Check again
                </button>
              </div>
            </div>
          </section>
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
