// Tools the assistant can call. Each one reads or changes the open theme
// through the same native commands the editors use, so every change is one
// undoable step. Changes ask for approval unless auto-apply is on.
import { api, errorCode, errorMessage } from '../lib/api';
import { fileName } from '../lib/paths';
import { getState, setState } from './store';
import * as A from './actions';
import { applyEdits, lineDiff, lineSpan, locate, parseToolArgs, type EditLocation } from '../lib/aiEdits';

export type { EditLocation };

const GUIDES = import.meta.glob('../../docs/maml/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const GUIDE_PAGES = new Map(Object.entries(GUIDES).map(([path, src]) => [path.replace(/^.*\/(.+)\.md$/, '$1'), src]));

const MAX_READ = 40_000;
const MAX_RESULT = 24_000;

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_theme_overview',
      description: 'Title, theme details (description.xml), parts present, file counts, the file open in the editor, and validation problems. Call this first when you need context.',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the theme. Paths inside a part archive look like "lockscreen!/advance/manifest.xml".',
      parameters: obj({ folder: str('Only files under this folder or archive, e.g. "lockscreen!/" or "wallpaper".'), query: str('Only paths containing this text.') }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text/XML file. Shows the unapplied editor draft if the person is editing it. Large files: use start_line/end_line.',
      parameters: obj({ path: str('File path'), start_line: { type: 'integer' }, end_line: { type: 'integer' } }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Find text in every text file of the theme.',
      parameters: obj({ query: str('Text or regular expression'), regex: { type: 'boolean' }, include: str('Optional path filter, e.g. "*.xml" or "lockscreen"') }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Change part of a text file by exact replacement. Each old_text must appear exactly once (or set replace_all). Prefer this over write_file for existing files. XML must stay well-formed.',
      parameters: obj(
        {
          path: str('File path'),
          edits: {
            type: 'array',
            items: obj({ old_text: str('Exact text currently in the file'), new_text: str('Replacement'), replace_all: { type: 'boolean' } }, ['old_text', 'new_text']),
          },
        },
        ['path', 'edits'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new text file or replace a whole file. XML must be well-formed.',
      parameters: obj({ path: str('File path'), content: str('Full file contents') }, ['path', 'content']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_files',
      description: 'Delete files or folders from the theme.',
      parameters: obj({ paths: { type: 'array', items: { type: 'string' } } }, ['paths']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_theme_details',
      description: 'Change theme details in description.xml (fields such as title, author, designer, version, uiVersion).',
      parameters: obj({ fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field name → new value' } }, ['fields']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_theme',
      description: 'Validate the theme package and list errors and warnings.',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_guide',
      description: `Read the built-in MAML (lock screen markup) guide. Pages: ${[...GUIDE_PAGES.keys()].join(', ')}.`,
      parameters: obj({ page: str('Page name') }, ['page']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Open a file in the editor so the person can see it.',
      parameters: obj({ path: str('File path') }, ['path']),
    },
  },
];

export const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'delete_files', 'set_theme_details']);

/** A change waiting for the person's yes. */
export interface Proposal {
  title: string;
  /** Unified-ish preview of what changes. */
  diff?: string;
}

export interface ToolContext {
  /** Resolves true when the change may go ahead. */
  approve: (proposal: Proposal) => Promise<boolean>;
}

export interface ToolOutcome {
  result: string;
  /** One line for the chat card. */
  summary: string;
  ok: boolean;
  /** Where a change landed. */
  locations?: EditLocation[];
}


const clip = (text: string, max = MAX_RESULT) => (text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text);

function needProject() {
  const project = getState().project;
  if (!project) throw new Error('No theme is open. Ask the person to create or open a theme first.');
  return project;
}

function args(raw: string): Record<string, unknown> {
  const parsed = parseToolArgs(raw);
  if (!parsed) throw new Error(`The tool arguments were not valid JSON (got: ${String(raw).slice(0, 120)}). Send them again as one JSON object.`);
  return parsed;
}

const asString = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required.`);
  return v.trim();
};

async function currentText(path: string): Promise<string | null> {
  const draft = getState().drafts[path];
  if (draft) return draft.text;
  if (!getState().fileIndex.has(path)) return null;
  return (await api.fileText(path, 'main')).text;
}


async function writeText(path: string, text: string): Promise<string | null> {
  try {
    const snapshot = await api.fileWriteText(path, text, false);
    A.discardDraft(path);
    A.applySnapshot(snapshot);
    return null;
  } catch (error) {
    if (errorCode(error) === 'xml_invalid') return `${errorMessage(error)} Nothing was changed; fix the XML and try again.`;
    return errorMessage(error);
  }
}

async function run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case 'get_theme_overview': {
      const state = getState();
      const project = needProject();
      const meta = await api.metadataGet('main').catch(() => null);
      const parts = new Map<string, number>();
      for (const f of project.files) parts.set(f.component, (parts.get(f.component) ?? 0) + 1);
      const label = (id: string) => project.components.find((c) => c.id === id)?.label ?? id;
      const tab = state.tabs.find((t) => t.id === state.activeTab);
      const v = state.validation;
      const lines = [
        `Theme: ${project.title}${project.dirty ? ' (unsaved changes)' : ''}`,
        `Files: ${project.files.length}, archives: ${project.containers.map((c) => c.name).join(', ') || 'none'}`,
        `Parts: ${[...parts].map(([id, n]) => `${label(id)} [${id}] ${n} files`).join('; ')}`,
        `Known parts: ${project.components.map((c) => `${c.id} (${c.label}${c.archive ? `, archive ${c.defaultRoot}` : c.defaultRoot ? `, folder ${c.defaultRoot}` : ''})`).join('; ')}`,
        meta?.exists ? `description.xml: ${meta.fields.map((f) => `${f.name}=${f.value}`).join('; ')}` : 'description.xml: missing',
        tab?.path ? `Open in editor: ${tab.path}` : `App section: ${state.section}${state.part ? ` / ${state.part}` : ''}`,
        state.selection.length ? `Selected: ${state.selection.slice(0, 10).join(', ')}` : '',
        v ? `Validation: ${v.errors} errors, ${v.warnings} warnings` : '',
        ...(v?.issues ?? []).filter((i) => i.severity !== 'info').slice(0, 15).map((i) => `  ${i.severity}: ${i.message}${i.path ? ` (${i.path})` : ''}`),
      ];
      return { ok: true, summary: 'Looked at the theme', result: lines.filter(Boolean).join('\n') };
    }
    case 'list_files': {
      const project = needProject();
      const folder = typeof input.folder === 'string' ? input.folder.trim() : '';
      const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const files = project.files.filter((f) => (!folder || f.path.startsWith(folder)) && (!query || f.path.toLowerCase().includes(query)));
      const rows = files.slice(0, 500).map((f) => `${f.path}\t${f.kind}\t${f.size}B${f.width ? `\t${f.width}x${f.height}` : ''}${f.status !== 'original' ? `\t${f.status}` : ''}`);
      return {
        ok: true,
        summary: `Listed ${files.length} file${files.length === 1 ? '' : 's'}${folder || query ? ` in ${folder || query}` : ''}`,
        result: rows.length ? `${rows.join('\n')}${files.length > 500 ? `\n… ${files.length - 500} more; narrow with folder/query` : ''}` : 'No files match.',
      };
    }
    case 'read_file': {
      needProject();
      const path = asString(input.path, 'path');
      const info = getState().fileIndex.get(path);
      if (!info && !getState().drafts[path]) throw new Error(`There is no file ${path}. Use list_files to find the right path.`);
      if (info && !['xml', 'text', 'binaryXml'].includes(info.kind)) {
        return { ok: true, summary: `Checked ${fileName(path)}`, result: `${path} is a ${info.kind} file (${info.size} bytes${info.width ? `, ${info.width}x${info.height}` : ''}). Its contents cannot be read as text.` };
      }
      const text = (await currentText(path)) ?? '';
      const lines = text.split('\n');
      const startLine = Number(input.start_line) || 0;
      const endLine = Number(input.end_line) || 0;
      if (startLine || endLine || text.length > MAX_READ) {
        const from = Math.max(1, startLine || 1);
        let to = Math.min(lines.length, endLine || lines.length);
        let body = lines.slice(from - 1, to);
        while (body.join('\n').length > MAX_READ && body.length > 1) body = body.slice(0, Math.ceil(body.length / 2));
        to = from + body.length - 1;
        return {
          ok: true,
          summary: `Read ${fileName(path)} lines ${from}–${to}`,
          result: `${path} lines ${from}-${to} of ${lines.length}:\n${body.join('\n')}`,
        };
      }
      return { ok: true, summary: `Read ${fileName(path)}`, result: `${path} (${lines.length} lines${getState().drafts[path] ? ', unapplied draft' : ''}):\n${text}` };
    }
    case 'search_files': {
      needProject();
      const query = asString(input.query, 'query');
      const res = await api.projectSearch({ query, regex: !!input.regex, caseSensitive: false, wholeWord: false, include: typeof input.include === 'string' ? input.include : '' });
      const rows = res.files.flatMap((f) => f.matches.slice(0, 20).map((m) => `${f.path}:${m.line}: ${m.preview.trim()}`)).slice(0, 200);
      return { ok: true, summary: `Searched for "${query}" (${res.total} matches)`, result: rows.length ? rows.join('\n') + (res.truncated ? '\n… more matches cut' : '') : 'No matches.' };
    }
    case 'edit_file': {
      needProject();
      const path = asString(input.path, 'path');
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      if (!edits.length) throw new Error('"edits" needs at least one {old_text, new_text}.');
      const before = await currentText(path);
      if (before === null) throw new Error(`There is no file ${path}. Use write_file to create it.`);
      const { after, diff, locations } = applyEdits(path, before, edits);
      if (after === before) return { ok: true, summary: `No change to ${fileName(path)}`, result: 'The edits left the file unchanged.' };
      if (!(await ctx.approve({ title: `Edit ${path}`, diff }))) return { ok: false, summary: `Edit to ${fileName(path)} declined`, result: 'The person declined this change. Ask what they want instead.' };
      const error = await writeText(path, after);
      if (error) return { ok: false, summary: `Could not edit ${fileName(path)}`, result: error };
      const where = locations.map(lineSpan).join(', ');
      return { ok: true, summary: `Edited ${fileName(path)}`, locations, result: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${path}; changed ${where}.` };
    }
    case 'write_file': {
      needProject();
      const path = asString(input.path, 'path');
      const content = typeof input.content === 'string' ? input.content : '';
      const before = await currentText(path).catch(() => null);
      const proposal = before === null ? { title: `Create ${path}`, diff: lineDiff('', content) } : { title: `Replace ${path}`, diff: lineDiff(before, content) };
      if (!(await ctx.approve(proposal))) return { ok: false, summary: `${proposal.title} declined`, result: 'The person declined this change.' };
      const error = await writeText(path, content);
      if (error) return { ok: false, summary: `Could not write ${fileName(path)}`, result: error };
      // Point at the first line that differs (line 1 for a new file).
      let first = 0;
      if (before !== null) while (first < before.length && first < content.length && before[first] === content[first]) first++;
      const lineStart = content.lastIndexOf('\n', first - 1) + 1;
      const location = locate(path, content, lineStart, Math.max(0, content.indexOf('\n', lineStart) === -1 ? content.length - lineStart : content.indexOf('\n', lineStart) - lineStart));
      return { ok: true, summary: before === null ? `Created ${fileName(path)}` : `Rewrote ${fileName(path)}`, locations: [location], result: `Wrote ${path} (${content.split('\n').length} lines).` };
    }
    case 'delete_files': {
      needProject();
      const paths = (Array.isArray(input.paths) ? input.paths : []).filter((p): p is string => typeof p === 'string' && !!p.trim());
      if (!paths.length) throw new Error('"paths" is empty.');
      if (!(await ctx.approve({ title: `Delete ${paths.length} item${paths.length === 1 ? '' : 's'}`, diff: paths.map((p) => `- ${p}`).join('\n') }))) {
        return { ok: false, summary: 'Delete declined', result: 'The person declined deleting these.' };
      }
      const snapshot = await api.filesDelete(paths);
      A.applySnapshot(snapshot);
      return { ok: true, summary: `Deleted ${paths.length} item${paths.length === 1 ? '' : 's'}`, result: `Deleted: ${paths.join(', ')}` };
    }
    case 'set_theme_details': {
      needProject();
      const fields = input.fields && typeof input.fields === 'object' ? Object.entries(input.fields as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value ?? '') })) : [];
      if (!fields.length) throw new Error('"fields" is empty.');
      const meta = await api.metadataGet('main').catch(() => null);
      const old = new Map(meta?.fields.map((f) => [f.name, f.value]) ?? []);
      const diff = fields.map((f) => `- ${f.name}: ${old.get(f.name) ?? ''}\n+ ${f.name}: ${f.value}`).join('\n');
      if (!(await ctx.approve({ title: 'Change theme details', diff }))) return { ok: false, summary: 'Theme details change declined', result: 'The person declined.' };
      const snapshot = await api.metadataUpdate(fields, 'Theme details (assistant)');
      A.applySnapshot(snapshot);
      // Find each field's element in description.xml for the "go to line" buttons.
      const xml = await api.fileText('description.xml', 'main').then((t) => t.text).catch(() => '');
      const locations = fields
        .map((f) => {
          const at = xml.search(new RegExp(`<${f.name.replace(/[^\w.-]/g, '')}[\\s>]`));
          return at < 0 ? null : locate('description.xml', xml, at, xml.indexOf('\n', at) === -1 ? xml.length - at : xml.indexOf('\n', at) - at);
        })
        .filter((l): l is EditLocation => !!l);
      return { ok: true, summary: `Updated ${fields.map((f) => f.name).join(', ')}`, locations, result: 'Theme details updated.' };
    }
    case 'check_theme': {
      needProject();
      const report = await api.validate();
      setState({ validation: report });
      const issues = report.issues.filter((i) => i.severity !== 'info').slice(0, 80);
      return {
        ok: true,
        summary: `Checked the theme: ${report.errors} errors, ${report.warnings} warnings`,
        result: [`${report.errors} errors, ${report.warnings} warnings (${report.checkedFiles} files checked)`, ...issues.map((i) => `${i.severity}: ${i.message}${i.path ? ` [${i.path}]` : ''}`)].join('\n'),
      };
    }
    case 'read_guide': {
      const page = asString(input.page, 'page').replace(/\.md$/, '');
      const src = GUIDE_PAGES.get(page) ?? GUIDE_PAGES.get(page.toLowerCase());
      if (!src) throw new Error(`No guide page "${page}". Pages: ${[...GUIDE_PAGES.keys()].join(', ')}`);
      return { ok: true, summary: `Read the guide: ${page}`, result: src };
    }
    case 'open_file': {
      needProject();
      const path = asString(input.path, 'path');
      if (!getState().fileIndex.has(path)) throw new Error(`There is no file ${path}.`);
      A.openFile(path);
      return { ok: true, summary: `Opened ${fileName(path)}`, result: `Opened ${path} in the editor.` };
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const outcome = await run(name, args(rawArgs), ctx);
    return { ...outcome, result: clip(outcome.result) };
  } catch (error) {
    const message = errorMessage(error);
    return { ok: false, summary: message, result: `Error: ${message}` };
  }
}

/** A short label for a tool call while it runs. */
export function toolLabel(name: string, rawArgs: string): string {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(rawArgs || '{}');
  } catch {
    /* partial */
  }
  const path = typeof input.path === 'string' ? fileName(input.path) : '';
  switch (name) {
    case 'get_theme_overview':
      return 'Looking at the theme';
    case 'list_files':
      return 'Listing files';
    case 'read_file':
      return `Reading ${path}`;
    case 'search_files':
      return `Searching for "${String(input.query ?? '')}"`;
    case 'edit_file':
      return `Editing ${path}`;
    case 'write_file':
      return `Writing ${path}`;
    case 'delete_files':
      return 'Deleting files';
    case 'set_theme_details':
      return 'Changing theme details';
    case 'check_theme':
      return 'Checking the theme';
    case 'read_guide':
      return `Reading the guide (${String(input.page ?? '')})`;
    case 'open_file':
      return `Opening ${path}`;
    default:
      return name;
  }
}
