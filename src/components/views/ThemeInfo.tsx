import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileCode2, Info } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { MetadataView } from '../../lib/types';
import { useStore } from '../../state/store';
import * as A from '../../state/actions';

const KNOWN: { name: string; label: string; hint: string; wide?: boolean; multiline?: boolean }[] = [
  { name: 'title', label: 'Title', hint: 'Theme name shown in Theme Manager.' },
  { name: 'version', label: 'Version', hint: 'Your own version, e.g. 1.0.' },
  { name: 'author', label: 'Author', hint: 'Credited creator.' },
  { name: 'designer', label: 'Designer', hint: 'Optional designer attribution.' },
  { name: 'uiVersion', label: 'UI version', hint: 'MIUI UI version the theme targets (e.g. 10, 12, 14).' },
  { name: 'miuiAdapterVersion', label: 'Adapter version', hint: 'Editor/adapter version field used by some packages.' },
  { name: 'description', label: 'Description', hint: 'Short description of the theme.', wide: true, multiline: true },
  { name: 'keywords', label: 'Keywords', hint: 'Semicolon-separated keywords.', wide: true },
];

function Field({ name, label, hint, wide, multiline, initial }: { name: string; label: string; hint: string; wide?: boolean; multiline?: boolean; initial: string }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const commit = () => {
    if (value !== initial) void A.updateMetadata([{ name, value }], `Edit ${label.toLowerCase()}`);
  };
  const id = `meta-${name}`;
  return (
    <div className={`field ${wide ? 'wide' : ''}`}>
      <label htmlFor={id}>
        {label} {value !== initial && <span className="badge badge-accent">editing</span>}
      </label>
      {multiline ? (
        <textarea id={id} className="textarea" rows={3} value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit} />
      ) : (
        <input
          id={id}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setValue(initial);
          }}
        />
      )}
      <span className="field-hint">
        <code>&lt;{name}&gt;</code> · {hint}
      </span>
    </div>
  );
}

export function ThemeInfo() {
  const rev = useStore((s) => s.fileIndex.get('description.xml')?.rev ?? 0);
  const hasProject = useStore((s) => !!s.project);
  const [view, setView] = useState<MetadataView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasProject) return;
    api
      .metadataGet()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [rev, hasProject]);

  const plain = useMemo(() => new Map((view?.fields ?? []).filter((f) => !f.attributes.length && !f.complex).map((f) => [f.name, f.value])), [view]);
  const others = (view?.fields ?? []).filter((f) => !f.attributes.length && !f.complex && !KNOWN.some((k) => k.name === f.name));
  const localized = (view?.fields ?? []).filter((f) => f.attributes.length || f.complex);

  if (!hasProject) return <div className="empty">Open a package first.</div>;

  return (
    <div className="view">
      <div className="view-pad">
        <div className="view-header">
          <div>
            <h1>Theme details</h1>
            <div className="sub">
              Stored in <code>description.xml</code>. Edits are applied when a field loses focus and can be undone.
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => A.openFile('description.xml')} disabled={!view?.exists}>
              <FileCode2 /> Edit XML
            </button>
          </div>
        </div>

        {error && (
          <div className="banner banner-err">
            <AlertTriangle /> {error}
          </div>
        )}
        {view && !view.exists && (
          <div className="banner banner-warn">
            <AlertTriangle />
            <span className="grow">This package has no description.xml. Theme Manager needs it to identify the theme.</span>
            <div className="actions">
              <button className="btn btn-sm btn-primary" onClick={() => void A.createDescription()}>
                Create description.xml
              </button>
            </div>
          </div>
        )}
        {view?.error && (
          <div className="banner banner-err">
            <AlertTriangle />
            <span className="grow">
              description.xml is not well-formed and cannot be edited with this form: {view.error}
            </span>
            <div className="actions">
              <button className="btn btn-sm" onClick={() => A.openFile('description.xml')}>
                Fix in XML editor
              </button>
            </div>
          </div>
        )}

        {view?.exists && !view.error && (
          <>
            {view.root !== 'MIUI-Theme' && (
              <div className="banner banner-warn" style={{ marginBottom: 14 }}>
                <AlertTriangle /> Root element is <code>{view.root}</code>; MIUI packages use <code>MIUI-Theme</code>.
              </div>
            )}
            <div className="form-grid">
              {KNOWN.map((f) => (
                <Field key={f.name} {...f} initial={plain.get(f.name) ?? ''} />
              ))}
            </div>
            {others.length > 0 && (
              <div className="section">
                <div className="section-head">
                  <h2>Other fields</h2>
                  <span className="muted">Present in this package; preserved as-is unless edited</span>
                </div>
                <div className="form-grid">
                  {others.map((f) => (
                    <Field key={f.name} name={f.name} label={f.name} hint="Package-specific field." initial={f.value} />
                  ))}
                </div>
              </div>
            )}
            {localized.length > 0 && (
              <div className="section">
                <div className="section-head">
                  <h2>Localized and structured fields</h2>
                  <span className="muted">Read-only here — edit them in the XML editor</span>
                </div>
                <table className="table surface">
                  <thead>
                    <tr>
                      <th>Element</th>
                      <th>Attributes</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {localized.map((f, i) => (
                      <tr key={i}>
                        <td className="mono">{f.name}</td>
                        <td className="mono muted">{f.attributes.map(([k, v]) => `${k}="${v}"`).join(' ')}</td>
                        <td>{f.complex ? <span className="muted">nested elements</span> : f.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="section">
              <div className="banner">
                <Info />
                <span>Fields that are not listed above, comments and formatting in description.xml are preserved when you edit through this form.</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
