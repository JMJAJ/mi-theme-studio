// A tick-box file tree for choosing what goes into the proof of copyright: folders keep
// their structure, a folder's box ticks everything inside it, and any file can be unticked.
import { useMemo, useState } from 'react';
import { ChevronRight, File, Folder, X } from 'lucide-react';
import { formatBytes } from '../../lib/format';

export interface PickEntry {
  /** Identifies the file (what is sent back through onToggle). */
  key: string;
  /** Where it sits: `Folder/sub/file.psd`; nested package paths use `/` as well. */
  rel: string;
  size: number;
  /** The picked item the file belongs to; its top node gets a remove button. */
  root?: string;
}

interface Node {
  path: string;
  name: string;
  folder: boolean;
  root?: string;
  keys: string[];
  size: number;
  children: Node[];
}

function build(entries: PickEntry[]): Node[] {
  const top: Node[] = [];
  const index = new Map<string, Node>();
  for (const entry of entries) {
    const parts = entry.rel.replace(/!\//g, '/').split('/').filter(Boolean);
    let siblings = top;
    let prefix = '';
    const trail: Node[] = [];
    parts.forEach((part, i) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const isFile = i === parts.length - 1;
      const id = isFile ? `${prefix}\u0000${entry.key}` : prefix;
      let node = index.get(id);
      if (!node) {
        node = { path: id, name: part, folder: !isFile, root: i === 0 ? entry.root : undefined, keys: [], size: 0, children: [] };
        index.set(id, node);
        siblings.push(node);
      }
      trail.push(node);
      siblings = node.children;
    });
    for (const node of trail) {
      node.keys.push(entry.key);
      node.size += entry.size;
    }
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    nodes.forEach((n) => sort(n.children));
  };
  sort(top);
  return top;
}

function Box({ state, onChange, label }: { state: 'all' | 'some' | 'none'; onChange: (include: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={state === 'all'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some';
      }}
      onChange={() => onChange(state !== 'all')}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function ProofTree({
  entries,
  excluded,
  onToggle,
  onRemove,
  empty,
}: {
  entries: PickEntry[];
  excluded: string[];
  onToggle: (keys: string[], include: boolean) => void;
  /** Called with a picked item's root when its top node's remove button is used. */
  onRemove?: (root: string) => void;
  empty?: string;
}) {
  const nodes = useMemo(() => build(entries), [entries]);
  const out = useMemo(() => new Set(excluded), [excluded]);
  // Top-level folders start open; the rest start closed until the user opens them.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!nodes.length) return empty ? <div className="field-hint">{empty}</div> : null;

  const rows = (list: Node[], depth: number): React.ReactNode =>
    list.map((node) => {
      const ticked = node.keys.filter((k) => !out.has(k)).length;
      const state = ticked === 0 ? 'none' : ticked === node.keys.length ? 'all' : 'some';
      const isOpen = node.folder && (open[node.path] ?? depth === 0);
      return (
        <div key={node.path}>
          <div
            className={`pick-row ${state === 'none' ? 'is-off' : ''}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            onClick={() => node.folder && setOpen((o) => ({ ...o, [node.path]: !isOpen }))}
          >
            <span className={`tree-twisty ${isOpen ? 'is-open' : ''}`}>{node.folder && <ChevronRight />}</span>
            <Box state={state} label={`Include ${node.name}`} onChange={(include) => onToggle(node.keys, include)} />
            {node.folder ? <Folder className="tree-icon folder" /> : <File className="tree-icon" />}
            <span className="tree-name" title={node.name}>{node.name}</span>
            <span className="tree-meta">
              {node.folder ? `${ticked}/${node.keys.length} · ` : ''}
              {formatBytes(node.size)}
            </span>
            {onRemove && node.root && (
              <button
                className="btn btn-sm btn-icon"
                aria-label={`Remove ${node.name}`}
                title="Remove from the list"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(node.root!);
                }}
              >
                <X />
              </button>
            )}
          </div>
          {isOpen && rows(node.children, depth + 1)}
        </div>
      );
    });

  const all = entries.map((e) => e.key);
  const tickedAll = all.filter((k) => !out.has(k)).length;
  return (
    <div className="pick-tree">
      <div className="pick-head">
        <span className="muted">{tickedAll} of {all.length} ticked</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={() => onToggle(all, true)} disabled={tickedAll === all.length}>All</button>
        <button className="btn btn-sm" onClick={() => onToggle(all, false)} disabled={tickedAll === 0}>None</button>
      </div>
      <div className="pick-body">{rows(nodes, 0)}</div>
    </div>
  );
}
