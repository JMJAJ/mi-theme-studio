// "Try on phone": apply the open theme on the connected phone right away.
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Lock, Play } from 'lucide-react';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { formatVersion, useThemeCompatibility } from '../../state/compat';

export function TryOnButton({
  className = 'btn btn-sm btn-primary',
  compact = false,
  permanentToggle = !compact,
}: {
  className?: string;
  compact?: boolean;
  /** Show the “Permanent apply (AOD)” checkbox next to the button. */
  permanentToggle?: boolean;
}) {
  const busy = useStore((s) => s.busy);
  const hasProject = useStore((s) => !!s.project);
  const ready = useStore((s) => !!s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device'));
  const running = busy === A.TRY_ON_BUSY;
  const compat = useThemeCompatibility();
  const serial = useStore((s) => s.selectedSerial);
  const [rooted, setRooted] = useState(false);
  const permanentOn = useStore((s) => s.permanentApply);
  useEffect(() => {
    let cancelled = false;
    if (!ready || !serial) return setRooted(false);
    void A.phoneIsRooted(serial).then((r) => !cancelled && setRooted(r));
    return () => {
      cancelled = true;
    };
  }, [ready, serial]);

  if (!hasProject) return null;
  const permanent = permanentOn && ready && !rooted;
  // A newer theme format is not blocked: the button dims and the action warns.
  const newer = compat !== null && !compat.supported;
  const title = !ready
    ? 'Connect a phone to try the theme on it'
    : newer
      ? `Made for a newer system than this phone (theme ${compat.themeUiVersion ?? '?'} vs phone ${formatVersion(compat.deviceFormat)}). Newer parts may be refused or look wrong. You can still apply it at your own risk.`
      : rooted
        ? 'Rooted phone: writes every part of the theme straight into the theme folder (no Xiaomi licence needed), with a backup first (Ctrl+Shift+T)'
        : 'Apply this theme on the phone now (Ctrl+Shift+T)';
  const button = (
    <button
      className={`${className} ${newer ? 'is-risky' : ''}`}
      disabled={!!busy}
      onClick={() => (ready ? void A.tryOnOrPermanent() : A.goTo('phone'))}
      title={permanent ? 'Permanent apply (AOD): writes the theme and the sticky AOD licence-check blocker (Ctrl+Shift+T)' : title}
    >
      {running ? <Loader2 className="spin" /> : newer ? <AlertTriangle /> : permanent ? <Lock /> : <Play />}{' '}
      {running ? 'Applying…' : compact ? 'Try on' : rooted ? 'Try on phone (root)' : permanent ? 'Apply permanently' : 'Try on phone'}
    </button>
  );
  if (!permanentToggle || !ready || rooted) return button;
  return (
    <span className="tryon-group">
      {button}
      <label className={`tryon-perm ${permanent ? 'is-on' : ''}`} title="Permanent apply (AOD): no root, keeps the theme past the 2-hour licence check. Asks for confirmation when ticked.">
        <input type="checkbox" checked={permanent} disabled={!!busy} onChange={(e) => void A.setPermanentApply(e.target.checked)} />
        <Lock /> Permanent (AOD)
      </label>
    </span>
  );
}
