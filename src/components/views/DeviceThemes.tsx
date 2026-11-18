// Themes already cached by Theme Manager on the connected phone.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, FolderOpen, Globe, ImageOff, Info, Loader2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { CachedDeviceTheme, DeviceEntry } from '../../lib/types';
import { log, useStore } from '../../state/store';
import { openPhoneThemeAsProject } from '../../state/actions';

const NO_DEVICES: DeviceEntry[] = [];

function DeviceThemeCard({
  serial,
  theme,
  isOpening,
  openBusy,
  onOpenReference,
  onOpenProject,
}: {
  serial: string;
  theme: CachedDeviceTheme;
  isOpening: false | 'project' | 'ref';
  openBusy: boolean;
  onOpenReference: (theme: CachedDeviceTheme) => void;
  onOpenProject: (theme: CachedDeviceTheme) => void;
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
          <button className="btn btn-sm btn-primary" disabled={openBusy} onClick={() => onOpenProject(theme)} title="Copy this theme from the phone and edit it as a new project">
            {isOpening === 'project' ? <Loader2 className="spin" /> : <FolderOpen />} {isOpening === 'project' ? 'Opening…' : 'Open'}
          </button>
          <button className="btn btn-sm" disabled={openBusy} onClick={() => onOpenReference(theme)} title="Open read-only beside your project to copy parts from it">
            {isOpening === 'ref' ? <Loader2 className="spin" /> : <BookOpen />} {isOpening === 'ref' ? 'Opening…' : 'As reference'}
          </button>
        </div>
      </div>
    </article>
  );
}

export function DeviceThemes({ refreshKey, compact = false, headless = false }: { refreshKey: number; compact?: boolean; headless?: boolean }) {
  const selectedSerial = useStore((s) => s.selectedSerial);
  const attachedDevices = useStore((s) => s.adb?.devices ?? NO_DEVICES);
  const [themes, setThemes] = useState<CachedDeviceTheme[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openingKind, setOpeningKind] = useState<'project' | 'ref'>('ref');
  const request = useRef(0);
  const ready = !!selectedSerial && attachedDevices.some((d) => d.serial === selectedSerial && d.state === 'device');

  const load = async () => {
    const serial = selectedSerial;
    if (!serial) {
      setThemes([]);
      setError('Select a connected device in the Device panel first.');
      return;
    }
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.adbCachedThemes(serial);
      if (id === request.current) setThemes(list ?? []);
    } catch (e) {
      if (id === request.current) setError(errorMessage(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSerial) void load();
  }, [selectedSerial, refreshKey]);

  const openReference = async (theme: CachedDeviceTheme) => {
    if (!selectedSerial || openingId) return;
    setOpeningId(theme.localId);
    setOpeningKind('ref');
    setReferenceError(null);
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
      setReferenceError(message);
      log('error', `Could not open cached theme reference: ${message}`);
    } finally {
      setOpeningId(null);
    }
  };

  const openProject = async (theme: CachedDeviceTheme) => {
    if (!selectedSerial || openingId) return;
    setOpeningId(theme.localId);
    setOpeningKind('project');
    setReferenceError(null);
    try {
      await openPhoneThemeAsProject(selectedSerial, theme.localId, theme.title);
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <>
      {!compact && (
      <div className="banner banner-info" style={{ marginBottom: 16 }}>
        <Info />
        <span>Themes already cached by Theme Manager on the selected phone. Open one to edit a copy as a new project, or open it as a read-only reference to copy parts into your theme. The phone's copy stays untouched.</span>
      </div>
      )}
      {referenceError && <div className="banner banner-err" style={{ marginBottom: 14 }}><AlertTriangle /><span>{referenceError}</span></div>}
      {!ready ? (
        <div className="empty">
          <Globe />
          <h3>Connect a phone to browse its themes</h3>
          <p>Connect and authorize a Xiaomi phone in Device, then return here and refresh.</p>
        </div>
      ) : error ? (
        <div className="banner banner-err">
          <AlertTriangle />
          <span className="grow">{error}</span>
          <button className="btn btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      ) : loading && themes.length === 0 ? (
        <div className="empty"><Loader2 className="spin" /><p>Reading Theme Manager cache…</p></div>
      ) : themes.length === 0 ? (
        <div className="empty">
          <ImageOff />
          <h3>No cached theme records found</h3>
          <p>Open Theme Manager and download or open a theme on this phone, then refresh.</p>
        </div>
      ) : (
        <>
          {!headless && (
          <div className="section-head">
            <h2>Cached themes</h2>
            <span className="muted">{themes.length} on {attachedDevices.find((d) => d.serial === selectedSerial)?.model ?? selectedSerial}</span>
          </div>
          )}
          <div className="catalog-grid device-theme-grid">
            {themes.map((theme) => (
              <DeviceThemeCard
                key={`${selectedSerial}:${theme.localId}`}
                serial={selectedSerial!}
                theme={theme}
                isOpening={openingId === theme.localId ? openingKind : false}
                openBusy={openingId !== null}
                onOpenReference={(t) => void openReference(t)}
                onOpenProject={(t) => void openProject(t)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
