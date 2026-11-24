import { AlertTriangle, CircleX, Info, RefreshCw, Wrench } from 'lucide-react';
import type { Issue } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';
import { api } from '../../lib/api';
import { lineOf } from '../../lib/mamlEdit';

export function issueIcon(issue: Issue) {
  if (issue.severity === 'error') return <CircleX className="err" />;
  if (issue.severity === 'warning') return <AlertTriangle className="warn" />;
  return <Info style={{ color: 'var(--info)' }} />;
}

function openIssue(issue: Issue) {
  const state = useStore.getState();
  if (!issue.path) return;
  if (state.fileIndex.has(issue.path)) {
    const path = issue.path;
    A.openFile(path);
    A.revealInExplorer(path);
    void revealIssueLine(path, issue.message);
  } else {
    A.toggleExpanded(issue.path, 'main', true);
    A.select(issue.path, 'single');
  }
}

/**
 * Problems carry a file, not a line. Find the line from what the message names
 * (`bg12.png`, or "line 12" for syntax errors), then jump there and highlight it.
 */
async function revealIssueLine(path: string, message: string) {
  const info = useStore.getState().fileIndex.get(path);
  if (!info || (info.kind !== 'xml' && info.kind !== 'text')) return;
  const lineNo = /\bline (\d+)/i.exec(message);
  const byteAt = /\bat byte (\d+)/i.exec(message);
  const token = /`([^`]+)`/.exec(message)?.[1] ?? /“([^”]+)”/.exec(message)?.[1];
  try {
    if (lineNo) return A.revealInFile(path, Number(lineNo[1]), 1, 0);
    if (byteAt) {
      // Syntax errors point at a UTF-8 byte offset in the BOM-less text.
      const { text } = await api.fileText(path);
      const at = charIndexOfByte(text, Number(byteAt[1]));
      const { line, column } = lineOf(text, at);
      return A.revealInFile(path, line, column, 0);
    }
    if (!token) return;
    const { text } = await api.fileText(path);
    // Prefer the name inside quotes (an attribute value), then anywhere.
    let at = text.search(new RegExp(`["'/]${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`));
    at = at >= 0 ? at + 1 : text.indexOf(token);
    if (at < 0) return;
    const { line, column } = lineOf(text, at);
    A.revealInFile(path, line, column, token.length);
  } catch {
    // The file opens either way; only the jump is skipped.
  }
}

/** The UTF-16 index in `text` where UTF-8 byte offset `byte` falls. */
function charIndexOfByte(text: string, byte: number) {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byte) {
    const cp = text.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

export function ProblemList({ limit }: { limit?: number }) {
  const validation = useStore((s) => s.validation);
  if (!validation) return <div className="tree-empty">Validation has not run yet.</div>;
  if (!validation.issues.length) return <div className="tree-empty">No problems found in {validation.checkedFiles} files.</div>;
  const issues = limit ? validation.issues.slice(0, limit) : validation.issues;
  const convertible = validation.issues.filter((i) => i.fix === 'convert-format' && i.path).map((i) => i.path!);
  return (
    <div role="list">
      {convertible.length > 1 && (
        <div className="problem-row problem-bulk">
          <RefreshCw className="warn" />
          <span className="ellipsis">{convertible.length} images are stored in a different format than their extension says.</span>
          <button className="btn btn-sm btn-primary" title="Re-encode each file to the format its extension names; names and references stay the same" onClick={() => void A.convertImages(convertible)}>
            <Wrench /> Convert all
          </button>
        </div>
      )}
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
          {issue.fix === 'convert-format' && issue.path && (
            <button
              className="btn btn-sm"
              title="Re-encode the file to the format its extension names"
              onClick={(e) => {
                e.stopPropagation();
                void A.convertImages([issue.path!]);
              }}
            >
              <Wrench /> Convert
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
