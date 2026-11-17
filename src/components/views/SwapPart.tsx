// Swap dialog: replace one part of the open theme (icons, lock screen, font,
// wallpapers…) with the same part from another theme: a store download, a
// theme cached on the phone, or any .mtz file. Shows the part now and after,
// side by side, before anything changes.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ArrowRight, Check, FileArchive, Loader2, Repeat, ShoppingBag, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, plural } from '../../lib/format';
import type { CachedDeviceTheme, ComponentDef, DownloadedTheme, MediaTarget } from '../../lib/types';
import * as A from '../../state/actions';
import { toast, useStore } from '../../state/store';
import { refreshDownloads, useThemeStore } from '../../state/themeStore';
import { openStoreTab } from '../../state/storeTab';
import { Modal } from '../common/Modal';
import { PART_COPY, PART_ORDER, PartThumb, previewImages } from './PartArt';

type Source =
  | { kind: 'download'; key: string; theme: DownloadedTheme }
  | { kind: 'phone'; key: string; theme: CachedDeviceTheme }
  | { kind: 'reference'; key: string; title: string };

const MEDIA_FOR: Record<string, { kind: 'wallpaper' | 'ringtone'; targets: [MediaTarget, string][] }> = {
  wallpapers: { kind: 'wallpaper', targets: [['homeWallpaper', 'Home screen'], ['lockWallpaper', 'Lock screen']] },
  sounds: { kind: 'ringtone', targets: [['ringtone', 'Ringtone'], ['notification', 'Notification'], ['alarm', 'Alarm']] },
};

/**
 * What to open the dialog on: a part of the open theme, optionally with the
 * source already chosen (a downloaded theme to take several parts from, or a
 * downloaded wallpaper / ringtone).
 */
export interface SwapRequest {
  part?: string;
  theme?: DownloadedTheme;
  media?: DownloadedTheme;
}

const useSwapRequest = create<{ request: SwapRequest | null }>(() => ({ request: null }));

/** Open the swap dialog from anywhere. Needs an open theme to swap into. */
export function openSwap(request: SwapRequest) {
  if (!useStore.getState().project) {
    toast('warning', 'Open or create a theme first, then you can take parts from this one.');
    return false;
  }
  useSwapRequest.setState({ request });
  return true;
}

export function SwapHost() {
  const request = useSwapRequest((s) => s.request);
  const hasProject = useStore((s) => !!s.project);
  if (!request || !hasProject) return null;
  return <SwapPartDialog key={JSON.stringify([request.part, request.theme?.moduleId, request.media?.moduleId])} request={request} onClose={() => useSwapRequest.setState({ request: null })} />;
}

function SwapPartDialog({ request, onClose }: { request: SwapRequest; onClose: () => void }) {
  const multi = !!request.theme;
  const initialPart = request.part ?? (request.media ? (request.media.kind === 'ringtone' ? 'sounds' : 'wallpapers') : request.theme?.kind === 'font' ? 'fonts' : 'icons');
  const project = useStore((s) => s.project)!;
  const reference = useStore((s) => s.reference);
  const serial = useStore((s) => (s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device') ? s.selectedSerial : null));
  const downloads = useThemeStore((s) => s.downloads);
  const [part, setPart] = useState(initialPart);
  const [selected, setSelected] = useState<string | null>(request.media ? `media:${request.media.moduleId}` : null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(request.part || !multi ? [initialPart] : []));
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phoneThemes, setPhoneThemes] = useState<CachedDeviceTheme[] | null>(null);
  const [clean, setClean] = useState(true);
  const [targets, setTargets] = useState<Set<MediaTarget>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshDownloads();
    if (request.theme) void choose({ kind: 'download', key: `dl:${request.theme.moduleId}`, theme: request.theme });
  }, []);
  useEffect(() => {
    if (!serial) return setPhoneThemes(null);
    let cancelled = false;
    api
      .adbCachedThemes(serial)
      .then((list) => !cancelled && setPhoneThemes(list ?? []))
      .catch(() => !cancelled && setPhoneThemes([]));
    return () => {
      cancelled = true;
    };
  }, [serial]);

  const parts = PART_ORDER.map((id) => project.components.find((c) => c.id === id)).filter(Boolean) as ComponentDef[];
  const def = parts.find((p) => p.id === part) ?? project.components.find((c) => c.id === part);
  const label = def?.label ?? part;
  const media = MEDIA_FOR[part];

  const packages = downloads.filter((d) => d.kind === 'theme' || (d.kind === 'font' && part === 'fonts'));
  const mediaItems = media ? downloads.filter((d) => d.kind === media.kind) : [];
  const sources: Source[] = [
    ...packages.map((theme) => ({ kind: 'download' as const, key: `dl:${theme.moduleId}`, theme })),
    ...(phoneThemes ?? []).map((theme) => ({ kind: 'phone' as const, key: `ph:${theme.localId}`, theme })),
  ];
  const known = (path: string | null) => !!path && downloads.some((d) => d.path === path);
  if (reference && !known(reference.sourcePath)) sources.push({ kind: 'reference', key: 'ref', title: reference.title });

  // The reference that is open right now decides what "selected" shows.
  useEffect(() => {
    if (selected || !reference) return;
    const dl = downloads.find((d) => d.path === reference.sourcePath);
    setSelected(dl ? `dl:${dl.moduleId}` : 'ref');
  }, [reference, downloads]);

  const pickedMedia = selected?.startsWith('media:') ? mediaItems.find((m) => `media:${m.moduleId}` === selected) : undefined;
  useEffect(() => {
    if (media) setTargets(new Set([media.targets[0][0]]));
  }, [part, selected]);

  const choose = async (source: Source) => {
    setSelected(source.key);
    setError(null);
    if (source.kind === 'reference') return;
    setOpening(source.key);
    try {
      const snap =
        source.kind === 'download'
          ? await A.openDownloadAsReference(source.theme, false)
          : serial
            ? await A.openPhoneThemeAsReference(serial, source.theme.localId, source.theme.title)
            : null;
      if (!snap) setError('Could not open that theme.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };
  const openFile = async () => {
    setError(null);
    setOpening('file');
    const snap = await A.openReference(false);
    setOpening(null);
    if (snap) setSelected(downloads.some((d) => d.path === snap.sourcePath) ? `dl:${downloads.find((d) => d.path === snap.sourcePath)!.moduleId}` : 'ref');
  };

  const currentFiles = useMemo(() => project.files.filter((f) => f.component === part), [project, part]);
  const currentPreviews = useMemo(() => previewImages(project), [project]);
  const sourceReady = !!reference && !opening && !!selected && !selected.startsWith('media:');
  const sourceFiles = useMemo(() => (sourceReady && reference ? reference.files.filter((f) => f.component === part) : []), [sourceReady, reference, part]);
  const sourcePreviews = useMemo(() => (sourceReady && reference ? previewImages(reference) : []), [sourceReady, reference]);
  const sourceBytes = sourceFiles.reduce((n, f) => n + f.size, 0);

  // Parts the chosen source actually has; in multi mode only those are offered.
  const available = useMemo(() => new Set(sourceReady && reference ? reference.files.map((f) => f.component) : []), [sourceReady, reference]);
  const chips = parts.filter((p) => !['other', 'previews'].includes(p.id) && (!multi || !sourceReady || available.has(p.id)));
  useEffect(() => {
    if (!multi || !sourceReady) return;
    // A package with a single part (a font) needs no ticking; otherwise drop ticks the source can't fill.
    if (chips.length === 1) {
      setPart(chips[0].id);
      setPicked(new Set([chips[0].id]));
    } else {
      setPicked((s) => new Set([...s].filter((id) => available.has(id))));
      if (!available.has(part) && chips[0]) setPart(chips[0].id);
    }
  }, [multi, sourceReady, available]);

  // How each part compares with the chosen source: same files, different, or only on one side.
  const compare = useMemo(() => {
    const map = new Map<string, 'same' | 'differs' | 'new'>();
    if (!sourceReady || !reference) return map;
    const sig = (files: typeof project.files, id: string) =>
      files
        .filter((f) => f.component === id)
        .map((f) => `${f.path}:${f.size}`)
        .sort()
        .join('|');
    for (const p of parts) {
      const theirs = sig(reference.files, p.id);
      if (!theirs) continue;
      const mine = sig(project.files, p.id);
      map.set(p.id, !mine ? 'new' : mine === theirs ? 'same' : 'differs');
    }
    return map;
  }, [sourceReady, reference, project, parts.length]);
  const compareText = { same: 'Same as yours', differs: 'Different from yours', new: 'You don’t have this part' } as const;

  const chosenParts = multi ? chips.filter((p) => picked.has(p.id)) : def ? [def] : [];
  const canSwap = pickedMedia ? targets.size > 0 : sourceReady && (multi ? chosenParts.length > 0 : sourceFiles.length > 0);
  const swap = async () => {
    setBusy(true);
    const ok = pickedMedia
      ? await A.applyDownloadedMedia(pickedMedia, [...targets])
      : await A.swapParts(chosenParts.map((p) => ({ id: p.id, label: p.label })), clean);
    setBusy(false);
    if (ok) onClose();
  };
  const actionLabel = pickedMedia
    ? `Use ${media?.kind === 'ringtone' ? 'sound' : 'wallpaper'}`
    : multi
      ? chosenParts.length
        ? `Use ${plural(chosenParts.length, 'part')}`
        : 'Tick parts to use'
      : `${currentFiles.length ? 'Swap' : 'Add'} ${label.toLowerCase()}`;

  const sourceName = (s: Source) => (s.kind === 'reference' ? s.title : s.kind === 'download' ? s.theme.name : s.theme.title);
  const row = (s: Source) => (
    <button key={s.key} className="swap-source" aria-pressed={selected === s.key} onClick={() => void choose(s)}>
      <span className="swap-source-art">
        {s.kind === 'download' && s.theme.cover ? (
          <img src={s.theme.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : s.kind === 'phone' ? (
          <Smartphone />
        ) : (
          <FileArchive />
        )}
      </span>
      <span className="swap-source-text">
        <span className="ellipsis">{sourceName(s)}</span>
        <span className="faint ellipsis">
          {s.kind === 'download' ? (s.theme.designer ?? (s.theme.kind === 'font' ? 'Font' : 'Store theme')) : s.kind === 'phone' ? (s.theme.designer ?? s.theme.author ?? 'On the phone') : 'Open reference'}
        </span>
      </span>
      {opening === s.key ? <Loader2 className="spin" /> : selected === s.key ? <Check className="swap-check" /> : null}
    </button>
  );

  return (
    <Modal
      wide
      title={multi ? `Use parts of “${request.theme!.name}”` : currentFiles.length ? `Swap ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
      icon={<Repeat width={16} className="muted" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={() => (onClose(), openStoreTab('discover'))}>
            <ShoppingBag /> Find more in the store
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSwap || busy} onClick={() => void swap()}>
            {busy ? <Loader2 className="spin" /> : <Repeat />} {actionLabel}
          </button>
        </>
      }
    >
      {multi && <p className="muted swap-hint">Tick the parts you want. Click a part to see it now and after.</p>}
      <div className="swap-parts" role="tablist" aria-label="Part to swap">
        {chips.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === part}
            className={`swap-part-chip ${multi ? 'is-multi' : ''} ${multi && picked.has(p.id) ? 'is-picked' : ''}`}
            onClick={() => {
              if (multi)
                setPicked((s) => {
                  const next = new Set(s);
                  // Clicking the part already in view toggles it; clicking another one shows and ticks it.
                  if (p.id === part && next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  return next;
                });
              setPart(p.id);
              if (selected?.startsWith('media:')) setSelected(null);
            }}
          >
            {multi && <span className="swap-tick">{picked.has(p.id) && <Check />}</span>}
            {p.label}
            {compare.get(p.id) && <span className={`swap-diff is-${compare.get(p.id)}`} title={compareText[compare.get(p.id)!]} />}
          </button>
        ))}
        {multi && opening && (
          <span className="swap-note">
            <Loader2 className="spin" /> Reading the theme…
          </span>
        )}
      </div>

      <div className={`swap ${multi ? 'is-multi' : ''}`}>
        <div className="swap-sources" hidden={multi}>
          <div className="swap-group">Take it from</div>
          {mediaItems.length > 0 && (
            <>
              <div className="swap-sub">{media!.kind === 'wallpaper' ? 'Downloaded wallpapers' : 'Downloaded ringtones'}</div>
              {mediaItems.map((m) => (
                <button key={m.moduleId} className="swap-source" aria-pressed={selected === `media:${m.moduleId}`} onClick={() => setSelected(`media:${m.moduleId}`)}>
                  <span className="swap-source-art">{m.cover ? <img src={m.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <FileArchive />}</span>
                  <span className="swap-source-text">
                    <span className="ellipsis">{m.name}</span>
                    <span className="faint ellipsis">{formatBytes(m.sizeBytes)}</span>
                  </span>
                  {selected === `media:${m.moduleId}` && <Check className="swap-check" />}
                </button>
              ))}
            </>
          )}
          {packages.length > 0 && <div className="swap-sub">Downloaded themes</div>}
          {sources.filter((s) => s.kind === 'download').map(row)}
          {serial && <div className="swap-sub">On the phone</div>}
          {serial && phoneThemes === null && (
            <div className="swap-note">
              <Loader2 className="spin" /> Reading Theme Manager…
            </div>
          )}
          {serial && phoneThemes?.length === 0 && <div className="swap-note">No cached themes on the phone</div>}
          {sources.filter((s) => s.kind === 'phone').map(row)}
          <div className="swap-sub">Other</div>
          {sources.filter((s) => s.kind === 'reference').map(row)}
          <button className="swap-source" onClick={() => void openFile()}>
            <span className="swap-source-art">{opening === 'file' ? <Loader2 className="spin" /> : <FileArchive />}</span>
            <span className="swap-source-text">
              <span>Open a .mtz file…</span>
              <span className="faint ellipsis">Any theme package on this computer</span>
            </span>
          </button>
          {!packages.length && !serial && (
            <div className="swap-note">Download themes in the store and they show up here, ready to swap from.</div>
          )}
        </div>

        <div className="swap-preview">
          <div className="swap-compare">
            <figure>
              <figcaption>Now</figcaption>
              <div className="swap-art">
                <PartThumb part={part} files={currentFiles} previews={currentPreviews} interactive />
              </div>
              <span className="faint">{currentFiles.length ? `${plural(currentFiles.length, 'file')} · ${formatBytes(currentFiles.reduce((n, f) => n + f.size, 0))}` : 'Not in this theme'}</span>
            </figure>
            <ArrowRight className="swap-arrow" />
            <figure>
              <figcaption>New</figcaption>
              <div className="swap-art is-new">
                {pickedMedia ? (
                  pickedMedia.cover ? <img className="pc-contain" src={pickedMedia.cover} alt="" referrerPolicy="no-referrer" /> : <FileArchive />
                ) : opening ? (
                  <Loader2 className="spin" />
                ) : sourceReady && sourceFiles.length ? (
                  <PartThumb part={part} files={sourceFiles} previews={sourcePreviews} slot="ref" interactive />
                ) : (
                  <span className="swap-empty">{sourceReady ? `No ${label.toLowerCase()} in this theme` : 'Pick a theme on the left'}</span>
                )}
              </div>
              <span className="faint ellipsis">
                {pickedMedia ? pickedMedia.name : sourceReady && sourceFiles.length ? `${plural(sourceFiles.length, 'file')} · ${formatBytes(sourceBytes)} from ${reference!.title}` : ' '}
              </span>
            </figure>
          </div>

          {compare.size > 0 && (
            <div className="swap-legend">
              <span>
                <i className="swap-diff is-differs" /> different from yours
              </span>
              <span>
                <i className="swap-diff is-new" /> you don’t have it
              </span>
              <span>
                <i className="swap-diff is-same" /> same as yours
              </span>
              {compare.get(part) && <strong>{label}: {compareText[compare.get(part)!].toLowerCase()}</strong>}
            </div>
          )}
          {error && <div className="banner banner-err">{error}</div>}

          {pickedMedia && media ? (
            <div className="swap-options">
              <span className="muted">Use it as</span>
              {media.targets.map(([t, name]) => (
                <label key={t} className="check">
                  <input
                    type="checkbox"
                    checked={targets.has(t)}
                    onChange={() =>
                      setTargets((s) => {
                        const next = new Set(s);
                        if (next.has(t)) next.delete(t);
                        else next.add(t);
                        return next;
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          ) : (
            (multi ? chosenParts.length > 0 : currentFiles.length > 0) && (
              <label className="check swap-options">
                <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
                <span>
                  Remove the current {multi ? 'files of those parts' : label.toLowerCase()} first
                  <span className="faint"> · a clean swap, nothing old left behind. Untick to only add and overwrite.</span>
                </span>
              </label>
            )
          )}
          <p className="faint swap-foot">{PART_COPY[part] ?? def?.description}. Everything is undoable with Ctrl+Z.</p>
        </div>
      </div>
    </Modal>
  );
}
