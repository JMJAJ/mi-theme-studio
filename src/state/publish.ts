// Publishing to the Xiaomi Theme Design Station as a guided flow. The state lives here
// (not in the view) so leaving the Publish tab and coming back keeps your place.
import { create } from 'zustand';
import {
  api,
  errorMessage,
  type DesignerCopyrightFile,
  type DesignerPackageAudit,
  type DesignerProofEntry,
  type DesignerProofInfo,
  type DesignerProductDetail,
  type DesignerProductRow,
  type DesignerTagGroup,
  type DesignerUploadProgress,
  type ProofWorkingFiles,
} from '../lib/api';
import type { ProjectSnapshot } from '../lib/types';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { formatBytes, plural } from '../lib/format';
import { goTo } from './actions';
import { toast, useStore } from './store';

export type PublishStep = 'account' | 'details' | 'proof' | 'submit' | 'done';
export const PUBLISH_STEPS: { id: Exclude<PublishStep, 'done'>; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'details', label: 'Store details' },
  { id: 'proof', label: 'Proof of copyright' },
  { id: 'submit', label: 'Submit' },
];

export type TaskId = 'package' | 'proof' | 'proofUpload' | 'submit';
export const TASKS: { id: TaskId; label: string }[] = [
  { id: 'package', label: 'Build and upload the theme package' },
  { id: 'proof', label: 'Build the proof-of-copyright ZIP' },
  { id: 'proofUpload', label: 'Upload the proof of copyright' },
  { id: 'submit', label: 'Submit for review' },
];
export type TaskState = 'idle' | 'running' | 'done' | 'error';

export interface PublishForm {
  productName: string;
  versionName: string;
  designerName: string;
  authorName: string;
  description: string;
  talkToUs: string;
  /** What changed; only for a new version of a theme that has been live. */
  changeLog: string;
}

/** The published theme a new version is for. */
export interface UpdateTarget {
  productId: string;
  productName: string;
  /** Version currently on the station. */
  versionName: string;
  /** Has been in the store. A theme rejected before it ever went live is resubmitted: the
   *  station then asks for no change log and no newer version (`changeLog.show` needs a
   *  `productStatus` in its update form). */
  live: boolean;
  /** Why the last review was rejected, when it was. */
  refusal: string[];
}

interface PublishState {
  active: boolean;
  /** The project this publish belongs to; another project resets it. */
  projectId: string | null;
  /** Set when publishing a new version of an existing theme. */
  updateOf: UpdateTarget | null;
  step: PublishStep;
  signingIn: boolean;
  miuiVersion: 'V12' | 'V15' | 'V17';
  form: PublishForm;
  tags: string[];
  tagGroups: DesignerTagGroup[];
  gifUrl: string | null;
  proofInfo: DesignerProofInfo | null;
  /** Theme images unticked in the proof's file tree. */
  excludedArtwork: string[];
  /** The designer brings their own proof: nothing is generated, the files below are the proof. */
  ownProof: boolean;
  /** Files and folders picked from disk. */
  extraFiles: string[];
  /** What they contain, as shown in the tree. */
  extraEntries: DesignerProofEntry[];
  /** Files unticked in the tree. */
  excludedExtra: string[];
  sources: string;
  /** What the declaration says about the layered working files. */
  workingFiles: ProofWorkingFiles;
  /** Parts made with generative AI, disclosed to the reviewer as they are written. */
  aiText: string;
  /** How the theme was made, printed in the declaration above the working files. */
  process: string;
  /** Uploads are reused while what they were made from is unchanged. */
  audit: { data: DesignerPackageAudit; key: string } | null;
  proof: { path: string; bytes: number; files: number; key: string } | null;
  copyright: { file: DesignerCopyrightFile; key: string } | null;
  tasks: Record<TaskId, TaskState>;
  taskError: string | null;
  running: boolean;
  uploadingVideo: boolean;
  progress: DesignerUploadProgress | null;
}

const EMPTY_FORM: PublishForm = { productName: '', versionName: '', designerName: '', authorName: '', description: '', talkToUs: '', changeLog: '' };
const IDLE_TASKS: Record<TaskId, TaskState> = { package: 'idle', proof: 'idle', proofUpload: 'idle', submit: 'idle' };

const initial = (): Omit<PublishState, 'signingIn' | 'tagGroups'> => ({
  active: false,
  projectId: null,
  updateOf: null,
  step: 'account',
  miuiVersion: 'V15',
  form: { ...EMPTY_FORM },
  tags: [],
  gifUrl: null,
  proofInfo: null,
  excludedArtwork: [],
  ownProof: false,
  extraFiles: [],
  extraEntries: [],
  excludedExtra: [],
  sources: '',
  workingFiles: 'included',
  aiText: '',
  process: '',
  audit: null,
  proof: null,
  copyright: null,
  tasks: { ...IDLE_TASKS },
  taskError: null,
  running: false,
  uploadingVideo: false,
  progress: null,
});

export const usePublish = create<PublishState>(() => ({ ...initial(), signingIn: false, tagGroups: [] }));
const set = usePublish.setState;
const get = usePublish.getState;

export const projectId = (p: ProjectSnapshot | null) => (p ? `${p.sourcePath ?? ''}|${p.name}` : null);

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Changes whenever a file of the project changes. */
function packageKey(): string {
  const project = useStore.getState().project;
  return hash(`${get().updateOf?.productId ?? ''}|${get().miuiVersion}|${project?.files.map((f) => `${f.path}:${f.rev}`).join('|') ?? ''}`);
}

export function proofKey(): string {
  const s = get();
  return hash(JSON.stringify([s.form.productName, s.form.designerName, s.ownProof, s.excludedArtwork, s.extraFiles, s.excludedExtra, s.sources, s.workingFiles, s.aiText, s.process, packageKey()]));
}

export const updateForm = (patch: Partial<PublishForm>) => set((s) => ({ form: { ...s.form, ...patch } }));

/** Station tags that already appear in the theme's keywords, name or description. */
export function suggestTags(groups: DesignerTagGroup[], info: DesignerProofInfo | null): string[] {
  if (!info) return [];
  const words = new Set(
    `${info.keywords} ${info.title} ${info.description}`
      .toLowerCase()
      .split(/[\s,;，、/|]+/)
      .filter(Boolean),
  );
  const keywords = new Set(info.keywords.toLowerCase().split(/[,;，、]+/).map((k) => k.trim()).filter(Boolean));
  const out: string[] = [];
  for (const group of groups) {
    for (const tag of group.subTags) {
      const t = tag.toLowerCase();
      if ((keywords.has(t) || words.has(t)) && !out.includes(tag)) out.push(tag);
    }
  }
  return out.slice(0, 6);
}

export async function loadTags() {
  if (get().tagGroups.length || !useStore.getState().designer?.signedIn) return;
  try {
    const groups = await api.designerTags();
    set({ tagGroups: groups });
    if (!get().tags.length) set({ tags: suggestTags(groups, get().proofInfo) });
  } catch {
    // The picker stays empty; typing tags still works.
  }
}

/** Fills the store details from description.xml. */
async function prefill() {
  try {
    const info = await api.designerProofInfo();
    const nickname = useStore.getState().designer?.nickname ?? '';
    set((s) => ({
      proofInfo: info,
      form: {
        ...s.form,
        productName: s.form.productName || info.title.slice(0, 18),
        versionName: s.form.versionName || info.version || '1.0',
        designerName: s.form.designerName || (info.designer || info.author || nickname).slice(0, 20),
        authorName: s.form.authorName || (info.author || info.designer || nickname).slice(0, 20),
        description: s.form.description || info.description,
      },
    }));
    if (get().tagGroups.length && !get().tags.length) set({ tags: suggestTags(get().tagGroups, info) });
  } catch {
    // No project details yet; the fields stay editable.
  }
}

export async function refreshProofInfo() {
  try {
    set({ proofInfo: await api.designerProofInfo() });
  } catch {
    // Keep the previous numbers.
  }
}

/** Starts (or resumes) publishing the open project, as a new theme or as a new version of `update`. */
export function startPublishing(update?: DesignerProductDetail) {
  const project = useStore.getState().project;
  if (!project) return;
  const id = projectId(project);
  const target: UpdateTarget | null = update
    ? {
        productId: update.productId,
        productName: update.productName,
        versionName: update.versionName ?? '',
        live: !!update.productStatus,
        refusal: update.auditState === 'REJECTED' ? refusalReasons(update.refusalReason) : [],
      }
    : get().projectId === id ? get().updateOf : null;
  if (get().projectId !== id || get().updateOf?.productId !== target?.productId) {
    set({ ...initial(), projectId: id, updateOf: target });
    if (update) {
      // Start from what is on the station; the version and change log are new.
      const mv = update.auditMiuiVersion;
      set((s) => ({
        miuiVersion: mv === 'V12' || mv === 'V17' ? mv : 'V15',
        tags: (update.tags ?? []).slice(0, 10),
        form: {
          ...s.form,
          productName: update.productName.slice(0, 18),
          designerName: (update.designerName ?? '').slice(0, 20),
          authorName: (update.authorName ?? '').slice(0, 20),
          description: update.description ?? '',
        },
      }));
    }
  }
  const signedIn = !!useStore.getState().designer?.signedIn;
  set((s) => ({ active: true, step: s.step === 'done' ? 'details' : signedIn && s.step === 'account' ? 'details' : s.step }));
  void prefill();
  void loadTags();
  if (!usePublished.getState().loaded) void refreshPublished();
  goTo('check');
}

/** Back to Check & export; the publish stays where it was. */
export const pausePublishing = () => set({ active: false });

export function cancelPublishing() {
  set({ ...initial() });
}

export function setStep(step: PublishStep) {
  set({ step });
}

/** Called when the Design Station session changes. */
export function onDesignerSession(signedIn: boolean) {
  set({ signingIn: false });
  if (signedIn) {
    if (get().active && get().step === 'account') set({ step: 'details' });
    void loadTags();
    void refreshPublished();
  } else {
    usePublished.setState({ rows: [], loaded: false, error: null });
    if (get().active && get().step !== 'done') set({ step: 'account' });
  }
}

export async function signIn() {
  if (get().signingIn) {
    void api.designerLoginOpen();
    return;
  }
  set({ signingIn: true });
  try {
    await api.designerLoginOpen();
    toast('info', 'Finish signing in in the Xiaomi window. It closes by itself when you’re in.');
  } catch (e) {
    set({ signingIn: false });
    toast('error', `Sign in: ${errorMessage(e)}`);
  }
}

export async function signOut() {
  try {
    await api.designerSignOut();
  } catch (e) {
    toast('error', `Sign out: ${errorMessage(e)}`);
  }
}

export async function uploadVideo(path: string) {
  set({ uploadingVideo: true, progress: null });
  try {
    set({ gifUrl: await api.designerUploadVideo(path) });
  } catch (e) {
    toast('error', `Preview video: ${errorMessage(e)}`);
  } finally {
    set({ uploadingVideo: false, progress: null });
  }
}

/** Missing store details, in words; empty when the step is complete. */
export function detailProblems(s: Pick<PublishState, 'form' | 'tags'> & { updateOf?: UpdateTarget | null }): string[] {
  const out: string[] = [];
  const f = s.form;
  if (!f.productName.trim()) out.push('a theme name');
  else if (f.productName.length > 18) out.push('a theme name of up to 18 characters');
  if (!f.versionName.trim()) out.push('a version');
  if (!f.designerName.trim() || !f.authorName.trim()) out.push('designer and author');
  if (!f.description.trim()) out.push('a description');
  if (!s.tags.length) out.push('at least one tag');
  if (s.updateOf?.live) {
    if (f.versionName.trim() && f.versionName.trim() === s.updateOf.versionName.trim()) out.push(`a version newer than ${s.updateOf.versionName}`);
    if (!f.changeLog.trim()) out.push('what changed in this version');
  }
  return out;
}

/** What the proof is made of, as ticked in the file tree. */
export function proofSelection(s: Pick<PublishState, 'excludedArtwork' | 'extraFiles' | 'excludedExtra'>) {
  return { includeArtwork: true, excludeArtwork: s.excludedArtwork, extraFiles: s.extraFiles, excludeExtra: s.excludedExtra };
}

/** Picked files that are still ticked. */
export function ticked(s: Pick<PublishState, 'extraEntries' | 'excludedExtra'>): DesignerProofEntry[] {
  const out = new Set(s.excludedExtra);
  return s.extraEntries.filter((e) => !out.has(e.path));
}

async function rescanExtras(paths: string[]) {
  try {
    const entries = paths.length ? await api.designerProofScan(paths) : [];
    set({ extraEntries: entries });
  } catch (e) {
    toast('error', `Could not read the files: ${errorMessage(e)}`);
  }
}

/** Adds files or folders; everything inside a folder starts ticked. */
export async function addProofPaths(picked: string[]) {
  const extraFiles = Array.from(new Set([...get().extraFiles, ...picked]));
  set({ extraFiles });
  await rescanExtras(extraFiles);
}

export async function removeProofRoot(root: string) {
  const extraFiles = get().extraFiles.filter((f) => f !== root);
  const gone = get().extraEntries.filter((e) => e.root === root).map((e) => e.path);
  set((s) => ({ extraFiles, excludedExtra: s.excludedExtra.filter((p) => !gone.includes(p)) }));
  await rescanExtras(extraFiles);
}

/** Ticks or unticks files in the tree ('artwork' = the theme's images, 'extra' = picked files). */
export function setProofIncluded(kind: 'artwork' | 'extra', keys: string[], include: boolean) {
  set((s) => {
    const current = kind === 'artwork' ? s.excludedArtwork : s.excludedExtra;
    const next = new Set(current);
    for (const k of keys) include ? next.delete(k) : next.add(k);
    return kind === 'artwork' ? { excludedArtwork: [...next] } : { excludedExtra: [...next] };
  });
}

/** Saves the designer's own proof (their files, untouched) where they want it. */
async function exportOwnProof() {
  const s = get();
  if (!ticked(s).length) {
    toast('warning', 'Tick at least one file for your proof of copyright first.');
    return;
  }
  const output = await saveDialog({
    title: 'Export proof of copyright',
    defaultPath: `${s.form.productName.replace(/[\\/:*?"<>|]/g, '').trim() || 'theme'} - proof of copyright.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (!output) return;
  try {
    const result = await api.designerProofBuild({ output, title: s.form.productName, designer: s.form.designerName, ...proofSelection(s), includeArtwork: false, sources: '', ownFiles: true });
    toast('success', `Proof of copyright exported: ${plural(result.files, 'file')}, ${formatBytes(result.bytes)}.`, result.path, [
      { label: 'Show in folder', run: () => void revealItemInDir(result.path) },
    ]);
  } catch (e) {
    toast('error', `Export proof of copyright: ${errorMessage(e)}`);
  }
}

/**
 * Exports the proof-of-copyright ZIP to a place the user picks. Works without signing in
 * and outside the publish flow; a publish in progress for this project lends its choices
 * (added files, third-party notes, artwork), otherwise the theme's details are used.
 */
export async function exportProof() {
  const project = useStore.getState().project;
  if (!project) return;
  const s = get();
  const sameProject = s.projectId === projectId(project);
  if (sameProject && s.ownProof) return exportOwnProof();
  let title = sameProject ? s.form.productName.trim() : '';
  let designer = sameProject ? s.form.designerName.trim() : '';
  if (!title || !designer) {
    try {
      const info = await api.designerProofInfo();
      title ||= info.title.trim();
      designer ||= (info.designer || info.author).trim();
    } catch {
      // Fall back to the project name below.
    }
  }
  title ||= project.title.trim() || project.name.replace(/\.(mtz|zip)$/i, '');
  designer ||= useStore.getState().designer?.nickname?.trim() ?? '';
  if (!designer) {
    toast('warning', 'Add a designer name in the theme details first; the copyright declaration is made in that name.', undefined, [
      { label: 'Theme details', run: () => goTo('design', 'info') },
    ]);
    return;
  }
  const output = await saveDialog({
    title: 'Export proof of copyright',
    defaultPath: `${title.replace(/[\\/:*?"<>|]/g, '').trim() || 'theme'} - proof of copyright.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (!output) return;
  useStore.setState({ busy: 'Building proof of copyright…' });
  try {
    const result = await api.designerProofBuild({
      output,
      title,
      designer,
      ...(sameProject ? proofSelection(s) : proofSelection({ excludedArtwork: [], extraFiles: [], excludedExtra: [] })),
      sources: sameProject ? s.sources : '',
      workingFiles: sameProject ? s.workingFiles : 'included',
      aiText: sameProject ? s.aiText : '',
      process: sameProject ? s.process : '',
    });
    toast('success', `Proof of copyright exported: ${plural(result.files, 'file')}, ${formatBytes(result.bytes)}.`, result.path, [
      { label: 'Show in folder', run: () => void revealItemInDir(result.path) },
    ]);
  } catch (e) {
    toast('error', `Export proof of copyright: ${errorMessage(e)}`);
  } finally {
    useStore.setState({ busy: null });
  }
}

/**
 * Everything the website makes you click through, in one go: build and upload the
 * package, build and upload the proof of copyright, submit. Finished uploads are reused
 * when nothing they depend on has changed, so a retry continues where it failed.
 */
export async function runPublish() {
  if (get().running) return;
  const problems = detailProblems(get());
  if (problems.length) {
    toast('warning', `Still needed: ${problems.join(', ')}.`);
    set({ step: 'details' });
    return;
  }
  if (get().ownProof && !ticked(get()).length) {
    toast('warning', 'Add the files that make up your proof of copyright, or let the app build it.');
    set({ step: 'proof' });
    return;
  }
  set({ running: true, taskError: null, tasks: { ...IDLE_TASKS } });
  const mark = (id: TaskId, state: TaskState) => set((s) => ({ tasks: { ...s.tasks, [id]: state } }));
  let current: TaskId = 'package';
  try {
    const pk = packageKey();
    if (get().audit?.key !== pk) {
      mark('package', 'running');
      const data = await api.designerUploadPackage(get().miuiVersion, undefined, get().updateOf?.productId);
      set({ audit: { data, key: pk } });
    }
    mark('package', 'done');

    current = 'proof';
    const prk = proofKey();
    let proof = get().proof;
    if (proof?.key !== prk) {
      mark('proof', 'running');
      const s = get();
      const result = await api.designerProofBuild({
        title: s.form.productName,
        designer: s.form.designerName,
        ...proofSelection(s),
        sources: s.sources,
        workingFiles: s.workingFiles,
        aiText: s.aiText,
        process: s.process,
        ownFiles: s.ownProof,
      });
      proof = { ...result, key: prk };
      set({ proof, copyright: null });
    }
    mark('proof', 'done');

    current = 'proofUpload';
    let copyright = get().copyright;
    if (copyright?.key !== prk) {
      mark('proofUpload', 'running');
      copyright = { file: await api.designerUploadCopyright(proof.path), key: prk };
      set({ copyright });
    }
    mark('proofUpload', 'done');

    current = 'submit';
    mark('submit', 'running');
    const s = get();
    await api.designerSubmit({
      auditId: s.audit!.data.auditId,
      ...s.form,
      tags: s.tags,
      copyrightLocator: copyright.file.fileId,
      copyrightFilename: copyright.file.filename,
      gifUrl: s.gifUrl,
      changeLog: s.updateOf?.live ? s.form.changeLog : null,
    });
    mark('submit', 'done');
    set({ step: 'done' });
    toast('success', s.updateOf?.live ? `Version ${s.form.versionName} submitted for review.` : 'Submitted to Xiaomi Themes for review.');
    void refreshPublished();
  } catch (e) {
    mark(current, 'error');
    set({ taskError: errorMessage(e) });
    // The station consumes an audit on submit; a failed submit may need a fresh upload.
    if (current === 'submit') set({ audit: null });
  } finally {
    set({ running: false, progress: null });
  }
}

// ----- published themes ------------------------------------------------------------

interface PublishedState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  rows: DesignerProductRow[];
}

export const usePublished = create<PublishedState>(() => ({ loading: false, loaded: false, error: null, rows: [] }));

export async function refreshPublished() {
  if (!useStore.getState().designer?.signedIn) {
    usePublished.setState({ rows: [], loaded: false, error: null });
    return;
  }
  usePublished.setState({ loading: true, error: null });
  try {
    const answer = await api.designerProducts();
    usePublished.setState({ rows: answer?.data ?? [], loaded: true });
  } catch (e) {
    usePublished.setState({ error: errorMessage(e) });
  } finally {
    usePublished.setState({ loading: false });
  }
}

export type ReviewTone = 'blue' | 'orange' | 'green' | 'red' | 'grey' | 'online';

/** The station's own wording for an audit or product state. */
export function reviewState(row: Pick<DesignerProductRow, 'auditState' | 'productStatus'>): { label: string; tone: ReviewTone; hint: string } {
  const a = row.auditState ?? '';
  if (a) {
    if (['EDITING', 'SNAPSHOT', 'WAIT_SNAPSHOT', 'SNAPSHOT_PROCESS'].includes(a)) return { label: 'Making screenshots', tone: 'blue', hint: 'Xiaomi is generating the store screenshots; review comes next.' };
    if (a === 'WAIT_AUDIT') return { label: 'Waiting for review', tone: 'orange', hint: 'In the review queue.' };
    if (a === 'WAIT_ONLINE' || a === 'GOING_ONLINE') return { label: 'Approved, going live', tone: 'green', hint: 'Approved; it will appear in the Themes app shortly.' };
    if (a === 'REJECTED') return { label: 'Rejected', tone: 'red', hint: 'See the reason, fix it and publish a new version.' };
    return { label: 'Review state unknown', tone: 'grey', hint: a };
  }
  const p = row.productStatus ?? '';
  if (p === 'ONLINE') return { label: 'Live', tone: 'online', hint: 'Available in the Themes app.' };
  if (p === 'OFFLINE') return { label: 'Taken down', tone: 'grey', hint: 'No longer in the store.' };
  if (p === 'HIDDEN') return { label: 'Hidden', tone: 'grey', hint: 'Not listed in the store.' };
  return { label: p || 'Unknown', tone: 'grey', hint: '' };
}

/** Rejection reasons come as an object of messages (empty when there are none). */
export function refusalReasons(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(refusalReasons);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(refusalReasons);
  return [];
}

/** Whether the station accepts a new version now (same rules as its website). */
export function canUpdate(row: Pick<DesignerProductRow, 'auditState' | 'productStatus'>): boolean {
  const a = row.auditState ?? '';
  if (a === 'REJECTED') return true;
  if (a) return false;
  return ['ONLINE', 'HIDDEN', 'OFFLINE'].includes(row.productStatus ?? '');
}
