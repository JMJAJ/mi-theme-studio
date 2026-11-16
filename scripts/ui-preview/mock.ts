// Browser preview harness: runs the real UI with Tauri's IPC mocked, fed by
// a fixture exported from a real theme (see vite.config.ts in this folder).
// Development only; never bundled into the app.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

const params = new URLSearchParams(location.search);
const withProject = params.get('project') !== '0';
const withPhone = params.get('phone') !== '0';
(globalThis as { __MTS_RESOURCE_BASE__?: string }).__MTS_RESOURCE_BASE__ = `${location.origin}/__res`;
localStorage.setItem('mts.catalog.consent.v1', '1');

const fixture = await fetch('/__fixture/snapshot.json').then((r) => r.json());
const metadata = await fetch('/__fixture/metadata.json').then((r) => r.json());
const storeHome = await fetch('/__fixture/store-home.json').then((r) => r.json()).catch(() => ({ title: null, hasMore: false, nextStart: 0, sections: [], fetchedAtMs: 0, durationMs: 0 }));
const storeDetail = await fetch('/__fixture/store-detail.json').then((r) => r.json()).catch(() => null);

const device = { serial: '595e1e14', state: 'device', model: '2510DPC44G', product: 'annibale_eea', device: 'annibale', transportId: '3' };
const details = {
  serial: '595e1e14',
  manufacturer: 'Xiaomi',
  brand: 'POCO',
  model: '2510DPC44G',
  marketName: 'POCO F8 Pro',
  androidVersion: '16',
  sdk: 36,
  miuiVersion: null,
  hyperosVersion: 'OS3.0.302.0',
  screen: { width: 1160, height: 2504 },
  screenOverride: null,
  density: 480,
  densityOverride: null,
  abi: 'arm64-v8a',
  themeManagerVersion: '3.0.5.19-global',
  themeManagerInstalled: true,
};

mockWindows('main');
mockIPC((cmd) => {
  switch (cmd) {
    case 'app_info':
      return { version: '0.3.0', dataDir: 'C:/Users/me/AppData/Roaming/mi-theme-studio', recovery: null, settings: { adbPath: null, recent: [{ name: 'Glass Flower.mtz', path: 'C:/Themes/Glass Flower.mtz', openedAtMs: Date.now() }], autosaveEnabled: true, autosaveIntervalSeconds: 60, backupsEnabled: true } };
    case 'project_snapshot':
      return withProject ? fixture : null;
    case 'metadata_get':
      return metadata;
    case 'reference_snapshot':
      return null;
    case 'adb_log':
    case 'screenshots_list':
    case 'store_downloads':
    case 'adb_cached_themes':
      return [];
    case 'adb_status':
      return { location: { path: 'adb.exe', source: 'bundled' }, searched: [], version: '1.0.41', devices: withPhone ? [device] : [], error: null };
    case 'adb_details':
      return details;
    case 'adb_theme_support':
      return { installed: true, version: '3.0.5.19-global', canApply: false, twoStep: false, canOpenStore: true };
    case 'mirror_status':
      return { available: true, running: false, serial: null, startedMs: null, version: '3.3.1' };
    case 'project_validate':
      return { issues: [], errors: 0, warnings: 0, checkedFiles: fixture.files.length, durationMs: 12 };
    case 'store_page':
      return storeHome;
    case 'store_detail':
      return storeDetail;
    case 'plugin:event|listen':
      return 1;
    default:
      return null;
  }
});

await import('../../src/main');
const section = params.get('section');
const part = params.get('part');
if (section || part) {
  const { useStore } = await import('../../src/state/store');
  setTimeout(() => useStore.setState({ section: (section ?? 'design') as never, part }), 900);
}
