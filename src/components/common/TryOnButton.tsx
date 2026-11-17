// "Try on phone": apply the open theme on the connected phone right away.
import { useEffect, useState } from 'react';
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
  const serial = useStore((s) => s.selectedSerial);
  const [rooted, setRooted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!ready || !serial) return setRooted(false);
    void A.phoneIsRooted(serial).then((r) => !cancelled && setRooted(r));
    return () => {
      cancelled = true;
    };
  }, [ready, serial]);

  if (!hasProject) return null;
  // A newer theme format is not blocked: the button dims and the action warns.
  const newer = compat !== null && !compat.supported;
  const title = !ready
    ? 'Connect a phone to try the theme on it'
    : newer
      ? `Made for a newer system than this phone (theme ${compat.themeUiVersion ?? '?'} vs phone ${formatVersion(compat.deviceFormat)}). Newer parts may be refused or look wrong. You can still apply it at your own risk.`
      : rooted
        ? 'Rooted phone: writes every part of the theme straight into the theme folder (no Xiaomi licence needed), with a backup first (Ctrl+Shift+T)'
        : 'Apply this theme on the phone now (Ctrl+Shift+T)';
  return (
    <button
      className={`${className} ${newer ? 'is-risky' : ''}`}
      disabled={!!busy}
      onClick={() => (ready ? void A.tryOnPhone() : A.goTo('phone'))}
      title={title}
    >
      {running ? <Loader2 className="spin" /> : newer ? <AlertTriangle /> : <Play />} {running ? 'Applying…' : compact ? 'Try on' : rooted ? 'Try on phone (root)' : 'Try on phone'}
    </button>
  );
}
