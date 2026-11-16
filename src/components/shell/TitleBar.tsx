// Title bar: theme identity and save state on the left, a command search in
// the middle, and the actions that matter for a theme (phone, export, save)
// on the right. The full menu lives behind one button.
import { useRef, useState } from 'react';
import { Clock3, Download, Menu, PanelRight, Redo2, Save, Search, Smartphone, Undo2 } from 'lucide-react';
import { MenuPopup, type MenuItem } from '../common/Menu';
import { MENUS, commandById, isEnabled, runCommand } from '../../state/commands';
import { setState, updateLayout, useStore } from '../../state/store';
import { goTo, openPackage } from '../../state/actions';
import { useDeviceSummary } from './deviceSummary';

function allMenuItems(): MenuItem[] {
  const state = useStore.getState();
  const items: MenuItem[] = [];
  for (const menu of MENUS) {
    if (items.length) items.push('separator');
    items.push({ heading: menu.label });
    for (const entry of menu.items) {
      if (entry === '-') continue;
      if (typeof entry === 'object') {
        items.push(entry);
        continue;
      }
      if (entry === 'recent') {
        for (const item of (state.settings?.recent ?? []).slice(0, 5)) {
          items.push({ label: item.name, icon: Clock3, onSelect: () => openPackage(item.path) });
        }
        continue;
      }
      const command = commandById.get(entry);
      if (!command) continue;
      items.push({ label: command.label, icon: command.icon, shortcut: command.shortcut, disabled: !isEnabled(command, state), onSelect: () => runCommand(command.id) });
    }
  }
  return items;
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
      {menu && rect && <MenuPopup items={allMenuItems()} x={rect.left} y={rect.bottom + 4} anchor={menuButton.current} label="Menu" onClose={() => setMenu(false)} />}

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
