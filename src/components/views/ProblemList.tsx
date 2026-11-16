import { AlertTriangle, CircleX, Info, Wrench } from 'lucide-react';
import type { Issue } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';

export function issueIcon(issue: Issue) {
  if (issue.severity === 'error') return <CircleX className="err" />;
  if (issue.severity === 'warning') return <AlertTriangle className="warn" />;
  return <Info style={{ color: 'var(--info)' }} />;
}

function openIssue(issue: Issue) {
  const state = useStore.getState();
  if (!issue.path) return;
  if (state.fileIndex.has(issue.path)) {
    A.openFile(issue.path);
    A.revealInExplorer(issue.path);
  } else {
    A.toggleExpanded(issue.path, 'main', true);
    A.select(issue.path, 'single');
  }
}

export function ProblemList({ limit }: { limit?: number }) {
  const validation = useStore((s) => s.validation);
  if (!validation) return <div className="tree-empty">Validation has not run yet.</div>;
  if (!validation.issues.length) return <div className="tree-empty">No problems found in {validation.checkedFiles} files.</div>;
  const issues = limit ? validation.issues.slice(0, limit) : validation.issues;
  return (
    <div role="list">
      {issues.map((issue, i) => (
        <div
          key={i}
          role="listitem"
          className="problem-row"
          tabIndex={0}
          onClick={() => openIssue(issue)}
          onKeyDown={(e) => e.key === 'Enter' && openIssue(issue)}
          title={issue.code}
        >
          {issueIcon(issue)}
          <span className="ellipsis">{issue.message}</span>
          {issue.fix === 'pack-folder' && issue.path && (
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                void A.packFolder(issue.path!);
              }}
            >
              <Wrench /> Pack folder
            </button>
          )}
          {issue.fix === 'create-description' && (
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                void A.createDescription();
              }}
            >
              <Wrench /> Create
            </button>
          )}
          {issue.path && <span className="path">{issue.path}</span>}
        </div>
      ))}
      {limit && validation.issues.length > limit && <div className="tree-empty">…and {validation.issues.length - limit} more in the Problems panel.</div>}
    </div>
  );
}
