import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderInput,
  FolderPlus,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { buildTree, filterTree, flattenTree, type FlatRow, type TreeNode } from '../../lib/tree';
import { fileName, parentOf } from '../../lib/paths';
import { formatBytes } from '../../lib/format';
import type { FileInfo, ProjectSnapshot, Slot } from '../../lib/types';
import { getState, setState, useStore } from '../../state/store';
import * as A from '../../state/actions';
import { openContextMenu, type MenuItem } from '../common/Menu';
import { SearchPanel } from './SearchPanel';
import { kindIcon } from '../common/icons';

const ROW = 28;
type Filter = 'images' | 'xml' | 'changed' | 'problems';

function dropFolderOf(node: TreeNode): string {
  return node.type === 'file' ? parentOf(node.key) : node.folder;
}

interface TreeViewProps {
  slot: Slot;
  rows: FlatRow[];
  selection: string[];
  onSelect: (key: string, mode: 'single' | 'toggle' | 'range', ordered: string[]) => void;
  onToggle: (key: string, open?: boolean) => void;
  onOpen: (node: TreeNode) => void;
  onContext: (event: React.MouseEvent, node: TreeNode | null) => void;
  onMove?: (paths: string[], folder: string) => void;
  onKey?: (event: React.KeyboardEvent, focused: TreeNode | null) => boolean;
  emptyText: string;
}

function TreeView({ slot, rows, selection, onSelect, onToggle, onOpen, onContext, onMove, onKey, emptyText }: TreeViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [focus, setFocus] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const drag = useRef<{ keys: string[]; x: number; y: number; active: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; count: number } | null>(null);
  const suppressClick = useRef(false);
  const ordered = useMemo(() => rows.map((r) => r.node.key), [rows]);
  const selected = useMemo(() => new Set(selection), [selection]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Keep the focused row in sync with external selection (e.g. reveal).
  useEffect(() => {
    if (!selection.length) return;
    const index = ordered.indexOf(selection[selection.length - 1]);
    if (index !== -1) {
      setFocus(index);
      const el = ref.current;
      if (el && (index * ROW < el.scrollTop || index * ROW > el.scrollTop + el.clientHeight - ROW)) {
        el.scrollTop = Math.max(0, index * ROW - el.clientHeight / 2);
      }
    }
  }, [selection, ordered]);

  const start = Math.max(0, Math.floor(scroll / ROW) - 8);
  const end = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 8);

  const focusRow = (index: number, mode: 'single' | 'range' = 'single') => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setFocus(clamped);
    const key = rows[clamped]?.node.key;
    if (key) onSelect(key, mode, ordered);
    const el = ref.current;
    if (el) {
      if (clamped * ROW < el.scrollTop) el.scrollTop = clamped * ROW;
      else if ((clamped + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (clamped + 1) * ROW - el.clientHeight;
    }
  };

  useEffect(() => {
    if (!onMove) return;
    const onPointerMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      if (!state.active && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6) return;
      state.active = true;
      setGhost({ x: event.clientX, y: event.clientY, count: state.keys.length });
      const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop-folder]');
      setDropTarget(target ? (target.dataset.dropFolder ?? '') : null);
    };
    const onPointerUp = () => {
      const state = drag.current;
      drag.current = null;
      if (state?.active) {
        suppressClick.current = true;
        setGhost(null);
        setDropTarget((target) => {
          if (target !== null) {
            const keys = state.keys.filter((k) => parentOf(k) !== target && k !== target && !target.startsWith(`${k}/`) && !target.startsWith(`${k}!/`));
            if (keys.length) onMove(keys, target);
          }
          return null;
        });
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onMove]);

  return (
    <div
      ref={ref}
      className="tree"
      role="tree"
      aria-multiselectable="true"
      aria-label={slot === 'main' ? 'Package files' : 'Reference package files'}
      tabIndex={0}
      data-drop-folder={slot === 'main' ? '' : undefined}
      onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) onContext(event, null);
      }}
      onKeyDown={(event) => {
        const row = rows[focus];
        if (onKey?.(event, row?.node ?? null)) return;
        if (event.key === 'ArrowDown') focusRow(focus + 1, event.shiftKey ? 'range' : 'single');
        else if (event.key === 'ArrowUp') focusRow(focus - 1, event.shiftKey ? 'range' : 'single');
        else if (event.key === 'Home') focusRow(0);
        else if (event.key === 'End') focusRow(rows.length - 1);
        else if (event.key === 'ArrowRight' && row) {
          if (row.node.type !== 'file' && !row.expanded) onToggle(row.node.key, true);
          else if (row.expanded) focusRow(focus + 1);
        } else if (event.key === 'ArrowLeft' && row) {
          if (row.expanded) onToggle(row.node.key, false);
          else {
            const parentIndex = rows.slice(0, focus).map((r) => r.depth).lastIndexOf(row.depth - 1);
            if (parentIndex !== -1) focusRow(parentIndex);
          }
        } else if (event.key === 'Enter' && row) {
          if (row.node.type === 'file') onOpen(row.node);
          else onToggle(row.node.key);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          setState(slot === 'main' ? { selection: ordered } : { refSelection: ordered });
        } else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {rows.length === 0 && <div className="tree-empty">{emptyText}</div>}
      <div style={{ height: rows.length * ROW, position: 'relative' }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const node = row.node;
          const isSelected = selected.has(node.key);
          const Icon = node.type === 'container' ? Archive : node.type === 'folder' ? Folder : kindIcon(node.file!.kind);
          const thumb = node.file?.kind === 'image' && node.file.size < 4 * 1024 * 1024;
          const dropKey = node.type === 'file' ? undefined : node.folder;
          return (
            <div
              key={node.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={node.type === 'file' ? undefined : row.expanded}
              className={`tree-row ${isSelected ? 'is-selected' : ''} ${index === focus ? 'is-focused' : ''} ${dropKey !== undefined && dropTarget === dropKey ? 'is-drop' : ''}`}
              style={{ top: index * ROW, ['--depth' as string]: row.depth }}
              data-drop-folder={slot === 'main' ? dropFolderOf(node) : undefined}
              title={node.type === 'container' ? `${node.key} — component archive (${node.fileCount} files)` : node.key}
              onPointerDown={(event) => {
                if (event.button !== 0 || slot !== 'main' || !onMove) return;
                const keys = isSelected ? selection : [node.key];
                drag.current = { keys, x: event.clientX, y: event.clientY, active: false };
              }}
              onClick={(event) => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setFocus(index);
                const mode = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single';
                onSelect(node.key, mode, ordered);
                if (mode === 'single' && node.type !== 'file' && (event.target as HTMLElement).closest('.tree-twisty')) onToggle(node.key);
              }}
              onDoubleClick={() => (node.type === 'file' ? onOpen(node) : onToggle(node.key))}
              onContextMenu={(event) => {
                if (!isSelected) onSelect(node.key, 'single', ordered);
                setFocus(index);
                onContext(event, node);
              }}
            >
              <span className={`tree-twisty ${row.expanded ? 'is-open' : ''}`}>{node.type !== 'file' && <ChevronRight />}</span>
              {thumb ? (
                <img className="tree-thumb checker" src={resourceUrl(slot, node.key, node.file!.rev)} alt="" loading="lazy" draggable={false} />
              ) : (
                <Icon className={`tree-icon ${node.type === 'container' ? 'archive' : node.type === 'folder' ? 'folder' : ''}`} />
              )}
              <span className="tree-name">{node.name}</span>
              {slot === 'main' && node.changed && (
                <span className={`status-mark ${node.file?.status === 'added' || node.container?.status === 'added' ? 'added' : 'modified'}`} title={node.file ? node.file.status : 'contains changes'}>
                  {node.file?.status === 'added' || node.container?.status === 'added' ? 'A' : node.type === 'file' ? 'M' : '•'}
                </span>
              )}
              <span className="tree-meta">{node.type === 'file' ? formatBytes(node.bytes) : node.fileCount}</span>
            </div>
          );
        })}
      </div>
      {ghost && (
        <div className="badge badge-accent" style={{ position: 'fixed', left: ghost.x + 14, top: ghost.y + 10, zIndex: 100, pointerEvents: 'none' }}>
          Move {ghost.count} {ghost.count === 1 ? 'item' : 'items'}
          {dropTarget !== null ? ` → ${dropTarget || 'root'}` : ''}
        </div>
      )}
    </div>
  );
}

function useFilteredRows(snapshot: ProjectSnapshot | null, expanded: Set<string>, query: string, filters: Set<Filter>, problemPaths: Set<string>) {
  const tree = useMemo(() => (snapshot ? buildTree(snapshot.files, snapshot.containers) : []), [snapshot]);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = q || filters.size;
    if (!active) return flattenTree(tree, expanded);
    const predicate = (file: FileInfo) => {
      if (q && !file.path.toLowerCase().includes(q)) return false;
      if (filters.has('images') && file.kind !== 'image') return false;
      if (filters.has('xml') && file.kind !== 'xml') return false;
      if (filters.has('changed') && file.status === 'original') return false;
      if (filters.has('problems') && !problemPaths.has(file.path)) return false;
      return true;
    };
    return flattenTree(filterTree(tree, predicate), expanded, true);
  }, [tree, expanded, query, filters, problemPaths]);
}

function FilesPanel() {
  const project = useStore((s) => s.project)!;
  const expanded = useStore((s) => s.expanded);
  const selection = useStore((s) => s.selection);
  const validation = useStore((s) => s.validation);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const problemPaths = useMemo(() => new Set((validation?.issues ?? []).map((i) => i.path).filter(Boolean) as string[]), [validation]);
  const rows = useFilteredRows(project, expanded, query, filters, problemPaths);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener('mts:focus-explorer-search', focusSearch);
    return () => window.removeEventListener('mts:focus-explorer-search', focusSearch);
  }, []);

  const toggleFilter = (filter: Filter) =>
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });

  const contextMenu = (event: React.MouseEvent, node: TreeNode | null) => {
    const state = getState();
    const keys = node ? (state.selection.includes(node.key) ? state.selection : [node.key]) : [];
    const folder = node ? dropFolderOf(node) : '';
    const items: MenuItem[] = [];
    if (node?.type === 'file') {
      items.push({ label: 'Open', icon: ExternalLink, onSelect: () => A.openFile(node.key) });
      items.push({ label: 'Replace…', icon: RefreshCw, disabled: keys.length > 1, onSelect: () => A.replaceFile(node.key) });
      items.push({
        label: keys.length > 1 ? `Export ${keys.length} selected items…` : 'Export file…',
        icon: Download,
        onSelect: () => (keys.length > 1 ? A.exportPaths(keys) : A.extractFile(node.key)),
      });
      items.push('separator');
    }
    if (node && node.type !== 'file') {
      items.push({
        label: keys.length > 1 ? `Export ${keys.length} selected items…` : `Export folder “${node.name}”…`,
        icon: Download,
        onSelect: () => A.exportPaths(keys),
      });
    }
    items.push({ label: `Add files to ${folder ? fileName(folder.replace(/!\/$/, '')) : 'root'}…`, icon: Plus, onSelect: () => A.addFilesDialog(folder) });
    if (!node) {
      items.push({ label: 'Export entire package…', icon: Download, onSelect: () => A.exportPaths([]) });
      items.push({ label: 'New component archive…', icon: FolderPlus, onSelect: () => A.createContainer() });
    }
    if (node?.type === 'folder' && !node.key.includes('/') && !node.key.includes('!/')) {
      items.push({ label: `Pack “${node.key}” as component archive`, icon: Package, onSelect: () => A.packFolder(node.key) });
    }
    if (node) {
      items.push('separator');
      items.push({ label: 'Rename…', icon: Pencil, shortcut: 'F2', disabled: keys.length !== 1, onSelect: () => A.renamePath(node.key) });
      items.push({ label: 'Duplicate', icon: Copy, shortcut: 'Ctrl+D', disabled: !keys.some((k) => state.fileIndex.has(k)), onSelect: () => A.duplicatePaths(keys) });
      items.push({ label: 'Move to folder…', icon: FolderInput, onSelect: () => setState({ dialog: { type: 'move', paths: keys } }) });
      items.push({ label: 'Copy path', icon: ClipboardCopy, onSelect: () => void navigator.clipboard?.writeText(keys.join('\n')) });
      items.push('separator');
      items.push({ label: keys.length > 1 ? `Delete ${keys.length} items` : 'Delete', icon: Trash2, shortcut: 'Delete', danger: true, onSelect: () => A.deletePaths(keys) });
    }
    openContextMenu(event, items);
  };

  return (
    <>
      <div className="panel-tools">
        <div className="search">
          <Search />
          <input
            ref={searchRef}
            className="input"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            aria-label="Filter files"
          />
          {query && (
            <button className="btn btn-ghost btn-icon btn-sm clear" onClick={() => setQuery('')} aria-label="Clear filter">
              <X />
            </button>
          )}
        </div>
        <div className="chips" role="group" aria-label="File filters">
          {(
            [
              ['images', 'Images'],
              ['xml', 'XML'],
              ['changed', 'Changed'],
              ['problems', `Problems${problemPaths.size ? ` ${problemPaths.size}` : ''}`],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button key={id} className="chip" aria-pressed={filters.has(id)} onClick={() => toggleFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <TreeView
        slot="main"
        rows={rows}
        selection={selection}
        onSelect={(key, mode, ordered) => A.select(key, mode, ordered)}
        onToggle={(key, open) => A.toggleExpanded(key, 'main', open)}
        onOpen={(node) => A.openFile(node.key)}
        onContext={contextMenu}
        onMove={(paths, folder) => void A.movePaths(paths, folder)}
        onKey={(event, node) => {
          if (event.key === 'F2' && node) void A.renamePath(getState().selection[0] ?? node.key);
          else if (event.key === 'Delete' && getState().selection.length) void A.deletePaths(getState().selection);
          else return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        }}
        emptyText={query || filters.size ? 'No files match the filter.' : 'This package is empty. Drop files here or use Add files.'}
      />
    </>
  );
}

function ReferencePanel() {
  const reference = useStore((s) => s.reference);
  const expanded = useStore((s) => s.refExpanded);
  const selection = useStore((s) => s.refSelection);
  const [query, setQuery] = useState('');
  const rows = useFilteredRows(reference, expanded, query, useMemo(() => new Set<Filter>(), []), useMemo(() => new Set<string>(), []));

  if (!reference) {
    return (
      <div className="empty">
        <BookOpen />
        <h3>No reference package</h3>
        <p>Open another .mtz read-only to browse it side by side and copy icons, wallpapers or XML into your theme. The reference is never modified.</p>
        <button className="btn" onClick={() => void A.openReference()}>
          <BookOpen /> Open reference…
        </button>
      </div>
    );
  }

  const selectRef = (key: string, mode: 'single' | 'toggle' | 'range', ordered: string[]) => {
    setState((s) => {
      if (mode === 'toggle') return { refSelection: s.refSelection.includes(key) ? s.refSelection.filter((k) => k !== key) : [...s.refSelection, key] };
      if (mode === 'range' && s.refSelection.length) {
        const a = ordered.indexOf(s.refSelection[0]);
        const b = ordered.indexOf(key);
        return { refSelection: ordered.slice(Math.min(a, b), Math.max(a, b) + 1) };
      }
      return { refSelection: [key] };
    });
  };

  return (
    <>
      <div className="panel-tools">
        <div className="row">
          <BookOpen width={14} height={14} className="muted" />
          <span className="ellipsis grow" title={reference.sourcePath ?? reference.name}>
            <strong>{reference.title}</strong> <span className="faint">read-only</span>
          </span>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => void A.closeReference()} aria-label="Close reference" title="Close reference">
            <X />
          </button>
        </div>
        <div className="search">
          <Search />
          <input className="input" placeholder="Filter reference files" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter reference files" />
        </div>
        <button className="btn btn-sm" disabled={!selection.length} onClick={() => setState({ dialog: { type: 'copyPlan', paths: selection } })}>
          <Copy /> Copy {selection.length || ''} to project…
        </button>
        <button className="btn btn-sm" onClick={() => void A.exportPaths(selection, 'ref')}>
          <Download /> {selection.length ? `Export ${selection.length} selected…` : 'Export all files…'}
        </button>
      </div>
      <TreeView
        slot="ref"
        rows={rows}
        selection={selection}
        onSelect={selectRef}
        onToggle={(key, open) => A.toggleExpanded(key, 'ref', open)}
        onOpen={(node) => A.openFile(node.key, 'ref')}
        onContext={(event, node) => {
          if (!node) return;
          const keys = getState().refSelection.includes(node.key) ? getState().refSelection : [node.key];
          openContextMenu(event, [
            ...(node.type === 'file' ? [{ label: 'Open (read-only)', icon: ExternalLink, onSelect: () => A.openFile(node.key, 'ref') }] : []),
            { label: `Copy ${keys.length > 1 ? `${keys.length} items` : 'to project'}…`, icon: Copy, onSelect: () => setState({ dialog: { type: 'copyPlan', paths: keys } }) },
            {
              label: keys.length > 1 ? `Export ${keys.length} selected items…` : node.type === 'file' ? 'Export file…' : `Export folder “${node.name}”…`,
              icon: Download,
              onSelect: () => (keys.length === 1 && node.type === 'file' ? A.extractFile(node.key, 'ref') : A.exportPaths(keys, 'ref')),
            },
          ]);
        }}
        emptyText="No files match."
      />
    </>
  );
}

export function Explorer() {
  const project = useStore((s) => s.project);
  const sideTab = useStore((s) => s.sideTab);
  const selection = useStore((s) => s.selection);
  const reference = useStore((s) => s.reference);

  return (
    <section className="panel" aria-label="Explorer">
      <div className="panel-header">
        <div className="panel-tabs" role="tablist">
          <button role="tab" aria-selected={sideTab === 'files'} onClick={() => setState({ sideTab: 'files' })}>
            Explorer
          </button>
          <button role="tab" aria-selected={sideTab === 'search'} onClick={() => setState({ sideTab: 'search' })} disabled={!project}>
            Search
          </button>
          <button role="tab" aria-selected={sideTab === 'reference'} onClick={() => setState({ sideTab: 'reference' })} disabled={!project}>
            Reference{reference ? ' •' : ''}
          </button>
        </div>
        <span className="grow" />
        {project && sideTab === 'files' && (
          <>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={selection.length ? `Export ${selection.length} selected file or folder${selection.length === 1 ? '' : 's'}` : 'Export entire package'}
              aria-label={selection.length ? `Export ${selection.length} selected items` : 'Export entire package'}
              onClick={() => void A.exportPaths(selection)}
            >
              <Download />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="Add files" aria-label="Add files" onClick={() => void A.addFilesDialog('')}>
              <Plus />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="New component archive" aria-label="New component archive" onClick={() => void A.createContainer()}>
              <FolderPlus />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" title="Collapse all" aria-label="Collapse all" onClick={() => setState({ expanded: new Set() })}>
              <ChevronRight style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </>
        )}
      </div>
      {!project ? (
        <div className="tree-empty">Open or create a theme package to browse its files.</div>
      ) : sideTab === 'files' ? (
        <FilesPanel />
      ) : sideTab === 'search' ? (
        <SearchPanel />
      ) : (
        <ReferencePanel />
      )}
    </section>
  );
}
