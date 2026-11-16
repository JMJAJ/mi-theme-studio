// Start/stop the live scrcpy mirror window for the selected phone.
import { useEffect } from 'react';
import { MonitorPlay, Square } from 'lucide-react';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';

export function MirrorButton({ className = 'btn', block = false }: { className?: string; block?: boolean }) {
  const mirror = useStore((s) => s.mirror);
  const serial = useStore((s) => s.selectedSerial);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));

  useEffect(() => {
    void A.refreshMirror();
    // scrcpy can be closed from its own window; poll while it runs.
    const timer = window.setInterval(() => {
      if (A.mirrorRunning()) void A.refreshMirror();
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  if (mirror && !mirror.available) return null;
  const running = !!mirror?.running && mirror.serial === serial;
  return (
    <button
      className={className}
      style={block ? { justifyContent: 'flex-start' } : undefined}
      disabled={!ready && !running}
      onClick={() => void (running ? A.stopMirror() : A.startMirror())}
      title={running ? 'Close the mirror window' : 'Open a live, interactive mirror of the phone screen (scrcpy)'}
    >
      {running ? <Square /> : <MonitorPlay />} {running ? 'Stop mirroring' : 'Mirror screen'}
    </button>
  );
}
