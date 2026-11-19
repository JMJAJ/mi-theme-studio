// Pure helpers for the assistant's file edits: apply exact replacements,
// find where they landed, and show a compact diff.

/** A changed range, 1-based, in the shape the editor's reveal takes. */
export interface EditLocation {
  path: string;
  line: number;
  column: number;
  length: number;
  endLine: number;
}

/** Line/column (in characters, like the editor) of a range in `text`. */
export function locate(path: string, text: string, offset: number, length: number): EditLocation {
  const head = text.slice(0, offset);
  const lineStart = head.lastIndexOf('\n') + 1;
  const line = head.split('\n').length;
  const segment = text.slice(offset, offset + length);
  const firstLine = segment.split('\n')[0];
  return { path, line, column: [...head.slice(lineStart)].length + 1, length: [...firstLine].length, endLine: line + (segment.match(/\n/g)?.length ?? 0) };
}

export const lineSpan = (l: EditLocation) => (l.endLine > l.line ? `lines ${l.line}-${l.endLine}` : `line ${l.line}`);

/** Apply exact replacements, tracking where each new text ends up. */
export function applyEdits(path: string, text: string, edits: Record<string, unknown>[]): { after: string; diff: string; locations: EditLocation[] } {
  let after = text;
  const ranges: { start: number; length: number }[] = [];
  const hunks: string[] = [];
  for (const [i, edit] of edits.entries()) {
    const oldText = typeof edit.old_text === 'string' ? edit.old_text : '';
    const newText = typeof edit.new_text === 'string' ? edit.new_text : '';
    if (!oldText) throw new Error(`Edit ${i + 1}: old_text is empty.`);
    const hits: number[] = [];
    for (let at = after.indexOf(oldText); at !== -1; at = after.indexOf(oldText, at + oldText.length)) hits.push(at);
    if (!hits.length) throw new Error(`Edit ${i + 1}: old_text was not found in ${path}. Read the file again and copy the text exactly.`);
    if (hits.length > 1 && !edit.replace_all) throw new Error(`Edit ${i + 1}: old_text appears ${hits.length} times; add more surrounding text or set replace_all.`);
    const delta = newText.length - oldText.length;
    const step = after;
    // Back to front, so earlier offsets stay valid while replacing.
    for (const at of [...hits].reverse()) {
      after = after.slice(0, at) + newText + after.slice(at + oldText.length);
      for (const r of ranges) if (r.start > at) r.start += delta;
    }
    hits.forEach((at, n) => ranges.push({ start: at + n * delta, length: newText.length }));
    if (step !== after) hunks.push(lineDiff(step, after));
  }
  ranges.sort((a, b) => a.start - b.start);
  return { after, diff: hunks.join('\n'), locations: ranges.map((r) => locate(path, after, r.start, r.length)) };
}

/** Changed lines with a little context, like a compact unified diff. */
export function lineDiff(before: string, after: string, context = 2, maxLines = 120): string {
  // CRLF files: compare and show lines without the carriage return.
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  const from = Math.max(0, start - context);
  out.push(`@@ line ${start + 1}`);
  for (let i = from; i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + context); i++) out.push(`  ${a[i]}`);
  if (out.length > maxLines) return `${out.slice(0, maxLines).join('\n')}\n… ${out.length - maxLines} more lines`;
  return out.join('\n');
}

/**
 * Tool-call arguments as an object. Small models sometimes wrap the JSON in
 * code fences or add a stray ")" after it, so fall back to the outermost {...}.
 */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  const asObject = (text: string) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const text = (raw ?? '').trim();
  if (!text) return {};
  const direct = asObject(text);
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? asObject(text.slice(start, end + 1)) : null;
}
