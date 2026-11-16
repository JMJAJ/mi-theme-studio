// Interface zoom: scales the whole webview, persisted per machine.
import { create } from 'zustand';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
const ZOOM_KEY = 'mts.zoom.v1';

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

/** Next preset level in the given direction from `current`. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((l) => l > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((l) => l < current - 0.001) ?? MIN_ZOOM;
}

function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (raw) return clampZoom(Number(raw));
  } catch {
    /* ignore */
  }
  return 1;
}

export const useZoom = create<{ zoom: number }>(() => ({ zoom: loadZoom() }));

function apply(zoom: number) {
  try {
    getCurrentWebview()
      .setZoom(zoom)
      .catch(() => {
        document.documentElement.style.zoom = String(zoom);
      });
  } catch {
    // Not running inside Tauri (tests, plain browser dev).
    document.documentElement.style.zoom = String(zoom);
  }
}

export function setZoom(value: number) {
  const zoom = clampZoom(value);
  useZoom.setState({ zoom });
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    /* ignore */
  }
  apply(zoom);
}

export const zoomIn = () => setZoom(stepZoom(useZoom.getState().zoom, 1));
export const zoomOut = () => setZoom(stepZoom(useZoom.getState().zoom, -1));
export const resetZoom = () => setZoom(1);

/** Applies the saved zoom and wires Ctrl+wheel. Returns a cleanup function. */
export function installZoom(): () => void {
  apply(useZoom.getState().zoom);
  let acc = 0;
  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    // Image and preview canvases use Ctrl+wheel for their own zoom.
    if ((event.target as HTMLElement | null)?.closest?.('.image-stage, [data-own-zoom]')) return;
    event.preventDefault();
    acc += event.deltaY;
    if (Math.abs(acc) < 50) return;
    const direction = acc < 0 ? 1 : -1;
    acc = 0;
    if (direction > 0) zoomIn();
    else zoomOut();
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  return () => window.removeEventListener('wheel', onWheel);
}
