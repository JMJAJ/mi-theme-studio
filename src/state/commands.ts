// Every user-facing command, used by the menu bar, the command palette and
// keyboard shortcuts, so enablement and labels stay consistent.
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  FileArchive,
  LogIn,
  LogOut,
  BookOpen,
  Bot,
  Camera,
  Copy,
  Download,
  FileDown,
  FilePlus2,
  FileText,
  FlaskConical,
  FolderOpen,
  Globe,
  Info,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  MonitorSmartphone,
  PanelBottom,
  Play,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Smartphone,
  Trash2,
  Undo2,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as A from './actions';
import { exportProof, signIn as signInToDesigner, signOut as signOutOfDesigner, startPublishing } from './publish';
import { openGuide } from './guide';
import { DEFAULT_LAYOUT, getState, setState, updateLayout, type StoreState } from './store';
import { parentOf } from '../lib/paths';
import { resetZoom, zoomIn, zoomOut } from './zoom';
import { stopStream, useMirrorStream } from './mirrorStream';
import { openStoreTab } from './storeTab';
import { startInAppMirror } from '../components/common/MirrorButton';

export interface Command {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  /** Extra key combinations that trigger the command but are not shown. */
  alt?: string[];
  icon?: LucideIcon;
  enabled?: (s: StoreState) => boolean;
  run: () => void | Promise<void>;
  /** Allowed while focus is in a text field. */
  global?: boolean;
}

const hasProject = (s: StoreState) => !!s.project;
const hasSelection = (s: StoreState) => !!s.project && s.selection.length > 0;
const deviceReady = (s: StoreState) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device');

/** Folder new files go into: the selected folder, or the selected file's folder. */
export function targetFolder(s: StoreState = getState()): string {
  const first = s.selection[0];
  if (!first || !s.project) return '';
  if (s.fileIndex.has(first)) return parentOf(first);
  if (s.project.containers.some((c) => c.name === first)) return `${first}!/`;
  return first;
}

function toggle(key: 'sidebar' | 'inspector' | 'dock') {
  updateLayout({ [key]: !getState().layout[key] });
}

export const COMMANDS: Command[] = [
  // File
  { id: 'file.new', group: 'File', label: 'New theme…', shortcut: 'Ctrl+N', icon: FilePlus2, run: A.newProject, global: true },
  { id: 'file.open', group: 'File', label: 'Open package…', shortcut: 'Ctrl+O', icon: FolderOpen, run: () => A.openPackage(), global: true },
  { id: 'file.openPhone', group: 'File', label: 'Open a theme from the phone…', icon: Smartphone, run: () => openStoreTab('device') },
  { id: 'file.openDownloaded', group: 'File', label: 'Open a downloaded theme…', icon: Download, run: () => openStoreTab('downloads') },
  { id: 'file.openReference', group: 'File', label: 'Open reference package…', icon: BookOpen, enabled: hasProject, run: () => void A.openReference() },
  { id: 'file.save', group: 'File', label: 'Save', shortcut: 'Ctrl+S', icon: Save, enabled: hasProject, run: () => void A.save(), global: true },
  { id: 'file.saveAs', group: 'File', label: 'Save as…', shortcut: 'Ctrl+Shift+S', enabled: hasProject, run: () => void A.saveAs(), global: true },
  { id: 'file.exportCopy', group: 'File', label: 'Export a copy…', shortcut: 'Ctrl+E', icon: Download, enabled: hasProject, run: A.exportCopy, global: true },
  { id: 'file.report', group: 'File', label: 'Save package report…', icon: FileText, enabled: hasProject, run: A.saveReport },
  { id: 'file.close', group: 'File', label: 'Close package', enabled: hasProject, run: A.closeProject },

  // Edit
  { id: 'edit.undo', group: 'Edit', label: 'Undo', shortcut: 'Ctrl+Z', icon: Undo2, enabled: (s) => !!s.project?.canUndo, run: A.undo },
  { id: 'edit.redo', group: 'Edit', label: 'Redo', shortcut: 'Ctrl+Y', alt: ['Ctrl+Shift+Z'], icon: Redo2, enabled: (s) => !!s.project?.canRedo, run: A.redo },
  { id: 'edit.rename', group: 'Edit', label: 'Rename…', shortcut: 'F2', icon: Pencil, enabled: (s) => hasSelection(s) && s.selection.length === 1, run: () => A.renamePath(getState().selection[0]) },
  { id: 'edit.duplicate', group: 'Edit', label: 'Duplicate', shortcut: 'Ctrl+D', icon: Copy, enabled: (s) => s.selection.some((p) => s.fileIndex.has(p)), run: () => A.duplicatePaths(getState().selection) },
  { id: 'edit.move', group: 'Edit', label: 'Move to folder…', enabled: hasSelection, run: () => setState({ dialog: { type: 'move', paths: getState().selection } }) },
  { id: 'edit.delete', group: 'Edit', label: 'Delete', shortcut: 'Delete', icon: Trash2, enabled: hasSelection, run: () => A.deletePaths(getState().selection) },
  { id: 'edit.findInFiles', group: 'Edit', label: 'Find in files', shortcut: 'Ctrl+Shift+F', icon: Search, enabled: hasProject, run: () => setState((s) => ({ sideTab: 'search', layout: { ...s.layout, sidebar: true } })), global: true },
  { id: 'edit.goToFile', group: 'Edit', label: 'Go to file…', shortcut: 'Ctrl+P', icon: Search, enabled: hasProject, run: () => setState({ palette: 'files' }), global: true },
  { id: 'edit.palette', group: 'Edit', label: 'Command palette…', shortcut: 'Ctrl+K', alt: ['Ctrl+Shift+P'], icon: Search, run: () => setState({ palette: 'commands' }), global: true },

  // Go to
  { id: 'go.design', group: 'Go', label: 'Design', shortcut: 'Ctrl+1', run: () => A.goTo('design'), global: true },
  { id: 'go.files', group: 'Go', label: 'Files', shortcut: 'Ctrl+2', run: () => A.goTo('files'), global: true },
  { id: 'go.store', group: 'Go', label: 'Theme store', shortcut: 'Ctrl+3', run: () => A.goTo('store'), global: true },
  { id: 'go.phone', group: 'Go', label: 'Phone', shortcut: 'Ctrl+4', run: () => A.goTo('phone'), global: true },
  { id: 'go.check', group: 'Go', label: 'Export & publish', shortcut: 'Ctrl+5', run: () => A.goTo('check'), global: true },
  { id: 'go.library', group: 'Go', label: 'Library', shortcut: 'Ctrl+6', run: () => A.goTo('library'), global: true },
  { id: 'go.guide', group: 'Go', label: 'Guide', shortcut: 'Ctrl+7', icon: BookOpen, run: () => A.goTo('guide'), global: true },
  { id: 'go.assistant', group: 'Go', label: 'AI assistant (full screen)', shortcut: 'Ctrl+8', icon: Bot, run: () => A.goTo('assistant'), global: true },
  {
    id: 'view.assistant',
    group: 'View',
    label: 'Toggle AI assistant',
    shortcut: 'Ctrl+Shift+A',
    icon: Bot,
    run: () => {
      const s = getState();
      // In the full-screen chat, the toggle leaves it for the side panel's home.
      if (s.section === 'assistant') A.goTo('design');
      else updateLayout({ assistant: !s.layout.assistant });
    },
    global: true,
  },
  { id: 'view.phone', group: 'View', label: 'Toggle phone preview', shortcut: 'Ctrl+Alt+P', run: () => updateLayout({ phone: !getState().layout.phone }), global: true },

  // View
  { id: 'view.sidebar', group: 'View', label: 'Toggle sidebar', shortcut: 'Ctrl+B', icon: PanelLeft, run: () => toggle('sidebar'), global: true },
  { id: 'view.inspector', group: 'View', label: 'Toggle inspector', shortcut: 'Ctrl+Alt+B', icon: PanelRight, run: () => toggle('inspector'), global: true },
  { id: 'view.dock', group: 'View', label: 'Toggle bottom panel', shortcut: 'Ctrl+J', icon: PanelBottom, run: () => toggle('dock'), global: true },
  { id: 'view.problems', group: 'View', label: 'Show problems', shortcut: 'Ctrl+Shift+M', run: () => { updateLayout({ dock: true }); setState({ dockTab: 'problems' }); } },
  { id: 'view.output', group: 'View', label: 'Show output log', run: () => { updateLayout({ dock: true }); setState({ dockTab: 'output' }); } },
  { id: 'view.adbLog', group: 'View', label: 'Show ADB log', run: () => { updateLayout({ dock: true }); setState({ dockTab: 'adb' }); } },
  { id: 'view.history', group: 'View', label: 'Show edit history', run: () => { updateLayout({ dock: true }); setState({ dockTab: 'history' }); } },
  { id: 'view.zoomIn', group: 'View', label: 'Zoom in', shortcut: 'Ctrl+=', alt: ['Ctrl+Shift+=', 'Ctrl+NumpadAdd'], icon: ZoomIn, run: zoomIn, global: true },
  { id: 'view.zoomOut', group: 'View', label: 'Zoom out', shortcut: 'Ctrl+-', alt: ['Ctrl+NumpadSubtract'], icon: ZoomOut, run: zoomOut, global: true },
  { id: 'view.zoomReset', group: 'View', label: 'Reset zoom', shortcut: 'Ctrl+0', run: resetZoom, global: true },
  { id: 'view.resetLayout', group: 'View', label: 'Reset layout', run: () => updateLayout(DEFAULT_LAYOUT) },

  // Project
  { id: 'project.details', group: 'Project', label: 'Theme details', icon: Info, enabled: hasProject, run: () => A.openSingleton('info') },
  { id: 'project.addFiles', group: 'Project', label: 'Add files…', icon: Plus, enabled: hasProject, run: () => A.addFilesDialog(targetFolder()) },
  { id: 'project.newComponent', group: 'Project', label: 'New component archive…', icon: Archive, enabled: hasProject, run: () => A.createContainer() },
  { id: 'project.validate', group: 'Project', label: 'Validate package', shortcut: 'Ctrl+Shift+B', icon: ListChecks, enabled: hasProject, run: () => { void A.runValidation(false); updateLayout({ dock: true }); setState({ dockTab: 'problems' }); }, global: true },
  { id: 'project.build', group: 'Project', label: 'Build & export', icon: FileDown, enabled: hasProject, run: () => A.openSingleton('build') },
  { id: 'project.exportProof', group: 'Project', label: 'Export proof of copyright…', icon: FileArchive, enabled: hasProject, run: () => void exportProof() },
  { id: 'project.publish', group: 'Project', label: 'Publish to Xiaomi Themes…', icon: Send, enabled: hasProject, run: () => startPublishing() },
  { id: 'account.signIn', group: 'Account', label: 'Sign in to Xiaomi Theme Design Station', icon: LogIn, enabled: (s) => !s.designer?.signedIn, run: () => void signInToDesigner() },
  { id: 'account.signOut', group: 'Account', label: 'Sign out of Xiaomi Theme Design Station', icon: LogOut, enabled: (s) => !!s.designer?.signedIn, run: () => void signOutOfDesigner() },

  // Tools
  { id: 'tools.catalog', group: 'Tools', label: 'Theme store', icon: Globe, run: () => A.openSingleton('catalog') },
  { id: 'tools.settings', group: 'Tools', label: 'Settings…', shortcut: 'Ctrl+,', icon: Settings, run: () => setState({ dialog: { type: 'settings' } }), global: true },

  // Device
  { id: 'device.manager', group: 'Device', label: 'Device manager', icon: Smartphone, run: () => A.openSingleton('device') },
  { id: 'device.refresh', group: 'Device', label: 'Refresh devices', icon: RefreshCw, run: () => A.refreshAdb(false, true) },
  { id: 'device.screenshot', group: 'Device', label: 'Capture device screenshot', shortcut: 'Ctrl+Alt+S', icon: Camera, enabled: deviceReady, run: async () => { const shot = await A.captureScreenshot(); if (shot) A.openSingleton('preview'); } },
  { id: 'device.tryOn', group: 'Device', label: 'Try on phone', shortcut: 'Ctrl+Shift+T', icon: Play, enabled: (s) => hasProject(s) && deviceReady(s) && !s.busy, run: () => void A.tryOnOrPermanent(), global: true },
  { id: 'device.addToThemeManager', group: 'Device', label: 'Add to Theme Manager on phone (don’t apply)', icon: Send, enabled: (s) => hasProject(s) && deviceReady(s) && !s.busy, run: A.addToThemeManager },
  { id: 'device.send', group: 'Device', label: 'Copy package to device…', icon: Send, enabled: (s) => hasProject(s) && deviceReady(s), run: A.sendToDevice },
  { id: 'device.mirror', group: 'Device', label: 'Mirror screen (live)', icon: Smartphone, enabled: deviceReady, run: () => (useMirrorStream.getState().status === 'live' ? void stopStream() : startInAppMirror()) },
  { id: 'device.mirrorWindow', group: 'Device', label: 'Mirror screen in a separate window', icon: Smartphone, enabled: deviceReady, run: () => (A.mirrorRunning() ? A.stopMirror() : A.startMirror()) },
  { id: 'device.restart', group: 'Device', label: 'Restart ADB server', icon: RefreshCw, enabled: (s) => !!s.adb?.location, run: A.restartAdb },
  { id: 'device.locate', group: 'Device', label: 'Set adb.exe location…', icon: Wrench, run: A.chooseAdbPath },

  // Window
  { id: 'window.dashboard', group: 'Window', label: 'Dashboard', icon: LayoutDashboard, enabled: hasProject, run: () => A.openSingleton('dashboard') },
  { id: 'window.preview', group: 'Window', label: 'Preview', icon: MonitorSmartphone, run: () => A.openSingleton('preview') },
  { id: 'window.closeTab', group: 'Window', label: 'Close tab', shortcut: 'Ctrl+W', icon: X, enabled: (s) => !!s.activeTab, run: () => { const id = getState().activeTab; if (id) void A.closeTab(id); }, global: true },
  { id: 'window.closeAll', group: 'Window', label: 'Close all tabs', enabled: (s) => s.tabs.length > 0, run: A.closeAllTabs },
  { id: 'window.nextTab', group: 'Window', label: 'Next tab', shortcut: 'Ctrl+Tab', run: () => A.cycleTab(1), global: true },
  { id: 'window.prevTab', group: 'Window', label: 'Previous tab', shortcut: 'Ctrl+Shift+Tab', run: () => A.cycleTab(-1), global: true },

  // Help
  { id: 'help.guide', group: 'Help', label: 'Lock screen & widget guide', icon: BookOpen, run: () => A.goTo('guide') },
  { id: 'help.tryFormula', group: 'Help', label: 'Try a formula…', icon: FlaskConical, run: () => openGuide('try') },
  { id: 'help.shortcuts', group: 'Help', label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', icon: Keyboard, run: () => setState({ dialog: { type: 'shortcuts' } }), global: true },
  { id: 'help.roadmap', group: 'Help', label: 'Roadmap & limitations', icon: BookOpen, run: () => A.openSingleton('roadmap') },
  { id: 'help.about', group: 'Help', label: 'About Mi Theme Studio', icon: Info, run: () => setState({ dialog: { type: 'about' } }) },
];

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

export function isEnabled(command: Command, state: StoreState = getState()) {
  return command.enabled ? command.enabled(state) : true;
}

export function runCommand(id: string) {
  const command = commandById.get(id);
  if (command && isEnabled(command)) void command.run();
}

export type MenuEntry = string | '-' | { heading: string };

/** Menu bar layout (command ids; '-' is a separator). */
export const MENUS: { label: string; items: MenuEntry[] }[] = [
  { label: 'File', items: ['file.new', 'file.open', 'file.openPhone', 'file.openDownloaded', 'recent', '-', 'file.save', 'file.saveAs', 'file.exportCopy', 'project.exportProof', 'file.report', '-', 'file.openReference', '-', 'file.close'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.rename', 'edit.duplicate', 'edit.move', 'edit.delete', '-', 'edit.findInFiles', 'edit.goToFile', 'edit.palette'] },
  { label: 'Go', items: ['go.design', 'go.files', 'go.store', 'go.phone', 'go.check', 'go.library', 'go.guide'] },
  { label: 'View', items: ['view.phone', 'view.sidebar', 'view.inspector', 'view.dock', '-', 'view.problems', 'view.output', 'view.adbLog', 'view.history', '-', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', '-', 'view.resetLayout'] },
  { label: 'Project', items: ['project.details', 'project.addFiles', 'project.newComponent', '-', 'project.validate', 'project.build'] },
  { label: 'Tools', items: ['tools.catalog', '-', 'tools.settings'] },
  { label: 'Device', items: ['device.manager', 'device.refresh', '-', 'device.screenshot', 'device.mirror', 'device.send', '-', 'device.restart', 'device.locate'] },
  { label: 'Window', items: ['window.dashboard', 'window.preview', 'device.manager', 'project.build', '-', 'window.nextTab', 'window.prevTab', 'window.closeTab', 'window.closeAll'] },
  { label: 'Help', items: ['help.guide', 'help.tryFormula', '-', 'help.shortcuts', 'help.roadmap', '-', 'help.about'] },
];
