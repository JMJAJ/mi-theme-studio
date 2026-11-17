// Settings: a large panel with searchable sections on the left and cards of
// setting rows (title + description, control on the right) on the right.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, Info, Keyboard, MonitorSmartphone, Palette, RotateCcw, Search, Settings2, ShoppingBag, Smartphone, X, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import { COMMANDS } from '../../state/commands';
import { closeDialog, updateLayout, useStore } from '../../state/store';
import { DEFAULT_LAYOUT } from '../../state/store';
import * as A from '../../state/actions';
import { MAX_ZOOM, MIN_ZOOM, resetZoom, setZoom, useZoom, zoomIn, zoomOut } from '../../state/zoom';
import { REGIONS, REGION_NOTES, setFreeOnly, setRegion, useThemeStore } from '../../state/themeStore';
import { checkForUpdate, installUpdate, useUpdater } from '../../state/updater';

export type SettingsSection = 'general' | 'appearance' | 'phone' | 'store' | 'keys' | 'about';

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon; keywords: string }[] = [
  { id: 'general', label: 'General', icon: Settings2, keywords: 'recovery autosave backup save interval data folder' },
  { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'zoom size scale interface layout phone panel' },
  { id: 'phone', label: 'Phone', icon: Smartphone, keywords: 'adb device mirror scrcpy usb' },
  { id: 'store', label: 'Theme store', icon: ShoppingBag, keywords: 'region free paid downloads catalog' },
  { id: 'keys', label: 'Keyboard shortcuts', icon: Keyboard, keywords: 'shortcuts keys keybindings hotkeys' },
  { id: 'about', label: 'About', icon: Info, keywords: 'version license credits scrcpy' },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)} />;
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {description && <div className="set-desc">{description}</div>}
      </div>
      {children && <div className="set-control">{children}</div>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      <div className="set-card">{children}</div>
    </section>
  );
}

const INTERVALS = [
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every minute' },
  { value: 120, label: 'Every 2 minutes' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 600, label: 'Every 10 minutes' },
];

function General() {
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.appInfo);
  if (!settings) return null;
  const interval = settings.autosaveIntervalSeconds;
  return (
    <>
      <Group title="Saving and recovery">
        <Row title="Recovery copy" description="Keep a copy of unsaved work in the app data folder, so a crash or power cut never loses edits. Never written over your theme file.">
          <Switch label="Recovery copy" checked={settings.autosaveEnabled} onChange={(v) => void A.updateSettings({ autosaveEnabled: v })} />
        </Row>
        <Row title="Recovery copy interval" description="How often the recovery copy is refreshed while there are unsaved changes.">
          <select className="select" value={interval} disabled={!settings.autosaveEnabled} onChange={(e) => void A.updateSettings({ autosaveIntervalSeconds: Number(e.target.value) })}>
            {[...INTERVALS, ...(INTERVALS.some((i) => i.value === interval) ? [] : [{ value: interval, label: `Every ${interval} seconds` }])].map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Backups before overwriting" description="Save the previous version of a theme file before replacing it. The last 10 backups per theme are kept.">
          <Switch label="Backups before overwriting" checked={settings.backupsEnabled} onChange={(v) => void A.updateSettings({ backupsEnabled: v })} />
        </Row>
      </Group>
      {info && (
        <Group title="Storage">
          <Row title="App data folder" description={<span className="mono">{info.dataDir}</span>}>
            <button className="btn btn-sm" onClick={() => void A.revealPath(info.dataDir)}>
              <FolderOpen /> Show
            </button>
          </Row>
        </Group>
      )}
    </>
  );
}

function Appearance() {
  const zoom = useZoom((s) => s.zoom);
  const layout = useStore((s) => s.layout);
  return (
    <>
      <Group title="Interface">
        <Row title="Interface zoom" description="Scale everything in the window. Ctrl+mouse wheel, Ctrl+= and Ctrl+- also work; Ctrl+0 resets.">
          <div className="zoom-control">
            <button className="tb-icon" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={zoomOut}>
              <ZoomOut />
            </button>
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Interface zoom level" />
            <button className="tb-icon" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={zoomIn}>
              <ZoomIn />
            </button>
            <button className="zoom-value" onClick={resetZoom} title="Reset to 100%">
              {Math.round(zoom * 100)}%
            </button>
          </div>
        </Row>
      </Group>
      <Group title="Layout">
        <Row title="Phone preview panel" description="Show the phone on the right in every section. It hides by itself in narrow windows.">
          <Switch label="Phone preview panel" checked={layout.phone} onChange={(v) => updateLayout({ phone: v })} />
        </Row>
        <Row title="Bottom panel" description="Problems, output log, ADB log and edit history under the editor.">
          <Switch label="Bottom panel" checked={layout.dock} onChange={(v) => updateLayout({ dock: v })} />
        </Row>
        <Row title="Reset layout" description="Restore panel sizes and visibility to their defaults.">
          <button className="btn btn-sm" onClick={() => updateLayout(DEFAULT_LAYOUT)}>
            <RotateCcw /> Reset
          </button>
        </Row>
      </Group>
    </>
  );
}

function Phone() {
  const settings = useStore((s) => s.settings);
  const adb = useStore((s) => s.adb);
  const mirror = useStore((s) => s.mirror);
  return (
    <>
      <Group title="Connection">
        <Row
          title="adb executable"
          description={
            settings?.adbPath ? (
              <span className="mono">{settings.adbPath}</span>
            ) : (
              <>Automatic: {adb?.location ? <span className="mono">{adb.location.path}</span> : 'not found yet'}</>
            )
          }
        >
          <div className="row" style={{ gap: 6 }}>
            {settings?.adbPath && (
              <button className="btn btn-sm btn-ghost" onClick={() => void A.resetAdbPath()}>
                Use automatic
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void A.chooseAdbPath()}>
              Choose…
            </button>
          </div>
        </Row>
        <Row title="Restart ADB server" description="Fixes most “offline” or stuck devices.">
          <button className="btn btn-sm" onClick={() => void A.restartAdb()}>
            <RotateCcw /> Restart
          </button>
        </Row>
      </Group>
      <Group title="Screen mirroring">
        <Row title="scrcpy" description={mirror?.available ? `Bundled scrcpy ${mirror.version ?? ''}. Opens an interactive window of the phone screen at up to 60 fps, without audio, keeping the phone awake.` : 'The bundled scrcpy was not found. Reinstall Mi Theme Studio.'}>
          <span className={`badge ${mirror?.available ? 'badge-ok' : 'badge-warn'}`}>{mirror?.available ? 'Ready' : 'Missing'}</span>
        </Row>
      </Group>
    </>
  );
}

function Store() {
  const region = useThemeStore((s) => s.region);
  const freeOnly = useThemeStore((s) => s.freeOnly);
  const downloads = useThemeStore((s) => s.downloads);
  return (
    <>
      <Group title="Catalog">
        <Row title="Store region" description="Changes which themes and prices the store shows. US hides paid themes; IN has the largest catalog.">
          <select className="select" value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
                {REGION_NOTES[r] ? ` · ${REGION_NOTES[r]}` : ''}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Free only" description="Hide paid items. Only free items can be downloaded.">
          <Switch label="Free only" checked={freeOnly} onChange={setFreeOnly} />
        </Row>
      </Group>
      <Group title="Downloads">
        <Row title="Downloaded items" description={`${downloads.length} item${downloads.length === 1 ? '' : 's'} kept offline in the app data folder.`}>
          <button
            className="btn btn-sm"
            onClick={() => {
              closeDialog();
              A.goTo('store');
            }}
          >
            Manage
          </button>
        </Row>
      </Group>
    </>
  );
}

function Keys({ query }: { query: string }) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS.filter((c) => c.shortcut && (!q || c.label.toLowerCase().includes(q) || c.shortcut.toLowerCase().includes(q)))) {
      map.set(c.group, [...(map.get(c.group) ?? []), c]);
    }
    return [...map.entries()];
  }, [query]);
  return (
    <>
      {groups.map(([group, commands]) => (
        <Group key={group} title={group}>
          {commands.map((c) => (
            <Row key={c.id} title={c.label}>
              <kbd>{c.shortcut}</kbd>
            </Row>
          ))}
        </Group>
      ))}
      <Group title="Files and selection">
        {[
          ['Move / extend selection', '↑ ↓ / Shift+↑ ↓'],
          ['Expand / collapse folder', '→ / ←'],
          ['Open file', 'Enter'],
          ['Toggle selection', 'Ctrl+Click'],
          ['Select range', 'Shift+Click'],
          ['Apply text edits', 'Ctrl+Enter'],
        ].map(([label, key]) => (
          <Row key={label} title={label}>
            <kbd>{key}</kbd>
          </Row>
        ))}
      </Group>
    </>
  );
}

function UpdatesRow() {
  const { status, version, error, checkedAt, progress } = useUpdater();
  const when = checkedAt ? new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const text =
    status === 'checking'
      ? 'Checking…'
      : status === 'available'
        ? `Version ${version} is available.`
        : status === 'downloading'
          ? `Downloading ${version}${progress !== undefined ? ` · ${Math.round(progress * 100)}%` : '…'}`
          : status === 'installing'
            ? 'Installing and restarting…'
            : status === 'none'
              ? `You have the latest version${when ? ` (checked ${when})` : ''}.`
              : status === 'error'
                ? `Could not check: ${error}`
                : 'Checks GitHub for new versions when the app starts and every few hours.';
  return (
    <Row title="Updates" description={text}>
      {status === 'available' ? (
        <button className="btn btn-primary btn-sm" onClick={() => void installUpdate()}>
          Update and restart
        </button>
      ) : (
        <button className="btn btn-sm" disabled={status === 'checking' || status === 'downloading' || status === 'installing'} onClick={() => void checkForUpdate(true)}>
          Check for updates
        </button>
      )}
    </Row>
  );
}

function About() {
  const info = useStore((s) => s.appInfo);
  const mirror = useStore((s) => s.mirror);
  return (
    <>
      <div className="about-card">
        <span className="tb-mark about-mark">mi</span>
        <div>
          <div className="about-name">Mi Theme Studio</div>
          <div className="muted">Version {info?.version ?? '—'}</div>
        </div>
      </div>
      <Group title="Version">
        <UpdatesRow />
      </Group>
      <Group title="About">
        <Row title="Independent tool" description="Not affiliated with or endorsed by Xiaomi. Contains no Xiaomi application code or assets; store data is loaded from the public Theme Manager service on request." />
        <Row title="License" description="MIT License." />
        <Row title="Bundled software" description={`scrcpy ${mirror?.version ?? ''} by Genymobile (Apache-2.0) with adb (Apache-2.0), FFmpeg and libusb (LGPL-2.1+), SDL2 (zlib). Notices are in the scrcpy folder next to the app.`} />
      </Group>
    </>
  );
}

export function SettingsPanel({ initial = 'general' }: { initial?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    void A.refreshMirror();
    ref.current?.querySelector<HTMLInputElement>('.set-search input')?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const visible = SECTIONS.filter((s) => !q || s.label.toLowerCase().includes(q) || s.keywords.includes(q));
  useEffect(() => {
    if (q && visible.length && !visible.some((s) => s.id === section)) setSection(visible[0].id);
  }, [q]);
  const current = SECTIONS.find((s) => s.id === section)!;

  const restore = async () => {
    await A.updateSettings({ autosaveEnabled: true, autosaveIntervalSeconds: 60, backupsEnabled: true });
    if (settings?.adbPath) await A.resetAdbPath();
    resetZoom();
    setRegion('IN');
    setFreeOnly(false);
    updateLayout(DEFAULT_LAYOUT);
  };

  return (
    <div
      className="modal-backdrop settings-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeDialog();
      }}
    >
      <div
        ref={ref}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            closeDialog();
          }
        }}
      >
        <nav className="set-nav" aria-label="Settings sections">
          <label className="set-search">
            <Search />
            <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search settings" />
          </label>
          {visible.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`set-nav-item ${section === id ? 'is-active' : ''}`} onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined}>
              <Icon /> {label}
            </button>
          ))}
          {!visible.length && <span className="faint set-nav-empty">No matching settings</span>}
          <span className="grow" />
          <div className="set-nav-foot">
            <MonitorSmartphone /> Mi Theme Studio
          </div>
        </nav>
        <div className="set-main">
          <header className="set-head">
            <span className="muted">Settings</span>
            <span className="faint">/</span>
            <strong>{current.label}</strong>
            <span className="grow" />
            <button className="btn btn-ghost btn-sm" onClick={() => void restore()} title="Restore every setting to its default">
              <RotateCcw /> Restore defaults
            </button>
            <button className="tb-icon" aria-label="Close settings" onClick={closeDialog}>
              <X />
            </button>
          </header>
          <div className="set-body">
            <div className="set-content">
              {section === 'general' && <General />}
              {section === 'appearance' && <Appearance />}
              {section === 'phone' && <Phone />}
              {section === 'store' && <Store />}
              {section === 'keys' && <Keys query={q && current.id === 'keys' ? q : ''} />}
              {section === 'about' && <About />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
