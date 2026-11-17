// Colours: every <color> a theme sets in its theme_values.xml files (system
// framework, status bar, launcher, apps…), as swatches you can pick instead
// of hand-editing XML. Changes are written back into the same files, keeping
// everything else in them untouched.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Palette, RotateCcw, Save, Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { splitNested } from '../../lib/paths';
import { plural } from '../../lib/format';
import * as A from '../../state/actions';
import { toast, useStore } from '../../state/store';

interface ColorEntry {
  file: string;
  name: string;
  /** Value as written in the file, e.g. #ff0d84ff (Android order: alpha first). */
  value: string;
  /** Offsets of the value inside the file text. */
  start: number;
  end: number;
}

const COLOR_RE = /<color\b[^>]*\bname="([^"]+)"[^>]*>\s*(#[0-9a-fA-F]{3,8})\s*<\/color>/g;

/** #rgb / #argb / #rrggbb / #aarrggbb → { rgb: '#rrggbb', alpha: 0..255 } */
function parse(value: string) {
  let hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length === 6) return { rgb: `#${hex.toLowerCase()}`, alpha: 255 };
  if (hex.length === 8) return { rgb: `#${hex.slice(2).toLowerCase()}`, alpha: parseInt(hex.slice(0, 2), 16) };
  return null;
}
function compose(rgb: string, alpha: number) {
  return `#${alpha.toString(16).padStart(2, '0')}${rgb.slice(1)}`.toLowerCase();
}
function cssColor(value: string) {
  const p = parse(value);
  return p ? `rgba(${parseInt(p.rgb.slice(1, 3), 16)}, ${parseInt(p.rgb.slice(3, 5), 16)}, ${parseInt(p.rgb.slice(5, 7), 16)}, ${(p.alpha / 255).toFixed(3)})` : 'transparent';
}

const AREA: Record<string, string> = {
  'framework-res': 'System (all apps)',
  'framework-miui-res': 'System (MIUI controls)',
  'com.android.systemui': 'Status bar & notifications',
  'miui.systemui.plugin': 'Control center',
  'com.miui.home': 'Home screen',
  'com.android.settings': 'Settings',
  'com.android.contacts': 'Contacts & dialer',
  'com.android.mms': 'Messages',
};
function areaOf(file: string) {
  const [outer, inner] = splitNested(file);
  const label = AREA[outer] ?? outer;
  return inner && /nightmode/i.test(inner) ? `${label} · dark mode` : label;
}

export function ColorsView() {
  const project = useStore((s) => s.project)!;
  const sources = useMemo(() => project.files.filter((f) => /(^|\/)theme_values\.xml$/i.test(f.path)), [project]);
  const stamp = sources.map((f) => `${f.path}:${f.rev}`).join('|');
  const [texts, setTexts] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTexts(null);
    setEdits({});
    Promise.all(sources.map((f) => api.fileText(f.path).then((t) => [f.path, t.text] as const)))
      .then((pairs) => !cancelled && setTexts(Object.fromEntries(pairs)))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [stamp]);

  const entries = useMemo(() => {
    const list: ColorEntry[] = [];
    for (const [file, text] of Object.entries(texts ?? {})) {
      for (const m of text.matchAll(COLOR_RE)) {
        const start = m.index + m[0].indexOf(m[2], m[0].indexOf('>'));
        list.push({ file, name: m[1], value: m[2], start, end: start + m[2].length });
      }
    }
    return list;
  }, [texts]);

  const key = (e: ColorEntry) => `${e.file}\n${e.start}`;
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, ColorEntry[]>();
    for (const e of entries) {
      if (q && !e.name.toLowerCase().includes(q) && !(edits[key(e)] ?? e.value).toLowerCase().includes(q)) continue;
      map.set(e.file, [...(map.get(e.file) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries, q, edits]);
  const changed = Object.keys(edits).length;

  const set = (e: ColorEntry, value: string) =>
    setEdits((all) => {
      const next = { ...all };
      if (value.toLowerCase() === e.value.toLowerCase()) delete next[key(e)];
      else next[key(e)] = value;
      return next;
    });

  const save = async () => {
    if (!texts) return;
    setSaving(true);
    let files = 0;
    for (const [file, text] of Object.entries(texts)) {
      const mine = entries.filter((e) => e.file === file && edits[key(e)]).sort((a, b) => b.start - a.start);
      if (!mine.length) continue;
      let out = text;
      for (const e of mine) out = out.slice(0, e.start) + edits[key(e)] + out.slice(e.end);
      if (!(await A.writeText(file, out))) {
        setSaving(false);
        return;
      }
      files += 1;
    }
    setSaving(false);
    toast('success', `${plural(changed, 'colour')} saved in ${plural(files, 'file')}`);
  };

  if (error) return <div className="view-pad"><div className="banner banner-err">{error}</div></div>;
  if (!texts) {
    return (
      <div className="empty">
        <Loader2 className="spin" />
      </div>
    );
  }
  if (!entries.length) {
    return (
      <div className="empty">
        <Palette />
        <h3>This theme sets no colours yet</h3>
        <p style={{ maxWidth: 520 }}>
          Colours live in <code>theme_values.xml</code> inside parts such as System UI, Home screen or Framework. Take one of those parts from another theme (Swap), and its colours show up here to change.
        </p>
      </div>
    );
  }

  return (
    <div className="center-body">
      <div className="toolbar">
        <div className="search" style={{ width: 240 }}>
          <Search />
          <input className="input" placeholder="Find a colour by name or value" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a colour" />
        </div>
        <span className="muted">
          {plural(entries.length, 'colour')} in {plural(Object.keys(texts).length, 'file')}
        </span>
        <span className="grow" />
        {changed > 0 && (
          <button className="btn btn-sm" onClick={() => setEdits({})}>
            <RotateCcw /> Discard {changed}
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="spin" /> : <Save />} Save {changed ? plural(changed, 'change') : 'changes'}
        </button>
      </div>
      <div className="view">
        <div className="view-pad">
          {groups.map(([file, list]) => (
            <div className="section" key={file}>
              <div className="section-head">
                <h2>{areaOf(file)}</h2>
                <span className="muted">{plural(list.length, 'colour')}</span>
                <div className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => A.openFile(file)} title={file}>
                    Open the XML
                  </button>
                </div>
              </div>
              <div className="color-grid">
                {list.map((e) => {
                  const value = edits[key(e)] ?? e.value;
                  const p = parse(value);
                  return (
                    <div key={key(e)} className={`color-row ${edits[key(e)] ? 'is-changed' : ''}`}>
                      <label className="color-swatch checker" title="Pick a colour">
                        <span style={{ background: cssColor(value) }} />
                        <input type="color" value={p?.rgb ?? '#000000'} onChange={(ev) => set(e, compose(ev.target.value, p?.alpha ?? 255))} aria-label={`Colour for ${e.name}`} />
                      </label>
                      <div className="color-info">
                        <span className="ellipsis" title={e.name}>
                          {e.name.replace(/_/g, ' ')}
                        </span>
                        <input
                          className="input color-hex"
                          value={value}
                          spellCheck={false}
                          onChange={(ev) => /^#[0-9a-fA-F]{0,8}$/.test(ev.target.value) && set(e, ev.target.value)}
                          aria-label={`Hex value for ${e.name}`}
                        />
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={255}
                        value={p?.alpha ?? 255}
                        disabled={!p}
                        onChange={(ev) => p && set(e, compose(p.rgb, Number(ev.target.value)))}
                        title={`Opacity ${Math.round(((p?.alpha ?? 255) / 255) * 100)}%`}
                        aria-label={`Opacity for ${e.name}`}
                        className="color-alpha"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && <p className="muted">No colours match “{query}”.</p>}
        </div>
      </div>
    </div>
  );
}
