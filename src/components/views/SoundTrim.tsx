// Trim a sound to the part you want (ringtones and notification sounds are
// usually a short cut of a longer track), with an optional fade-out. The
// result replaces the file in the theme as uncompressed WAV audio.
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Loader2, Play, Scissors, Square } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { fileName } from '../../lib/paths';
import { formatBytes } from '../../lib/format';
import type { FileInfo } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { Modal } from '../common/Modal';

const useTrimRequest = create<{ path: string | null }>(() => ({ path: null }));

export function openSoundTrim(path: string) {
  useTrimRequest.setState({ path });
}

export function SoundTrimHost() {
  const path = useTrimRequest((s) => s.path);
  const file = useStore((s) => (path ? s.fileIndex.get(path) : undefined));
  if (!path || !file) return null;
  return <SoundTrimDialog key={`${path}:${file.rev}`} file={file} onClose={() => useTrimRequest.setState({ path: null })} />;
}

/** 16-bit PCM WAV from the chosen stretch of a decoded sound. */
function encodeWav(buffer: AudioBuffer, start: number, length: number, fade: number) {
  const rate = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const first = Math.floor(start * rate);
  const frames = Math.max(1, Math.min(Math.floor(length * rate), buffer.length - first));
  const fadeFrames = Math.min(frames, Math.floor(fade * rate));
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  data.setUint32(4, 36 + frames * channels * 2, true);
  text(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, channels, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * channels * 2, true);
  data.setUint16(32, channels * 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, frames * channels * 2, true);
  const source = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const gain = fadeFrames && i >= frames - fadeFrames ? (frames - i) / fadeFrames : 1;
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, source[c][first + i] * gain));
      data.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(data.buffer);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function SoundTrimDialog({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState(false);
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(30);
  const [fade, setFade] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  const node = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    const audio = new AudioContext();
    ctx.current = audio;
    // "&trim" avoids a copy cached without the cross-origin header.
    fetch(`${resourceUrl('main', file.path, file.rev)}&trim`)
      .then((r) => r.arrayBuffer())
      .then((bytes) => audio.decodeAudioData(bytes))
      .then((decoded) => {
        if (cancelled) return;
        setBuffer(decoded);
        setLength(Math.min(30, decoded.duration));
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      node.current?.stop();
      void audio.close();
    };
  }, [file.path, file.rev]);

  const stop = () => {
    node.current?.stop();
    node.current = null;
    setPlaying(false);
  };
  const play = () => {
    if (!buffer || !ctx.current) return;
    stop();
    const src = ctx.current.createBufferSource();
    const gain = ctx.current.createGain();
    src.buffer = buffer;
    src.connect(gain).connect(ctx.current.destination);
    const t = ctx.current.currentTime;
    if (fade) {
      const f = Math.min(2, len / 2);
      gain.gain.setValueAtTime(1, t + len - f);
      gain.gain.linearRampToValueAtTime(0, t + len);
    }
    src.onended = () => node.current === src && setPlaying(false);
    src.start(0, start, len);
    node.current = src;
    setPlaying(true);
  };

  const duration = buffer?.duration ?? 0;
  const len = Math.max(0.2, Math.min(length, duration - start));
  const outBytes = buffer ? 44 + Math.floor(len * buffer.sampleRate) * Math.min(2, buffer.numberOfChannels) * 2 : 0;

  const save = async () => {
    if (!buffer) return;
    stop();
    setBusy(true);
    const bytes = encodeWav(buffer, start, len, fade ? Math.min(2, len / 2) : 0);
    const ok = await A.writeGenerated([{ path: file.path, bytes }], 'Trim sound', `${fileName(file.path)} trimmed to ${len.toFixed(1)} s`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Trim · ${fileName(file.path)}`}
      icon={<Scissors width={16} className="muted" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!buffer || busy} onClick={() => void save()}>
            {busy ? <Loader2 className="spin" /> : <Scissors />} Save trimmed sound
          </button>
        </>
      }
    >
      {error ? (
        <div className="banner banner-err">This sound could not be decoded here, so it can’t be trimmed in the app.</div>
      ) : !buffer ? (
        <div className="empty" style={{ padding: 24 }}>
          <Loader2 className="spin" />
        </div>
      ) : (
        <div className="trim">
          <label className="trim-row">
            <span>Start at {clock(start)}</span>
            <input type="range" min={0} max={Math.max(0, duration - 0.2)} step={0.1} value={start} onChange={(e) => (stop(), setStart(Number(e.target.value)))} />
          </label>
          <label className="trim-row">
            <span>
              Length {len.toFixed(1)} s <span className="faint">of {clock(duration)}</span>
            </span>
            <input type="range" min={0.2} max={Math.max(0.2, duration)} step={0.1} value={len} onChange={(e) => (stop(), setLength(Number(e.target.value)))} />
          </label>
          <div className="row wrap">
            <button className="btn btn-sm" onClick={() => (playing ? stop() : play())}>
              {playing ? <Square /> : <Play />} {playing ? 'Stop' : 'Listen to the cut'}
            </button>
            {[5, 15, 30].filter((s) => s < duration).map((s) => (
              <button key={s} className="btn btn-ghost btn-sm" onClick={() => (stop(), setLength(s))}>
                {s} s
              </button>
            ))}
            <label className="check">
              <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} /> Fade out at the end
            </label>
          </div>
          <p className="faint" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
            Saved as uncompressed WAV audio under the same file name, about {formatBytes(outBytes)} (the file is now {formatBytes(file.size)}). Undo brings the original back.
          </p>
        </div>
      )}
    </Modal>
  );
}
