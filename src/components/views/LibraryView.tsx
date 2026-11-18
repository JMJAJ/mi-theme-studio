// Library: every theme you have, in one place. Theme files you opened or made
// on this computer, themes and fonts downloaded from the store, and the themes
// Theme Manager has on the connected phone (including ones bought there).
import { useEffect, useMemo, useState } from 'react';
import { FileArchive, FolderOpen, HardDrive, Library, PackageOpen, Repeat, Search, ShoppingBag, Smartphone, Sparkles, Trash2, X } from 'lucide-react';
import { formatBytes, formatDateTime, plural, relativeTime } from '../../lib/format';
import type { DownloadedTheme } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { refreshDownloads, removeDownload, useThemeStore } from '../../state/themeStore';
import { openStoreTab } from '../../state/storeTab';
import { useDeviceSummary } from '../shell/deviceSummary';
import { putToUse, RemoteImage } from './CatalogView';
import { DeviceThemes } from './DeviceThemes';

type Shelf = 'all' | 'mine' | 'downloaded' | 'phone';

const SHELF_KEY = 'mts.library.shelf.v1';
function loadShelf(): Shelf {
  try {
    const v = localStorage.getItem(SHELF_KEY);
    if (v === 'all' || v === 'mine' || v === 'downloaded' || v === 'phone') return v;
  } catch {
    /* storage unavailable */
  }
  return 'all';
}

const matches = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q));

/** Theme files opened or saved on this computer. */
function MyThemes({ query, limit }: { query: string; limit?: number }) {
  const recent = useStore((s) => s.settings?.recent ?? []);
  const openPath = useStore((s) => s.project?.sourcePath ?? null);
  const items = recent.filter((r) => matches(query, r.name, r.path));
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <section className="section lib-section">
      <div className="section-head">
        <h2>
          <FileArchive /> On this computer
        </h2>
        <span className="muted">{plural(items.length, 'theme')}</span>
        <div className="actions">
          <button className="btn btn-sm" onClick={() => void A.openPackage()}>
            <FolderOpen /> Open a theme file…
          </button>
        </div>
      </div>
      {shown.length ? (
        <div className="surface lib-list">
          {shown.map((item) => {
            const open = openPath === item.path;
            return (
              <div
                key={item.path}
                className={`recent-row ${open ? 'is-open' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void A.openPackage(item.path)}
                onKeyDown={(e) => e.key === 'Enter' && void A.openPackage(item.path)}
                title={item.path}
              >
                <FileArchive />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    {item.name.replace(/\.(mtz|zip)$/i, '')}
                    {open && <span className="badge badge-info lib-open">Open now</span>}
                  </div>
                  <div className="path ellipsis">{item.path}</div>
                </div>
                <span className="faint nowrap" style={{ fontSize: 12 }}>
                  {relativeTime(item.openedAtMs)}
                </span>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title="Show file"
                  aria-label={`Show ${item.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void A.revealPath(item.path);
                  }}
                >
                  <FolderOpen />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  title="Remove from the library (the file stays)"
                  aria-label={`Remove ${item.name} from the library`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void A.removeRecent(item.path);
                  }}
                >
                  <X />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted lib-empty">{query ? 'No theme files match.' : 'Theme files you open or save show up here.'}</p>
      )}
      {limit && items.length > limit && <p className="faint lib-more">and {items.length - limit} more in “On this computer”</p>}
    </section>
  );
}

function DownloadCard({ d }: { d: DownloadedTheme }) {
  const hasProject = useStore((s) => !!s.project);
  return (
    <div className={`dl-card kind-${d.kind}`}>
      <button className="dl-cover" onClick={() => void A.openDownloadAsProject(d)} title="Open as the theme you are working on" aria-label={`Open ${d.name}`}>
        <RemoteImage src={d.cover} alt="" />
      </button>
      <div className="dl-body">
        <div className="dl-name ellipsis" title={d.name}>
          {d.name}
        </div>
        <div className="faint ellipsis">
          {d.designer ? `${d.designer} · ` : ''}
          {formatBytes(d.sizeBytes)} · {formatDateTime(d.downloadedAtMs)}
        </div>
        <div className="dl-actions">
          <button className="btn btn-sm btn-primary grow" onClick={() => void A.openDownloadAsProject(d)} title="Open as the theme you are working on">
            <PackageOpen /> Open
          </button>
          {hasProject && (
            <button className="btn btn-ghost btn-sm" title="Take parts of it into the theme you are editing" aria-label="Use in my theme" onClick={() => putToUse(d)}>
              <Repeat />
            </button>
          )}
          <button className="btn btn-ghost btn-sm" title="Show file" aria-label="Show file" onClick={() => void A.revealPath(d.path)}>
            <FolderOpen />
          </button>
          <button className="btn btn-ghost btn-sm" title="Delete download" aria-label="Delete download" onClick={() => void removeDownload(d)}>
            <Trash2 />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Themes and fonts downloaded from the store (wallpapers and ringtones stay in the store's Downloaded tab). */
function Downloaded({ query, limit }: { query: string; limit?: number }) {
  const downloads = useThemeStore((s) => s.downloads);
  const loaded = useThemeStore((s) => s.loaded);
  const themes = useMemo(() => downloads.filter((d) => d.kind === 'theme' || d.kind === 'font' || d.kind === 'icon').sort((a, b) => b.downloadedAtMs - a.downloadedAtMs), [downloads]);
  const items = themes.filter((d) => matches(query, d.name, d.designer));
  const shown = limit ? items.slice(0, limit) : items;
  const media = downloads.length - themes.length;
  return (
    <section className="section lib-section">
      <div className="section-head">
        <h2>
          <HardDrive /> Downloaded from the store
        </h2>
        <span className="muted">
          {plural(items.length, 'theme')}
          {items.length ? ` · ${formatBytes(items.reduce((n, d) => n + d.sizeBytes, 0))}` : ''}
        </span>
        <div className="actions">
          {media > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => openStoreTab('downloads')} title="Wallpapers and ringtones you downloaded">
              {plural(media, 'wallpaper or ringtone', 'wallpapers & ringtones')}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => openStoreTab('discover')}>
            <ShoppingBag /> Browse the store
          </button>
        </div>
      </div>
      {!loaded ? (
        <p className="muted lib-empty">Loading…</p>
      ) : shown.length ? (
        <div className="dl-grid kind-theme">
          {shown.map((d) => (
            <DownloadCard key={d.moduleId} d={d} />
          ))}
        </div>
      ) : (
        <p className="muted lib-empty">{query ? 'No downloads match.' : 'Free themes you download from the store show up here, and stay available offline.'}</p>
      )}
      {limit && items.length > limit && <p className="faint lib-more">and {items.length - limit} more in “Downloaded”</p>}
    </section>
  );
}

function OnPhone({ refreshKey }: { refreshKey: number }) {
  const device = useDeviceSummary();
  return (
    <section className="section lib-section">
      <div className="section-head">
        <h2>
          <Smartphone /> On {device.ready ? device.label : 'your phone'}
        </h2>
        <span className="muted">Themes Theme Manager has, including ones you bought</span>
      </div>
      <DeviceThemes refreshKey={refreshKey} compact headless />
    </section>
  );
}

export function LibraryView() {
  const [shelf, setShelf] = useState<Shelf>(loadShelf);
  const [query, setQuery] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const recentCount = useStore((s) => s.settings?.recent.length ?? 0);
  const downloadCount = useThemeStore((s) => s.downloads.filter((d) => d.kind === 'theme' || d.kind === 'font' || d.kind === 'icon').length);

  useEffect(() => {
    void refreshDownloads();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(SHELF_KEY, shelf);
    } catch {
      /* storage unavailable */
    }
  }, [shelf]);

  const q = query.trim().toLowerCase();
  return (
    <div className="view">
      <div className="phone-page lib-page">
        <div className="lib-head">
          <h1>
            <Library /> Library
          </h1>
          <span className="muted">Every theme you have: files on this computer, store downloads and the themes on your phone.</span>
        </div>
        <div className="toolbar lib-toolbar">
          <div className="segmented" role="group" aria-label="Show">
            <button aria-pressed={shelf === 'all'} onClick={() => setShelf('all')}>
              All
            </button>
            <button aria-pressed={shelf === 'mine'} onClick={() => setShelf('mine')}>
              <FileArchive /> On this computer {recentCount ? <span className="faint">{recentCount}</span> : null}
            </button>
            <button aria-pressed={shelf === 'downloaded'} onClick={() => setShelf('downloaded')}>
              <HardDrive /> Downloaded {downloadCount ? <span className="faint">{downloadCount}</span> : null}
            </button>
            <button aria-pressed={shelf === 'phone'} onClick={() => setShelf('phone')}>
              <Smartphone /> On phone
            </button>
          </div>
          <span className="grow" />
          {shelf !== 'phone' && (
            <label className="lib-search">
              <Search />
              <input className="input" placeholder="Search your themes" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search your themes" />
            </label>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              void refreshDownloads();
              setRefreshKey((k) => k + 1);
            }}
            title="Refresh"
          >
            Refresh
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => void A.newProject()} title="Start a new theme from scratch">
            <Sparkles /> New theme
          </button>
        </div>

        {shelf === 'all' && (
          <>
            <MyThemes query={q} limit={8} />
            <Downloaded query={q} limit={12} />
            <OnPhone refreshKey={refreshKey} />
          </>
        )}
        {shelf === 'mine' && <MyThemes query={q} />}
        {shelf === 'downloaded' && <Downloaded query={q} />}
        {shelf === 'phone' && <OnPhone refreshKey={refreshKey} />}
      </div>
    </div>
  );
}
