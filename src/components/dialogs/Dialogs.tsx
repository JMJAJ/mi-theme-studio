import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleX, Copy, Info, Loader2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { buildTree, folderOptions } from '../../lib/tree';
import { displayFolder } from '../../lib/paths';
import { formatBytes, plural } from '../../lib/format';
import type { ConflictPolicy, CopyPlanItem } from '../../lib/types';
import { closeDialog, dismissToast, useStore, type DialogState } from '../../state/store';
import * as A from '../../state/actions';
import { SettingsPanel } from './SettingsPanel';
import { Modal } from '../common/Modal';

function ConfirmDialog({ dialog }: { dialog: Extract<DialogState, { type: 'confirm' }> }) {
  const done = (value: boolean) => {
    closeDialog();
    dialog.resolve(value);
  };
  return (
    <Modal
      title={dialog.title}
      icon={dialog.danger ? <AlertTriangle width={17} className="err" /> : <Info width={17} className="muted" />}
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)} data-autofocus>
            {dialog.confirmLabel}
          </button>
        </>
      }
    >
      <p className="message">{dialog.message}</p>
      {dialog.detail && dialog.detail.length > 0 && (
        <ul className="mono" style={{ fontSize: 13 }}>
          {dialog.detail.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
function PromptDialog({ dialog }: { dialog: Extract<DialogState, { type: 'prompt' }> }) {
  const [value, setValue] = useState(dialog.initial);
  const ref = useRef<HTMLInputElement>(null);
  const error = dialog.validate?.(value) ?? null;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = dialog.selectStem ? value.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const done = (result: string | null) => {
    closeDialog();
    dialog.resolve(result);
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => done(null)}
      initialFocus="input"
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!error} onClick={() => done(value.trim())}>
            {dialog.confirmLabel}
          </button>
        </>
      }
    >
      {dialog.message && <p>{dialog.message}</p>}
      <div className="field">
        <label htmlFor="prompt-input">{dialog.label}</label>
        <input
          id="prompt-input"
          ref={ref}
          className="input"
          value={value}
          aria-invalid={!!error}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !error) done(value.trim());
          }}
        />
        {error && value !== dialog.initial && <span className="field-error">{error}</span>}
      </div>
    </Modal>
  );
}

function ChoiceDialog({ dialog }: { dialog: Extract<DialogState, { type: 'choice' }> }) {
  const done = (id: string) => {
    closeDialog();
    dialog.resolve(id);
  };
  const cancel = dialog.choices.find((c) => c.id === 'cancel')?.id ?? dialog.choices[dialog.choices.length - 1].id;
  return (
    <Modal
      title={dialog.title}
      onClose={() => done(cancel)}
      footer={dialog.choices.map((choice) => (
        <button key={choice.id} className={`btn ${choice.primary ? 'btn-primary' : choice.danger ? 'btn-danger' : ''}`} onClick={() => done(choice.id)} data-autofocus={choice.primary ? true : undefined}>
          {choice.label}
        </button>
      ))}
    >
      <p className="message">{dialog.message}</p>
    </Modal>
  );
}

function CopyPlanDialog({ paths, initialPolicy = 'skip', title = 'Copy from reference' }: { paths: string[]; initialPolicy?: ConflictPolicy; title?: string }) {
  const project = useStore((s) => s.project);
  const [mode, setMode] = useState<'same' | 'folder'>('same');
  const [folder, setFolder] = useState('');
  const [policy, setPolicy] = useState<ConflictPolicy>(initialPolicy);
  const [plan, setPlan] = useState<CopyPlanItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = useMemo(() => (project ? folderOptions(buildTree(project.files, project.containers)) : []), [project]);

  useEffect(() => {
    setPlan(null);
    api
      .referencePlan(paths, mode === 'same' ? null : folder)
      .then((p) => {
        setPlan(p);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [paths, mode, folder]);

  const conflicts = plan?.filter((p) => p.conflict).length ?? 0;
  return (
    <Modal
      wide
      title={title}
      icon={<Copy width={16} className="muted" />}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!plan?.length || busy}
            onClick={async () => {
              setBusy(true);
              const ok = await A.copyFromReference(paths, mode === 'same' ? null : folder, policy);
              setBusy(false);
              if (ok) closeDialog();
            }}
          >
            {busy && <Loader2 className="spin" />} Copy {plan ? plural(plan.length, 'file') : ''}
          </button>
        </>
      }
    >
      <p>Files are copied into your project as new, undoable changes. The reference package is not modified, and the source theme is recorded in the package report.</p>
      <div className="row wrap">
        <div className="segmented" role="group" aria-label="Destination">
          <button aria-pressed={mode === 'same'} onClick={() => setMode('same')}>
            Same paths
          </button>
          <button aria-pressed={mode === 'folder'} onClick={() => setMode('folder')}>
            Into folder
          </button>
        </div>
        {mode === 'folder' && (
          <select className="select" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Destination folder">
            <option value="">Package root</option>
            {folders.map((f) => (
              <option key={f.key} value={f.key}>
                {' '.repeat(f.depth * 3)}
                {displayFolder(f.key)}
              </option>
            ))}
          </select>
        )}
        <span className="grow" />
        <label className="field-label">If a file exists</label>
        <select className="select" value={policy} onChange={(e) => setPolicy(e.target.value as ConflictPolicy)} aria-label="Conflict handling">
          <option value="skip">Skip it</option>
          <option value="rename">Keep both (rename)</option>
          <option value="overwrite">Replace it</option>
        </select>
      </div>
      {error && (
        <div className="banner banner-err">
          <AlertTriangle /> {error}
        </div>
      )}
      {plan && (
        <>
          <p className={conflicts ? 'warn' : 'muted'}>
            {plural(plan.length, 'file')} · {formatBytes(plan.reduce((n, p) => n + p.size, 0))}
            {conflicts ? ` · ${conflicts} already exist in your project` : ' · no conflicts'}
          </p>
          <div className="surface" style={{ maxHeight: 260, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Destination</th>
                  <th className="num">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plan.slice(0, 400).map((item) => (
                  <tr key={item.source}>
                    <td className="mono" title={`from ${item.source}`}>
                      {item.destination}
                    </td>
                    <td className="num">{formatBytes(item.size)}</td>
                    <td>{item.conflict && <span className="badge badge-warn">exists</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function MoveDialog({ paths }: { paths: string[] }) {
  const project = useStore((s) => s.project);
  const folders = useMemo(() => (project ? folderOptions(buildTree(project.files, project.containers)) : []), [project]);
  const [folder, setFolder] = useState('');
  const [custom, setCustom] = useState('');
  const target = custom.trim() || folder;
  return (
    <Modal
      title={`Move ${plural(paths.length, 'item')}`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              closeDialog();
              void A.movePaths(paths, target);
            }}
          >
            Move
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="move-folder">Existing folder</label>
        <select id="move-folder" className="select" value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">Package root</option>
          {folders.map((f) => (
            <option key={f.key} value={f.key}>
              {' '.repeat(f.depth * 3)}
              {displayFolder(f.key)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="move-custom">Or a new folder path</label>
        <input id="move-custom" className="input" placeholder="e.g. wallpaper/extra or icons!/res/drawable-xxhdpi" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <span className="field-hint">Use “name!/path” to address a folder inside a component archive.</span>
      </div>
    </Modal>
  );
}





export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'confirm':
      return <ConfirmDialog dialog={dialog} />;
    case 'prompt':
      return <PromptDialog dialog={dialog} />;
    case 'choice':
      return <ChoiceDialog dialog={dialog} />;
    case 'copyPlan':
      return <CopyPlanDialog paths={dialog.paths} initialPolicy={dialog.policy} title={dialog.title} />;
    case 'move':
      return <MoveDialog paths={dialog.paths} />;
    case 'settings':
      return <SettingsPanel initial={dialog.section} />;
    case 'shortcuts':
      return <SettingsPanel initial="keys" />;
    case 'about':
      return <SettingsPanel initial="about" />;
  }
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.level === 'error' ? <CircleX className="err" /> : t.level === 'warning' ? <AlertTriangle className="warn" /> : t.level === 'success' ? <CircleCheck className="ok" /> : <Info style={{ color: 'var(--info)' }} />}
          <span className="grow">{t.message}</span>
          {t.actions?.map((a) => (
            <button
              key={a.label}
              className="btn btn-sm toast-action"
              onClick={() => {
                dismissToast(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
