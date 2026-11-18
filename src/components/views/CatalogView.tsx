// Theme store: browse and search the online catalog, inspect a theme
// (screenshots, description, details), download free themes and apply all
// or selected parts of them to the open project.
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  Heart,
  ImageOff,
  LayoutGrid,
  Loader2,
  Lock,
  Music,
  Image as ImageIcon,
  Type,
  Palette,
  BatteryMedium,
  House,
  Clock,
  Contact,
  MessageSquare,
  Power,
  Wand2,
  Moon,
  Bell,
  AlarmClock,
  Phone,
  Monitor,
  PackageOpen,
  Play,
  ShieldCheck,
  RefreshCw,
  Repeat,
  Search,
  Smartphone,
  Shapes,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDateTime, plural } from '../../lib/format';
import type { DownloadedTheme, ProductKind, StoreLink, StorePage, StorePart, StoreProduct, StoreQuery, ThemeDetail } from '../../lib/types';
import * as A from '../../state/actions';
import { getState, useStore } from '../../state/store';
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
  partListings,
  rememberPartListing,
} from '../../state/themeStore';
import { DeviceThemes } from './DeviceThemes';
import { openSwap } from './SwapPart';
import { toggleSaved, useSaved } from '../../state/savedStore';
import { useStoreTabRequest, type StoreTab } from '../../state/storeTab';
import { formatVersion, usePhoneThemeFormat } from '../../state/compat';

const CONSENT_KEY = 'mts.catalog.consent.v1';

type Tab = StoreTab;

const KINDS: { kind: ProductKind; label: string; noun: string; icon: typeof Palette }[] = [
  { kind: 'theme', label: 'Themes', noun: 'theme', icon: Palette },
  { kind: 'icon', label: 'Icons', noun: 'icon pack', icon: Shapes },
  { kind: 'font', label: 'Fonts', noun: 'font', icon: Type },
  { kind: 'wallpaper', label: 'Wallpapers', noun: 'wallpaper', icon: ImageIcon },
  { kind: 'ringtone', label: 'Ringtones', noun: 'ringtone', icon: Music },
];
// Theme parts the store can list themes by. `component` is the part of your theme it swaps into.
const PARTS: { part: StorePart; label: string; plural: string; component: string; icon: typeof Palette; note?: string }[] = [
  { part: 'lockscreen', label: 'Lock screen', plural: 'Lock screens', component: 'lockscreen', icon: Lock },
  { part: 'statusBar', label: 'Status bar', plural: 'Status bars', component: 'systemui', icon: BatteryMedium },
  { part: 'homeScreen', label: 'Home screen', plural: 'Home screens', component: 'home', icon: House },
  { part: 'clock', label: 'Clock widget', plural: 'Clock widgets', component: 'widgets', icon: Clock, note: 'The store has no pictures of clock widgets; the cover is empty until you open it.' },
  { part: 'contacts', label: 'Contacts & calls', plural: 'Contacts & calls', component: 'apps', icon: Contact },
  { part: 'messages', label: 'Messages', plural: 'Messages', component: 'apps', icon: MessageSquare },
  { part: 'bootAnimation', label: 'Boot animation', plural: 'Boot animations', component: 'boot', icon: Power, note: 'A boot animation only changes on a rooted phone.' },
  { part: 'superWallpaper', label: 'Super wallpaper', plural: 'Super wallpapers', component: 'wallpapers', icon: Wand2 },
  { part: 'aod', label: 'Always-on display', plural: 'Always-on displays', component: 'other', icon: Moon, note: 'Always-on display styles come as small packages with only that part; the store shows no pictures of them.' },
];
export const partInfo = (part: StorePart | null | undefined) => PARTS.find((p) => p.part === part) ?? null;

const nounOf = (kind: ProductKind) => KINDS.find((k) => k.kind === kind)?.noun ?? 'item';
const isPackage = (kind: ProductKind) => kind === 'theme' || kind === 'font' || kind === 'icon';
type Route = { type: 'list'; query: StoreQuery; title: string } | { type: 'detail'; moduleId: string; name: string };

function readConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function RemoteImage({
  src,
  alt,
  className,
  onLoad,
  onFail,
}: {
  src: string | null;
  alt: string;
  className?: string;
  onLoad?: (img: HTMLImageElement) => void;
  onFail?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="img-fallback">
        <ImageOff width={16} />
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={onLoad ? (e) => onLoad(e.currentTarget) : undefined}
      onError={() => {
        setFailed(true);
        onFail?.();
      }}
      draggable={false}
    />
  );
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

// Animated previews seen on cards, so the theme page can show them too
// (the store sends the GIF with the listing, not with the theme details).
const knownGifs = new Map<string, string>();

/** The animated preview over a cover: plays while the pointer is on the card (loaded on first hover). */
function GifCover({ product, playing }: { product: StoreProduct; playing: boolean }) {
  const [ready, setReady] = useState(false);
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (playing) setWanted(true);
  }, [playing]);
  if (!product.gifUrl) return null;
  return (
    <>
      {wanted && (
        <img
          className={`cover-gif ${playing && ready ? 'is-on' : ''}`}
          src={product.gifUrl}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setReady(true)}
        />
      )}
      <span className={`cover-anim ${playing && !ready ? 'is-loading' : ''}`} title="Animated preview: hover to play">
        {playing && !ready ? <Loader2 className="spin" /> : <Play />} GIF
      </span>
    </>
  );
}

/** Put a download to use in the open theme: pick parts of a theme/font, or place a wallpaper/ringtone. */
export function putToUse(item: DownloadedTheme) {
  // Nothing open yet: this download becomes the theme you work on.
  if (!getState().project) return void A.startFromDownload(item);
  const part = partInfo(partListings.get(item.moduleId)?.part);
  if (isPackage(item.kind)) return openSwap(part ? { theme: item, part: part.component } : { theme: item });
  return openSwap({ media: item });
}

// Heart on a card or detail page: keep the item in the Saved tab to come back to.
function SaveToggle({ product, className = 'cover-save' }: { product: StoreProduct; className?: string }) {
  const saved = useSaved((s) => s.items.some((p) => p.moduleId === product.moduleId));
  const run = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    toggleSaved(product);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={saved}
      className={`${className} ${saved ? 'is-saved' : ''}`}
      title={saved ? 'Remove from Saved' : 'Save for later'}
      onClick={run}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && run(e)}
    >
      <Heart />
    </span>
  );
}

function SavedLibrary({ navigate }: { navigate: (route: Route) => void }) {
  const items = useSaved((s) => s.items);
  if (!items.length) {
    return (
      <div className="empty">
        <Heart />
        <h3>Nothing saved yet</h3>
        <p>Tap the heart on any theme, font, wallpaper or ringtone to keep it here for later.</p>
      </div>
    );
  }
  return (
    <>
      <div className="section-head">
        <h2>Saved</h2>
        <span className="muted">{plural(items.length, 'item')}</span>
      </div>
      <div className="product-grid">
        {items.map((p) => (
          <ProductCard key={p.moduleId} product={p} onOpen={() => navigate({ type: 'detail', moduleId: p.moduleId, name: p.name })} />
        ))}
      </div>
    </>
  );
}

// Hover action on a store card: get a free item, or use one that is already downloaded.
function QuickAction({ product }: { product: StoreProduct }) {
  const record = useThemeStore((s) => s.downloads.find((d) => d.moduleId === product.moduleId));
  const busy = useThemeStore((s) => !!s.progress[product.moduleId]);
  const hasProject = useStore((s) => !!s.project);
  if (busy || (!record && product.priceCents > 0)) return null;
  const run = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    if (record) putToUse(record);
    else void downloadTheme(product.moduleId, product.name);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className="cover-quick"
      title={
        !record
          ? `Download this ${nounOf(product.kind)}`
          : hasProject
            ? `Use this ${nounOf(product.kind)} in my theme`
            : isPackage(product.kind)
              ? `Open this ${nounOf(product.kind)} as the theme to work on`
              : `Start a new theme with this ${nounOf(product.kind)}`
      }
      onClick={run}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && run(e)}
    >
      {record ? (
        <>
          <Repeat /> {hasProject ? 'Use' : isPackage(product.kind) ? 'Open' : 'Start theme'}
        </>
      ) : (
        <>
          <Download /> Get
        </>
      )}
    </span>
  );
}

function ProductCard({ product, onOpen }: { product: StoreProduct; onOpen: () => void }) {
  const downloaded = useThemeStore((s) => s.downloads.some((d) => d.moduleId === product.moduleId));
  const progress = useThemeStore((s) => s.progress[product.moduleId]);
  const [hover, setHover] = useState(false);
  if (product.gifUrl) knownGifs.set(product.moduleId, product.gifUrl);
  rememberPartListing(product);
  const part = partInfo(product.part);
  return (
    <button className={`product-card kind-${product.kind}`} onClick={onOpen} title={product.name} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <div className="cover">
        <RemoteImage src={product.imageUrl} alt={product.name} />
        <GifCover product={product} playing={hover} />
        {part && (
          <span className="cover-part" title={`Listed for its ${part.label.toLowerCase()}`}>
            <part.icon /> {part.label}
          </span>
        )}
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
        <SaveToggle product={product} />
        <QuickAction product={product} />
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

// A shelf with a single theme: lock + home screenshots beside the details, so
// one cover doesn't stretch to fill the whole card.
function FeatureCard({ product, onOpen }: { product: StoreProduct; onOpen: () => void }) {
  const downloaded = useThemeStore((s) => s.downloads.some((d) => d.moduleId === product.moduleId));
  const progress = useThemeStore((s) => s.progress[product.moduleId]);
  const [hover, setHover] = useState(false);
  if (product.gifUrl) knownGifs.set(product.moduleId, product.gifUrl);
  const second = product.secondImageUrl && product.secondImageUrl !== product.imageUrl ? product.secondImageUrl : null;
  return (
    <button className={`feature-card kind-${product.kind}${second ? ' has-second' : ''}`} onClick={onOpen} title={product.name} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="covers">
        <div className="cover">
          <RemoteImage src={product.imageUrl} alt={product.name} />
          <GifCover product={product} playing={hover} />
          {downloaded && (
            <span className="cover-badge" title="Downloaded">
              <Check />
            </span>
          )}
        </div>
        {second && (
          <div className="cover">
            <RemoteImage src={second} alt={`${product.name} (second screen)`} />
          </div>
        )}
      </div>
      <div className="info">
        <span className="name">{product.name}</span>
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
        {product.tags.length > 0 && (
          <span className="tags">
            {product.tags.slice(0, 4).map((t) => (
              <span className="badge" key={t}>
                {t}
              </span>
            ))}
          </span>
        )}
        {progress && <ProgressBar {...progress} />}
        <span className="btn btn-sm view-btn">
          View {nounOf(product.kind)} <ChevronRight />
        </span>
      </div>
    </button>
  );
}

// One scrollable row with paging arrows, for big shelves that have a "See all".
// A shelf only shows the handful of items the store put on the page. When it
// has a "See all", the rest of that list is fetched as the shelf comes into
// view, so a row is filled instead of ending halfway across the window.
const shelfExtras = new Map<string, Promise<StoreProduct[]>>();
const SHELF_FULL = 14;

function Shelf({
  products,
  subjectId,
  rail,
  visible,
  onOpen,
}: {
  products: StoreProduct[];
  subjectId: string | null;
  rail: boolean;
  visible: (p: StoreProduct) => boolean;
  onOpen: (p: StoreProduct) => void;
}) {
  const region = useThemeStore((s) => s.region);
  const ref = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState<StoreProduct[]>([]);
  const short = !!subjectId && products.length < SHELF_FULL;

  useEffect(() => {
    setExtra([]);
    const el = ref.current;
    if (!short || !subjectId || !el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const key = `${region}:${subjectId}`;
        let pending = shelfExtras.get(key);
        if (!pending) {
          pending = api.storePage({ kind: 'subject', id: subjectId }, 0, region).then((page) => page.sections.flatMap((sec) => sec.products));
          shelfExtras.set(key, pending);
          pending.catch(() => shelfExtras.delete(key));
        }
        pending.then((list) => !cancelled && setExtra(list)).catch(() => undefined);
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [subjectId, region, short]);

  const all = extra.length ? dedupe([...products, ...extra.filter(visible)]) : products;
  const cards = all.map((p) => <ProductCard key={p.moduleId} product={p} onOpen={() => onOpen(p)} />);
  return (
    <div ref={ref}>
      {rail ? <ShelfRail count={all.length}>{cards}</ShelfRail> : <div className="product-grid">{cards}</div>}
    </div>
  );
}

function ShelfRail({ children, count }: { children: ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  const page = (dir: number) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  };
  return (
    <div className="shelf-rail-wrap">
      <div className="product-grid shelf-rail" ref={ref} onScroll={update}>
        {children}
      </div>
      {!edge.start && (
        <button className="rail-nav prev" aria-label="Scroll left" onClick={() => page(-1)}>
          <ChevronLeft />
        </button>
      )}
      {!edge.end && (
        <button className="rail-nav next" aria-label="Scroll right" onClick={() => page(1)}>
          <ChevronRight />
        </button>
      )}
    </div>
  );
}

// Columns for a row of banners: as many as fit, but drop a column or two when
// that fills the last row better (11 banners → 6+5, never 4+4+3 with a hole).
function pickColumns(count: number, width: number, minTile: number, gap = 14) {
  const max = width > 0 ? Math.max(1, Math.min(6, Math.floor((width + gap) / (minTile + gap)))) : 4;
  if (count <= max) return Math.max(1, count);
  const holes = (c: number) => (c - (count % c)) % c;
  let best = max;
  for (let c = max - 1; c >= Math.max(2, Math.ceil(max * 0.6)); c--) if (holes(c) < holes(best)) best = c;
  return best;
}

// Banner links: shortcut icons go in their own compact row; banners share one
// grid whose tile shape follows the store's artwork so its text isn't cropped.
function LinkGroup({ links, fill, onOpen }: { links: StoreLink[]; fill: boolean; onOpen: (l: StoreLink) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<number>>(() => new Set());
  const icons = links.filter((l) => l.icon);
  const cards = links.map((l, j) => ({ l, j })).filter(({ l, j }) => !l.icon && (l.title || (l.imageUrl && !broken.has(j))));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [cards.length > 0]);

  const r = ratio ?? 485 / 340;
  const cols = pickColumns(cards.length, width, r >= 1.8 ? 260 : 220);
  const measure = (img: HTMLImageElement) => {
    if (ratio || !img.naturalWidth || !img.naturalHeight) return;
    setRatio(Math.min(2.6, Math.max(1, img.naturalWidth / img.naturalHeight)));
  };

  return (
    <>
      {icons.length > 0 && (
        <div className="icon-links">
          {icons.map((l, j) => (
            <LinkTile key={`i-${l.pageId ?? l.moduleId}-${j}`} link={l} onOpen={() => onOpen(l)} />
          ))}
        </div>
      )}
      {cards.length > 0 && (
        <div
          ref={ref}
          className={`catalog-grid${icons.length ? ' after-icons' : ''}${fill ? ' fill' : ''}`}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, ['--link-ratio' as string]: r }}
        >
          {cards.map(({ l, j }) => (
            <LinkTile
              key={`${l.pageId ?? l.moduleId}-${j}`}
              link={l}
              onOpen={() => onOpen(l)}
              onLoad={measure}
              onFail={() => setBroken((b) => new Set(b).add(j))}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LinkTile({
  link,
  onOpen,
  onLoad,
  onFail,
}: {
  link: StoreLink;
  onOpen: () => void;
  onLoad?: (img: HTMLImageElement) => void;
  onFail?: () => void;
}) {
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
        <RemoteImage src={link.imageUrl} alt={link.title ?? ''} onLoad={onLoad} onFail={onFail} />
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
  scrollRoot,
  navigate,
}: {
  query: StoreQuery;
  refreshKey: number;
  scrollRoot: HTMLDivElement | null;
  navigate: (route: Route) => void;
}) {
  const region = useThemeStore((s) => s.region);
  const freeOnly = useThemeStore((s) => s.freeOnly);
  const [pages, setPages] = useState<StorePage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const loadingRef = useRef(false);
  const loadMoreTarget = useRef<HTMLDivElement>(null);
  const flat = query.kind === 'subject' || query.kind === 'search';

  const load = async (more: boolean) => {
    if (more && loadingRef.current) return;
    const id = ++request.current;
    loadingRef.current = true;
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
      if (id === request.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    setPages([]);
    void load(false);
  }, [JSON.stringify(query), region, refreshKey]);

  useEffect(() => {
    const target = loadMoreTarget.current;
    if (!target || !scrollRoot || !pages[pages.length - 1]?.hasMore || loading || error) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void load(true);
    }, { root: scrollRoot, rootMargin: '400px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollRoot, pages, loading, error]);

  const visible = (p: StoreProduct) => !freeOnly || p.priceCents === 0;
  // The store sends long shelves in pieces (one per page), each repeating the same
  // heading. Join those back into one shelf so a category is a full grid, not a
  // stack of half-empty rows.
  const sections = pages
    .flatMap((p) => p.sections)
    .map((s) => ({ ...s, products: s.products.filter(visible) }))
    .filter((s) => s.products.length > 0 || s.links.length > 0)
    .reduce<StorePage['sections']>((merged, s) => {
      const prev = merged[merged.length - 1];
      if (prev && prev.products.length && s.products.length && !prev.links.length && !s.links.length && prev.title === s.title && prev.subjectId === s.subjectId) {
        merged[merged.length - 1] = { ...prev, products: dedupe([...prev.products, ...s.products]) };
      } else merged.push(s);
      return merged;
    }, []);
  // A single-row rail only makes sense among several shelves; a page that is one
  // or two shelves shows them in full.
  const useRails = sections.filter((s) => s.products.length > 0).length >= 3;
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
          <h3>{query.kind === 'search' ? `No ${KINDS.find((k) => k.kind === (query.product ?? 'theme'))?.label.toLowerCase() ?? 'themes'} match “${query.keywords}”` : 'Nothing here yet'}</h3>
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
              (section.products.length === 1 && !section.links.length) ||
              (!section.products.length && section.links.length > 0 && section.links.length <= 2 && !section.links.some((l) => l.icon))
                ? section.products.length === 1
                  ? 'shelf-card shelf-feature'
                  : 'shelf-card'
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
            {section.products.length === 1 && !section.links.length ? (
              <FeatureCard product={section.products[0]} onOpen={() => openProduct(section.products[0])} />
            ) : (
              section.products.length > 0 && <Shelf products={section.products} subjectId={section.subjectId} rail={useRails && !!section.subjectId} visible={visible} onOpen={openProduct} />
            )}
            {section.links.length > 0 && (
              <LinkGroup
                links={section.links}
                fill={!section.products.length && section.links.length <= 2 && !section.links.some((l) => l.icon)}
                onOpen={openLink}
              />
            )}
          </div>
        ))}
        </div>
      )}
      {error && pages.length > 0 && (
        <div className="banner banner-err" style={{ marginTop: 14 }}>
          <AlertTriangle />
          <span className="grow">{error}</span>
          <button className="btn btn-sm" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}
      {last?.hasMore && (
        <div ref={loadMoreTarget} aria-live="polite" style={{ minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {loading && <><Loader2 className="spin" /> <span className="muted">Loading more…</span></>}
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

/** What a part listing tells about an item, as a detail page. */
function listingDetail(p: StoreProduct): ThemeDetail {
  const big = p.imageUrl ? p.imageUrl.replace('/w212q80/', '/w1080q70/') : null;
  return {
    moduleId: p.moduleId,
    productId: p.productId,
    kind: 'theme',
    name: p.name,
    designer: null,
    author: null,
    designerIcon: null,
    designerThemes: null,
    description: null,
    tags: p.tags,
    cover: big,
    screenshots: big ? [big] : [],
    sizeBytes: p.sizeBytes,
    version: null,
    uiVersion: null,
    downloads: null,
    score: null,
    priceCents: p.priceCents,
    currency: p.currency,
    bought: false,
    priceKnown: true,
    free: p.priceCents === 0,
    audioUrl: null,
    webUrl: `https://zhuti.xiaomi.com/detail/${p.moduleId}`,
  };
}

function StoreDetail({ moduleId, refreshKey, navigate }: { moduleId: string; refreshKey: number; navigate: (route: Route) => void }) {
  const phone = usePhoneThemeFormat();
  const region = useThemeStore((s) => s.region);
  const downloaded = useThemeStore((s) => s.downloads.find((d) => d.moduleId === moduleId));
  const progress = useThemeStore((s) => s.progress[moduleId]);
  const [detail, setDetail] = useState<ThemeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const hasProject = useStore((s) => !!s.project);
  const phoneReady = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));

  const listed = partListings.get(moduleId);
  const listedPart = partInfo(listed?.part);
  const [lite, setLite] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLite(false);
    api
      .storeDetail(moduleId, region)
      .then((d) => {
        if (cancelled) return;
        if (listed) rememberPartListing(listed, d.moduleId);
        setDetail(d);
      })
      .catch((e) => {
        if (cancelled) return;
        // Part listings: the store often has no page for the ID; show what the listing said.
        if (listed) {
          setDetail(listingDetail(listed));
          setLite(true);
        } else setError(errorMessage(e));
      });
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

  // Allow free themes, already-purchased themes, AND premium (paid) themes
  // Premium themes (priceCents > 0) are downloadable without purchase — the server serves them freely.
  const canDownload = detail.free || detail.bought || (detail.priceCents > 0 && detail.priceKnown);
  const start = async () => {
    const record = await downloadTheme(detail.moduleId, detail.name);
    if (record && hasProject && isPackage(record.kind)) putToUse(record);
  };

  // Fits the connected phone? Themes declare a uiVersion; the phone reports the newest format it renders.
  const fit = phone.format !== null && detail.uiVersion && detail.kind === 'theme' ? { ok: phone.format >= detail.uiVersion * 10 } : null;

  // The animated preview (seen on its store card) leads the screenshots.
  const gif = knownGifs.get(detail.moduleId) ?? null;
  const shots = gif ? [gif, ...detail.screenshots.filter((s) => s !== gif)] : detail.screenshots;

  return (
    <div className="store-detail">
      <div className="shots">
        {shots.length ? (
          shots.map((src, i) => (
            <button key={src} className={`shot ${src === gif ? 'is-gif' : ''}`} onClick={() => setLightbox(i)} aria-label={src === gif ? 'Open the animated preview' : `Open screenshot ${i + 1}`}>
              <RemoteImage src={src} alt={src === gif ? `${detail.name} animated preview` : `${detail.name} screenshot ${i + 1}`} />
              {src === gif && (
                <span className="cover-anim">
                  <Play /> Animated
                </span>
              )}
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
          {listedPart && (
            <div className="banner banner-info" style={{ marginBottom: 12 }}>
              <listedPart.icon />
              <span className="grow">
                Listed for its {listedPart.label.toLowerCase()}. {hasProject ? `“Get & use” takes just the ${listedPart.label.toLowerCase()} into your theme; you can tick more parts there.` : 'Open it, or open a theme first to take just this part.'}
                {lite ? ' The store has no full page for this item, so only its picture is shown; the download is the whole package it comes from, checked by SHA-1.' : ''}
                {listedPart.note ? ` ${listedPart.note}` : ''}
              </span>
            </div>
          )}
          <h1 className="selectable">
            {detail.name}
            <SaveToggle
              className="detail-save"
              product={{
                moduleId: detail.moduleId,
                productId: detail.productId,
                kind: detail.kind,
                name: detail.name,
                imageUrl: detail.screenshots[0] ?? null,
                secondImageUrl: detail.screenshots[1] ?? null,
                gifUrl: gif,
                priceCents: detail.priceCents,
                currency: detail.currency,
                sizeBytes: detail.sizeBytes,
                tags: detail.tags,
              }}
            />
          </h1>
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
                    ? detail.priceCents > 0
                      ? `Paid · ${formatPrice(detail.priceCents, detail.currency)} — fully downloadable`
                      : formatPrice(detail.priceCents, detail.currency)
                    : 'Not stated'}
            </Fact>
            {detail.sizeBytes ? <Fact label="Size">{formatBytes(detail.sizeBytes)}</Fact> : null}
            {detail.version ? <Fact label="Version">{detail.version}</Fact> : null}
            {detail.iconCount ? <Fact label="Icons">{detail.iconCount.toLocaleString()} app icons</Fact> : null}
            {detail.uiVersion ? <Fact label="Theme format">{detail.uiVersion}{phone.format !== null ? ` (your phone: up to ${formatVersion(phone.format)})` : ''}</Fact> : null}
            {detail.downloads ? <Fact label="Downloads">{detail.downloads.toLocaleString()}</Fact> : null}
            {detail.score ? (
              <Fact label="Rating">
                <Star width={13} /> {detail.score.toFixed(1)}
              </Fact>
            ) : null}
          </div>
        </div>

        <aside className="detail-actions surface surface-pad">
          {fit && (
            <div className={`compat ${fit.ok ? 'is-ok' : 'is-newer'}`}>
              {fit.ok ? <ShieldCheck /> : <AlertTriangle />}
              <div>
                <strong>{fit.ok ? `Works on your ${phone.label ?? 'phone'}` : `Made for a newer system than your ${phone.label ?? 'phone'}`}</strong>
                <span>
                  Theme format {detail.uiVersion} · phone supports up to {formatVersion(phone.format)}.
                  {fit.ok ? '' : ' Some parts may be refused or look wrong there. You can still take parts from it.'}
                </span>
              </div>
            </div>
          )}
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
              <div className="row ok detail-status">
                <Check width={16} /> <span>Downloaded · verified</span>
              </div>
              {isPackage(downloaded.kind) ? (
                <>
                  {hasProject && (
                    <button className="btn btn-primary" onClick={() => putToUse(downloaded)}>
                      <Repeat /> Use in my theme…
                    </button>
                  )}
                  <button className={hasProject ? 'btn' : 'btn btn-primary'} onClick={() => void A.openDownloadAsProject(downloaded)}>
                    <PackageOpen /> {hasProject ? `Open whole ${nounOf(downloaded.kind)} instead` : `Open as a new theme`}
                  </button>
                </>
              ) : (
                <MediaActions item={downloaded} />
              )}
              <div className="detail-links">
                {hasProject && isPackage(downloaded.kind) && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void A.openDownloadAsReference(downloaded)} title="Advanced: look through its files and copy single ones">
                    <BookOpen /> Browse its files
                  </button>
                )}
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
                <Download /> {hasProject && isPackage(detail.kind) ? 'Get & use in my theme' : 'Download'}
                {detail.sizeBytes ? ` · ${formatBytes(detail.sizeBytes)}` : ''}
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

      {lightbox !== null && shots.length > 0 && (
        <Lightbox images={shots} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

function MediaActions({ item, compact = false }: { item: DownloadedTheme; compact?: boolean }) {
  const hasProject = useStore((s) => !!s.project);
  const cls = compact ? 'btn btn-sm' : 'btn';
  if (!hasProject) {
    return (
      <button className={`${cls} ${compact ? '' : 'btn-primary'}`} onClick={() => void A.startFromDownload(item)}>
        <Sparkles /> Start a new theme with this {nounOf(item.kind)}
      </button>
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

function DownloadsLibrary({ navigate, product, onProduct }: { navigate: (route: Route) => void; product: ProductKind; onProduct: (kind: ProductKind) => void }) {
  const downloads = useThemeStore((s) => s.downloads);
  const loaded = useThemeStore((s) => s.loaded);
  const hasProject = useStore((s) => !!s.project);
  if (!loaded) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
      </div>
    );
  }
  const kindLabel = KINDS.find((k) => k.kind === product)?.label.toLowerCase() ?? 'items';
  // The Themes / Fonts / Wallpapers / Ringtones tabs above pick what is listed, newest first.
  const items = downloads.filter((d) => d.kind === product).sort((a, b) => b.downloadedAtMs - a.downloadedAtMs);
  const others = KINDS.filter((k) => k.kind !== product).map((k) => ({ ...k, count: downloads.filter((d) => d.kind === k.kind).length })).filter((k) => k.count > 0);
  const elsewhere = others.length > 0 && (
    <div className="dl-others">
      <span className="faint">Also downloaded:</span>
      {others.map((k) => (
        <button key={k.kind} className="chip" onClick={() => onProduct(k.kind)}>
          <k.icon /> {k.label} {k.count}
        </button>
      ))}
    </div>
  );
  if (!items.length) {
    return (
      <div className="empty">
        <HardDrive />
        <h3>No {kindLabel} downloaded yet</h3>
        <p>Download free {kindLabel} from Discover. Downloads stay available offline.</p>
        {elsewhere}
      </div>
    );
  }
  const ringtones = product === 'ringtone';
  return (
    <>
      <div className="section-head">
        <h2>Downloaded {kindLabel}</h2>
        <span className="muted">
          {plural(items.length, nounOf(product))} · {formatBytes(items.reduce((n, d) => n + d.sizeBytes, 0))}
        </span>
        {elsewhere}
      </div>
      <div className={`dl-grid kind-${product}`}>
        {items.map((d) => (
          <div key={d.moduleId} className={`dl-card kind-${d.kind}`}>
            <button className="dl-cover" onClick={() => navigate({ type: 'detail', moduleId: d.moduleId, name: d.name })} aria-label={`Open ${d.name}`}>
              {ringtones ? <Music /> : <RemoteImage src={d.cover} alt="" />}
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
                <button className="btn btn-sm btn-primary grow" onClick={() => putToUse(d)} title={hasProject ? 'Take parts of it into the theme you are editing' : 'Start a new theme with it'}>
                  {hasProject ? <Repeat /> : <Sparkles />} {hasProject ? 'Use in my theme…' : 'Start a theme'}
                </button>
                {isPackage(d.kind) && (
                  <button className="btn btn-ghost btn-sm" title="Open as the theme you are working on" aria-label="Open as theme" onClick={() => void A.openDownloadAsProject(d)}>
                    <PackageOpen />
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

function rootFor(tab: 'discover' | 'categories', product: ProductKind, part: StorePart | null): Route {
  if (tab === 'categories') return { type: 'list', query: { kind: 'categories' }, title: 'Categories' };
  const p = product === 'theme' ? partInfo(part) : null;
  if (p) return { type: 'list', query: { kind: 'home', product, part: p.part }, title: p.plural };
  return { type: 'list', query: { kind: 'home', product }, title: KINDS.find((k) => k.kind === product)?.label ?? 'Discover' };
}

const PART_KEY = 'mts.store.part.v1';
function loadPart(): StorePart | null {
  try {
    const v = localStorage.getItem(PART_KEY);
    return PARTS.some((p) => p.part === v) ? (v as StorePart) : null;
  } catch {
    return null;
  }
}

/** A search for these words in this kind (and part, for themes). */
function searchRoute(product: ProductKind, part: StorePart | null, keywords: string): Route {
  const p = product === 'theme' ? partInfo(part) : null;
  return {
    type: 'list',
    query: p ? { kind: 'search', keywords, product, part: p.part } : { kind: 'search', keywords, product },
    title: `${p ? p.plural : (KINDS.find((k) => k.kind === product)?.label ?? 'Themes')} matching “${keywords}”`,
  };
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
  const [part, setPartState] = useState<StorePart | null>(loadPart);
  const [stack, setStack] = useState<Route[]>([]);
  // Searching? Switching kind or part looks for the same words there instead of dropping the search.
  const reroute = (nextProduct: ProductKind, nextPart: StorePart | null) => {
    const current = stack[stack.length - 1];
    if (current?.type === 'list' && current.query.kind === 'search') setStack([searchRoute(nextProduct, nextPart, current.query.keywords)]);
    else setStack([]);
  };
  const setPart = (next: StorePart | null) => {
    setPartState(next);
    try {
      if (next) localStorage.setItem(PART_KEY, next);
      else localStorage.removeItem(PART_KEY);
    } catch {
      /* ignore */
    }
    if (tab !== 'discover') setTab('discover');
    reroute('theme', next);
  };
  const setProduct = (next: ProductKind) => {
    setProductState(next);
    try {
      localStorage.setItem(PRODUCT_KEY, next);
    } catch {
      /* ignore */
    }
    if (tab === 'categories' && next !== 'theme') setTab('discover');
    if (tab === 'device') setTab('discover');
    reroute(next, part);
  };
  const [consent, setConsent] = useState(readConsent);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const projectTitle = useStore((s) => s.project?.title ?? null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshDownloads();
  }, []);

  const route: Route | null = stack.length ? stack[stack.length - 1] : tab === 'discover' || tab === 'categories' ? rootFor(tab, product, part) : null;
  useEffect(() => {
    scroller?.scrollTo({ top: 0 });
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
    setStack((s) => [...s.filter((r) => !(r.type === 'list' && r.query.kind === 'search')), searchRoute(product, part, keywords)]);
  };
  const allow = () => {
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* ignore */
    }
    setConsent(true);
  };

  const needsNetwork = tab !== 'device' && !((tab === 'downloads' || tab === 'saved') && !stack.length);
  const savedCount = useSaved((s) => s.items.length);

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
          <button aria-pressed={tab === 'saved' && !stack.length} onClick={() => switchTab('saved')}>
            <Heart /> Saved{savedCount ? ` ${savedCount}` : ''}
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
          <input className="input" placeholder={`Search ${(product === 'theme' && partInfo(part)?.plural) || KINDS.find((k) => k.kind === product)?.label}…`.replace(/^Search (\w)/, (_m, c: string) => `Search ${c.toLowerCase()}`)} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the store" />
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
          {projectTitle && (
            <span className="store-context">
              <span className="faint">Adding to</span>
              <strong className="ellipsis">{projectTitle}</strong>
              <button onClick={() => A.goTo('design')} title="Back to your theme">
                <ArrowLeft /> Back to theme
              </button>
            </span>
          )}
        </div>
      )}
      {tab !== 'device' && tab !== 'categories' && product === 'theme' && (
        <div className="part-bar" role="group" aria-label="Look for one part of a theme">
          <span className="faint">Part</span>
          <button className={!part ? 'is-on' : ''} aria-pressed={!part} onClick={() => setPart(null)}>
            Whole theme
          </button>
          {PARTS.map((p) => (
            <button key={p.part} className={part === p.part ? 'is-on' : ''} aria-pressed={part === p.part} onClick={() => setPart(p.part)} title={`Themes listed for their ${p.label.toLowerCase()}. Use takes just that part into your theme.${p.note ? ` ${p.note}` : ''}`}>
              <p.icon /> {p.plural}
            </button>
          ))}
        </div>
      )}
      {stack.length > 0 && (
        <div className="crumbs">
          <button onClick={() => setStack([])}>{tab === 'categories' ? 'Categories' : tab === 'downloads' ? 'Downloaded' : tab === 'saved' ? 'Saved' : KINDS.find((k) => k.kind === product)?.label}</button>
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
      <div className="view" ref={setScroller}>
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
              <StoreList key={JSON.stringify(route.query)} query={route.query} refreshKey={refreshKey} scrollRoot={scroller} navigate={navigate} />
            </>
          ) : tab === 'saved' ? (
            <SavedLibrary navigate={navigate} />
          ) : (
            <DownloadsLibrary navigate={navigate} product={product} onProduct={setProduct} />
          )}
        </div>
      </div>
    </div>
  );
}
