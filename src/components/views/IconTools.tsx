// Icon pack tools: import many icon files at once (matched to apps by name),
// and generate matching icons for apps the theme has no icon for.
import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Loader2, Wand2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { joinPath } from '../../lib/paths';
import { plural } from '../../lib/format';
import type { DeviceApp } from '../../lib/types';
import * as A from '../../state/actions';
import { applySnapshot } from '../../state/actions';
import { log, toast } from '../../state/store';
import { Modal } from '../common/Modal';

const norm = (s: string) => s.toLowerCase().replace(/\.(png|webp|jpe?g)$/i, '').replace(/[^a-z0-9а-яё]/gi, '');

/**
 * Pick many icon files; each is stored as `<package>.png` for the app whose
 * package or name matches the file name. Files already named like a package
 * are kept as they are; the rest are reported, not guessed.
 */
export async function importIconsMatched(apps: DeviceApp[], folder: string) {
  const picked = await openDialog({ title: 'Import icons (file names are matched to apps)', multiple: true, directory: false, filters: [{ name: 'Images', extensions: ['png', 'webp', 'jpg'] }] });
  if (!picked) return;
  const sources = Array.isArray(picked) ? picked : [picked];
  const byPackage = new Map(apps.map((a) => [a.package.toLowerCase(), a]));
  const byLabel = new Map<string, DeviceApp | null>();
  for (const a of apps) {
    const k = norm(a.label);
    if (k) byLabel.set(k, byLabel.has(k) ? null : a); // two apps with one name: don't guess
  }
  const use: string[] = [];
  const names: string[] = [];
  const unmatched: string[] = [];
  for (const source of sources) {
    const base = source.replace(/\\/g, '/').split('/').pop() ?? source;
    const ext = (base.match(/\.(png|webp|jpe?g)$/i)?.[0] ?? '.png').toLowerCase();
    const stem = base.replace(/\.(png|webp|jpe?g)$/i, '');
    const pkg = byPackage.get(stem.split('#')[0].toLowerCase()) ? stem : (byLabel.get(norm(stem))?.package ?? (/^[a-z][\w]*(\.[\w]+)+(#.+)?$/i.test(stem) ? stem : null));
    if (!pkg) {
      unmatched.push(base);
      continue;
    }
    use.push(source);
    names.push(`${pkg}${ext}`);
  }
  if (!use.length) {
    toast('warning', `None of the ${plural(sources.length, 'file')} matched an app. Name files after the app (“Camera.png”) or its package (“com.android.camera.png”).`);
    return;
  }
  try {
    const response = await api.filesImport(use, folder, 'overwrite', names);
    applySnapshot(response.snapshot);
    for (const u of unmatched) log('warning', `Icon import: no app matches “${u}”, skipped`);
    toast(unmatched.length ? 'warning' : 'success', `${plural(use.length, 'icon')} imported${unmatched.length ? `, ${unmatched.length} had no matching app (listed in the output log)` : ''}`);
  } catch (e) {
    toast('error', `Import icons: ${errorMessage(e)}`);
  }
}

type Shape = 'squircle' | 'circle' | 'rounded' | 'square';
const SHAPES: [Shape, string][] = [
  ['squircle', 'Squircle'],
  ['circle', 'Circle'],
  ['rounded', 'Rounded'],
  ['square', 'Square'],
];
const SIZE = 192;

function hueOf(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** #rrggbb, 30% darker (canvas gradients take plain colours only). */
function darken(hex: string) {
  const c = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.7).toString(16).padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(hex) ? `#${c(1)}${c(3)}${c(5)}` : hex;
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, s: number) {
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  else if (shape === 'square') ctx.rect(0, 0, s, s);
  else if (shape === 'rounded') ctx.roundRect(0, 0, s, s, s * 0.18);
  else {
    // superellipse, the shape MIUI/HyperOS icons use
    const n = 5;
    for (let i = 0; i <= 360; i += 2) {
      const t = (i * Math.PI) / 180;
      const x = s / 2 + (Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 2 / n) * s) / 2;
      const y = s / 2 + (Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 2 / n) * s) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

interface Style {
  shape: Shape;
  auto: boolean;
  background: string;
  text: string;
  gradient: boolean;
}

function drawIcon(canvas: HTMLCanvasElement, app: DeviceApp, style: Style) {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, SIZE, SIZE);
  shapePath(ctx, style.shape, SIZE);
  const base = style.auto ? `hsl(${hueOf(app.package)} 62% 46%)` : style.background;
  if (style.gradient) {
    const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, base);
    g.addColorStop(1, style.auto ? `hsl(${(hueOf(app.package) + 40) % 360} 68% 34%)` : darken(style.background));
    ctx.fillStyle = g;
  } else ctx.fillStyle = base;
  ctx.fill();
  const letter = ([...app.label.trim()].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '?').toUpperCase();
  ctx.fillStyle = style.text;
  ctx.font = `600 ${SIZE * 0.5}px "DM Sans Variable", "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, SIZE / 2, SIZE / 2 + SIZE * 0.035);
}

function Sample({ app, style }: { app: DeviceApp; style: Style }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawIcon(ref.current, app, style);
  }, [app, style]);
  return (
    <figure className="gen-sample">
      <canvas ref={ref} />
      <figcaption className="ellipsis">{app.label}</figcaption>
    </figure>
  );
}

export function GenerateIconsDialog({ apps, folder, onClose }: { apps: DeviceApp[]; folder: string; onClose: () => void }) {
  const [style, setStyle] = useState<Style>({ shape: 'squircle', auto: true, background: '#ff6a1a', text: '#ffffff', gradient: true });
  const [busy, setBusy] = useState(false);
  const samples = useMemo(() => apps.slice(0, 10), [apps]);
  const patch = (p: Partial<Style>) => setStyle((s) => ({ ...s, ...p }));

  const generate = async () => {
    setBusy(true);
    const canvas = document.createElement('canvas');
    const files: { path: string; bytes: Uint8Array }[] = [];
    for (const app of apps) {
      drawIcon(canvas, app, style);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) files.push({ path: joinPath(folder, `${app.package}.png`), bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const ok = await A.writeGenerated(files, `Generate ${plural(files.length, 'icon')}`, `${plural(files.length, 'icon')} generated. Replace any of them with real artwork later.`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      wide
      title={`Generate icons for ${plural(apps.length, 'app')} without one`}
      icon={<Wand2 width={16} className="muted" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !apps.length} onClick={() => void generate()}>
            {busy ? <Loader2 className="spin" /> : <Wand2 />} Generate {plural(apps.length, 'icon')}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Each app gets an icon in one matching style, with its first letter, so unthemed apps stop looking out of place. The phone does not hand over the apps’ original artwork, so these are
        letter icons, not redrawn logos.
      </p>
      <div className="gen-options">
        <div>
          <div className="crop-label">Shape</div>
          <div className="crop-ratios">
            {SHAPES.map(([id, name]) => (
              <button key={id} className="swap-part-chip" aria-selected={style.shape === id} onClick={() => patch({ shape: id })}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="crop-label">Background</div>
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={style.auto} onChange={(e) => patch({ auto: e.target.checked })} /> A different colour per app
            </label>
            {!style.auto && <input type="color" value={style.background} onChange={(e) => patch({ background: e.target.value })} aria-label="Background colour" />}
            <label className="check">
              <input type="checkbox" checked={style.gradient} onChange={(e) => patch({ gradient: e.target.checked })} /> Gradient
            </label>
          </div>
        </div>
        <div>
          <div className="crop-label">Letter</div>
          <input type="color" value={style.text} onChange={(e) => patch({ text: e.target.value })} aria-label="Letter colour" />
        </div>
      </div>
      <div className="gen-samples">
        {samples.map((a) => (
          <Sample key={a.package} app={a} style={style} />
        ))}
      </div>
      {apps.length > samples.length && <p className="faint" style={{ fontSize: 'var(--fs-xs)', marginBottom: 0 }}>Showing {samples.length} of {apps.length}.</p>}
    </Modal>
  );
}
