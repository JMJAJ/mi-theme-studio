import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { TitleBar } from './components/shell/TitleBar';
import { Rail } from './components/shell/Rail';
import { PhonePanel } from './components/shell/PhonePanel';
import { DesignView } from './components/views/DesignView';
import { CatalogView } from './components/views/CatalogView';
import { PhoneView } from './components/views/PhoneView';
import { BuildView } from './components/views/BuildView';
import { StatusBar } from './components/shell/StatusBar';
import { Explorer } from './components/explorer/Explorer';
import { Workspace } from './components/views/Workspace';
import { Inspector } from './components/inspector/Inspector';
import { Dock } from './components/dock/Dock';
import { DialogHost, Toasts } from './components/dialogs/Dialogs';
import { CommandPalette } from './components/dialogs/CommandPalette';
import { ContextMenuHost } from './components/common/Menu';
import { Splitter } from './components/common/Splitter';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { getState, hasUnsavedWork, updateLayout, useStore, choiceDialog, log } from './state/store';
import { COMMANDS, isEnabled, targetFolder } from './state/commands';
import { matches, isTextTarget } from './lib/shortcuts';
import { api } from './lib/api';
import * as A from './state/actions';
import { installZoom } from './state/zoom';

const PACKAGE_RE = /\.(mtz|zip)$/i;

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = getState();
      if (state.dialog || state.palette) return;
      for (const command of COMMANDS) {
        const keys = [command.shortcut, ...(command.alt ?? [])].filter(Boolean) as string[];
        if (!keys.some((k) => matches(k, event))) continue;
        if (!command.global && isTextTarget(event.target)) return;
        event.preventDefault();
        if (isEnabled(command, state)) void command.run();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useInterfaceZoom() {
  useEffect(() => installZoom(), []);
}

function useFileDrop() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let highlighted: HTMLElement | null = null;
    const targetAt = (x: number, y: number) => {
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / ratio, y / ratio) as HTMLElement | null;
      return el?.closest<HTMLElement>('[data-drop-folder]') ?? null;
    };
    const clear = () => {
      highlighted?.classList.remove('is-drop');
      highlighted = null;
    };
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === 'over') {
          const target = targetAt(payload.position.x, payload.position.y);
          if (target !== highlighted) {
            clear();
            if (target && target.classList.contains('tree-row')) {
              target.classList.add('is-drop');
              highlighted = target;
            }
          }
          return;
        }
        if (payload.type === 'leave') {
          clear();
          return;
        }
        if (payload.type !== 'drop') return;
        clear();
        const paths = payload.paths;
        if (!paths.length) return;
        const state = getState();
        const packages = paths.filter((p) => PACKAGE_RE.test(p));
        if (!state.project) {
          if (packages[0]) await A.openPackage(packages[0]);
          else log('warning', 'Drop a .mtz or .zip package to open it.');
          return;
        }
        const target = targetAt(payload.position.x, payload.position.y);
        const folder = target?.dataset.dropFolder ?? targetFolder();
        if (packages.length === paths.length && packages.length === 1) {
          const choice = await choiceDialog({
            title: 'Dropped a theme package',
            message: `What should happen with ${packages[0].split(/[\\/]/).pop()}?`,
            choices: [
              { id: 'open', label: 'Open it', primary: true },
              { id: 'reference', label: 'Open as reference' },
              { id: 'add', label: 'Add as a file' },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
          if (choice === 'open') await A.openPackage(packages[0]);
          if (choice === 'reference') {
            const snapshot = await api.referenceOpen(packages[0]).catch(() => null);
            if (snapshot) {
              useStore.setState({ reference: snapshot, refIndex: new Map(snapshot.files.map((f) => [f.path, f])), sideTab: 'reference' });
            }
          }
          if (choice === 'add') await A.importFiles(paths, folder);
          return;
        }
        await A.importFiles(paths, folder);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);
}

function useCloseGuard() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        if (!hasUnsavedWork()) return;
        event.preventDefault();
        if (await A.ensureCanDiscard('quit')) {
          await api.projectClose().catch(() => undefined);
          await win.destroy();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);
}

function useBackgroundTasks() {
  const interval = useStore((s) => (s.settings?.autosaveEnabled ? s.settings.autosaveIntervalSeconds : 0));
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(() => void A.autosaveTick(), interval * 1000);
    return () => window.clearInterval(timer);
  }, [interval]);

  // Poll `adb devices` while the window is visible so the device chip stays truthful.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && getState().adb?.location) void A.refreshAdb(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const title = useStore((s) => (s.project ? `${s.project.dirty || Object.keys(s.drafts).length ? '● ' : ''}${s.project.title} — Mi Theme Studio` : 'Mi Theme Studio'));
  useEffect(() => {
    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => undefined);
  }, [title]);
}

/** Files: the advanced, file-level editor (explorer, tabs, inspector). */
function FilesSection() {
  const layout = useStore((s) => s.layout);
  return (
    <div className="files-section">
      {layout.sidebar && (
        <>
          <aside className="sidebar" style={{ width: layout.sidebarWidth }} aria-label="Files">
            <ErrorBoundary name="Explorer">
              <Explorer />
            </ErrorBoundary>
          </aside>
          <Splitter orientation="vertical" label="Resize file list" value={layout.sidebarWidth} min={220} max={560} onChange={(sidebarWidth) => updateLayout({ sidebarWidth })} />
        </>
      )}
      <div className="files-main">
        <ErrorBoundary name="Editor">
          <Workspace />
        </ErrorBoundary>
      </div>
      {layout.inspector && (
        <>
          <Splitter orientation="vertical" label="Resize details" value={layout.inspectorWidth} min={240} max={520} direction={-1} onChange={(inspectorWidth) => updateLayout({ inspectorWidth })} />
          <div style={{ width: layout.inspectorWidth, display: 'flex', minHeight: 0 }}>
            <ErrorBoundary name="Details">
              <Inspector />
            </ErrorBoundary>
          </div>
        </>
      )}
    </div>
  );
}

function SectionView() {
  const section = useStore((s) => s.section);
  const project = useStore((s) => s.project);
  switch (section) {
    case 'files':
      return project ? <FilesSection /> : <DesignView />;
    case 'store':
      return <CatalogView />;
    case 'phone':
      return <PhoneView />;
    case 'check':
      return project ? <BuildView /> : <DesignView />;
    default:
      return <DesignView />;
  }
}

export function App() {
  const layout = useStore((s) => s.layout);
  const section = useStore((s) => s.section);
  const started = useRef(false);
  useGlobalShortcuts();
  useInterfaceZoom();
  useFileDrop();
  useCloseGuard();
  useBackgroundTasks();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void A.init();
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <Rail />
        <div className="stage">
          <main className="center">
            <ErrorBoundary key={section} name="This section">
              <SectionView />
            </ErrorBoundary>
            {layout.dock && (
              <>
                <Splitter orientation="horizontal" label="Resize bottom panel" value={layout.dockHeight} min={90} max={560} direction={-1} onChange={(dockHeight) => updateLayout({ dockHeight })} />
                <div style={{ height: layout.dockHeight, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <ErrorBoundary name="Bottom panel">
                    <Dock />
                  </ErrorBoundary>
                </div>
              </>
            )}
          </main>
        </div>
        {layout.phone && (
          <div className="phone-dock">
            <Splitter orientation="vertical" label="Resize phone preview" value={layout.phoneWidth} min={280} max={620} direction={-1} onChange={(phoneWidth) => updateLayout({ phoneWidth })} />
            {/* Scales with the window: never more than about a third of it. */}
            <div style={{ width: `clamp(280px, ${layout.phoneWidth}px, 30vw)`, display: 'flex', minHeight: 0 }}>
              <ErrorBoundary name="Phone preview">
                <PhonePanel />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
      <StatusBar />
      <ErrorBoundary name="Dialog">
        <DialogHost />
      </ErrorBoundary>
      <CommandPalette />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}
