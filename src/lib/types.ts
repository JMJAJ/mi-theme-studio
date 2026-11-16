// Types mirroring the Rust DTOs in src-tauri/src (serde camelCase).

export type Slot = 'main' | 'ref';
export type FileKind = 'image' | 'xml' | 'text' | 'font' | 'audio' | 'video' | 'archive' | 'binary' | 'binaryXml';
export type FileStatus = 'original' | 'modified' | 'added';
export type ConflictPolicy = 'skip' | 'overwrite' | 'rename';

export interface FileInfo {
  path: string;
  size: number;
  kind: FileKind;
  component: string;
  format: string | null;
  width: number | null;
  height: number | null;
  ninePatch: boolean;
  density: string | null;
  status: FileStatus;
  rev: number;
  compression: 'stored' | 'deflated';
}

export interface ContainerInfo {
  name: string;
  component: string;
  files: number;
  bytes: number;
  status: FileStatus;
  originalBytes: number | null;
}

export interface ComponentDef {
  id: string;
  label: string;
  description: string;
  defaultRoot: string;
  archive: boolean;
}

export interface HistoryItem {
  id: number;
  label: string;
  atMs: number;
  files: number;
  done: boolean;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface ImportReport {
  sourceName: string;
  archiveBytes: number;
  files: number;
  directories: number;
  uncompressedBytes: number;
  nestedArchives: string[];
  skipped: SkippedEntry[];
  warnings: string[];
}

export interface Attribution {
  sourceTitle: string;
  sourceAuthor: string;
  sourceFile: string;
  files: number;
  atMs: number;
}

export interface ProjectSnapshot {
  slot: Slot;
  name: string;
  title: string;
  sourcePath: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  files: FileInfo[];
  containers: ContainerInfo[];
  removed: string[];
  totalBytes: number;
  history: HistoryItem[];
  importReport: ImportReport | null;
  attributions: Attribution[];
  components: ComponentDef[];
}

export interface MetadataField {
  name: string;
  value: string;
  attributes: [string, string][];
  complex: boolean;
}

export interface MetadataView {
  exists: boolean;
  root: string;
  fields: MetadataField[];
  error: string | null;
}

export interface TextFile {
  path: string;
  text: string;
  lossy: boolean;
  bom: boolean;
  rev: number;
}

export interface BulkResult {
  written: string[];
  skipped: string[];
  overwritten: string[];
}

export interface CopyPlanItem {
  source: string;
  destination: string;
  conflict: boolean;
  size: number;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  path: string | null;
  fix: 'pack-folder' | 'create-description' | null;
}

export interface ValidationReport {
  issues: Issue[];
  errors: number;
  warnings: number;
  infos: number;
  checkedFiles: number;
  checkedXml: number;
  checkedReferences: number;
  limitations: string[];
}

export interface SaveResult {
  snapshot: ProjectSnapshot;
  path: string;
  bytes: number;
  entries: number;
  backupPath: string | null;
  verified: boolean;
  durationMs: number;
  mode: 'save' | 'saveAs' | 'copy';
}

export interface ExportProgress {
  stage: 'collect' | 'write' | 'verify' | 'write-file' | 'done';
  done: number;
  total: number;
}

export interface RecentItem {
  path: string;
  name: string;
  openedAtMs: number;
}

export interface Settings {
  adbPath: string | null;
  recent: RecentItem[];
  autosaveEnabled: boolean;
  autosaveIntervalSeconds: number;
  backupsEnabled: boolean;
}

export interface RecoveryInfo {
  name: string;
  sourcePath: string | null;
  savedAtMs: number;
  bytes: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  backupsDir: string;
  screenshotsDir: string;
  recovery: RecoveryInfo | null;
  settings: Settings;
}

export interface AppErrorPayload {
  code: string;
  message: string;
}

// ----- ADB -----

export interface DeviceEntry {
  serial: string;
  state: string;
  model: string | null;
  product: string | null;
  device: string | null;
  transportId: string | null;
  usb: string | null;
}

export interface AdbLocation {
  path: string;
  source: string;
}

export interface AdbCandidate {
  path: string;
  source: string;
  exists: boolean;
}

export interface AdbStatus {
  location: AdbLocation | null;
  searched: AdbCandidate[];
  version: string | null;
  devices: DeviceEntry[];
  error: AppErrorPayload | null;
  checkedAtMs: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface DeviceDetails {
  serial: string;
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  marketName: string | null;
  device: string | null;
  androidVersion: string | null;
  sdk: string | null;
  miuiVersion: string | null;
  hyperosVersion: string | null;
  buildIncremental: string | null;
  region: string | null;
  abi: string | null;
  screen: Size | null;
  screenOverride: Size | null;
  density: number | null;
  densityOverride: number | null;
  themeManagerVersion: string | null;
  themeManagerInstalled: boolean;
  fetchedAtMs: number;
}

export interface ScreenshotInfo {
  id: number;
  serial: string;
  model: string | null;
  atMs: number;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface AdbLogEntry {
  id: number;
  atMs: number;
  command: string;
  code: number | null;
  durationMs: number;
  ok: boolean;
  summary: string;
}

export interface PushResult {
  remotePath: string;
  bytes: number;
  verified: boolean;
  durationMs: number;
}

export interface SendResult {
  push: PushResult;
  packageEntries: number;
}

/** Theme Manager metadata and preview references already present on a device. */
export interface CachedDeviceTheme {
  localId: string;
  onlineId: string | null;
  productId: string | null;
  title: string;
  author: string | null;
  designer: string | null;
  description: string | null;
  version: string | null;
  sizeBytes: number | null;
  updatedTimeMs: number | null;
  components: string[];
  hasPreview: boolean;
}

// ----- Online catalog (read-only discovery) -----

export type CatalogSource = 'shelves' | 'categories';

export interface CatalogLink {
  kind: string | null;
  target: string | null;
  title: string | null;
  productType: string | null;
}

export interface CatalogItem {
  title: string | null;
  imageUrl: string | null;
  darkImageUrl: string | null;
  link: CatalogLink | null;
}

export interface CatalogSection {
  cardUuid: string | null;
  cardType: string;
  layout: 'shelf' | 'banner' | 'grid' | 'icons' | 'other';
  title: string | null;
  localizedTitle: string | null;
  subtitle: string | null;
  subjectUuid: string | null;
  productCount: number | null;
  productCountPerCard: number | null;
  productsReturned: number;
  visible: boolean;
  imageUrl: string | null;
  link: CatalogLink | null;
  items: CatalogItem[];
}

export interface CatalogPage {
  source: CatalogSource;
  endpoint: string;
  title: string | null;
  pageUuid: string | null;
  language: string | null;
  hasMore: boolean;
  cardStart: number;
  nextStart: number;
  sections: CatalogSection[];
  fetchedAtMs: number;
  durationMs: number;
}
