// Left rail: the places a theme author works in.
import { useState } from 'react';
import { BookOpen, Bot, CircleUserRound, ExternalLink, FolderTree, Keyboard, Library, Loader2, LogOut, Palette, PackageCheck, Send, Settings, ShoppingBag, Smartphone, UserCheck, type LucideIcon } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { projectId, signIn, signOut, startPublishing, usePublish } from '../../state/publish';
import { openContextMenu } from '../common/Menu';
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

/** Design Station account: a sign-in placeholder when signed out, the avatar when signed in. */
function DesignerAccount() {
  const designer = useStore((s) => s.designer);
  const project = useStore((s) => s.project);
  const signingIn = usePublish((s) => s.signingIn);
  const [broken, setBroken] = useState(false);
  if (!designer) return null; // still checking the saved session
  if (!designer.signedIn) {
    return (
      <button
        className="rail-item rail-small rail-account is-signed-out"
        title="Sign in to the Xiaomi Theme Design Station to publish themes"
        onClick={() => void signIn()}
      >
        <span className="rail-icon">{signingIn ? <Loader2 className="spin" /> : <CircleUserRound />}</span>
        <span className="rail-label">{signingIn ? 'Signing in' : 'Sign in'}</span>
      </button>
    );
  }
  const name = designer.nickname ?? 'designer';
  return (
    <button
      className="rail-item rail-small rail-account"
      title={`Xiaomi Theme Design Station: signed in as ${name}`}
      aria-label={`Xiaomi Theme Design Station account (${name})`}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openContextMenu({ clientX: rect.right + 6, clientY: rect.top, preventDefault: () => e.preventDefault() }, [
          { heading: `Signed in as ${name}` },
          { label: 'Publish this theme…', icon: Send, disabled: !project, onSelect: () => startPublishing() },
          { label: 'Open Design Station', icon: ExternalLink, onSelect: () => void openUrl('https://zhuti.designer.intl.xiaomi.com/') },
          'separator',
          { label: 'Sign out', icon: LogOut, onSelect: () => void signOut() },
        ]);
      }}
    >
      <span className="rail-icon">
        {designer.profilePic && !broken ? (
          <img className="rail-avatar" src={designer.profilePic} alt="" onError={() => setBroken(true)} />
        ) : (
          <UserCheck />
        )}
        <span className="rail-dot dot-ok" />
      </span>
    </button>
  );
}

export function Rail() {
  const project = useStore((s) => s.project);
  const validation = useStore((s) => s.validation);
  const device = useDeviceSummary();
  const problems = validation ? validation.errors || validation.warnings : 0;
  // While a publish is under way the tab is the publish flow; otherwise check & export.
  const publishing = usePublish((s) => s.active && s.projectId === projectId(project));
  return (
    <nav className="rail" aria-label="Sections">
      <RailButton section="design" label="Design" icon={Palette} />
      <RailButton section="files" label="Files" icon={FolderTree} disabled={!project} />
      <RailButton section="store" label="Store" icon={ShoppingBag} />
      <RailButton section="library" label="Library" icon={Library} />
      <RailButton section="phone" label="Phone" icon={Smartphone} dot={device.ready ? 'ok' : device.tone === 'warn' || device.tone === 'err' ? device.tone : undefined} />
      <RailButton
        section="check"
        label={publishing ? 'Publish' : 'Export'}
        icon={publishing ? Send : PackageCheck}
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
      <DesignerAccount />
      <button className="rail-item rail-small" title="Settings (Ctrl+,)" onClick={() => setState({ dialog: { type: 'settings' } })}>
        <span className="rail-icon">
          <Settings />
        </span>
      </button>
    </nav>
  );
}
