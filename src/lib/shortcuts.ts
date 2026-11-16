// Keyboard shortcut parsing/matching. Shortcut strings look like
// `Ctrl+Shift+S`, `F2`, `Delete`, `Ctrl+/`.

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+');
  let key = parts.pop() ?? '';
  // `Ctrl++` splits into a trailing empty part.
  if (key === '' && parts.length) {
    parts.pop();
    key = '+';
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt'), key: key.toLowerCase() };
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code?: string;
}

function eventKey(event: KeyLike): string {
  const key = event.key.toLowerCase();
  if (key === ' ') return 'space';
  if (key === 'del') return 'delete';
  // Shift+/ produces "?" on US layouts; match the physical key.
  if (event.code === 'Slash') return '/';
  // Match +/- by physical key so Shift and keyboard layout don't matter.
  if (event.code === 'Equal') return '=';
  if (event.code === 'Minus') return '-';
  if (event.code === 'NumpadAdd') return 'numpadadd';
  if (event.code === 'NumpadSubtract') return 'numpadsubtract';
  if (event.code?.startsWith('Digit')) return event.code.slice(5);
  return key;
}

export function matches(shortcut: string, event: KeyLike): boolean {
  const parsed = parseShortcut(shortcut);
  const ctrl = event.ctrlKey || event.metaKey;
  return (
    parsed.ctrl === ctrl && parsed.shift === event.shiftKey && parsed.alt === event.altKey && parsed.key === eventKey(event)
  );
}

/** True when the keyboard focus is in an element that handles text editing itself. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== 'function') return false;
  const element = target as HTMLElement;
  if (element.closest('.cm-editor')) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type);
  }
  return element.isContentEditable;
}
