// Typed wrappers over the native commands. All file system, archive and
// device work happens in Rust; the UI only calls these.
import { invoke } from '@tauri-apps/api/core';
import type { DeviceApp, TryOnResult, ConvertResult,
  LicenceReport,
  LocalImageData, LocalImageListing, TerminalResult,
  LicenseOutcome,
  ThemeCompatibility,
  RootApplyResult,
  ThemeBackup,
  MirrorStatus,
  ApplyResult,
  ThemeManagerSupport,
  PrepareThemeManagerResult,
  KeepAppliedResult,
  PermanentApplyResult,
  AodRestoreResult,
  MediaTarget,
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
  FilesExtractResult,
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
  ValidationReport, StorePart, ProductKind, PhoneLiveState, AiSettings, AiSettingsPatch, AiProxyDetection, AiChatReply } from './types';

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
  launchPackageTake: () => call<string | null>('launch_package_take'),
  settingsUpdate: (patch: Partial<Omit<Settings, 'recent'>>) => call<Settings>('settings_update', { patch }),
  recentRemove: (path: string) => call<Settings>('recent_remove', { path }),

  projectNew: (title: string) => call<ProjectSnapshot>('project_new', { title }),
  projectOpen: (path: string) => call<ProjectSnapshot>('project_open', { path }),
  projectSnapshot: () => call<ProjectSnapshot | null>('project_snapshot'),
  projectClose: () => call<void>('project_close'),

  fileText: (path: string, slot: Slot = 'main') => call<TextFile>('file_text', { path, slot }),
  fileWriteText: (path: string, text: string, allowInvalidXml = false) =>
    call<ProjectSnapshot>('file_write_text', { path, text, allowInvalidXml }),
  filesImport: (sources: string[], folder: string, policy: ConflictPolicy, names?: string[]) =>
    call<BulkResponse>('files_import', { sources, folder, policy, names: names ?? null }),
  localImagesList: (folder: string) => call<LocalImageListing>('local_images_list', { folder }),
  localImageRead: (path: string) => call<LocalImageData>('local_image_read', { path }),
  terminalRun: (runId: string, command: string, workingDirectory: string, timeoutSeconds: number) =>
    call<TerminalResult>('terminal_run', { runId, command, workingDirectory, timeoutSeconds }),
  terminalCancel: (runId: string) => call<boolean>('terminal_cancel', { runId }),
  /** Files made in the app (cropped wallpaper, generated icons): one undoable change, overwrites. */
  filesWrite: (files: { path: string; data: number[] }[], label: string) => call<BulkResponse>('files_write', { files, label }),
  fileReplace: (path: string, source: string) => call<ProjectSnapshot>('file_replace', { path, source }),
  filesDelete: (paths: string[]) => call<ProjectSnapshot>('files_delete', { paths }),
  fileRename: (path: string, newName: string) => call<PathsResponse>('file_rename', { path, newName }),
  filesMove: (paths: string[], folder: string) => call<PathsResponse>('files_move', { paths, folder }),
  filesDuplicate: (paths: string[]) => call<PathsResponse>('files_duplicate', { paths }),
  fileExtract: (path: string, destination: string, slot: Slot = 'main') =>
    call<void>('file_extract', { path, destination, slot }),
  filesExtract: (paths: string[], destination: string, slot: Slot = 'main') =>
    call<FilesExtractResult>('files_extract', { paths, destination, slot }),
  containerCreate: (name: string) => call<ProjectSnapshot>('container_create', { name }),
  folderPack: (folder: string) => call<ProjectSnapshot>('folder_pack', { folder }),
  imagesConvert: (paths: string[]) => call<{ snapshot: ProjectSnapshot; result: ConvertResult }>('images_convert', { paths }),

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

  inventoryList: () => call<unknown[]>('inventory_list'),
  inventorySave: (item: object, files: { path: string; data: number[] }[]) => call<unknown>('inventory_save', { item, files }),
  inventoryUpdate: (id: string, patch: object) => call<unknown>('inventory_update', { id, patch }),
  inventoryDelete: (id: string) => call<void>('inventory_delete', { id }),
  inventoryFiles: (id: string) => call<{ path: string; data: number[] }[]>('inventory_files', { id }),

  referenceOpen: (path: string) => call<ProjectSnapshot>('reference_open', { path }),
  referenceSnapshot: () => call<ProjectSnapshot | null>('reference_snapshot'),
  referenceClose: () => call<void>('reference_close'),
  referencePlan: (paths: string[], folder: string | null) => call<CopyPlanItem[]>('reference_plan', { paths, folder }),
  referenceCopy: (paths: string[], folder: string | null, policy: ConflictPolicy) =>
    call<BulkResponse>('reference_copy', { paths, folder, policy }),

  adbStatus: (quiet = false, withVersion = true) => call<AdbStatus>('adb_status', { quiet, withVersion }),
  adbRestartServer: () => call<AdbStatus>('adb_restart_server'),
  adbDetails: (serial: string) => call<DeviceDetails>('adb_details', { serial }),
  adbLiveState: (serial: string) => call<PhoneLiveState>('adb_live_state', { serial }),
  adbCachedThemes: (serial: string) => call<CachedDeviceTheme[]>('adb_cached_themes', { serial }),
  adbCachedThemePreview: (serial: string, localId: string) =>
    call<number[]>('adb_cached_theme_preview', { serial, localId }),
  adbCachedThemeReference: (serial: string, localId: string) =>
    call<ProjectSnapshot>('adb_cached_theme_reference', { serial, localId }),
  adbListApps: (serial: string) => call<DeviceApp[]>('adb_list_apps', { serial }),
  adbAddToThemeManager: (serial: string, opId: string) => call<TryOnResult>('adb_add_to_theme_manager', { serial, opId }),
  adbTryOn: (serial: string, opId: string, force = false) => call<TryOnResult>('adb_try_on', { serial, opId, force }),
  adbLicenceReport: (serial: string) => call<LicenceReport>('adb_licence_report', { serial }),
  adbLicenseDownloads: (serial: string, opId: string) => call<LicenseOutcome[]>('adb_license_downloads', { serial, opId }),
  themeCompatibility: (serial: string) => call<ThemeCompatibility>('theme_compatibility', { serial }),
  adbThemeFormat: (serial: string) => call<number | null>('adb_theme_format', { serial }),
  adbRootApply: (serial: string, opId: string) => call<RootApplyResult>('adb_root_apply', { serial, opId }),
  adbReboot: (serial: string) => call<void>('adb_reboot', { serial }),
  adbRootBackups: (serial: string) => call<ThemeBackup[]>('adb_root_backups', { serial }),
  adbRootRestore: (serial: string, backup: string) => call<string[]>('adb_root_restore', { serial, backup }),
  adbCachedThemeOpen: (serial: string, localId: string) =>
    call<ProjectSnapshot>('adb_cached_theme_open', { serial, localId }),
  adbScreenshot: (serial: string, model: string | null, opId: string) =>
    call<ScreenshotInfo>('adb_screenshot', { serial, model, opId }),
  screenshotsList: () => call<ScreenshotInfo[]>('screenshots_list'),
  screenshotSave: (id: number, path: string) => call<void>('screenshot_save', { id, path }),
  adbCancel: (opId: string) => call<boolean>('adb_cancel', { opId }),
  adbLog: () => call<AdbLogEntry[]>('adb_log'),
  adbSendPackage: (serial: string, opId: string) =>
    call<SendResult>('adb_send_package', { serial, confirmed: true, opId }),

  adbThemeSupport: (serial: string) => call<ThemeManagerSupport>('adb_theme_support', { serial }),
  adbPrepareThemeManager: (serial: string, opId?: string) =>
    call<PrepareThemeManagerResult>('adb_prepare_theme_manager', { serial, confirmed: true, opId }),
  adbInstallThemeManagerApk: (serial: string, apkPath: string, opId?: string) =>
    call<ThemeManagerSupport>('adb_install_theme_manager_apk', { serial, apkPath, confirmed: true, opId }),
  adbKeepThemeApplied: (serial: string, enabled: boolean, opId?: string) =>
    call<KeepAppliedResult>('adb_keep_theme_applied', { serial, enabled, opId }),
  adbKeepaliveStatus: (serial: string) => call<boolean>('adb_keepalive_status', { serial }),
  adbOpenStoreItem: (serial: string, moduleId: string) => call<void>('adb_open_store_item', { serial, moduleId }),
  adbOpenThemeSettings: (serial: string) => call<void>('adb_open_theme_settings', { serial }),
  adbApplyTheme: (serial: string, opId: string, force = false) => call<ApplyResult>('adb_apply_theme', { serial, confirmed: true, force, opId }),
  adbApplyThemePermanent: (serial: string, opId?: string, force = false) =>
    call<PermanentApplyResult>('adb_apply_theme_permanent', { serial, confirmed: true, force, opId }),
  adbRestoreAod: (serial: string, opId?: string) =>
    call<AodRestoreResult>('adb_restore_aod', { serial, confirmed: true, opId }),
  mirrorStatus: () => call<MirrorStatus>('mirror_status'),
  mirrorStart: (serial: string, title?: string) => call<MirrorStatus>('mirror_start', { serial, title }),
  mirrorStop: () => call<MirrorStatus>('mirror_stop'),
  ninepatchInfo: (slot: Slot, path: string) => call<NinePatch>('ninepatch_info', { slot, path }),
  ninepatchUpdate: (path: string, update: NinePatchUpdate) => call<ProjectSnapshot>('ninepatch_update', { path, update }),
  projectSearch: (options: SearchOptions) => call<SearchResult>('project_search', { options }),
  projectReplace: (options: SearchOptions, replacement: string, targets: ReplaceTarget[], allowInvalidXml = false) =>
    call<{ result: ReplaceResult; snapshot: ProjectSnapshot }>('project_replace', { options, replacement, targets, allowInvalidXml }),
  storePage: (query: StoreQuery, start = 0, region?: string) => call<StorePage>('store_page', { query, start, region }),
  storeDetail: (id: string, region?: string) => call<ThemeDetail>('store_detail', { id, region }),
  storeDownload: (moduleId: string, region?: string, listing?: { part: StorePart | null; kind: ProductKind; name: string; cover: string | null }) => call<DownloadedTheme>('store_download', { moduleId, region, listing }),
  storeCancel: (moduleId: string) => call<void>('store_cancel', { moduleId }),
  storeDownloads: () => call<DownloadedTheme[]>('store_downloads'),
  storeRemoveDownload: (moduleId: string) => call<void>('store_remove_download', { moduleId }),
  storeApplyMedia: (moduleId: string, target: MediaTarget) => call<ProjectSnapshot>('store_apply_media', { moduleId, target }),
  storeOpenProject: (moduleId: string) => call<ProjectSnapshot>('store_open_project', { moduleId }),

  aiSettings: () => call<AiSettings>('ai_settings'),
  aiSettingsUpdate: (patch: AiSettingsPatch) => call<AiSettings>('ai_settings_update', { patch }),
  aiDetectAiproxy: () => call<AiProxyDetection>('ai_detect_aiproxy'),
  aiModels: () => call<string[]>('ai_models'),
  /** Streams `ai-stream` events tagged with requestId while it runs. */
  aiChat: (requestId: string, body: object) => call<AiChatReply>('ai_chat', { requestId, body }),
  aiCancel: (requestId: string) => call<void>('ai_cancel', { requestId }),
  /** GET JSON for the playground's Live mode (a few fixed weather and location hosts). */
  liveGetJson: (url: string) => call<string>('live_get_json', { url }),
};

// Windows/Android webviews reach custom protocols as http://<scheme>.localhost.
const RESOURCE_BASE =
  // The browser UI preview harness (scripts/ui-preview) serves resources itself.
  (globalThis as { __MTS_RESOURCE_BASE__?: string }).__MTS_RESOURCE_BASE__ ??
  (typeof navigator !== 'undefined' && /Windows|Android/i.test(navigator.userAgent)
    ? 'http://themeres.localhost'
    : 'themeres://localhost');

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
