// Which page of the in-app guide is open, so any part of the app can open it
// at a page and heading (the lock screen side panel links to it).
import { create } from 'zustand';
import type { LockBlock } from '../lib/mamlBlocks';
import { goTo } from './actions';
import { getState, toast } from './store';

const PAGE_KEY = 'mts.guide.page.v1';

function loadPage() {
  try {
    const v = localStorage.getItem(PAGE_KEY);
    if (v && /^[\w-]+$/.test(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'recipes';
}

export function rememberGuidePage(page: string) {
  try {
    localStorage.setItem(PAGE_KEY, page);
  } catch {
    /* storage unavailable */
  }
}

/** page: a docs/maml file name without .md, or "try" / "starter". */
export const useGuide = create<{ page: string; anchor: string | null; nonce: number; tryText: string | null }>(() => ({ page: loadPage(), anchor: null, nonce: 0, tryText: null }));

/** Open the guide at a page and optionally a heading anchor (GitHub-style, e.g. "date-and-time-patterns"). */
export function openGuide(page = 'recipes', anchor: string | null = null) {
  useGuide.setState((s) => ({ page, anchor, nonce: s.nonce + 1 }));
  goTo('guide');
}

/** Open Try it with a formula in its text box. */
export function tryFormula(code: string) {
  useGuide.setState((s) => ({ page: 'try', anchor: null, nonce: s.nonce + 1, tryText: code }));
  goTo('guide');
}

/** A widget from the recipe gallery waiting to be added when the lock screen editor opens. */
export const usePendingBlock = create<{ block: LockBlock | null; title: string }>(() => ({ block: null, title: '' }));

/** Open the lock screen editor and add this widget to the page being edited. */
export function addToLockScreen(block: LockBlock, title: string) {
  const project = getState().project;
  if (!project) {
    toast('warning', 'Open or create a theme first', 'The widget is added to the theme’s lock screen.');
    return;
  }
  const hasLayout = project.files.some((f) => f.component === 'lockscreen' && /(^|\/)manifest\.xml$/i.test(f.path));
  if (!hasLayout) {
    toast('warning', 'This theme has no lock screen layout yet', 'Use Swap on the Lock screen card to take one from another theme, then add widgets to it.');
    return;
  }
  usePendingBlock.setState({ block, title });
  goTo('design', 'lockscreen');
}
