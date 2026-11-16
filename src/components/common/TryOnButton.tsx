// "Try on phone": apply the open theme on the connected phone right away.
import { Loader2, Play } from 'lucide-react';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';

export function TryOnButton({ className = 'btn btn-sm btn-primary', compact = false }: { className?: string; compact?: boolean }) {
  const busy = useStore((s) => s.busy);
  const project = useStore((s) => !!s.project);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const running = busy === A.TRY_ON_BUSY;
  if (!project) return null;
  return (
    <button
      className={className}
      disabled={!!busy}
      onClick={() => (ready ? void A.tryOnPhone() : A.goTo('phone'))}
      title={ready ? 'Apply this theme on the phone now (Ctrl+Shift+T)' : 'Connect a phone to try the theme on it'}
    >
      {running ? <Loader2 className="spin" /> : <Play />} {running ? 'Applying…' : compact ? 'Try on' : 'Try on phone'}
    </button>
  );
}
