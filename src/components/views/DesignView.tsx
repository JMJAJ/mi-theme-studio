// Design: the home of a theme. An overview of every part of the theme as
// visual cards (wallpapers, lock screen, icons, fonts, sounds…), and a part
// view with the part's assets next to the details panel.
import { TryOnButton } from '../common/TryOnButton';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FolderTree, PackageCheck, Pencil, Plus, ShoppingBag } from 'lucide-react';
import { api, resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import { formatBytes, plural } from '../../lib/format';
import type { ComponentDef, FileInfo, MetadataView } from '../../lib/types';
import * as A from '../../state/actions';
import { runCommand } from '../../state/commands';
import { setState, useStore } from '../../state/store';
import { componentIcon } from '../common/icons';
import { ComponentView } from './ComponentView';
import { ThemeInfo } from './ThemeInfo';
import { Welcome } from './Welcome';
import { Inspector } from '../inspector/Inspector';
import { findWallpaper, pickIcons } from './PreviewView';

/** Order and wording that match how a theme looks on the phone. */
const PART_ORDER = ['wallpapers', 'lockscreen', 'icons', 'home', 'systemui', 'fonts', 'widgets', 'sounds', 'previews', 'settings', 'apps', 'framework', 'boot', 'other'];
const PART_COPY: Record<string, string> = {
  wallpapers: 'Home and lock screen backgrounds',
  lockscreen: 'Clock, date and unlock layout',
  icons: 'App icons, mask and folder',
  home: 'Launcher layout, folders and dock',
  systemui: 'Status bar, notifications, control center',
  fonts: 'System font',
  widgets: 'Home screen clocks and widgets',
  sounds: 'Ringtone, notification and alarm',
  previews: 'Screenshots shown in Theme Manager',
  settings: 'Settings app styling',
  apps: 'Contacts, Messages and other apps',
  framework: 'System colors and controls',
  boot: 'Animation shown while starting',
  other: 'Files that belong to no part',
};

function field(view: MetadataView | null, name: string) {
  return view?.fields.find((f) => f.name === name && f.attributes.length === 0)?.value || null;
}

/** Designer screenshots in preview/ that show a given part. */
const PREVIEW_MATCH: Record<string, RegExp> = {
  lockscreen: /lockscreen|lockstyle/i,
  home: /launcher|home/i,
  systemui: /statusbar|notification|control/i,
  widgets: /clock|widget|photo/i,
  apps: /contact|mms|dialer|message|phone/i,
  settings: /setting/i,
  icons: /icons_0|icons/i,
  framework: /framework|dialog/i,
};

function partPreviews(part: string, previews: FileInfo[]) {
  const re = PREVIEW_MATCH[part];
  if (part === 'previews') return previews.slice(0, 3);
  return re ? previews.filter((f) => re.test(fileName(f.path))).slice(0, 2) : [];
}

function Phones({ files }: { files: FileInfo[] }) {
  const wide = files.filter((f) => (f.width ?? 0) > (f.height ?? 0) * 0.8);
  if (wide.length) return <img className="pc-contain" src={resourceUrl('main', wide[0].path, wide[0].rev)} alt="" loading="lazy" />;
  return (
    <div className="pc-phones">
      {files.map((f) => (
        <img key={f.path} src={resourceUrl('main', f.path, f.rev)} alt="" loading="lazy" />
      ))}
    </div>
  );
}

function Thumb({ part, files, previews }: { part: string; files: FileInfo[]; previews: FileInfo[] }) {
  const images = files.filter((f) => f.kind === 'image');
  const url = (f: FileInfo) => resourceUrl('main', f.path, f.rev);
  const shots = partPreviews(part, previews);
  if (shots.length && part !== 'icons') return <Phones files={shots} />;
  if (part === 'icons') {
    const icons = pickIcons(files).slice(0, 12);
    if (icons.length)
      return (
        <div className="pc-icons">
          {icons.map((i) => (
            <img key={i.file.path} src={url(i.file)} alt="" loading="lazy" />
          ))}
        </div>
      );
  }
  if (part === 'wallpapers' && images.length) {
    const home = findWallpaper(files, false);
    const lock = findWallpaper(files, true);
    return <Phones files={[home, lock !== home ? lock : undefined].filter(Boolean) as FileInfo[]} />;
  }
  if (part === 'fonts') {
    const font = files.find((f) => f.kind === 'font');
    return <FontSpecimen file={font} />;
  }
  if (part === 'sounds' && files.length) {
    return (
      <div className="pc-list">
        {files.slice(0, 4).map((f) => (
          <span key={f.path} className="ellipsis">
            ♪ {fileName(f.path)}
          </span>
        ))}
      </div>
    );
  }
  const Icon = componentIcon(part);
  return (
    <div className="pc-placeholder">
      <Icon />
    </div>
  );
}

function FontSpecimen({ file }: { file?: FileInfo }) {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const name = `mts-part-font-${file.rev}`;
    const face = new FontFace(name, `url("${resourceUrl('main', file.path, file.rev)}")`);
    face
      .load()
      .then((f) => {
        document.fonts.add(f);
        setFamily(name);
      })
      .catch(() => setFamily(null));
  }, [file?.path, file?.rev]);
  return (
    <div className="pc-font" style={family ? { fontFamily: family } : undefined}>
      <span>Aa</span>
      <small>{file ? fileName(file.path) : 'System default'}</small>
    </div>
  );
}

function PartCard({ def, files, previews, onOpen }: { def: ComponentDef; files: FileInfo[]; previews: FileInfo[]; onOpen: () => void }) {
  const changed = files.filter((f) => f.status !== 'original').length;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const empty = files.length === 0;
  return (
    <button className={`part-card ${empty ? 'is-empty' : ''}`} onClick={onOpen} title={def.description}>
      <div className="pc-art">
        <Thumb part={def.id} files={files} previews={previews} />
        {changed > 0 && <span className="pc-changed">{changed} changed</span>}
      </div>
      <div className="pc-body">
        <div className="pc-name">{def.label}</div>
        <div className="pc-meta">{empty ? (PART_COPY[def.id] ?? def.description) : `${plural(files.length, 'file')} · ${formatBytes(bytes)}`}</div>
      </div>
      {empty && (
        <span className="pc-add">
          <Plus /> Add
        </span>
      )}
    </button>
  );
}

function Overview() {
  const project = useStore((s) => s.project)!;
  const validation = useStore((s) => s.validation);
  const [meta, setMeta] = useState<MetadataView | null>(null);
  const descRev = project.files.find((f) => f.path === 'description.xml')?.rev;
  useEffect(() => {
    api.metadataGet().then(setMeta).catch(() => setMeta(null));
  }, [descRev]);

  const byPart = useMemo(() => {
    const map = new Map<string, FileInfo[]>();
    for (const f of project.files) map.set(f.component, [...(map.get(f.component) ?? []), f]);
    return map;
  }, [project]);
  const defs = PART_ORDER.map((id) => project.components.find((c) => c.id === id)).filter(Boolean) as ComponentDef[];
  const present = defs.filter((d) => byPart.get(d.id)?.length);
  const missing = defs.filter((d) => !byPart.get(d.id)?.length && ['wallpapers', 'lockscreen', 'icons', 'fonts', 'sounds', 'previews', 'systemui', 'home'].includes(d.id));
  const cover = findWallpaper(project.files, true);
  const previewImages = useMemo(() => (byPart.get('previews') ?? []).filter((f) => f.kind === 'image' && !/_small_/i.test(f.path)), [byPart]);
  const designer = field(meta, 'designer') ?? field(meta, 'author');
  const version = field(meta, 'version');
  const ui = field(meta, 'uiVersion');

  return (
    <div className="view">
      <div className="design">
        <section className="hero">
          <div className="hero-art">{cover ? <img src={resourceUrl('main', cover.path, cover.rev)} alt="" /> : <div className="hero-art-empty" />}</div>
          <div className="hero-body">
            <div className="hero-kicker">Theme</div>
            <h1 className="selectable">{project.title}</h1>
            <div className="hero-meta">
              {designer && <span>by {designer}</span>}
              {version && <span>v{version}</span>}
              {ui && <span>UI {ui}</span>}
              <span>{plural(project.files.length, 'file')}</span>
              <span>{formatBytes(project.totalBytes)}</span>
            </div>
            <div className="hero-actions">
              <button className="btn" onClick={() => A.goTo('design', 'info')}>
                <Pencil /> Edit details
              </button>
              <button className="btn" onClick={() => A.goTo('check')}>
                <PackageCheck />
                {validation ? (validation.errors ? `${plural(validation.errors, 'problem')}` : validation.warnings ? plural(validation.warnings, 'warning') : 'Ready to export') : 'Check'}
              </button>
              <TryOnButton className="btn" />
              <button className="btn btn-ghost" onClick={() => runCommand('file.exportCopy')}>
                <Download /> Export .mtz
              </button>
            </div>
          </div>
        </section>

        <div className="section-head design-head">
          <h2>Parts</h2>
          <span className="muted">What this theme changes on the phone</span>
          <div className="actions">
            <button className="btn btn-sm btn-ghost" onClick={() => A.goTo('store')}>
              <ShoppingBag /> Borrow from the store
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => A.goTo('files')}>
              <FolderTree /> All files
            </button>
          </div>
        </div>
        <div className="part-grid">
          {present.map((d) => (
            <PartCard key={d.id} def={d} files={byPart.get(d.id) ?? []} previews={previewImages} onOpen={() => A.goTo('design', d.id)} />
          ))}
        </div>
        {missing.length > 0 && (
          <>
            <div className="section-head design-head">
              <h2>Not in this theme yet</h2>
              <span className="muted">Add files, or apply parts from a store theme</span>
            </div>
            <div className="part-grid">
              {missing.map((d) => (
                <PartCard key={d.id} def={d} files={[]} previews={[]} onOpen={() => A.goTo('design', d.id)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PartView({ part }: { part: string }) {
  const project = useStore((s) => s.project)!;
  const def = project.components.find((c) => c.id === part);
  const selection = useStore((s) => s.selection.length);
  const label = part === 'info' ? 'Theme details' : (def?.label ?? part);
  return (
    <div className="part-view">
      <div className="part-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => A.goTo('design')}>
          <ArrowLeft /> Design
        </button>
        <span className="faint">/</span>
        <strong>{label}</strong>
        {part !== 'info' && (
          <span className="muted ellipsis">
            {PART_COPY[part] ?? def?.description} · {plural(project.files.filter((f) => f.component === part).length, 'file')}
          </span>
        )}
      </div>
      <div className="part-body">
        <div className="part-main">{part === 'info' ? <ThemeInfo /> : <ComponentView key={part} componentId={part} embedded />}</div>
        {part !== 'info' && selection > 0 && (
          <div className="part-inspector">
            <Inspector />
          </div>
        )}
      </div>
    </div>
  );
}

export function DesignView() {
  const project = useStore((s) => s.project);
  const part = useStore((s) => s.part);
  useEffect(() => {
    // Leaving a part clears its selection so the next part starts clean.
    return () => setState({ selection: [] });
  }, [part]);
  if (!project) return <Welcome />;
  return part ? <PartView part={part} /> : <Overview />;
}
