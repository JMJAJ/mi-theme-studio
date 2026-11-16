import { unzipSync, zipSync } from '../node_modules/fflate/esm/browser.js';

const appRoot = document.querySelector('#app');
const toastRoot = document.querySelector('#toast');
const categories = [
  { id: 'overview', label: 'Overview', icon: '◫' },
  { id: 'icons', label: 'Icons', icon: '▦' },
  { id: 'wallpapers', label: 'Wallpapers', icon: '▧' },
  { id: 'lockscreen', label: 'Lock screen', icon: '◈' },
  { id: 'system', label: 'System UI', icon: '⌘' },
  { id: 'all', label: 'All files', icon: '☷' },
  { id: 'info', label: 'Theme details', icon: '◎' }
];

const state = {
  project: null,
  route: 'overview',
  selectedPath: '',
  query: '',
  visibleLimit: 120,
  pendingText: null,
  dirty: false,
  toastTimer: null,
  objectUrls: new Map()
};

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const extension = (filePath) => filePath.split('.').pop().toLowerCase();
const isImage = (filePath) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'].includes(extension(filePath));
const isText = (filePath) => ['xml', 'maml', 'json', 'txt', 'ini', 'css', 'html', 'js', 'md', 'csv'].includes(extension(filePath));

function cleanArchivePath(input) {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((part) => part === '..' || part === '.')) return '';
  return normalized;
}

function bytesToText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function getTextFile(project, path) {
  const file = project?.files[path];
  return file ? bytesToText(file) : '';
}

function xmlDocument(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('The XML has a syntax error. Fix it before saving.');
  return document;
}

function metadata() {
  if (!state.project) return { title: 'Untitled theme', author: '', version: '1.0', designer: '', description: '' };
  const xml = getTextFile(state.project, 'description.xml');
  try {
    const doc = xmlDocument(xml);
    const value = (name) => doc.querySelector(`MIUI-Theme > ${name}`)?.textContent?.trim() || '';
    return {
      title: value('title') || state.project.name.replace(/\.mtz$/i, '') || 'Untitled theme',
      author: value('author'),
      designer: value('designer'),
      version: value('version') || '1.0',
      description: value('description')
    };
  } catch {
    return { title: state.project.name.replace(/\.mtz$/i, ''), author: '', designer: '', version: '1.0', description: '' };
  }
}

function routeForPath(filePath) {
  const path = filePath.toLowerCase();
  if (/(^|\/)(wallpaper|wallpapers|background|backgrounds)(\/|$)/.test(path) || /wallpaper|background/.test(path)) return 'wallpapers';
  if (/lock.?screen|lockscreen|keyguard/.test(path)) return 'lockscreen';
  if (/(^|\/)icons?(\/|$)/.test(path) || /(^|\/)icon[_-]/.test(path) || /app.?icon/.test(path)) return 'icons';
  if (/(^|\/)(res|framework-res)(\/|$)/.test(path) || /framework|systemui|system_ui|status.?bar|navigation.?bar|settings|contacts|messages/.test(path)) return 'system';
  return 'all';
}

function routeFiles(route = state.route) {
  if (!state.project) return [];
  return Object.keys(state.project.files)
    .filter((path) => !path.endsWith('/'))
    .filter((path) => route === 'all' || route === 'overview' || route === 'info' || routeForPath(path) === route)
    .filter((path) => !state.query || path.toLowerCase().includes(state.query.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function routeCount(route) {
  if (!state.project) return 0;
  return Object.keys(state.project.files).filter((path) => routeForPath(path) === route).length;
}

function totalBytes() {
  return state.project ? Object.values(state.project.files).reduce((sum, data) => sum + data.byteLength, 0) : 0;
}

function toast(message, kind = 'success') {
  clearTimeout(state.toastTimer);
  toastRoot.className = `toast toast-${kind} toast-visible`;
  toastRoot.textContent = message;
  state.toastTimer = setTimeout(() => toastRoot.classList.remove('toast-visible'), 2800);
}

function formatName(filePath) {
  return filePath.split('/').pop() || filePath;
}

function objectUrl(filePath) {
  const current = state.objectUrls.get(filePath);
  if (current) return current;
  const file = state.project.files[filePath];
  if (!file) return '';
  const mime = extension(filePath) === 'svg' ? 'image/svg+xml' : `image/${extension(filePath) === 'jpg' ? 'jpeg' : extension(filePath)}`;
  const url = URL.createObjectURL(new Blob([file], { type: mime }));
  state.objectUrls.set(filePath, url);
  return url;
}

function clearObjectUrl(filePath) {
  const url = state.objectUrls.get(filePath);
  if (url) URL.revokeObjectURL(url);
  state.objectUrls.delete(filePath);
}

function clearAllObjectUrls() {
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function emptyProject() {
  const description = `<?xml version="1.0" encoding="UTF-8"?>\n<MIUI-Theme>\n  <title>My Theme</title>\n  <designer></designer>\n  <author></author>\n  <version>1.0</version>\n  <description></description>\n</MIUI-Theme>\n`;
  const pluginConfig = `<?xml version="1.0" encoding="UTF-8"?>\n<PluginConfig>\n  <iconCalendar/>\n  <iconClock/>\n  <iconWeather/>\n  <lockscreen/>\n  <desktopClock/>\n  <desktopWallpaper/>\n</PluginConfig>\n`;
  return {
    name: 'My Theme.mtz',
    files: {
      'description.xml': new TextEncoder().encode(description),
      'plugin_config.xml': new TextEncoder().encode(pluginConfig)
    }
  };
}

async function importTheme() {
  if (!persistTextDraft()) return;
  if (state.project && state.dirty && !confirm('This theme has unsaved changes. Open another package and discard them?')) return;
  try {
    const chosen = await window.themeStudio.openTheme();
    if (!chosen) return;
    const entries = unzipSync(chosen.data);
    const files = Object.create(null);
    for (const [rawPath, data] of Object.entries(entries)) {
      const safePath = cleanArchivePath(rawPath);
      if (!safePath || rawPath.endsWith('/')) continue;
      files[safePath] = data;
    }
    if (Object.keys(files).length === 0) throw new Error('No files were found in that archive.');
    clearAllObjectUrls();
    state.project = { name: chosen.name, files };
    state.route = 'overview';
    state.selectedPath = Object.keys(files).sort()[0] || '';
    state.query = '';
    state.visibleLimit = 120;
    state.pendingText = null;
    state.dirty = false;
    render();
    toast(`Opened ${chosen.name}`);
  } catch (error) {
    toast(error.message || 'Could not open that theme package.', 'error');
  }
}

function createTheme() {
  if (!persistTextDraft()) return;
  if (state.project && state.dirty && !confirm('This theme has unsaved changes. Start a new theme and discard them?')) return;
  clearAllObjectUrls();
  state.project = emptyProject();
  state.route = 'overview';
  state.selectedPath = 'description.xml';
  state.query = '';
  state.visibleLimit = 120;
  state.pendingText = null;
  state.dirty = true;
  render();
}

async function exportTheme() {
  if (!state.project) return;
  if (!persistTextDraft()) return;
  try {
    const archive = zipSync(state.project.files, { level: 6 });
    const suggested = state.project.name.replace(/\.(mtz|zip)$/i, '') + '.mtz';
    const savedPath = await window.themeStudio.saveTheme(suggested, archive);
    if (savedPath) {
      state.project.name = savedPath.split(/[\\/]/).pop();
      state.dirty = false;
      render();
      toast('Theme exported successfully');
    }
  } catch (error) {
    toast(error.message || 'Could not export this package.', 'error');
  }
}

function defaultDestination() {
  return ({ icons: 'icons', wallpapers: 'wallpaper', lockscreen: 'lockscreen', system: 'res' })[state.route] || '';
}

async function addFiles() {
  if (!state.project) return;
  try {
    const selected = await window.themeStudio.pickAssets(true);
    if (!selected.length) return;
    const folder = defaultDestination();
    for (const asset of selected) {
      const filePath = cleanArchivePath([folder, asset.name].filter(Boolean).join('/'));
      if (!filePath) continue;
      if (state.project.files[filePath] && !confirm(`${filePath} already exists. Replace it?`)) continue;
      clearObjectUrl(filePath);
      state.project.files[filePath] = asset.data;
      state.selectedPath = filePath;
    }
    state.dirty = true;
    render();
    toast(`${selected.length} file${selected.length === 1 ? '' : 's'} added`);
  } catch (error) {
    toast(error.message || 'Could not add those files.', 'error');
  }
}

async function replaceSelected() {
  const filePath = state.selectedPath;
  if (!filePath || !state.project) return;
  try {
    const [asset] = await window.themeStudio.pickAssets(false);
    if (!asset) return;
    clearObjectUrl(filePath);
    state.project.files[filePath] = asset.data;
    state.dirty = true;
    render();
    toast(`${formatName(filePath)} replaced`);
  } catch (error) {
    toast(error.message || 'Could not replace that file.', 'error');
  }
}

function deleteSelected() {
  const filePath = state.selectedPath;
  if (!filePath || !state.project) return;
  if (!confirm(`Remove ${filePath} from this theme?`)) return;
  clearObjectUrl(filePath);
  delete state.project.files[filePath];
  state.selectedPath = routeFiles()[0] || Object.keys(state.project.files)[0] || '';
  state.dirty = true;
  render();
  toast('File removed');
}

function saveTextEdit() {
  const filePath = state.selectedPath;
  const editor = document.querySelector('#text-editor');
  if (!filePath || !editor || !state.project) return;
  state.pendingText = { path: filePath, text: editor.value };
  if (!persistTextDraft()) return;
  render();
  toast('File changes saved');
}

function persistTextDraft() {
  const draft = state.pendingText;
  if (!draft || !state.project) return true;
  if (/\.(xml|maml)$/i.test(draft.path)) {
    try { xmlDocument(draft.text); }
    catch (error) { toast(error.message, 'error'); return false; }
  }
  state.project.files[draft.path] = new TextEncoder().encode(draft.text);
  state.pendingText = null;
  state.dirty = true;
  return true;
}

function updateMetadata(field, value) {
  const currentXml = getTextFile(state.project, 'description.xml') || bytesToText(emptyProject().files['description.xml']);
  try {
    const doc = xmlDocument(currentXml);
    const root = doc.querySelector('MIUI-Theme') || doc.documentElement;
    let node = root.querySelector(`:scope > ${field}`);
    if (!node) {
      node = doc.createElement(field);
      root.append(node);
    }
    node.textContent = value;
    const serialized = new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^?]*\?>\s*/i, '');
    state.project.files['description.xml'] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`);
    state.dirty = true;
    const title = metadata().title;
    const author = metadata().author || metadata().designer || 'Unknown creator';
    const topbarTitle = document.querySelector('#topbar-project');
    if (topbarTitle) topbarTitle.textContent = title;
    const summaryTitle = document.querySelector('#summary-title');
    if (summaryTitle) summaryTitle.textContent = title;
    const projectTitle = document.querySelector('#project-title');
    if (projectTitle) projectTitle.textContent = title;
    const projectVersion = document.querySelector('#project-version');
    if (projectVersion) projectVersion.textContent = `v${metadata().version}`;
    const projectAuthor = document.querySelector('#project-author');
    if (projectAuthor) projectAuthor.textContent = `By ${author}`;
    const status = document.querySelector('#save-state');
    if (status) status.textContent = 'Unsaved changes';
  } catch (error) {
    toast(error.message, 'error');
  }
}

function getSelectedWallpaper() {
  return Object.keys(state.project?.files || {}).find((path) => routeForPath(path) === 'wallpapers' && isImage(path));
}

function navHtml() {
  return categories.map((item) => {
    const count = ['overview', 'info'].includes(item.id) ? '' : `<span class="nav-count">${routeCount(item.id)}</span>`;
    return `<button class="nav-item ${state.route === item.id ? 'is-active' : ''}" data-route="${item.id}">
      <span class="nav-icon">${item.icon}</span><span>${item.label}</span>${count}
    </button>`;
  }).join('');
}

function shell(content) {
  const meta = metadata();
  return `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">mi</div><div><div class="brand-name">Theme Studio</div><div class="brand-caption">MIUI package editor</div></div></div>
      <div class="side-label">WORKSPACE</div>
      <nav class="nav-list">${navHtml()}</nav>
      <div class="sidebar-bottom">
        <div class="device-chip"><div class="device-icon">◉</div><div><strong>MIUI theme</strong><span>Local workspace</span></div><span class="online-dot"></span></div>
        <div class="version-line"><span>MI THEME STUDIO</span><span>v0.1</span></div>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar">
        <div class="topbar-title"><span class="topbar-eyebrow">THEME WORKSPACE</span><span class="topbar-project" id="topbar-project">${state.project ? escapeHtml(meta.title) : 'Start creating'}</span></div>
        <div class="topbar-actions">
          ${state.project ? `<span class="save-state" id="save-state"><i></i>${state.dirty ? 'Unsaved changes' : 'All changes saved'}</span><button class="button button-quiet" data-action="create">New theme</button><button class="button button-quiet" data-action="open">Open theme</button><button class="button button-primary" data-action="export"><span>↥</span> Export .mtz</button>` : `<button class="button button-quiet" data-action="open">Open .mtz</button>`}
          <div class="avatar">M</div>
        </div>
      </header>
      <section class="workspace">${content}</section>
    </main>
  </div>`;
}

function welcomePage() {
  const content = `<div class="welcome-wrap">
    <div class="welcome-copy"><div class="eyebrow"><span class="eyebrow-line"></span>DESIGNED FOR THE WAY YOU CREATE</div>
      <h1>Your next theme<br/>starts <em>here.</em></h1>
      <p>Open a theme package, explore every asset, and shape it into something that feels like yours.</p>
      <div class="welcome-actions"><button class="button button-primary button-large" data-action="create"><span>＋</span> New theme</button><button class="button button-outline button-large" data-action="open"><span>↥</span> Open .mtz package</button></div>
      <div class="welcome-footnote"><span class="footnote-icon">✦</span> Everything stays on your computer. No account or upload required.</div>
    </div>
    <div class="welcome-art"><div class="art-glow"></div><div class="art-card back-card"><div class="art-card-top"><span>THEME ASSETS</span><span class="tiny-dots">•••</span></div><div class="art-tile-grid"><div class="art-tile tile-orange">◒</div><div class="art-tile tile-lilac">✣</div><div class="art-tile tile-blue">◈</div><div class="art-tile tile-green">⌘</div></div><div class="art-lines"><i></i><i></i><i></i></div></div><div class="art-phone"><div class="phone-camera"></div><div class="phone-time">09:41</div><div class="phone-date">Monday, June 16</div><div class="phone-notification"><span class="notif-icon">mi</span><span><b>Theme Studio</b><small>Your next theme is ready to begin.</small></span></div><div class="phone-dock"><i></i><i></i><i></i><i></i></div></div><div class="floating-badge"><span>✦</span> YOUR CREATIVE SPACE</div></div>
    <div class="welcome-bottom"><div><span class="step-number">01</span><span><b>Open a package</b><small>Start with an existing .mtz theme.</small></span></div><div><span class="step-number">02</span><span><b>Make it yours</b><small>Browse, replace, and edit resources.</small></span></div><div><span class="step-number">03</span><span><b>Export & enjoy</b><small>Package everything back into .mtz.</small></span></div></div>
  </div>`;
  return shell(content);
}

function overviewPage() {
  const meta = metadata();
  const files = routeFiles('all');
  const images = files.filter(isImage);
  const xml = files.filter((path) => extension(path) === 'xml' || extension(path) === 'maml');
  const wallpaper = getSelectedWallpaper();
  const recent = files.slice(0, 7);
  const categoryCards = categories.filter((item) => ['icons', 'wallpapers', 'lockscreen', 'system'].includes(item.id)).map((item) => `
    <button class="category-card category-${item.id}" data-route="${item.id}"><span class="category-symbol">${item.icon}</span><span class="category-label">${item.label}</span><span class="category-subtitle">${routeCount(item.id)} files</span><span class="category-arrow">↗</span></button>`).join('');
  return `<div class="page-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span>YOUR WORKSPACE</div><h1>Good to have you back.</h1><p>Here’s what’s inside <strong id="summary-title">${escapeHtml(meta.title)}</strong>.</p></div><button class="button button-outline" data-action="add"><span>＋</span> Add files</button></div>
    <div class="project-banner"><div class="project-symbol">mi</div><div class="project-banner-info"><div class="project-banner-title"><span id="project-title">${escapeHtml(meta.title)}</span><span class="project-version" id="project-version">v${escapeHtml(meta.version)}</span></div><div class="project-banner-meta"><span id="project-author">By ${escapeHtml(meta.author || meta.designer || 'Unknown creator')}</span><i></i><span>${escapeHtml(state.project.name)}</span></div></div><div class="project-banner-right"><span class="status-pill"><i></i>${state.dirty ? 'Editing' : 'Ready to edit'}</span><div class="project-size">${formatSize(totalBytes())}</div></div></div>
    <div class="stats-grid"><div class="stat-card"><div class="stat-label">TOTAL ASSETS <span>↗</span></div><div class="stat-value">${files.length}<small> files</small></div><div class="stat-note"><b>Across your whole theme</b></div></div><div class="stat-card"><div class="stat-label">IMAGES <span>◫</span></div><div class="stat-value">${images.length}<small> images</small></div><div class="stat-note">Icons, wallpapers & more</div></div><div class="stat-card"><div class="stat-label">XML & MAML <span>⌘</span></div><div class="stat-value">${xml.length}<small> files</small></div><div class="stat-note">Theme structure & behavior</div></div><div class="stat-card stat-highlight"><div class="stat-label">PACKAGE SIZE <span>◌</span></div><div class="stat-value">${formatSize(totalBytes())}</div><div class="stat-note"><span class="storage-track"><i style="width:${Math.min(100, Math.max(6, totalBytes() / (50 * 1024 * 1024) * 100))}%"></i></span> Local package</div></div></div>
    <div class="overview-grid"><section class="panel category-panel"><div class="panel-heading"><div><h2>Explore your theme</h2><p>Jump straight into a part of your package.</p></div><button class="text-link" data-route="all">View all files <span>→</span></button></div><div class="category-grid">${categoryCards}</div><div class="panel-heading recent-heading"><div><h2>Recently in your package</h2><p>Files included in this theme.</p></div><button class="text-link" data-route="all">Browse library <span>→</span></button></div><div class="recent-list">${recent.length ? recent.map((path) => `<button class="recent-row" data-select="${escapeHtml(path)}"><span class="file-type ${isImage(path) ? 'type-image' : 'type-code'}">${isImage(path) ? '◫' : '</>'}</span><span class="recent-file"><b>${escapeHtml(formatName(path))}</b><small>${escapeHtml(path)}</small></span><span class="recent-size">${formatSize(state.project.files[path].byteLength)}</span><span class="row-chevron">›</span></button>`).join('') : `<div class="empty-inline">No files yet. Add assets to start building your theme.</div>`}</div></section>
    <aside class="preview-panel"><div class="panel-heading"><div><h2>Theme preview</h2><p>A quick look at your wallpaper.</p></div><span class="preview-tag">PREVIEW</span></div><div class="phone-stage"><div class="preview-phone"><div class="preview-notch"></div>${wallpaper ? `<img class="preview-wallpaper" src="${objectUrl(wallpaper)}" alt="Theme wallpaper preview" />` : `<div class="preview-wallpaper placeholder-wallpaper"><div class="placeholder-orb"></div><span>Wallpaper preview</span></div>`}<div class="preview-screen-content"><div class="preview-clock">09:41</div><div class="preview-day">MONDAY, JUNE 16</div><div class="preview-widgets"><div class="widget-circle">☀</div><div><b>Good morning</b><span>18° · Clear sky</span></div></div><div class="preview-dock"><i></i><i></i><i></i><i></i></div></div></div></div><button class="preview-action" data-route="wallpapers"><span>▧</span> ${wallpaper ? 'Browse wallpapers' : 'Add a wallpaper'} <span class="preview-action-arrow">→</span></button><div class="preview-tip"><span>✦</span><p>Your changes are local. Export when you’re ready to create a new .mtz package.</p></div></aside></div>`;
}

function fileRow(filePath) {
  const data = state.project.files[filePath];
  const image = isImage(filePath);
  return `<button class="file-row ${state.selectedPath === filePath ? 'is-selected' : ''}" data-select="${escapeHtml(filePath)}">
    <span class="file-thumb ${image ? 'thumb-image' : ''}">${image ? `<img src="${objectUrl(filePath)}" alt=""/>` : `<span>${extension(filePath).toUpperCase().slice(0, 4)}</span>`}</span>
    <span class="file-main"><b>${escapeHtml(formatName(filePath))}</b><small>${escapeHtml(filePath)}</small></span>
    <span class="file-kind">${escapeHtml(routeForPath(filePath) === 'all' ? 'Resource' : categories.find((item) => item.id === routeForPath(filePath))?.label || 'Resource')}</span>
    <span class="file-bytes">${formatSize(data.byteLength)}</span><span class="row-chevron">›</span>
  </button>`;
}

function fileRowsHtml(files) {
  const visible = files.slice(0, state.visibleLimit);
  const more = files.length > visible.length
    ? `<div class="more-files"><button class="button button-outline" data-action="more">Show ${Math.min(120, files.length - visible.length)} more <span>· ${files.length - visible.length} remaining</span></button></div>`
    : '';
  return `${visible.map(fileRow).join('')}${more}`;
}

function inspectorHtml() {
  const filePath = state.selectedPath;
  if (!filePath || !state.project?.files[filePath]) return `<div class="inspector-empty"><div class="empty-file-icon">◫</div><b>Select a file</b><span>Choose an asset to inspect or edit it.</span></div>`;
  const data = state.project.files[filePath];
  const image = isImage(filePath);
  const text = isText(filePath);
  const content = text ? `<div class="code-editor-wrap"><div class="code-editor-title"><span>TEXT CONTENT</span><span>${extension(filePath).toUpperCase()}</span></div><textarea id="text-editor" spellcheck="false" aria-label="Edit ${escapeHtml(filePath)}">${escapeHtml(bytesToText(data))}</textarea><button class="button button-primary save-file-button" data-action="save-text">Save changes</button></div>` : image ? `<div class="inspector-image-frame"><img src="${objectUrl(filePath)}" alt="Preview of ${escapeHtml(formatName(filePath))}" /></div>` : `<div class="binary-preview"><div class="binary-icon">${extension(filePath).slice(0, 4).toUpperCase()}</div><span>Binary resource</span><small>This file is preserved in the package. Replace it to use a different asset.</small></div>`;
  return `<div class="inspector-head"><div class="inspector-label">SELECTED FILE</div><h3>${escapeHtml(formatName(filePath))}</h3><p>${escapeHtml(filePath)}</p></div>${content}<div class="file-properties"><div><span>File size</span><b>${formatSize(data.byteLength)}</b></div><div><span>File type</span><b>${escapeHtml(extension(filePath).toUpperCase() || 'FILE')}</b></div><div><span>Category</span><b>${escapeHtml(categories.find((item) => item.id === routeForPath(filePath))?.label || 'Other')}</b></div></div><div class="inspector-actions"><button class="button button-outline" data-action="replace">Replace file</button><button class="button button-danger" data-action="delete">Remove</button></div>`;
}

function libraryPage() {
  const route = categories.find((item) => item.id === state.route) || categories[5];
  const files = routeFiles();
  const heading = state.route === 'all' ? 'All theme files' : route.label;
  const description = state.route === 'all' ? 'Every resource in your package, in one place.' : `Browse and manage the ${route.label.toLowerCase()} in your theme.`;
  return `<div class="page-heading library-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span>ASSET LIBRARY</div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(description)}</p></div><button class="button button-primary" data-action="add"><span>＋</span> Add files</button></div>
    <div class="library-toolbar"><div class="library-breadcrumb"><span>My theme</span><i>/</i><b>${escapeHtml(heading)}</b><span class="breadcrumb-count">${files.length} files</span></div><label class="search-box"><span>⌕</span><input id="file-search" type="search" placeholder="Search files..." value="${escapeHtml(state.query)}" /><kbd>⌘ K</kbd></label></div>
    <div class="library-layout"><section class="file-list-panel"><div class="file-list-head"><span>NAME</span><span>CATEGORY</span><span>SIZE</span><span></span></div><div class="file-list">${files.length ? fileRowsHtml(files) : `<div class="empty-library"><div class="empty-illustration">${route.icon}</div><b>No files here yet</b><p>${state.query ? 'Try a different search.' : 'Add files to this category to see them in your library.'}</p><button class="button button-outline" data-action="add">＋ Add files</button></div>`}</div></section><aside class="inspector-panel">${inspectorHtml()}</aside></div>`;
}

function infoPage() {
  const meta = metadata();
  return `<div class="page-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span>PROJECT SETTINGS</div><h1>Theme details</h1><p>Set the information that travels with your theme package.</p></div><span class="xml-badge"><span>⌘</span> description.xml</span></div><div class="settings-layout"><section class="settings-card"><div class="settings-card-title"><div class="settings-icon">◎</div><div><h2>Theme metadata</h2><p>These fields are saved into the package's description.xml file.</p></div></div><div class="form-grid"><label class="form-field"><span>Theme name</span><input data-meta="title" value="${escapeHtml(meta.title)}" placeholder="My Theme" /><small>Shown as the name of your theme.</small></label><label class="form-field"><span>Version</span><input data-meta="version" value="${escapeHtml(meta.version)}" placeholder="1.0" /><small>Use a simple number such as 1.0.</small></label><label class="form-field"><span>Author</span><input data-meta="author" value="${escapeHtml(meta.author)}" placeholder="Your name" /><small>The creator credited in the package.</small></label><label class="form-field"><span>Designer</span><input data-meta="designer" value="${escapeHtml(meta.designer)}" placeholder="Designer name" /><small>Optional designer attribution.</small></label><label class="form-field form-wide"><span>Description</span><textarea data-meta="description" rows="4" placeholder="A few words about your theme">${escapeHtml(meta.description)}</textarea><small>A short description for people browsing your theme.</small></label></div><div class="settings-note"><span>✦</span><p>Edits are applied to <b>description.xml</b> as you type. Use <b>Export .mtz</b> when you’re ready to package them.</p></div></section><section class="settings-aside"><div class="settings-card compact"><div class="settings-icon peach">⌘</div><h3>Package structure</h3><p>Theme details are stored in <code>description.xml</code>. Assets remain in their original package folders when you export.</p><button class="text-link" data-route="all">Browse package files <span>→</span></button></div><div class="settings-card compact"><div class="settings-icon purple">▧</div><h3>Safe by design</h3><p>Files stay on this computer. The editor keeps the rest of your package intact when you make changes.</p></div></section></div>`;
}

function render() {
  if (!state.project) {
    appRoot.innerHTML = welcomePage();
    return;
  }
  const page = state.route === 'overview' ? overviewPage() : state.route === 'info' ? infoPage() : libraryPage();
  appRoot.innerHTML = shell(page);
  bindSearch();
}

function bindSearch() {
  const search = document.querySelector('#file-search');
  if (!search) return;
  search.addEventListener('input', () => {
    const selectionStart = search.selectionStart;
    state.query = search.value;
    state.visibleLimit = 120;
    const panel = document.querySelector('.file-list');
    const files = routeFiles();
    panel.innerHTML = files.length ? fileRowsHtml(files) : `<div class="empty-library"><div class="empty-illustration">⌕</div><b>No matching files</b><p>Try a different search.</p></div>`;
    const count = document.querySelector('.breadcrumb-count');
    if (count) count.textContent = `${files.length} files`;
    if (!files.includes(state.selectedPath)) {
      state.selectedPath = files[0] || '';
      document.querySelector('.inspector-panel').innerHTML = inspectorHtml();
    }
    search.focus();
    search.setSelectionRange(selectionStart, selectionStart);
  });
}

appRoot.addEventListener('click', (event) => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    if (!persistTextDraft()) return;
    state.route = routeButton.dataset.route;
    state.query = '';
    state.visibleLimit = 120;
    const files = routeFiles(state.route);
    if (!files.includes(state.selectedPath)) state.selectedPath = files[0] || '';
    render();
    return;
  }

  const selectButton = event.target.closest('[data-select]');
  if (selectButton) {
    if (!persistTextDraft()) return;
    state.selectedPath = selectButton.dataset.select;
    if (state.route === 'overview') state.route = 'all';
    render();
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action && action !== 'save-text' && !persistTextDraft()) return;
  if (action === 'create') createTheme();
  if (action === 'open') importTheme();
  if (action === 'export') exportTheme();
  if (action === 'add') addFiles();
  if (action === 'replace') replaceSelected();
  if (action === 'delete') deleteSelected();
  if (action === 'save-text') saveTextEdit();
  if (action === 'more') { state.visibleLimit += 120; render(); }
});

appRoot.addEventListener('input', (event) => {
  if (event.target.id === 'text-editor') {
    state.pendingText = { path: state.selectedPath, text: event.target.value };
    state.dirty = true;
    const status = document.querySelector('#save-state');
    if (status) status.textContent = 'Unsaved changes';
    return;
  }
  const field = event.target.dataset.meta;
  if (field) updateMetadata(field, event.target.value);
});

appRoot.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    importTheme();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.project) {
    event.preventDefault();
    exportTheme();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    const input = document.querySelector('#file-search');
    if (input) { event.preventDefault(); input.focus(); }
  }
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  if (!persistTextDraft()) return;
  const file = [...(event.dataTransfer?.files || [])].find((item) => /\.(mtz|zip)$/i.test(item.name));
  if (!file) return;
  if (state.project && state.dirty && !confirm('This theme has unsaved changes. Open the dropped package and discard them?')) return;
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const files = Object.create(null);
    for (const [rawPath, data] of Object.entries(entries)) {
      const safePath = cleanArchivePath(rawPath);
      if (safePath && !rawPath.endsWith('/')) files[safePath] = data;
    }
    if (!Object.keys(files).length) throw new Error('No files were found in that archive.');
    clearAllObjectUrls();
    state.project = { name: file.name, files };
    state.route = 'overview';
    state.selectedPath = Object.keys(files).sort()[0] || '';
    state.query = '';
    state.visibleLimit = 120;
    state.pendingText = null;
    state.dirty = false;
    render();
    toast(`Opened ${file.name}`);
  } catch (error) {
    toast(error.message || 'Could not open that theme package.', 'error');
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

render();
