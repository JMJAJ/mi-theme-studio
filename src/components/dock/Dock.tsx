import { useEffect, useRef } from 'react';
import { Eraser, X } from 'lucide-react';
import { setState, updateLayout, useStore, type DockTab } from '../../state/store';
import { formatBytes, formatTime } from '../../lib/format';
import * as A from '../../state/actions';
import { ProblemList } from '../views/ProblemList';

const EMPTY_HISTORY: never[] = [];

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

function OutputLog() {
  const logs = useStore((s) => s.logs);
  const ref = useAutoScroll(logs.length);
  return (
    <div className="dock-body" ref={ref} role="log" aria-live="polite">
      {logs.length === 0 && <div className="tree-empty">No messages yet.</div>}
      {logs.map((entry) => (
        <div key={entry.id} className="log-row">
          <span className="time">{formatTime(entry.atMs)}</span>
          <span className={`lvl lvl-${entry.level}`}>{entry.level === 'success' ? 'OK' : entry.level.toUpperCase().slice(0, 4)}</span>
          <span className="msg">
            {entry.message}
            {entry.detail ? ` — ${entry.detail}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function AdbLog() {
  const log = useStore((s) => s.adbLog);
  const ref = useAutoScroll(log.length);
  return (
    <div className="dock-body" ref={ref} role="log">
      {log.length === 0 && <div className="tree-empty">No ADB commands have run yet. Routine device polling is not logged unless it fails.</div>}
      {log.map((entry) => (
        <div key={entry.id} className="log-row">
          <span className="time">{formatTime(entry.atMs)}</span>
          <span className={`lvl ${entry.ok ? 'lvl-success' : 'lvl-error'}`}>{entry.ok ? 'OK' : entry.code === null ? 'FAIL' : `E${entry.code}`}</span>
          <span className="msg">
            <span style={{ color: 'var(--text)' }}>{entry.command}</span> <span className="faint">{entry.durationMs} ms</span>
            {entry.summary ? <span> — {entry.summary}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function BuildLog() {
  const builds = useStore((s) => s.builds);
  const progress = useStore((s) => s.exportProgress);
  return (
    <div className="dock-body">
      {progress && (
        <div className="log-row">
          <span className="lvl lvl-info">RUN</span>
          <span className="msg">
            {progress.stage} {progress.total ? `${progress.done}/${progress.total}` : ''}
          </span>
        </div>
      )}
      {builds.length === 0 && !progress && <div className="tree-empty">No builds in this session. Save or export to create one.</div>}
      {builds.map((b) => (
        <div key={b.atMs} className="log-row">
          <span className="time">{formatTime(b.atMs)}</span>
          <span className="lvl lvl-success">OK</span>
          <span className="msg">
            {b.mode === 'copy' ? 'Exported copy' : 'Saved'} {b.path} · {formatBytes(b.bytes)} · {b.entries} entries · verified in {b.durationMs} ms
            {b.backupPath ? ` · backup: ${b.backupPath}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function HistoryPanel() {
  const history = useStore((s) => s.project?.history) ?? EMPTY_HISTORY;
  const ref = useAutoScroll(history.length);
  if (!history.length) return <div className="dock-body"><div className="tree-empty">No edits yet. Every change appears here and can be undone.</div></div>;
  const lastDone = [...history].reverse().find((h) => h.done);
  return (
    <div className="dock-body" ref={ref}>
      <div className="problem-row" onClick={() => void A.historyGoto(null)} title="Return to the state when the package was opened">
        <span className="faint">◦</span>
        <span className={!lastDone ? '' : 'muted'}>Opened package</span>
      </div>
      {history.map((h) => (
        <div key={h.id} className="problem-row" onClick={() => void A.historyGoto(h.id)} style={{ opacity: h.done ? 1 : 0.5 }} title={h.done ? 'Go back to this step' : 'Redo up to this step'}>
          <span className={h.id === lastDone?.id ? 'ok' : 'faint'}>{h.id === lastDone?.id ? '●' : '◦'}</span>
          <span className="ellipsis">{h.label}</span>
          <span className="path">
            {h.files} files · {formatTime(h.atMs)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Dock() {
  const tab = useStore((s) => s.dockTab);
  const validation = useStore((s) => s.validation);
  const logCount = useStore((s) => s.logs.filter((l) => l.level === 'error').length);
  const tabs: [DockTab, string][] = [
    ['problems', `Problems${validation ? ` ${validation.errors + validation.warnings}` : ''}`],
    ['output', `Output${logCount ? ` (${logCount} errors)` : ''}`],
    ['adb', 'ADB'],
    ['build', 'Build'],
    ['history', 'History'],
  ];
  return (
    <section className="dock" aria-label="Bottom panel">
      <div className="dock-head">
        <div className="panel-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setState({ dockTab: id })}>
              {label}
            </button>
          ))}
        </div>
        <span className="grow" />
        {tab === 'output' && (
          <button className="btn btn-ghost btn-icon btn-sm" title="Clear output" aria-label="Clear output" onClick={() => setState({ logs: [] })}>
            <Eraser />
          </button>
        )}
        <button className="btn btn-ghost btn-icon btn-sm" title="Hide panel (Ctrl+J)" aria-label="Hide panel" onClick={() => updateLayout({ dock: false })}>
          <X />
        </button>
      </div>
      {tab === 'problems' && (
        <div className="dock-body">
          <ProblemList />
        </div>
      )}
      {tab === 'output' && <OutputLog />}
      {tab === 'adb' && <AdbLog />}
      {tab === 'build' && <BuildLog />}
      {tab === 'history' && <HistoryPanel />}
    </section>
  );
}
