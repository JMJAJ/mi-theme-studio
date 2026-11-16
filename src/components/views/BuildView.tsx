import { useMemo } from 'react';
import { AlertTriangle, CircleCheck, Download, FileText, FolderOpen, ListChecks, Loader2, Save, ShieldAlert } from 'lucide-react';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { runCommand } from '../../state/commands';
import { formatBytes, formatTime, plural } from '../../lib/format';
import { ProblemList } from './ProblemList';

export function BuildView() {
  const project = useStore((s) => s.project);
  const validation = useStore((s) => s.validation);
  const validating = useStore((s) => s.validating);
  const progress = useStore((s) => s.exportProgress);
  const builds = useStore((s) => s.builds);
  const appInfo = useStore((s) => s.appInfo);
  const settings = useStore((s) => s.settings);

  const changes = useMemo(() => {
    const added = project?.files.filter((f) => f.status === 'added') ?? [];
    const modified = project?.files.filter((f) => f.status === 'modified') ?? [];
    return { added, modified, removed: project?.removed ?? [] };
  }, [project]);

  if (!project) return <div className="empty">Open a package to build it.</div>;
  const rebuilt = project.containers.filter((c) => c.status !== 'original');

  return (
    <div className="view">
      <div className="view-pad">
        <div className="view-header">
          <div>
            <h1>Build & export</h1>
            <div className="sub">Packages are written atomically, re-read and verified entry by entry. Existing files are backed up first{settings?.backupsEnabled ? '' : ' (backups are off in Settings)'}.</div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void A.runValidation(false)} disabled={validating}>
              {validating ? <Loader2 className="spin" /> : <ListChecks />} Validate
            </button>
            <button className="btn" onClick={() => void A.saveReport()}>
              <FileText /> Save report…
            </button>
            <button className="btn" onClick={() => runCommand('file.exportCopy')}>
              <Download /> Export copy…
            </button>
            <button className="btn" onClick={() => runCommand('file.saveAs')}>
              Save as…
            </button>
            <button className="btn btn-primary" onClick={() => runCommand('file.save')}>
              <Save /> {project.sourcePath ? 'Save' : 'Save…'}
            </button>
          </div>
        </div>

        {progress && (
          <div className="surface surface-pad" style={{ marginBottom: 16 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Loader2 className="spin" width={14} />
              {progress.stage === 'write' ? `Writing entries ${progress.done} / ${progress.total}` : progress.stage === 'verify' ? 'Verifying archive…' : progress.stage === 'write-file' ? 'Writing file…' : 'Collecting files…'}
            </div>
            <div className="progress">
              <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%` }} />
            </div>
          </div>
        )}

        <div className="stats">
          <div className="stat">
            <div className="label">Output</div>
            <div className="value ellipsis" style={{ fontSize: 14 }} title={project.sourcePath ?? ''}>
              {project.name}
            </div>
          </div>
          <div className="stat">
            <div className="label">Added / modified / removed</div>
            <div className="value">
              {changes.added.length} <small>/</small> {changes.modified.length} <small>/</small> {changes.removed.length}
            </div>
          </div>
          <div className="stat">
            <div className="label">Components rebuilt on save</div>
            <div className="value">
              {rebuilt.length}
              <small>of {project.containers.length}</small>
            </div>
          </div>
          <div className="stat">
            <div className="label">Validation</div>
            <div className="value" style={{ fontSize: 15 }}>
              {validation ? (
                <span className={validation.errors ? 'err' : validation.warnings ? 'warn' : 'ok'}>
                  {plural(validation.errors, 'error')}, {plural(validation.warnings, 'warning')}
                </span>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Problems</h2>
            {validation && (
              <span className="muted">
                {validation.checkedFiles} files, {validation.checkedXml} XML documents, {validation.checkedReferences} image references checked
              </span>
            )}
          </div>
          <div className="surface" style={{ maxHeight: 280, overflow: 'auto', padding: '4px 0' }}>
            <ProblemList />
          </div>
          {validation?.errors ? (
            <div className="banner banner-warn" style={{ marginTop: 10 }}>
              <AlertTriangle /> Saving is still allowed with errors, but the package is unlikely to work on a device until they are fixed.
            </div>
          ) : null}
        </div>

        <div className="section" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 22 }}>
          <div>
            <div className="section-head">
              <h2>What gets written</h2>
            </div>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Every file in the package, including files this editor does not understand, keeps its path and compression method.</li>
              <li>Unchanged component archives ({project.containers.length - rebuilt.length}) are copied byte-for-byte.</li>
              <li>Changed component archives ({rebuilt.length ? rebuilt.map((c) => c.name).join(', ') : 'none'}) are rebuilt from their files.</li>
              {project.importReport?.skipped.length ? <li className="warn">{plural(project.importReport.skipped.length, 'unsafe entry', 'unsafe entries')} skipped at import will not be written.</li> : null}
            </ul>
          </div>
          <div>
            <div className="section-head">
              <h2>Compatibility</h2>
            </div>
            <div className="banner">
              <ShieldAlert />
              <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                {(validation?.limitations ?? []).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {project.attributions.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>Reused resources</h2>
              <span className="muted">Included in the package report</span>
            </div>
            <table className="table surface">
              <tbody>
                {project.attributions.map((a, i) => (
                  <tr key={i}>
                    <td>{plural(a.files, 'file')}</td>
                    <td>
                      from “{a.sourceTitle}” {a.sourceAuthor ? `by ${a.sourceAuthor}` : ''}
                    </td>
                    <td className="muted">{a.sourceFile}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="section">
          <div className="section-head">
            <h2>Builds this session</h2>
            {appInfo && (
              <div className="actions">
                <button className="btn btn-sm" onClick={() => void A.revealPath(appInfo.backupsDir)}>
                  <FolderOpen /> Backups folder
                </button>
              </div>
            )}
          </div>
          {builds.length === 0 ? (
            <p className="muted">Nothing saved or exported yet in this session.</p>
          ) : (
            <table className="table surface">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  <th>File</th>
                  <th className="num">Size</th>
                  <th className="num">Entries</th>
                  <th>Check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {builds.map((b) => (
                  <tr key={b.atMs}>
                    <td className="muted">{formatTime(b.atMs)}</td>
                    <td>{b.mode === 'copy' ? 'Copy' : b.mode === 'saveAs' ? 'Save as' : 'Save'}</td>
                    <td className="mono ellipsis" style={{ maxWidth: 360 }} title={b.path}>
                      {b.path}
                    </td>
                    <td className="num">{formatBytes(b.bytes)}</td>
                    <td className="num">{b.entries}</td>
                    <td>
                      {b.verified && (
                        <span className="badge badge-ok">
                          <CircleCheck /> verified
                        </span>
                      )}
                      {b.backupPath && <span className="badge badge-outline" title={b.backupPath}>backup kept</span>}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => void A.revealPath(b.path)}>
                        Show
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
