// Which of the phone's apps the theme has icons for. Xiaomi's old editor
// installed a helper APK ("ShowApps") for this; here the bundled scrcpy server
// lists the apps, so nothing is installed on the phone.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Search, Smartphone } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import type { DeviceApp, FileInfo } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { FolderInput, Wand2 } from 'lucide-react';
import { GenerateIconsDialog, importIconsMatched } from './IconTools';

interface AppsState {
  serial: string | null;
  apps: DeviceApp[];
  loading: boolean;
  error: string | null;
}
const useApps = create<AppsState>(() => ({ serial: null, apps: [], loading: false, error: null }));

async function loadApps(serial: string) {
  useApps.setState({ loading: true, error: null, serial });
  try {
    const apps = await api.adbListApps(serial);
    useApps.setState({ apps, loading: false });
  } catch (e) {
    useApps.setState({ loading: false, error: errorMessage(e) });
  }
}

/** Package an icon file is for: `com.app.png` or `com.app#Activity.png`. */
function iconPackage(path: string) {
  return fileName(path).replace(/\.(png|webp|jpg)$/i, '').split('#')[0];
}

export function IconCoverage({ files, folder }: { files: FileInfo[]; folder: string }) {
  const serial = useStore((s) => s.selectedSerial);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const { apps, loading, error, serial: loadedFor } = useApps();
  const [filter, setFilter] = useState<'missing' | 'themed' | 'all'>('missing');
  const [query, setQuery] = useState('');
  const [showSystem, setShowSystem] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (ready && serial && loadedFor !== serial && !useApps.getState().loading) void loadApps(serial);
  }, [ready, serial, loadedFor]);

  const icons = useMemo(() => {
    const map = new Map<string, FileInfo>();
    for (const f of files) {
      if (!/\.(png|webp|jpg)$/i.test(f.path)) continue;
      const pkg = iconPackage(f.path);
      if (!map.has(pkg)) map.set(pkg, f);
    }
    return map;
  }, [files]);

  if (!ready || !serial) {
    return (
      <div className="empty">
        <Smartphone />
        <h3>Connect your phone to see its apps</h3>
        <p>Then you can see which installed apps still use their stock icon and add one for each.</p>
      </div>
    );
  }

  const current = loadedFor === serial ? apps : [];
  const themed = current.filter((a) => icons.has(a.package)).length;
  const missingApps = current.filter((a) => !icons.has(a.package) && (showSystem || !a.system));
  const q = query.trim().toLowerCase();
  const rows = current.filter((a) => {
    if (!showSystem && a.system) return false;
    const has = icons.has(a.package);
    if (filter === 'missing' && has) return false;
    if (filter === 'themed' && !has) return false;
    return !q || a.label.toLowerCase().includes(q) || a.package.includes(q);
  });

  return (
    <div className="view-pad">
      <div className="section-head">
        <h2>Apps on your phone</h2>
        {current.length > 0 && (
          <span className="muted">
            {themed} of {current.length} have an icon in this theme
          </span>
        )}
        <div className="actions">
          <button className="btn btn-sm" disabled={!current.length} onClick={() => void importIconsMatched(current, folder)} title="Pick many icon files; each goes to the app its file name matches">
            <FolderInput /> Import icons…
          </button>
          <button className="btn btn-sm" disabled={!missingApps.length} onClick={() => setGenerating(true)} title="Make a matching letter icon for every app that has none">
            <Wand2 /> Generate {missingApps.length || ''} missing…
          </button>
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void loadApps(serial)}>
            {loading ? <Loader2 className="spin" /> : <RefreshCw />} Refresh
          </button>
        </div>
      </div>
      <div className="app-filters">
        <div className="segmented" role="group" aria-label="Show">
          {(['missing', 'themed', 'all'] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'missing' ? `Missing ${current.length - themed}` : f === 'themed' ? `Themed ${themed}` : 'All'}
            </button>
          ))}
        </div>
        <div className="search" style={{ width: 220 }}>
          <Search />
          <input className="input" placeholder="Find an app" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an app" />
        </div>
        <label className="check">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> System apps
        </label>
      </div>
      {error ? (
        <div className="banner banner-err">
          <AlertTriangle />
          <span className="grow">{error}</span>
          <button className="btn btn-sm" onClick={() => void loadApps(serial)}>
            Retry
          </button>
        </div>
      ) : loading && !current.length ? (
        <div className="empty">
          <Loader2 className="spin" />
          <p>Reading the app list from the phone…</p>
        </div>
      ) : (
        <div className="app-list">
          {rows.map((a) => {
            const icon = icons.get(a.package);
            return (
              <div key={a.package} className="app-row">
                <span className="app-icon checker">
                  {icon ? <img src={resourceUrl('main', icon.path, icon.rev)} alt="" draggable={false} /> : <span className="faint">?</span>}
                </span>
                <span className="app-name">
                  <span className="ellipsis">
                    {a.label} {a.system && <span className="badge badge-outline">system</span>}
                  </span>
                  <span className="path ellipsis">{a.package}</span>
                </span>
                {icon ? (
                  <>
                    <span className="ok app-ok">
                      <Check width={14} /> Themed
                    </span>
                    <button className="btn btn-ghost btn-sm" onClick={() => void A.replaceFile(icon.path)}>
                      Replace
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => void A.addAppIcon(a.package, a.label, folder)}>
                    <Plus /> Add icon
                  </button>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <p className="muted">{filter === 'missing' ? 'Every app in this list has an icon.' : 'No apps match.'}</p>}
        </div>
      )}
      {generating && <GenerateIconsDialog apps={missingApps} folder={folder} onClose={() => setGenerating(false)} />}
    </div>
  );
}
