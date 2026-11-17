// Store items the user marked to come back to. Kept on this computer only
// (localStorage); nothing is sent to the store.
import { create } from 'zustand';
import type { StoreProduct } from '../lib/types';

const KEY = 'mts.store.saved.v1';

function read(): StoreProduct[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p.moduleId === 'string') : [];
  } catch {
    return [];
  }
}

export const useSaved = create<{ items: StoreProduct[] }>(() => ({ items: read() }));

export function toggleSaved(product: StoreProduct) {
  useSaved.setState((s) => {
    const has = s.items.some((p) => p.moduleId === product.moduleId);
    const items = has ? s.items.filter((p) => p.moduleId !== product.moduleId) : [product, ...s.items];
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch {
      // Storage unavailable: the list still works for this session.
    }
    return { items };
  });
}
