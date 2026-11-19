// The panel next to the lock screen preview: every piece in the layout, and
// plain controls for the one you clicked (picture, text, colour, position,
// size, rotation, opacity, hide). Each change is written into manifest.xml in
// place and can be undone. Number labels can be dragged left/right to scrub.
import { useRef, useState } from 'react';
import { ArrowLeft, Code2, Eye, EyeOff, Group as GroupIcon, Image as ImageIcon, Layers, PackagePlus, Repeat, RotateCw, Sigma, Type, Ungroup as UngroupIcon, X } from 'lucide-react';
import { resourceUrl } from '../../lib/api';
import { evalNumber, evalString, type Vars } from '../../lib/maml';
import { findStartTag, lineOf } from '../../lib/mamlEdit';
import { fileName } from '../../lib/paths';
import type { FileInfo } from '../../lib/types';
import * as A from '../../state/actions';
import { useStore } from '../../state/store';
import { openSwap } from './SwapPart';
import { FormulaField } from './FormulaField';
import { DRAWABLE, isUserGroup, type Scene } from './MamlPreview';

const NAMES: Record<string, string> = {
  Text: 'Text',
  DateTime: 'Date / time',
  Time: 'Clock (digit pictures)',
  ImageNumber: 'Number (digit pictures)',
  Image: 'Picture',
  Video: 'Video',
  Rectangle: 'Rectangle',
  Circle: 'Circle',
  Ellipse: 'Ellipse',
  Arc: 'Arc (ring / gauge)',
  Line: 'Line',
  Group: 'Group',
  Button: 'Button',
  Unlocker: 'Unlock slider',
  StartPoint: 'Unlock start area',
  EndPoint: 'Unlock end area',
  Wallpaper: 'Wallpaper',
};
const isNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());

function describe(el: Element) {
  const name = el.getAttribute('name');
  const text = el.tagName === 'Text' ? (el.getAttribute('text') ?? el.getAttribute('format') ?? el.getAttribute('textExp')) : el.tagName === 'DateTime' ? el.getAttribute('format') : el.tagName === 'Image' ? (el.getAttribute('src') ?? el.getAttribute('srcExp')) : null;
  return [name, text].filter(Boolean).join(' · ') || (NAMES[el.tagName] ?? el.tagName);
}

/** One plain sentence about what this piece is, for the ones that are not obvious. */
function purpose(el: Element, vars: Vars) {
  const alpha = el.getAttribute('alpha');
  const fill = el.getAttribute('fillColor') ?? '';
  const invisible = (alpha !== null && evalNumber(alpha, vars, 255) <= 0) || /^#00[0-9a-f]{6}$/i.test(fill.trim());
  if (invisible) return 'Invisible. Usually a tap area, or a layer that fades in (dimming, unlock).';
  if (el.tagName === 'Image' && el.hasAttribute('srcExp')) return 'Shows a different picture depending on the time or state.';
  if (el.tagName === 'Time' || el.tagName === 'ImageNumber') return 'Built from digit pictures (…_0.png to …_9.png). Replace those to restyle it.';
  if (el.tagName === 'StartPoint' || el.tagName === 'Unlocker') return 'Where the unlock swipe starts. Invisible on the phone.';
  return null;
}

type Commit = (ord: number, attrs: Record<string, string | null>) => Promise<boolean>;

/** A text field for one attribute; with `numeric`, its label scrubs the value when dragged. */
function Field({
  el,
  ord,
  names,
  label,
  onCommit,
  vars,
  wide,
  numeric,
  placeholder,
}: {
  el: Element;
  ord: number;
  names: string[];
  label: string;
  onCommit: Commit;
  vars?: Vars;
  wide?: boolean;
  numeric?: boolean;
  placeholder?: string;
}) {
  const name = names.find((n) => el.hasAttribute(n)) ?? names[0];
  const value = el.getAttribute(name) ?? '';
  const input = useRef<HTMLInputElement>(null);
  const save = (next: string) => {
    if (next.trim() === value.trim()) return;
    void onCommit(ord, { [name]: next.trim() === '' ? null : next.trim() });
  };
  const computed = numeric && vars && value && !isNumber(value) ? evalNumber(value, vars, NaN) : NaN;
  const scrub = (e: React.PointerEvent) => {
    if (!numeric || (value && !isNumber(value))) return;
    const start = e.clientX;
    const base = value ? Number(value) : Number(placeholder) || 0;
    let current = base;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      current = Math.round(base + (ev.clientX - start) * (ev.shiftKey ? 10 : 1));
      if (input.current) input.current.value = String(current);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (current !== base) save(String(current));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return (
    <label className={`mi-field ${wide ? 'is-wide' : ''}`}>
      <span className={numeric && (!value || isNumber(value)) ? 'mi-scrub' : undefined} onPointerDown={scrub} title={numeric ? 'Drag left or right to change (Shift: ×10)' : undefined}>
        {label}
        {!Number.isNaN(computed) && <em> = {Math.round(computed)}</em>}
      </span>
      <input
        ref={input}
        key={`${ord}:${name}:${value}`}
        className="input"
        defaultValue={value}
        placeholder={placeholder}
        spellCheck={false}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (numeric && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (!value || isNumber(value))) {
            e.preventDefault();
            const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
            const t = e.target as HTMLInputElement;
            t.value = String((Number(t.value || placeholder) || 0) + step);
            save(t.value);
          }
        }}
      />
    </label>
  );
}

/** Colour with its own transparency (MAML colours are #AARRGGBB). */
function ColorField({ el, ord, name, onCommit }: { el: Element; ord: number; name: string; onCommit: Commit }) {
  const raw = (el.getAttribute(name) ?? '').trim();
  const m8 = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(raw);
  const m6 = /^#([0-9a-f]{6})$/i.exec(raw);
  const m3 = /^#([0-9a-f]{3})$/i.exec(raw);
  const rgb = m8 ? m8[2] : m6 ? m6[1] : m3 ? [...m3[1]].map((c) => c + c).join('') : 'ffffff';
  const alpha = m8 ? parseInt(m8[1], 16) : 255;
  const literal = !raw || !!(m8 || m6 || m3);
  const write = (hex: string, a: number) => void onCommit(ord, { [name]: a >= 255 ? `#${hex}` : `#${Math.round(a).toString(16).padStart(2, '0')}${hex}` });
  if (!literal) return <Field el={el} ord={ord} names={[name]} label="Colour formula" onCommit={onCommit} wide />;
  return (
    <div className="mi-colorbox">
      <label className="mi-swatch" style={{ ['--c' as string]: `#${rgb}`, ['--a' as string]: alpha / 255 }}>
        <input type="color" aria-label="Colour" value={`#${rgb}`} onChange={(e) => write(e.target.value.slice(1), alpha)} />
      </label>
      <div className="mi-colorfields">
        <Field el={el} ord={ord} names={[name]} label="Colour" onCommit={onCommit} />
        <label className="mi-field">
          <span>Colour opacity · {Math.round((alpha / 255) * 100)}%</span>
          <input key={`${ord}:${raw}`} type="range" min={0} max={255} defaultValue={alpha} onPointerUp={(e) => write(rgb, Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => write(rgb, Number((e.target as HTMLInputElement).value))} />
        </label>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mi-section">
      <div className="mi-label">{title}</div>
      {children}
    </section>
  );
}

export function MamlInspector({
  manifest,
  text,
  elements,
  selected,
  extra = [],
  scene,
  onSelect,
  onSelectMany,
  onCommit,
  onSave,
  onGroup,
  onUngroup,
}: {
  manifest: FileInfo;
  text: string | null;
  elements: Element[];
  selected: number | null;
  extra?: number[];
  scene: Scene | null;
  onSelect: (ord: number | null) => void;
  onSelectMany?: (ords: number[]) => void;
  onCommit: Commit;
  /** Save these pieces (with their code and pictures) to the inventory. */
  onSave?: (ords: number[]) => void;
  /** Keep these pieces together as one group (Ctrl+G). */
  onGroup?: (ords: number[]) => void;
  /** Take a group made with Group apart again (Ctrl+Shift+G). */
  onUngroup?: (ord: number) => void;
}) {
  const files = useStore((s) => s.fileIndex);
  const project = useStore((s) => s.project);
  const [newAttr, setNewAttr] = useState('');
  const el = selected !== null ? elements[selected] : undefined;
  const dir = manifest.path.replace(/manifest\.xml$/i, '');
  const vars: Vars = scene?.vars ?? new Map();

  const showCode = (ord: number) => {
    if (text === null) return;
    const tag = findStartTag(text, ord);
    if (!tag) return A.openFile(manifest.path);
    const { line, column } = lineOf(text, tag.start);
    A.revealInFile(manifest.path, line, column, tag.end - tag.start);
  };

  const chosen = selected === null ? extra : [selected, ...extra.filter((o) => o !== selected)];
  if (chosen.length > 1) {
    return (
      <aside className="mi">
        <div className="mi-head">
          <button className="tb-icon" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => onSelect(null)}>
            <ArrowLeft />
          </button>
          <strong>{chosen.length} pieces selected</strong>
        </div>
        <p className="muted mi-hint">Drag any of them to move them together, or nudge with the arrow keys (Shift: 10 px). Shift+click a piece to add or remove it. Group them (Ctrl+G) to keep them together next time. Click one below to edit it on its own.</p>
        <div className="mi-list">
          {chosen.map((o) => {
            const e = elements[o];
            if (!e) return null;
            return (
              <div key={o} className="mi-row mi-row-multi">
                <button className="mi-row-main" onClick={() => onSelect(o)}>
                  {e.tagName === 'Image' || e.tagName === 'Time' || e.tagName === 'ImageNumber' ? <ImageIcon /> : <Type />}
                  <span className="ellipsis grow">{describe(e)}</span>
                  <span className="faint">{NAMES[e.tagName] ?? e.tagName}</span>
                </button>
                {onSelectMany && (
                  <button className="tb-icon" aria-label="Remove from selection" title="Remove from selection" onClick={() => onSelectMany(chosen.filter((x) => x !== o))}>
                    <X />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="mi-foot">
          {onGroup && (
            <button className="btn btn-sm" onClick={() => onGroup(chosen)} title="Keep these pieces together: a click on any of them picks them all (Ctrl+G)">
              <GroupIcon /> Group
            </button>
          )}
          {onSave && (
            <button className="btn btn-sm btn-primary" onClick={() => onSave(chosen)} title="Keep these pieces with their code and pictures, to add them to any theme later">
              <PackagePlus /> Save to inventory
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => onSelect(null)}>
            Clear selection
          </button>
        </div>
      </aside>
    );
  }

  if (!el || selected === null) {
    const pieces = elements.map((e, i) => ({ e, i })).filter(({ e }) => DRAWABLE.has(e.tagName));
    return (
      <aside className="mi">
        <div className="mi-head">
          <Layers />
          <strong>Pieces</strong>
          <span className="faint">{pieces.length}</span>
        </div>
        <p className="muted mi-hint">Click a piece on the screen or in this list. Drag to move it, use the corner handles to resize and the round handle to rotate.</p>
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
  const alphaLiteral = alphaRaw === null || isNumber(alphaRaw);
  const alphaNow = alphaRaw === null ? 255 : Math.max(0, Math.min(255, Number(alphaRaw)));
  const textual = tag === 'Text' || tag === 'DateTime';
  const shape = tag === 'Rectangle' || tag === 'Circle' || tag === 'Ellipse';
  const note = purpose(el, vars);

  // The picture shown right now (srcExp is worked out with the current time), and its siblings (week_0 … week_6).
  const shownSrc = tag === 'Image' ? (el.hasAttribute('srcExp') ? evalString(el.getAttribute('srcExp'), vars) : el.getAttribute('src')) : null;
  const shown = shownSrc ? (files.get(`${dir}${shownSrc.replace(/^\/+/, '')}`) ?? null) : null;
  const variants =
    shown && el.hasAttribute('srcExp')
      ? (() => {
          const re = new RegExp(`^${shown.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+(?=\\\.[a-z0-9]+$)/i, '\\d+')}$`, 'i');
          return (project?.files ?? []).filter((f) => re.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
        })()
      : [];

  return (
    <aside className="mi">
      <div className="mi-head">
        <button className="tb-icon" aria-label="All pieces" title="All pieces" onClick={() => onSelect(null)}>
          <ArrowLeft />
        </button>
        <strong className="ellipsis">{NAMES[tag] ?? tag}</strong>
        {el.getAttribute('name') && <span className="faint ellipsis">{el.getAttribute('name')}</span>}
      </div>
      {note && <p className="mi-note">{note}</p>}
      {isUserGroup(el) && <p className="muted mi-hint">A click on any of its {el.children.length} pieces picks the whole group, so they move together. Double-click to pick one piece inside it.</p>}

      {tag === 'Image' && (
        <Section title={variants.length > 1 ? `Picture · ${variants.length} versions` : 'Picture'}>
          <div className="mi-pic">{shown ? <img src={resourceUrl('main', shown.path, shown.rev)} alt="" /> : <ImageIcon className="faint" />}</div>
          {shown && (
            <div className="mi-picbar">
              <span className="faint ellipsis" title={shown.path}>
                {fileName(shown.path)}
                {shown.width ? ` · ${shown.width}×${shown.height}` : ''}
              </span>
              <button className="btn btn-sm btn-primary" onClick={() => void A.replaceFile(shown.path)}>
                <ImageIcon /> Replace…
              </button>
            </div>
          )}
          {variants.length > 1 && (
            <>
              <div className="mi-variants">
                {variants.map((f) => (
                  <button key={f.path} className={`mi-variant ${f.path === shown?.path ? 'is-on' : ''}`} title={`Replace ${fileName(f.path)}`} onClick={() => void A.replaceFile(f.path)}>
                    <img src={resourceUrl('main', f.path, f.rev)} alt="" loading="lazy" />
                    <span>{fileName(f.path).replace(/\.[a-z0-9]+$/i, '')}</span>
                  </button>
                ))}
              </div>
              <p className="faint mi-hint-sm">The one outlined is showing now. Click any version to replace it.</p>
            </>
          )}
        </Section>
      )}

      {textual && (
        <Section title="Text">
          {tag === 'DateTime' ? (
            el.hasAttribute('formatExp') ? (
              <FormulaField key={`${selected}:formatExp`} label="Format formula" kind="text" value={el.getAttribute('formatExp') ?? ''} vars={vars} onCommit={(v) => void onCommit(selected, { formatExp: v || null })} />
            ) : (
              <FormulaField key={`${selected}:format`} label="Format" kind="date" value={el.getAttribute('format') ?? ''} vars={vars} onCommit={(v) => void onCommit(selected, { format: v || null })} />
            )
          ) : el.hasAttribute('textExp') ? (
            <FormulaField key={`${selected}:textExp`} label="Text formula" kind="text" value={el.getAttribute('textExp') ?? ''} vars={vars} onCommit={(v) => void onCommit(selected, { textExp: v || null })} />
          ) : (
            <>
              <Field el={el} ord={selected} names={el.hasAttribute('format') ? ['format'] : ['text']} label="Text" onCommit={onCommit} wide />
              {!el.hasAttribute('format') && (
                <button
                  className="btn btn-sm mi-formula-btn"
                  title="Show weather, battery, time or anything worked out, instead of fixed words"
                  onClick={() => void onCommit(selected, { textExp: `'${(el.getAttribute('text') ?? '').replace(/'/g, '’')}'`, text: null })}
                >
                  <Sigma /> Make it a formula
                </button>
              )}
            </>
          )}
          <div className="mi-grid">
            <Field el={el} ord={selected} names={['size']} label="Size" onCommit={onCommit} vars={vars} numeric placeholder="18" />
            <label className="mi-field">
              <span>Style</span>
              <button className="chip mi-bold" aria-pressed={el.getAttribute('bold') === 'true'} onClick={() => void onCommit(selected, { bold: el.getAttribute('bold') === 'true' ? null : 'true' })}>
                <strong>B</strong> Bold
              </button>
            </label>
          </div>
          <ColorField el={el} ord={selected} name="color" onCommit={onCommit} />
        </Section>
      )}

      {shape && (
        <Section title="Fill">
          <ColorField el={el} ord={selected} name="fillColor" onCommit={onCommit} />
          {tag === 'Rectangle' && <Field el={el} ord={selected} names={['cornerRadius']} label="Corner radius" onCommit={onCommit} vars={vars} numeric placeholder="0" />}
        </Section>
      )}

      {tag === 'Arc' && (
        <Section title="Arc">
          <ColorField el={el} ord={selected} name="strokeColor" onCommit={onCommit} />
          <div className="mi-grid">
            <Field el={el} ord={selected} names={['weight']} label="Line width" onCommit={onCommit} vars={vars} numeric placeholder="1" />
            <Field el={el} ord={selected} names={['startAngle']} label="Start °" onCommit={onCommit} vars={vars} numeric placeholder="0" />
            <Field el={el} ord={selected} names={['sweep']} label="Sweep °" onCommit={onCommit} vars={vars} numeric placeholder="0" />
          </div>
        </Section>
      )}

      <Section title="Position & size">
        <div className="mi-grid">
          <Field el={el} ord={selected} names={['x']} label="X" onCommit={onCommit} vars={vars} numeric placeholder="0" />
          <Field el={el} ord={selected} names={['y']} label="Y" onCommit={onCommit} vars={vars} numeric placeholder="0" />
          {!textual && tag !== 'Circle' && (
            <>
              <Field el={el} ord={selected} names={['w', 'width']} label="Width" onCommit={onCommit} vars={vars} numeric placeholder={shown?.width ? String(shown.width) : 'auto'} />
              <Field el={el} ord={selected} names={['h', 'height']} label="Height" onCommit={onCommit} vars={vars} numeric placeholder={shown?.height ? String(shown.height) : 'auto'} />
            </>
          )}
          {tag === 'Circle' && <Field el={el} ord={selected} names={['r']} label="Radius" onCommit={onCommit} vars={vars} numeric />}
          <Field el={el} ord={selected} names={['rotation', 'angle']} label="Rotation °" onCommit={onCommit} vars={vars} numeric placeholder="0" />
          <label className="mi-field">
            <span>&nbsp;</span>
            <button className="btn btn-sm" disabled={!el.getAttribute('rotation') && !el.getAttribute('angle')} onClick={() => void onCommit(selected, { rotation: null, angle: null })}>
              <RotateCw /> Straighten
            </button>
          </label>
        </div>
        <div className="mi-anchor">
          <span className="faint">X/Y is the</span>
          <div className="segmented">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} aria-pressed={(el.getAttribute('align') ?? 'left') === a} onClick={() => void onCommit(selected, { align: a === 'left' ? null : a })}>
                {a === 'center' ? 'centre' : a}
              </button>
            ))}
          </div>
          <div className="segmented">
            {(['top', 'center', 'bottom'] as const).map((a) => (
              <button key={a} aria-pressed={(el.getAttribute('alignV') ?? 'top') === a} onClick={() => void onCommit(selected, { alignV: a === 'top' ? null : a })}>
                {a === 'center' ? 'middle' : a}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Visibility">
        {alphaLiteral ? (
          <label className="mi-field is-wide">
            <span>Opacity · {Math.round((alphaNow / 255) * 100)}%</span>
            <input
              key={`${selected}:${alphaRaw}`}
              type="range"
              min={0}
              max={255}
              defaultValue={alphaNow}
              onPointerUp={(e) => void onCommit(selected, { alpha: (e.target as HTMLInputElement).value === '255' ? null : (e.target as HTMLInputElement).value })}
              onKeyUp={(e) => void onCommit(selected, { alpha: (e.target as HTMLInputElement).value === '255' ? null : (e.target as HTMLInputElement).value })}
            />
          </label>
        ) : (
          <FormulaField key={`${selected}:alpha`} label="Opacity formula (0–255)" kind="number" value={alphaRaw ?? ''} vars={vars} onCommit={(v) => void onCommit(selected, { alpha: v || null })} />
        )}
        {visExpr ? (
          <FormulaField key={`${selected}:visibility`} label="Shown when" kind="visibility" value={vis ?? ''} vars={vars} onCommit={(v) => void onCommit(selected, { visibility: v || null })} />
        ) : (
          <div className="mi-vis-btns">
            <button className="btn btn-sm" onClick={() => void onCommit(selected, { visibility: vis === 'false' ? null : 'false' })}>
              {vis === 'false' ? <Eye /> : <EyeOff />} {vis === 'false' ? 'Show it again' : 'Hide it'}
            </button>
            <button className="btn btn-sm" title="Show it only while charging, at night, when there are messages…" onClick={() => void onCommit(selected, { visibility: 'eq(#battery_state,1)' })}>
              <Sigma /> Show only when…
            </button>
          </div>
        )}
      </Section>

      <details className="mi-section mi-all">
        <summary>All settings ({el.attributes.length})</summary>
        {Array.from(el.attributes).map((a) => (
          <Field key={a.name} el={el} ord={selected} names={[a.name]} label={a.name} onCommit={onCommit} vars={vars} wide />
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

      {onSave && (
        <div className="mi-save">
          <button className="btn btn-sm btn-primary" onClick={() => onSave([selected])} title="Keep this piece with its code and pictures, to add it to any theme later">
            <PackagePlus /> Save to inventory
          </button>
        </div>
      )}
      <div className="mi-foot">
        {onUngroup && isUserGroup(el) && (
          <button className="btn btn-sm" onClick={() => onUngroup(selected)} title="Put the pieces back on their own (Ctrl+Shift+G)">
            <UngroupIcon /> Ungroup
          </button>
        )}
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
