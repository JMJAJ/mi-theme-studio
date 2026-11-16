import { useEffect, useState } from 'react';
import { AlertTriangle, Camera, CircleCheck, FolderSearch, Info, Lock, Palette, Play, RefreshCw, RotateCcw, Send, Smartphone, Unplug } from 'lucide-react';
import { api } from '../../lib/api';
import { MirrorButton } from '../common/MirrorButton';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { relativeTime } from '../../lib/format';
import type { DeviceEntry, ThemeManagerSupport } from '../../lib/types';

const SOURCE_LABEL: Record<string, string> = {
  settings: 'Set in Settings',
  'android-sdk-env': 'ANDROID_HOME / ANDROID_SDK_ROOT',
  path: 'PATH',
  'user-folder': 'User folder',
  'android-sdk': 'Android SDK (default location)',
  common: 'Common location',
  bundled: 'Bundled with Mi Theme Studio',
};

function stateBadge(device: DeviceEntry) {
  switch (device.state) {
    case 'device':
      return <span className="badge badge-ok">Connected</span>;
    case 'unauthorized':
      return <span className="badge badge-warn">Unauthorized</span>;
    case 'offline':
      return <span className="badge badge-err">Offline</span>;
    default:
      return <span className="badge badge-outline">{device.state}</span>;
  }
}

function ThemeManagerActions({ serial, hasProject, busy }: { serial: string; hasProject: boolean; busy: boolean }) {
  const [support, setSupport] = useState<ThemeManagerSupport | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    api
      .adbThemeSupport(serial)
      .then((s) => !cancelled && setSupport(s))
      .catch(() => !cancelled && setSupport(null))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [serial]);
  if (checking && !support) {
    return (
      <p className="muted row" style={{ fontSize: 13 }}>
        <RefreshCw width={13} className="spin" /> Checking Theme Manager…
      </p>
    );
  }
  if (!support?.installed) return null;
  return (
    <>
      <button
        className="btn"
        style={{ justifyContent: 'flex-start' }}
        disabled={!hasProject || busy || !support.canApply}
        onClick={() => void A.applyOnDevice()}
        title={support.canApply ? undefined : 'This Theme Manager build has no editor apply entry point'}
      >
        <Play /> Apply on phone…
      </button>
      {support.canOpenStore && (
        <button className="btn" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => void A.openThemeSettingsOnDevice()}>
          <Palette /> Open Theme Manager on phone
        </button>
      )}
      <div className="banner" style={{ marginTop: 4 }}>
        <Info />
        <span>
          {support.canApply ? (
            <>
              Theme Manager {support.version} supports applying from the desktop ({support.twoStep ? 'two-step' : 'legacy'} editor flow). You confirm before anything is applied, and a screenshot is taken afterwards.
            </>
          ) : (
            <>
              Theme Manager {support.version ?? ''} on this phone has no editor apply entry point (global builds don’t include it), so themes can’t be applied from the desktop here. Copy the
              package to the phone and apply it in Theme Manager, or open store themes on the phone from the Theme store.
            </>
          )}
        </span>
      </div>
    </>
  );
}

export function DeviceView({ embedded = false }: { embedded?: boolean }) {
  const adb = useStore((s) => s.adb);
  const checking = useStore((s) => s.adbChecking);
  const selected = useStore((s) => s.selectedSerial);
  const detailsMap = useStore((s) => s.deviceDetails);
  const settings = useStore((s) => s.settings);
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const device = adb?.devices.find((d) => d.serial === selected) ?? null;
  const details = device ? detailsMap[device.serial] : undefined;

  return (
    <div className={embedded ? '' : 'view'}>
      <div className={embedded ? '' : 'view-pad'}>
        <div className="view-header" style={embedded ? { marginBottom: 4 } : undefined}>
          <div>
            {!embedded && <h1>Device</h1>}
            <div className="sub">ADB runs in the native backend: read-only queries, screenshots, mirroring and confirmed file copies.</div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void A.refreshAdb(false, true)} disabled={checking}>
              <RefreshCw className={checking ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>ADB</h2>
            {adb && <span className="muted">checked {relativeTime(adb.checkedAtMs)}</span>}
          </div>
          {!adb ? (
            <div className="banner">
              <RefreshCw className="spin" /> Looking for adb…
            </div>
          ) : adb.location ? (
            <div className="surface surface-pad">
              <dl className="kv">
                <dt>Executable</dt>
                <dd className="mono">{adb.location.path}</dd>
                <dt>Found via</dt>
                <dd>{SOURCE_LABEL[adb.location.source] ?? adb.location.source}</dd>
                <dt>Version</dt>
                <dd>{adb.version ?? '—'}</dd>
              </dl>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => void A.chooseAdbPath()}>
                  <FolderSearch /> Choose adb.exe…
                </button>
                {settings?.adbPath && (
                  <button className="btn btn-sm" onClick={() => void A.resetAdbPath()}>
                    Use automatic search
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => void A.restartAdb()} disabled={checking}>
                  <RotateCcw /> Restart ADB server
                </button>
              </div>
            </div>
          ) : (
            <div className="banner banner-warn">
              <Unplug />
              <div className="grow">
                <strong>adb was not found</strong>
                <div>
                  Install Android SDK platform-tools, or point the app at an existing <code>adb.exe</code>. Searched:
                </div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="mono">
                  {adb.searched.slice(0, 10).map((c) => (
                    <li key={c.path}>{c.path}</li>
                  ))}
                </ul>
              </div>
              <div className="actions">
                <button className="btn btn-sm btn-primary" onClick={() => void A.chooseAdbPath()}>
                  Choose adb.exe…
                </button>
              </div>
            </div>
          )}
          {adb?.error && adb.location && (
            <div className="banner banner-err" style={{ marginTop: 10 }}>
              <AlertTriangle /> {adb.error.message}
            </div>
          )}
        </div>

        {adb?.location && (
          <div className="section">
            <div className="section-head">
              <h2>Devices</h2>
              <span className="muted">{adb.devices.length} attached</span>
            </div>
            {adb.devices.length === 0 ? (
              <div className="banner">
                <Smartphone />
                <span>No devices. Connect the phone by USB, enable USB debugging in Developer options, and keep it unlocked. The list refreshes automatically.</span>
              </div>
            ) : (
              <table className="table surface">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Serial</th>
                    <th>State</th>
                    <th>Transport</th>
                  </tr>
                </thead>
                <tbody>
                  {adb.devices.map((d) => (
                    <tr key={d.serial} className={`is-clickable ${d.serial === selected ? 'is-selected' : ''}`} onClick={() => A.selectDevice(d.serial)} aria-selected={d.serial === selected}>
                      <td>{detailsMap[d.serial]?.marketName ?? d.model ?? d.device ?? 'Unknown'}</td>
                      <td className="mono">{d.serial}</td>
                      <td>{stateBadge(d)}</td>
                      <td className="muted">{d.usb ? `USB ${d.usb}` : d.serial.includes(':') ? 'Network' : 'USB'}{d.transportId ? ` · #${d.transportId}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {adb.devices.length > 1 && <p className="muted" style={{ marginTop: 6 }}>Several devices are attached; commands go to the selected row only.</p>}
          </div>
        )}

        {device?.state === 'unauthorized' && (
          <div className="banner banner-warn section">
            <Lock />
            <span>Unlock the phone and accept the “Allow USB debugging?” prompt for this computer. If no prompt appears, reconnect the cable or revoke USB debugging authorizations in Developer options and try again.</span>
          </div>
        )}
        {device?.state === 'offline' && (
          <div className="banner banner-err section">
            <Unplug />
            <span className="grow">The device is offline. Reconnect the cable, or restart the ADB server.</span>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => void A.restartAdb()}>
                Restart server
              </button>
            </div>
          </div>
        )}

        {device?.state === 'device' && (
          <div className="section" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 22 }}>
            <div>
              <div className="section-head">
                <h2>Details</h2>
                <div className="actions">
                  <button className="btn btn-sm" onClick={() => void A.loadDeviceDetails(device.serial)}>
                    <RefreshCw /> Reload
                  </button>
                </div>
              </div>
              {details ? (
                <dl className="kv surface surface-pad">
                  <dt>Model</dt>
                  <dd>
                    {[details.manufacturer, details.marketName ?? details.model].filter(Boolean).join(' ')} {details.model && details.marketName ? <span className="muted">({details.model})</span> : null}
                  </dd>
                  <dt>System</dt>
                  <dd>
                    {details.hyperosVersion ? `HyperOS ${details.hyperosVersion.replace(/^OS/, '')}` : details.miuiVersion ? `MIUI ${details.miuiVersion}` : 'Unknown'}
                    {details.androidVersion ? ` · Android ${details.androidVersion}` : ''}
                    {details.sdk ? ` (API ${details.sdk})` : ''}
                  </dd>
                  <dt>Build</dt>
                  <dd className="mono">{details.buildIncremental ?? '—'}</dd>
                  <dt>Region</dt>
                  <dd>{details.region ?? '—'}</dd>
                  <dt>Screen</dt>
                  <dd>
                    {details.screen ? `${details.screen.width} × ${details.screen.height}` : '—'}
                    {details.screenOverride ? ` (override ${details.screenOverride.width} × ${details.screenOverride.height})` : ''}
                    {details.density ? ` · ${details.densityOverride ?? details.density} dpi` : ''}
                  </dd>
                  <dt>CPU ABI</dt>
                  <dd>{details.abi ?? '—'}</dd>
                  <dt>Theme Manager</dt>
                  <dd>{details.themeManagerInstalled ? `Installed${details.themeManagerVersion ? ` · ${details.themeManagerVersion}` : ''}` : 'Not found'}</dd>
                </dl>
              ) : (
                <div className="banner">
                  <RefreshCw className="spin" /> Reading device properties…
                </div>
              )}
            </div>
            <div>
              <div className="section-head">
                <h2>Actions</h2>
              </div>
              <div className="col">
                <button
                  className="btn"
                  style={{ justifyContent: 'flex-start' }}
                  disabled={!!busy}
                  onClick={async () => {
                    const shot = await A.captureScreenshot();
                    if (shot) A.openSingleton('preview');
                  }}
                >
                  <Camera /> Capture screenshot
                </button>
                <MirrorButton block />
                <button className="btn" style={{ justifyContent: 'flex-start' }} disabled={!project || !!busy} onClick={() => void A.sendToDevice()} title={project ? undefined : 'Open a package first'}>
                  <Send /> Copy package to device…
                </button>
                <p className="faint" style={{ fontSize: 12.5 }}>
                  Copying places the exported .mtz in <code>/sdcard/Download/MiThemeStudio/</code> and verifies its size.
                </p>
                {details?.themeManagerInstalled && device?.state === 'device' && <ThemeManagerActions serial={device.serial} hasProject={!!project} busy={!!busy} />}
                {details?.themeManagerInstalled && (
                  <p className="muted row" style={{ fontSize: 13 }}>
                    <CircleCheck width={13} className="ok" /> Theme Manager is installed on this device.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
