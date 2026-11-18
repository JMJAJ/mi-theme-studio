// The inventory (lock screen pieces saved from any theme, kept by the app) and
// the in-app clipboard for copying pieces between themes.
import { create } from 'zustand';
import { api, errorMessage, resourceUrl } from '../lib/api';
import type { Snippet } from '../lib/mamlCopy';
import type { FileInfo, Slot } from '../lib/types';
import { toast } from './store';

export interface InventoryItem extends Snippet {
  id: string;
  createdMs: number;
}

/** Reads a snippet's files (paths relative to its manifest folder). */
export type ByteReader = (rel: string) => Promise<Uint8Array>;

export interface Clip {
  snippet: Snippet;
  read: ByteReader;
  sizes: Map<string, number>;
}

interface InventoryState {
  items: InventoryItem[] | null;
  clip: Clip | null;
}

export const useInventory = create<InventoryState>(() => ({ items: null, clip: null }));

const bytesCache = new Map<string, Promise<Map<string, Uint8Array>>>();

export async function refreshInventory() {
  try {
    const list = ((await api.inventoryList()) ?? []) as InventoryItem[];
    useInventory.setState({ items: list.filter((i) => i && i.id && Array.isArray(i.elements)).sort((a, b) => b.createdMs - a.createdMs) });
  } catch (e) {
    useInventory.setState({ items: [] });
    toast('error', 'Could not read the inventory', errorMessage(e));
  }
}

/** Read files of a theme slot by their path relative to `dir`. */
export function slotReader(files: FileInfo[], slot: Slot, dir: string): { read: ByteReader; sizes: Map<string, number>; rels: string[] } {
  const inDir = files.filter((f) => f.path.startsWith(dir));
  const byRel = new Map(inDir.map((f) => [f.path.slice(dir.length), f]));
  return {
    rels: [...byRel.keys()],
    sizes: new Map([...byRel].map(([r, f]) => [r, f.size])),
    read: async (rel) => {
      const f = byRel.get(rel);
      if (!f) throw new Error(`Missing ${rel}`);
      const r = await fetch(resourceUrl(slot, f.path, f.rev));
      if (!r.ok) throw new Error(`Could not read ${rel}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

export async function saveToInventory(snippet: Snippet, read: ByteReader) {
  try {
    const files = await Promise.all(snippet.files.map(async (path) => ({ path, data: Array.from(await read(path)) })));
    const saved = (await api.inventorySave({ ...snippet, files: undefined }, files)) as InventoryItem;
    useInventory.setState((s) => ({ items: [saved, ...(s.items ?? []).filter((i) => i.id !== saved.id)] }));
    toast('success', `“${saved.name}” saved to the inventory`, snippet.files.length ? `With ${snippet.files.length} picture${snippet.files.length === 1 ? '' : 's'}.` : undefined);
    return saved;
  } catch (e) {
    toast('error', 'Could not save to the inventory', errorMessage(e));
    return null;
  }
}

export async function removeFromInventory(id: string) {
  try {
    await api.inventoryDelete(id);
    bytesCache.delete(id);
    useInventory.setState((s) => ({ items: (s.items ?? []).filter((i) => i.id !== id) }));
  } catch (e) {
    toast('error', 'Could not remove it', errorMessage(e));
  }
}

export async function renameInventoryItem(id: string, name: string) {
  try {
    const item = (await api.inventoryUpdate(id, { name })) as InventoryItem;
    useInventory.setState((s) => ({ items: (s.items ?? []).map((i) => (i.id === id ? { ...i, ...item, files: i.files } : i)) }));
  } catch (e) {
    toast('error', 'Could not rename it', errorMessage(e));
  }
}

/** An inventory item's pictures, loaded once. */
export function inventoryBytes(id: string) {
  let p = bytesCache.get(id);
  if (!p) {
    p = api.inventoryFiles(id).then((files) => new Map((files ?? []).map((f) => [f.path, new Uint8Array(f.data)])));
    p.catch(() => bytesCache.delete(id));
    bytesCache.set(id, p);
  }
  return p;
}

export function itemReader(item: InventoryItem): { read: ByteReader; sizes: Promise<Map<string, number>> } {
  return {
    read: async (rel) => {
      const data = (await inventoryBytes(item.id)).get(rel);
      if (!data) throw new Error(`Missing ${rel}`);
      return data;
    },
    sizes: inventoryBytes(item.id).then((m) => new Map([...m].map(([k, v]) => [k, v.length]))),
  };
}
