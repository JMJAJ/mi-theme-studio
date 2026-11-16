import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { xml } from '@codemirror/lang-xml';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { AlertTriangle, Check, Download, FileQuestion, Maximize, Minus, Plus, RefreshCw, RotateCcw, Scan } from 'lucide-react';
import { api, errorMessage, resourceUrl } from '../../lib/api';
import { dimensions, formatBytes } from '../../lib/format';
import { displayFolder, fileName, parentOf } from '../../lib/paths';
import type { FileInfo, Slot } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';

// ---------------------------------------------------------------- image

function ImageViewer({ file, slot }: { file: FileInfo; slot: Slot }) {
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
        <span className="muted nowrap">
          {[file.format, dimensions(file.width, file.height), formatBytes(file.size), file.density].filter(Boolean).join(' · ')}
        </span>
        {file.ninePatch && <span className="badge badge-info" title="Android nine-patch: the 1px border defines stretch and padding areas">9-patch</span>}
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
    '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--line-strong)' },
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

function xmlError(text: string): string | null {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const error = doc.querySelector('parsererror');
  if (!error) return null;
  return (error.textContent ?? 'XML syntax error').split('\n').filter(Boolean).slice(0, 2).join(' ');
}

function TextEditor({ file, slot }: { file: FileInfo; slot: Slot }) {
  const draft = useStore((s) => (slot === 'main' ? s.drafts[file.path] : undefined));
  const [loaded, setLoaded] = useState<{ text: string; rev: number; lossy: boolean; bom: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(draft?.text ?? '');
  const isXml = file.kind === 'xml';
  const readOnly = slot === 'ref';
  const view = useRef<EditorView | null>(null);
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

  // Select a search match once the text is loaded.
  useEffect(() => {
    const v = view.current;
    if (!reveal || !v || !loaded) return;
    const doc = v.state.doc;
    if (reveal.line < 1 || reveal.line > doc.lines) return;
    const line = doc.line(reveal.line);
    // Columns are in characters; CodeMirror positions are UTF-16 units.
    const prefix = [...line.text].slice(0, reveal.column - 1).join('');
    const hit = [...line.text.slice(prefix.length)].slice(0, reveal.length).join('');
    const from = line.from + prefix.length;
    v.dispatch({ selection: { anchor: from, head: Math.min(from + hit.length, doc.length) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    v.focus();
  }, [reveal?.nonce, loaded]);

  const [syntax, setSyntax] = useState<string | null>(null);
  useEffect(() => {
    if (!isXml) return;
    const timer = window.setTimeout(() => setSyntax(xmlError(text)), 250);
    return () => window.clearTimeout(timer);
  }, [text, isXml]);

  const extensions = useMemo(
    () => [
      ...(isXml ? [xml()] : []),
      editorTheme,
      highlight,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            void A.applyDraft(file.path);
            return true;
          },
        },
      ]),
    ],
    [isXml, file.path],
  );

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
          }}
          basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
          onChange={(value) => {
            setText(value);
            if (!readOnly) A.setDraft(file.path, value, draft?.baseRev ?? loaded.rev, draft?.original ?? loaded.text);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- font / audio / other

function FontPreview({ file, slot }: { file: FileInfo; slot: Slot }) {
  const family = `mts-font-${file.rev}`;
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog 0123456789');
  useEffect(() => {
    const face = new FontFace(family, `url("${resourceUrl(slot, file.path, file.rev)}")`);
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
