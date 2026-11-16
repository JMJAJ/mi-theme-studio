// In-app phone mirror: receives the scrcpy H.264 stream from the backend,
// decodes it with WebCodecs into a canvas, and sends touch/scroll/key input.
import { create } from 'zustand';
import { Channel, invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../lib/api';
import { getState, log, toast } from './store';

type Status = 'idle' | 'starting' | 'live' | 'error';

interface StreamState {
  status: Status;
  serial: string | null;
  width: number;
  height: number;
  error: string | null;
  fps: number;
}

export const useMirrorStream = create<StreamState>(() => ({ status: 'idle', serial: null, width: 0, height: 0, error: null, fps: 0 }));

const MSG_META = 1;
const MSG_PACKET = 2;
const MSG_END = 3;
const FLAG_CONFIG = 1;
const FLAG_KEY = 2;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let decoder: VideoDecoder | null = null;
let codec: string | null = null;
let pendingConfig: Uint8Array | null = null;
let needKey = true;
let lastFrame: VideoFrame | null = null;
let frames = 0;
let fpsTimer: number | undefined;
let generation = 0;

/** The canvas the mirror draws into (null when unmounted). */
export function attachCanvas(el: HTMLCanvasElement | null) {
  canvas = el;
  ctx = el?.getContext('2d') ?? null;
  if (el && lastFrame) draw(lastFrame);
}

function draw(frame: VideoFrame) {
  if (!canvas || !ctx) return;
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
}

function onFrame(frame: VideoFrame) {
  frames += 1;
  lastFrame?.close();
  lastFrame = frame;
  const s = useMirrorStream.getState();
  if (s.width !== frame.displayWidth || s.height !== frame.displayHeight) useMirrorStream.setState({ width: frame.displayWidth, height: frame.displayHeight });
  draw(frame);
}

/** `avc1.PPCCLL` from the SPS inside an Annex-B config packet. */
export function codecFromConfig(data: Uint8Array): string | null {
  for (let i = 0; i + 7 < data.length; i++) {
    const three = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (three && (data[i + 3] & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

function resetDecoder() {
  try {
    decoder?.close();
  } catch {
    /* already closed */
  }
  decoder = null;
  codec = null;
  needKey = true;
}

function ensureDecoder(nextCodec: string) {
  if (decoder && codec === nextCodec && decoder.state === 'configured') return;
  resetDecoder();
  decoder = new VideoDecoder({
    output: onFrame,
    error: (e) => {
      log('error', `Mirror decoder: ${e.message}`);
      resetDecoder();
    },
  });
  decoder.configure({ codec: nextCodec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  codec = nextCodec;
  needKey = true;
}

function onMessage(raw: ArrayBuffer | Uint8Array | number[], gen: number) {
  if (gen !== generation) return;
  const data = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  const type = data[0];
  if (type === MSG_META) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    useMirrorStream.setState({ width: view.getUint32(1), height: view.getUint32(5), status: 'live' });
    return;
  }
  if (type === MSG_END) {
    const reason = new TextDecoder().decode(data.subarray(1));
    if (useMirrorStream.getState().status !== 'idle') {
      log('info', `Mirror ended: ${reason}`);
      cleanup();
      useMirrorStream.setState({ status: 'idle' });
    }
    return;
  }
  if (type !== MSG_PACKET) return;
  const flags = data[1];
  const pts = Number(new DataView(data.buffer, data.byteOffset + 2, 8).getBigUint64(0));
  const payload = data.subarray(10);
  if (flags & FLAG_CONFIG) {
    pendingConfig = payload.slice();
    const next = codecFromConfig(pendingConfig);
    if (next) ensureDecoder(next);
    return;
  }
  if (!decoder || decoder.state !== 'configured') return;
  const key = (flags & FLAG_KEY) !== 0;
  if (needKey && !key) return;
  let chunkData = payload;
  if (pendingConfig && key) {
    chunkData = new Uint8Array(pendingConfig.length + payload.length);
    chunkData.set(pendingConfig, 0);
    chunkData.set(payload, pendingConfig.length);
    pendingConfig = null;
  }
  try {
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: chunkData }));
    needKey = false;
  } catch (e) {
    log('error', `Mirror decode: ${errorMessage(e)}`);
    needKey = true;
  }
}

function cleanup() {
  resetDecoder();
  pendingConfig = null;
  window.clearInterval(fpsTimer);
  fpsTimer = undefined;
}

export async function startStream(serial?: string) {
  const target = serial ?? getState().selectedSerial;
  if (!target) {
    toast('warning', 'Connect and authorize a phone first.');
    return false;
  }
  if (typeof VideoDecoder === 'undefined') {
    toast('error', 'This system’s web view cannot decode video. Use “Open in window” instead.');
    return false;
  }
  const gen = ++generation;
  cleanup();
  useMirrorStream.setState({ status: 'starting', serial: target, error: null });
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (m) => onMessage(m, gen);
  try {
    const info = await invoke<{ width: number; height: number }>('stream_start', { serial: target, maxSize: 1280, channel });
    if (gen !== generation) return false;
    useMirrorStream.setState({ status: 'live', width: info.width, height: info.height });
    frames = 0;
    fpsTimer = window.setInterval(() => {
      useMirrorStream.setState({ fps: frames });
      frames = 0;
    }, 1000);
    return true;
  } catch (e) {
    if (gen === generation) useMirrorStream.setState({ status: 'error', error: errorMessage(e) });
    return false;
  }
}

export async function stopStream() {
  generation++;
  cleanup();
  lastFrame?.close();
  lastFrame = null;
  useMirrorStream.setState({ status: 'idle', fps: 0 });
  await invoke('stream_stop').catch(() => undefined);
}

// ----- input ----------------------------------------------------------------

export function streamTouch(action: 0 | 1 | 2, x: number, y: number) {
  const { width, height, status } = useMirrorStream.getState();
  if (status !== 'live' || !width) return;
  void invoke('stream_touch', { action, x: Math.round(x), y: Math.round(y), width, height }).catch(() => undefined);
}

export function streamScroll(x: number, y: number, vscroll: number, hscroll = 0) {
  const { width, height, status } = useMirrorStream.getState();
  if (status !== 'live' || !width) return;
  void invoke('stream_scroll', { x: Math.round(x), y: Math.round(y), width, height, hscroll, vscroll }).catch(() => undefined);
}

export function streamKey(key: 'back' | 'home' | 'recents' | 'power' | 'volumeUp' | 'volumeDown') {
  if (useMirrorStream.getState().status !== 'live') return;
  void invoke('stream_key', { key }).catch((e) => toast('error', `Phone button: ${errorMessage(e)}`));
}

/** Test hook for the browser decode harness (scripts/ui-preview/decode.html). */
export function __feedForTest(message: Uint8Array) {
  if (useMirrorStream.getState().status === 'idle') useMirrorStream.setState({ status: 'live' });
  onMessage(message, generation);
}
