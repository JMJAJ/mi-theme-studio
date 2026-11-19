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
const storeCategories = await fetch('/__fixture/store-categories.json').then((r) => r.json()).catch(() => storeHome);
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

const inventory = new Map<string, { item: Record<string, unknown>; files: { path: string; data: number[] }[] }>();
mockWindows('main');
mockIPC((cmd, args) => {
  switch (cmd) {
    case 'app_info':
      return { version: '0.3.0', dataDir: 'C:/Users/me/AppData/Roaming/mi-theme-studio', recovery: null, settings: { adbPath: null, recent: [{ name: 'Glass Flower.mtz', path: 'C:/Themes/Glass Flower.mtz', openedAtMs: Date.now() }], autosaveEnabled: true, autosaveIntervalSeconds: 60, backupsEnabled: true } };
    case 'file_text': {
      // Text files straight from the fixture, so layouts (lock screen MAML, theme_values.xml) draw here too.
      const { path } = args as { path: string };
      return fetch(`/__res/main/${encodeURIComponent(path)}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`No such file: ${path}`))))
        .then((text) => ({ path, text, lossy: false, bom: false, rev: 0 }));
    }
    case 'file_write_text':
      (globalThis as { __lastWrite?: unknown }).__lastWrite = args;
      return fixture;
    case 'project_snapshot':
      return withProject ? fixture : null;
    case 'metadata_get':
      return metadata;
    case 'metadata_update':
    case 'files_delete':
      return fixture;
    case 'reference_snapshot':
      return params.get('ref') ? { ...fixture, title: 'Reference copy' } : null;
    case 'inventory_list':
      return [...inventory.values()].map((v) => v.item);
    case 'inventory_save': {
      const { item, files } = args as { item: Record<string, unknown>; files: { path: string; data: number[] }[] };
      const id = (item.id as string) || `i${Date.now().toString(16)}`;
      const saved = { ...item, id, createdMs: Date.now(), files: files.map((f) => f.path) };
      inventory.set(id, { item: saved, files });
      return saved;
    }
    case 'inventory_update': {
      const { id, patch } = args as { id: string; patch: object };
      const v = inventory.get(id)!;
      v.item = { ...v.item, ...patch };
      return v.item;
    }
    case 'inventory_delete':
      inventory.delete((args as { id: string }).id);
      return null;
    case 'inventory_files':
      return inventory.get((args as { id: string }).id)?.files ?? [];
    case 'adb_log':
    case 'screenshots_list':
    case 'store_downloads':
      return [];
    case 'adb_list_apps':
      return [
        ['Camera', 'com.android.camera', true], ['Chrome', 'com.android.chrome', true], ['Gallery', 'com.miui.gallery', true],
        ['Telegram', 'org.telegram.messenger', false], ['Discord', 'com.discord', false], ['Settings', 'com.android.settings', true],
        ['Calendar', 'com.android.calendar', true], ['Spotify', 'com.spotify.music', false],
      ].map(([label, pkg, system]) => ({ label, package: pkg, system }));
    case 'adb_cached_themes':
      return ['Dark Anime', 'Faith', 'Grey Sonnet', 'Holy Sword'].map((title, i) => ({
        localId: `00000000-0000-4000-8000-00000000000${i}`, title, author: 'Xiaomi', designer: null, description: null,
        components: ['icons', 'lockscreen', 'wallpaper'], hasPreview: false,
      }));
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
      return (args as { query?: { kind?: string } })?.query?.kind === 'categories' ? storeCategories : storeHome;
    case 'store_detail':
      return storeDetail;
    case 'plugin:event|listen':
      return 1;
    // AI: Pollinations (free, no key) straight from the browser, without streaming.
    case 'ai_settings':
    case 'ai_settings_update':
      return { active: 'pollinations', providers: { pollinations: { baseUrl: 'https://text.pollinations.ai/openai', model: 'openai', hasKey: false } }, autoApply: false };
    case 'ai_models':
      return ['openai'];
    case 'ai_cancel':
      return null;
    case 'ai_chat': {
      const { body } = args as { body: Record<string, unknown> };
      return fetch('/__ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: 'openai', stream: false }) })
        .then((r) => r.json())
        .then((j) => {
          if (j.error) throw { code: 'ai_http', message: `The AI provider answered: ${j.error.message ?? JSON.stringify(j.error)}` };
          const m = j.choices?.[0]?.message ?? {};
          return { content: m.content ?? '', reasoning: m.reasoning ?? '', toolCalls: (m.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: unknown } }) => ({ id: c.id, name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) })), finishReason: j.choices?.[0]?.finish_reason ?? null, model: j.model ?? null, cancelled: false };
        });
    }
    default:
      return null;
  }
});

await import('../../src/main');
const dialog = params.get('dialog');
if (dialog) {
  const { useStore } = await import('../../src/state/store');
  setTimeout(() => useStore.setState({ dialog: { type: 'settings', section: dialog as never } }), 900);
}
if (params.get('menu')) setTimeout(() => (document.querySelector('[aria-label="Menu"]') as HTMLButtonElement | null)?.click(), 1200);
const select = params.get('select');
if (select) {
  const { useStore } = await import('../../src/state/store');
  setTimeout(() => useStore.setState((s) => ({ selection: [select], selectionAnchor: select, layout: { ...s.layout, inspector: true, sidebar: true } }) as never), 1200);
  if (params.get('zoom')) setTimeout(() => {
    const box = document.querySelector('.zoom-box');
    const r = box?.getBoundingClientRect();
    if (box && r) for (let i = 0; i < 6; i++) box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.4, bubbles: true, cancelable: true }));
  }, 2600);
}
const pane = params.get('pane');
if (pane) setTimeout(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === pane) as HTMLButtonElement | undefined)?.click(), 2000);
const click = params.get('click');
if (click) {
  setTimeout(() => {
    const target = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === click || b.textContent?.trim().startsWith(click));
    target?.click();
  }, 1600);
}
if (params.get('logs')) {
  const { useStore } = await import('../../src/state/store');
  setTimeout(() => useStore.setState((s) => ({ dockTab: 'output', layout: { ...s.layout, dock: true }, logs: Array.from({ length: 120 }, (_, i) => ({ id: i, atMs: Date.now() - (120 - i) * 1000, level: i % 9 ? 'info' : 'warning', message: `Log line ${i + 1}` })) as never })), 900);
  setTimeout(() => document.querySelectorAll('.dock-body').forEach((el) => (el.scrollTop = el.scrollHeight)), 2200);
}
const section = params.get('section');
const part = params.get('part');
if (section || part) {
  const { useStore } = await import('../../src/state/store');
  setTimeout(() => useStore.setState({ section: (section ?? 'design') as never, part }), 900);
}
