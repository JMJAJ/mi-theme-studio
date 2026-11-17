// Crop & position a wallpaper for the phone's screen shape. Works on a
// wallpaper already in the theme: drag to move, zoom with the slider or the
// wheel, then save it over the original (undoable).
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Crop, Loader2 } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import type { FileInfo } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { Modal } from '../common/Modal';

const useCropRequest = create<{ path: string | null }>(() => ({ path: null }));

export function openWallpaperCrop(path: string) {
  useCropRequest.setState({ path });
}

export function WallpaperCropHost() {
  const path = useCropRequest((s) => s.path);
  const file = useStore((s) => (path ? s.fileIndex.get(path) : undefined));
  if (!path || !file) return null;
  return <WallpaperCropDialog key={`${path}:${file.rev}`} file={file} onClose={() => useCropRequest.setState({ path: null })} />;
}

const RATIOS: [string, number][] = [
  ['20:9', 9 / 20],
  ['19.5:9', 9 / 19.5],
  ['18:9', 9 / 18],
  ['16:9', 9 / 16],
];
const FRAME_H = 440;

function WallpaperCropDialog({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  const screen = useStore((s) => (s.selectedSerial ? (s.deviceDetails[s.selectedSerial]?.screenOverride ?? s.deviceDetails[s.selectedSerial]?.screen) : null));
  const phoneRatio = screen && screen.width && screen.height ? Math.min(screen.width, screen.height) / Math.max(screen.width, screen.height) : null;
  const [ratio, setRatio] = useState(phoneRatio ?? RATIOS[0][1]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 }); // centre of the crop, as a fraction of the picture
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => setImg(el);
    el.onerror = () => setError(true);
    // "&crop" avoids a copy cached without the cross-origin header, which could not be read back from a canvas.
    el.src = `${resourceUrl('main', file.path, file.rev)}&crop`;
  }, [file.path, file.rev]);

  const frameW = FRAME_H * ratio;
  // Crop rectangle in picture pixels: the largest one of this shape, shrunk by zoom.
  const crop = useMemo(() => {
    if (!img) return null;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const full = iw / ih > ratio ? { w: ih * ratio, h: ih } : { w: iw, h: iw / ratio };
    const w = full.w / zoom;
    const h = full.h / zoom;
    const x = Math.min(Math.max(pos.x * iw - w / 2, 0), iw - w);
    const y = Math.min(Math.max(pos.y * ih - h / 2, 0), ih - h);
    return { x, y, w, h, iw, ih };
  }, [img, ratio, zoom, pos]);

  const scale = crop ? frameW / crop.w : 1;
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !crop) return;
    const dx = (e.clientX - drag.current.x) / scale;
    const dy = (e.clientY - drag.current.y) / scale;
    const cx = Math.min(Math.max(drag.current.px - dx, crop.w / 2), crop.iw - crop.w / 2);
    const cy = Math.min(Math.max(drag.current.py - dy, crop.h / 2), crop.ih - crop.h / 2);
    setPos({ x: cx / crop.iw, y: cy / crop.ih });
  };

  const save = async () => {
    if (!img || !crop) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(crop.w);
      canvas.height = Math.round(crop.h);
      canvas.getContext('2d')!.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      const png = /\.png$/i.test(file.path);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', 0.93));
      if (!blob) throw new Error('no image');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ok = await A.writeGenerated([{ path: file.path, bytes }], 'Crop wallpaper', `${fileName(file.path)} cropped to ${canvas.width}×${canvas.height}`);
      if (ok) onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={`Crop & position · ${fileName(file.path)}`}
      icon={<Crop width={16} className="muted" />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 'var(--fs-xs)' }}>
            {crop ? `${Math.round(crop.w)} × ${Math.round(crop.h)} px of ${crop.iw} × ${crop.ih}` : ''}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!crop || busy} onClick={() => void save()}>
            {busy ? <Loader2 className="spin" /> : <Crop />} Save crop
          </button>
        </>
      }
    >
      <div className="crop">
        <div
          className="crop-frame"
          style={{ width: frameW, height: FRAME_H }}
          onPointerDown={(e) => {
            if (!crop) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: crop.x + crop.w / 2, py: crop.y + crop.h / 2 };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onWheel={(e) => setZoom((z) => Math.min(4, Math.max(1, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))}
        >
          {error ? (
            <span className="swap-empty">This picture could not be opened for cropping.</span>
          ) : !img || !crop ? (
            <Loader2 className="spin" />
          ) : (
            <img src={img.src} alt="" draggable={false} style={{ width: crop.iw * scale, height: crop.ih * scale, transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px)` }} />
          )}
          <span className="crop-notch" />
        </div>
        <div className="crop-side">
          <div>
            <div className="crop-label">Screen shape</div>
            <div className="crop-ratios">
              {phoneRatio && (
                <button className="swap-part-chip" aria-selected={ratio === phoneRatio} onClick={() => setRatio(phoneRatio)}>
                  Your phone
                </button>
              )}
              {RATIOS.map(([name, value]) => (
                <button key={name} className="swap-part-chip" aria-selected={ratio === value} onClick={() => setRatio(value)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="crop-label">Zoom · {zoom.toFixed(2)}×</div>
            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" style={{ width: '100%' }} />
          </div>
          <p className="faint" style={{ fontSize: 'var(--fs-sm)', margin: 0 }}>
            Drag the picture to choose what shows. The crop replaces this wallpaper file in the theme; Undo brings the full picture back.
          </p>
          <button
            className="btn btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              setZoom(1);
              setPos({ x: 0.5, y: 0.5 });
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </Modal>
  );
}
