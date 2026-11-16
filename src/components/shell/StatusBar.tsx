import { AlertTriangle, CircleCheck, CircleX, HardDrive, History, Loader2, Smartphone } from 'lucide-react';
import { useStore, setState, updateLayout } from '../../state/store';
import { formatBytes, formatTime, plural } from '../../lib/format';
import { openSingleton, cancelOperations, operations } from '../../state/actions';
import { useDeviceSummary } from './deviceSummary';

export function StatusBar() {
  const project = useStore((s) => s.project);
  const validation = useStore((s) => s.validation);
  const validating = useStore((s) => s.validating);
  const lastAutosave = useStore((s) => s.lastAutosave);
  const progress = useStore((s) => s.exportProgress);
  const busy = useStore((s) => s.busy);
  const settings = useStore((s) => s.settings);
  const selection = useStore((s) => s.selection.length);
  const device = useDeviceSummary();

  const showDock = (tab: 'problems' | 'history') => {
    updateLayout({ dock: true });
    setState({ dockTab: tab });
  };

  return (
    <footer className="statusbar">
      {project ? (
        <>
          <span className="sb-item" title={project.sourcePath ?? 'Not saved yet'}>
            <HardDrive /> {plural(project.files.length, 'file')} · {formatBytes(project.totalBytes)}
          </span>
          {selection > 1 && <span className="sb-item">{selection} selected</span>}
          <button className="sb-item" onClick={() => showDock('problems')} title="Show problems">
            {validating ? (
              <Loader2 className="spin" />
            ) : validation?.errors ? (
              <CircleX className="err" />
            ) : validation?.warnings ? (
              <AlertTriangle className="warn" />
            ) : (
              <CircleCheck className="ok" />
            )}
            {validation ? `${validation.errors} errors · ${validation.warnings} warnings` : 'Not validated'}
          </button>
          <button className="sb-item" onClick={() => showDock('history')} title="Edit history">
            <History /> {project.history.filter((h) => h.done).length} edits
          </button>
          {settings?.autosaveEnabled && (
            <span className="sb-item" title="Recovery copy in the app data folder (not your package file)">
              {lastAutosave ? `Recovery copy ${formatTime(lastAutosave.savedAtMs)}` : project.dirty ? 'Recovery copy pending' : 'Autosave on'}
            </span>
          )}
        </>
      ) : (
        <span className="sb-item">Ready</span>
      )}
      {progress && (
        <span className="sb-item" style={{ minWidth: 160 }}>
          {progress.stage === 'write' ? `Writing ${progress.done}/${progress.total}` : progress.stage === 'verify' ? 'Verifying…' : progress.stage === 'write-file' ? 'Writing file…' : 'Preparing…'}
          <span className="progress grow" style={{ width: 70 }}>
            <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </span>
        </span>
      )}
      <span className="spacer" />
      {busy && (
        <span className="sb-item">
          <Loader2 className="spin" /> {busy}
          {operations.size > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => void cancelOperations()}>
              Cancel
            </button>
          )}
        </span>
      )}
      <button className="sb-item" onClick={() => openSingleton('device')} title={device.title}>
        <span className={`dot dot-${device.tone}`} />
        <Smartphone /> {device.label}
      </button>
    </footer>
  );
}
