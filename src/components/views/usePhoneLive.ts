// Live data from the connected phone over ADB: its battery, clock, Weather app
// data and whether music is playing. Read every few seconds while `enabled` and
// a phone is ready; nothing is written to the phone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { PhoneLiveState } from '../../lib/types';
import { useStore } from '../../state/store';

const EVERY_MS = 15_000;

export interface PhoneLive {
  /** The ready phone's serial, or null when none is connected. */
  serial: string | null;
  name: string | null;
  data: PhoneLiveState | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function usePhoneLive(enabled: boolean): PhoneLive {
  const serial = useStore((s) => (s.selectedSerial && s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device') ? s.selectedSerial : null));
  const name = useStore((s) => {
    if (!serial) return null;
    const d = s.deviceDetails[serial];
    return d?.marketName ?? d?.model ?? s.adb?.devices.find((x) => x.serial === serial)?.model ?? serial;
  });
  const [state, setState] = useState<{ serial: string | null; data: PhoneLiveState | null; error: string | null; loading: boolean }>({ serial: null, data: null, error: null, loading: false });
  const busy = useRef(false);

  const read = useCallback(async (from: string) => {
    if (busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, serial: from, loading: true }));
    try {
      const data = await api.adbLiveState(from);
      setState({ serial: from, data, error: null, loading: false });
    } catch (e) {
      setState((s) => ({ serial: from, data: s.serial === from ? s.data : null, error: e instanceof Error ? e.message : String(e), loading: false }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !serial) return;
    void read(serial);
    const tick = window.setInterval(() => {
      if (!document.hidden) void read(serial);
    }, EVERY_MS);
    return () => window.clearInterval(tick);
  }, [enabled, serial, read]);

  const current = enabled && serial && state.serial === serial;
  return {
    serial: enabled ? serial : null,
    name,
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !!current && state.loading,
    refresh: () => serial && void read(serial),
  };
}
