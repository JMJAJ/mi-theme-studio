// Design: the home of a theme. An overview of every part of the theme as
// visual cards (wallpapers, lock screen, icons, fonts, sounds…), and a part
// view with the part's assets next to the details panel.
import { TryOnButton } from '../common/TryOnButton';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FolderTree, PackageCheck, Palette, Pencil, Plus, Repeat } from 'lucide-react';
import { api, resourceUrl } from '../../lib/api';
import { formatBytes, plural } from '../../lib/format';
import type { ComponentDef, FileInfo, MetadataView } from '../../lib/types';
import * as A from '../../state/actions';
import { runCommand } from '../../state/commands';
import { getState, setState, useStore } from '../../state/store';
import { ComponentView } from './ComponentView';
import { ThemeInfo } from './ThemeInfo';
import { Welcome } from './Welcome';
import { Inspector } from '../inspector/Inspector';
import { findWallpaper } from './PreviewView';
import { PART_COPY, PART_ORDER, PartThumb } from './PartArt';
import { openSwap } from './SwapPart';
import { ColorsView } from './ColorsView';

function field(view: MetadataView | null, name: string) {
  return view?.fields.find((f) => f.name === name && f.attributes.length === 0)?.value || null;
}

function PartCard({ def, files, previews, onOpen, onSwap }: { def: ComponentDef; files: FileInfo[]; previews: FileInfo[]; onOpen: () => void; onSwap: () => void }) {
  const changed = files.filter((f) => f.status !== 'original').length;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const empty = files.length === 0;
  return (
    <div className={`part-card-wrap ${empty ? 'is-empty' : ''}`} data-drop-part={def.id}>
      <button className={`part-card ${empty ? 'is-empty' : ''}`} onClick={onOpen} title={def.description}>
        <div className="pc-art">
          <PartThumb part={def.id} files={files} previews={previews} />
          {changed > 0 && <span className="pc-changed">{changed} changed</span>}
        </div>
        <div className="pc-body">
          <div className="pc-name">{def.label}</div>
          <div className="pc-meta">{empty ? (PART_COPY[def.id] ?? def.description) : `${plural(files.length, 'file')} · ${formatBytes(bytes)}`}</div>
        </div>
      </button>
      <div className="pc-actions">
        <button className="pc-action" onClick={onSwap} title={empty ? `Take ${def.label.toLowerCase()} from another theme` : `Replace with ${def.label.toLowerCase()} from another theme`}>
          <Repeat /> {empty ? 'From a theme' : 'Swap'}
        </button>
        {empty && (
          <button className="pc-action" onClick={onOpen} title={`Add your own ${def.label.toLowerCase()} files`}>
            <Plus /> Files
          </button>
        )}
      </div>
    </div>
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
              <button className="btn" onClick={() => A.goTo('design', 'colors')}>
                <Palette /> Colours
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
          <span className="muted">What this theme changes on the phone · drop files or a .mtz on a part to change it</span>
          <div className="actions">
            <button className="btn btn-sm" onClick={() => openSwap({ part: present[0]?.id ?? 'icons' })}>
              <Repeat /> Swap a part…
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => A.goTo('files')}>
              <FolderTree /> All files
            </button>
          </div>
        </div>
        <div className="part-grid">
          {present.map((d) => (
            <PartCard key={d.id} def={d} files={byPart.get(d.id) ?? []} previews={previewImages} onOpen={() => A.goTo('design', d.id)} onSwap={() => openSwap({ part: d.id })} />
          ))}
        </div>
        {missing.length > 0 && (
          <>
            <div className="section-head design-head">
              <h2>Not in this theme yet</h2>
              <span className="muted">Take them from another theme, or add your own files</span>
            </div>
            <div className="part-grid">
              {missing.map((d) => (
                <PartCard key={d.id} def={d} files={[]} previews={[]} onOpen={() => A.goTo('design', d.id)} onSwap={() => openSwap({ part: d.id })} />
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
  const special = part === 'info' || part === 'colors';
  const label = part === 'info' ? 'Theme details' : part === 'colors' ? 'Colours' : (def?.label ?? part);
  return (
    <div className="part-view">
      <div className="part-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => A.goTo('design')}>
          <ArrowLeft /> Design
        </button>
        <span className="faint">/</span>
        <strong>{label}</strong>
        {part === 'colors' && <span className="muted ellipsis">System, status bar, launcher and app colours this theme sets</span>}
        {!special && (
          <span className="muted ellipsis">
            {PART_COPY[part] ?? def?.description} · {plural(project.files.filter((f) => f.component === part).length, 'file')}
          </span>
        )}
        {!special && (
          <button className="btn btn-sm" style={{ marginLeft: 'auto', flex: 'none' }} onClick={() => openSwap({ part })}>
            <Repeat /> Swap from another theme…
          </button>
        )}
      </div>
      <div className="part-body">
        <div className="part-main">{part === 'info' ? <ThemeInfo /> : part === 'colors' ? <ColorsView /> : <ComponentView key={part} componentId={part} embedded />}</div>
        {!special && selection > 0 && (
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
    // A new part starts clean, but keeps a file of that part picked on the way in (an icon clicked on the phone).
    const { selection, fileIndex } = getState();
    const keep = selection.filter((p) => !!part && fileIndex.get(p)?.component === part);
    if (keep.length !== selection.length) setState({ selection: keep });
  }, [part]);
  if (!project) return <Welcome />;
  return part ? <PartView part={part} /> : <Overview />;
}
