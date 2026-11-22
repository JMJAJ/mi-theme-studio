// Application actions: every user operation goes through here so errors,
// logging, toasts and snapshot updates are handled consistently.
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api, errorCode, errorMessage, newOpId, resourceUrl } from '../lib/api';
import { fileName, joinPath, parentOf, splitNested, validateName } from '../lib/paths';
import type { AdbLogEntry, ConflictPolicy, DownloadedTheme, MediaTarget, ExportProgress, ProjectSnapshot, SaveResult, Slot, ThemeManagerSupport } from '../lib/types';
import { formatBytes, plural } from '../lib/format';
import { useMirrorStream } from './mirrorStream';
import {
  choiceDialog,
  confirmDialog,
  getState,
  hasUnsavedWork,
  indexFiles,
  log,
  pathExists,
  promptDialog,
  setState,
  type Section,
  type Tab,
  type TabKind,
  toast,
  updateLayout,
} from './store';

const PACKAGE_FILTERS = [
  { name: 'Theme packages', extensions: ['mtz', 'zip'] },
  { name: 'All files', extensions: ['*'] },
];

// ---------------------------------------------------------------------------
// helpers

async function guard<T>(label: string, run: () => Promise<T>, busy?: string): Promise<T | undefined> {
  if (busy) setState({ busy });
  try {
    return await run();
  } catch (error) {
    toast('error', `${label}: ${errorMessage(error)}`);
    return undefined;
  } finally {
    if (busy) setState({ busy: null });
  }
}

let validationTimer: number | undefined;
function scheduleValidation(delay = 600) {
  window.clearTimeout(validationTimer);
  validationTimer = window.setTimeout(() => void runValidation(true), delay);
}

export function applySnapshot(snapshot: ProjectSnapshot | null) {
  const fileIndex = indexFiles(snapshot);
  setState((s) => {
    const selection = s.selection.filter((p) => pathExists(snapshot, fileIndex, p));
    // Drop drafts whose file disappeared only if they are unchanged.
    return {
      project: snapshot,
      fileIndex,
      selection,
      selectionAnchor: selection.includes(s.selectionAnchor ?? '') ? s.selectionAnchor : (selection[0] ?? null),
    };
  });
  if (snapshot) scheduleValidation();
  else setState({ validation: null });
}

function applyReference(snapshot: ProjectSnapshot | null) {
  setState({ reference: snapshot, refIndex: indexFiles(snapshot), refSelection: [] });
}

export async function runValidation(quiet = false) {
  if (!getState().project) return;
  setState({ validating: true });
  try {
    const report = await api.validate();
    setState({ validation: report });
    if (!quiet) {
      toast(report.errors ? 'warning' : 'success', `Validation: ${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}`);
    }
  } catch (error) {
    if (!quiet) toast('error', `Validation failed: ${errorMessage(error)}`);
  } finally {
    setState({ validating: false });
  }
}

// ---------------------------------------------------------------------------
// startup

export async function init() {
  try {
    const info = await api.appInfo();
    setState({ appInfo: info, settings: info.settings, recoveryOffer: info.recovery });
    log('info', `Mi Theme Studio ${info.version} started`);
  } catch (error) {
    log('error', `Could not load app settings: ${errorMessage(error)}`);
  }
  await listen<ExportProgress>('export-progress', (event) => {
    setState({ exportProgress: event.payload.stage === 'done' ? null : event.payload });
  });
  await listen<AdbLogEntry>('adb-log', (event) => {
    setState((s) => ({ adbLog: [...s.adbLog.slice(-499), event.payload] }));
  });
  const [snapshot, reference, adbLog, screenshots] = await Promise.all([
    api.projectSnapshot().catch(() => null),
    api.referenceSnapshot().catch(() => null),
    api.adbLog().catch(() => []),
    api.screenshotsList().catch(() => []),
  ]);
  setState({ adbLog, screenshots });
  if (snapshot) {
    applySnapshot(snapshot);
    openSingleton('dashboard');
  }
  if (reference) applyReference(reference);
  void refreshAdb(false, true);
}

// ---------------------------------------------------------------------------
// tabs

const SINGLETON_TITLES: Partial<Record<TabKind, string>> = {
  dashboard: 'Dashboard',
  info: 'Theme details',
  preview: 'Preview',
  device: 'Device',
  build: 'Build & export',
  roadmap: 'Roadmap',
  catalog: 'Theme store',
};

export function openTab(tab: Tab) {
  setState((s) => {
    const exists = s.tabs.some((t) => t.id === tab.id);
    return { tabs: exists ? s.tabs : [...s.tabs, tab], activeTab: tab.id };
  });
}

export function goTo(section: Section, part: string | null = null) {
  setState({ section, part });
}

/** Views that used to be tabs now map onto app sections. */
export function openSingleton(kind: TabKind) {
  switch (kind) {
    case 'dashboard':
      return goTo('design');
    case 'info':
      return goTo('design', 'info');
    case 'catalog':
      return goTo('store');
    case 'device':
      return goTo('phone');
    case 'build':
      return goTo('check');
    case 'preview':
      return updateLayout({ phone: true });
    default:
      setState({ section: 'files' });
      openTab({ id: kind, kind, title: SINGLETON_TITLES[kind] ?? kind });
  }
}

export function openComponent(id: string) {
  goTo('design', id === 'metadata' ? 'info' : id);
}

let revealNonce = 0;
/** Open a file and select a range in its text editor. */
export function revealInFile(path: string, line: number, column: number, length: number) {
  openFile(path);
  setState({ reveal: { path, line, column, length, nonce: ++revealNonce } });
}

export function openFile(path: string, slot: Slot = 'main') {
  setState({ section: 'files' });
  openTab({ id: `file:${slot}:${path}`, kind: 'file', path, slot, title: fileName(path) });
  if (slot === 'main') setState({ selection: [path], selectionAnchor: path });
}

export async function closeTab(id: string): Promise<boolean> {
  const state = getState();
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return true;
  if (tab.kind === 'file' && tab.path && state.drafts[tab.path]) {
    const choice = await choiceDialog({
      title: 'Unapplied edits',
      message: `${tab.title} has edits that are not applied to the package yet.`,
      choices: [
        { id: 'apply', label: 'Apply edits', primary: true },
        { id: 'discard', label: 'Discard edits', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'apply' && !(await applyDraft(tab.path))) return false;
    if (choice === 'discard') discardDraft(tab.path);
  }
  setState((s) => {
    const index = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeTab = s.activeTab;
    if (activeTab === id) activeTab = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    return { tabs, activeTab };
  });
  return true;
}

export async function closeAllTabs() {
  for (const tab of [...getState().tabs]) {
    if (!(await closeTab(tab.id))) return;
  }
}

export function cycleTab(direction: 1 | -1) {
  const { tabs, activeTab } = getState();
  if (!tabs.length) return;
  const index = tabs.findIndex((t) => t.id === activeTab);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  setState({ activeTab: next.id });
}

function retargetTabs(mapping: Map<string, string>) {
  if (!mapping.size) return;
  setState((s) => {
    const drafts = { ...s.drafts };
    const ids = new Map<string, string>();
    const tabs = s.tabs.map((tab) => {
      if (tab.kind !== 'file' || tab.slot !== 'main' || !tab.path) return tab;
      const next = mapping.get(tab.path);
      if (!next) return tab;
      if (drafts[tab.path]) {
        drafts[next] = drafts[tab.path];
        delete drafts[tab.path];
      }
      const id = `file:main:${next}`;
      ids.set(tab.id, id);
      return { ...tab, id, path: next, title: fileName(next) };
    });
    const activeTab = s.activeTab ? (ids.get(s.activeTab) ?? s.activeTab) : null;
    return { tabs, drafts, activeTab };
  });
}

/** Map old paths to new paths after a move/rename of files or folders. */
function pathMapping(before: string[], after: string[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const files = getState().tabs.filter((t) => t.kind === 'file' && t.slot === 'main' && t.path).map((t) => t.path!);
  before.forEach((source, i) => {
    const target = after[i];
    if (!target) return;
    for (const file of files) {
      if (file === source) mapping.set(file, target);
      else if (file.startsWith(`${source}/`)) mapping.set(file, `${target}${file.slice(source.length)}`);
      else if (file.startsWith(`${source}!/`)) mapping.set(file, `${target}${file.slice(source.length)}`);
    }
  });
  return mapping;
}

// ---------------------------------------------------------------------------
// project lifecycle

/** Returns true when it is OK to replace/close the current project. */
export async function ensureCanDiscard(action: string): Promise<boolean> {
  const state = getState();
  if (!state.project || !hasUnsavedWork(state)) return true;
  const choice = await choiceDialog({
    title: 'Unsaved changes',
    message: `“${state.project.title}” has unsaved changes. Save before you ${action}?`,
    choices: [
      { id: 'save', label: 'Save', primary: true },
      { id: 'discard', label: "Don't save", danger: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice === 'cancel') return false;
  if (choice === 'save') return (await save()) !== undefined;
  setState({ drafts: {} });
  return true;
}

function resetWorkspace(snapshot: ProjectSnapshot) {
  setState({ tabs: [], activeTab: null, drafts: {}, selection: [], selectionAnchor: null, expanded: new Set(), validation: null });
  applySnapshot(snapshot);
  openSingleton('dashboard');
}

export async function newProject() {
  if (!(await ensureCanDiscard('start a new theme'))) return;
  const title = await promptDialog({
    title: 'New theme',
    label: 'Theme title',
    initial: 'My Theme',
    confirmLabel: 'Create',
    validate: (v) => (v.trim() ? null : 'Enter a title.'),
  });
  if (title === null) return;
  const snapshot = await guard('New theme', () => api.projectNew(title));
  if (!snapshot) return;
  resetWorkspace(snapshot);
  goTo('design');
  const startWith = await choiceDialog({
    title: `Start “${snapshot.title}” with…`,
    message: 'Pick what to put in first. You can add or swap any part afterwards.',
    choices: [
      { id: 'wallpaper', label: 'A wallpaper', primary: true },
      { id: 'icons', label: 'Wallpaper + icon pack' },
      { id: 'store', label: 'Parts from a store theme' },
      { id: 'empty', label: 'Nothing yet' },
    ],
  });
  if (startWith === 'wallpaper' || startWith === 'icons') {
    const picked = await openDialog({ title: 'Wallpaper picture', multiple: false, directory: false, filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (picked && !Array.isArray(picked)) await setWallpaperFromFile(picked, 'both');
    if (startWith === 'icons' && (await ensureContainer('icons'))) goTo('design', 'icons');
  } else if (startWith === 'store') goTo('store');
  else toast('success', `Created “${snapshot.title}”. Save it to choose a file location.`);
}

export async function openPackage(path?: string) {
  if (!(await ensureCanDiscard('open another package'))) return;
  const chosen =
    path ?? ((await openDialog({ title: 'Open theme package', multiple: false, directory: false, filters: PACKAGE_FILTERS })) as string | null);
  if (!chosen) return;
  const snapshot = await guard('Open package', () => api.projectOpen(chosen), `Opening ${fileName(chosen.replace(/\\/g, '/'))}…`);
  if (!snapshot) return;
  resetWorkspace(snapshot);
  const report = snapshot.importReport;
  const notes: string[] = [];
  if (report?.nestedArchives.length) notes.push(`${plural(report.nestedArchives.length, 'component archive')}`);
  if (report?.skipped.length) notes.push(`${plural(report.skipped.length, 'unsafe entry', 'unsafe entries')} skipped`);
  toast(report?.skipped.length ? 'warning' : 'success', `Opened ${snapshot.name} · ${plural(snapshot.files.length, 'file')}${notes.length ? ` · ${notes.join(', ')}` : ''}`);
  for (const warning of report?.warnings ?? []) log('warning', warning);
  for (const skipped of report?.skipped ?? []) log('warning', `Skipped ${skipped.path}: ${skipped.reason}`);
  refreshSettings();
}

export async function closeProject() {
  if (!(await ensureCanDiscard('close this package'))) return;
  await guard('Close package', () => api.projectClose());
  setState({ tabs: [], activeTab: null, drafts: {}, selection: [], validation: null, lastAutosave: null });
  applySnapshot(null);
}

export async function refreshSettings() {
  const info = await api.appInfo().catch(() => null);
  if (info) setState({ appInfo: info, settings: info.settings });
}

export async function removeRecent(path: string) {
  const settings = await guard('Update recent list', () => api.recentRemove(path));
  if (settings) setState({ settings });
}

// ---------------------------------------------------------------------------
// save / export

/** Apply all text drafts. Returns false if the user cancelled. */
export async function applyAllDrafts(): Promise<boolean> {
  for (const path of Object.keys(getState().drafts)) {
    if (!(await applyDraft(path))) return false;
  }
  return true;
}

function recordBuild(result: SaveResult) {
  const { snapshot, ...rest } = result;
  applySnapshot(snapshot);
  setState((s) => ({ builds: [{ ...rest, atMs: Date.now() }, ...s.builds].slice(0, 30), lastAutosave: null }));
  const verb = result.mode === 'copy' ? 'Exported copy' : 'Saved';
  toast('success', `${verb} ${fileName(result.path.replace(/\\/g, '/'))} · ${formatBytes(result.bytes)} · ${plural(result.entries, 'entry', 'entries')} · verified`);
  if (result.backupPath) log('info', `Previous file backed up to ${result.backupPath}`);
}

export async function save(): Promise<SaveResult | undefined> {
  const project = getState().project;
  if (!project) return undefined;
  if (!(await applyAllDrafts())) return undefined;
  if (!project.sourcePath) return saveAs();
  const result = await guard('Save', () => api.save('save'), 'Saving…');
  if (result) recordBuild(result);
  return result;
}

function suggestedName() {
  const project = getState().project;
  const base = (project?.name ?? 'Theme.mtz').replace(/\.(mtz|zip)$/i, '');
  return `${base}.mtz`;
}

export async function saveAs(): Promise<SaveResult | undefined> {
  if (!getState().project) return undefined;
  if (!(await applyAllDrafts())) return undefined;
  const path = await saveDialog({ title: 'Save theme package as', defaultPath: suggestedName(), filters: [{ name: 'MIUI theme package', extensions: ['mtz'] }] });
  if (!path) return undefined;
  const result = await guard('Save as', () => api.save('saveAs', path), 'Saving…');
  if (result) recordBuild(result);
  return result;
}

export async function exportCopy() {
  if (!getState().project) return;
  if (!(await applyAllDrafts())) return;
  const path = await saveDialog({ title: 'Export a copy', defaultPath: suggestedName(), filters: [{ name: 'MIUI theme package', extensions: ['mtz'] }] });
  if (!path) return;
  const result = await guard('Export', () => api.save('copy', path), 'Exporting…');
  if (result) recordBuild(result);
}

export async function saveReport() {
  const project = getState().project;
  if (!project) return;
  const path = await saveDialog({
    title: 'Save package report',
    defaultPath: `${project.name.replace(/\.(mtz|zip)$/i, '')}-report.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!path) return;
  const ok = await guard('Save report', () => api.reportSave(path).then(() => true));
  if (ok) toast('success', `Report saved to ${fileName(path.replace(/\\/g, '/'))}`);
}

export async function revealPath(path: string) {
  await guard('Show in folder', () => revealItemInDir(path));
}

// ---------------------------------------------------------------------------
// history

export async function undo() {
  const project = getState().project;
  if (!project?.canUndo) return;
  const label = project.undoLabel;
  const snapshot = await guard('Undo', () => api.undo());
  if (snapshot) {
    applySnapshot(snapshot);
    log('info', `Undid: ${label}`);
  }
}

export async function redo() {
  const project = getState().project;
  if (!project?.canRedo) return;
  const label = project.redoLabel;
  const snapshot = await guard('Redo', () => api.redo());
  if (snapshot) {
    applySnapshot(snapshot);
    log('info', `Redid: ${label}`);
  }
}

export async function historyGoto(id: number | null): Promise<boolean> {
  const snapshot = await guard('History', () => api.historyGoto(id));
  if (snapshot) applySnapshot(snapshot);
  return !!snapshot;
}

// ---------------------------------------------------------------------------
// selection

export function select(path: string, mode: 'single' | 'toggle' | 'range', ordered?: string[]) {
  setState((s) => {
    if (mode === 'toggle') {
      const has = s.selection.includes(path);
      return { selection: has ? s.selection.filter((p) => p !== path) : [...s.selection, path], selectionAnchor: path };
    }
    if (mode === 'range' && ordered && s.selectionAnchor) {
      const a = ordered.indexOf(s.selectionAnchor);
      const b = ordered.indexOf(path);
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a];
        return { selection: ordered.slice(from, to + 1) };
      }
    }
    return { selection: [path], selectionAnchor: path };
  });
}

export function toggleExpanded(key: string, slot: Slot = 'main', force?: boolean) {
  setState((s) => {
    const field = slot === 'main' ? 'expanded' : 'refExpanded';
    const next = new Set(s[field]);
    const open = force ?? !next.has(key);
    if (open) next.add(key);
    else next.delete(key);
    return { [field]: next } as Pick<typeof s, 'expanded'>;
  });
}

export function revealInExplorer(path: string) {
  const keys: string[] = [];
  let current = parentOf(path);
  while (current) {
    keys.push(current.endsWith('!/') ? current.slice(0, -2) : current);
    current = current.endsWith('!/') ? '' : parentOf(current);
  }
  setState((s) => ({ expanded: new Set([...s.expanded, ...keys]), sideTab: 'files', selection: [path], selectionAnchor: path, layout: { ...s.layout, sidebar: true } }));
}

// ---------------------------------------------------------------------------
// file operations

function isContainer(path: string) {
  return !!getState().project?.containers.some((c) => c.name === path);
}

export async function renamePath(path: string) {
  const current = isContainer(path) ? path : fileName(path);
  const value = await promptDialog({
    title: 'Rename',
    label: 'New name',
    initial: current,
    confirmLabel: 'Rename',
    selectStem: !isContainer(path),
    validate: validateName,
  });
  if (value === null || value === current) return;
  const response = await guard('Rename', () => api.fileRename(path, value));
  if (!response) return;
  applySnapshot(response.snapshot);
  retargetTabs(pathMapping([path], response.paths));
  setState({ selection: response.paths, selectionAnchor: response.paths[0] });
  log('success', `Renamed ${current} → ${value}`);
}

export async function duplicatePaths(paths: string[]) {
  const files = paths.filter((p) => getState().fileIndex.has(p));
  if (!files.length) {
    toast('warning', 'Select files to duplicate.');
    return;
  }
  const response = await guard('Duplicate', () => api.filesDuplicate(files));
  if (!response) return;
  applySnapshot(response.snapshot);
  setState({ selection: response.paths, selectionAnchor: response.paths[0] });
  toast('success', `Duplicated ${plural(files.length, 'file')}`);
}

export async function deletePaths(paths: string[]) {
  if (!paths.length) return;
  const state = getState();
  const affected = state.project!.files.filter((f) => paths.some((p) => f.path === p || f.path.startsWith(`${p}/`) || f.path.startsWith(`${p}!/`)));
  const ok = await confirmDialog({
    title: paths.length === 1 ? `Delete ${fileName(paths[0])}?` : `Delete ${paths.length} items?`,
    message: `${plural(affected.length, 'file')} (${formatBytes(affected.reduce((n, f) => n + f.size, 0))}) will be removed from the package. You can undo this.`,
    detail: affected.slice(0, 8).map((f) => f.path),
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const snapshot = await guard('Delete', () => api.filesDelete(paths));
  if (!snapshot) return;
  const gone = new Set(affected.map((f) => f.path));
  setState((s) => {
    const drafts = { ...s.drafts };
    for (const path of gone) delete drafts[path];
    return { drafts };
  });
  applySnapshot(snapshot);
  toast('success', `Deleted ${plural(affected.length, 'file')}`);
}

export async function movePaths(paths: string[], folder: string) {
  const response = await guard('Move', () => api.filesMove(paths, folder));
  if (!response) return;
  applySnapshot(response.snapshot);
  retargetTabs(pathMapping(paths, response.paths));
  setState({ selection: response.paths, selectionAnchor: response.paths[0] });
  log('success', `Moved ${plural(paths.length, 'item')} to ${folder || 'package root'}`);
}

async function askPolicy(conflicts: string[]): Promise<ConflictPolicy | null> {
  if (!conflicts.length) return 'skip';
  const choice = await choiceDialog({
    title: 'Files already exist',
    message: `${plural(conflicts.length, 'file')} already exist${conflicts.length === 1 ? 's' : ''}: ${conflicts.slice(0, 3).map(fileName).join(', ')}${conflicts.length > 3 ? '…' : ''}`,
    choices: [
      { id: 'overwrite', label: 'Replace', danger: true },
      { id: 'rename', label: 'Keep both', primary: true },
      { id: 'skip', label: 'Skip existing' },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  return choice === 'cancel' ? null : (choice as ConflictPolicy);
}

export async function importFiles(sources: string[], folder: string) {
  if (!getState().project || !sources.length) return;
  const index = getState().fileIndex;
  const conflicts = sources.map((s) => joinPath(folder, fileName(s.replace(/\\/g, '/')))).filter((p) => index.has(p));
  const policy = await askPolicy(conflicts);
  if (!policy) return;
  const response = await guard('Add files', () => api.filesImport(sources, folder, policy), 'Adding files…');
  if (!response) return;
  applySnapshot(response.snapshot);
  const { written, skipped, overwritten } = response.result;
  if (written.length) setState({ selection: written, selectionAnchor: written[0] });
  toast('success', `Added ${plural(written.length, 'file')}${overwritten.length ? ` (${overwritten.length} replaced)` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}`);
}

/** Pick a PNG and store it as the themed icon for an app (`<package>.png`). */
export async function addAppIcon(pkg: string, label: string, folder: string) {
  if (!getState().project) return;
  const picked = await openDialog({ title: `Icon for ${label}`, multiple: false, directory: false, filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (!picked || Array.isArray(picked)) return;
  const target = joinPath(folder, `${pkg}.png`);
  const policy = await askPolicy(getState().fileIndex.has(target) ? [target] : []);
  if (!policy) return;
  const response = await guard('Add icon', () => api.filesImport([picked], folder, policy, [`${pkg}.png`]), 'Adding icon…');
  if (!response) return;
  applySnapshot(response.snapshot);
  toast('success', `Icon for ${label} added`);
}

export async function addFilesDialog(folder: string) {
  const picked = await openDialog({ title: `Add files to ${folder || 'package root'}`, multiple: true, directory: false });
  if (!picked) return;
  await importFiles(Array.isArray(picked) ? picked : [picked], folder);
}

export async function replaceFile(path: string) {
  const info = getState().fileIndex.get(path);
  const ext = info ? fileName(path).split('.').pop() : undefined;
  const picked = await openDialog({
    title: `Replace ${fileName(path)}`,
    multiple: false,
    directory: false,
    filters: ext && ext !== fileName(path) ? [{ name: `.${ext} files`, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
  });
  if (!picked || Array.isArray(picked)) return;
  const snapshot = await guard('Replace', () => api.fileReplace(path, picked));
  if (snapshot) {
    applySnapshot(snapshot);
    const next = snapshot.files.find((f) => f.path === path);
    if (info?.width && next?.width && (info.width !== next.width || info.height !== next.height)) {
      toast('warning', `Replaced ${fileName(path)} — size changed from ${info.width}×${info.height} to ${next.width}×${next.height}`);
    } else {
      toast('success', `Replaced ${fileName(path)}`);
    }
  }
}

export async function extractFile(path: string, slot: Slot = 'main') {
  const target = await saveDialog({ title: `Export ${fileName(path)}`, defaultPath: fileName(path) });
  if (!target) return;
  const ok = await guard('Export file', () => api.fileExtract(path, target, slot).then(() => true));
  if (ok) toast('success', `Exported ${fileName(path)}`);
}

/** Export selected files/folders, or the whole package when paths is empty. */
export async function exportPaths(paths: string[], slot: Slot = 'main') {
  const selection = [...new Set(paths)];
  const title = selection.length ? `Export ${selection.length} selected item${selection.length === 1 ? '' : 's'}` : 'Export all package files';
  const destination = await openDialog({ title, multiple: false, directory: true });
  if (!destination || Array.isArray(destination)) return;
  const result = await guard('Export files', () => api.filesExtract(selection, destination, slot), `Exporting ${selection.length || 'all'} files…`);
  if (result) toast('success', `Exported ${plural(result.files, 'file', 'files')} (${formatBytes(result.bytes)}) to the selected folder`);
}

export async function createContainer(initial = '') {
  const name = await promptDialog({
    title: 'New component archive',
    message: 'Components such as icons, lockscreen or com.android.systemui are stored as ZIP archives inside the .mtz.',
    label: 'Archive name',
    initial,
    confirmLabel: 'Create',
    validate: validateName,
  });
  if (!name) return;
  const snapshot = await guard('Create component', () => api.containerCreate(name));
  if (snapshot) {
    applySnapshot(snapshot);
    toggleExpanded(name, 'main', true);
    toast('success', `Created component archive ${name}`);
  }
}

export async function packFolder(folder: string) {
  const ok = await confirmDialog({
    title: `Pack ${folder}/ as a component archive?`,
    message: `All files under ${folder}/ move into a ZIP component named “${folder}”, which is how packages store this component. You can undo this.`,
    confirmLabel: 'Pack folder',
  });
  if (!ok) return;
  const snapshot = await guard('Pack folder', () => api.folderPack(folder));
  if (snapshot) {
    applySnapshot(snapshot);
    toast('success', `Packed ${folder} into a component archive`);
  }
}

export async function createDescription() {
  const title = getState().project?.title ?? 'My Theme';
  const snapshot = await guard('Create description.xml', () => api.metadataUpdate([{ name: 'title', value: title }], 'Create description.xml'));
  if (snapshot) applySnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// text drafts

export function setDraft(path: string, text: string, baseRev: number, original: string) {
  setState((s) => {
    const drafts = { ...s.drafts };
    if (text === original) delete drafts[path];
    else drafts[path] = { text, baseRev, original };
    return { drafts };
  });
}

export function discardDraft(path: string) {
  setState((s) => {
    const drafts = { ...s.drafts };
    delete drafts[path];
    return { drafts };
  });
}

export async function applyDraft(path: string): Promise<boolean> {
  const draft = getState().drafts[path];
  if (!draft) return true;
  try {
    const snapshot = await api.fileWriteText(path, draft.text, false);
    discardDraft(path);
    applySnapshot(snapshot);
    log('success', `Applied edits to ${path}`);
    return true;
  } catch (error) {
    if (errorCode(error) === 'xml_invalid') {
      const force = await confirmDialog({
        title: 'XML is not well-formed',
        message: `${errorMessage(error)}\n\nApplying invalid XML may break the theme on the device.`,
        confirmLabel: 'Apply anyway',
        danger: true,
      });
      if (!force) return false;
      try {
        const snapshot = await api.fileWriteText(path, draft.text, true);
        discardDraft(path);
        applySnapshot(snapshot);
        log('warning', `Applied invalid XML to ${path}`);
        return true;
      } catch (inner) {
        toast('error', `Apply edits: ${errorMessage(inner)}`);
        return false;
      }
    }
    toast('error', `Apply edits: ${errorMessage(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// metadata

export async function updateMetadata(fields: { name: string; value: string }[], label?: string) {
  const snapshot = await guard('Theme details', () => api.metadataUpdate(fields, label));
  if (snapshot) applySnapshot(snapshot);
  return !!snapshot;
}

// ---------------------------------------------------------------------------
// reference package

export async function openReference(reveal = true) {
  const picked = await openDialog({ title: 'Open reference package (read-only)', multiple: false, directory: false, filters: PACKAGE_FILTERS });
  if (!picked || Array.isArray(picked)) return null;
  const snapshot = await guard('Open reference', () => api.referenceOpen(picked), 'Opening reference…');
  if (snapshot) {
    applyReference(snapshot);
    if (reveal) {
      setState((s) => ({ sideTab: 'reference', layout: { ...s.layout, sidebar: true } }));
      toast('success', `Reference “${snapshot.title}” opened read-only`);
    }
  }
  return snapshot ?? null;
}

/** Open a theme cached by Theme Manager on the phone as the read-only reference package. */
export async function openPhoneThemeAsReference(serial: string, localId: string, title: string) {
  const snapshot = await guard('Open reference', () => api.adbCachedThemeReference(serial, localId), `Copying ${title} from the phone…`);
  if (!snapshot) return null;
  applyReference(snapshot);
  return snapshot;
}

/** Next steps offered after something was put into the theme: undo it, or see it on the phone. */
function afterChange(undoSteps: number) {
  const ready = !!getState().adb?.devices.some((d) => d.serial === getState().selectedSerial && d.state === 'device');
  return [
    {
      label: 'Undo',
      run: () => {
        void (async () => {
          for (let i = 0; i < undoSteps; i++) await undo();
        })();
      },
    },
    { label: ready ? 'Try on phone' : 'Connect phone', run: () => (ready ? void tryOnOrPermanent() : goTo('phone')) },
  ];
}

/** Save files made inside the app (cropped wallpaper, generated icons) into the theme as one undoable change. */
export async function writeGenerated(files: { path: string; bytes: Uint8Array }[], label: string, done?: string) {
  if (!getState().project || !files.length) return false;
  const response = await guard(label, () => api.filesWrite(files.map((f) => ({ path: f.path, data: Array.from(f.bytes) })), label), `${label}…`);
  if (!response) return false;
  applySnapshot(response.snapshot);
  if (done) toast('success', done, undefined, afterChange(1));
  return true;
}

/**
 * Save generated preview pictures into preview/. A file with the same name but
 * another extension is removed so Theme Manager does not show it twice;
 * `removeOthers` clears every other preview picture first.
 */
export async function savePreviewImages(files: { path: string; bytes: Uint8Array }[], removeOthers: boolean) {
  const project = getState().project;
  if (!project || !files.length) return false;
  const stemOf = (p: string) => p.slice(0, p.lastIndexOf('.')).toLowerCase();
  const stems = new Set(files.map((f) => stemOf(f.path)));
  const paths = new Set(files.map((f) => f.path.toLowerCase()));
  const stale = project.files
    .filter((f) => f.component === 'previews' && !f.path.includes('!/') && !paths.has(f.path.toLowerCase()) && (removeOthers ? f.kind === 'image' : stems.has(stemOf(f.path))))
    .map((f) => f.path);
  if (stale.length) {
    const snapshot = await guard('Replace previews', () => api.filesDelete(stale));
    if (!snapshot) return false;
    applySnapshot(snapshot);
  }
  return writeGenerated(files, 'Generate previews', `${files.length} preview picture${files.length === 1 ? '' : 's'} added to preview/`);
}

/**
 * Take the open reference theme's home and/or lock wallpaper into this theme,
 * as wallpaper/default_wallpaper.* and wallpaper/default_lock_wallpaper.*.
 * Only the chosen screen changes; a theme with one picture gives it to both.
 */
export async function takeReferenceWallpaper(which: 'home' | 'lock' | 'both') {
  const { reference, project } = getState();
  if (!reference || !project) return false;
  const walls = reference.files.filter((f) => f.component === 'wallpapers' && f.kind === 'image');
  const named = (re: RegExp) => walls.find((f) => re.test(fileName(f.path)));
  const home = named(/^default_wallpaper\./i) ?? walls.find((f) => !/lock/i.test(f.path)) ?? walls[0];
  const lock = named(/^default_lock_wallpaper\./i) ?? named(/lock/i) ?? home;
  const jobs = [
    ...(which !== 'lock' && home ? [{ stem: 'wallpaper/default_wallpaper', src: home }] : []),
    ...(which !== 'home' && lock ? [{ stem: 'wallpaper/default_lock_wallpaper', src: lock }] : []),
  ];
  if (!jobs.length) {
    toast('warning', `${reference.title} has no wallpaper to take.`);
    return false;
  }
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const job of jobs) {
    const ext = (job.src.path.split('.').pop() ?? 'jpg').toLowerCase();
    const response = await fetch(`${resourceUrl('ref', job.src.path, job.src.rev)}&take`);
    if (!response.ok) {
      toast('error', `Could not read ${fileName(job.src.path)} from ${reference.title}.`);
      return false;
    }
    files.push({ path: `${job.stem}.${ext}`, bytes: new Uint8Array(await response.arrayBuffer()) });
  }
  // The same picture under another extension would be a second wallpaper: remove it.
  const stale = project.files
    .filter((f) => !f.path.includes('!/') && files.some((n) => n.path !== f.path && f.path.toLowerCase().startsWith(`${n.path.slice(0, n.path.lastIndexOf('.')).toLowerCase()}.`)))
    .map((f) => f.path);
  if (stale.length) {
    const snapshot = await guard('Replace wallpaper', () => api.filesDelete(stale));
    if (!snapshot) return false;
    applySnapshot(snapshot);
  }
  const where = which === 'both' ? 'home and lock screen' : which === 'home' ? 'home screen' : 'lock screen';
  return writeGenerated(files, 'Take wallpaper', `${where[0].toUpperCase()}${where.slice(1)} wallpaper taken from ${reference.title}`);
}

/** Replace a text file's contents (used by editors that are not the code editor, e.g. Colours). */
export async function writeText(path: string, text: string) {
  const snapshot = await guard('Save', () => api.fileWriteText(path, text, false));
  if (!snapshot) return false;
  setState((s) => {
    const drafts = { ...s.drafts };
    delete drafts[path];
    return { drafts };
  });
  applySnapshot(snapshot);
  return true;
}

/** Create a part's component archive without asking for a name. */
export async function ensureContainer(name: string) {
  if (getState().project?.containers.some((c) => c.name === name)) return true;
  const snapshot = await guard('Create component', () => api.containerCreate(name));
  if (!snapshot) return false;
  applySnapshot(snapshot);
  return true;
}

/** Top-level paths (nested packages and loose files) that make up one part of a theme. */
export function partPaths(snapshot: ProjectSnapshot, component: string) {
  const paths = new Set(snapshot.containers.filter((c) => c.component === component).map((c) => c.name));
  for (const f of snapshot.files) {
    if (f.component !== component) continue;
    const [outer, inner] = splitNested(f.path);
    if (inner === null || !paths.has(outer)) paths.add(inner === null ? f.path : outer);
  }
  return [...paths];
}

/**
 * Replace parts of the open theme (icons, lock screen, fonts…) with the same
 * parts of the reference package. With `clean`, each part's current files are
 * removed first so nothing from the old version lingers. Both steps undo.
 */
export async function swapParts(parts: { id: string; label: string }[], clean: boolean) {
  const { project, reference } = getState();
  if (!project || !reference || !parts.length) return false;
  const usable = parts.filter((p) => partPaths(reference, p.id).length > 0);
  const names = usable.map((p) => p.label).join(', ');
  if (!usable.length) {
    toast('warning', `“${reference.title}” has none of those parts`);
    return false;
  }
  const source = usable.flatMap((p) => partPaths(reference, p.id));
  const current = clean ? usable.flatMap((p) => partPaths(project, p.id)) : [];
  if (current.length) {
    const snapshot = await guard('Swap', () => api.filesDelete(current), 'Removing the current files…');
    if (!snapshot) return false;
    const gone = new Set(project.files.filter((f) => current.some((p) => f.path === p || f.path.startsWith(`${p}/`) || f.path.startsWith(`${p}!/`))).map((f) => f.path));
    setState((s) => {
      const drafts = { ...s.drafts };
      for (const path of gone) delete drafts[path];
      return { drafts };
    });
    applySnapshot(snapshot);
  }
  const response = await guard('Swap', () => api.referenceCopy(source, null, 'overwrite'), `Copying ${names.toLowerCase()}…`);
  if (!response) return false;
  applySnapshot(response.snapshot);
  toast('success', `${names} now from “${reference.title}” (${plural(response.result.written.length, 'file')})`, undefined, afterChange(current.length ? 2 : 1));
  return true;
}

/** Use an image from disk as the home and/or lock wallpaper, replacing the current one. */
export async function setWallpaperFromFile(source: string, where: 'home' | 'lock' | 'both') {
  const project = getState().project;
  if (!project) return false;
  const ext = (source.split('.').pop() ?? 'jpg').toLowerCase();
  const walls = project.files.filter((f) => f.kind === 'image' && f.component === 'wallpapers');
  const slots: { name: string; existing?: string }[] = [];
  if (where !== 'lock') slots.push({ name: 'default_wallpaper', existing: walls.find((f) => /^default_wallpaper\./i.test(fileName(f.path)))?.path });
  if (where !== 'home') slots.push({ name: 'default_lock_wallpaper', existing: walls.find((f) => /^default_lock_wallpaper\./i.test(fileName(f.path)))?.path });
  for (const slot of slots) {
    if (slot.existing && slot.existing.toLowerCase().endsWith(`.${ext}`)) {
      const snapshot = await guard('Set wallpaper', () => api.fileReplace(slot.existing!, source));
      if (!snapshot) return false;
      applySnapshot(snapshot);
    } else {
      if (slot.existing) {
        const snapshot = await guard('Set wallpaper', () => api.filesDelete([slot.existing!]));
        if (!snapshot) return false;
        applySnapshot(snapshot);
      }
      const response = await guard('Set wallpaper', () => api.filesImport([source], 'wallpaper', 'overwrite', [`${slot.name}.${ext}`]));
      if (!response) return false;
      applySnapshot(response.snapshot);
    }
  }
  toast('success', `Wallpaper set for ${where === 'both' ? 'home and lock screen' : where === 'home' ? 'the home screen' : 'the lock screen'}`);
  return true;
}

export async function closeReference() {
  await guard('Close reference', () => api.referenceClose());
  applyReference(null);
  setState((s) => ({ sideTab: 'files', tabs: s.tabs.filter((t) => t.slot !== 'ref'), activeTab: s.tabs.find((t) => t.id === s.activeTab)?.slot === 'ref' ? null : s.activeTab }));
}

/**
 * "Use" on a store download while no theme is open: the download becomes the
 * theme being worked on. A theme or font package opens as the project; a
 * wallpaper or ringtone starts a new theme that already uses it.
 */
export async function startFromDownload(item: DownloadedTheme) {
  if (item.kind === 'theme' || item.kind === 'font' || item.kind === 'icon') {
    if (!(await openDownloadAsProject(item))) return false;
  } else {
    const snapshot = await guard('New theme', () => api.projectNew(item.name));
    if (!snapshot) return false;
    resetWorkspace(snapshot);
    if (!(await applyDownloadedMedia(item, item.kind === 'wallpaper' ? ['homeWallpaper', 'lockWallpaper'] : ['ringtone']))) return false;
  }
  goTo('design');
  return true;
}

/** Open a downloaded store theme as an editable, untitled project. */
export async function openDownloadAsProject(theme: DownloadedTheme) {
  if (!(await ensureCanDiscard('open another theme'))) return false;
  const snapshot = await guard('Open theme', () => api.storeOpenProject(theme.moduleId), `Opening ${theme.name}…`);
  if (!snapshot) return false;
  resetWorkspace(snapshot);
  toast('success', `Opened “${theme.name}” as a new project. Saving asks where to store your copy.`);
  return true;
}

/** Open a theme cached by Theme Manager on the phone as an editable, untitled project. */
export async function openPhoneThemeAsProject(serial: string, localId: string, title: string) {
  if (!(await ensureCanDiscard('open another theme'))) return false;
  const snapshot = await guard('Open theme', () => api.adbCachedThemeOpen(serial, localId), `Copying ${title} from the phone…`);
  if (!snapshot) return false;
  resetWorkspace(snapshot);
  for (const warning of snapshot.importReport?.warnings ?? []) log('warning', warning);
  toast('success', `Opened “${title}” from the phone as a new project. Saving asks where to store your copy.`);
  return true;
}

const MEDIA_LABELS: Record<MediaTarget, string> = {
  homeWallpaper: 'home screen wallpaper',
  lockWallpaper: 'lock screen wallpaper',
  ringtone: 'ringtone',
  notification: 'notification sound',
  alarm: 'alarm sound',
};

/** Put a downloaded wallpaper or ringtone into the open project. */
export async function applyDownloadedMedia(item: DownloadedTheme, targets: MediaTarget[]) {
  if (!getState().project) {
    toast('warning', 'Open or create a theme first.');
    return false;
  }
  let snapshot: ProjectSnapshot | undefined;
  for (const target of targets) {
    snapshot = await guard('Use download', () => api.storeApplyMedia(item.moduleId, target));
    if (!snapshot) return false;
  }
  if (snapshot) applySnapshot(snapshot);
  toast('success', `“${item.name}” is now the ${targets.map((t) => MEDIA_LABELS[t]).join(' and ')}`, undefined, afterChange(targets.length));
  return true;
}

/** Open a downloaded store theme as the read-only reference package. */
export async function openDownloadAsReference(theme: DownloadedTheme, reveal = true) {
  const current = getState().reference;
  if (current?.sourcePath === theme.path) return current;
  const snapshot = await guard('Open reference', () => api.referenceOpen(theme.path), `Opening ${theme.name}…`);
  if (!snapshot) return null;
  applyReference(snapshot);
  if (reveal) setState((s) => ({ sideTab: 'reference', layout: { ...s.layout, sidebar: true } }));
  return snapshot;
}

export async function copyFromReference(paths: string[], folder: string | null, policy: ConflictPolicy) {
  const response = await guard('Copy from reference', () => api.referenceCopy(paths, folder, policy), 'Copying…');
  if (!response) return false;
  applySnapshot(response.snapshot);
  const { written, skipped, overwritten } = response.result;
  if (written.length) {
    setState({ selection: written, selectionAnchor: written[0] });
    revealInExplorer(written[0]);
  }
  toast('success', `Copied ${plural(written.length, 'file')}${overwritten.length ? ` (${overwritten.length} replaced)` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  return true;
}

// ---------------------------------------------------------------------------
// device / ADB

let adbInFlight = false;
export async function refreshAdb(quiet = true, withVersion = false) {
  if (adbInFlight) return;
  adbInFlight = true;
  if (!quiet) setState({ adbChecking: true });
  try {
    const status = await api.adbStatus(quiet, withVersion);
    setState((s) => {
      const ready = status.devices.filter((d) => d.state === 'device');
      let selectedSerial = s.selectedSerial;
      if (!selectedSerial || !status.devices.some((d) => d.serial === selectedSerial)) {
        selectedSerial = (ready[0] ?? status.devices[0])?.serial ?? null;
      }
      const version = status.version ?? s.adb?.version ?? null;
      return { adb: { ...status, version }, selectedSerial };
    });
    const { selectedSerial, deviceDetails, adb } = getState();
    const device = adb?.devices.find((d) => d.serial === selectedSerial);
    if (device?.state === 'device' && !deviceDetails[device.serial]) void loadDeviceDetails(device.serial);
  } catch (error) {
    if (!quiet) toast('error', `ADB: ${errorMessage(error)}`);
  } finally {
    adbInFlight = false;
    setState({ adbChecking: false });
  }
}

export async function loadDeviceDetails(serial: string) {
  try {
    const details = await api.adbDetails(serial);
    setState((s) => ({ deviceDetails: { ...s.deviceDetails, [serial]: details } }));
  } catch (error) {
    log('error', `Device details: ${errorMessage(error)}`);
  }
}

export function selectDevice(serial: string) {
  setState({ selectedSerial: serial });
  const device = getState().adb?.devices.find((d) => d.serial === serial);
  if (device?.state === 'device' && !getState().deviceDetails[serial]) void loadDeviceDetails(serial);
}

export function readyDevice() {
  const { adb, selectedSerial } = getState();
  const device = adb?.devices.find((d) => d.serial === selectedSerial);
  return device?.state === 'device' ? device : null;
}

export const operations = new Map<string, string>();

export async function captureScreenshot(quiet = false) {
  const device = readyDevice();
  if (!device) {
    if (!quiet) toast('warning', 'Connect and authorize a device to capture a screenshot.');
    return null;
  }
  const details = getState().deviceDetails[device.serial];
  const opId = newOpId('shot');
  operations.set(opId, 'Capturing screenshot');
  setState({ busy: quiet ? getState().busy : 'Capturing screenshot…' });
  try {
    const shot = await api.adbScreenshot(device.serial, details?.marketName ?? details?.model ?? device.model, opId);
    setState((s) => ({ screenshots: [...s.screenshots.filter((x) => x.id !== shot.id), shot].slice(-12) }));
    if (!quiet) log('success', `Screenshot captured (${shot.width}×${shot.height})`);
    return shot;
  } catch (error) {
    if (errorCode(error) !== 'cancelled') toast('error', `Screenshot: ${errorMessage(error)}`);
    else log('info', 'Screenshot cancelled');
    return null;
  } finally {
    operations.delete(opId);
    if (!quiet) setState({ busy: null });
  }
}

export async function cancelOperations() {
  for (const opId of operations.keys()) await api.adbCancel(opId).catch(() => false);
}

export async function saveScreenshot(id: number) {
  const target = await saveDialog({ title: 'Save screenshot', defaultPath: `screenshot-${id}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (!target) return;
  const ok = await guard('Save screenshot', () => api.screenshotSave(id, target).then(() => true));
  if (ok) toast('success', 'Screenshot saved');
}

export async function restartAdb() {
  setState({ adbChecking: true });
  const status = await guard('Restart ADB', () => api.adbRestartServer());
  setState({ adbChecking: false });
  if (status) {
    setState({ adb: status });
    toast('success', 'ADB server restarted');
  }
}

export async function chooseAdbPath() {
  const picked = await openDialog({ title: 'Locate adb.exe', multiple: false, directory: false, filters: [{ name: 'adb', extensions: ['exe'] }] });
  if (!picked || Array.isArray(picked)) return;
  const settings = await guard('Settings', () => api.settingsUpdate({ adbPath: picked }));
  if (settings) {
    setState({ settings });
    await refreshAdb(false, true);
  }
}

export async function resetAdbPath() {
  const settings = await guard('Settings', () => api.settingsUpdate({ adbPath: null }));
  if (settings) {
    setState({ settings });
    await refreshAdb(false, true);
  }
}

export async function sendToDevice() {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a package and connect an authorized device first.');
    return;
  }
  if (!(await applyAllDrafts())) return;
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `Copy package to ${name}?`,
    message:
      'The current package state is exported and copied to the phone’s shared storage. Nothing is installed or applied, and your active theme is not changed.',
    detail: [
      `Destination: /sdcard/Download/MiThemeStudio/`,
      `Package: ${project.name} (${plural(project.files.length, 'file')})`,
      'The copy is verified by comparing file sizes on both sides.',
      'To try the theme, open the file from Theme Manager or a file manager on the phone.',
    ],
    confirmLabel: 'Copy to device',
  });
  if (!ok) return;
  const opId = newOpId('send');
  operations.set(opId, 'Sending package');
  setState({ busy: 'Copying package to device…' });
  try {
    const result = await api.adbSendPackage(device.serial, opId);
    toast('success', `Copied to ${result.push.remotePath} · ${formatBytes(result.push.bytes)} · size verified`);
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Send cancelled');
    else toast('error', `Send to device: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null, exportProgress: null });
  }
}

/** Put the theme into Theme Manager's library on the phone (My themes) without applying it. */
export async function addToThemeManager() {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a theme and connect an authorized phone first.');
    return;
  }
  if (getState().busy) return;
  if (!(await applyAllDrafts())) return;
  const opId = newOpId('addtm');
  operations.set(opId, 'Adding to Theme Manager');
  setState({ busy: 'Adding the theme to Theme Manager…' });
  try {
    const result = await api.adbAddToThemeManager(device.serial, opId);
    for (const step of result.steps) log('info', `Add to Theme Manager: ${step}`);
    toast('success', `“${project.title}” is in Theme Manager on the phone, with its page open. Mixes of parts already licensed on the phone apply; edited parts still need a Xiaomi licence.`);
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Add to Theme Manager cancelled');
    else toast('error', `Add to Theme Manager: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null, exportProgress: null });
  }
}

const TRY_ON_OK_KEY = 'mts.tryOnConfirmed';
export const TRY_ON_BUSY = 'Applying the theme on the phone…';

/**
 * Try on phone: export the theme, add it to Theme Manager's library on the
 * phone and press Apply there, so the phone switches to it right away.
 */
// Whether each phone grants root (asked once per connection; su can take a moment).
const rootedPhones = new Map<string, boolean>();
export async function phoneIsRooted(serial: string) {
  if (rootedPhones.has(serial)) return rootedPhones.get(serial)!;
  try {
    const support = await api.adbThemeSupport(serial);
    rootedPhones.set(serial, !!support.rooted);
    return !!support.rooted;
  } catch {
    return false;
  }
}
const ROOT_APPLY_OK_KEY = 'mts.rootApply.ok.v1';

/**
 * Revert Theme Manager to its factory build, which still carries the editor
 * apply entry point on affected global builds. No root and no APK patching:
 * the package manager removes the update, so the system-partition build runs.
 */
export async function prepareThemeManager(): Promise<ThemeManagerSupport | null> {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return null;
  }
  if (getState().busy) return null;
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `Enable non-root one-click apply on ${name}?`,
    message: 'Theme Manager’s app data will be cleared. Imported themes, downloaded themes and their list in Themes → My themes are removed from the phone. Store purchases stay on your Xiaomi account and can be downloaded again.',
    detail: [
      'Why: this phone’s Theme Manager update removed the editor apply entry point. Removing the update restores the factory build, which can apply a theme directly, and Android clears an app’s data when it removes an update.',
      'No root and no APK patching: Android’s package manager reverts Theme Manager to the build already in the system partition.',
      'Your theme projects on this PC are not affected.',
      'The store can update Theme Manager again later, which removes one-click apply until you prepare it again.',
      'Apply only themes you created or have the rights to use.',
    ],
    confirmLabel: 'Clear data and prepare',
    danger: true,
  });
  if (!ok) return null;
  const opId = newOpId('prepare-tm');
  operations.set(opId, 'Preparing Theme Manager');
  setState({ busy: 'Preparing Theme Manager on the phone…' });
  try {
    const result = await api.adbPrepareThemeManager(device.serial, opId);
    for (const step of result.steps) log('info', `Theme Manager: ${step}`);
    if (!result.changed) toast('success', 'Theme Manager already has the editor apply entry point.');
    else toast('success', `Theme Manager ${result.beforeVersion ?? ''} → ${result.support.version ?? 'factory build'}: one-click apply is ready.`);
    return result.support;
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Preparing Theme Manager cancelled');
    else toast('error', `Prepare Theme Manager: ${errorMessage(error)}`);
    return null;
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}

/**
 * Non-root keep-alive: a detached shell loop on the phone reapplies the staged
 * theme when the framework's 2-hour DRM check changes /data/system/theme.
 * True permanence would need the system check disabled (root/framework patch).
 */
export async function keepThemeApplied(enabled: boolean): Promise<boolean | null> {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return null;
  }
  if (getState().busy) return null;
  if (enabled) {
    const ok = await confirmDialog({
      title: 'Keep the theme applied without root?',
      message: 'Android’s theme framework re-checks the theme about every two hours and restores the default when the package has no Xiaomi-signed licence. This starts a small shell loop on the phone that reapplies the theme after each reset.',
      detail: [
        'The loop runs as the adb shell user; it needs no root and survives an adb disconnect.',
        'A reboot stops the loop, and the theme can be reset once after boot until you enable it again.',
        'Reapply happens within about 30 seconds of the check, so the default theme may show briefly.',
        'It also reapplies after you intentionally change themes; stop it first when switching.',
      ],
      confirmLabel: 'Keep applied',
      danger: true,
    });
    if (!ok) return null;
  }
  const opId = newOpId('keep-alive');
  operations.set(opId, enabled ? 'Starting keep-alive' : 'Stopping keep-alive');
  setState({ busy: enabled ? 'Staging the theme and starting the keep-alive loop…' : 'Stopping the keep-alive loop…' });
  try {
    const result = await api.adbKeepThemeApplied(device.serial, enabled, opId);
    for (const step of result.steps) log('info', `Keep applied: ${step}`);
    toast('success', enabled ? 'Keep-alive started. The theme will be reapplied after the periodic check.' : 'Keep-alive stopped.');
    return result.running;
  } catch (error) {
    toast('error', `Keep applied: ${errorMessage(error)}`);
    return null;
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}

/** The permanent (AOD) apply warning; true when the person accepts it. */
export async function confirmPermanentApply(): Promise<boolean> {
  const device = readyDevice();
  const project = getState().project;
  const details = device ? getState().deviceDetails[device.serial] : undefined;
  const name = details?.marketName ?? details?.model ?? device?.model ?? device?.serial ?? 'the phone';
  const title = project?.title ?? 'the theme';
  return confirmDialog({
    title: `Make “${title}” permanent on ${name}?`,
    message:
      'This uses the AOD/System UI MAML vulnerability to write the theme and a sticky boot-animation blocker into /data/system/theme. The framework’s 2-hour licence check then hangs instead of restoring the default theme.',
    detail: [
      'No root and no APK patching. It needs USB debugging, the AOD provider, and always-on display enabled.',
      'On builds with the editor entry point, Theme Manager applies the real files first. On 3.0.5.19 the AOD/System UI path copies theme files, sets the wallpaper, triggers the framework theme reload, restarts System UI/launcher, and installs the sticky blocker. Its icon-generation call does not reliably populate the customized icon cache, and the launcher home-clock cache may remain stock.',
      'On the test phone, the verified non-root route for lock screen, icons and home clock is to apply with Theme Manager 3.0.5.16, update to 3.0.5.19, and not reapply. A clean .19 AOD apply has only confirmed theme files, wallpaper and lock screen.',
      'The screen turns off and on once to run the AOD manifest. System UI and the launcher restart, so the phone may flicker for a few seconds.',
      'AOD is left on the maml category. The validation worker may stay stuck, and normal theme cleanup may restore some parts; AOD recreates the blocker on screen off/on.',
      'Use “Remove AOD blocker” to undo the blocker and restore the AOD category. Your next theme apply is the normal way to change themes.',
      'This is invasive. Only use it with themes you own or have permission to use.',
    ],
    confirmLabel: 'Make permanent',
    danger: true,
  });
}

/** Tick or untick the “Permanent apply (AOD)” box on Try on phone. Ticking asks first. */
export async function setPermanentApply(on: boolean) {
  if (on && !(await confirmPermanentApply())) return;
  setState({ permanentApply: on });
}

/** Try on phone, honouring the permanent (AOD) box. */
export async function tryOnOrPermanent() {
  const device = readyDevice();
  if (getState().permanentApply && device && !(await phoneIsRooted(device.serial))) return applyThemePermanently(true);
  return tryOnPhone();
}

/**
 * Make the open theme permanent without root.
 *
 * On builds with the editor entry point Theme Manager copies the real files
 * first. On builds without it, the AOD/System UI MAML path copies the real
 * files from /data/local/tmp, sets the wallpaper, reloads the theme, and
 * restarts System UI/launcher. Both finish with a sticky boot-animation
 * symlink that blocks the framework's 2-hour DRM validation.
 */
export async function applyThemePermanently(confirmed = false) {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a theme and connect an authorized phone first.');
    return;
  }
  if (getState().busy) return;
  if (!(await applyAllDrafts())) return;
  if (!confirmed && !(await confirmPermanentApply())) return;
  const opId = newOpId('permanent-apply');
  operations.set(opId, 'Making the theme permanent');
  setState({ busy: 'Applying the theme permanently…' });
  try {
    const result = await api.adbApplyThemePermanent(device.serial, opId, true);
    for (const step of result.steps) log('info', `Permanent: ${step}`);
    toast(
      result.blockerVerified ? 'success' : 'warning',
      result.blockerVerified
        ? `Permanent blocker verified (${result.mode === 'themeManagerAod' ? 'Theme Manager + AOD' : result.mode === 'aodFull' ? 'AOD full apply' : 'AOD blocker'}).`
        : 'The theme was written but the blocker could not be verified. Enable always-on display and try again.',
    );
    if (result.mode === 'aodFull') {
      const reboot = await confirmDialog({
        title: 'Reboot to activate the lock screen?',
        message:
          'The theme files and wallpaper are written, and the MAML lockscreen files are installed. The lock wallpaper service only reloads lock.xml at startup, so the themed lockscreen appears after a reboot. On a clean 3.0.5.19 AOD apply, home icons and the clock may remain stock because the launcher caches are not reliably prepared.',
        detail: [
          'The phone will disconnect from ADB while it restarts.',
          'Reconnect USB after boot; the sticky blocker and applied theme persist.',
        ],
        confirmLabel: 'Reboot phone',
        danger: true,
      });
      if (reboot) {
        try {
          await api.adbReboot(device.serial);
          toast('success', 'Rebooting the phone. Reconnect USB after it starts.');
        } catch (error) {
          toast('error', `Reboot failed: ${errorMessage(error)}`);
        }
      }
    }
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Permanent apply cancelled');
    else toast('error', `Permanent apply: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null, exportProgress: null });
  }
}

/** Remove the sticky AOD blocker and restore the normal AOD category. */
export async function restoreAodChanges(): Promise<boolean | null> {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return null;
  }
  if (getState().busy) return null;
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `Remove the AOD blocker on ${name}?`,
    message:
      'This asks AOD to remove the sticky boot-animation blocker and restores the AOD category to sun. The current theme files are left in place; apply another theme normally afterwards.',
    detail: [
      'The framework’s next 2-hour check can then run again and may restore the default theme if it has no licence.',
      'If the blocker path still exists, the same AOD/theme cleanup can be run again or you can re-apply a theme.',
    ],
    confirmLabel: 'Remove blocker',
    danger: true,
  });
  if (!ok) return null;
  const opId = newOpId('restore-aod');
  operations.set(opId, 'Removing the AOD blocker');
  setState({ busy: 'Removing the AOD blocker…' });
  try {
    const result = await api.adbRestoreAod(device.serial, opId);
    for (const step of result.steps) log('info', `AOD restore: ${step}`);
    toast('success', result.blockerRemoved ? 'AOD blocker removed.' : 'AOD settings restored; the blocker may still need cleanup.');
    return result.blockerRemoved;
  } catch (error) {
    toast('error', `Remove AOD blocker: ${errorMessage(error)}`);
    return null;
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}

/**
 * Install a Xiaomi-signed Theme Manager APK as an update. This is the fallback
 * for phones whose factory build has no editor apply entry point and whose
 * 3.0.5.19 cannot be removed with `pm uninstall-system-updates`.
 */
export async function installThemeManagerApk(): Promise<ThemeManagerSupport | null> {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return null;
  }
  if (getState().busy) return null;
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: 'Theme Manager APK', extensions: ['apk'] }],
  });
  if (!picked || Array.isArray(picked)) return null;
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `Install a Theme Manager APK on ${name}?`,
    message: 'Android will install the APK as an update. The OEM signature must match. A lower version cannot replace a factory system app, so this only helps with a same-version or newer build.',
    detail: [
      'Use a Xiaomi-signed Theme Manager build from the same model/region.',
      'A preinstalled 3.0.5.19 cannot be downgraded this way; Android rejects the version downgrade even with the downgrade flag.',
      'Theme Manager data is normally preserved, but back up anything important first.',
      'Do not install an APK you do not trust: it runs with Theme Manager’s system-shared uid.',
    ],
    confirmLabel: 'Install APK',
    danger: true,
  });
  if (!ok) return null;
  const opId = newOpId('install-tm');
  operations.set(opId, 'Installing Theme Manager');
  setState({ busy: 'Installing the Theme Manager APK…' });
  try {
    const support = await api.adbInstallThemeManagerApk(device.serial, picked, opId);
    toast('success', `Theme Manager ${support.version ?? ''} installed; one-click apply is ready.`);
    return support;
  } catch (error) {
    toast('error', `Install Theme Manager: ${errorMessage(error)}`);
    return null;
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}

export async function tryOnPhone(force = false) {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a theme and connect an authorized phone first.');
    return;
  }
  if (getState().busy) return;
  if (!(await applyAllDrafts())) return;
  const compat = await themeCompatibility();
  if (compat && !compat.supported && !force) {
    const go = await confirmDialog({
      title: 'This theme is newer than the phone',
      message: compat.detail,
      detail: [
        'The phone renders an older MIUI/HyperOS theme format: newer icons, system UI, lock screen or font parts may be refused or render wrong.',
        'Theme Manager still applies what it can; you can usually go back from Themes → My themes on the phone.',
      ],
      confirmLabel: 'Apply anyway',
      danger: true,
    });
    if (!go) return;
  }
  if (await phoneIsRooted(device.serial)) {
    let ok = false;
    try {
      ok = localStorage.getItem(ROOT_APPLY_OK_KEY) === '1';
    } catch {
      /* ignore */
    }
    return applyWithRoot(ok, true);
  }
  if (force) {
    const ok = await confirmDialog({
      title: `Force apply every part of “${project.title}”?`,
      message: 'The staged copy is marked with the newest theme format this phone renders, so Theme Manager stops skipping parts that need a newer uiVersion than the theme declares.',
      detail: [
        'Parts built for another format (system UI, Settings, lock screen, fonts) may be copied even if this phone does not understand them; they can render wrong or cause UI glitches.',
        'The project file is not modified — only the copy sent to the phone is changed.',
        'Use Themes → My themes on the phone to go back to another theme.',
      ],
      confirmLabel: 'Force apply',
      danger: true,
    });
    if (!ok) return;
  }
  let confirmed = force;
  try {
    confirmed = localStorage.getItem(TRY_ON_OK_KEY) === '1';
  } catch {
    /* ignore */
  }
  if (!confirmed) {
    const details = getState().deviceDetails[device.serial];
    const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
    const ok = await confirmDialog({
      title: `Try “${project.title}” on ${name}?`,
      message: 'The theme is added to Theme Manager on the phone and applied right away, as if you had pressed Apply there.',
      detail: [
        'No root is used. Theme Manager does the applying.',
        'Each try replaces the previous one, so Theme Manager keeps only your latest try-on.',
        'To go back, pick another theme in Theme Manager → My themes.',
        'Keep the phone unlocked while it applies.',
      ],
      confirmLabel: 'Try on phone',
    });
    if (!ok) return;
    try {
      localStorage.setItem(TRY_ON_OK_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  const opId = newOpId('tryon');
  operations.set(opId, 'Trying on phone');
  setState({ busy: TRY_ON_BUSY });
  try {
    const result = await api.adbTryOn(device.serial, opId, force);
    for (const step of result.steps) log('info', `Try on: ${step}`);
    if (result.applied) {
      toast('success', `“${project.title}” is now on the phone (${plural(result.parts.length, 'part')})`);
      // Without a live mirror, refresh the phone screenshot so the result shows here.
      if (useMirrorStream.getState().status !== 'live') {
        await new Promise((r) => setTimeout(r, 1500));
        await captureScreenshot();
      }
    }
    else toast('warning', 'The theme is open in Theme Manager on the phone. Tap Apply there to finish.');
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Try on cancelled');
    else if (errorCode(error) === 'license') {
      log('warning', `Try on: ${errorMessage(error)}`);
      // A rooted phone can take the same theme through /data/system/theme,
      // where Theme Manager's licence check does not exist.
      const support = await api.adbThemeSupport(device.serial).catch(() => null);
      const choice = await choiceDialog({
        title: 'Theme Manager needs a Xiaomi licence for this theme',
        message:
          'Theme Manager applies a part only when a Xiaomi-signed licence covering its exact bytes is on the phone. Try on phone reuses those licences, so a mix of unmodified store parts applies; parts you edited or added have none, and Xiaomi only signs store packages — that is the “downloadRight|413” error. Apply the source theme or font in Theme Manager once to licence its parts, keep your own artwork to wallpapers and sounds — or, on a rooted phone, write the theme straight into /data/system/theme.',
        choices: support?.rooted
          ? [
              { id: 'root', label: 'Apply with root instead', primary: true },
              { id: 'ok', label: 'OK' },
            ]
          : [{ id: 'ok', label: 'OK', primary: true }],
      });
      if (choice === 'root') await applyWithRoot(true);
    } else toast('error', `Try on phone: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null, exportProgress: null });
  }
}

// ---------------------------------------------------------------------------
// licences

/** Whether the open theme targets a newer format than the connected phone. */
export async function themeCompatibility() {
  const device = readyDevice();
  if (!device) return null;
  try {
    return await api.themeCompatibility(device.serial);
  } catch {
    return null;
  }
}

/** Per-part verdict: what Theme Manager will accept on this phone right now. */
export async function checkLicences() {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a theme and connect an authorized phone first.');
    return;
  }
  if (getState().busy) return;
  if (!(await applyAllDrafts())) return;
  setState({ busy: 'Checking licences on the phone…' });
  try {
    const report = await api.adbLicenceReport(device.serial);
    const mark = (s: string) => (s === 'missing' ? '✗' : s === 'free' ? '–' : '✓');
    const detail = report.parts.map((p) => `${mark(p.status)} ${p.code} — ${p.status === 'missing' ? 'no licence on this phone (will get 413)' : p.status === 'free' ? 'free (wallpaper or sound)' : 'licensed'}`);
    const message =
      report.missing === 0
        ? `Every part is covered: ${report.licensed} licensed, ${report.free} free. Try on phone will apply this theme.`
        : `${report.missing} part${report.missing === 1 ? '' : 's'} have no licence on this phone and will be refused with 413. Apply the store theme or font they come from on the phone once (Device → License downloads on phone), or replace them with licensed parts.`;
    await confirmDialog({ title: `Licences for “${project.title}”`, message, detail, confirmLabel: 'OK' });
  } catch (error) {
    toast('error', `Licence check: ${errorMessage(error)}`);
  } finally {
    setState({ busy: null });
  }
}

/** Applies each downloaded store theme/font once so its parts become reusable. */
export async function licenseDownloadsOnPhone() {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return;
  }
  if (getState().busy) return;
  let items: Awaited<ReturnType<typeof api.storeDownloads>>;
  try {
    items = await api.storeDownloads();
  } catch (error) {
    toast('error', `Downloads: ${errorMessage(error)}`);
    return;
  }
  items = items.filter((d) => d.kind === 'theme' || d.kind === 'font' || d.kind === 'icon');
  if (!items.length) {
    toast('warning', 'Download some themes or fonts in the Store first.');
    return;
  }
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `License ${items.length} downloaded item${items.length === 1 ? '' : 's'} on ${name}?`,
    message: 'Each item is opened in Theme Manager and applied once, so Theme Manager stores a Xiaomi licence for its parts. Afterwards those parts can be mixed into any theme. Your active theme changes while this runs.',
    detail: [
      ...items.slice(0, 8).map((d) => `${d.kind === 'font' ? 'Font' : d.kind === 'icon' ? 'Icons' : 'Theme'}: ${d.name}`),
      ...(items.length > 8 ? [`…and ${items.length - 8} more`] : []),
      'Keep the phone unlocked and on the home screen.',
    ],
    confirmLabel: 'License them',
  });
  if (!ok) return;
  const opId = newOpId('license');
  operations.set(opId, 'Licensing downloads');
  setState({ busy: 'Licensing downloaded items on the phone…' });
  try {
    const results = await api.adbLicenseDownloads(device.serial, opId);
    for (const r of results) log(r.ok ? 'info' : 'warning', `Licence: ${r.name} — ${r.message}`);
    const done = results.filter((r) => r.ok).length;
    await confirmDialog({
      title: 'Licensing finished',
      message: `${done} of ${results.length} item${results.length === 1 ? '' : 's'} are licensed on the phone.${done < results.length ? ' The rest can be applied manually in Theme Manager, then re-checked.' : ''}`,
      detail: results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.message}`),
      confirmLabel: 'OK',
    });
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Licensing cancelled');
    else toast('error', `Licensing: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}

/** Applies the open theme with root: writes its parts into /data/system/theme. */
export async function applyWithRoot(confirmed = false, fromTryOn = false) {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a theme and connect a rooted phone first.');
    return;
  }
  if (getState().busy) return;
  if (!fromTryOn && !(await applyAllDrafts())) return;
  const compat = await themeCompatibility();
  if (!confirmed) {
  const ok = await confirmDialog({
    title: fromTryOn ? `Try “${project.title}” on your rooted phone?` : `Write “${project.title}” into the phone’s theme folder?`,
    message:
      'Root apply copies the theme parts straight into /data/system/theme and restarts SystemUI. Theme Manager’s licence check is not involved, so custom icons, fonts and system UI work — but a part the phone cannot render can leave the interface broken until you restore the backup.',
    detail: [
      compat ? compat.detail : 'The phone did not report a theme format.',
      'Every part is written, including icons, fonts, system UI, the lock screen and both wallpapers. Parts of the previous theme that this one does not have are removed, like a normal theme apply.',
      'The current theme folder and home wallpaper are backed up to /sdcard/MiThemeStudio first; without a backup nothing is changed.',
      'Ringtones are not changed by root apply. Icons, fonts and app styles show after a restart, which you are offered at the end.',
      'Root (su) is used; nothing is uploaded anywhere. If the phone looks wrong afterwards, use Restore theme backup.',
      ...(fromTryOn ? ['This phone is rooted, so Try on phone uses root from now on and skips Theme Manager’s licence check (which fails for edited themes). You will not be asked again; a backup is still made every time.'] : []),
    ],
    confirmLabel: 'Apply with root',
    danger: true,
  });
  if (!ok) return;
  if (fromTryOn) {
    try {
      localStorage.setItem(ROOT_APPLY_OK_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  }
  const opId = newOpId('root');
  operations.set(opId, 'Applying with root');
  setState({ busy: fromTryOn ? TRY_ON_BUSY : 'Writing the theme into /data/system/theme…' });
  try {
    const result = await api.adbRootApply(device.serial, opId);
    for (const step of result.steps) log(result.failed.length ? 'warning' : 'info', `Root apply: ${step}`);
    setState({ busy: null });
    const reboot = result.needsReboot
      ? await confirmDialog({
          title: result.applied ? `“${project.title}” is applied` : `“${project.title}” is partly applied`,
          message: `${result.parts.length} part${result.parts.length === 1 ? '' : 's'} written${result.failed.length ? `; ${result.failed.join(', ')} did not land` : ''}. The lock screen, status bar and wallpapers already show; icons, fonts and app styles appear after the phone restarts.`,
          detail: [...result.steps, ...(result.backup ? [`Backup: ${result.backup}`] : [])],
          confirmLabel: 'Restart phone now',
        })
      : false;
    if (reboot) {
      try {
        await api.adbReboot(device.serial);
        toast('info', 'The phone is restarting. It reconnects here when it is back.');
      } catch (error) {
        toast('error', `Restart: ${errorMessage(error)}`);
      }
    } else if (!result.needsReboot) {
      if (result.applied) toast('success', `“${project.title}” is applied: ${result.parts.length} part${result.parts.length === 1 ? '' : 's'} written. Backup: ${result.backup}`);
      else toast('warning', `Applied, except ${result.failed.join(', ')}. The backup is ${result.backup}; the log has the details.`);
    }
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Root apply cancelled');
    else toast('error', `Root apply: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}
/** Restores a /data/system/theme backup made by Apply with root. */
export async function restoreThemeBackup() {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect a rooted phone first.');
    return;
  }
  if (getState().busy) return;
  let backups: Awaited<ReturnType<typeof api.adbRootBackups>>;
  try {
    backups = await api.adbRootBackups(device.serial);
  } catch (error) {
    toast('error', `Theme backups: ${errorMessage(error)}`);
    return;
  }
  if (!backups.length) {
    toast('warning', 'No theme backups on the phone yet — Apply with root creates one first.');
    return;
  }
  const choice = await choiceDialog({
    title: 'Restore a theme backup',
    message: 'The current /data/system/theme is replaced by the selected backup, then SystemUI restarts. Only backups listed here are used.',
    choices: [
      ...backups.slice(0, 8).map((b) => ({
        id: b.path,
        label: `${b.name} · ${formatBytes(b.bytes)}`,
        primary: false,
      })),
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice === 'cancel') return;
  const picked = backups.find((b) => b.path === choice);
  const ok = await confirmDialog({
    title: `Restore ${picked?.name ?? 'this backup'}?`,
    message: 'This replaces the phone’s whole theme folder with the backup and restarts SystemUI. Nothing else on the phone is touched.',
    detail: [picked ? picked.path : choice, 'Root is used. The current theme folder is not backed up again.'],
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!ok) return;
  const opId = newOpId('restore');
  operations.set(opId, 'Restoring theme backup');
  setState({ busy: 'Restoring the theme backup…' });
  try {
    const steps = await api.adbRootRestore(device.serial, choice);
    for (const step of steps) log('info', `Restore: ${step}`);
    toast('success', 'Theme backup restored.');
  } catch (error) {
    toast('error', `Restore: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null });
  }
}
// ---------------------------------------------------------------------------
// live mirror (bundled scrcpy)

export function mirrorRunning() {
  return !!getState().mirror?.running;
}

export async function refreshMirror() {
  try {
    setState({ mirror: await api.mirrorStatus() });
  } catch {
    /* not available outside the app */
  }
}

export async function startMirror() {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return;
  }
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  setState({ busy: 'Starting screen mirror…' });
  try {
    const status = await api.mirrorStart(device.serial, `${name} · Mi Theme Studio`);
    setState({ mirror: status });
    toast('success', `Mirroring ${name} in a separate window. You can use the phone from there.`);
  } catch (error) {
    toast('error', `Mirror screen: ${errorMessage(error)}`);
  } finally {
    setState({ busy: null });
  }
}

export async function stopMirror() {
  const status = await guard('Stop mirroring', () => api.mirrorStop());
  if (status) setState({ mirror: status });
}

/** Open a store item's page in Theme Manager on the selected phone. */
export async function openStoreItemOnDevice(moduleId: string, name: string) {
  const device = readyDevice();
  if (!device) {
    toast('warning', 'Connect and authorize a phone first.');
    return;
  }
  const ok = await guard('Open on phone', () => api.adbOpenStoreItem(device.serial, moduleId));
  if (ok !== undefined) toast('success', `Opened “${name}” in Theme Manager on the phone`);
}

export async function openThemeSettingsOnDevice() {
  const device = readyDevice();
  if (!device) return;
  const ok = await guard('Open Theme Manager', () => api.adbOpenThemeSettings(device.serial));
  if (ok !== undefined) toast('success', 'Opened Theme Manager on the phone');
}

/**
 * Apply the open project on the phone through Theme Manager's editor entry
 * point (only offered when the phone supports it), then capture a screenshot
 * so the result can be checked.
 */
export async function applyOnDevice(force = false) {
  const device = readyDevice();
  const project = getState().project;
  if (!device || !project) {
    toast('warning', 'Open a package and connect an authorized device first.');
    return;
  }
  if (!(await applyAllDrafts())) return;
  const details = getState().deviceDetails[device.serial];
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const ok = await confirmDialog({
    title: `Apply “${project.title}” on ${name}?`,
    message: 'The current package is exported, copied to the phone and handed to Theme Manager, which applies it as the active theme.',
    detail: [
      'This uses the same entry point as Xiaomi’s desktop theme editor. No root is used and no system settings are changed.',
      ...(force ? ['Force apply rewrites the staged copy’s uiVersion so Theme Manager copies every part, including ones built for another format.'] : []),
      'To go back, pick your previous theme in Theme Manager → My themes (it stays installed).',
      'A screenshot is taken afterwards so you can check the result.',
    ],
    confirmLabel: 'Apply on phone',
  });
  if (!ok) return;
  const opId = newOpId('apply');
  operations.set(opId, 'Applying on phone');
  setState({ busy: 'Applying theme on the phone…' });
  try {
    const result = await api.adbApplyTheme(device.serial, opId, force);
    for (const step of result.steps) log('info', `Apply: ${step}`);
    toast('success', `Sent to Theme Manager (${formatBytes(result.bytes)}). Check the phone.`);
    await new Promise((r) => setTimeout(r, 2500));
    const shot = await captureScreenshot();
    if (shot) openSingleton('preview');
  } catch (error) {
    if (errorCode(error) === 'cancelled') log('info', 'Apply cancelled');
    else toast('error', `Apply on phone: ${errorMessage(error)}`);
  } finally {
    operations.delete(opId);
    setState({ busy: null, exportProgress: null });
  }
}

// ---------------------------------------------------------------------------
// settings & recovery

export async function updateSettings(patch: Parameters<typeof api.settingsUpdate>[0]) {
  const settings = await guard('Settings', () => api.settingsUpdate(patch));
  if (settings) setState({ settings });
}

export async function autosaveTick() {
  const { project, settings } = getState();
  if (!project?.dirty || !settings?.autosaveEnabled) return;
  try {
    const info = await api.autosave();
    if (info) setState({ lastAutosave: info });
  } catch (error) {
    log('warning', `Autosave failed: ${errorMessage(error)}`);
  }
}

export async function restoreRecovery() {
  if (!(await ensureCanDiscard('restore the recovery copy'))) return;
  const snapshot = await guard('Restore', () => api.recoveryRestore(), 'Restoring…');
  setState({ recoveryOffer: null });
  if (snapshot) {
    resetWorkspace(snapshot);
    toast('success', `Restored unsaved work for “${snapshot.title}”. Save to keep it.`);
  }
}

export async function discardRecovery() {
  await guard('Discard recovery', () => api.recoveryDiscard());
  setState({ recoveryOffer: null });
}
