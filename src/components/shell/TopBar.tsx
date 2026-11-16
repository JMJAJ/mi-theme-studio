import { useRef, useState } from 'react';
import { Clock3, Download, ListChecks, Redo2, Save, Smartphone, Undo2 } from 'lucide-react';
import { MenuPopup, type MenuItem } from '../common/Menu';
import { MENUS, commandById, isEnabled, runCommand } from '../../state/commands';
import { useStore } from '../../state/store';
import { openPackage, openSingleton } from '../../state/actions';
import { useDeviceSummary } from './deviceSummary';

function menuItems(entries: (typeof MENUS)[number]['items']): MenuItem[] {
  const state = useStore.getState();
  const items: MenuItem[] = [];
  for (const entry of entries) {
    if (entry === '-') items.push('separator');
    else if (typeof entry === 'object') items.push(entry);
    else if (entry === 'recent') {
      const recent = state.settings?.recent ?? [];
      if (recent.length) {
        items.push({ heading: 'Recent' });
        for (const item of recent.slice(0, 6)) {
          items.push({ label: item.name, icon: Clock3, onSelect: () => openPackage(item.path) });
        }
      }
    } else {
      const command = commandById.get(entry);
      if (!command) continue;
      items.push({
        label: command.label,
        icon: command.icon,
        shortcut: command.shortcut,
        disabled: !isEnabled(command, state),
        onSelect: () => runCommand(command.id),
      });
    }
  }
  return items;
}

export function TopBar() {
  const project = useStore((s) => s.project);
  const hasDrafts = useStore((s) => Object.keys(s.drafts).length > 0);
  const busy = useStore((s) => s.busy);
  const validation = useStore((s) => s.validation);
  const [open, setOpen] = useState<number | null>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const device = useDeviceSummary();

  const dirty = !!project?.dirty || hasDrafts;
  const rect = open !== null ? triggers.current[open]?.getBoundingClientRect() : undefined;

  return (
    <header className="topbar">
      <div className="brand" aria-label="Mi Theme Studio">
        <div className="brand-mark">mi</div>
      </div>
      <nav className="menubar" aria-label="Main menu">
        {MENUS.map((menu, index) => (
          <button
            key={menu.label}
            ref={(el) => {
              triggers.current[index] = el;
            }}
            type="button"
            className="menu-trigger"
            aria-haspopup="menu"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? null : index)}
            onMouseEnter={() => open !== null && open !== index && setOpen(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                setOpen(index);
                event.preventDefault();
              }
            }}
          >
            {menu.label}
          </button>
        ))}
      </nav>
      {open !== null && rect && (
        <MenuPopup
          items={menuItems(MENUS[open].items)}
          x={rect.left}
          y={rect.bottom + 2}
          anchor={triggers.current[open]}
          label={MENUS[open].label}
          onClose={() => setOpen(null)}
          onNavigate={(direction) => setOpen((current) => (current === null ? null : (current + direction + MENUS.length) % MENUS.length))}
        />
      )}

      <div className="topbar-title" title={project?.sourcePath ?? undefined}>
        {project ? (
          <>
            <strong className="ellipsis">{project.title}</strong>
            <span className="faint ellipsis">{project.name}</span>
            {dirty ? (
              <span className="badge badge-accent" title="There are unsaved changes">
                <span className="dot dot-accent" /> Unsaved
              </span>
            ) : (
              <span className="badge badge-outline">Saved</span>
            )}
          </>
        ) : (
          <span className="faint">No package open</span>
        )}
        {busy && <span className="muted ellipsis">· {busy}</span>}
      </div>

      <div className="topbar-actions">
        <button className="btn btn-ghost btn-icon" title={project?.undoLabel ? `Undo ${project.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} aria-label="Undo" disabled={!project?.canUndo} onClick={() => runCommand('edit.undo')}>
          <Undo2 />
        </button>
        <button className="btn btn-ghost btn-icon" title={project?.redoLabel ? `Redo ${project.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} aria-label="Redo" disabled={!project?.canRedo} onClick={() => runCommand('edit.redo')}>
          <Redo2 />
        </button>
        <span className="sep" />
        <button className="btn btn-ghost" disabled={!project} title="Validate package (Ctrl+Shift+B)" onClick={() => runCommand('project.validate')}>
          <ListChecks />
          {validation ? (
            <span className={validation.errors ? 'err' : validation.warnings ? 'warn' : 'ok'}>
              {validation.errors}·{validation.warnings}
            </span>
          ) : (
            'Validate'
          )}
        </button>
        <button className="btn" disabled={!project} title="Export a copy (Ctrl+E)" onClick={() => runCommand('file.exportCopy')}>
          <Download /> Export
        </button>
        <button className="btn btn-primary" disabled={!project} title="Save (Ctrl+S)" onClick={() => runCommand('file.save')}>
          <Save /> Save
        </button>
        <span className="sep" />
        <button className="device-chip" onClick={() => openSingleton('device')} title={device.title}>
          <span className={`dot dot-${device.tone}`} />
          <Smartphone width={13} height={13} />
          <span className="ellipsis">{device.label}</span>
        </button>
      </div>
    </header>
  );
}
