import { useMemo } from 'react';
import { Archive, Copy, Download, ExternalLink, Folder, FolderInput, Package, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { displayFolder, fileName, parentOf } from '../../lib/paths';
import { dimensions, formatBytes, plural } from '../../lib/format';
import type { FileInfo, Slot } from '../../lib/types';
import { setState, useStore } from '../../state/store';
import * as A from '../../state/actions';
import { issueIcon } from '../views/ProblemList';

function FileDetails({ file, slot }: { file: FileInfo; slot: Slot }) {
  const validation = useStore((s) => s.validation);
  const issues = useMemo(() => (slot === 'main' ? (validation?.issues ?? []).filter((i) => i.path === file.path) : []), [validation, slot, file.path]);
  const component = useStore((s) => (slot === 'main' ? s.project : s.reference)?.components.find((c) => c.id === file.component));
  return (
    <>
      <div className="insp-section">
        <div className="insp-title">{fileName(file.path)}</div>
        <div className="insp-path selectable">{file.path}</div>
      </div>
      {file.kind === 'image' && (
        <div className="insp-section">
          <div className="insp-preview checker">
            <img src={resourceUrl(slot, file.path, file.rev)} alt={`Preview of ${fileName(file.path)}`} />
          </div>
        </div>
      )}
      <div className="insp-section">
        <h3>Properties</h3>
        <dl className="kv">
          <dt>Component</dt>
          <dd>{component?.label ?? file.component}</dd>
          <dt>Folder</dt>
          <dd className="mono">{displayFolder(parentOf(file.path))}</dd>
          <dt>Type</dt>
          <dd>
            {file.format ?? file.kind}
            {file.ninePatch && ' · nine-patch'}
          </dd>
          {file.width && (
            <>
              <dt>Dimensions</dt>
              <dd>{dimensions(file.width, file.height)} px</dd>
            </>
          )}
          {file.density && (
            <>
              <dt>Density</dt>
              <dd>{file.density}</dd>
            </>
          )}
          <dt>Size</dt>
          <dd>
            {formatBytes(file.size)} <span className="faint">({file.size.toLocaleString()} B)</span>
          </dd>
          <dt>Compression</dt>
          <dd>{file.compression}</dd>
          {slot === 'main' && (
            <>
              <dt>Status</dt>
              <dd>
                {file.status === 'original' ? (
                  <span className="muted">Unchanged since open/save</span>
                ) : (
                  <span className={`badge ${file.status === 'added' ? 'badge-ok' : 'badge-warn'}`}>{file.status}</span>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>
      {issues.length > 0 && (
        <div className="insp-section">
          <h3>Problems</h3>
          {issues.map((issue, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', marginBottom: 6, fontSize: 12 }}>
              <span style={{ width: 14, flex: 'none' }}>{issueIcon(issue)}</span>
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="insp-section">
        <h3>Actions</h3>
        <div className="insp-actions">
          <button className="btn btn-sm" onClick={() => A.openFile(file.path, slot)}>
            <ExternalLink /> Open
          </button>
          <button className="btn btn-sm" onClick={() => void A.extractFile(file.path, slot)}>
            <Download /> Export…
          </button>
          {slot === 'main' ? (
            <>
              <button className="btn btn-sm" onClick={() => void A.replaceFile(file.path)}>
                <RefreshCw /> Replace…
              </button>
              <button className="btn btn-sm" onClick={() => void A.renamePath(file.path)}>
                <Pencil /> Rename…
              </button>
              <button className="btn btn-sm" onClick={() => void A.duplicatePaths([file.path])}>
                <Copy /> Duplicate
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => void A.deletePaths([file.path])}>
                <Trash2 /> Delete
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setState({ dialog: { type: 'copyPlan', paths: [file.path] } })}>
              <Copy /> Copy to project…
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function FolderDetails({ path }: { path: string }) {
  const project = useStore((s) => s.project)!;
  const container = project.containers.find((c) => c.name === path);
  const prefix = container ? `${path}!/` : path.endsWith('!/') ? path : `${path}/`;
  const files = project.files.filter((f) => f.path.startsWith(prefix));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const isRootFolder = !container && !path.includes('/') && !path.includes('!/');
  return (
    <>
      <div className="insp-section">
        <div className="row">
          {container ? <Archive width={16} className="muted" /> : <Folder width={16} className="muted" />}
          <div className="insp-title">{container ? path : fileName(path)}</div>
        </div>
        <div className="insp-path">{container ? 'Component archive (ZIP stored inside the package)' : path}</div>
      </div>
      <div className="insp-section">
        <h3>Contents</h3>
        <dl className="kv">
          <dt>Files</dt>
          <dd>{files.length}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(bytes)} uncompressed</dd>
          {container && (
            <>
              <dt>Archive</dt>
              <dd>{container.originalBytes ? `${formatBytes(container.originalBytes)} as imported` : 'New'}</dd>
              <dt>On save</dt>
              <dd>{container.status === 'original' ? 'Copied unchanged' : 'Rebuilt from its files'}</dd>
            </>
          )}
          <dt>Changed</dt>
          <dd>{files.filter((f) => f.status !== 'original').length}</dd>
        </dl>
      </div>
      <div className="insp-section">
        <h3>Actions</h3>
        <div className="insp-actions">
          <button className="btn btn-sm" onClick={() => void A.addFilesDialog(container ? `${path}!/` : path)}>
            <Plus /> Add files…
          </button>
          <button className="btn btn-sm" onClick={() => void A.renamePath(path)}>
            <Pencil /> Rename…
          </button>
          {isRootFolder && (
            <button className="btn btn-sm" onClick={() => void A.packFolder(path)}>
              <Package /> Pack as archive
            </button>
          )}
          <button className="btn btn-sm btn-danger" onClick={() => void A.deletePaths([path])}>
            <Trash2 /> Delete
          </button>
        </div>
      </div>
    </>
  );
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const index = useStore((s) => s.fileIndex);
  const refIndex = useStore((s) => s.refIndex);
  const refSelection = useStore((s) => s.refSelection);
  const sideTab = useStore((s) => s.sideTab);
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTab));

  let body: React.ReactNode;
  const refFocus = activeTab?.slot === 'ref' ? activeTab.path : sideTab === 'reference' && refSelection.length === 1 ? refSelection[0] : undefined;
  if (refFocus && refIndex.get(refFocus)) {
    body = <FileDetails file={refIndex.get(refFocus)!} slot="ref" />;
  } else if (!project) {
    body = <div className="tree-empty">Open a package to inspect its resources.</div>;
  } else if (selection.length === 0) {
    body = (
      <div className="insp-section">
        <div className="insp-title">{project.title}</div>
        <div className="insp-path">{project.sourcePath ?? 'Not saved yet'}</div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Files</dt>
          <dd>{project.files.length}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(project.totalBytes)}</dd>
          <dt>Components</dt>
          <dd>{project.containers.length} archives</dd>
        </dl>
        <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>Select a file or folder to see its properties.</p>
      </div>
    );
  } else if (selection.length === 1) {
    const file = index.get(selection[0]);
    body = file ? <FileDetails file={file} slot="main" /> : <FolderDetails path={selection[0]} />;
  } else {
    const files = selection.map((p) => index.get(p)).filter(Boolean) as FileInfo[];
    body = (
      <>
        <div className="insp-section">
          <div className="insp-title">{plural(selection.length, 'item')} selected</div>
          <div className="insp-path">
            {plural(files.length, 'file')} · {formatBytes(files.reduce((n, f) => n + f.size, 0))}
          </div>
        </div>
        <div className="insp-section">
          <h3>Actions</h3>
          <div className="insp-actions">
            <button className="btn btn-sm" disabled={!files.length} onClick={() => void A.duplicatePaths(selection)}>
              <Copy /> Duplicate
            </button>
            <button className="btn btn-sm" onClick={() => setState({ dialog: { type: 'move', paths: selection } })}>
              <FolderInput /> Move…
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => void A.deletePaths(selection)}>
              <Trash2 /> Delete
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="panel-header">Inspector</div>
      <div className="inspector-body">{body}</div>
    </aside>
  );
}
