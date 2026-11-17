// Does the open theme's format (uiVersion in description.xml) fit the connected
// phone's theme format (theme_compatibility.xml)? Asked again when the phone or
// the theme details change; shared by every place that shows the verdict.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ThemeCompatibility } from '../lib/types';
import { useStore } from './store';

const cache = new Map<string, ThemeCompatibility | null>();

export function useThemeCompatibility(): ThemeCompatibility | null {
  const serial = useStore((s) => (s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device') ? s.selectedSerial : null));
  const project = useStore((s) => s.project);
  const descRev = project?.files.find((f) => f.path === 'description.xml')?.rev ?? -1;
  const key = serial && project ? `${serial}:${project.sourcePath ?? project.title}:${descRev}` : null;
  const [value, setValue] = useState<ThemeCompatibility | null>(() => (key ? (cache.get(key) ?? null) : null));
  useEffect(() => {
    if (!key || !serial) {
      setValue(null);
      return;
    }
    if (cache.has(key)) {
      setValue(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    api
      .themeCompatibility(serial)
      .then((v) => {
        cache.set(key, v);
        if (!cancelled) setValue(v);
      })
      .catch(() => !cancelled && setValue(null));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return value;
}

const formats = new Map<string, number | null>();

/** The connected phone's theme format (140 = 14.0), or null with no phone or no answer. */
export function usePhoneThemeFormat(): { serial: string | null; format: number | null; label: string | null } {
  const serial = useStore((s) => (s.adb?.devices.some((d) => d.serial === s.selectedSerial && d.state === 'device') ? s.selectedSerial : null));
  const label = useStore((s) => {
    const d = s.adb?.devices.find((x) => x.serial === s.selectedSerial);
    return d?.model ?? d?.product ?? null;
  });
  const [format, setFormat] = useState<number | null>(() => (serial ? (formats.get(serial) ?? null) : null));
  useEffect(() => {
    if (!serial) return setFormat(null);
    if (formats.has(serial)) return setFormat(formats.get(serial) ?? null);
    let cancelled = false;
    api
      .adbThemeFormat(serial)
      .then((f) => {
        formats.set(serial, f);
        if (!cancelled) setFormat(f);
      })
      .catch(() => !cancelled && setFormat(null));
    return () => {
      cancelled = true;
    };
  }, [serial]);
  return { serial, format, label };
}

/** "14.0" from 140. */
export const formatVersion = (format: number | null) => (format === null ? '?' : (format / 10).toFixed(1));
