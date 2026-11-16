// Theme store: browse and search the online catalog, inspect a theme
// (screenshots, description, details), download free themes and apply all
// or selected parts of them to the open project.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Globe,
  HardDrive,
  ImageOff,
  Layers,
  LayoutGrid,
  Loader2,
  Lock,
  Music,
  Image as ImageIcon,
  Type,
  Palette,
  Bell,
  AlarmClock,
  Phone,
  Monitor,
  PackageOpen,
  RefreshCw,
  Search,
  Smartphone,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import { splitNested } from '../../lib/paths';
import type { DownloadedTheme, ProductKind, ProjectSnapshot, StoreLink, StorePage, StoreProduct, StoreQuery, ThemeDetail } from '../../lib/types';
import * as A from '../../state/actions';
import { setState, useStore } from '../../state/store';
import {
  REGIONS,
  REGION_NOTES,
  cancelDownload,
  formatPrice,
  setFreeOnly,
  downloadTheme,
  refreshDownloads,
  removeDownload,
  setRegion,
  useThemeStore,
} from '../../state/themeStore';
import { DeviceThemes } from './DeviceThemes';
import { useStoreTabRequest, type StoreTab } from '../../state/storeTab';

const CONSENT_KEY = 'mts.catalog.consent.v1';

type Tab = StoreTab;

const KINDS: { kind: ProductKind; label: string; noun: string; icon: typeof Palette }[] = [
  { kind: 'theme', label: 'Themes', noun: 'theme', icon: Palette },
  { kind: 'font', label: 'Fonts', noun: 'font', icon: Type },
  { kind: 'wallpaper', label: 'Wallpapers', noun: 'wallpaper', icon: ImageIcon },
  { kind: 'ringtone', label: 'Ringtones', noun: 'ringtone', icon: Music },
];
const nounOf = (kind: ProductKind) => KINDS.find((k) => k.kind === kind)?.noun ?? 'item';
const isPackage = (kind: ProductKind) => kind === 'theme' || kind === 'font';
type Route = { type: 'list'; query: StoreQuery; title: string } | { type: 'detail'; moduleId: string; name: string };

function readConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

function RemoteImage({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="img-fallback">
        <ImageOff width={16} />
      </span>
    );
  }
  return <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} draggable={false} />;
}

function ProgressBar({ received, total }: { received: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : null;
  return (
    <div className="store-progress" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className={pct === null ? 'bar indeterminate' : 'bar'} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// cards

function ProductCard({ product, onOpen }: { product: StoreProduct; onOpen: () => void }) {
  const downloaded = useThemeStore((s) => s.downloads.some((d) => d.moduleId === product.moduleId));
  const progress = useThemeStore((s) => s.progress[product.moduleId]);
  return (
    <button className={`product-card kind-${product.kind}`} onClick={onOpen} title={product.name}>
      <div className="cover">
        <RemoteImage src={product.imageUrl} alt={product.name} />
        {downloaded && (
          <span className="cover-badge" title="Downloaded">
            <Check />
          </span>
        )}
        {progress && (
          <div className="cover-progress">
            <ProgressBar {...progress} />
          </div>
        )}
      </div>
      <div className="meta">
        <span className="name ellipsis">{product.name}</span>
        <span className="sub">
          {product.priceCents > 0 ? (
            <span className="badge badge-warn">
              <Lock /> {formatPrice(product.priceCents, product.currency)}
            </span>
          ) : (
            <span className="badge badge-ok">Free</span>
          )}
          {product.sizeBytes ? <span className="faint">{formatBytes(product.sizeBytes)}</span> : null}
        </span>
      </div>
    </button>
  );
}

function LinkTile({ link, onOpen }: { link: StoreLink; onOpen: () => void }) {
  if (link.icon) {
    return (
      <button className="icon-link" onClick={onOpen}>
        <RemoteImage src={link.imageUrl} alt={link.title ?? ''} />
        <span className="ellipsis" style={{ maxWidth: '100%' }}>
          {link.title ?? '—'}
        </span>
      </button>
    );
  }
  return (
    <button className="catalog-card link-card" onClick={onOpen}>
      <div className="img">
        <RemoteImage src={link.imageUrl} alt={link.title ?? ''} />
      </div>
      {link.title && (
        <div className="cap">
          <span className="ellipsis grow">{link.title}</span>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// listing

function StoreList({
  query,
  refreshKey,
  navigate,
}: {
  query: StoreQuery;
  refreshKey: number;
  navigate: (route: Route) => void;
}) {
  const region = useThemeStore((s) => s.region);
  const freeOnly = useThemeStore((s) => s.freeOnly);
  const [pages, setPages] = useState<StorePage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const flat = query.kind === 'subject' || query.kind === 'search';

  const load = async (more: boolean) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const start = more && pages.length ? pages[pages.length - 1].nextStart : 0;
      const page = await api.storePage(query, start, region);
      if (id !== request.current) return;
      setPages((p) => (more ? [...p, page] : [page]));
    } catch (e) {
      if (id === request.current) setError(errorMessage(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    setPages([]);
    void load(false);
  }, [JSON.stringify(query), region, refreshKey]);

  const visible = (p: StoreProduct) => !freeOnly || p.priceCents === 0;
  const sections = pages
    .flatMap((p) => p.sections)
    .map((s) => ({ ...s, products: s.products.filter(visible) }))
    .filter((s) => s.products.length > 0 || s.links.length > 0);
  const hiddenPaid = freeOnly ? pages.flatMap((p) => p.sections).reduce((n, s) => n + s.products.filter((p) => p.priceCents > 0).length, 0) : 0;
  const last = pages[pages.length - 1];
  const openProduct = (p: StoreProduct) => navigate({ type: 'detail', moduleId: p.moduleId, name: p.name });
  const openLink = (l: StoreLink) => {
    if (l.moduleId) navigate({ type: 'detail', moduleId: l.moduleId, name: l.title ?? 'Theme' });
    else if (l.pageId) navigate({ type: 'list', query: { kind: 'page', id: l.pageId }, title: l.title ?? 'Themes' });
  };

  if (error && !pages.length) {
    return (
      <div className="banner banner-err">
        <AlertTriangle />
        <span className="grow">{error}</span>
        <button className="btn btn-sm" onClick={() => void load(false)}>
          Retry
        </button>
      </div>
    );
  }
  if (!pages.length) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
        <p>Loading themes…</p>
      </div>
    );
  }

  const products = flat ? dedupe(sections.flatMap((s) => s.products)) : [];
  const empty = flat ? products.length === 0 : sections.length === 0;

  return (
    <>
      {empty && (
        <div className="empty">
          <Globe />
          <h3>{query.kind === 'search' ? `No themes match “${query.keywords}”` : 'Nothing here yet'}</h3>
          <p>
            {hiddenPaid
              ? `${plural(hiddenPaid, 'paid theme')} hidden by “Free only”.`
              : query.kind === 'search'
                ? 'Try another word, or switch region.'
                : 'The store returned an empty page for this region. Try another region.'}
          </p>
        </div>
      )}
      {flat ? (
        products.length > 0 && (
          <div className="product-grid">
            {products.map((p) => (
              <ProductCard key={p.moduleId} product={p} onOpen={() => openProduct(p)} />
            ))}
          </div>
        )
      ) : (
        <div className="store-sections">
        {sections.map((section, i) => (
          <div
            className={`section ${
              (section.products.length > 0 && section.products.length <= 4 && !section.links.length) ||
              (!section.products.length && section.links.length > 0 && section.links.length <= 2 && !section.links.some((l) => l.icon))
                ? 'shelf-card'
                : 'shelf-wide'
            }`}
            key={`${section.id ?? 's'}-${i}`}
          >
            {(section.title || section.subjectId) && section.products.length > 0 && (
              <div className="section-head">
                <h2>{section.title ?? 'Themes'}</h2>
                {section.subtitle && section.subtitle.trim() && <span className="muted">{section.subtitle}</span>}
                {section.subjectId && (
                  <div className="actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate({ type: 'list', query: { kind: 'subject', id: section.subjectId! }, title: section.title ?? 'Themes' })}
                    >
                      See all <ChevronRight />
                    </button>
                  </div>
                )}
              </div>
            )}
            {!section.products.length && section.title && (
              <div className="section-head">
                <h2>{section.title}</h2>
              </div>
            )}
            {section.products.length > 0 && (
              <div className="product-grid" style={section.products.length <= 4 ? { ['--shelf-count' as string]: section.products.length } : undefined}>
                {section.products.map((p) => (
                  <ProductCard key={p.moduleId} product={p} onOpen={() => openProduct(p)} />
                ))}
              </div>
            )}
            {section.links.length > 0 && (
              <div
                className={section.links.every((l) => l.icon) ? 'icon-links' : 'catalog-grid'}
                style={!section.products.length && section.links.length <= 2 && !section.links.some((l) => l.icon) ? { gridTemplateColumns: `repeat(${section.links.length}, minmax(0, 1fr))` } : undefined}
              >
                {section.links.map((l, j) => (
                  <LinkTile key={`${l.pageId ?? l.moduleId}-${j}`} link={l} onOpen={() => openLink(l)} />
                ))}
              </div>
            )}
          </div>
        ))}
        </div>
      )}
      {error && pages.length > 0 && (
        <div className="banner banner-err" style={{ marginTop: 14 }}>
          <AlertTriangle />
          <span className="grow">{error}</span>
        </div>
      )}
      {last?.hasMore && (
        <div className="section" style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="btn" disabled={loading} onClick={() => void load(true)}>
            {loading && <Loader2 className="spin" />} Load more
          </button>
        </div>
      )}
    </>
  );
}

function dedupe(products: StoreProduct[]) {
  const seen = new Set<string>();
  return products.filter((p) => (seen.has(p.moduleId) ? false : (seen.add(p.moduleId), true)));
}

// ---------------------------------------------------------------------------
// parts of a downloaded theme

interface Part {
  path: string;
  label: string;
  hint: string;
  files: number;
  bytes: number;
}

const PART_LABELS: Record<string, [string, string]> = {
  'description.xml': ['Theme info', 'Title, author and version (description.xml)'],
  'plugin_config.xml': ['Plugin config', 'Widget and plugin settings'],
  wallpaper: ['Wallpapers', 'Home and lock screen wallpapers'],
  preview: ['Store previews', 'Preview images shown in Theme Manager'],
  fonts: ['Fonts', 'System font files'],
  ringtones: ['Sounds', 'Ringtones and notification sounds'],
  audio: ['Sounds', 'Ringtones and notification sounds'],
  boots: ['Boot animation', 'Boot animation archives'],
  icons: ['Icons', 'App icons and icon mask'],
  lockscreen: ['Lock screen', 'Lock screen layout (MAML)'],
  lockstyle: ['Lock style', 'Lock screen style'],
  'com.android.systemui': ['Status bar & notifications', 'System UI'],
  'miui.systemui.plugin': ['Control center', 'System UI plugin'],
  'com.miui.home': ['Home screen', 'Launcher layout and assets'],
  'framework-res': ['System framework', 'Colors and system resources'],
  'framework-miui-res': ['MIUI framework', 'MIUI system resources'],
  'com.android.settings': ['Settings app', 'Settings styling'],
  'com.android.contacts': ['Contacts & dialer', 'Contacts styling'],
  'com.android.mms': ['Messages', 'Messaging styling'],
};

function partsOf(ref: ProjectSnapshot): Part[] {
  const map = new Map<string, Part>();
  const labelFor = (name: string): [string, string] => {
    if (PART_LABELS[name]) return PART_LABELS[name];
    const def = ref.components.find((c) => c.id === name || c.defaultRoot === name);
    if (def) return [def.label, def.description];
    if (name.startsWith('clock_')) return [`Clock widget ${name.slice(6)}`, 'Home screen clock'];
    if (name.startsWith('photoframe_')) return [`Photo frame ${name.slice(11)}`, 'Home screen widget'];
    return [name, 'App overlay'];
  };
  for (const c of ref.containers) {
    const [label, hint] = labelFor(c.name);
    map.set(c.name, { path: c.name, label, hint, files: c.files, bytes: c.bytes });
  }
  for (const f of ref.files) {
    const [outer, inner] = splitNested(f.path);
    if (inner !== null) continue;
    const top = outer.includes('/') ? outer.split('/')[0] : outer;
    if (map.has(top) && ref.containers.some((c) => c.name === top)) continue;
    const existing = map.get(top);
    if (existing) {
      existing.files += 1;
      existing.bytes += f.size;
    } else {
      const [label, hint] = labelFor(top);
      map.set(top, { path: top, label, hint, files: 1, bytes: f.size });
    }
  }
  const order = (p: Part) => (p.path === 'description.xml' ? 2 : p.path === 'preview' ? 1 : 0);
  return [...map.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
}

function PartsPicker({ theme, onClose }: { theme: DownloadedTheme; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const reference = useStore((s) => s.reference);
  const [opening, setOpening] = useState(false);
  const ready = reference?.sourcePath === theme.path ? reference : null;
  const parts = useMemo(() => (ready ? partsOf(ready) : []), [ready]);
  const [selected, setSelected] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (ready || opening) return;
    setOpening(true);
    void A.openDownloadAsReference(theme, false).finally(() => setOpening(false));
  }, [theme.path, ready]);

  useEffect(() => {
    if (ready && !selected) setSelected(new Set(parts.filter((p) => p.path !== 'description.xml' && p.path !== 'preview').map((p) => p.path)));
  }, [ready, parts]);

  const chosen = parts.filter((p) => selected?.has(p.path));
  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="surface parts-picker">
      <div className="section-head" style={{ padding: '12px 14px 0' }}>
        <Layers width={16} className="muted" />
        <h2>Apply parts to your theme</h2>
        <div className="actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close parts picker">
            <X />
          </button>
        </div>
      </div>
      {!ready ? (
        <div className="empty" style={{ padding: 24 }}>
          <Loader2 className="spin" />
          <p>Reading package…</p>
        </div>
      ) : (
        <>
          <div className="parts-toolbar">
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(parts.map((p) => p.path)))}>
              Select all
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
              Select none
            </button>
            <span className="grow" />
            <span className="muted">
              {plural(chosen.length, 'part')} · {plural(chosen.reduce((n, p) => n + p.files, 0), 'file')} · {formatBytes(chosen.reduce((n, p) => n + p.bytes, 0))}
            </span>
          </div>
          <div className="parts-list">
            {parts.map((part) => (
              <label key={part.path} className={`part-row ${selected?.has(part.path) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={!!selected?.has(part.path)} onChange={() => toggle(part.path)} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="part-name">{part.label}</span>
                  <span className="part-hint ellipsis">
                    {part.hint} · <code>{part.path}</code>
                  </span>
                </span>
                <span className="faint nowrap">
                  {plural(part.files, 'file')} · {formatBytes(part.bytes)}
                </span>
              </label>
            ))}
          </div>
          <div className="parts-footer">
            {project ? (
              <>
                <span className="muted grow">
                  Copies into <strong>{project.title}</strong> as one undoable change. Existing files at the same paths are replaced; you can review before applying.
                </span>
                <button
                  className="btn btn-primary"
                  disabled={!chosen.length}
                  onClick={() =>
                    setState({
                      dialog: { type: 'copyPlan', paths: chosen.map((p) => p.path), policy: 'overwrite', title: `Apply from “${theme.name}”` },
                    })
                  }
                >
                  <Layers /> Apply {plural(chosen.length, 'part')}…
                </button>
              </>
            ) : (
              <>
                <span className="muted grow">Open or create a theme first, or start from this whole theme.</span>
                <button className="btn" onClick={() => void A.newProject()}>
                  New empty theme
                </button>
                <button className="btn btn-primary" onClick={() => void A.openDownloadAsProject(theme)}>
                  <PackageOpen /> Use whole theme
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// detail

function Lightbox({ images, index, onClose, onIndex }: { images: string[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
      else if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, images.length]);
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-nav left" onClick={(e) => (e.stopPropagation(), onIndex((index - 1 + images.length) % images.length))} aria-label="Previous screenshot">
        <ChevronLeft />
      </button>
      <img src={images[index]} alt={`Screenshot ${index + 1}`} onClick={(e) => e.stopPropagation()} referrerPolicy="no-referrer" draggable={false} />
      <button className="lightbox-nav right" onClick={(e) => (e.stopPropagation(), onIndex((index + 1) % images.length))} aria-label="Next screenshot">
        <ChevronRight />
      </button>
      <span className="lightbox-count">
        {index + 1} / {images.length}
      </span>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

function StoreDetail({ moduleId, refreshKey, navigate }: { moduleId: string; refreshKey: number; navigate: (route: Route) => void }) {
  const region = useThemeStore((s) => s.region);
  const downloaded = useThemeStore((s) => s.downloads.find((d) => d.moduleId === moduleId));
  const progress = useThemeStore((s) => s.progress[moduleId]);
  const [detail, setDetail] = useState<ThemeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const phoneReady = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .storeDetail(moduleId, region)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [moduleId, region, refreshKey]);

  if (error && !detail) {
    return (
      <div className="banner banner-err">
        <AlertTriangle />
        <span className="grow">{error}</span>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
        <p>Loading theme…</p>
      </div>
    );
  }

  const canDownload = detail.free || detail.bought;
  const start = async () => {
    const record = await downloadTheme(detail.moduleId, detail.name);
    if (record) setPicking(true);
  };

  return (
    <div className="store-detail">
      <div className="shots">
        {detail.screenshots.length ? (
          detail.screenshots.map((src, i) => (
            <button key={src} className="shot" onClick={() => setLightbox(i)} aria-label={`Open screenshot ${i + 1}`}>
              <RemoteImage src={src} alt={`${detail.name} screenshot ${i + 1}`} />
            </button>
          ))
        ) : (
          <div className="empty">
            <ImageOff />
            <p>No screenshots</p>
          </div>
        )}
      </div>

      <div className="detail-body">
        <div className="detail-main">
          <h1 className="selectable">{detail.name}</h1>
          {detail.designer && (
            <div className="designer">
              {detail.designerIcon ? <img src={detail.designerIcon} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{detail.designer.slice(0, 1)}</span>}
              <span>
                by <strong>{detail.designer}</strong>
                {detail.designerThemes ? <span className="faint"> · {plural(detail.designerThemes, 'theme')}</span> : null}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => navigate({ type: 'list', query: { kind: 'search', keywords: detail.designer!, product: detail.kind }, title: `Search “${detail.designer}”` })}
              >
                <Search /> More like this
              </button>
            </div>
          )}
          {detail.tags.length > 0 && (
            <div className="tags">
              {detail.tags.map((t) => (
                <button key={t} className="chip" onClick={() => navigate({ type: 'list', query: { kind: 'search', keywords: t, product: detail.kind }, title: `Search “${t}”` })}>
                  {t}
                </button>
              ))}
            </div>
          )}
          {detail.audioUrl && (
            <audio className="store-audio" controls preload="none" src={detail.audioUrl}>
              Audio preview is not supported.
            </audio>
          )}
          {detail.description && <p className="description selectable">{detail.description}</p>}
          <div className="facts">
            <Fact label="Price">
              {detail.free
                ? 'Free'
                : detail.bought
                  ? 'Purchased'
                  : detail.priceKnown
                    ? formatPrice(detail.priceCents, detail.currency)
                    : 'Not stated'}
            </Fact>
            {detail.sizeBytes ? <Fact label="Size">{formatBytes(detail.sizeBytes)}</Fact> : null}
            {detail.version ? <Fact label="Version">{detail.version}</Fact> : null}
            {detail.uiVersion ? <Fact label="UI version">{detail.uiVersion}</Fact> : null}
            {detail.downloads ? <Fact label="Downloads">{detail.downloads.toLocaleString()}</Fact> : null}
            {detail.score ? (
              <Fact label="Rating">
                <Star width={13} /> {detail.score.toFixed(1)}
              </Fact>
            ) : null}
          </div>
        </div>

        <aside className="detail-actions surface surface-pad">
          {!canDownload ? (
            <>
              <div className="banner banner-warn">
                <Lock />
                <span>
                  {detail.priceKnown
                    ? `Paid ${nounOf(detail.kind)} (${formatPrice(detail.priceCents, detail.currency)}). Mi Theme Studio only downloads items the store lists as free. Buy it in Theme Manager on your phone${detail.kind === 'theme' ? ', then import it from the “On device” tab' : ''}.`
                    : `The store did not state a price for this ${nounOf(detail.kind)}, so Mi Theme Studio will not download it. Free items are listed at zero.`}
                </span>
              </div>
            </>
          ) : progress ? (
            <>
              <div className="row">
                <Loader2 className="spin" />
                <span className="grow">
                  Downloading… {progress.total ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}` : formatBytes(progress.received)}
                </span>
              </div>
              <ProgressBar {...progress} />
              <button className="btn btn-sm" onClick={() => cancelDownload(moduleId)}>
                Cancel
              </button>
            </>
          ) : downloaded ? (
            <>
              <div className="row ok">
                <Check width={16} /> <span>Downloaded · verified</span>
              </div>
              {isPackage(downloaded.kind) ? (
                <>
                  <button className="btn btn-primary" onClick={() => setPicking(true)}>
                    <Layers /> Apply {downloaded.kind === 'font' ? 'font' : 'parts'} to my theme…
                  </button>
                  <button className="btn" onClick={() => void A.openDownloadAsProject(downloaded)}>
                    <PackageOpen /> Open whole {nounOf(downloaded.kind)} as project
                  </button>
                  <button className="btn" onClick={() => void A.openDownloadAsReference(downloaded)}>
                    <BookOpen /> Browse files as reference
                  </button>
                </>
              ) : (
                <MediaActions item={downloaded} />
              )}
              <div className="row">
                <button className="btn btn-ghost btn-sm" onClick={() => void A.revealPath(downloaded.path)}>
                  <FolderOpen /> Show file
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void removeDownload(downloaded)}>
                  <Trash2 /> Delete download
                </button>
              </div>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => void start()}>
                <Download /> Download{detail.sizeBytes ? ` · ${formatBytes(detail.sizeBytes)}` : ''}
              </button>
              <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                Saved to the app’s downloads folder and checked against the store’s SHA-1.
              </span>
            </>
          )}
          {phoneReady && (
            <button
              className="btn btn-ghost btn-sm"
              title="Opens this item's page in Theme Manager on the connected phone, where you can apply or buy it"
              onClick={() => void A.openStoreItemOnDevice(detail.moduleId, detail.name)}
            >
              <Smartphone /> Open in Theme Manager on phone
            </button>
          )}
        </aside>
      </div>

      {picking && downloaded && (
        <div className="section">
          <PartsPicker theme={downloaded} onClose={() => setPicking(false)} />
        </div>
      )}

      {lightbox !== null && detail.screenshots.length > 0 && (
        <Lightbox images={detail.screenshots} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function MediaActions({ item, compact = false }: { item: DownloadedTheme; compact?: boolean }) {
  const hasProject = useStore((s) => !!s.project);
  const cls = compact ? 'btn btn-sm' : 'btn';
  if (!hasProject) {
    return (
      <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
        Open or create a theme to use this {nounOf(item.kind)}.
      </span>
    );
  }
  if (item.kind === 'wallpaper') {
    return (
      <>
        <button className={`${cls} ${compact ? '' : 'btn-primary'}`} onClick={() => void A.applyDownloadedMedia(item, ['homeWallpaper', 'lockWallpaper'])}>
          <ImageIcon /> Use for home &amp; lock
        </button>
        <button className={cls} onClick={() => void A.applyDownloadedMedia(item, ['homeWallpaper'])}>
          <Monitor /> Home only
        </button>
        <button className={cls} onClick={() => void A.applyDownloadedMedia(item, ['lockWallpaper'])}>
          <Lock /> Lock only
        </button>
      </>
    );
  }
  return (
    <>
      <button className={`${cls} ${compact ? '' : 'btn-primary'}`} onClick={() => void A.applyDownloadedMedia(item, ['ringtone'])}>
        <Phone /> Use as ringtone
      </button>
      <button className={cls} onClick={() => void A.applyDownloadedMedia(item, ['notification'])}>
        <Bell /> Notification
      </button>
      <button className={cls} onClick={() => void A.applyDownloadedMedia(item, ['alarm'])}>
        <AlarmClock /> Alarm
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// downloads library

function DownloadsLibrary({ navigate }: { navigate: (route: Route) => void }) {
  const downloads = useThemeStore((s) => s.downloads);
  const loaded = useThemeStore((s) => s.loaded);
  const [picking, setPicking] = useState<DownloadedTheme | null>(null);
  if (!loaded) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
      </div>
    );
  }
  if (!downloads.length) {
    return (
      <div className="empty">
        <HardDrive />
        <h3>Nothing downloaded yet</h3>
        <p>Download free themes, fonts, wallpapers or ringtones from Discover. Downloads stay available offline.</p>
      </div>
    );
  }
  return (
    <>
      {picking && (
        <div className="section" style={{ marginTop: 0, marginBottom: 18 }}>
          <PartsPicker key={picking.moduleId} theme={picking} onClose={() => setPicking(null)} />
        </div>
      )}
      <div className="section-head">
        <h2>Downloaded</h2>
        <span className="muted">
          {plural(downloads.length, 'item')} · {formatBytes(downloads.reduce((n, d) => n + d.sizeBytes, 0))}
        </span>
      </div>
      <div className="download-list surface">
        {downloads.map((d) => (
          <div key={d.moduleId} className="download-row">
            <button className={`thumb kind-${d.kind}`} onClick={() => navigate({ type: 'detail', moduleId: d.moduleId, name: d.name })} aria-label={`Open ${d.name}`}>
              <RemoteImage src={d.cover} alt="" />
            </button>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="name ellipsis">{d.name}</div>
              <div className="faint ellipsis">
                <span className="badge badge-outline">{nounOf(d.kind)}</span> {d.designer ? `${d.designer} · ` : ''}
                {formatBytes(d.sizeBytes)} · {formatDateTime(d.downloadedAtMs)}
              </div>
            </div>
            <div className="row">
              {isPackage(d.kind) ? (
                <>
                  <button className="btn btn-sm" onClick={() => setPicking(d)}>
                    <Layers /> Apply parts…
                  </button>
                  <button className="btn btn-sm" onClick={() => void A.openDownloadAsProject(d)}>
                    <PackageOpen /> Open
                  </button>
                </>
              ) : (
                <MediaActions item={d} compact />
              )}
              <button className="btn btn-ghost btn-sm" title="Show file" aria-label="Show file" onClick={() => void A.revealPath(d.path)}>
                <FolderOpen />
              </button>
              <button className="btn btn-ghost btn-sm" title="Delete download" aria-label="Delete download" onClick={() => void removeDownload(d)}>
                <Trash2 />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// root

const PRODUCT_KEY = 'mts.store.product.v1';
function loadProduct(): ProductKind {
  try {
    const v = localStorage.getItem(PRODUCT_KEY);
    if (v && KINDS.some((k) => k.kind === v)) return v as ProductKind;
  } catch {
    /* ignore */
  }
  return 'theme';
}

function rootFor(tab: 'discover' | 'categories', product: ProductKind): Route {
  return tab === 'categories'
    ? { type: 'list', query: { kind: 'categories' }, title: 'Categories' }
    : { type: 'list', query: { kind: 'home', product }, title: KINDS.find((k) => k.kind === product)?.label ?? 'Discover' };
}

export function CatalogView() {
  const region = useThemeStore((s) => s.region);
  const freeOnly = useThemeStore((s) => s.freeOnly);
  const [tab, setTab] = useState<Tab>(() => useStoreTabRequest.getState().tab ?? 'discover');
  const tabRequest = useStoreTabRequest((s) => s.seq);
  useEffect(() => {
    const requested = useStoreTabRequest.getState().tab;
    if (requested) {
      setTab(requested);
      setStack([]);
      useStoreTabRequest.setState({ tab: null });
    }
  }, [tabRequest]);
  const [product, setProductState] = useState<ProductKind>(loadProduct);
  const [stack, setStack] = useState<Route[]>([]);
  const setProduct = (next: ProductKind) => {
    setProductState(next);
    try {
      localStorage.setItem(PRODUCT_KEY, next);
    } catch {
      /* ignore */
    }
    if (tab === 'categories' && next !== 'theme') setTab('discover');
    if (tab === 'device') setTab('discover');
    setStack([]);
  };
  const [consent, setConsent] = useState(readConsent);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshDownloads();
  }, []);

  const route: Route | null = stack.length ? stack[stack.length - 1] : tab === 'discover' || tab === 'categories' ? rootFor(tab, product) : null;
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [route && JSON.stringify(route), tab]);

  const navigate = (next: Route) => {
    if (tab === 'device') setTab('discover');
    setStack((s) => [...s, next]);
  };
  const back = () => setStack((s) => s.slice(0, -1));
  const switchTab = (next: Tab) => {
    setTab(next);
    setStack([]);
  };
  const runSearch = () => {
    const keywords = search.trim();
    if (!keywords) return;
    if (tab !== 'discover' && tab !== 'categories') setTab('discover');
    setStack((s) => [...s.filter((r) => !(r.type === 'list' && r.query.kind === 'search')), { type: 'list', query: { kind: 'search', keywords, product }, title: `Search ${KINDS.find((k) => k.kind === product)?.label.toLowerCase()} “${keywords}”` }]);
  };
  const allow = () => {
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* ignore */
    }
    setConsent(true);
  };

  const needsNetwork = tab !== 'device' && !(tab === 'downloads' && !stack.length);

  return (
    <div className="center-body">
      <div className="toolbar">
        {stack.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={back} title="Back">
            <ArrowLeft /> Back
          </button>
        )}
        <div className="segmented" role="group" aria-label="Store section">
          <button aria-pressed={tab === 'discover' && !stack.length} onClick={() => switchTab('discover')}>
            <Sparkles /> Discover
          </button>
          <button aria-pressed={tab === 'categories' && !stack.length} onClick={() => switchTab('categories')} disabled={product !== 'theme'} title={product !== 'theme' ? 'Categories are available for themes' : undefined}>
            <LayoutGrid /> Categories
          </button>
          <button aria-pressed={tab === 'downloads' && !stack.length} onClick={() => switchTab('downloads')}>
            <HardDrive /> Downloaded
          </button>
          <button aria-pressed={tab === 'device'} onClick={() => switchTab('device')}>
            <Smartphone /> On device
          </button>
        </div>
        <form
          className="search grow"
          style={{ maxWidth: 340, minWidth: 200 }}
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <Search />
          <input className="input" placeholder={`Search ${KINDS.find((k) => k.kind === product)?.label.toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the store" />
        </form>
        <span className="grow" />
        {tab !== 'device' && (
          <>
            <label className="check" title="Hide paid themes (only free themes can be downloaded)">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Free only
        </label>
        <select
          className="select"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          aria-label="Store region"
          title="Store region: changes which themes and prices the store returns"
          style={{ width: 'auto' }}
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
              {REGION_NOTES[r] ? ` · ${REGION_NOTES[r]}` : ''}
            </option>
          ))}
        </select>
          </>
        )}
        <button className="btn btn-sm" onClick={() => (tab === 'downloads' && !stack.length ? void refreshDownloads() : setRefreshKey((k) => k + 1))} title="Refresh">
          <RefreshCw />
        </button>
      </div>
      {tab !== 'device' && (
        <div className="kind-bar" role="tablist" aria-label="Store content type">
          {KINDS.map(({ kind, label, icon: Icon }) => (
            <button key={kind} role="tab" aria-selected={product === kind} className={product === kind ? 'is-on' : ''} onClick={() => setProduct(kind)}>
              <Icon /> {label}
            </button>
          ))}
        </div>
      )}
      {stack.length > 0 && (
        <div className="crumbs">
          <button onClick={() => setStack([])}>{tab === 'categories' ? 'Categories' : tab === 'downloads' ? 'Downloaded' : KINDS.find((k) => k.kind === product)?.label}</button>
          {stack.map((r, i) => (
            <span key={i} className="row" style={{ gap: 4 }}>
              <ChevronRight width={13} className="faint" />
              <button onClick={() => setStack((s) => s.slice(0, i + 1))} disabled={i === stack.length - 1}>
                {r.type === 'list' ? r.title : r.name}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="view" ref={scroller}>
        <div className="view-pad">
          {needsNetwork && !consent ? (
            <div className="empty">
              <Globe />
              <h3>Connect to the theme store?</h3>
              <p style={{ maxWidth: 520 }}>
                Mi Theme Studio loads listings, screenshots and free theme downloads from Xiaomi’s public Theme Manager service. Requests are anonymous: they carry
                generic client settings (region, language), never an account, device ID or your files.
              </p>
              <button className="btn btn-primary" onClick={allow}>
                Connect
              </button>
            </div>
          ) : tab === 'device' ? (
            <DeviceThemes refreshKey={refreshKey} />
          ) : route?.type === 'detail' ? (
            <StoreDetail key={route.moduleId} moduleId={route.moduleId} refreshKey={refreshKey} navigate={navigate} />
          ) : route?.type === 'list' ? (
            <>
              {stack.length > 0 && (
                <div className="section-head" style={{ marginBottom: 14 }}>
                  <h1 style={{ fontSize: 'var(--fs-xl)' }}>{route.title}</h1>
                </div>
              )}
              <StoreList key={JSON.stringify(route.query)} query={route.query} refreshKey={refreshKey} navigate={navigate} />
            </>
          ) : (
            <DownloadsLibrary navigate={navigate} />
          )}
        </div>
      </div>
    </div>
  );
}
