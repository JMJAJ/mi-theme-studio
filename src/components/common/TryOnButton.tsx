// "Try on phone": apply the open theme on the connected phone right away.
import { AlertTriangle, Loader2, Play } from 'lucide-react';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { formatVersion, useThemeCompatibility } from '../../state/compat';

export function TryOnButton({ className = 'btn btn-sm btn-primary', compact = false }: { className?: string; compact?: boolean }) {
  const busy = useStore((s) => s.busy);
  const hasProject = useStore((s) => !!s.project);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const running = busy === A.TRY_ON_BUSY;
  const compat = useThemeCompatibility();

  if (!hasProject) return null;
  // A newer theme format is not blocked: the button dims and the action warns.
  const newer = compat !== null && !compat.supported;
  const title = !ready
    ? 'Connect a phone to try the theme on it'
    : newer
      ? `Made for a newer system than this phone (theme ${compat.themeUiVersion ?? '?'} vs phone ${formatVersion(compat.deviceFormat)}). Newer parts may be refused or look wrong. You can still apply it at your own risk.`
      : 'Apply this theme on the phone now (Ctrl+Shift+T)';
  return (
    <button
      className={`${className} ${newer ? 'is-risky' : ''}`}
      disabled={!!busy}
      onClick={() => (ready ? void A.tryOnPhone() : A.goTo('phone'))}
      title={title}
    >
      {running ? <Loader2 className="spin" /> : newer ? <AlertTriangle /> : <Play />} {running ? 'Applying…' : compact ? 'Try on' : 'Try on phone'}
    </button>
  );
}
