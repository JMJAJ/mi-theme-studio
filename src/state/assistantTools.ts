// Tools the assistant can call. Each one reads or changes the open theme
// through the same native commands the editors use, so every change is one
// undoable step. Changes ask for approval unless auto-apply is on.
import { api, errorCode, errorMessage, newOpId } from '../lib/api';
import { fileName, joinPath } from '../lib/paths';
import { getState, setState } from './store';
import * as A from './actions';
import { applyEdits, lineDiff, lineSpan, locate, parseToolArgs, type EditLocation } from '../lib/aiEdits';
import type { PermissionMode } from './assistantPermissions';

export type { EditLocation };

const GUIDES = import.meta.glob('../../docs/maml/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const GUIDE_PAGES = new Map(Object.entries(GUIDES).map(([path, src]) => [path.replace(/^.*\/(.+)\.md$/, '$1'), src]));

const MAX_READ = 40_000;
const MAX_RESULT = 24_000;
const DEFAULT_IMAGE_PALETTE = ['#26110E', '#773426', '#C24A1D', '#E68A23', '#F4D36A'];

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
      name: 'list_local_images',
      description: 'List raster image files directly inside a local folder on this PC. Use this to find a source image when the person gives you a folder path. It returns names, paths and sizes only; image contents stay local.',
      parameters: obj({ folder: str('Absolute path to a local folder on this PC') }, ['folder']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'colorize_image',
      description: 'Read a local JPG, PNG, WEBP, GIF or BMP image, convert each pixel to Rec. 709 grayscale luminance, map that luminance through an evenly spaced dark-to-light color palette, preserve alpha, encode a PNG, and add it to the open theme at target_path. Processing happens locally in the desktop app; source pixels are never sent to the AI provider. Omit palette to use dark brown → reddish brown → burnt orange → amber → gold. target_path must end in .png. The result is added as one undoable theme change and asks for approval unless auto-apply is enabled.',
      parameters: obj(
        {
          source_path: str('Absolute local path to the source raster image'),
          target_path: str('Destination PNG path inside the open theme, e.g. "lockscreen!/advance/cd/weather_tint.png"'),
          palette: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', description: 'A six-digit hex color, darkest first and lightest last, e.g. #26110E' } },
        },
        ['source_path', 'target_path'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Run a PowerShell command on Windows (or sh on macOS/Linux) in a local working directory. Use it for local tools such as Python. Only available in Supervised or Full access mode. Supervised asks the person to approve the exact command and directory first; Full access runs without that approval. Commands have a timeout of at most 300 seconds and bounded output.',
      parameters: obj(
        {
          command: str('The shell command to run, such as "python colorize.py input.jpg output.png"'),
          working_directory: str('Absolute local folder path to run the command in'),
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 300, description: 'Optional timeout; defaults to 60 seconds' },
        },
        ['command', 'working_directory'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'import_local_files',
      description: 'Import files created on this PC into the open theme. Use after local tools such as Python generate an asset. The files are copied into the theme through the app and become one undoable change. The destination folder is inside the theme; use an archive path like "lockscreen!/advance/cd" or an empty string for the theme root.',
      parameters: obj(
        {
          paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', description: 'Absolute path to a local file' } },
          folder: str('Destination folder inside the open theme; use an empty string for the root'),
        },
        ['paths'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_theme_files',
      description: 'Export files or folders from the open theme to an existing local folder on this PC. Use list_files to identify paths. A path may be a package file or folder; nested component archives use paths like "lockscreen!/advance" and export as normal folders. Pass an empty paths array to export the whole package. Original theme folder structure is preserved under destination_directory. This writes files outside the theme and is not undoable; only available in Supervised or Full access. Supervised asks before writing and shows the paths.',
      parameters: obj(
        {
          paths: { type: 'array', maxItems: 5000, items: { type: 'string', description: 'A file or folder path from list_files; use an empty array to export the whole package' } },
          destination_directory: str('Absolute path to an existing local destination folder on this PC'),
        },
        ['paths', 'destination_directory'],
      ),
    },
  },
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

export const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'delete_files', 'set_theme_details', 'colorize_image', 'import_local_files', 'export_theme_files', 'run_terminal']);

export function toolsForPermissionMode(permissionMode: PermissionMode) {
  return TOOL_SPECS.filter(({ function: tool }) => {
    if (permissionMode === 'read-only') return !WRITE_TOOLS.has(tool.name);
    if (permissionMode === 'workspace') return tool.name !== 'run_terminal' && tool.name !== 'export_theme_files';
    return true;
  });
}

/** A change waiting for the person's yes. */
export interface Proposal {
  title: string;
  /** Unified-ish preview of what changes. */
  diff?: string;
}

export interface ToolContext {
  /** Resolves true when the change may go ahead. */
  approve: (proposal: Proposal) => Promise<boolean>;
  permissionMode: PermissionMode;
  onTerminalRun?: (runId: string | null) => void;
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

function requireAbsolutePath(path: string, name: string) {
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) throw new Error(`"${name}" must be an absolute local path.`);
  return path;
}

function localBasename(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'file';
}

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

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function imagePalette(input: unknown): { colors: Rgb[]; labels: string[] } {
  const values = input === undefined || input === null ? DEFAULT_IMAGE_PALETTE : input;
  if (!Array.isArray(values) || values.length < 2 || values.length > 8) {
    throw new Error('palette must contain 2–8 six-digit hex colors, ordered from darkest to lightest.');
  }
  const labels = values.map((value) => {
    if (typeof value !== 'string' || !/^#?[\da-f]{6}$/i.test(value.trim())) {
      throw new Error('Each palette color must be a six-digit hex color such as #C24A1D.');
    }
    const hex = value.trim().replace(/^#/, '').toUpperCase();
    return `#${hex}`;
  });
  const colors = labels.map((hex) => ({
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }));
  return { colors, labels };
}

async function colorizeLocalImage(sourcePath: string, colors: Rgb[]): Promise<{ data: number[]; width: number; height: number }> {
  const local = await api.localImageRead(sourcePath);
  const sourceBuffer = new ArrayBuffer(local.data.length);
  new Uint8Array(sourceBuffer).set(local.data);
  const extension = sourcePath.split('.').pop()?.toLowerCase();
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'png' ? 'image/png'
      : extension === 'webp' ? 'image/webp'
        : extension === 'gif' ? 'image/gif'
          : 'image/bmp';
  const bitmap = await createImageBitmap(new Blob([sourceBuffer], { type: mime }));
  try {
    if (bitmap.width !== local.width || bitmap.height !== local.height) {
      throw new Error('The image decoder returned unexpected dimensions; nothing was imported.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The local image canvas is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const data = pixels.data;
    const segments = colors.length - 1;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const at = (y * bitmap.width + x) * 4;
        const luminance = (0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) / 255;
        const scaled = luminance * segments;
        const lower = Math.min(Math.floor(scaled), segments - 1);
        const mix = scaled - lower;
        const a = colors[lower];
        const b = colors[lower + 1];
        data[at] = Math.round(a.r + (b.r - a.r) * mix);
        data[at + 1] = Math.round(a.g + (b.g - a.g) * mix);
        data[at + 2] = Math.round(a.b + (b.b - a.b) * mix);
      }
      if ((y & 127) === 127) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    context.putImageData(pixels, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the colorized PNG.')), 'image/png');
    });
    const output = new Uint8Array(await png.arrayBuffer());
    canvas.width = 0;
    canvas.height = 0;
    return { data: Array.from(output), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

async function run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (WRITE_TOOLS.has(name) && ctx.permissionMode === 'read-only') {
    throw new Error('This chat is in Read only mode. Switch to a mode that allows changes before using this tool.');
  }
  if (name === 'run_terminal' && (ctx.permissionMode === 'read-only' || ctx.permissionMode === 'workspace')) {
    throw new Error('Terminal commands are disabled in this chat permission mode. Choose Supervised or Full access to enable them.');
  }
  if (name === 'export_theme_files' && ctx.permissionMode !== 'supervised' && ctx.permissionMode !== 'full-access') {
    throw new Error('Exporting theme files to your PC requires Supervised or Full access mode.');
  }
  switch (name) {
    case 'list_local_images': {
      const folder = requireAbsolutePath(asString(input.folder, 'folder'), 'folder');
      const listing = await api.localImagesList(folder);
      const rows = listing.images.map((image) => `${image.name}\t${image.bytes.toLocaleString()} bytes\t${image.path}`);
      return {
        ok: true,
        summary: `Found ${listing.images.length} local image${listing.images.length === 1 ? '' : 's'}`,
        result: [`Folder: ${listing.folder}`, ...(rows.length ? rows : ['No supported raster images found.']), ...(listing.truncated ? ['… more than 100 images; narrow the folder'] : [])].join('\n'),
      };
    }
    case 'colorize_image': {
      needProject();
      const sourcePath = requireAbsolutePath(asString(input.source_path, 'source_path'), 'source_path');
      const targetPath = asString(input.target_path, 'target_path').replace(/\\/g, '/');
      if (!/\.png$/i.test(targetPath)) throw new Error('target_path must end in .png because the generated asset is encoded as PNG.');
      const palette = imagePalette(input.palette);
      const image = await colorizeLocalImage(sourcePath, palette.colors);
      const replacesExisting = getState().fileIndex.has(targetPath);
      const details = [
        `Source image: ${sourcePath}`,
        `Theme asset: ${targetPath}`,
        `Theme action: ${replacesExisting ? 'replace the existing file' : 'create a new file'}`,
        `Image size: ${image.width}×${image.height}`,
        'Processing: per-pixel Rec. 709 grayscale luminance mapped to the palette; source alpha preserved.',
        `Dark-to-light palette: ${palette.labels.join(' → ')}`,
      ].join('\n');
      if (!(await ctx.approve({ title: `${replacesExisting ? 'Replace' : 'Add'} colorized image ${targetPath}`, diff: details }))) {
        return { ok: false, summary: 'Colorized image import declined', result: 'No theme files were changed.' };
      }
      const response = await api.filesWrite([{ path: targetPath, data: image.data }], 'AI colorize image');
      A.applySnapshot(response.snapshot);
      return {
        ok: true,
        summary: `Imported ${fileName(targetPath)}`,
        result: `Colorized the local source image and imported it into ${targetPath} (${image.width}×${image.height}, PNG). Source pixels stayed on this PC; the new asset is undoable with Ctrl+Z.`,
      };
    }
    case 'run_terminal': {
      if (ctx.permissionMode !== 'supervised' && ctx.permissionMode !== 'full-access') {
        throw new Error('Terminal commands require Supervised or Full access mode.');
      }
      const command = asString(input.command, 'command');
      const workingDirectory = requireAbsolutePath(asString(input.working_directory, 'working_directory'), 'working_directory');
      const timeoutSeconds = input.timeout_seconds === undefined ? 60 : Number(input.timeout_seconds);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('timeout_seconds must be between 1 and 300.');
      const proposal = {
        title: 'Run terminal command',
        diff: [`Working directory: ${workingDirectory}`, `Timeout: ${timeoutSeconds} seconds`, 'Command:', command].join('\n'),
      };
      if (!(await ctx.approve(proposal))) return { ok: false, summary: 'Terminal command declined', result: 'The command was not run.' };
      const runId = newOpId('terminal');
      ctx.onTerminalRun?.(runId);
      try {
        const output = await api.terminalRun(runId, command, workingDirectory, timeoutSeconds);
        const status = output.exitCode === 0 ? 'completed successfully' : `exited with code ${output.exitCode ?? 'unknown'}`;
        const sections = [
          `Command ${status} in ${output.durationMs} ms.`,
          `Working directory: ${workingDirectory}`,
          `Command: ${command}`,
          `Exit code: ${output.exitCode ?? 'unknown'}`,
          output.stdout ? `stdout:\n${output.stdout}` : '',
          output.stderr ? `stderr:\n${output.stderr}` : '',
          output.truncated ? 'Output was truncated after the local capture limit.' : '',
        ].filter(Boolean);
        return {
          ok: output.exitCode === 0,
          summary: `Terminal ${status}: ${command.slice(0, 80)}`,
          result: sections.join('\n\n'),
        };
      } finally {
        ctx.onTerminalRun?.(null);
      }
    }
    case 'import_local_files': {
      needProject();
      const sourcePaths = Array.isArray(input.paths)
        ? input.paths.filter((path): path is string => typeof path === 'string' && !!path.trim()).map((path) => requireAbsolutePath(path.trim(), 'paths item'))
        : [];
      if (!sourcePaths.length) throw new Error('paths needs one or more absolute local file paths.');
      if (sourcePaths.length > 20) throw new Error('Import at most 20 files at a time.');
      const folder = typeof input.folder === 'string' ? input.folder.trim().replace(/\\/g, '/') : '';
      const destinations = sourcePaths.map((path) => joinPath(folder, localBasename(path)));
      const details = sourcePaths.map((path, index) => `+ ${destinations[index]}${getState().fileIndex.has(destinations[index]) ? ' (replace existing)' : ''}\n  ← ${path}`);
      const proposal = { title: `Import ${sourcePaths.length} local file${sourcePaths.length === 1 ? '' : 's'}`, diff: details.join('\n') };
      if (!(await ctx.approve(proposal))) return { ok: false, summary: 'Local file import declined', result: 'No theme files were changed.' };
      const response = await api.filesImport(sourcePaths, folder, 'overwrite');
      A.applySnapshot(response.snapshot);
      return {
        ok: true,
        summary: `Imported ${response.result.written.length} local file${response.result.written.length === 1 ? '' : 's'}`,
        result: `Imported into ${folder || 'the theme root'}: ${response.result.written.join(', ') || 'no files'}. This theme change is undoable with Ctrl+Z.`,
      };
    }
    case 'export_theme_files': {
      needProject();
      if (!Array.isArray(input.paths) || !input.paths.every((path) => typeof path === 'string')) {
        throw new Error('paths must be an array of theme file or folder paths; use [] to export the whole package.');
      }
      const paths = input.paths as string[];
      if (paths.length > 5000) throw new Error('Export at most 5,000 selected files or folders at once.');
      const destination = requireAbsolutePath(asString(input.destination_directory, 'destination_directory'), 'destination_directory');
      const displayPaths = paths.length ? paths : ['(entire package)'];
      const proposal = {
        title: `Export ${paths.length ? `${paths.length} selected item${paths.length === 1 ? '' : 's'}` : 'entire package'}`,
        diff: [`Destination folder: ${destination}`, 'Files and folders:', ...displayPaths.map((path) => `+ ${path}`), 'Folder structure will be preserved. Local exported files are not undoable.'].join('\n'),
      };
      if (!(await ctx.approve(proposal))) return { ok: false, summary: 'Export declined', result: 'No local files were written.' };
      const output = await api.filesExtract(paths, destination);
      return {
        ok: true,
        summary: `Exported ${output.files} theme file${output.files === 1 ? '' : 's'}`,
        result: [`Exported ${output.files} file${output.files === 1 ? '' : 's'} (${output.bytes.toLocaleString()} bytes) to ${destination}.`, ...output.paths.slice(0, 80)].join('\n'),
      };
    }
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
    case 'list_local_images':
      return `Listing images in ${localBasename(String(input.folder ?? 'local folder'))}`;
    case 'colorize_image':
      return `Colorizing ${localBasename(String(input.source_path ?? 'local image'))}`;
    case 'run_terminal':
      return `Running ${String(input.command ?? 'terminal command').slice(0, 70)}`;
    case 'import_local_files':
      return `Importing ${Array.isArray(input.paths) ? input.paths.length : 0} local file${Array.isArray(input.paths) && input.paths.length === 1 ? '' : 's'}`;
    case 'export_theme_files':
      return `Exporting ${Array.isArray(input.paths) && input.paths.length ? `${input.paths.length} selected item${input.paths.length === 1 ? '' : 's'}` : 'the theme'}`;
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
