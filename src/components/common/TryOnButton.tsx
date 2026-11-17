// "Try on phone": apply the open theme on the connected phone right away.
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import type { ThemeCompatibility } from '../../lib/types';

export function TryOnButton({ className = 'btn btn-sm btn-primary', compact = false }: { className?: string; compact?: boolean }) {
  const busy = useStore((s) => s.busy);
  const hasProject = useStore((s) => !!s.project);
  const serial = useStore((s) => s.selectedSerial);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const running = busy === A.TRY_ON_BUSY;
  const [compat, setCompat] = useState<ThemeCompatibility | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!hasProject || !ready) {
      setCompat(null);
      return;
    }
    void A.themeCompatibility().then((value) => {
      if (!cancelled) setCompat(value);
    });
    return () => {
      cancelled = true;
    };
  }, [hasProject, ready, serial]);

  if (!hasProject) return null;
  // A newer theme format is not blocked: the button dims and the action warns.
  const newer = compat !== null && !compat.supported;
  const title = !ready
    ? 'Connect a phone to try the theme on it'
    : newer
      ? `${compat.detail} The phone renders an older theme format, so newer parts may be refused. You can still apply it at your own risk.`
      : 'Apply this theme on the phone now (Ctrl+Shift+T)';
  return (
    <button
      className={className}
      disabled={!!busy}
      style={newer ? { opacity: 0.6 } : undefined}
      onClick={() => (ready ? void A.tryOnPhone() : A.goTo('phone'))}
      title={title}
    >
      {running ? <Loader2 className="spin" /> : newer ? <AlertTriangle /> : <Play />} {running ? 'Applying…' : compact ? 'Try on' : 'Try on phone'}
    </button>
  );
}
