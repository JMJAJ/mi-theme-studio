// Start/stop the in-app phone mirror (shown in the phone panel).
import { MonitorPlay, Square } from 'lucide-react';
import { startStream, stopStream, useMirrorStream } from '../../state/mirrorStream';
import { updateLayout, useStore } from '../../state/store';

export function startInAppMirror() {
  updateLayout({ phone: true });
  void startStream();
}

export function MirrorButton({ className = 'btn', block = false }: { className?: string; block?: boolean }) {
  const status = useMirrorStream((s) => s.status);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const running = status === 'live' || status === 'starting';
  return (
    <button
      className={className}
      style={block ? { justifyContent: 'flex-start' } : undefined}
      disabled={!ready && !running}
      onClick={() => (running ? void stopStream() : startInAppMirror())}
      title={running ? 'Stop the live mirror' : 'Mirror the phone live in the phone panel; click and drag to use it'}
    >
      {running ? <Square /> : <MonitorPlay />} {running ? 'Stop mirroring' : 'Mirror screen'}
    </button>
  );
}
