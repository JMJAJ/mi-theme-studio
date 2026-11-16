import { useStore } from '../../state/store';

export interface DeviceSummary {
  label: string;
  title: string;
  tone: 'ok' | 'warn' | 'err' | 'info' | 'faint';
  ready: boolean;
}

/** Truthful one-line device state derived from the last native ADB check. */
export function useDeviceSummary(): DeviceSummary {
  const adb = useStore((s) => s.adb);
  const serial = useStore((s) => s.selectedSerial);
  const details = useStore((s) => (s.selectedSerial ? s.deviceDetails[s.selectedSerial] : undefined));
  if (!adb) return { label: 'Checking ADB…', title: 'Looking for adb', tone: 'faint', ready: false };
  if (!adb.location) return { label: 'ADB not found', title: 'Install Android platform-tools or set the adb.exe location', tone: 'faint', ready: false };
  if (adb.error && !adb.devices.length) return { label: 'ADB error', title: adb.error.message, tone: 'err', ready: false };
  const device = adb.devices.find((d) => d.serial === serial);
  if (!device) return { label: 'No device', title: 'No device connected over ADB', tone: 'faint', ready: false };
  const name = details?.marketName ?? details?.model ?? device.model ?? device.serial;
  const extra = adb.devices.length > 1 ? ` (+${adb.devices.length - 1})` : '';
  switch (device.state) {
    case 'device':
      return { label: `${name}${extra}`, title: `${name} connected via ADB`, tone: 'ok', ready: true };
    case 'unauthorized':
      return { label: `Unauthorized${extra}`, title: 'Accept the USB debugging prompt on the phone', tone: 'warn', ready: false };
    case 'offline':
      return { label: `Offline${extra}`, title: 'The device is offline; reconnect it or restart the ADB server', tone: 'err', ready: false };
    default:
      return { label: `${device.state}${extra}`, title: `Device state: ${device.state}`, tone: 'warn', ready: false };
  }
}
