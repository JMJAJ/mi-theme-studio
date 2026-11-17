// The editor's find & replace bar (Ctrl+F / Ctrl+H): match count ("3 of 12"),
// previous/next, match case, whole word and regex toggles, and a replace row.
// Built on @codemirror/search, styled like the rest of the app.
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, SearchQuery, setSearchQuery } from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  up: icon('<path d="m18 15-6-6-6 6"/>'),
  down: icon('<path d="m6 9 6 6 6-6"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
  replace: icon('<path d="m9 18 6-6-6-6"/>'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (html) node.innerHTML = html;
  return node;
}

/** How many matches, and which one the selection is on (counting stops at 9999). */
function countMatches(view: EditorView, query: SearchQuery) {
  if (!query.valid || !query.search) return { total: 0, current: 0 };
  const sel = view.state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= 9999) break;
  }
  return { total, current };
}

function createFindPanel(view: EditorView): Panel {
  const dom = el('div', { class: 'cm-find' });
  const toggleReplace = el('button', { class: 'cm-find-btn cm-find-expand', title: 'Show replace (Ctrl+H)', 'aria-label': 'Toggle replace', type: 'button' }, ICONS.replace);
  const findInput = el('input', { class: 'cm-find-input', placeholder: 'Find', 'aria-label': 'Find', 'main-field': 'true', spellcheck: 'false' });
  const count = el('span', { class: 'cm-find-count' });
  const caseBtn = el('button', { class: 'cm-find-opt', title: 'Match case', type: 'button' }, 'Aa');
  const wordBtn = el('button', { class: 'cm-find-opt', title: 'Whole word', type: 'button' }, '<u>ab</u>');
  const regexBtn = el('button', { class: 'cm-find-opt', title: 'Regular expression', type: 'button' }, '.*');
  const prev = el('button', { class: 'cm-find-btn', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', type: 'button' }, ICONS.up);
  const next = el('button', { class: 'cm-find-btn', title: 'Next match (Enter)', 'aria-label': 'Next match', type: 'button' }, ICONS.down);
  const close = el('button', { class: 'cm-find-btn', title: 'Close (Esc)', 'aria-label': 'Close find', type: 'button' }, ICONS.close);
  const replaceInput = el('input', { class: 'cm-find-input', placeholder: 'Replace', 'aria-label': 'Replace', spellcheck: 'false' });
  const replaceOne = el('button', { class: 'cm-find-text', type: 'button', title: 'Replace this match (Enter)' }, 'Replace');
  const replaceEvery = el('button', { class: 'cm-find-text', type: 'button', title: 'Replace every match' }, 'Replace all');

  const rowFind = el('div', { class: 'cm-find-row' });
  const field = el('div', { class: 'cm-find-field' });
  field.append(findInput, caseBtn, wordBtn, regexBtn);
  rowFind.append(toggleReplace, field, count, prev, next, close);
  const rowReplace = el('div', { class: 'cm-find-row cm-find-replace' });
  const rfield = el('div', { class: 'cm-find-field' });
  rfield.append(replaceInput);
  rowReplace.append(el('span', { class: 'cm-find-spacer' }), rfield, replaceOne, replaceEvery);
  dom.append(rowFind, rowReplace);

  const readOnly = view.state.readOnly;
  let showReplace = false;
  const opts = { caseSensitive: false, wholeWord: false, regexp: false };

  const sync = () => {
    const q = getSearchQuery(view.state);
    if (findInput.value !== q.search && document.activeElement !== findInput) findInput.value = q.search;
    if (replaceInput.value !== q.replace && document.activeElement !== replaceInput) replaceInput.value = q.replace;
    opts.caseSensitive = q.caseSensitive;
    opts.wholeWord = q.wholeWord;
    opts.regexp = q.regexp;
    caseBtn.setAttribute('aria-pressed', String(q.caseSensitive));
    wordBtn.setAttribute('aria-pressed', String(q.wholeWord));
    regexBtn.setAttribute('aria-pressed', String(q.regexp));
    const { total, current } = countMatches(view, q);
    count.textContent = !q.search ? '' : !q.valid ? 'Bad pattern' : total === 0 ? 'No results' : `${current || '–'} of ${total >= 9999 ? '9999+' : total}`;
    count.classList.toggle('is-none', !!q.search && total === 0);
    rowReplace.hidden = !showReplace || readOnly;
    toggleReplace.hidden = readOnly;
    toggleReplace.setAttribute('aria-pressed', String(showReplace));
  };
  const commit = () => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: findInput.value, replace: replaceInput.value, ...opts })) });
  };

  findInput.addEventListener('input', () => {
    commit();
    // Jump to the first match from where you are, like a browser.
    if (findInput.value) findNext(view);
  });
  replaceInput.addEventListener('input', commit);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceNext(view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  const flip = (key: keyof typeof opts, btn: HTMLElement) =>
    btn.addEventListener('click', () => {
      opts[key] = !opts[key];
      commit();
      findInput.focus();
    });
  flip('caseSensitive', caseBtn);
  flip('wholeWord', wordBtn);
  flip('regexp', regexBtn);
  prev.addEventListener('click', () => findPrevious(view));
  next.addEventListener('click', () => findNext(view));
  close.addEventListener('click', () => {
    closeSearchPanel(view);
    view.focus();
  });
  toggleReplace.addEventListener('click', () => {
    showReplace = !showReplace;
    sync();
    (showReplace ? replaceInput : findInput).focus();
  });
  replaceOne.addEventListener('click', () => replaceNext(view));
  replaceEvery.addEventListener('click', () => replaceAll(view));

  // Ctrl+H opens with the replace row showing.
  dom.addEventListener('cm-find-replace', () => {
    showReplace = true;
    sync();
  });

  return {
    dom,
    top: true,
    mount() {
      sync();
      findInput.focus();
      findInput.select();
    },
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) sync();
    },
  };
}

/** The search extension with this panel; keep the selection's word as the starting query. */
export const findExtension = search({ top: true, createPanel: createFindPanel });

/** Open the find bar with the replace row shown. */
export function showReplace(view: EditorView) {
  view.dom.querySelector('.cm-find')?.dispatchEvent(new Event('cm-find-replace'));
}
