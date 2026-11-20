import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { fileLinks, xmlAssist } from './mamlCodeAssist';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import { findExtension, showReplace } from './findPanel';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { AlertTriangle, Check, Download, FileQuestion, Maximize, Minus, Plus, RefreshCw, RotateCcw, Scan, Scissors, Search, Sparkles } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { NinePatchEditor } from './NinePatchEditor';
import { dimensions, formatBytes } from '../../lib/format';
import { displayFolder, fileName, parentOf } from '../../lib/paths';
import type { FileInfo, Slot } from '../../lib/types';
import { toast, useStore } from '../../state/store';
import * as A from '../../state/actions';
import { openSoundTrim } from './SoundTrim';
import { openContextMenu } from '../common/Menu';
import { CodePrompt, type CodeReference } from '../assistant/CodePrompt';

// ---------------------------------------------------------------- image

function ImageViewer({ file, slot }: { file: FileInfo; slot: Slot }) {
  const [mode, setMode] = useState<'image' | 'ninepatch'>(file.ninePatch ? 'ninepatch' : 'image');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [bg, setBg] = useState<'checker' | 'bg-dark' | 'bg-light'>('checker');
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth - 48, h: el.clientHeight - 48 }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const w = file.width ?? 0;
  const h = file.height ?? 0;
  const fitScale = w && h ? Math.min(box.w / w, box.h / h, 8) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const setScale = (next: number) => setZoom(Math.min(32, Math.max(0.05, Number(next.toFixed(3)))));

  return (
    <div className="center-body">
      <div className="toolbar">
        {file.ninePatch && (
          <>
            <div className="segmented" role="group" aria-label="View mode">
              <button aria-pressed={mode === 'image'} onClick={() => setMode('image')}>
                Image
              </button>
              <button aria-pressed={mode === 'ninepatch'} onClick={() => setMode('ninepatch')}>
                Nine-patch
              </button>
            </div>
            <span className="sep" />
          </>
        )}
        {mode === 'image' && (
        <>
        <div className="segmented" role="group" aria-label="Zoom">
          <button onClick={() => setScale(scale / 1.25)} title="Zoom out" aria-label="Zoom out">
            <Minus />
          </button>
          <button aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')} title="Fit to window">
            <Maximize /> Fit
          </button>
          <button aria-pressed={zoom === 1} onClick={() => setZoom(1)} title="Actual pixels">
            <Scan /> 100%
          </button>
          <button onClick={() => setScale(scale * 1.25)} title="Zoom in" aria-label="Zoom in">
            <Plus />
          </button>
        </div>
        <span className="label nowrap">{Math.round(scale * 100)}%</span>
        <select className="select" value={bg} onChange={(e) => setBg(e.target.value as typeof bg)} aria-label="Background">
          <option value="checker">Checkerboard</option>
          <option value="bg-dark">Black</option>
          <option value="bg-light">Light</option>
        </select>
        <span className="sep" />
        </>
        )}
        <span className="muted nowrap">
          {[file.format, dimensions(file.width, file.height), formatBytes(file.size), file.density].filter(Boolean).join(' · ')}
        </span>
        {file.ninePatch && <span className="badge badge-info" title="Android nine-patch: stretch and padding areas">9-patch</span>}
        <span className="grow" />
        {slot === 'main' && (
          <button className="btn btn-sm" onClick={() => void A.replaceFile(file.path)}>
            <RefreshCw /> Replace…
          </button>
        )}
        <button className="btn btn-sm" onClick={() => void A.extractFile(file.path, slot)}>
          <Download /> Export…
        </button>
      </div>
      {mode === 'ninepatch' ? (
        <NinePatchEditor file={file} slot={slot} />
      ) : (
      <div
        ref={stage}
        className={`image-stage ${bg} ${panning ? 'is-panning' : ''}`}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setScale(e.deltaY < 0 ? scale * 1.15 : scale / 1.15);
        }}
        onPointerDown={(e) => {
          const el = stage.current!;
          pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
          setPanning(true);
        }}
        onPointerMove={(e) => {
          if (!pan.current) return;
          const el = stage.current!;
          el.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
          el.scrollTop = pan.current.top - (e.clientY - pan.current.y);
        }}
        onPointerUp={() => {
          pan.current = null;
          setPanning(false);
        }}
        onPointerLeave={() => {
          pan.current = null;
          setPanning(false);
        }}
      >
        <img
          src={resourceUrl(slot, file.path, file.rev)}
          alt={file.path}
          draggable={false}
          className={scale >= 3 ? 'pixelated' : ''}
          style={w && h ? { width: w * scale, height: h * scale } : undefined}
        />
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- text

const editorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg-1)', color: 'var(--text)', height: '100%', fontSize: '13.5px' },
    '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-1)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: 'var(--text-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(240,136,62,0.25) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
    '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(214,160,61,0.3)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(255,255,255,0.08)', outline: '1px solid var(--line-strong)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--line-strong)', borderRadius: '8px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul': { maxHeight: '18em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: '12.5px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
    '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '10px', fontFamily: 'var(--font)', fontSize: '12px' },
    '.cm-completionInfo': { fontFamily: 'var(--font)', fontSize: '12px', padding: '6px 9px', maxWidth: '300px' },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--err, #f87171)', textUnderlineOffset: '3px' },
    '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn, #d6a03d)', textUnderlineOffset: '3px' },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic-error': { borderLeft: '3px solid var(--err, #f87171)' },
    '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn, #d6a03d)' },
  },
  { dark: true },
);

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.tagName, color: '#e8a36a' },
    { tag: tags.attributeName, color: '#9cc6ef' },
    { tag: tags.attributeValue, color: '#a8d4a0' },
    { tag: tags.string, color: '#a8d4a0' },
    { tag: tags.comment, color: '#6b6e76', fontStyle: 'italic' },
    { tag: tags.angleBracket, color: '#8c8f97' },
    { tag: tags.processingInstruction, color: '#c3a6e8' },
    { tag: tags.content, color: '#e5e6e9' },
  ]),
);

// The line a search hit or a problem pointed at flashes for a few seconds (or until you edit).
const REVEAL_MS = 3000;
const setRevealLine = StateEffect.define<number | null>();
const revealLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) deco = Decoration.none;
    for (const e of tr.effects) if (e.is(setRevealLine)) deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-revealLine' }).range(e.value)]);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// A stable object: a new one on every render makes the editor reconfigure, which closes the find bar.
const BASIC_SETUP = { foldGutter: true, highlightActiveLine: true, autocompletion: true, closeBrackets: true, bracketMatching: true, highlightSelectionMatches: true } as const;

function xmlError(text: string): string | null {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const error = doc.querySelector('parsererror');
  if (!error) return null;
  return (error.textContent ?? 'XML syntax error').split('\n').filter(Boolean).slice(0, 2).join(' ');
}

/** Attributes that never name a file, so a value that happens to match one is not a link. */
const NOT_FILE = /^(name|x|y|w|h|width|height|align|alignV|alpha|visibility|expression|format|formatExp|textExp|text|color|fillColor|strokeColor|target|value|condition|srcExp)$/;

/**
 * The file an attribute value in an XML file points at, if it exists: relative to
 * the XML file's folder, case-insensitively. A digit picture (Time / ImageNumber
 * src="time.png") opens its first digit, time_0.png.
 */
function linkedFile(from: string, slot: Slot, value: string, attr: string): string | null {
  const v = value.trim().replace(/^\.?\/+/, '');
  if (!v || NOT_FILE.test(attr) || !/\.[a-z0-9]{2,5}$/i.test(v) || /[#@()\s]/.test(v)) return null;
  const s = useStore.getState();
  const files = slot === 'ref' ? (s.reference?.files ?? []).map((f) => f.path) : [...s.fileIndex.keys()];
  const dir = from.replace(/[^/]*$/, '');
  const wanted = [v, v.replace(/(\.[a-z0-9]+)$/i, '_0$1')].flatMap((rel) => [`${dir}${rel}`.toLowerCase(), rel.toLowerCase()]);
  for (const want of wanted) {
    const hit = files.find((p) => p.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

function openLinked(path: string, slot: Slot) {
  A.openFile(path, slot);
  if (slot === 'main') A.revealInExplorer(path);
}

function TextEditor({ file, slot }: { file: FileInfo; slot: Slot }) {
  const draft = useStore((s) => (slot === 'main' ? s.drafts[file.path] : undefined));
  const [loaded, setLoaded] = useState<{ text: string; rev: number; lossy: boolean; bom: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(draft?.text ?? '');
  const isXml = file.kind === 'xml';
  // A lock screen / widget layout gets the MAML autocomplete, hover help and formula checks.
  const isMaml = isXml && (/(^|\/)manifest\.xml$/i.test(file.path) || /<(Lockscreen|Widget|Clock)[\s>]/.test((draft?.text ?? loaded?.text ?? '').slice(0, 4000)));
  const readOnly = slot === 'ref';
  const view = useRef<EditorView | null>(null);
  const [editor, setEditor] = useState<EditorView | null>(null);
  const [aiReference, setAiReference] = useState<CodeReference | null>(null);
  const reveal = useStore((s) => (slot === 'main' && s.reveal?.path === file.path ? s.reveal : null));

  useEffect(() => {
    if (draft && loaded) return; // keep editing the draft
    let cancelled = false;
    api
      .fileText(file.path, slot)
      .then((result) => {
        if (cancelled) return;
        setLoaded({ text: result.text, rev: result.rev, lossy: result.lossy, bom: result.bom });
        if (!draft) setText(result.text);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.rev, slot]);

  // Select a search match / problem once the text is loaded AND the editor exists.
  // CodeMirror creates its view a render after the text arrives, so wait for it,
  // and handle each reveal once so a later reload does not jump back.
  const handledReveal = useRef(0);
  const revealTimers = useRef<{ frame: number; timer: number } | null>(null);
  useEffect(
    () => () => {
      if (revealTimers.current) {
        window.cancelAnimationFrame(revealTimers.current.frame);
        window.clearTimeout(revealTimers.current.timer);
      }
    },
    [],
  );
  useEffect(() => {
    const v = editor;
    if (!reveal || !v || !loaded || handledReveal.current === reveal.nonce) return;
    const doc = v.state.doc;
    if (doc.length === 0 && loaded.text.length > 0) return; // value not applied yet
    handledReveal.current = reveal.nonce;
    if (reveal.line < 1 || reveal.line > doc.lines) return;
    const line = doc.line(reveal.line);
    // Columns are in characters; CodeMirror positions are UTF-16 units.
    const prefix = [...line.text].slice(0, reveal.column - 1).join('');
    const hit = [...line.text.slice(prefix.length)].slice(0, reveal.length).join('');
    const from = line.from + prefix.length;
    // Clear first and re-add next frame, so revealing the same line again restarts the flash.
    v.dispatch({ selection: { anchor: from, head: Math.min(from + hit.length, doc.length) }, effects: [EditorView.scrollIntoView(from, { y: 'center' }), setRevealLine.of(null)] });
    v.focus();
    if (revealTimers.current) {
      window.cancelAnimationFrame(revealTimers.current.frame);
      window.clearTimeout(revealTimers.current.timer);
    }
    revealTimers.current = {
      frame: window.requestAnimationFrame(() => {
        // Re-scroll too: layout can settle after the first frame on a freshly opened file.
        v.dispatch({ effects: [setRevealLine.of(line.from), EditorView.scrollIntoView(from, { y: 'center' })] });
      }),
      timer: window.setTimeout(() => v.dispatch({ effects: setRevealLine.of(null) }), REVEAL_MS),
    };
  }, [reveal?.nonce, loaded, editor, text]);

  const [syntax, setSyntax] = useState<string | null>(null);
  useEffect(() => {
    if (!isXml) return;
    const timer = window.setTimeout(() => setSyntax(xmlError(text)), 250);
    return () => window.clearTimeout(timer);
  }, [text, isXml]);

  const extensions = useMemo(
    () => [
      ...(isXml ? xmlAssist(isMaml, !readOnly) : []),
      ...(isXml ? [fileLinks((value, attr) => linkedFile(file.path, slot, value, attr), (path) => openLinked(path, slot))] : []),
      editorTheme,
      highlight,
      EditorView.lineWrapping,
      findExtension,
      revealLineField,
      EditorView.domEventHandlers({
        contextmenu(event, v) {
          event.preventDefault();
          event.stopPropagation();
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
          const selection = v.state.selection.main;
          const useSelection = !selection.empty && pos !== null && pos >= selection.from && pos <= selection.to;
          const range = useSelection ? selection : v.state.doc.lineAt(pos ?? selection.head);
          const from = useSelection ? selection.from : range.from;
          const to = useSelection ? selection.to : range.to;
          const startLine = v.state.doc.lineAt(from).number;
          const endLine = v.state.doc.lineAt(to > from ? to - 1 : to).number;
          const selectedText = v.state.sliceDoc(from, to);
          if (!useSelection && pos !== null) v.dispatch({ selection: { anchor: pos } });
          const reference: CodeReference = {
            path: file.path,
            startLine,
            endLine,
            code: selectedText,
            language: file.path.split('.').pop() || file.kind,
            readOnly,
          };
          const hasSelection = useSelection && from !== to;
          const clip = async (value: string) => {
            try {
              await navigator.clipboard.writeText(value);
              return true;
            } catch {
              toast('error', 'Could not access the clipboard.');
              return false;
            }
          };

          openContextMenu(event, [
            {
              label: hasSelection ? 'Ask AI about selection' : `Ask AI about line ${startLine}`,
              icon: Sparkles,
              onSelect: () => setAiReference(reference),
            },
            'separator',
            {
              label: 'Cut',
              shortcut: 'Ctrl+X',
              icon: Scissors,
              disabled: readOnly || !hasSelection,
              onSelect: () => {
                void clip(selectedText).then((copied) => {
                  if (copied && !readOnly && hasSelection) {
                    v.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
                    v.focus();
                  }
                });
              },
            },
            {
              label: 'Copy',
              shortcut: 'Ctrl+C',
              disabled: !hasSelection,
              onSelect: () => void clip(selectedText),
            },
            {
              label: 'Paste',
              shortcut: 'Ctrl+V',
              disabled: readOnly,
              onSelect: () => {
                void (async () => {
                  try {
                    const value = await navigator.clipboard.readText();
                    const current = v.state.selection.main;
                    v.dispatch({ changes: { from: current.from, to: current.to, insert: value }, selection: { anchor: current.from + value.length } });
                    v.focus();
                  } catch {
                    toast('error', 'Could not access the clipboard.');
                  }
                })();
              },
            },
            'separator',
            {
              label: 'Select all',
              shortcut: 'Ctrl+A',
              onSelect: () => {
                v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
                v.focus();
              },
            },
          ]);
          return true;
        },
      }),
      keymap.of([
        {
          key: 'Mod-h',
          run: (v) => {
            openSearchPanel(v);
            showReplace(v);
            return true;
          },
        },
        {
          key: 'Mod-Enter',
          run: () => {
            void A.applyDraft(file.path);
            return true;
          },
        },
      ]),
    ],
    [isXml, isMaml, readOnly, file.path, file.kind, slot],
  );

  // A stable change handler: the editor component reconfigures itself whenever
  // this function changes, and that reset the find bar after every keystroke.
  const latest = useRef({ draft, loaded, readOnly, path: file.path });
  latest.current = { draft, loaded, readOnly, path: file.path };
  const onChange = useCallback((value: string) => {
    setText(value);
    const { draft: d, loaded: l, readOnly: ro, path } = latest.current;
    if (!ro && l) A.setDraft(path, value, d?.baseRev ?? l.rev, d?.original ?? l.text);
  }, []);

  if (error) {
    return (
      <div className="empty">
        <AlertTriangle />
        <h3>Cannot open as text</h3>
        <p>{error}</p>
      </div>
    );
  }
  if (!loaded) return <div className="empty">Loading…</div>;

  const stale = !!draft && draft.baseRev !== file.rev;
  const dirty = !!draft;

  return (
    <div className="center-body">
      <div className="toolbar">
        <span className="mono muted ellipsis" title={file.path}>
          {displayFolder(parentOf(file.path))}
        </span>
        <span className="sep" />
        {isXml &&
          (syntax ? (
            <span className="badge badge-err" title={syntax}>
              <AlertTriangle /> XML error
            </span>
          ) : (
            <span className="badge badge-ok">
              <Check /> Well-formed
            </span>
          ))}
        {loaded.lossy && <span className="badge badge-warn" title="The file is not valid UTF-8; invalid bytes are shown as �. Saving will write UTF-8.">Not UTF-8</span>}
        {loaded.bom && <span className="badge badge-outline">UTF-8 BOM</span>}
        {readOnly && <span className="badge badge-info">Read-only reference</span>}
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" title="Find (Ctrl+F) · Replace (Ctrl+H)" onClick={() => view.current && openSearchPanel(view.current)}>
          <Search /> Find
        </button>
        {dirty && <span className="muted">Unapplied edits</span>}
        {!readOnly && (
          <>
            <button className="btn btn-sm" disabled={!dirty} onClick={() => { A.discardDraft(file.path); setText(loaded.text); }}>
              <RotateCcw /> Revert
            </button>
            <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => void A.applyDraft(file.path)} title="Apply edits to the package (Ctrl+Enter). Ctrl+S applies and saves.">
              <Check /> Apply
            </button>
          </>
        )}
      </div>
      {isXml && syntax && <div className="banner banner-err" style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--line)' }}><AlertTriangle /> <span className="mono">{syntax}</span></div>}
      {stale && (
        <div className="banner banner-warn" style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--line)' }}>
          <AlertTriangle />
          <span className="grow">The package version of this file changed (undo, redo or replace) after you started editing.</span>
          <div className="actions">
            <button className="btn btn-sm" onClick={() => { A.discardDraft(file.path); setText(loaded.text); }}>
              Load package version
            </button>
          </div>
        </div>
      )}
      <div className="editor-host">
        <CodeMirror
          value={text}
          height="100%"
          theme="none"
          readOnly={readOnly}
          extensions={extensions}
          onCreateEditor={(v) => {
            view.current = v;
            setEditor(v);
          }}
          basicSetup={BASIC_SETUP}
          onChange={onChange}
        />
      </div>
      {aiReference && <CodePrompt reference={aiReference} onClose={() => setAiReference(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- font / audio / other

function FontPreview({ file, slot }: { file: FileInfo; slot: Slot }) {
  const family = `mts-font-${file.rev}`;
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog 0123456789');
  useEffect(() => {
    const face = new FontFace(family, `url("${resourceUrl(slot, file.path, file.rev)}&font")`);
    face
      .load()
      .then((loadedFace) => {
        document.fonts.add(loadedFace);
        setState('ok');
      })
      .catch(() => setState('error'));
    return () => {
      document.fonts.delete(face);
    };
  }, [family, file.path, file.rev, slot]);
  return (
    <div className="view">
      <div className="view-pad">
        <div className="view-header">
          <div>
            <h1>{fileName(file.path)}</h1>
            <div className="sub">{formatBytes(file.size)} · rendered by the desktop webview, not by the phone</div>
          </div>
          <div className="actions">
            {slot === 'main' && (
              <button className="btn" onClick={() => void A.replaceFile(file.path)}>
                <RefreshCw /> Replace…
              </button>
            )}
          </div>
        </div>
        {state === 'error' && <div className="banner banner-warn"><AlertTriangle /> This font could not be loaded for preview. It is still kept in the package.</div>}
        <input className="input" style={{ width: '100%', marginBottom: 16 }} value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample text" />
        {state === 'ok' &&
          [14, 18, 24, 36, 56].map((size) => (
            <div key={size} style={{ fontFamily: family, fontSize: size, lineHeight: 1.3, marginBottom: 10, userSelect: 'text' }}>
              <span className="faint" style={{ fontFamily: 'var(--mono)', fontSize: 11, marginRight: 10 }}>{size}px</span>
              {sample}
            </div>
          ))}
      </div>
    </div>
  );
}

function OtherFile({ file, slot }: { file: FileInfo; slot: Slot }) {
  return (
    <div className="view">
      <div className="view-pad">
        <div className="view-header">
          <div>
            <h1>{fileName(file.path)}</h1>
            <div className="sub mono">{file.path}</div>
          </div>
          <div className="actions">
            {slot === 'main' && (
              <button className="btn" onClick={() => void A.replaceFile(file.path)}>
                <RefreshCw /> Replace…
              </button>
            )}
            <button className="btn" onClick={() => void A.extractFile(file.path, slot)}>
              <Download /> Export…
            </button>
          </div>
        </div>
        {file.kind === 'audio' && (
          <div className="section">
            <audio controls src={resourceUrl(slot, file.path, file.rev)} style={{ width: '100%' }} />
            {slot === 'main' && (
              <button className="btn" style={{ marginTop: 10 }} onClick={() => openSoundTrim(file.path)}>
                <Scissors /> Trim this sound…
              </button>
            )}
          </div>
        )}
        <dl className="kv surface surface-pad">
          <dt>Type</dt>
          <dd>{file.kind === 'binaryXml' ? 'Compiled Android XML (binary)' : file.kind === 'archive' ? 'Nested archive (not expanded)' : (file.format ?? 'Binary data')}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(file.size)}</dd>
          <dt>Compression</dt>
          <dd>{file.compression}</dd>
          <dt>Status</dt>
          <dd>{file.status}</dd>
        </dl>
        <div className="banner" style={{ marginTop: 14 }}>
          <FileQuestion />
          <span>This file has no built-in editor. It is preserved byte-for-byte on export; replace it to use a different version.</span>
        </div>
      </div>
    </div>
  );
}

export function FileView({ path, slot }: { path: string; slot: Slot }) {
  const file = useStore((s) => (slot === 'ref' ? s.refIndex : s.fileIndex).get(path));
  if (!file) {
    return (
      <div className="empty">
        <FileQuestion />
        <h3>File not in the package</h3>
        <p>
          <code>{path}</code> was removed, renamed or the package was closed. Undo restores it if it was deleted in this session.
        </p>
      </div>
    );
  }
  switch (file.kind) {
    case 'image':
      return <ImageViewer file={file} slot={slot} />;
    case 'xml':
    case 'text':
      return <TextEditor file={file} slot={slot} />;
    case 'font':
      return <FontPreview file={file} slot={slot} />;
    default:
      return <OtherFile file={file} slot={slot} />;
  }
}
