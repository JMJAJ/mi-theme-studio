import { BookOpen, FilePlus2, FileArchive, FolderOpen, Globe, LifeBuoy, Smartphone, X } from 'lucide-react';
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
      <div className="welcome">
        <div>
          <h1>Mi Theme Studio</h1>
          <p className="lead">Create, inspect, preview and package MIUI / HyperOS .mtz themes. Everything runs locally; packages are never uploaded.</p>
          <div className="start-list">
            <button className="start-item" onClick={() => void A.openPackage()}>
              <FolderOpen />
              <span>
                <div className="t">Open package…</div>
                <div className="d">.mtz or .zip theme — or drop it on this window</div>
              </span>
              <kbd>Ctrl+O</kbd>
            </button>
            <button className="start-item" onClick={() => void A.newProject()}>
              <FilePlus2 />
              <span>
                <div className="t">New theme</div>
                <div className="d">Start from a minimal description.xml</div>
              </span>
              <kbd>Ctrl+N</kbd>
            </button>
            <button className="start-item" onClick={() => A.openSingleton('device')}>
              <Smartphone />
              <span>
                <div className="t">Device manager</div>
                <div className="d">{device.label}</div>
              </span>
            </button>
            <button className="start-item" onClick={() => A.openSingleton('catalog')}>
              <Globe />
              <span>
                <div className="t">Online themes</div>
                <div className="d">Browse public catalog shelves (read-only)</div>
              </span>
            </button>
            <button className="start-item" onClick={() => A.openSingleton('roadmap')}>
              <BookOpen />
              <span>
                <div className="t">Roadmap & limitations</div>
                <div className="d">What works today and what is planned</div>
              </span>
            </button>
          </div>
        </div>

        <div className="col" style={{ gap: 14 }}>
          {recovery && (
            <div className="banner banner-accent" role="alert">
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
          <div className="section-head" style={{ marginBottom: 2 }}>
            <h2>Recent packages</h2>
          </div>
          {settings?.recent.length ? (
            <div className="surface" style={{ padding: 4 }}>
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
                    <div className="ellipsis">{item.name}</div>
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
            <p className="muted">Packages you open or save appear here.</p>
          )}
        </div>
      </div>
    </div>
  );
}
