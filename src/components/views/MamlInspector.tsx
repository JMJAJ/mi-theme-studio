// The panel next to the lock screen preview: every piece in the layout, and
// plain controls for the one you clicked (position, size, colour, text, picture,
// hide). Each change is written into manifest.xml in place and can be undone.
import { useState } from 'react';
import { ArrowLeft, Code2, Eye, EyeOff, Image as ImageIcon, Layers, Repeat, Type } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { findStartTag, lineOf } from '../../lib/mamlEdit';
import type { FileInfo } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { openSwap } from './SwapPart';
import { argb, DRAWABLE, type Scene } from './MamlPreview';

const NAMES: Record<string, string> = {
  Text: 'Text',
  DateTime: 'Date / time',
  Time: 'Clock (digit pictures)',
  ImageNumber: 'Number (digit pictures)',
  Image: 'Picture',
  Rectangle: 'Rectangle',
  Circle: 'Circle',
  Ellipse: 'Ellipse',
  Line: 'Line',
  Group: 'Group',
  Button: 'Button',
  Unlocker: 'Unlock slider',
  Wallpaper: 'Wallpaper',
};
const FORMATS = ['HH:mm', 'hh:mm', 'HH', 'mm', 'EEEE', 'EEE, d MMM', 'd MMMM', 'MM/dd'];

function describe(el: Element) {
  const name = el.getAttribute('name');
  const text = el.tagName === 'Text' ? (el.getAttribute('text') ?? el.getAttribute('format') ?? el.getAttribute('textExp')) : el.tagName === 'DateTime' ? el.getAttribute('format') : el.tagName === 'Image' ? (el.getAttribute('src') ?? el.getAttribute('srcExp')) : null;
  return [name, text].filter(Boolean).join(' · ') || (NAMES[el.tagName] ?? el.tagName);
}

type Commit = (ord: number, attrs: Record<string, string | null>) => Promise<boolean>;

function Field({ el, ord, name, label, onCommit, wide }: { el: Element; ord: number; name: string; label: string; onCommit: Commit; wide?: boolean }) {
  const value = el.getAttribute(name) ?? '';
  const save = (next: string) => {
    if (next === value) return;
    void onCommit(ord, { [name]: next === '' ? null : next });
  };
  return (
    <label className={`mi-field ${wide ? 'is-wide' : ''}`}>
      <span>{label}</span>
      <input
        key={`${ord}:${name}:${value}`}
        className="input"
        defaultValue={value}
        spellCheck={false}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function ColorField({ el, ord, name, onCommit }: { el: Element; ord: number; name: string; onCommit: Commit }) {
  const raw = el.getAttribute(name);
  const css = argb(raw, '#ffffff');
  const hex = css.length === 9 ? css.slice(0, 7) : css.length === 4 ? `#${[...css.slice(1)].map((c) => c + c).join('')}` : css;
  const alpha = raw && /^#[0-9a-f]{8}$/i.test(raw.trim()) ? raw.trim().slice(1, 3) : null;
  return (
    <div className="mi-color">
      <input type="color" aria-label="Colour" value={hex} onChange={(e) => void onCommit(ord, { [name]: alpha ? `#${alpha}${e.target.value.slice(1)}` : e.target.value })} />
      <Field el={el} ord={ord} name={name} label="Colour" onCommit={onCommit} />
    </div>
  );
}

export function MamlInspector({
  manifest,
  text,
  elements,
  selected,
  scene,
  onSelect,
  onCommit,
}: {
  manifest: FileInfo;
  text: string | null;
  elements: Element[];
  selected: number | null;
  scene: Scene | null;
  onSelect: (ord: number | null) => void;
  onCommit: Commit;
}) {
  const files = useStore((s) => s.fileIndex);
  const [newAttr, setNewAttr] = useState('');
  const el = selected !== null ? elements[selected] : undefined;
  const dir = manifest.path.replace(/manifest\.xml$/i, '');

  const showCode = (ord: number) => {
    if (text === null) return;
    const tag = findStartTag(text, ord);
    if (!tag) return A.openFile(manifest.path);
    const { line, column } = lineOf(text, tag.start);
    A.revealInFile(manifest.path, line, column, tag.end - tag.start);
  };

  if (!el || selected === null) {
    const pieces = elements.map((e, i) => ({ e, i })).filter(({ e }) => DRAWABLE.has(e.tagName));
    return (
      <aside className="mi">
        <div className="mi-head">
          <Layers />
          <strong>Pieces</strong>
          <span className="faint">{pieces.length}</span>
        </div>
        <p className="muted mi-hint">Click a piece on the screen or in this list to change it. Drag it on the screen to move it.</p>
        <div className="mi-list">
          {pieces.slice(0, 300).map(({ e, i }) => (
            <button key={i} className="mi-row" onClick={() => onSelect(i)}>
              {e.tagName === 'Image' || e.tagName === 'Time' || e.tagName === 'ImageNumber' ? <ImageIcon /> : <Type />}
              <span className="ellipsis grow">{describe(e)}</span>
              <span className="faint">{NAMES[e.tagName] ?? e.tagName}</span>
            </button>
          ))}
        </div>
        <div className="mi-foot">
          <button className="btn btn-sm" onClick={() => openSwap({ part: manifest.component })}>
            <Repeat /> Swap from another theme…
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => A.openFile(manifest.path)}>
            <Code2 /> Code
          </button>
        </div>
      </aside>
    );
  }

  const tag = el.tagName;
  const parent = el.parentElement;
  const parentOrd = parent && parent !== el.ownerDocument.documentElement ? elements.indexOf(parent) : -1;
  const vis = el.getAttribute('visibility');
  const visExpr = vis !== null && vis !== 'true' && vis !== 'false';
  const alphaRaw = el.getAttribute('alpha');
  const alphaLiteral = alphaRaw === null || /^\d+$/.test(alphaRaw.trim());
  const src = tag === 'Image' ? el.getAttribute('src') : null;
  const srcFile = src ? (files.get(`${dir}${src.replace(/^\/+/, '')}`) ?? null) : null;
  const textual = tag === 'Text' || tag === 'DateTime';
  const shape = tag === 'Rectangle' || tag === 'Circle' || tag === 'Ellipse';

  return (
    <aside className="mi">
      <div className="mi-head">
        <button className="tb-icon" aria-label="All pieces" title="All pieces" onClick={() => onSelect(null)}>
          <ArrowLeft />
        </button>
        <strong className="ellipsis">{NAMES[tag] ?? tag}</strong>
        {el.getAttribute('name') && <span className="faint ellipsis">{el.getAttribute('name')}</span>}
      </div>

      {tag === 'Image' && (
        <div className="mi-section">
          <div className="mi-pic">
            {srcFile ? <img src={resourceUrl('main', srcFile.path, srcFile.rev)} alt="" /> : <ImageIcon className="faint" />}
          </div>
          {srcFile && (
            <button className="btn btn-sm btn-primary" onClick={() => void A.replaceFile(srcFile.path)}>
              <ImageIcon /> Replace picture…
            </button>
          )}
          {!srcFile && el.hasAttribute('srcExp') && <p className="faint mi-hint">This picture changes with a formula (srcExp), so it is replaced in the code.</p>}
        </div>
      )}

      {textual && (
        <div className="mi-section">
          {tag === 'DateTime' ? (
            <>
              <Field el={el} ord={selected} name="format" label="Format" onCommit={onCommit} wide />
              <div className="mi-chips">
                {FORMATS.map((f) => (
                  <button key={f} className="chip" aria-pressed={el.getAttribute('format') === f} onClick={() => void onCommit(selected, { format: f })}>
                    {f}
                  </button>
                ))}
              </div>
            </>
          ) : el.hasAttribute('textExp') ? (
            <Field el={el} ord={selected} name="textExp" label="Text formula" onCommit={onCommit} wide />
          ) : el.hasAttribute('format') ? (
            <Field el={el} ord={selected} name="format" label="Text" onCommit={onCommit} wide />
          ) : (
            <Field el={el} ord={selected} name="text" label="Text" onCommit={onCommit} wide />
          )}
          <div className="mi-grid">
            <Field el={el} ord={selected} name="size" label="Size" onCommit={onCommit} />
            <label className="mi-field">
              <span>Bold</span>
              <input type="checkbox" checked={el.getAttribute('bold') === 'true'} onChange={(e) => void onCommit(selected, { bold: e.target.checked ? 'true' : null })} />
            </label>
          </div>
          <ColorField el={el} ord={selected} name="color" onCommit={onCommit} />
        </div>
      )}

      {shape && (
        <div className="mi-section">
          <ColorField el={el} ord={selected} name="fillColor" onCommit={onCommit} />
          {tag === 'Rectangle' && <Field el={el} ord={selected} name="cornerRadius" label="Corner radius" onCommit={onCommit} />}
        </div>
      )}

      <div className="mi-section">
        <div className="mi-label">Position{scene ? <span className="faint"> · screen {scene.w} × {scene.h}</span> : null}</div>
        <div className="mi-grid">
          <Field el={el} ord={selected} name="x" label="X" onCommit={onCommit} />
          <Field el={el} ord={selected} name="y" label="Y" onCommit={onCommit} />
          {!textual && <Field el={el} ord={selected} name="w" label="Width" onCommit={onCommit} />}
          {!textual && <Field el={el} ord={selected} name="h" label="Height" onCommit={onCommit} />}
        </div>
        <div className="mi-chips">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} className="chip" aria-pressed={(el.getAttribute('align') ?? 'left') === a} onClick={() => void onCommit(selected, { align: a === 'left' ? null : a })}>
              Anchor {a}
            </button>
          ))}
        </div>
      </div>

      <div className="mi-section">
        {alphaLiteral ? (
          <label className="mi-field is-wide">
            <span>Opacity · {Math.round(((alphaRaw ? Number(alphaRaw) : 255) / 255) * 100)}%</span>
            <input
              key={`${selected}:${alphaRaw}`}
              type="range"
              min={0}
              max={255}
              defaultValue={alphaRaw ? Number(alphaRaw) : 255}
              onPointerUp={(e) => void onCommit(selected, { alpha: (e.target as HTMLInputElement).value === '255' ? null : (e.target as HTMLInputElement).value })}
              onKeyUp={(e) => void onCommit(selected, { alpha: (e.target as HTMLInputElement).value === '255' ? null : (e.target as HTMLInputElement).value })}
            />
          </label>
        ) : (
          <Field el={el} ord={selected} name="alpha" label="Opacity formula" onCommit={onCommit} wide />
        )}
        {visExpr ? (
          <Field el={el} ord={selected} name="visibility" label="Shown when" onCommit={onCommit} wide />
        ) : (
          <button className="btn btn-sm" onClick={() => void onCommit(selected, { visibility: vis === 'false' ? null : 'false' })}>
            {vis === 'false' ? <Eye /> : <EyeOff />} {vis === 'false' ? 'Show it again' : 'Hide it'}
          </button>
        )}
      </div>

      <details className="mi-section mi-all">
        <summary>All settings ({el.attributes.length})</summary>
        {Array.from(el.attributes).map((a) => (
          <Field key={a.name} el={el} ord={selected} name={a.name} label={a.name} onCommit={onCommit} wide />
        ))}
        <form
          className="mi-add"
          onSubmit={(e) => {
            e.preventDefault();
            const [name, ...rest] = newAttr.split('=');
            if (!/^[A-Za-z_][\w.:-]*$/.test(name.trim())) return;
            void onCommit(selected, { [name.trim()]: rest.join('=').trim().replace(/^"|"$/g, '') });
            setNewAttr('');
          }}
        >
          <input className="input" placeholder='name="value"' value={newAttr} onChange={(e) => setNewAttr(e.target.value)} />
          <button className="btn btn-sm" type="submit">
            Add
          </button>
        </form>
      </details>

      <div className="mi-foot">
        {parentOrd >= 0 && (
          <button className="btn btn-sm" onClick={() => onSelect(parentOrd)}>
            <Layers /> Select its group
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => showCode(selected)}>
          <Code2 /> Show in code
        </button>
      </div>
    </aside>
  );
}
