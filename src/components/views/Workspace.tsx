import { FileDown, Globe, Info, LayoutDashboard, Map, MonitorSmartphone, Smartphone, X } from 'lucide-react';
import { useStore, type Tab } from '../../state/store';
import { closeTab } from '../../state/actions';
import { openContextMenu } from '../common/Menu';
import { componentIcon, kindIcon } from '../common/icons';
import { Welcome } from './Welcome';
import { Dashboard } from './Dashboard';
import { ThemeInfo } from './ThemeInfo';
import { ComponentView } from './ComponentView';
import { FileView } from './FileView';
import { PreviewView } from './PreviewView';
import { DeviceView } from './DeviceView';
import { BuildView } from './BuildView';
import { CatalogView } from './CatalogView';
import { RoadmapView } from './RoadmapView';
import { ErrorBoundary } from '../common/ErrorBoundary';

function TabIcon({ tab }: { tab: Tab }) {
  const index = useStore((s) => (tab.slot === 'ref' ? s.refIndex : s.fileIndex));
  const map = { dashboard: LayoutDashboard, info: Info, preview: MonitorSmartphone, device: Smartphone, build: FileDown, roadmap: Map, catalog: Globe } as const;
  if (tab.kind === 'component') {
    const Icon = componentIcon(tab.component ?? '');
    return <Icon className="tab-icon" />;
  }
  if (tab.kind === 'file') {
    const file = tab.path ? index.get(tab.path) : undefined;
    const Icon = kindIcon(file?.kind ?? 'binary');
    return <Icon className="tab-icon" />;
  }
  const Icon = map[tab.kind as keyof typeof map] ?? Info;
  return <Icon className="tab-icon" />;
}

function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const drafts = useStore((s) => s.drafts);
  if (!tabs.length) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Open editors">
      {tabs.map((tab) => {
        const dirty = tab.kind === 'file' && tab.slot === 'main' && !!tab.path && !!drafts[tab.path];
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === active}
            className={`tab ${tab.id === active ? 'is-active' : ''}`}
            title={tab.path ?? tab.title}
            onClick={() => useStore.setState({ activeTab: tab.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') useStore.setState({ activeTab: tab.id });
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(tab.id);
            }}
            onContextMenu={(e) =>
              openContextMenu(e, [
                { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => void closeTab(tab.id) },
                {
                  label: 'Close others',
                  onSelect: async () => {
                    for (const other of useStore.getState().tabs) if (other.id !== tab.id && !(await closeTab(other.id))) return;
                  },
                },
              ])
            }
          >
            <TabIcon tab={tab} />
            <span className="ellipsis">{tab.title}</span>
            {tab.slot === 'ref' && <span className="tab-ref">REF</span>}
            <button
              className={`tab-close ${dirty ? 'has-dirty' : ''}`}
              aria-label={`Close ${tab.title}${dirty ? ' (unapplied edits)' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
            >
              {dirty && <span className="tab-dirty" />}
              <X className="x" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ActiveView() {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTab));
  const project = useStore((s) => s.project);
  if (!tab) return project ? <Dashboard /> : <Welcome />;
  switch (tab.kind) {
    case 'dashboard':
      return project ? <Dashboard /> : <Welcome />;
    case 'info':
      return <ThemeInfo />;
    case 'component':
      return <ComponentView key={tab.component} componentId={tab.component!} />;
    case 'file':
      return <FileView key={tab.id} path={tab.path!} slot={tab.slot ?? 'main'} />;
    case 'preview':
      return <PreviewView />;
    case 'device':
      return <DeviceView />;
    case 'build':
      return <BuildView />;
    case 'catalog':
      return <CatalogView />;
    case 'roadmap':
      return <RoadmapView />;
  }
}

export function Workspace() {
  const active = useStore((s) => s.activeTab);
  return (
    <div className="center-body">
      <TabStrip />
      <ErrorBoundary key={active ?? 'none'} name="This view">
        <ActiveView />
      </ErrorBoundary>
    </div>
  );
}
