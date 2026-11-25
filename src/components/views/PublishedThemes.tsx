// Your themes on the Xiaomi Theme Design Station, with their review state, versions
// and change log, and a way to publish a new version of one.
import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ChevronDown, ChevronRight, CircleUserRound, Download, ExternalLink, Loader2, RefreshCw, Send } from 'lucide-react';
import { api, errorMessage, type DesignerProductDetail, type DesignerProductRow, type DesignerVersionRow } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useStore } from '../../state/store';
import { canUpdate, refreshPublished, reviewState, signIn, startPublishing, usePublish, usePublished } from '../../state/publish';

const STATION = 'https://zhuti.designer.intl.xiaomi.com';
const SYSTEMS: Record<string, string> = { V12: 'MIUI 12', V15: 'Xiaomi HyperOS', V17: 'Xiaomi HyperOS 3' };

function when(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso.replace(/\+0000$/, 'Z'));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** First readable text among the given keys of a loosely typed record. */
function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Rejection reasons come as an object of messages (empty when there are none). */
function reasons(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(reasons);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(reasons);
  return [];
}

export function PublishedThemes() {
  const designer = useStore((s) => s.designer);
  const project = useStore((s) => s.project);
  const { rows, loading, loaded, error } = usePublished();
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (designer?.signedIn && !loaded && !loading) void refreshPublished();
  }, [designer?.signedIn]);

  if (!designer) return null;

  const title = project?.title.trim().toLowerCase() ?? '';
  const isThis = (row: DesignerProductRow) => !!title && row.productName.trim().toLowerCase() === title;
  const sorted = [...rows].sort((a, b) => Number(isThis(b)) - Number(isThis(a)));

  return (
    <div className="section published">
      <div className="section-head">
        <h2>Published on Xiaomi Themes</h2>
        {designer.signedIn && (
          <div className="actions">
            <button className="btn btn-sm" onClick={() => void refreshPublished()} disabled={loading} title="Refresh">
              {loading ? <Loader2 className="spin" /> : <RefreshCw />} Refresh
            </button>
            <button className="btn btn-sm" onClick={() => void openUrl(`${STATION}/`)}>
              <ExternalLink /> Design Station
            </button>
          </div>
        )}
      </div>

      {!designer.signedIn ? (
        <div className="surface surface-pad published-empty">
          <CircleUserRound />
          <span className="grow muted">Sign in to see the themes you have published, their review status and versions.</span>
          <button className="btn btn-sm btn-primary" onClick={() => void signIn()}>Sign in</button>
        </div>
      ) : error ? (
        <div className="surface surface-pad published-empty">
          <span className="grow err">{error}</span>
          <button className="btn btn-sm" onClick={() => void refreshPublished()}>Try again</button>
        </div>
      ) : loaded && !rows.length ? (
        <div className="surface surface-pad published-empty">
          <span className="grow muted">Nothing published yet. When this theme is ready, use Publish above.</span>
        </div>
      ) : !loaded ? (
        <div className="surface surface-pad published-empty"><Loader2 className="spin" /> <span className="muted">Loading your themes…</span></div>
      ) : (
        <div className="surface published-list">
          {sorted.map((row) => (
            <ProductRow key={row.productId} row={row} mine={isThis(row)} open={open === row.productId} onToggle={() => setOpen(open === row.productId ? null : row.productId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductRow({ row, mine, open, onToggle }: { row: DesignerProductRow; mine: boolean; open: boolean; onToggle: () => void }) {
  const state = reviewState(row);
  const project = useStore((s) => s.project);
  const running = usePublish((s) => s.running);
  const [detail, setDetail] = useState<DesignerProductDetail | null>(null);
  const [versions, setVersions] = useState<DesignerVersionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setLoadError(null);
    try {
      const [d, v] = await Promise.all([api.designerProduct(row.productId), api.designerProductVersions(row.productId).catch(() => [])]);
      setDetail(d);
      setVersions(Array.isArray(v) ? v : []);
      return d;
    } catch (e) {
      setLoadError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open && !detail && !busy) void load();
  }, [open]);

  const updatable = canUpdate(row);
  const publishUpdate = async () => {
    const d = detail ?? (await load());
    if (d) startPublishing(d);
  };
  const updateTitle = !project
    ? 'Open the theme project first'
    : !updatable
      ? 'Xiaomi accepts a new version once the current review is finished'
      : `Upload the open project as a new version of ${row.productName}`;

  const why = reasons(detail?.refusalReason);
  const changeLog = detail?.changeLogList ?? [];
  const pack = detail?.originalThemePack;

  return (
    <div className={`published-row ${open ? 'is-open' : ''}`}>
      <button className="published-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown className="muted" /> : <ChevronRight className="muted" />}
        {row.showedSnapshot ? <img className="published-thumb" src={row.showedSnapshot} alt="" /> : <span className="published-thumb" />}
        <span className="published-name">
          <b>{row.productName}</b>
          {mine && <span className="badge">This theme</span>}
          <span className="muted">
            {[detail?.versionName ? `v${detail.versionName}` : null, SYSTEMS[row.auditMiuiVersion ?? ''] ?? row.auditMiuiVersion, row.auditType === 'UPDATE' ? 'update' : row.auditType === 'ADD' ? 'new theme' : null, when(row.updateTime)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className={`review-chip tone-${state.tone}`} title={state.hint}>{state.label}</span>
      </button>

      {open && (
        <div className="published-body">
          {busy && !detail ? (
            <div className="row muted"><Loader2 className="spin" /> Loading…</div>
          ) : loadError ? (
            <div className="err">{loadError}</div>
          ) : detail ? (
            <>
              {why.length > 0 && (
                <div className="publish-callout is-err">
                  <div>
                    <b>Why it was rejected</b>
                    {why.map((r, i) => <div key={i}>{r}</div>)}
                  </div>
                </div>
              )}
              <div className="published-facts">
                <div><span className="muted">Status</span>{state.label}<span className="field-hint">{state.hint}</span></div>
                <div><span className="muted">Version</span>{detail.versionName || '—'}</div>
                <div><span className="muted">Designer</span>{detail.designerName}{detail.authorName && detail.authorName !== detail.designerName ? ` · author ${detail.authorName}` : ''}</div>
                <div><span className="muted">Tags</span>{detail.tags?.length ? detail.tags.join(', ') : '—'}</div>
                <div><span className="muted">Created</span>{when(detail.createTime) || '—'}</div>
                <div><span className="muted">Proof of copyright</span>{detail.copyrightFilename ? decodeURIComponent(detail.copyrightFilename.replace(/\+/g, ' ')) : '—'}</div>
              </div>
              {detail.description && <p className="published-desc">{detail.description}</p>}

              <div className="published-sub">Versions</div>
              <ul className="published-versions">
                {pack && (
                  <li>
                    <span className="grow">
                      <b>{detail.versionName || 'Current'}</b> <span className="muted">· submitted package · {SYSTEMS[pack.miuiVersion ?? ''] ?? pack.miuiVersion}{pack.size ? ` · ${formatBytes(pack.size)}` : ''}</span>
                    </span>
                    {pack.downloadUri?.startsWith('https://') && (
                      <button className="btn btn-sm" onClick={() => void openUrl(pack.downloadUri!)}><Download /> .mtz</button>
                    )}
                  </li>
                )}
                {(versions ?? []).map((v, i) => (
                  <li key={`v${i}`}>
                    <span className="grow">
                      <b>{SYSTEMS[pick(v, ['miuiVersion', 'version'])] ?? (pick(v, ['miuiVersion', 'version']) || 'Package')}</b>{' '}
                      <span className="muted">{[pick(v, ['versionName']), pick(v, ['productStatus', 'auditState', 'state']), when(pick(v, ['updateTime', 'createTime']))].filter(Boolean).join(' · ')}</span>
                    </span>
                  </li>
                ))}
                {changeLog.map((c, i) => (
                  <li key={`c${i}`}>
                    <span className="grow">
                      <b>{pick(c, ['versionName', 'version']) || 'Update'}</b>{' '}
                      <span className="muted">{when(pick(c, ['createTime', 'updateTime', 'time']))}</span>
                      <div>{pick(c, ['changeLog', 'content', 'log', 'description'])}</div>
                    </span>
                  </li>
                ))}
                {!pack && !(versions ?? []).length && !changeLog.length && <li className="muted">No versions listed yet.</li>}
              </ul>
            </>
          ) : null}

          <div className="row published-actions">
            <button className="btn btn-sm btn-primary" disabled={!project || !updatable || running} title={updateTitle} onClick={() => void publishUpdate()}>
              <Send /> Publish new version…
            </button>
            <button className="btn btn-sm" onClick={() => void openUrl(`${STATION}/detail/${row.productId}/?productType=THEME`)}>
              <ExternalLink /> Open on Design Station
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
