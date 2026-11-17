import { useMemo, useState } from 'react';
import { Archive, Crop, Download, Scissors, Package, Plus, RefreshCw, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { displayFolder, extension, fileName, parentOf } from '../../lib/paths';
import { dimensions, formatBytes, plural } from '../../lib/format';
import type { FileInfo } from '../../lib/types';
import { getState, useStore } from '../../state/store';
import * as A from '../../state/actions';
import { openContextMenu, type MenuItem } from '../common/Menu';
import { componentIcon } from '../common/icons';
import { IconCoverage } from './IconCoverage';
import { MamlPreview } from './MamlPreview';
import { openWallpaperCrop } from './WallpaperCrop';
import { openSoundTrim } from './SoundTrim';

type Sort = 'name' | 'size' | 'status';

export function ComponentView({ componentId, embedded = false }: { componentId: string; embedded?: boolean }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'grid' | 'list'>(componentId === 'fonts' || componentId === 'sounds' ? 'list' : 'grid');
  const [tile, setTile] = useState(componentId === 'icons' ? 104 : 140);
  const [density, setDensity] = useState('all');
  const [sort, setSort] = useState<Sort>('name');
  const [bg, setBg] = useState<'checker' | 'bg-dark' | 'bg-light'>('checker');
  const hasLayout = componentId === 'lockscreen' || componentId === 'widgets';
  const [pane, setPane] = useState<'files' | 'apps' | 'live'>(hasLayout ? 'live' : 'files');

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

  // The wallpaper the Crop button works on: the selected picture, else the first one.
  const cropTarget = files.find((f) => f.kind === 'image' && selection.includes(f.path)) ?? files.find((f) => f.kind === 'image');
  const addFiles = async () => {
    // New parts that live in an archive get it created on the first add, no extra step.
    if (needsArchive) {
      if (!(await A.ensureContainer(def.defaultRoot))) return;
      await A.addFilesDialog(`${def.defaultRoot}!/`);
    } else await A.addFilesDialog(destination);
  };
  const viewMenu = (event: React.MouseEvent) => {
    const on = (yes: boolean, label: string) => (yes ? `✓  ${label}` : `     ${label}`);
    const items: MenuItem[] = [
      { heading: 'Layout' },
      { label: on(mode === 'grid', 'Grid'), onSelect: () => setMode('grid') },
      { label: on(mode === 'list', 'List'), onSelect: () => setMode('list') },
      { heading: 'Sort by' },
      { label: on(sort === 'name', 'Name'), onSelect: () => setSort('name') },
      { label: on(sort === 'size', 'Size'), onSelect: () => setSort('size') },
      { label: on(sort === 'status', 'Changed first'), onSelect: () => setSort('status') },
      { heading: 'Thumbnail background' },
      { label: on(bg === 'checker', 'Checkerboard'), onSelect: () => setBg('checker') },
      { label: on(bg === 'bg-dark', 'Black'), onSelect: () => setBg('bg-dark') },
      { label: on(bg === 'bg-light', 'Light'), onSelect: () => setBg('bg-light') },
    ];
    if (densities.length > 1) {
      items.push({ heading: 'Density' }, { label: on(density === 'all', 'All densities'), onSelect: () => setDensity('all') });
      for (const d of densities) items.push({ label: on(density === d, d), onSelect: () => setDensity(d) });
    }
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu({ clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => event.preventDefault() }, items);
  };

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
      ...(file.kind === 'audio' ? [{ label: 'Trim…', icon: Scissors, disabled: keys.length > 1, onSelect: () => openSoundTrim(file.path) }] : []),
      ...(componentId === 'wallpapers' && file.kind === 'image' ? [{ label: 'Crop & position…', icon: Crop, disabled: keys.length > 1, onSelect: () => openWallpaperCrop(file.path) }] : []),
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
      {componentId === 'icons' && (
        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="Icons view">
            <button role="tab" aria-pressed={pane === 'files'} onClick={() => setPane('files')}>
              Icon files
            </button>
            <button role="tab" aria-pressed={pane === 'apps'} onClick={() => setPane('apps')}>
              Apps on your phone
            </button>
          </div>
        </div>
      )}
      {hasLayout && (
        <div className="toolbar">
          <div className="segmented" role="tablist" aria-label="View">
            <button role="tab" aria-pressed={pane === 'live'} onClick={() => setPane('live')}>
              Preview
            </button>
            <button role="tab" aria-pressed={pane === 'files'} onClick={() => setPane('files')}>
              Files
            </button>
          </div>
        </div>
      )}
      {hasLayout && pane === 'live' ? (
        <MamlPreview componentId={componentId} />
      ) : componentId === 'icons' && pane === 'apps' ? (
        <div className="view">
          {needsArchive ? (
            <div className="view-pad">
              <div className="banner banner-info">
                <Archive />
                <span>Add the Icons part first, then come back to add icons for your apps.</span>
              </div>
            </div>
          ) : (
            <IconCoverage files={files} folder={folders.find((f) => f.endsWith('drawable-xxhdpi')) ?? `${containers[0]?.name ?? 'icons'}!/res/drawable-xxhdpi`} />
          )}
        </div>
      ) : (
      <>
      <div className="toolbar">
        {!embedded && (
          <>
            <Icon width={16} height={16} className="muted" />
            <strong>{def.label}</strong>
            <span className="muted">{plural(files.length, 'file')}</span>
            <span className="sep" />
          </>
        )}
        <div className="search" style={{ width: 200 }}>
          <Search />
          <input className="input" placeholder={`Filter ${def.label.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter" />
        </div>
        <button className="btn btn-sm" onClick={viewMenu} title="Layout, sorting, background and density">
          <SlidersHorizontal /> View{density !== 'all' ? ` · ${density}` : ''}
        </button>
        {mode === 'grid' && (
          <input type="range" min={72} max={240} value={tile} onChange={(e) => setTile(Number(e.target.value))} aria-label="Thumbnail size" title="Thumbnail size" style={{ width: 90, accentColor: 'var(--accent)' }} />
        )}
        <span className="grow" />
        {componentId === 'wallpapers' && cropTarget && (
          <button className="btn btn-sm" onClick={() => openWallpaperCrop(cropTarget.path)} title={`Crop ${fileName(cropTarget.path)} to the phone's screen shape`}>
            <Crop /> Crop &amp; position
          </button>
        )}
        {selection.length > 0 && selection.every((p) => files.some((f) => f.path === p)) && (
          <button className="btn btn-sm btn-danger" onClick={() => void A.deletePaths(selection)}>
            <Trash2 /> Delete {selection.length}
          </button>
        )}
        {new Set([...containers.map((c) => `${c.name}!/`), ...folders]).size > 1 && (
          <select className="select" style={{ maxWidth: 220 }} value={destination} onChange={(e) => setFolder(e.target.value)} aria-label="Destination folder" title="Folder new files are added to">
            {[...new Set([...(containers.map((c) => `${c.name}!/`)), ...folders, ...(def.defaultRoot ? [def.defaultRoot] : [])])].map((f) => (
              <option key={f} value={f}>
                Add to: {displayFolder(f)}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => void addFiles()}>
          <Plus /> Add files
        </button>
      </div>

      <div className="view" data-drop-folder={needsArchive ? undefined : destination}>
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
      </>
      )}
    </div>
  );
}
