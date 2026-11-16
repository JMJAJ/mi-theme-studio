// Title bar: theme identity and save state on the left, a command search in
// the middle, and the actions that matter for a theme (phone, export, save)
// on the right. The full menu lives behind one button.
import { useRef, useState } from 'react';
import { Clock3, Download, FilePen, XCircle, Menu, PanelRight, Redo2, Save, Search, Smartphone, Undo2 } from 'lucide-react';
import { MenuPopup, type MenuAction, type MenuItem } from '../common/Menu';
import { commandById, isEnabled, runCommand } from '../../state/commands';
import { setState, updateLayout, useStore } from '../../state/store';
import { goTo, openPackage } from '../../state/actions';
import { useDeviceSummary } from './deviceSummary';

/**
 * The app menu: the handful of things people reach for. Everything else is a
 * keystroke away in the command palette (Ctrl+K), so it is not repeated here.
 */
function appMenuItems(): MenuItem[] {
  const state = useStore.getState();
  const hasProject = !!state.project;
  const cmd = (id: string, label?: string, icon?: MenuAction['icon']): MenuItem | null => {
    const command = commandById.get(id);
    if (!command || !isEnabled(command, state)) return null;
    return { label: label ?? command.label, icon: icon ?? command.icon, shortcut: command.shortcut, onSelect: () => runCommand(command.id) };
  };
  const recent = (state.settings?.recent ?? []).filter((r) => r.path !== state.project?.sourcePath).slice(0, 4);
  const items: (MenuItem | null)[] = [
    cmd('file.new', 'New theme…'),
    cmd('file.open', 'Open theme…'),
    cmd('file.openPhone', 'Open from phone…'),
    cmd('file.openDownloaded', 'Open downloaded…'),
    ...(recent.length
      ? [{ heading: 'Recent' } as MenuItem, ...recent.map((r): MenuItem => ({ label: r.name.replace(/\.(mtz|zip)$/i, ''), icon: Clock3, onSelect: () => openPackage(r.path) }))]
      : []),
    ...(hasProject ? ['separator' as const, cmd('file.save'), cmd('file.saveAs', undefined, FilePen), cmd('file.exportCopy', 'Export a copy…'), cmd('file.close', 'Close theme', XCircle)] : []),
    'separator',
    cmd('edit.palette', 'Search commands…'),
    cmd('tools.settings', 'Settings'),
    cmd('help.shortcuts'),
    'separator',
    cmd('help.about', 'About Mi Theme Studio'),
  ];
  // Drop empty entries and doubled or dangling separators.
  const out: MenuItem[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue;
    out.push(item);
  }
  while (out[out.length - 1] === 'separator') out.pop();
  return out;
}

export function TitleBar() {
  const project = useStore((s) => s.project);
  const hasDrafts = useStore((s) => Object.keys(s.drafts).length > 0);
  const busy = useStore((s) => s.busy);
  const phoneOpen = useStore((s) => s.layout.phone);
  const device = useDeviceSummary();
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rect = menu ? menuButton.current?.getBoundingClientRect() : undefined;
  const dirty = !!project?.dirty || hasDrafts;

  return (
    <header className="titlebar">
      <button ref={menuButton} className="tb-icon" aria-label="Menu" aria-haspopup="menu" aria-expanded={menu} title="Menu" onClick={() => setMenu((v) => !v)}>
        <Menu />
      </button>
      {menu && rect && <MenuPopup items={appMenuItems()} x={rect.left} y={rect.bottom + 4} anchor={menuButton.current} label="Menu" onClose={() => setMenu(false)} />}

      <button className="tb-theme" onClick={() => project && goTo('design')} disabled={!project} title={project?.sourcePath ?? undefined}>
        <span className="tb-mark">mi</span>
        {project ? (
          <>
            <span className="tb-name ellipsis">{project.title}</span>
            <span className={`tb-state ${dirty ? 'is-dirty' : ''}`}>{dirty ? 'Unsaved' : project.sourcePath ? 'Saved' : 'Not saved yet'}</span>
          </>
        ) : (
          <span className="tb-name muted">Mi Theme Studio</span>
        )}
      </button>
      {project && (
        <div className="tb-group">
          <button className="tb-icon" title={project.undoLabel ? `Undo ${project.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} aria-label="Undo" disabled={!project.canUndo} onClick={() => runCommand('edit.undo')}>
            <Undo2 />
          </button>
          <button className="tb-icon" title={project.redoLabel ? `Redo ${project.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} aria-label="Redo" disabled={!project.canRedo} onClick={() => runCommand('edit.redo')}>
            <Redo2 />
          </button>
        </div>
      )}

      <button className="tb-search" onClick={() => setState({ palette: 'commands' })} title="Search commands and files">
        <Search />
        <span className="grow">{busy ?? 'Search commands, files and parts…'}</span>
        <kbd>Ctrl+K</kbd>
      </button>

      <div className="tb-actions">
        <button className={`tb-phone tone-${device.tone}`} onClick={() => goTo('phone')} title={device.title}>
          <span className={`dot dot-${device.tone}`} />
          <Smartphone />
          <span className="ellipsis">{device.ready ? device.label : device.label === 'No device' ? 'Connect phone' : device.label}</span>
        </button>
        <button className={`tb-icon ${phoneOpen ? 'is-on' : ''}`} aria-pressed={phoneOpen} title={phoneOpen ? 'Hide phone preview' : 'Show phone preview'} aria-label="Toggle phone preview" onClick={() => updateLayout({ phone: !phoneOpen })}>
          <PanelRight />
        </button>
        {project && (
          <>
            <button className="btn btn-ghost" title="Export a copy (Ctrl+E)" onClick={() => runCommand('file.exportCopy')}>
              <Download /> Export
            </button>
            <button className="btn btn-primary" title="Save (Ctrl+S)" onClick={() => runCommand('file.save')}>
              <Save /> Save
            </button>
          </>
        )}
      </div>
    </header>
  );
}
