import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, ClipboardCopy, Globe, ImageOff, Info, Loader2, Lock, RefreshCw, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatTime } from '../../lib/format';
import type { CachedDeviceTheme, CatalogItem, CatalogPage, CatalogSection, CatalogSource, DeviceEntry } from '../../lib/types';
import { log, useStore } from '../../state/store';

const CONSENT_KEY = 'mts.catalog.consent.v1';
const ENDPOINTS: Record<CatalogSource, string> = {
  shelves: 'https://api.zhuti.intl.xiaomi.com/app/v9/uipages?pageCategory=THEME…',
  categories: 'https://api.zhuti.intl.xiaomi.com/app/v9/uipages/classification?pageCategory=HYBRID…',
};
const NO_DEVICES: DeviceEntry[] = [];

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
      <span className="img-fallback row" style={{ justifyContent: 'center' }}>
        <ImageOff width={14} /> {src ? 'Image failed to load' : 'No image'}
      </span>
    );
  }
  return <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} draggable={false} />;
}

function linkLabel(item: { link: CatalogItem['link'] }) {
  const link = item.link;
  if (!link) return null;
  const kind = link.kind === 'UI_PAGE' ? 'Theme page' : link.kind === 'EXTERNAL_HREF' ? 'App-only link' : (link.kind ?? 'Link');
  return (
    <span className="badge badge-outline" title={link.target ?? undefined}>
      {kind}
      {link.productType ? ` · ${link.productType.toLowerCase()}` : ''}
    </span>
  );
}

function sectionTitle(section: CatalogSection) {
  return section.title ?? section.link?.title ?? section.cardType.replace(/_/g, ' ').toLowerCase();
}

function SectionView({ section }: { section: CatalogSection }) {
  const hiddenBadge = !section.visible && <span className="badge badge-outline" title="The service marks this card as not visible">hidden by service</span>;
  if (section.layout === 'icons') {
    return (
      <div className="section">
        <div className="section-head">
          <h2>Quick links</h2>
          {hiddenBadge}
        </div>
        <div className="icon-links">
          {section.items.map((item, i) => (
            <div key={i} className="icon-link" title={item.link?.target ?? undefined}>
              <RemoteImage src={item.darkImageUrl ?? item.imageUrl} alt={item.title ?? 'link'} />
              <span className="ellipsis" style={{ maxWidth: '100%' }}>{item.title ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (section.layout === 'grid') {
    return (
      <div className="section">
        <div className="section-head">
          <h2>{sectionTitle(section)}</h2>
          {hiddenBadge}
        </div>
        <div className="catalog-grid">
          {section.items.map((item, i) => (
            <div key={i} className="catalog-card">
              <div className="img">
                <RemoteImage src={item.imageUrl} alt={item.title ?? ''} />
              </div>
              <div className="cap">
                <span className="ellipsis grow">{item.title ?? 'Untitled'}</span>
                {linkLabel(item)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (section.layout === 'banner') {
    return (
      <div className="section">
        <div className="section-head">
          <h2>{sectionTitle(section)}</h2>
          {linkLabel(section)}
          {hiddenBadge}
        </div>
        {section.imageUrl && (
          <div className="catalog-card" style={{ maxWidth: 560 }}>
            <div className="img" style={{ aspectRatio: '3 / 1' }}>
              <RemoteImage src={section.imageUrl} alt={sectionTitle(section)} />
            </div>
          </div>
        )}
      </div>
    );
  }
  return null;
}

function DeviceThemeCard({
  serial,
  theme,
  isOpening,
  openBusy,
  onOpenReference,
}: {
  serial: string;
  theme: CachedDeviceTheme;
  isOpening: boolean;
  openBusy: boolean;
  onOpenReference: (theme: CachedDeviceTheme) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (!theme.hasPreview) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    let requested = false;
    const load = async () => {
      if (requested) return;
      requested = true;
      setLoadingPreview(true);
      try {
        const bytes = await api.adbCachedThemePreview(serial, theme.localId);
        if (cancelled || !bytes.length) return;
        const first = bytes[0];
        const mime = first === 0xff ? 'image/jpeg' : first === 0x89 ? 'image/png' : 'image/webp';
        const data = new Uint8Array(bytes);
        objectUrl = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: mime }));
        setPreviewUrl(objectUrl);
      } catch {
        if (!cancelled) setPreviewError(true);
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    };

    const element = cardRef.current;
    if (!element || !('IntersectionObserver' in window)) {
      void load();
      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    }, { rootMargin: '240px' });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [serial, theme.localId, theme.hasPreview]);

  return (
    <article ref={cardRef} className="catalog-card device-theme-card">
      <div className="img">
        {previewUrl ? (
          <img src={previewUrl} alt={`${theme.title} preview`} loading="lazy" draggable={false} />
        ) : loadingPreview ? (
          <span className="img-fallback"><Loader2 className="spin" /> Loading preview…</span>
        ) : (
          <span className="img-fallback"><ImageOff /> {previewError ? 'Preview unavailable' : 'No cached preview'}</span>
        )}
      </div>
      <div className="device-theme-body">
        <div className="device-theme-title" title={theme.title}>{theme.title}</div>
        <div className="muted ellipsis" title={theme.author ? `By ${theme.author}` : undefined}>
          {theme.author ? `By ${theme.author}` : theme.designer ? `Designed by ${theme.designer}` : 'Author not listed'}
        </div>
        {theme.description && <p className="device-theme-description">{theme.description}</p>}
        <div className="device-theme-parts" aria-label="Theme components listed in metadata">
          {theme.components.length ? theme.components.map((part) => <span className="badge badge-outline" key={part}>{part}</span>) : <span className="muted">No component list</span>}
        </div>
        <div className="device-theme-actions">
          <button className="btn btn-sm" disabled={openBusy} onClick={() => onOpenReference(theme)}>
            {isOpening ? <Loader2 className="spin" /> : <BookOpen />} {isOpening ? 'Opening reference…' : 'Open as reference'}
          </button>
        </div>
      </div>
    </article>
  );
}

export function CatalogView() {
  const selectedSerial = useStore((s) => s.selectedSerial);
  const attachedDevices = useStore((s) => s.adb?.devices ?? NO_DEVICES);
  const [source, setSource] = useState<CatalogSource | 'device'>('shelves');
  const [pages, setPages] = useState<Partial<Record<CatalogSource, CatalogPage[]>>>({});
  const [deviceThemes, setDeviceThemes] = useState<CachedDeviceTheme[]>([]);
  const [deviceThemesLoading, setDeviceThemesLoading] = useState(false);
  const [deviceThemesError, setDeviceThemesError] = useState<string | null>(null);
  const [deviceReferenceError, setDeviceReferenceError] = useState<string | null>(null);
  const [openingThemeId, setOpeningThemeId] = useState<string | null>(null);
  const deviceRequest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(readConsent);
  const [showHidden, setShowHidden] = useState(true);

  const loadDeviceThemes = async () => {
    const serial = selectedSerial;
    if (!serial) {
      setDeviceThemes([]);
      setDeviceThemesError('Select a connected device in the Device panel first.');
      return;
    }
    const request = ++deviceRequest.current;
    setDeviceThemesLoading(true);
    setDeviceThemesError(null);
    try {
      const themes = await api.adbCachedThemes(serial);
      if (request === deviceRequest.current) setDeviceThemes(themes);
    } catch (e) {
      if (request === deviceRequest.current) setDeviceThemesError(errorMessage(e));
    } finally {
      if (request === deviceRequest.current) setDeviceThemesLoading(false);
    }
  };

  const openCachedReference = async (theme: CachedDeviceTheme) => {
    if (!selectedSerial || openingThemeId) return;
    setOpeningThemeId(theme.localId);
    setDeviceReferenceError(null);
    try {
      const snapshot = await api.adbCachedThemeReference(selectedSerial, theme.localId);
      useStore.setState({
        reference: snapshot,
        refIndex: new Map(snapshot.files.map((file) => [file.path, file])),
        sideTab: 'reference',
      });
      log('success', `Opened “${snapshot.title}” from the Theme Manager cache as a read-only reference`);
      for (const warning of snapshot.importReport?.warnings ?? []) log('warning', warning);
    } catch (e) {
      const message = errorMessage(e);
      setDeviceReferenceError(message);
      log('error', `Could not open cached theme reference: ${message}`);
    } finally {
      setOpeningThemeId(null);
    }
  };

  useEffect(() => {
    if (source === 'device' && selectedSerial) void loadDeviceThemes();
  }, [source, selectedSerial]);

  const load = async (target: CatalogSource, more = false) => {
    setLoading(true);
    setError(null);
    try {
      const existing = pages[target] ?? [];
      const start = more && existing.length ? existing[existing.length - 1].nextStart : 0;
      const page = await api.catalogFetch(target, start);
      setPages((p) => ({ ...p, [target]: more ? [...(p[target] ?? []), page] : [page] }));
      log('info', `Catalog: loaded ${page.sections.length} cards (${target}) in ${page.durationMs} ms`);
    } catch (e) {
      setError(errorMessage(e));
      log('error', `Catalog: ${errorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const allow = () => {
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* ignore */
    }
    setConsent(true);
    if (source !== 'device') void load(source);
  };

  const current = source === 'device' ? undefined : pages[source];
  const returned = (current ?? []).flatMap((p) => p.sections);
  const sections = returned.filter((s) => showHidden || s.visible);
  const shelves = sections.filter((s) => s.layout === 'shelf');
  const others = sections.filter((s) => s.layout !== 'shelf');
  const last = current?.[current.length - 1];

  return (
    <div className="center-body">
      <div className="toolbar">
        {source === 'device' ? <Smartphone width={16} className="muted" /> : <Globe width={16} className="muted" />}
        <strong>{source === 'device' ? 'Themes on device' : 'Online themes'}</strong>
        <span className="badge badge-outline">{source === 'device' ? 'Local cache' : 'Browse only'}</span>
        <span className="sep" />
        <div className="segmented" role="group" aria-label="Catalog page">
          <button
            aria-pressed={source === 'shelves'}
            onClick={() => {
              setSource('shelves');
              if (consent && !pages.shelves) void load('shelves');
            }}
          >
            Theme shelves
          </button>
          <button
            aria-pressed={source === 'categories'}
            onClick={() => {
              setSource('categories');
              if (consent && !pages.categories) void load('categories');
            }}
          >
            Categories
          </button>
          <button aria-pressed={source === 'device'} onClick={() => setSource('device')}>
            On device
          </button>
        </div>
        {source !== 'device' && (
          <label className="check">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Include cards the service marks hidden
          </label>
        )}
        <span className="grow" />
        {source !== 'device' && last && (
          <span className="muted nowrap">
            {formatTime(last.fetchedAtMs)} · {last.durationMs} ms{last.language ? ` · ${last.language}` : ''}
          </span>
        )}
        <button className="btn btn-sm" disabled={source === 'device' ? deviceThemesLoading : !consent || loading} onClick={() => source === 'device' ? void loadDeviceThemes() : void load(source)}>
          {source === 'device' ? (deviceThemesLoading ? <Loader2 className="spin" /> : <RefreshCw />) : (loading ? <Loader2 className="spin" /> : <RefreshCw />)} Refresh
        </button>
      </div>
      <div className="view">
        <div className="view-pad">
          {source === 'device' ? (
            <>
              <div className="banner banner-info" style={{ marginBottom: 16 }}>
                <Info />
                <span>This reads themes already cached by Theme Manager on the selected phone. Opening one creates a read-only reference in memory so you can copy selected files into your project; the phone cache stays untouched, and the app does not call store download or rights endpoints. Copies are recorded in the project report.</span>
              </div>
              {deviceReferenceError && <div className="banner banner-err" style={{ marginBottom: 14 }}><AlertTriangle /><span>{deviceReferenceError}</span></div>}
              {!selectedSerial || !attachedDevices.some((device) => device.serial === selectedSerial && device.state === 'device') ? (
                <div className="empty">
                  <Globe />
                  <h3>Connect a phone to browse its themes</h3>
                  <p>Connect and authorize a Xiaomi phone in Device, then return here and refresh.</p>
                </div>
              ) : deviceThemesError ? (
                <div className="banner banner-err">
                  <AlertTriangle />
                  <span className="grow">{deviceThemesError}</span>
                  <button className="btn btn-sm" onClick={() => void loadDeviceThemes()}>Retry</button>
                </div>
              ) : deviceThemesLoading && deviceThemes.length === 0 ? (
                <div className="empty"><Loader2 className="spin" /><p>Reading Theme Manager cache…</p></div>
              ) : deviceThemes.length === 0 ? (
                <div className="empty">
                  <ImageOff />
                  <h3>No cached theme records found</h3>
                  <p>Open Theme Manager and download or open a theme on this phone, then refresh.</p>
                </div>
              ) : (
                <>
                  <div className="section-head">
                    <h2>Cached themes</h2>
                    <span className="muted">{deviceThemes.length} on {attachedDevices.find((device) => device.serial === selectedSerial)?.model ?? selectedSerial}</span>
                  </div>
                  <div className="catalog-grid device-theme-grid">
                    {deviceThemes.map((theme) => (
                      <DeviceThemeCard
                        key={`${selectedSerial}:${theme.localId}`}
                        serial={selectedSerial!}
                        theme={theme}
                        isOpening={openingThemeId === theme.localId}
                        openBusy={openingThemeId !== null}
                        onOpenReference={(selected) => void openCachedReference(selected)}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
          <div className="banner banner-info" style={{ marginBottom: 16 }}>
            <Info />
            <div>
              Shelves and categories below are live data from the public Theme Manager catalog API. <strong>Individual themes and downloads are not available</strong>: in verified calls the service returns
              shelf titles without product lists, and the download and rights routes are not used by this app. Paid or DRM-protected content is never bypassed.
            </div>
          </div>

          {!consent ? (
            <div className="empty">
              <Globe />
              <h3>Load the online catalog?</h3>
              <p>
                This sends an anonymous GET request (no account, device or package data) to Xiaomi’s catalog service:
                <br />
                <code>{ENDPOINTS[source]}</code>
              </p>
              <button className="btn btn-primary" onClick={allow}>
                Load catalog
              </button>
            </div>
          ) : error ? (
            <div className="banner banner-err">
              <AlertTriangle />
              <span className="grow">{error}</span>
              <div className="actions">
                <button className="btn btn-sm" onClick={() => void load(source)}>
                  Retry
                </button>
              </div>
            </div>
          ) : !current ? (
            <div className="empty">
              <Loader2 className="spin" />
              <p>Loading catalog…</p>
            </div>
          ) : sections.length === 0 ? (
            <div className="empty">
              <Globe />
              {returned.length ? (
                <>
                  <h3>All {returned.length} cards are marked hidden by the service</h3>
                  <p>The request succeeded. The service flags every card on this page as not visible.</p>
                  <button className="btn" onClick={() => setShowHidden(true)}>
                    Show them anyway
                  </button>
                </>
              ) : (
                <>
                  <h3>The service returned no cards</h3>
                  <p>The request succeeded but the page is empty for this region or language.</p>
                </>
              )}
            </div>
          ) : (
            <>
              {others.map((s, i) => (
                <SectionView key={s.cardUuid ?? `o${i}`} section={s} />
              ))}
              {shelves.length > 0 && (
                <div className="section">
                  <div className="section-head">
                    <h2>Theme shelves</h2>
                    <span className="muted">{shelves.length} shelves</span>
                  </div>
                  <div className="surface">
                    {shelves.map((s, i) => (
                      <div key={s.cardUuid ?? `s${i}`} className="shelf-row">
                        <span className="grow ellipsis">
                          <strong>{sectionTitle(s)}</strong>
                          {s.localizedTitle && s.localizedTitle !== s.title && <span className="faint"> · {s.localizedTitle}</span>}
                        </span>
                        {!s.visible && <span className="badge badge-outline">hidden by service</span>}
                        <span className="badge badge-outline" title="The service returned this shelf without a product list">
                          <Lock /> {s.productsReturned ? `${s.productsReturned} products` : 'No products returned'}
                        </span>
                        {s.subjectUuid && (
                          <button
                            className="btn btn-ghost btn-sm"
                            title={`Copy subject ID ${s.subjectUuid}`}
                            onClick={() => void navigator.clipboard?.writeText(s.subjectUuid!)}
                          >
                            <ClipboardCopy /> ID
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {last?.hasMore && (
                <div className="section">
                  <button className="btn" disabled={loading} onClick={() => void load(source, true)}>
                    {loading ? <Loader2 className="spin" /> : null} Load more cards
                  </button>
                </div>
              )}
              <p className="faint" style={{ marginTop: 18, fontSize: 12.5 }}>
                Source: <code>{last?.endpoint}</code>
              </p>
            </>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
