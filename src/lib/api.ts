// Typed wrappers over the native commands. All file system, archive and
// device work happens in Rust; the UI only calls these.
import { invoke } from '@tauri-apps/api/core';
import type {
  NinePatch,
  NinePatchUpdate,
  ReplaceResult,
  ReplaceTarget,
  SearchOptions,
  SearchResult,
  DownloadedTheme,
  StorePage,
  StoreQuery,
  ThemeDetail,
  AdbLogEntry,
  AdbStatus,
  AppErrorPayload,
  AppInfo,
  CachedDeviceTheme,
  BulkResult,
  ConflictPolicy,
  CopyPlanItem,
  DeviceDetails,
  MetadataView,
  ProjectSnapshot,
  RecoveryInfo,
  SaveResult,
  ScreenshotInfo,
  SendResult,
  Settings,
  Slot,
  TextFile,
  ValidationReport,
} from './types';

export class ApiError extends Error {
  code: string;
  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.code = payload.code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'Unexpected error';
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  return undefined;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
      throw new ApiError(error as AppErrorPayload);
    }
    throw new ApiError({ code: 'internal', message: errorMessage(error) });
  }
}

interface BulkResponse {
  snapshot: ProjectSnapshot;
  result: BulkResult;
}

interface PathsResponse {
  snapshot: ProjectSnapshot;
  paths: string[];
}

export interface FieldUpdate {
  name: string;
  value: string;
}

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  settingsUpdate: (patch: Partial<Omit<Settings, 'recent'>>) => call<Settings>('settings_update', { patch }),
  recentRemove: (path: string) => call<Settings>('recent_remove', { path }),

  projectNew: (title: string) => call<ProjectSnapshot>('project_new', { title }),
  projectOpen: (path: string) => call<ProjectSnapshot>('project_open', { path }),
  projectSnapshot: () => call<ProjectSnapshot | null>('project_snapshot'),
  projectClose: () => call<void>('project_close'),

  fileText: (path: string, slot: Slot = 'main') => call<TextFile>('file_text', { path, slot }),
  fileWriteText: (path: string, text: string, allowInvalidXml = false) =>
    call<ProjectSnapshot>('file_write_text', { path, text, allowInvalidXml }),
  filesImport: (sources: string[], folder: string, policy: ConflictPolicy) =>
    call<BulkResponse>('files_import', { sources, folder, policy }),
  fileReplace: (path: string, source: string) => call<ProjectSnapshot>('file_replace', { path, source }),
  filesDelete: (paths: string[]) => call<ProjectSnapshot>('files_delete', { paths }),
  fileRename: (path: string, newName: string) => call<PathsResponse>('file_rename', { path, newName }),
  filesMove: (paths: string[], folder: string) => call<PathsResponse>('files_move', { paths, folder }),
  filesDuplicate: (paths: string[]) => call<PathsResponse>('files_duplicate', { paths }),
  fileExtract: (path: string, destination: string, slot: Slot = 'main') =>
    call<void>('file_extract', { path, destination, slot }),
  containerCreate: (name: string) => call<ProjectSnapshot>('container_create', { name }),
  folderPack: (folder: string) => call<ProjectSnapshot>('folder_pack', { folder }),

  metadataGet: (slot: Slot = 'main') => call<MetadataView>('metadata_get', { slot }),
  metadataUpdate: (fields: FieldUpdate[], label?: string) => call<ProjectSnapshot>('metadata_update', { fields, label }),

  undo: () => call<ProjectSnapshot>('history_undo'),
  redo: () => call<ProjectSnapshot>('history_redo'),
  historyGoto: (id: number | null) => call<ProjectSnapshot>('history_goto', { id }),

  save: (mode: 'save' | 'saveAs' | 'copy', path?: string) => call<SaveResult>('project_save', { mode, path: path ?? null }),
  validate: () => call<ValidationReport>('project_validate'),
  reportSave: (path: string) => call<void>('report_save', { path }),

  autosave: () => call<RecoveryInfo | null>('autosave'),
  recoveryRestore: () => call<ProjectSnapshot>('recovery_restore'),
  recoveryDiscard: () => call<void>('recovery_discard'),

  referenceOpen: (path: string) => call<ProjectSnapshot>('reference_open', { path }),
  referenceSnapshot: () => call<ProjectSnapshot | null>('reference_snapshot'),
  referenceClose: () => call<void>('reference_close'),
  referencePlan: (paths: string[], folder: string | null) => call<CopyPlanItem[]>('reference_plan', { paths, folder }),
  referenceCopy: (paths: string[], folder: string | null, policy: ConflictPolicy) =>
    call<BulkResponse>('reference_copy', { paths, folder, policy }),

  adbStatus: (quiet = false, withVersion = true) => call<AdbStatus>('adb_status', { quiet, withVersion }),
  adbRestartServer: () => call<AdbStatus>('adb_restart_server'),
  adbDetails: (serial: string) => call<DeviceDetails>('adb_details', { serial }),
  adbCachedThemes: (serial: string) => call<CachedDeviceTheme[]>('adb_cached_themes', { serial }),
  adbCachedThemePreview: (serial: string, localId: string) =>
    call<number[]>('adb_cached_theme_preview', { serial, localId }),
  adbCachedThemeReference: (serial: string, localId: string) =>
    call<ProjectSnapshot>('adb_cached_theme_reference', { serial, localId }),
  adbScreenshot: (serial: string, model: string | null, opId: string) =>
    call<ScreenshotInfo>('adb_screenshot', { serial, model, opId }),
  screenshotsList: () => call<ScreenshotInfo[]>('screenshots_list'),
  screenshotSave: (id: number, path: string) => call<void>('screenshot_save', { id, path }),
  adbCancel: (opId: string) => call<boolean>('adb_cancel', { opId }),
  adbLog: () => call<AdbLogEntry[]>('adb_log'),
  adbSendPackage: (serial: string, opId: string) =>
    call<SendResult>('adb_send_package', { serial, confirmed: true, opId }),

  ninepatchInfo: (slot: Slot, path: string) => call<NinePatch>('ninepatch_info', { slot, path }),
  ninepatchUpdate: (path: string, update: NinePatchUpdate) => call<ProjectSnapshot>('ninepatch_update', { path, update }),
  projectSearch: (options: SearchOptions) => call<SearchResult>('project_search', { options }),
  projectReplace: (options: SearchOptions, replacement: string, targets: ReplaceTarget[], allowInvalidXml = false) =>
    call<{ result: ReplaceResult; snapshot: ProjectSnapshot }>('project_replace', { options, replacement, targets, allowInvalidXml }),
  storePage: (query: StoreQuery, start = 0, region?: string) => call<StorePage>('store_page', { query, start, region }),
  storeDetail: (id: string, region?: string) => call<ThemeDetail>('store_detail', { id, region }),
  storeDownload: (moduleId: string, region?: string) => call<DownloadedTheme>('store_download', { moduleId, region }),
  storeCancel: (moduleId: string) => call<void>('store_cancel', { moduleId }),
  storeDownloads: () => call<DownloadedTheme[]>('store_downloads'),
  storeRemoveDownload: (moduleId: string) => call<void>('store_remove_download', { moduleId }),
  storeOpenProject: (moduleId: string) => call<ProjectSnapshot>('store_open_project', { moduleId }),
};

// Windows/Android webviews reach custom protocols as http://<scheme>.localhost.
const RESOURCE_BASE =
  typeof navigator !== 'undefined' && /Windows|Android/i.test(navigator.userAgent)
    ? 'http://themeres.localhost'
    : 'themeres://localhost';

/** URL for a package resource served by the native `themeres:` protocol. */
export function resourceUrl(slot: Slot, path: string, rev: number): string {
  return `${RESOURCE_BASE}/${slot}/${encodeURIComponent(path)}?v=${rev}`;
}

export function screenshotUrl(id: number): string {
  return `${RESOURCE_BASE}/shot/${id}`;
}

let opCounter = 0;
export function newOpId(prefix: string): string {
  opCounter += 1;
  return `${prefix}-${Date.now()}-${opCounter}`;
}
