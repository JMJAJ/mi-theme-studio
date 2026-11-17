// Visual summary of one theme part (wallpapers, icons, fonts, sounds…), shared
// by the Design overview cards and the Swap dialog. Works for the open theme
// ('main') and the reference package ('ref').
import { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import type { FileInfo, ProjectSnapshot, Slot } from '../../lib/types';
import { componentIcon } from '../common/icons';
import { themeFontFile, usePackageFont } from '../common/themeFont';
import { findWallpaper, pickIcons } from './PreviewView';

/** Order and wording that match how a theme looks on the phone. */
export const PART_ORDER = ['wallpapers', 'lockscreen', 'icons', 'home', 'systemui', 'fonts', 'widgets', 'sounds', 'previews', 'settings', 'apps', 'framework', 'boot', 'other'];
export const PART_COPY: Record<string, string> = {
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

/** Store screenshots in a snapshot (the big ones, not the _small_ copies). */
export function previewImages(snapshot: ProjectSnapshot) {
  return snapshot.files.filter((f) => f.component === 'previews' && f.kind === 'image' && !/_small_/i.test(f.path));
}

function Phones({ files, slot }: { files: FileInfo[]; slot: Slot }) {
  const wide = files.filter((f) => (f.width ?? 0) > (f.height ?? 0) * 0.8);
  if (wide.length) return <img className="pc-contain" src={resourceUrl(slot, wide[0].path, wide[0].rev)} alt="" loading="lazy" />;
  return (
    <div className="pc-phones">
      {files.map((f) => (
        <img key={f.path} src={resourceUrl(slot, f.path, f.rev)} alt="" loading="lazy" />
      ))}
    </div>
  );
}

export function PartThumb({
  part,
  files,
  previews,
  slot = 'main',
  interactive = false,
}: {
  part: string;
  files: FileInfo[];
  previews: FileInfo[];
  slot?: Slot;
  /** True where the thumb is not inside a button, so it may hold its own controls (sound playback). */
  interactive?: boolean;
}) {
  const images = files.filter((f) => f.kind === 'image');
  const url = (f: FileInfo) => resourceUrl(slot, f.path, f.rev);
  const shots = partPreviews(part, previews);
  if (shots.length && part !== 'icons') return <Phones files={shots} slot={slot} />;
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
    return <Phones files={[home, lock !== home ? lock : undefined].filter(Boolean) as FileInfo[]} slot={slot} />;
  }
  if (part === 'fonts') {
    const font = themeFontFile(files) ?? files.find((f) => f.kind === 'font');
    return <FontSpecimen file={font} slot={slot} />;
  }
  if (part === 'sounds' && files.length) {
    const sounds = files.filter((f) => f.kind === 'audio');
    if (interactive && sounds.length) return <SoundList files={sounds} slot={slot} />;
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
  // No screenshot of this part: show its own biggest pictures rather than a generic icon.
  const own = representativeImages(files);
  if (own.length)
    return (
      <div className={`pc-mosaic n${own.length}`}>
        {own.map((f) => (
          <img key={f.path} src={url(f)} alt="" loading="lazy" />
        ))}
      </div>
    );
  const Icon = componentIcon(part);
  return (
    <div className="pc-placeholder">
      <Icon />
    </div>
  );
}

function FontSpecimen({ file, slot }: { file?: FileInfo; slot: Slot }) {
  const { family, failed } = usePackageFont(file, slot);
  return (
    <div className={`pc-font ${file && !family ? 'is-pending' : ''}`} style={family ? { fontFamily: family } : undefined}>
      <span>Aa</span>
      <p className="pc-font-sample">
        12:36 · Hello, phone!
        <br />
        ABC abc 0123456789
      </p>
      <small>{!file ? 'System default' : failed ? `${fileName(file.path)} · can't preview this font` : fileName(file.path)}</small>
    </div>
  );
}

/** Sounds you can actually listen to (only where the card itself is not a button). */
function SoundList({ files, slot }: { files: FileInfo[]; slot: Slot }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    audio.current?.pause();
    setPlaying(null);
  }, [slot, files]);
  const toggle = (f: FileInfo) => {
    audio.current?.pause();
    if (playing === f.path) return setPlaying(null);
    const el = new Audio(resourceUrl(slot, f.path, f.rev));
    el.onended = () => setPlaying((p) => (p === f.path ? null : p));
    el.onerror = () => setPlaying((p) => (p === f.path ? null : p));
    audio.current = el;
    setPlaying(f.path);
    void el.play().catch(() => setPlaying(null));
  };
  return (
    <div className="pc-list pc-sounds">
      {files.slice(0, 6).map((f) => (
        <button key={f.path} className={`pc-sound ${playing === f.path ? 'is-playing' : ''}`} onClick={() => toggle(f)} title={playing === f.path ? 'Stop' : 'Listen'}>
          {playing === f.path ? <Square /> : <Play />}
          <span className="ellipsis">{fileName(f.path)}</span>
        </button>
      ))}
    </div>
  );
}

/** The biggest pictures of a part, for parts that ship no screenshot of themselves. */
function representativeImages(files: FileInfo[]) {
  return files
    .filter((f) => f.kind === 'image' && !f.ninePatch && (f.width ?? 0) >= 48 && (f.height ?? 0) >= 48)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))
    .slice(0, 6);
}
