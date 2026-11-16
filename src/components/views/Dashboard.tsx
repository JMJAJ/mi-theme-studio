import { useMemo } from 'react';
import { AlertTriangle, CircleCheck, CircleX, Download, FolderOpen, Info, MonitorSmartphone, Plus, Save } from 'lucide-react';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { runCommand } from '../../state/commands';
import { formatBytes, formatTime, plural } from '../../lib/format';
import { resourceUrl } from '../../lib/api';
import { componentIcon } from '../common/icons';

export function Dashboard() {
  const project = useStore((s) => s.project)!;
  const validation = useStore((s) => s.validation);
  const builds = useStore((s) => s.builds);

  const stats = useMemo(() => {
    const byComponent = new Map<string, { files: number; bytes: number }>();
    let images = 0;
    let xml = 0;
    let changed = 0;
    for (const f of project.files) {
      const entry = byComponent.get(f.component) ?? { files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += f.size;
      byComponent.set(f.component, entry);
      if (f.kind === 'image') images += 1;
      if (f.kind === 'xml') xml += 1;
      if (f.status !== 'original') changed += 1;
    }
    return { byComponent, images, xml, changed };
  }, [project]);

  const wallpaper = project.files.find((f) => f.component === 'wallpapers' && f.kind === 'image' && /default_wallpaper|wallpaper/i.test(f.path));
  const previews = project.files.filter((f) => f.component === 'previews' && f.kind === 'image').slice(0, 6);

  return (
    <div className="view">
      <div className="view-pad">
        <div className="view-header">
          <div className="grow">
            <h1 className="ellipsis">{project.title}</h1>
            <div className="sub">
              {project.sourcePath ?? 'Not saved yet'} {project.dirty && <span className="badge badge-accent">Unsaved changes</span>}
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => A.openSingleton('info')}>
              <Info /> Theme details
            </button>
            <button className="btn" onClick={() => A.openSingleton('preview')}>
              <MonitorSmartphone /> Preview
            </button>
            <button className="btn" onClick={() => runCommand('file.exportCopy')}>
              <Download /> Export copy
            </button>
            <button className="btn btn-primary" onClick={() => runCommand('file.save')}>
              <Save /> Save
            </button>
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="label">Files</div>
            <div className="value">{project.files.length}</div>
          </div>
          <div className="stat">
            <div className="label">Uncompressed size</div>
            <div className="value">{formatBytes(project.totalBytes)}</div>
          </div>
          <div className="stat">
            <div className="label">Images / XML</div>
            <div className="value">
              {stats.images}
              <small>/ {stats.xml}</small>
            </div>
          </div>
          <div className="stat">
            <div className="label">Component archives</div>
            <div className="value">{project.containers.length}</div>
          </div>
          <div className="stat">
            <div className="label">Changed since save</div>
            <div className="value">
              {stats.changed}
              <small>{project.removed.length ? `+${project.removed.length} removed` : ''}</small>
            </div>
          </div>
          <div className="stat" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => runCommand('view.problems')}>
            <div className="label">Validation</div>
            <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {!validation ? (
                <span className="muted" style={{ fontSize: 13 }}>Checking…</span>
              ) : validation.errors ? (
                <>
                  <CircleX className="err" width={17} /> {validation.errors}
                  <small>errors</small>
                </>
              ) : validation.warnings ? (
                <>
                  <AlertTriangle className="warn" width={17} /> {validation.warnings}
                  <small>warnings</small>
                </>
              ) : (
                <>
                  <CircleCheck className="ok" width={17} /> <small>no problems</small>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Components</h2>
            <span className="muted">Click to browse and edit resources</span>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => void A.addFilesDialog('')}>
                <Plus /> Add files
              </button>
            </div>
          </div>
          <div className="component-list">
            {project.components.map((c) => {
              const s = stats.byComponent.get(c.id);
              const Icon = componentIcon(c.id);
              const container = project.containers.find((x) => x.component === c.id);
              return (
                <button key={c.id} className={`component-row ${s ? '' : 'is-empty'}`} onClick={() => (c.id === 'metadata' ? A.openSingleton('info') : A.openComponent(c.id))} title={c.description}>
                  <Icon />
                  <span className="grow">
                    <div className="name">{c.label}</div>
                    <div className="meta ellipsis">{s ? `${plural(s.files, 'file')} · ${formatBytes(s.bytes)}${container ? ' · archive' : ''}` : c.description}</div>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="section" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 22 }}>
          <div>
            <div className="section-head">
              <h2>Package previews</h2>
              <span className="muted">preview/ images shown by Theme Manager</span>
            </div>
            {previews.length || wallpaper ? (
              <div className="thumb-strip" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' }}>
                {(previews.length ? previews : [wallpaper!]).map((f) => (
                  <button key={f.path} onClick={() => A.openFile(f.path)} title={f.path}>
                    <img src={resourceUrl('main', f.path, f.rev)} alt={f.path} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="banner">
                <Info />
                <span>No preview or wallpaper images yet. Add images to <code>preview/</code> and <code>wallpaper/</code>.</span>
              </div>
            )}
          </div>
          <div>
            <div className="section-head">
              <h2>Recent activity</h2>
            </div>
            <div className="surface" style={{ maxHeight: 220, overflow: 'auto' }}>
              {project.history.length === 0 && builds.length === 0 && (
                <div className="shelf-row muted">
                  <FolderOpen width={14} /> Opened {project.name}. Edits and saves will be listed here.
                </div>
              )}
              {builds.slice(0, 3).map((b) => (
                <div key={b.atMs} className="shelf-row">
                  <Save width={14} className="ok" />
                  <span className="grow ellipsis">
                    {b.mode === 'copy' ? 'Exported copy' : 'Saved'} {b.path}
                  </span>
                  <span className="faint">{formatTime(b.atMs)}</span>
                </div>
              ))}
              {[...project.history].reverse().slice(0, 12).map((h) => (
                <div key={h.id} className="shelf-row" style={{ opacity: h.done ? 1 : 0.5 }}>
                  <span className="grow ellipsis">{h.label}</span>
                  {!h.done && <span className="badge badge-outline">undone</span>}
                  <span className="faint">{formatTime(h.atMs)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {project.importReport && (project.importReport.skipped.length > 0 || project.importReport.warnings.length > 0) && (
          <div className="section">
            <div className="banner banner-warn">
              <AlertTriangle />
              <div>
                <strong>Import notes</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {project.importReport.skipped.map((s) => (
                    <li key={s.path}>
                      Skipped <code>{s.path}</code>: {s.reason}
                    </li>
                  ))}
                  {project.importReport.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
