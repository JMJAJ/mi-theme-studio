// Publishing to the Xiaomi Theme Design Station as a guided flow. The state lives here
// (not in the view) so leaving the Publish tab and coming back keeps your place.
import { create } from 'zustand';
import {
  api,
  errorMessage,
  type DesignerCopyrightFile,
  type DesignerPackageAudit,
  type DesignerProofInfo,
  type DesignerProductDetail,
  type DesignerProductRow,
  type DesignerTagGroup,
  type DesignerUploadProgress,
} from '../lib/api';
import type { ProjectSnapshot } from '../lib/types';
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
  /** What changed; only for a new version of a published theme. */
  changeLog: string;
}

/** The published theme a new version is for. */
export interface UpdateTarget {
  productId: string;
  productName: string;
  /** Version currently on the station. */
  versionName: string;
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
  includeArtwork: boolean;
  extraFiles: string[];
  sources: string;
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
  includeArtwork: true,
  extraFiles: [],
  sources: '',
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

function proofKey(): string {
  const s = get();
  return hash(JSON.stringify([s.form.productName, s.form.designerName, s.includeArtwork, s.extraFiles, s.sources, packageKey()]));
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
    ? { productId: update.productId, productName: update.productName, versionName: update.versionName ?? '' }
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
  if (s.updateOf) {
    if (f.versionName.trim() && f.versionName.trim() === s.updateOf.versionName.trim()) out.push(`a version newer than ${s.updateOf.versionName}`);
    if (!f.changeLog.trim()) out.push('what changed in this version');
  }
  return out;
}

/** Saves a copy of the proof ZIP where the user wants it. */
export async function buildProofCopy(output: string) {
  const s = get();
  try {
    const result = await api.designerProofBuild({
      output,
      title: s.form.productName,
      designer: s.form.designerName,
      includeArtwork: s.includeArtwork,
      extraFiles: s.extraFiles,
      sources: s.sources,
    });
    toast('success', `Saved ${result.path}`);
  } catch (e) {
    toast('error', `Proof of copyright: ${errorMessage(e)}`);
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
        includeArtwork: s.includeArtwork,
        extraFiles: s.extraFiles,
        sources: s.sources,
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
      changeLog: s.updateOf ? s.form.changeLog : null,
    });
    mark('submit', 'done');
    set({ step: 'done' });
    toast('success', s.updateOf ? `Version ${s.form.versionName} submitted for review.` : 'Submitted to Xiaomi Themes for review.');
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

/** Whether the station accepts a new version now (same rules as its website). */
export function canUpdate(row: Pick<DesignerProductRow, 'auditState' | 'productStatus'>): boolean {
  const a = row.auditState ?? '';
  if (a === 'REJECTED') return true;
  if (a) return false;
  return ['ONLINE', 'HIDDEN', 'OFFLINE'].includes(row.productStatus ?? '');
}
