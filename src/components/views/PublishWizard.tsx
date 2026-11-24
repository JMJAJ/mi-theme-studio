// Publish to Xiaomi Themes, one step at a time. Details come from the theme, the proof of
// copyright is put together automatically, and Submit does every upload in one go.
import { useEffect, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleUserRound,
  CircleX,
  ExternalLink,
  FileArchive,
  Film,
  Loader2,
  LogIn,
  PartyPopper,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { formatBytes, plural } from '../../lib/format';
import { useStore } from '../../state/store';
import {
  PUBLISH_STEPS,
  TASKS,
  buildProofCopy,
  cancelPublishing,
  detailProblems,
  loadTags,
  pausePublishing,
  refreshProofInfo,
  runPublish,
  setStep,
  signIn,
  signOut,
  updateForm,
  uploadVideo,
  usePublish,
  usePublished,
  canUpdate,
  startPublishing,
  type PublishStep,
} from '../../state/publish';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../state/store';

const STATION = 'https://zhuti.designer.intl.xiaomi.com/';
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function PublishWizard() {
  const step = usePublish((s) => s.step);
  const running = usePublish((s) => s.running);
  const signedIn = useStore((s) => !!s.designer?.signedIn);
  const order: PublishStep[] = ['account', 'details', 'proof', 'submit', 'done'];
  const at = order.indexOf(step);
  const updateOf = usePublish((s) => s.updateOf);

  return (
    <div className="view">
      <div className="view-pad publish-view">
        <div className="view-header">
          <div>
            <h1>{updateOf ? `New version of ${updateOf.productName}` : 'Publish to Xiaomi Themes'}</h1>
            <div className="sub">
              {updateOf
                ? `Uploads the open project as an update to ${updateOf.productName}${updateOf.versionName ? ` (now ${updateOf.versionName})` : ''} and sends it for review.`
                : 'Sends this theme to the Xiaomi Theme Design Station for review, the same way the website does.'}{' '}
              Your progress is kept if you leave this page.
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={pausePublishing} disabled={running}>
              <ArrowLeft /> Check & export
            </button>
            {step !== 'done' && (
              <button className="btn" onClick={cancelPublishing} disabled={running}>
                Cancel publishing
              </button>
            )}
          </div>
        </div>

        {step !== 'done' && (
          <ol className="stepper" aria-label="Publishing steps">
            {PUBLISH_STEPS.map((s, i) => {
              const done = i < at || (s.id === 'account' && signedIn);
              const current = s.id === step;
              const reachable = signedIn || s.id === 'account';
              return (
                <li key={s.id} className={`${current ? 'is-current' : ''} ${done ? 'is-done' : ''}`}>
                  <button disabled={running || current || !reachable} onClick={() => setStep(s.id)} aria-current={current ? 'step' : undefined}>
                    <span className="stepper-dot">{done && !current ? <Check /> : i + 1}</span>
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        <div className="surface surface-pad publish-card">
          {step === 'account' && <AccountStep />}
          {step === 'details' && <DetailsStep />}
          {step === 'proof' && <ProofStep />}
          {step === 'submit' && <SubmitStep />}
          {step === 'done' && <DoneStep />}
        </div>
      </div>
    </div>
  );
}

function StepNav({ back, next, nextLabel, nextDisabled, hint }: { back?: PublishStep; next?: () => void; nextLabel?: string; nextDisabled?: boolean; hint?: string }) {
  return (
    <div className="publish-nav">
      {back && (
        <button className="btn" onClick={() => setStep(back)}>
          <ArrowLeft /> Back
        </button>
      )}
      <span className="grow muted">{hint}</span>
      {next && (
        <button className="btn btn-primary" onClick={next} disabled={nextDisabled}>
          {nextLabel ?? 'Next'} <ArrowRight />
        </button>
      )}
    </div>
  );
}

function AccountStep() {
  const designer = useStore((s) => s.designer);
  const signingIn = usePublish((s) => s.signingIn);
  if (designer?.signedIn) {
    return (
      <>
        <h2>Account</h2>
        <div className="row publish-account">
          {designer.profilePic ? <img src={designer.profilePic} alt="" className="publish-avatar" /> : <CircleUserRound />}
          <div className="grow">
            <b>{designer.nickname ?? 'Designer'}</b>
            <div className="muted">{designer.registrationStatus === 'VERIFIED' ? 'Verified designer' : designer.registrationStatus?.toLowerCase() ?? ''}</div>
          </div>
          <button className="btn btn-sm" onClick={() => void signOut()}>Use another account</button>
        </div>
        <StepNav next={() => setStep('details')} />
      </>
    );
  }
  return (
    <div className="publish-signin">
      <CircleUserRound className="publish-signin-icon" />
      <h2>Sign in to the Theme Design Station</h2>
      <p className="muted">
        Use the Mi account your designer profile is registered with. Xiaomi’s own sign-in page opens in a new window: enter your password, then the code Xiaomi e-mails or texts you. The window closes by itself when you’re in, and you stay signed in next time.
      </p>
      <button className="btn btn-primary" onClick={() => void signIn()}>
        {signingIn ? <Loader2 className="spin" /> : <LogIn />} {signingIn ? 'Waiting for you to sign in…' : 'Sign in with Mi account'}
      </button>
      {designer?.message && <div className="field-error">{designer.message}</div>}
      <div className="field-hint">
        Not a designer yet?{' '}
        <button className="btn-link" onClick={() => void openUrl(STATION)}>Register on the Design Station</button>
      </div>
    </div>
  );
}

function DetailsStep() {
  const form = usePublish((s) => s.form);
  const tags = usePublish((s) => s.tags);
  const tagGroups = usePublish((s) => s.tagGroups);
  const miuiVersion = usePublish((s) => s.miuiVersion);
  const gifUrl = usePublish((s) => s.gifUrl);
  const uploadingVideo = usePublish((s) => s.uploadingVideo);
  const progress = usePublish((s) => s.progress);
  const [tagInput, setTagInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => void loadTags(), []);

  const setTags = (next: string[]) => usePublish.setState({ tags: next });
  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tags.includes(tag) || /[,;]/.test(tag) || tags.length >= 10) return;
    setTags([...tags, tag]);
  };
  const updateOf = usePublish((s) => s.updateOf);
  const published = usePublished((s) => s.rows);
  const problems = detailProblems({ form, tags, updateOf });
  // Same name as a theme already on the station: offer to publish it as a new version.
  const existing = !updateOf ? published.find((r) => r.productName.trim().toLowerCase() === form.productName.trim().toLowerCase()) : undefined;
  const field = (key: keyof typeof form) => ({ value: form[key], onChange: (e: { target: { value: string } }) => updateForm({ [key]: e.target.value }) });

  return (
    <>
      <h2>Store details</h2>
      <p className="muted publish-lead">
        {updateOf ? `Taken from ${updateOf.productName} on the store; give it a new version number and say what changed.` : 'Filled in from the theme’s details. This is what people see in the Themes app.'}
      </p>
      {existing && (
        <div className="publish-callout is-warn">
          <AlertTriangle />
          <div className="grow">
            You already published a theme called “{existing.productName}”. A second theme with the same name is usually rejected.
            {canUpdate(existing) ? ' Publish this as a new version of it instead?' : ' Its current review has to finish before it can take a new version.'}
          </div>
          {canUpdate(existing) && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  startPublishing(await api.designerProduct(existing.productId));
                } catch (e) {
                  toast('error', errorMessage(e));
                }
              }}
            >
              Make it a new version
            </button>
          )}
        </div>
      )}
      {updateOf && (
        <div className="field">
          <label>What’s new in this version</label>
          <textarea className="textarea" rows={3} {...field('changeLog')} maxLength={1000} placeholder="New icons for…, fixed the clock on…" />
        </div>
      )}
      <div className="publish-grid">
        <div className="field">
          <label>Theme name</label>
          <input className="input" {...field('productName')} maxLength={18} />
          <span className="field-hint">{form.productName.length}/18</span>
        </div>
        <div className="field">
          <label>Version</label>
          <input className="input" {...field('versionName')} />
          {updateOf?.versionName && <span className="field-hint">On the store: {updateOf.versionName}</span>}
        </div>
        <div className="field">
          <label>Designer</label>
          <input className="input" {...field('designerName')} maxLength={20} />
        </div>
        <div className="field">
          <label>Author</label>
          <input className="input" {...field('authorName')} maxLength={20} />
        </div>
        <div className="field">
          <label>Works on</label>
          <select className="select" value={miuiVersion} onChange={(e) => usePublish.setState({ miuiVersion: e.target.value as 'V12' | 'V15' | 'V17' })}>
            {updateOf && <option value="V12">MIUI 12</option>}
            <option value="V15">Xiaomi HyperOS</option>
            <option value="V17">Xiaomi HyperOS 3</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="textarea" rows={3} {...field('description')} maxLength={1000} />
      </div>
      <div className="field">
        <label>Tags <span className="muted">· up to 6 recommended{tagGroups.length && tags.length ? ', suggested from your theme’s keywords' : ''}</span></label>
        {tags.length > 0 && (
          <div className="chips">
            {tags.map((t) => (
              <span key={t} className="chip" aria-pressed="true">
                {t}
                <button className="chip-x" aria-label={`Remove ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><X /></button>
              </span>
            ))}
          </div>
        )}
        <div className="row">
          <input
            className="input grow"
            value={tagInput}
            placeholder="Type a tag and press Enter"
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addTag(tagInput);
                setTagInput('');
              }
            }}
          />
          <button className="btn btn-sm" onClick={() => setPickerOpen((v) => !v)} disabled={!tagGroups.length} aria-expanded={pickerOpen}>
            {pickerOpen ? 'Hide tags' : 'Browse tags'}
          </button>
        </div>
        {pickerOpen && (
          <div className="publish-tags">
            {tagGroups.map((g) => (
              <div key={g.name}>
                <div className="field-label">{g.name}</div>
                <div className="chips">
                  {g.subTags.map((t) => (
                    <button key={t} className="chip" aria-pressed={tags.includes(t)} onClick={() => (tags.includes(t) ? setTags(tags.filter((x) => x !== t)) : addTag(t))}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="field">
        <label>Preview video <span className="muted">· needed for dynamic (animated) themes. MP4 up to 20 MB, recorded on a Xiaomi phone; seconds 4–8 become the preview.</span></label>
        <div className="row">
          <button
            className="btn btn-sm"
            disabled={uploadingVideo}
            onClick={async () => {
              const picked = await openDialog({ filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
              if (typeof picked === 'string') void uploadVideo(picked);
            }}
          >
            {uploadingVideo ? <Loader2 className="spin" /> : <Film />} {uploadingVideo ? `Uploading${progress?.total ? ` ${Math.round((progress.sent / progress.total) * 100)}%` : '…'}` : gifUrl ? 'Replace video…' : 'Add video…'}
          </button>
          {gifUrl && (
            <>
              <img src={gifUrl} alt="Preview" className="publish-gif" />
              <button className="btn btn-sm btn-icon" aria-label="Remove video" onClick={() => usePublish.setState({ gifUrl: null })}><X /></button>
            </>
          )}
        </div>
      </div>
      <div className="field">
        <label>Note for the reviewer <span className="muted">· optional</span></label>
        <textarea className="textarea" rows={2} {...field('talkToUs')} maxLength={1000} placeholder="Special features, anything the reviewer should know" />
      </div>
      <StepNav next={() => setStep('proof')} nextDisabled={problems.length > 0} hint={problems.length ? `Still needed: ${problems.join(', ')}.` : undefined} />
    </>
  );
}

function ProofStep() {
  const info = usePublish((s) => s.proofInfo);
  const includeArtwork = usePublish((s) => s.includeArtwork);
  const extraFiles = usePublish((s) => s.extraFiles);
  const sources = usePublish((s) => s.sources);
  const form = usePublish((s) => s.form);
  useEffect(() => void refreshProofInfo(), []);
  const hasPsd = extraFiles.some((f) => /\.(psd|psb|ai|kra|procreate|afdesign|fig|sketch|xd)$/i.test(f));

  return (
    <>
      <h2>Proof of copyright</h2>
      <p className="muted publish-lead">
        Xiaomi asks for one ZIP that shows the theme is yours. The app builds it for you when you submit: a signed copyright declaration, a list of third-party material, a checksum manifest, and the files below.
      </p>

      {info && info.attributions.length > 0 && <Disclosure attributions={info.attributions} />}

      <div className="publish-checklist">
        <label className="publish-check">
          <input type="checkbox" checked={includeArtwork} onChange={(e) => usePublish.setState({ includeArtwork: e.target.checked })} />
          <div>
            <b>The theme’s artwork at full resolution</b>
            <div className="muted">{info ? `${plural(info.artworkFiles, 'image')}, ${formatBytes(info.artworkBytes)}` : 'Every image in the package'}</div>
          </div>
        </label>

        <div className={`publish-check ${hasPsd ? '' : 'is-suggested'}`}>
          {hasPsd ? <CircleCheck className="ok" /> : <AlertTriangle className="warn" />}
          <div className="grow">
            <b>Source files</b>
            <div className="muted">Layered PSD (or AI, Procreate, Figma…) files, sketches, work in progress. The strongest proof you made it.</div>
          </div>
        </div>
        <div className="publish-check">
          <span className="publish-check-pad" />
          <div className="grow muted">
            If the design shows a real person: their signed image-consent form, plus a photo of you holding your photo ID.
          </div>
        </div>
      </div>

      <div className="field">
        <div className="row">
          <label className="field-label grow">Files to include</label>
          <button
            className="btn btn-sm"
            onClick={async () => {
              const picked = await openDialog({ multiple: true, title: 'Add source files, licences, consent forms…' });
              const list = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
              if (list.length) usePublish.setState({ extraFiles: Array.from(new Set([...extraFiles, ...list])) });
            }}
          >
            <Plus /> Add files…
          </button>
        </div>
        {extraFiles.length ? (
          <div className="publish-files">
            {extraFiles.map((f) => (
              <div key={f} className="row">
                <FileArchive className="muted" />
                <span className="grow" title={f}>{fileName(f)}</span>
                <button className="btn btn-sm btn-icon" aria-label={`Remove ${fileName(f)}`} onClick={() => usePublish.setState({ extraFiles: extraFiles.filter((x) => x !== f) })}><X /></button>
              </div>
            ))}
          </div>
        ) : (
          <div className="field-hint">None added. The proof still works without them, but source files make approval much more likely.</div>
        )}
      </div>

      <div className="field">
        <label>Third-party or free-licensed material <span className="muted">· leave empty if you made everything</span></label>
        <textarea
          className="textarea"
          rows={3}
          value={sources}
          onChange={(e) => usePublish.setState({ sources: e.target.value })}
          placeholder={'Background photo: Unsplash, https://unsplash.com/photos/…, Unsplash License (commercial use allowed)\nFont: Inter, SIL Open Font License 1.1'}
        />
      </div>

      <div className="row">
        <button
          className="btn btn-sm"
          onClick={async () => {
            const output = await saveDialog({
              defaultPath: `${form.productName.replace(/[\\/:*?"<>|]/g, '').trim() || 'theme'} - proof of copyright.zip`,
              filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
            });
            if (output) void buildProofCopy(output);
          }}
        >
          <FileArchive /> Save a copy of the ZIP…
        </button>
        <span className="field-hint">Optional, to check what will be sent.</span>
      </div>

      <StepNav back="details" next={() => setStep('submit')} />
    </>
  );
}

/** Material from other themes: disclosed in the proof without the user doing anything. */
function Disclosure({ attributions }: { attributions: NonNullable<ReturnType<typeof usePublish.getState>['proofInfo']>['attributions'] }) {
  const [open, setOpen] = useState(false);
  const files = attributions.reduce((n, a) => n + a.files, 0);
  return (
    <div className="publish-disclosure">
      <div className="row">
        <CircleCheck className="ok" />
        <div className="grow">
          <b>{plural(files, 'file')} from other themes will be disclosed automatically</b>
          <div className="muted">
            Found by comparing file contents with where they came from: {attributions.map((a) => `“${a.sourceTitle}”${a.sourceAuthor ? ` by ${a.sourceAuthor}` : ''}`).join(', ')}. SOURCES.txt lists each source and every affected file; nothing for you to fill in. Replace a file and it drops off this list.
          </div>
        </div>
        <button className="btn btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide files' : 'Show files'}</button>
      </div>
      {open && (
        <div className="publish-disclosure-list">
          {attributions.map((a) => (
            <div key={`${a.sourceTitle}|${a.origin}`}>
              <div className="field-label">{a.sourceTitle}{a.sourceAuthor ? ` · ${a.sourceAuthor}` : ''}{a.origin ? ` · ${a.origin}` : ''}</div>
              <ul>
                {a.paths.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="field-hint">Xiaomi may still ask for the owner’s permission for reused artwork; if you have it, add it under Files to include.</div>
    </div>
  );
}

function SubmitStep() {
  const s = usePublish();
  const designer = useStore((st) => st.designer);
  const percent = s.progress?.total ? Math.round((s.progress.sent / s.progress.total) * 100) : null;
  const started = Object.values(s.tasks).some((t) => t !== 'idle');

  return (
    <>
      <h2>Submit</h2>
      <div className="publish-summary">
        <div><span className="muted">{s.updateOf ? 'New version' : 'Theme'}</span>{s.form.productName} {s.form.versionName}{s.updateOf?.versionName ? ` (was ${s.updateOf.versionName})` : ''}</div>
        {s.updateOf && <div><span className="muted">What’s new</span>{s.form.changeLog}</div>}
        <div><span className="muted">Works on</span>{s.miuiVersion === 'V17' ? 'Xiaomi HyperOS 3' : 'Xiaomi HyperOS'}</div>
        <div><span className="muted">Designer</span>{s.form.designerName}{s.form.authorName !== s.form.designerName ? ` · author ${s.form.authorName}` : ''}</div>
        <div><span className="muted">Tags</span>{s.tags.join(', ')}</div>
        <div><span className="muted">Preview video</span>{s.gifUrl ? 'Added' : 'None'}</div>
        <div><span className="muted">Proof</span>{s.extraFiles.length ? plural(s.extraFiles.length, 'added file') : 'Generated'}{s.includeArtwork ? ' + artwork' : ''}</div>
        <div><span className="muted">Account</span>{designer?.nickname ?? '—'}</div>
      </div>

      {started && (
        <ul className="publish-tasks">
          {TASKS.map((t) => {
            const state = s.tasks[t.id];
            return (
              <li key={t.id} className={`is-${state}`}>
                {state === 'done' ? <CircleCheck className="ok" /> : state === 'running' ? <Loader2 className="spin" /> : state === 'error' ? <CircleX className="err" /> : <span className="publish-task-dot" />}
                <span className="grow">{t.label}</span>
                {state === 'running' && percent !== null && (t.id === 'package' || t.id === 'proofUpload') && (
                  <span className="muted">{percent >= 100 ? 'Processing…' : `${percent}%`}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {s.running && percent !== null && percent < 100 && (
        <div className="progress"><i style={{ width: `${percent}%` }} /></div>
      )}
      {s.taskError && (
        <div className="publish-callout is-err">
          <CircleX />
          <div>{s.taskError}</div>
        </div>
      )}

      <div className="publish-nav">
        <button className="btn" onClick={() => setStep('proof')} disabled={s.running}>
          <ArrowLeft /> Back
        </button>
        <span className="grow muted">The theme is built from the open project, so unsaved changes are included.</span>
        <button className="btn btn-primary" onClick={() => void runPublish()} disabled={s.running}>
          {s.running ? <Loader2 className="spin" /> : <Send />} {s.running ? 'Publishing…' : s.taskError ? 'Try again' : 'Submit for review'}
        </button>
      </div>
    </>
  );
}

function DoneStep() {
  const name = usePublish((s) => s.form.productName);
  return (
    <div className="publish-signin">
      <PartyPopper className="publish-signin-icon ok" />
      <h2>{name} is submitted</h2>
      <p className="muted">Xiaomi reviews new themes, usually within a few working days. You’ll get a notification on the Design Station, where you can also follow the status.</p>
      <div className="row">
        <button className="btn" onClick={() => void openUrl(STATION)}><ExternalLink /> Open Design Station</button>
        <button className="btn btn-primary" onClick={cancelPublishing}>Done</button>
      </div>
    </div>
  );
}
