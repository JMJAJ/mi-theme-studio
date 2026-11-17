// In-app updates: look for a newer release on GitHub (on start and every few
// hours), show it in the title bar, and on click download the signed
// installer, install it and restart. Unsaved work is offered a save first.
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { create } from 'zustand';
import { errorMessage } from '../lib/api';
import { ensureCanDiscard } from './actions';
import { toast } from './store';

type Status = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';

export const useUpdater = create<{ status: Status; version?: string; notes?: string; progress?: number; error?: string; checkedAt?: number }>(() => ({ status: 'idle' }));

let pending: Update | null = null;
let started = false;

/** Ask GitHub for a newer version. `manual` reports "up to date" and errors as toasts. */
export async function checkForUpdate(manual = false) {
  const { status } = useUpdater.getState();
  if (status === 'checking' || status === 'downloading' || status === 'installing') return;
  useUpdater.setState({ status: 'checking', error: undefined });
  try {
    const update = await check();
    pending = update;
    if (update) {
      useUpdater.setState({ status: 'available', version: update.version, notes: update.body ?? undefined, checkedAt: Date.now() });
      if (manual) toast('info', `Mi Theme Studio ${update.version} is available.`, undefined, [{ label: 'Update now', run: () => void installUpdate() }]);
    } else {
      useUpdater.setState({ status: 'none', checkedAt: Date.now() });
      if (manual) toast('success', 'You have the latest version.');
    }
  } catch (e) {
    useUpdater.setState({ status: 'error', error: errorMessage(e), checkedAt: Date.now() });
    if (manual) toast('error', 'Could not check for updates', errorMessage(e));
  }
}

/** Download, install and restart. */
export async function installUpdate() {
  if (!pending) return;
  if (!(await ensureCanDiscard('update and restart'))) return;
  let total = 0;
  let received = 0;
  useUpdater.setState({ status: 'downloading', progress: 0 });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        useUpdater.setState({ progress: total ? Math.min(1, received / total) : undefined });
      } else if (event.event === 'Finished') useUpdater.setState({ status: 'installing' });
    });
    await relaunch();
  } catch (e) {
    useUpdater.setState({ status: 'available', progress: undefined });
    toast('error', 'The update could not be installed', errorMessage(e));
  }
}

/** Check shortly after start, then every 6 hours. Not in development builds. */
export function startUpdateChecks() {
  if (started || import.meta.env.DEV) return;
  started = true;
  window.setTimeout(() => void checkForUpdate(false), 8000);
  window.setInterval(() => void checkForUpdate(false), 6 * 60 * 60 * 1000);
}
