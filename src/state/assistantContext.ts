// What the assistant knows about themes in general and about the open theme
// right now. Sent with every request so the model starts from the real state
// instead of guessing, and only uses tools for details.
import { api } from '../lib/api';
import type { FileInfo, ProjectSnapshot } from '../lib/types';
import { getState } from './store';

/** How MIUI/HyperOS themes work, as this app sees them. */
export const THEME_KNOWLEDGE = `How MIUI/HyperOS theme packages (.mtz) work:
- A .mtz is a zip. Loose files sit at the root (description.xml, wallpaper/, preview/, fonts/, ringtones/, boots/). Most parts are nested zip archives with no extension, named after their target: "lockscreen", "icons", "com.android.systemui", "framework-res", "com.android.settings", "com.miui.home", or any app package name. In this app a file inside an archive is addressed "<archive>!/<path>", e.g. "com.android.systemui!/theme_values.xml".
- description.xml: <theme> with <title>, <designer>, <author>, <version>, <uiVersion>, <description> and similar. uiVersion tells Theme Manager which system the theme targets; do not change it unless asked.
- Wallpapers: wallpaper/default_wallpaper.jpg (home) and wallpaper/default_lock_wallpaper.jpg (lock). Previews shown in Theme Manager: preview/preview_*.jpg or preview/en_US_*.jpg.
- Lock screen ("lockscreen" archive): MAML in lockscreen!/advance/manifest.xml, with images beside it and an optional config.xml (user settings). Root <Lockscreen screenWidth="1080" frameRate=…>; coordinates are in a 1080-wide space. Elements: <Image src= x= y= w= h= align= alignV=>, <Text text= or textExp= size= color= x= y=>, <DateTime format=>, <Time src=…> (digit images), <Group> (children move together), <Button>/<Unlocker>, <Var name= expression=>, <Rectangle>, <Circle>. Expressions read variables with #name (numbers) and @name (strings), e.g. #hour24, #minute, #battery_level, @next_alarm_time, #screen_width. Elements show or hide with visibility="expression". Read the guide pages before inventing syntax.
- Icons ("icons" archive): PNGs under icons!/res/drawable-xxhdpi/ named <package>.png or <package>.<Activity>.png. Icon masks/backgrounds: icon_background.png, icon_mask.png, icon_border.png, icon_pattern.png, plus transform_config.xml.
- System apps ("com.android.systemui", "com.miui.home", "com.android.settings", "framework-res", other packages): theme_values.xml overrides resources by name: <MIUI_Theme_Values><color name="…">#AARRGGBB</color><dimen name="…">12dp</dimen><bool name="…">true</bool><integer …>. Replacement images go in res/drawable-xxhdpi/ (or another density folder) inside the archive, with the same file name as the system resource; *.9.png are nine-patch images.
- Fonts in fonts/ (Roboto-Regular.ttf etc.), sounds in ringtones/ (ringtone.mp3, notification.mp3, alarm.mp3), boot animation in boots/.
- XML must stay well-formed or the part breaks on the phone. Keep the existing indentation style and attribute order when editing.`;

let cache: { key: unknown[]; text: string } | null = null;

const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function countBy<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return map;
}

/** Folders inside one part with file counts, so the model knows where things live. */
function folders(files: FileInfo[], max = 8): string {
  const counts = countBy(files, (f) => f.path.slice(0, f.path.lastIndexOf('/') + 1) || '(root)');
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([dir, n]) => `${dir} (${n})`)
    .join(', ');
}

function textFile(f: FileInfo) {
  return f.kind === 'xml' || f.kind === 'text';
}

/** A short outline of a MAML file: root attributes, element counts, named elements. */
export function mamlOutline(xml: string, maxNames = 40): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return '(could not parse)';
  }
  if (doc.getElementsByTagName('parsererror').length) return '(XML is not well-formed)';
  const root = doc.documentElement;
  const attrs = [...root.attributes].map((a) => `${a.name}="${a.value}"`).join(' ');
  const all = [...root.getElementsByTagName('*')];
  const tags = [...countBy(all, (e) => e.tagName)].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ');
  const named = all
    .filter((e) => e.getAttribute('name') && e.tagName !== 'Var')
    .slice(0, maxNames)
    .map((e) => `${e.tagName}:${e.getAttribute('name')}`)
    .join(', ');
  const vars = all
    .filter((e) => e.tagName === 'Var' && e.getAttribute('name'))
    .slice(0, 30)
    .map((e) => e.getAttribute('name'))
    .join(', ');
  return [`<${root.tagName} ${attrs}>`, `elements: ${tags}`, named && `named: ${named}`, vars && `variables: ${vars}`].filter(Boolean).join('\n');
}

async function readText(path: string): Promise<string | null> {
  const draft = getState().drafts[path];
  if (draft) return draft.text;
  try {
    return (await api.fileText(path, 'main')).text;
  } catch {
    return null;
  }
}

function withLineNumbers(text: string, maxChars: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = `${i + 1}| ${lines[i]}`;
    if (size + line.length > maxChars) {
      out.push(`… ${lines.length - i} more lines (use read_file with start_line)`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

async function describe(project: ProjectSnapshot): Promise<string> {
  const state = getState();
  const files = project.files;
  const out: string[] = [];

  // Identity.
  const meta = await api.metadataGet('main').catch(() => null);
  const field = (name: string) => meta?.fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.value;
  out.push(
    `Theme "${project.title}"${field('author') ? ` by ${field('author')}` : ''}${field('version') ? `, version ${field('version')}` : ''}${field('uiVersion') ? `, uiVersion ${field('uiVersion')}` : ''}. ${files.length} files${project.dirty ? ', unsaved changes' : ''}.`,
  );
  out.push(meta?.exists ? `description.xml fields: ${meta.fields.map((f) => `${f.name}="${f.value.slice(0, 80)}"`).join(', ')}` : 'description.xml is missing (create it with write_file if asked).');

  // Parts and where their files live.
  const byPart = new Map<string, FileInfo[]>();
  for (const f of files) byPart.set(f.component, [...(byPart.get(f.component) ?? []), f]);
  const label = (id: string) => project.components.find((c) => c.id === id)?.label ?? id;
  out.push('Parts in this theme:');
  for (const [id, list] of [...byPart].sort((a, b) => b[1].length - a[1].length)) {
    const kinds = [...countBy(list, (f) => f.kind)].map(([k, n]) => `${n} ${k}`).join(', ');
    out.push(`- ${label(id)} [${id}]: ${kinds}. Folders: ${folders(list)}`);
  }
  const absent = project.components.filter((c) => !byPart.has(c.id) && c.defaultRoot && !['metadata', 'other'].includes(c.id));
  if (absent.length) out.push(`Not in this theme yet: ${absent.map((c) => `${c.label} (${c.archive ? `archive "${c.defaultRoot}"` : `folder ${c.defaultRoot}/`})`).join(', ')}`);

  // Key text files by name, so edits target real paths.
  const keyFiles = files.filter((f) => textFile(f) && /(^|\/)(manifest\.xml|theme_values\.xml|config\.xml|transform_config\.xml|description\.xml|theme_fallback\.xml)$/i.test(f.path));
  if (keyFiles.length) out.push(`Key text files: ${keyFiles.slice(0, 40).map((f) => `${f.path}${f.status !== 'original' ? ` (${f.status})` : ''}`).join(', ')}`);

  // Lock screen outline.
  const manifest = files.find((f) => /^lockscreen!\/advance\/manifest\.xml$/i.test(f.path)) ?? files.find((f) => f.component === 'lockscreen' && /manifest\.xml$/i.test(f.path));
  if (manifest) {
    const xml = await readText(manifest.path);
    if (xml) out.push(`Lock screen ${manifest.path} (${xml.split('\n').length} lines):\n${mamlOutline(xml)}`);
  }

  // What the person changed recently (newest first).
  const recent = project.history.filter((h) => h.done).slice(-8).reverse();
  if (recent.length) out.push(`Recent edits (newest first): ${recent.map((h) => h.label).join('; ')}`);

  const modified = files.filter((f) => f.status !== 'original');
  if (modified.length) out.push(`Changed since opening: ${modified.slice(0, 20).map((f) => `${f.path} (${f.status})`).join(', ')}${modified.length > 20 ? ` and ${modified.length - 20} more` : ''}`);

  // Problems.
  const v = state.validation;
  if (v && (v.errors || v.warnings)) {
    out.push(`Check results: ${v.errors} errors, ${v.warnings} warnings`);
    for (const i of v.issues.filter((i) => i.severity !== 'info').slice(0, 10)) out.push(`- ${i.severity}: ${i.message}${i.path ? ` [${i.path}]` : ''}`);
  }

  // Where the person is looking.
  const tab = state.tabs.find((t) => t.id === state.activeTab);
  if (state.section === 'design' || !tab?.path) out.push(`The person is in the ${state.section} section${state.part ? `, looking at the ${label(state.part)} part` : ''}.`);
  if (state.selection.length) out.push(`Selected in the file list: ${state.selection.slice(0, 8).join(', ')}`);
  if (tab?.path && tab.slot !== 'ref') {
    const info = state.fileIndex.get(tab.path);
    if (info && textFile(info)) {
      const text = await readText(tab.path);
      if (text !== null) out.push(`File open in the editor${state.drafts[tab.path] ? ' (with unapplied edits)' : ''}: ${tab.path}\n${withLineNumbers(text, 8000)}`);
    } else if (info) {
      out.push(`File open in the editor: ${tab.path} (${info.kind}${info.width ? `, ${info.width}x${info.height}` : ''})`);
    }
  }
  if (state.reference) out.push(`A reference theme "${state.reference.title}" is open read-only (the person can copy parts from it in the app).`);
  return out.join('\n');
}

/** The open theme as text for the system prompt; cached until something changes. */
export async function themeContext(): Promise<string> {
  const state = getState();
  const project = state.project;
  if (!project) return 'No theme is open. You can answer questions and explain; to edit, the person must create or open a theme (Design section).';
  const key = [project, state.activeTab, state.drafts, state.validation, state.section, state.part, state.selection, state.reference];
  if (cache && sameKey(cache.key, key)) return cache.text;
  const text = await describe(project).catch((e) => `Theme "${project.title}" (details unavailable: ${String(e)})`);
  cache = { key, text };
  return text;
}
