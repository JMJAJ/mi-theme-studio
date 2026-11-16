import { useMemo, useState } from 'react';
import { Archive, Download, FolderPlus, Grid2x2, List, Package, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { displayFolder, extension, fileName, parentOf } from '../../lib/paths';
import { dimensions, formatBytes, plural } from '../../lib/format';
import type { FileInfo } from '../../lib/types';
import { getState, useStore } from '../../state/store';
import * as A from '../../state/actions';
import { openContextMenu } from '../common/Menu';
import { componentIcon } from '../common/icons';

type Sort = 'name' | 'size' | 'status';

export function ComponentView({ componentId }: { componentId: string }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'grid' | 'list'>(componentId === 'fonts' || componentId === 'sounds' ? 'list' : 'grid');
  const [tile, setTile] = useState(componentId === 'icons' ? 104 : 140);
  const [density, setDensity] = useState('all');
  const [sort, setSort] = useState<Sort>('name');
  const [bg, setBg] = useState<'checker' | 'bg-dark' | 'bg-light'>('checker');

  const def = project?.components.find((c) => c.id === componentId);
  const files = useMemo(() => (project?.files ?? []).filter((f) => f.component === componentId), [project, componentId]);
  const densities = useMemo(() => [...new Set(files.map((f) => f.density).filter(Boolean) as string[])].sort(), [files]);
  const folders = useMemo(() => [...new Set(files.map((f) => parentOf(f.path)))].sort(), [files]);
  const containers = project?.containers.filter((c) => c.component === componentId) ?? [];
  const [folder, setFolder] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = files.filter((f) => (!q || f.path.toLowerCase().includes(q)) && (density === 'all' || f.density === density));
    const sorted = [...list];
    if (sort === 'name') sorted.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path), undefined, { numeric: true }));
    if (sort === 'size') sorted.sort((a, b) => b.size - a.size);
    if (sort === 'status') sorted.sort((a, b) => (a.status === b.status ? 0 : a.status === 'original' ? 1 : -1));
    return sorted;
  }, [files, query, density, sort]);
  const ordered = useMemo(() => visible.map((f) => f.path), [visible]);
  const selected = new Set(selection);

  if (!project || !def) return <div className="empty">Open a package first.</div>;
  const Icon = componentIcon(componentId);
  const destination = folder ?? (containers[0] ? `${containers[0].name}!/` : folders[0] ?? def.defaultRoot);
  const needsArchive = def.archive && def.defaultRoot && !containers.length && !project.files.some((f) => f.path.startsWith(`${def.defaultRoot}/`));

  const onTileClick = (event: React.MouseEvent, file: FileInfo) => {
    const modeSel = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single';
    A.select(file.path, modeSel, ordered);
  };
  const context = (event: React.MouseEvent, file: FileInfo) => {
    if (!getState().selection.includes(file.path)) A.select(file.path, 'single');
    const keys = getState().selection;
    openContextMenu(event, [
      { label: 'Open', onSelect: () => A.openFile(file.path) },
      { label: 'Replace…', icon: RefreshCw, disabled: keys.length > 1, onSelect: () => A.replaceFile(file.path) },
      { label: 'Export file…', icon: Download, disabled: keys.length > 1, onSelect: () => A.extractFile(file.path) },
      { label: 'Show in explorer', onSelect: () => A.revealInExplorer(file.path) },
      'separator',
      { label: 'Rename…', shortcut: 'F2', disabled: keys.length !== 1, onSelect: () => A.renamePath(file.path) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => A.duplicatePaths(keys) },
      'separator',
      { label: keys.length > 1 ? `Delete ${keys.length} files` : 'Delete', icon: Trash2, danger: true, onSelect: () => A.deletePaths(keys) },
    ]);
  };

  return (
    <div className="center-body">
      <div className="toolbar">
        <Icon width={16} height={16} className="muted" />
        <strong>{def.label}</strong>
        <span className="muted">{plural(files.length, 'file')}</span>
        <span className="sep" />
        <div className="search" style={{ width: 200 }}>
          <Search />
          <input className="input" placeholder={`Filter ${def.label.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter" />
        </div>
        {densities.length > 1 && (
          <select className="select" value={density} onChange={(e) => setDensity(e.target.value)} aria-label="Density">
            <option value="all">All densities</option>
            {densities.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="name">Sort: name</option>
          <option value="size">Sort: size</option>
          <option value="status">Sort: changed first</option>
        </select>
        <div className="segmented" role="group" aria-label="Layout">
          <button aria-pressed={mode === 'grid'} onClick={() => setMode('grid')} title="Grid">
            <Grid2x2 />
          </button>
          <button aria-pressed={mode === 'list'} onClick={() => setMode('list')} title="List">
            <List />
          </button>
        </div>
        {mode === 'grid' && (
          <>
            <input type="range" min={72} max={240} value={tile} onChange={(e) => setTile(Number(e.target.value))} aria-label="Thumbnail size" style={{ width: 90, accentColor: 'var(--accent)' }} />
            <select className="select" value={bg} onChange={(e) => setBg(e.target.value as typeof bg)} aria-label="Thumbnail background">
              <option value="checker">Checkerboard</option>
              <option value="bg-dark">Black</option>
              <option value="bg-light">Light</option>
            </select>
          </>
        )}
        <span className="grow" />
        {selection.length > 0 && selection.every((p) => files.some((f) => f.path === p)) && (
          <button className="btn btn-sm btn-danger" onClick={() => void A.deletePaths(selection)}>
            <Trash2 /> Delete {selection.length}
          </button>
        )}
        {(folders.length > 0 || containers.length > 0) && (
          <select className="select" value={destination} onChange={(e) => setFolder(e.target.value)} aria-label="Destination folder" title="Folder new files are added to">
            {[...new Set([...(containers.map((c) => `${c.name}!/`)), ...folders, ...(def.defaultRoot ? [def.defaultRoot] : [])])].map((f) => (
              <option key={f} value={f}>
                Add to: {displayFolder(f)}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => void A.addFilesDialog(destination)} disabled={!!needsArchive}>
          <Plus /> Add files
        </button>
      </div>

      <div className="view" data-drop-folder={needsArchive ? undefined : destination}>
        {needsArchive && (
          <div className="view-pad" style={{ paddingBottom: 0 }}>
            <div className="banner banner-info">
              <Archive />
              <span className="grow">
                {def.label} resources are stored in a component archive named <code>{def.defaultRoot}</code> inside the package. Create it to start adding files.
              </span>
              <div className="actions">
                <button className="btn btn-sm btn-primary" onClick={() => void A.createContainer(def.defaultRoot)}>
                  <FolderPlus /> Create {def.defaultRoot}
                </button>
              </div>
            </div>
          </div>
        )}
        {def.archive && !containers.length && files.some((f) => f.path.startsWith(`${def.defaultRoot}/`)) && (
          <div className="view-pad" style={{ paddingBottom: 0 }}>
            <div className="banner banner-warn">
              <Package />
              <span className="grow">
                <code>{def.defaultRoot}/</code> is a plain folder. Packages store this component as a ZIP archive named <code>{def.defaultRoot}</code>.
              </span>
              <div className="actions">
                <button className="btn btn-sm" onClick={() => void A.packFolder(def.defaultRoot)}>
                  Pack as archive
                </button>
              </div>
            </div>
          </div>
        )}
        {visible.length === 0 ? (
          <div className="empty">
            <Icon />
            <h3>{files.length ? 'No files match' : `No ${def.label.toLowerCase()} yet`}</h3>
            <p>{files.length ? 'Change the filter to see more files.' : def.description}</p>
          </div>
        ) : mode === 'grid' ? (
          <div className="asset-grid" style={{ ['--tile' as string]: `${tile}px` }} role="listbox" aria-multiselectable="true" aria-label={def.label}>
            {visible.map((f) => (
              <button
                key={f.path}
                role="option"
                aria-selected={selected.has(f.path)}
                className={`asset-tile ${selected.has(f.path) ? 'is-selected' : ''}`}
                onClick={(e) => onTileClick(e, f)}
                onDoubleClick={() => A.openFile(f.path)}
                onContextMenu={(e) => context(e, f)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') A.openFile(f.path);
                }}
                title={f.path}
              >
                <div className={`asset-thumb ${bg} ${componentId === 'wallpapers' || componentId === 'previews' ? 'cover' : ''}`}>
                  {f.kind === 'image' ? <img src={resourceUrl('main', f.path, f.rev)} alt="" loading="lazy" draggable={false} /> : <span className="ext">{extension(f.path).toUpperCase() || f.kind.toUpperCase()}</span>}
                  <span className="marks">
                    {f.ninePatch && <span className="badge badge-info">9</span>}
                    {f.status !== 'original' && <span className={`badge ${f.status === 'added' ? 'badge-ok' : 'badge-warn'}`}>{f.status === 'added' ? 'A' : 'M'}</span>}
                  </span>
                </div>
                <div className="asset-info">
                  <div className="name">{fileName(f.path)}</div>
                  <div className="meta">{[dimensions(f.width, f.height), f.density, formatBytes(f.size)].filter(Boolean).join(' · ')}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Folder</th>
                <th>Type</th>
                <th>Dimensions</th>
                <th className="num">Size</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((f) => (
                <tr
                  key={f.path}
                  className={`is-clickable ${selected.has(f.path) ? 'is-selected' : ''}`}
                  onClick={(e) => onTileClick(e, f)}
                  onDoubleClick={() => A.openFile(f.path)}
                  onContextMenu={(e) => context(e, f)}
                >
                  <td>{fileName(f.path)}</td>
                  <td className="muted mono">{displayFolder(parentOf(f.path))}</td>
                  <td className="muted">{f.format ?? f.kind}</td>
                  <td className="muted">{dimensions(f.width, f.height) ?? '—'}</td>
                  <td className="num">{formatBytes(f.size)}</td>
                  <td>{f.status !== 'original' && <span className={`badge ${f.status === 'added' ? 'badge-ok' : 'badge-warn'}`}>{f.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
