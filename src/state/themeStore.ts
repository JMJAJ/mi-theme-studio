// Theme store downloads: the local library plus in-flight progress, kept
// outside the view so downloads continue while the user navigates.
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { api, errorCode, errorMessage } from '../lib/api';
import type { DownloadedTheme, DownloadProgress, StoreProduct } from '../lib/types';
import { log, toast } from './store';

// Keep in sync with REGIONS in src-tauri/src/store/mod.rs.
export const REGIONS = [
  'US', 'GB', 'DE', 'FR', 'ES', 'IT', 'RU', 'IN', 'ID', 'MY', 'PH', 'TH', 'VN', 'TR',
  'BR', 'MX', 'CA', 'AU', 'NZ', 'JP', 'KR', 'SG', 'TW', 'HK', 'NL', 'BE', 'AT', 'CH',
  'PT', 'GR', 'IE', 'SE', 'PL', 'RO', 'HU', 'SA', 'QA', 'KW', 'OM', 'EG', 'MA', 'DZ',
  'IQ', 'NG', 'KE', 'ZA', 'AR', 'CL', 'CO', 'PE', 'EC', 'PA', 'SV', 'PR',
  // Free-only regions: the store hides paid themes here.
  'AE', 'PK', 'BD', 'UA', 'IL', 'KZ', 'BY', 'CZ', 'NP', 'LK', 'MM', 'KH', 'LA', 'CN',
] as const;
const FREE_ONLY_REGIONS = new Set(['AE', 'PK', 'BD', 'UA', 'IL', 'KZ', 'BY', 'CZ', 'NP', 'LK', 'MM', 'KH', 'LA', 'CN']);
/** Regions whose catalog differs in a way worth naming in the picker. */
export const REGION_NOTES: Partial<Record<string, string>> = {
  IN: 'largest catalog',
  US: 'full catalog, USD',
  RU: 'mostly paid',
  ...Object.fromEntries([...FREE_ONLY_REGIONS].map((r) => [r, 'free only'])),
};
export const DEFAULT_REGION = 'IN';
const REGION_KEY = 'mts.store.region.v1';
const FREE_ONLY_KEY = 'mts.store.freeOnly.v1';

function loadFreeOnly(): boolean {
  try {
    return localStorage.getItem(FREE_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFreeOnly(freeOnly: boolean) {
  useThemeStore.setState({ freeOnly });
  try {
    localStorage.setItem(FREE_ONLY_KEY, freeOnly ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Price in the store's currency, e.g. `₹41.00`. */
export function formatPrice(cents: number, currency: string | null): string {
  const amount = cents / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency}`;
    }
  }
  return amount.toFixed(2);
}

function loadRegion(): string {
  try {
    const value = localStorage.getItem(REGION_KEY);
    if (value && (REGIONS as readonly string[]).includes(value)) return value;
  } catch {
    /* ignore */
  }
  return DEFAULT_REGION;
}

interface ThemeStoreState {
  region: string;
  freeOnly: boolean;
  downloads: DownloadedTheme[];
  loaded: boolean;
  progress: Record<string, { received: number; total: number }>;
}

export const useThemeStore = create<ThemeStoreState>(() => ({
  region: loadRegion(),
  freeOnly: loadFreeOnly(),
  downloads: [],
  loaded: false,
  progress: {},
}));

export function setRegion(region: string) {
  useThemeStore.setState({ region });
  try {
    localStorage.setItem(REGION_KEY, region);
  } catch {
    /* ignore */
  }
}

let listening = false;
async function ensureListener() {
  if (listening) return;
  listening = true;
  try {
    await listen<DownloadProgress>('store-download', ({ payload }) => {
      useThemeStore.setState((s) =>
        s.progress[payload.moduleId] ? { progress: { ...s.progress, [payload.moduleId]: { received: payload.received, total: payload.total } } } : s,
      );
    });
  } catch {
    listening = false;
  }
}

export async function refreshDownloads() {
  try {
    const downloads = await api.storeDownloads();
    useThemeStore.setState({ downloads, loaded: true });
  } catch (e) {
    useThemeStore.setState({ loaded: true });
    log('error', `Could not list downloaded themes: ${errorMessage(e)}`);
  }
}

export function downloadFor(moduleId: string): DownloadedTheme | undefined {
  return useThemeStore.getState().downloads.find((d) => d.moduleId === moduleId);
}

/**
 * Items seen in a part listing (lock screens, status bars…), by module ID. Their
 * IDs often have no store page; the download falls back to what the listing said,
 * and "use" starts on that part.
 */
export const partListings = new Map<string, StoreProduct>();
export function rememberPartListing(product: StoreProduct, alsoAs?: string) {
  // Icon packs too: many of their IDs have no store page either.
  if (!product.part && product.kind !== 'icon') return;
  partListings.set(product.moduleId, product);
  if (alsoAs) partListings.set(alsoAs, product);
}

export async function downloadTheme(moduleId: string, name: string): Promise<DownloadedTheme | null> {
  if (useThemeStore.getState().progress[moduleId]) return null;
  await ensureListener();
  useThemeStore.setState((s) => ({ progress: { ...s.progress, [moduleId]: { received: 0, total: 0 } } }));
  try {
    const listed = partListings.get(moduleId);
    const listing = listed ? { part: listed.part ?? null, kind: listed.kind, name: listed.name, cover: listed.imageUrl } : undefined;
    const record = await api.storeDownload(moduleId, useThemeStore.getState().region, listing);
    if (listed && record.moduleId !== moduleId) partListings.set(record.moduleId, listed);
    useThemeStore.setState((s) => ({ downloads: [record, ...s.downloads.filter((d) => d.moduleId !== record.moduleId)] }));
    log('success', `Downloaded “${record.name}” (SHA-1 ${record.sha1.slice(0, 12)}…) to ${record.path}`);
    toast('success', `Downloaded “${record.name}”`);
    return record;
  } catch (e) {
    if (errorCode(e) === 'cancelled') toast('info', `Download of “${name}” cancelled`);
    else toast('error', `Download “${name}”: ${errorMessage(e)}`);
    return null;
  } finally {
    useThemeStore.setState((s) => {
      const progress = { ...s.progress };
      delete progress[moduleId];
      return { progress };
    });
  }
}

export function cancelDownload(moduleId: string) {
  void api.storeCancel(moduleId);
}

export async function removeDownload(theme: DownloadedTheme) {
  try {
    await api.storeRemoveDownload(theme.moduleId);
    useThemeStore.setState((s) => ({ downloads: s.downloads.filter((d) => d.moduleId !== theme.moduleId) }));
    toast('success', `Removed “${theme.name}” from downloads`);
  } catch (e) {
    toast('error', `Remove download: ${errorMessage(e)}`);
  }
}
