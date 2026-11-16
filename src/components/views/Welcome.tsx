// Start screen: three ways into a theme, then recent work.
import { FileArchive, FilePlus2, FolderOpen, LifeBuoy, ShoppingBag, Smartphone, X } from 'lucide-react';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { formatBytes, formatDateTime, relativeTime } from '../../lib/format';
import { useDeviceSummary } from '../shell/deviceSummary';

export function Welcome() {
  const settings = useStore((s) => s.settings);
  const recovery = useStore((s) => s.recoveryOffer);
  const device = useDeviceSummary();

  return (
    <div className="view" data-drop-folder="">
      <div className="start">
        <div className="start-hero">
          <span className="tb-mark start-mark">mi</span>
          <h1>Make a theme for your Xiaomi phone</h1>
          <p>Design wallpapers, lock screens, icons, fonts and sounds, see them on a phone as you go, and export a .mtz for Theme Manager. Drop a theme anywhere on this window to open it.</p>
        </div>

        {recovery && (
          <div className="banner banner-accent start-recovery" role="alert">
            <LifeBuoy />
            <div className="grow">
              <strong>Unsaved work from {formatDateTime(recovery.savedAtMs)}</strong>
              <div className="muted">
                {recovery.name} · {formatBytes(recovery.bytes)} recovery copy from a session that ended without saving.
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-sm btn-primary" onClick={() => void A.restoreRecovery()}>
                Restore
              </button>
              <button className="btn btn-sm" onClick={() => void A.discardRecovery()}>
                Discard
              </button>
            </div>
          </div>
        )}

        <div className="start-cards">
          <button className="start-card is-primary" onClick={() => void A.newProject()}>
            <span className="sc-icon">
              <FilePlus2 />
            </span>
            <span className="sc-title">New theme</span>
            <span className="sc-desc">Start empty and add parts one by one.</span>
            <kbd>Ctrl+N</kbd>
          </button>
          <button className="start-card" onClick={() => void A.openPackage()}>
            <span className="sc-icon">
              <FolderOpen />
            </span>
            <span className="sc-title">Open a theme</span>
            <span className="sc-desc">Edit any .mtz or .zip theme package.</span>
            <kbd>Ctrl+O</kbd>
          </button>
          <button className="start-card" onClick={() => A.goTo('store')}>
            <span className="sc-icon">
              <ShoppingBag />
            </span>
            <span className="sc-title">Start from the store</span>
            <span className="sc-desc">Download a free theme, font or wallpaper and remix it.</span>
          </button>
        </div>

        <div className="start-columns">
          <div>
            <div className="section-head">
              <h2>Recent themes</h2>
            </div>
            {settings?.recent.length ? (
              <div className="surface start-recent">
                {settings.recent.map((item) => (
                  <div
                    key={item.path}
                    className="recent-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => void A.openPackage(item.path)}
                    onKeyDown={(e) => e.key === 'Enter' && void A.openPackage(item.path)}
                    title={item.path}
                  >
                    <FileArchive />
                    <div className="grow">
                      <div className="ellipsis">{item.name.replace(/\.(mtz|zip)$/i, '')}</div>
                      <div className="path ellipsis">{item.path}</div>
                    </div>
                    <span className="faint nowrap" style={{ fontSize: 12 }}>
                      {relativeTime(item.openedAtMs)}
                    </span>
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      aria-label={`Remove ${item.name} from recent`}
                      title="Remove from list"
                      onClick={(e) => {
                        e.stopPropagation();
                        void A.removeRecent(item.path);
                      }}
                    >
                      <X />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">Themes you open or save appear here.</p>
            )}
          </div>
          <div>
            <div className="section-head">
              <h2>Your phone</h2>
            </div>
            <button className="surface start-phone" onClick={() => A.goTo('phone')}>
              <Smartphone />
              <span className="grow">
                <strong>{device.ready ? device.label : 'No phone connected'}</strong>
                <span className="muted">{device.ready ? 'Mirror it, take screenshots and send themes to it.' : 'Connect with USB debugging to preview themes on the real phone.'}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
