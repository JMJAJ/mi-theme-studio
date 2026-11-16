// Theme store downloads: the local library plus in-flight progress, kept
// outside the view so downloads continue while the user navigates.
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { api, errorCode, errorMessage } from '../lib/api';
import type { DownloadedTheme, DownloadProgress } from '../lib/types';
import { log, toast } from './store';

export const REGIONS = ['US', 'GB', 'DE', 'FR', 'ES', 'IT', 'RU', 'IN', 'ID', 'MY', 'PH', 'TH', 'VN', 'TR', 'BR', 'MX'] as const;
const REGION_KEY = 'mts.store.region.v1';

function loadRegion(): string {
  try {
    const value = localStorage.getItem(REGION_KEY);
    if (value && (REGIONS as readonly string[]).includes(value)) return value;
  } catch {
    /* ignore */
  }
  return 'US';
}

interface ThemeStoreState {
  region: string;
  downloads: DownloadedTheme[];
  loaded: boolean;
  progress: Record<string, { received: number; total: number }>;
}

export const useThemeStore = create<ThemeStoreState>(() => ({
  region: loadRegion(),
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

export async function downloadTheme(moduleId: string, name: string): Promise<DownloadedTheme | null> {
  if (useThemeStore.getState().progress[moduleId]) return null;
  await ensureListener();
  useThemeStore.setState((s) => ({ progress: { ...s.progress, [moduleId]: { received: 0, total: 0 } } }));
  try {
    const record = await api.storeDownload(moduleId, useThemeStore.getState().region);
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
