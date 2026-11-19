// Blank phone or My theme: where the Guide draws widgets and Try it scripts.
// "My theme" lays them over the open theme's own lock screen (wallpaper, font,
// every piece) so they are seen exactly where they will live. Nothing is saved.
import { create } from 'zustand';
import { Palette, Smartphone } from 'lucide-react';

export type PhoneMode = 'blank' | 'theme';

const KEY = 'mts.guide.phoneMode.v1';

function load(): PhoneMode {
  try {
    return localStorage.getItem(KEY) === 'theme' ? 'theme' : 'blank';
  } catch {
    return 'blank';
  }
}

const usePhoneModeStore = create<{ mode: PhoneMode }>(() => ({ mode: load() }));

/** The chosen phone, shared by the Widgets gallery and Try it, remembered between sessions. */
export function usePhoneMode(): [PhoneMode, (m: PhoneMode) => void] {
  const mode = usePhoneModeStore((s) => s.mode);
  const set = (m: PhoneMode) => {
    usePhoneModeStore.setState({ mode: m });
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable */
    }
  };
  return [mode, set];
}

export function PhoneSwitch({ mode, onChange, hasTheme }: { mode: PhoneMode; onChange: (m: PhoneMode) => void; hasTheme: boolean }) {
  return (
    <div className="segmented phone-switch" role="group" aria-label="Preview on">
      <button aria-pressed={mode === 'blank'} onClick={() => onChange('blank')} title="Draw it alone on an empty screen">
        <Smartphone /> Blank
      </button>
      <button
        aria-pressed={mode === 'theme'}
        disabled={!hasTheme}
        onClick={() => onChange('theme')}
        title={hasTheme ? 'Draw it on your theme’s lock screen, wallpaper and all. Nothing is saved.' : 'Open a theme with a lock screen first'}
      >
        <Palette /> My theme
      </button>
    </div>
  );
}
