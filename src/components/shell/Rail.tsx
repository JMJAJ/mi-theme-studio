// Left rail: the places a theme author works in.
import { BookOpen, Bot, FolderTree, Keyboard, Library, Palette, PackageCheck, Settings, ShoppingBag, Smartphone, type LucideIcon } from 'lucide-react';
import { goTo } from '../../state/actions';
import { setState, useStore, type Section } from '../../state/store';
import { useDeviceSummary } from './deviceSummary';

function RailButton({ section, label, icon: Icon, badge, dot, disabled }: { section: Section; label: string; icon: LucideIcon; badge?: React.ReactNode; dot?: string; disabled?: boolean }) {
  const active = useStore((s) => s.section === section);
  return (
    <button className={`rail-item ${active ? 'is-active' : ''}`} onClick={() => goTo(section)} disabled={disabled} aria-current={active ? 'page' : undefined} title={label}>
      <span className="rail-icon">
        <Icon />
        {dot && <span className={`rail-dot dot-${dot}`} />}
        {badge}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

export function Rail() {
  const project = useStore((s) => s.project);
  const validation = useStore((s) => s.validation);
  const device = useDeviceSummary();
  const problems = validation ? validation.errors || validation.warnings : 0;
  return (
    <nav className="rail" aria-label="Sections">
      <RailButton section="design" label="Design" icon={Palette} />
      <RailButton section="files" label="Files" icon={FolderTree} disabled={!project} />
      <RailButton section="store" label="Store" icon={ShoppingBag} />
      <RailButton section="library" label="Library" icon={Library} />
      <RailButton section="phone" label="Phone" icon={Smartphone} dot={device.ready ? 'ok' : device.tone === 'warn' || device.tone === 'err' ? device.tone : undefined} />
      <RailButton
        section="check"
        label="Check"
        icon={PackageCheck}
        disabled={!project}
        badge={problems ? <span className={`rail-badge ${validation?.errors ? 'is-err' : 'is-warn'}`}>{problems > 99 ? '99+' : problems}</span> : undefined}
      />
      <RailButton section="guide" label="Guide" icon={BookOpen} />
      <RailButton section="assistant" label="Assistant" icon={Bot} />
      <span className="grow" />
      <button className="rail-item rail-small" title="Keyboard shortcuts (Ctrl+/)" onClick={() => setState({ dialog: { type: 'shortcuts' } })}>
        <span className="rail-icon">
          <Keyboard />
        </span>
      </button>
      <button className="rail-item rail-small" title="Settings (Ctrl+,)" onClick={() => setState({ dialog: { type: 'settings' } })}>
        <span className="rail-icon">
          <Settings />
        </span>
      </button>
    </nav>
  );
}
