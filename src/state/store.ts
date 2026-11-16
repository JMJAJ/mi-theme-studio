import { create } from 'zustand';
import type {
  AdbLogEntry,
  AdbStatus,
  AppInfo,
  DeviceDetails,
  ExportProgress,
  FileInfo,
  ProjectSnapshot,
  RecoveryInfo,
  SaveResult,
  ScreenshotInfo,
  Settings,
  Slot,
  ConflictPolicy,
  ValidationReport,
} from '../lib/types';

export type TabKind = 'dashboard' | 'info' | 'component' | 'file' | 'preview' | 'device' | 'build' | 'roadmap' | 'catalog';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  path?: string;
  slot?: Slot;
  component?: string;
}

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  id: number;
  atMs: number;
  level: LogLevel;
  message: string;
  detail?: string;
}

export interface Toast {
  id: number;
  level: LogLevel;
  message: string;
}

export interface Draft {
  text: string;
  baseRev: number;
  original: string;
}

export interface BuildRecord extends Omit<SaveResult, 'snapshot'> {
  atMs: number;
}

export type DockTab = 'problems' | 'output' | 'adb' | 'build' | 'history';
export type SideTab = 'files' | 'search' | 'reference';

/** A text range to select once its file is open in an editor. */
export interface Reveal {
  path: string;
  line: number;
  column: number;
  length: number;
  nonce: number;
}

export interface Layout {
  sidebar: boolean;
  inspector: boolean;
  dock: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  dockHeight: number;
  navHeight: number;
}

const LAYOUT_KEY = 'mts.layout.v1';
export const DEFAULT_LAYOUT: Layout = {
  sidebar: true,
  inspector: true,
  dock: true,
  sidebarWidth: 320,
  inspectorWidth: 340,
  dockHeight: 210,
  navHeight: 300,
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

export function persistLayout(layout: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

// ---- dialogs (promise based) ----

export type DialogState =
  | {
      type: 'confirm';
      title: string;
      message: string;
      detail?: string[];
      confirmLabel: string;
      danger?: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      type: 'prompt';
      title: string;
      message?: string;
      label: string;
      initial: string;
      confirmLabel: string;
      validate?: (value: string) => string | null;
      selectStem?: boolean;
      resolve: (value: string | null) => void;
    }
  | {
      type: 'choice';
      title: string;
      message: string;
      choices: { id: string; label: string; primary?: boolean; danger?: boolean }[];
      resolve: (value: string) => void;
    }
  | { type: 'copyPlan'; paths: string[]; policy?: ConflictPolicy; title?: string }
  | { type: 'settings' }
  | { type: 'shortcuts' }
  | { type: 'about' }
  | { type: 'move'; paths: string[] };

export interface StoreState {
  appInfo: AppInfo | null;
  settings: Settings | null;
  project: ProjectSnapshot | null;
  fileIndex: Map<string, FileInfo>;
  reference: ProjectSnapshot | null;
  refIndex: Map<string, FileInfo>;
  tabs: Tab[];
  activeTab: string | null;
  selection: string[];
  selectionAnchor: string | null;
  refSelection: string[];
  drafts: Record<string, Draft>;
  expanded: Set<string>;
  refExpanded: Set<string>;
  layout: Layout;
  dockTab: DockTab;
  sideTab: SideTab;
  reveal: Reveal | null;
  validation: ValidationReport | null;
  validating: boolean;
  logs: LogEntry[];
  toasts: Toast[];
  adb: AdbStatus | null;
  adbChecking: boolean;
  selectedSerial: string | null;
  deviceDetails: Record<string, DeviceDetails>;
  screenshots: ScreenshotInfo[];
  adbLog: AdbLogEntry[];
  exportProgress: ExportProgress | null;
  builds: BuildRecord[];
  busy: string | null;
  lastAutosave: RecoveryInfo | null;
  recoveryOffer: RecoveryInfo | null;
  dialog: DialogState | null;
  palette: null | 'commands' | 'files';
}

let idCounter = 0;
export const nextId = () => ++idCounter;

export const useStore = create<StoreState>(() => ({
  appInfo: null,
  settings: null,
  project: null,
  fileIndex: new Map(),
  reference: null,
  refIndex: new Map(),
  tabs: [],
  activeTab: null,
  selection: [],
  selectionAnchor: null,
  refSelection: [],
  drafts: {},
  expanded: new Set(),
  refExpanded: new Set(),
  layout: loadLayout(),
  dockTab: 'problems',
  sideTab: 'files',
  reveal: null,
  validation: null,
  validating: false,
  logs: [],
  toasts: [],
  adb: null,
  adbChecking: false,
  selectedSerial: null,
  deviceDetails: {},
  screenshots: [],
  adbLog: [],
  exportProgress: null,
  builds: [],
  busy: null,
  lastAutosave: null,
  recoveryOffer: null,
  dialog: null,
  palette: null,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

// ---- logging & toasts ----

export function log(level: LogLevel, message: string, detail?: string) {
  const entry: LogEntry = { id: nextId(), atMs: Date.now(), level, message, detail };
  setState((s) => ({ logs: [...s.logs.slice(-499), entry] }));
}

export function toast(level: LogLevel, message: string, detail?: string) {
  log(level, message, detail);
  const id = nextId();
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, message }] }));
  window.setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 7000 : 3800);
}

// ---- dialogs ----

export function confirmDialog(options: Omit<Extract<DialogState, { type: 'confirm' }>, 'type' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => setState({ dialog: { type: 'confirm', ...options, resolve } }));
}

export function promptDialog(options: Omit<Extract<DialogState, { type: 'prompt' }>, 'type' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => setState({ dialog: { type: 'prompt', ...options, resolve } }));
}

export function choiceDialog(options: Omit<Extract<DialogState, { type: 'choice' }>, 'type' | 'resolve'>): Promise<string> {
  return new Promise((resolve) => setState({ dialog: { type: 'choice', ...options, resolve } }));
}

export function closeDialog() {
  setState({ dialog: null });
}

// ---- layout ----

export function updateLayout(patch: Partial<Layout>) {
  setState((s) => {
    const layout = { ...s.layout, ...patch };
    persistLayout(layout);
    return { layout };
  });
}

// ---- derived helpers ----

export function indexFiles(snapshot: ProjectSnapshot | null): Map<string, FileInfo> {
  return new Map((snapshot?.files ?? []).map((f) => [f.path, f]));
}

export function pathExists(snapshot: ProjectSnapshot | null, index: Map<string, FileInfo>, path: string): boolean {
  if (!snapshot) return false;
  if (index.has(path)) return true;
  if (snapshot.containers.some((c) => c.name === path)) return true;
  const prefix = path.endsWith('!/') || path.endsWith('/') ? path : `${path}/`;
  return snapshot.files.some((f) => f.path.startsWith(prefix));
}

export function hasUnsavedWork(state: StoreState = getState()): boolean {
  return !!state.project?.dirty || Object.keys(state.drafts).length > 0;
}
