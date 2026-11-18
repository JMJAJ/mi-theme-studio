// The lock screen editor's inventory: pieces saved from any theme (drawn live
// from their saved code and pictures) and the built-in working widgets.
import { useEffect, useMemo, useState } from 'react';
import { BatteryCharging, BatteryMedium, CloudSun, Footprints, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { LockBlock } from '../../lib/mamlBlocks';
import { LOCK_BLOCKS } from '../../lib/mamlBlocks';
import { lenientXml } from '../../lib/mamlEdit';
import type { FileInfo } from '../../lib/types';
import { inventoryBytes, refreshInventory, removeFromInventory, renameInventoryItem, useInventory, type InventoryItem } from '../../state/inventory';
import { openContextMenu } from '../common/Menu';
import { buildScene, MamlCanvas } from './MamlPreview';

const BLOCK_ICON: Record<string, typeof Package> = { battery: BatteryMedium, weather: CloudSun, steps: Footprints, charging: BatteryCharging };

function fakeFile(path: string, size: number): FileInfo {
  return { path, size, kind: 'image', component: 'lockscreen', format: null, width: null, height: null, ninePatch: false, density: null, status: 'unchanged' as FileInfo['status'], rev: 0, compression: 'stored' };
}

/** A saved piece drawn from its own code and pictures, cropped to what it covers. */
export function SnippetThumb({ item, width, height }: { item: InventoryItem; width: number; height: number }) {
  const [urls, setUrls] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    inventoryBytes(item.id)
      .then((bytes) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const [path, data] of bytes) {
          const type = /\.webp$/i.test(path) ? 'image/webp' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.mp4$/i.test(path) ? 'video/mp4' : 'image/png';
          const url = URL.createObjectURL(new Blob([data.slice()], { type }));
          made.push(url);
          map.set(path, url);
        }
        setUrls(map);
      })
      .catch(() => !cancelled && setUrls(new Map()));
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [item.id]);

  const scene = useMemo(() => {
    if (!urls) return null;
    const xml = `<Lockscreen version="1" screenWidth="${item.width}">
<VariableBinders>
${item.binders.join('\n')}
</VariableBinders>
<Group x="${item.offset.x}" y="${item.offset.y}">
${[...item.defs, ...item.elements].join('\n')}
</Group>
</Lockscreen>`;
    let doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(lenientXml(xml), 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    const elements = Array.from(doc.getElementsByTagName('*'));
    const files = new Map<string, FileInfo>();
    for (const path of urls.keys()) {
      files.set(path, fakeFile(path, 0));
      files.set(path.toLowerCase(), fakeFile(path, 0));
    }
    try {
      return buildScene(doc, new Map(elements.map((e, i) => [e, i])), { phone: 20 / 9, dir: '', files, now: new Date(), t: null, slot: 'main', url: (f) => urls.get(f.path) ?? urls.get(f.path.toLowerCase()) ?? '' });
    } catch {
      return null;
    }
  }, [urls, item]);

  const box = item.box && item.box.w > 0 && item.box.h > 0 ? item.box : { x: 0, y: 0, w: item.width, h: item.width };
  const k = Math.min(width / box.w, height / box.h);
  return (
    <div className="inv-thumb" style={{ width, height }}>
      {scene ? (
        <div style={{ position: 'absolute', left: (width - box.w * k) / 2 - box.x * k, top: (height - box.h * k) / 2 - box.y * k, width: scene.w * k, height: scene.h * k }}>
          <MamlCanvas scene={scene} scale={k} />
        </div>
      ) : (
        <Package className="faint" />
      )}
    </div>
  );
}

/**
 * The inventory beside the lock screen: click a saved piece or a built-in
 * widget to add it to the page being edited.
 */
export function InventoryPanel({ target, onAdd, onAddBlock, onClose }: { target: string; onAdd: (item: InventoryItem) => void; onAddBlock: (block: LockBlock) => void; onClose: () => void }) {
  const items = useInventory((s) => s.items);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (items === null) void refreshInventory();
  }, [items]);

  const menu = (e: React.MouseEvent, item: InventoryItem) => {
    e.preventDefault();
    openContextMenu(e, [
      { label: `Add to ${target}`, icon: Plus, onSelect: () => onAdd(item) },
      { label: 'Rename', icon: Pencil, onSelect: () => setEditing(item.id) },
      'separator',
      { label: 'Remove from the inventory', icon: Trash2, danger: true, onSelect: () => void removeFromInventory(item.id) },
    ]);
  };

  return (
    <aside className="inv" aria-label="Inventory">
      <div className="inv-head">
        <Package />
        <strong>Inventory</strong>
        <span className="faint ellipsis grow">adds to {target}</span>
        <button className="tb-icon" aria-label="Close the inventory" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="inv-body">
        <div className="inv-section">Saved</div>
        {items === null ? null : items.length === 0 ? (
          <p className="muted inv-empty">Right-click pieces on the lock screen (yours or a theme opened beside it) and pick “Save to inventory”, or use Save to inventory in the sidebar. They keep their code and pictures, so they work in any theme.</p>
        ) : (
          <div className="inv-grid">
            {items.map((item) => (
              <div key={item.id} className="inv-card" onContextMenu={(e) => menu(e, item)}>
                <button className="inv-card-main" onClick={() => onAdd(item)} title={`Add “${item.name}” to ${target}`}>
                  <SnippetThumb item={item} width={132} height={96} />
                </button>
                {editing === item.id ? (
                  <input
                    className="input inv-rename"
                    autoFocus
                    defaultValue={item.name}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim();
                      if (v && v !== item.name) void renameInventoryItem(item.id, v);
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <div className="inv-card-name" onDoubleClick={() => setEditing(item.id)} title={`${item.name}${item.source ? ` · from ${item.source}` : ''} · double-click to rename`}>
                    <span className="ellipsis">{item.name}</span>
                    <button className="tb-icon inv-del" aria-label={`Remove ${item.name}`} title="Remove from the inventory" onClick={() => void removeFromInventory(item.id)}>
                      <Trash2 />
                    </button>
                  </div>
                )}
                <div className="faint inv-card-meta ellipsis">
                  {item.source ? `${item.source} · ` : ''}
                  {item.files.length ? `${item.files.length} picture${item.files.length === 1 ? '' : 's'}` : 'code only'}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="inv-section">Built-in widgets</div>
        <div className="inv-blocks">
          {LOCK_BLOCKS.map((b) => {
            const Icon = BLOCK_ICON[b.id] ?? Package;
            return (
              <button key={b.id} className="inv-block" onClick={() => onAddBlock(b)} title={`Add to ${target}. Built from shapes and text, so you can restyle every part.`}>
                <Icon />
                <span>
                  <strong>{b.label}</strong>
                  <span className="faint">{b.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
