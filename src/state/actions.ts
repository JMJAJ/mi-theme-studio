// Application actions: every user operation goes through here so errors,
// logging, toasts and snapshot updates are handled consistently.
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api, errorCode, errorMessage, newOpId } from '../lib/api';
import { fileName, joinPath, parentOf, validateName } from '../lib/paths';
import type { AdbLogEntry, ConflictPolicy, DownloadedTheme, MediaTarget, ExportProgress, ProjectSnapshot, SaveResult, Slot } from '../lib/types';
import { formatBytes, plural } from '../lib/format';
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
  type Tab,
  type TabKind,
  toast,
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

export function openSingleton(kind: TabKind) {
  openTab({ id: kind, kind, title: SINGLETON_TITLES[kind] ?? kind });
}

export function openComponent(id: string) {
  const def = getState().project?.components.find((c) => c.id === id);
  openTab({ id: `component:${id}`, kind: 'component', component: id, title: def?.label ?? id });
}

let revealNonce = 0;
/** Open a file and select a range in its text editor. */
export function revealInFile(path: string, line: number, column: number, length: number) {
  openFile(path);
  setState({ reveal: { path, line, column, length, nonce: ++revealNonce } });
}

export function openFile(path: string, slot: Slot = 'main') {
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
  if (snapshot) {
    resetWorkspace(snapshot);
    toast('success', `Created “${snapshot.title}”. Save it to choose a file location.`);
  }
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

export async function historyGoto(id: number | null) {
  const snapshot = await guard('History', () => api.historyGoto(id));
  if (snapshot) applySnapshot(snapshot);
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

export async function openReference() {
  const picked = await openDialog({ title: 'Open reference package (read-only)', multiple: false, directory: false, filters: PACKAGE_FILTERS });
  if (!picked || Array.isArray(picked)) return;
  const snapshot = await guard('Open reference', () => api.referenceOpen(picked), 'Opening reference…');
  if (snapshot) {
    applyReference(snapshot);
    setState((s) => ({ sideTab: 'reference', layout: { ...s.layout, sidebar: true } }));
    toast('success', `Reference “${snapshot.title}” opened read-only`);
  }
}

export async function closeReference() {
  await guard('Close reference', () => api.referenceClose());
  applyReference(null);
  setState((s) => ({ sideTab: 'files', tabs: s.tabs.filter((t) => t.slot !== 'ref'), activeTab: s.tabs.find((t) => t.id === s.activeTab)?.slot === 'ref' ? null : s.activeTab }));
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
  toast('success', `“${item.name}” is now the ${targets.map((t) => MEDIA_LABELS[t]).join(' and ')}`);
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
