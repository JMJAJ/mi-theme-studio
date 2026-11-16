import { useMemo } from 'react';
import { FileDown, Globe, Info, LayoutDashboard, Map as MapIcon, MonitorSmartphone, Smartphone } from 'lucide-react';
import { useStore } from '../../state/store';
import { openComponent, openSingleton } from '../../state/actions';
import { componentIcon } from '../common/icons';

/** Left navigation: workspace views, components with live counts, output. */
export function Navigator() {
  const project = useStore((s) => s.project);
  const activeTab = useStore((s) => s.activeTab);
  const validation = useStore((s) => s.validation);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of project?.files ?? []) map.set(file.component, (map.get(file.component) ?? 0) + 1);
    return map;
  }, [project]);

  const item = (id: string, label: string, Icon: typeof Info, onClick: () => void, extra?: React.ReactNode, disabled = false) => (
    <button key={id} className={`nav-item ${activeTab === id ? 'is-active' : ''}`} onClick={onClick} disabled={disabled} aria-current={activeTab === id ? 'page' : undefined}>
      <Icon />
      <span className="ellipsis">{label}</span>
      {extra}
    </button>
  );

  return (
    <nav className="nav" aria-label="Editor navigation">
      <div className="nav-heading">Workspace</div>
      {item('dashboard', 'Dashboard', LayoutDashboard, () => openSingleton('dashboard'), undefined, !project)}
      {item('info', 'Theme details', Info, () => openSingleton('info'), undefined, !project)}

      {project && (
        <>
          <div className="nav-heading">Components</div>
          {project.components
            .filter((c) => c.id !== 'metadata')
            .filter((c) => (counts.get(c.id) ?? 0) > 0 || ['wallpapers', 'icons', 'lockscreen', 'systemui', 'fonts', 'previews'].includes(c.id))
            .map((c) =>
              item(`component:${c.id}`, c.label, componentIcon(c.id), () => openComponent(c.id), <span className="count">{counts.get(c.id) ?? 0}</span>),
            )}
        </>
      )}

      <div className="nav-heading">Output</div>
      {item('preview', 'Preview', MonitorSmartphone, () => openSingleton('preview'), undefined, !project)}
      {item('device', 'Device', Smartphone, () => openSingleton('device'))}
      {item(
        'build',
        'Build & export',
        FileDown,
        () => openSingleton('build'),
        validation && (validation.errors || validation.warnings) ? (
          <span className={`badge ${validation.errors ? 'badge-err' : 'badge-warn'}`}>{validation.errors || validation.warnings}</span>
        ) : undefined,
        !project,
      )}
      <div className="nav-heading">Discover</div>
      {item('catalog', 'Online themes', Globe, () => openSingleton('catalog'), <span className="badge badge-outline">Browse only</span>)}
      {item('roadmap', 'Roadmap', MapIcon, () => openSingleton('roadmap'))}
    </nav>
  );
}
