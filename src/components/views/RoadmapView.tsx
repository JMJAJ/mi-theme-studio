import { CircleCheck, CircleDashed, CircleDot } from 'lucide-react';

type Status = 'done' | 'partial' | 'planned';

const ITEMS: { area: string; items: [Status, string, string?][] }[] = [
  {
    area: 'Package editing',
    items: [
      ['done', 'Open .mtz/.zip safely', 'Size limits, unsafe paths skipped and reported, nested component archives expanded.'],
      ['done', 'Explorer, component views, rename/move/duplicate/delete', 'Multi-select, context menus, drag to move, drop files from Windows.'],
      ['done', 'description.xml editor', 'Preserves comments, order and unknown fields.'],
      ['done', 'XML/text editor, image viewer, font preview'],
      ['done', 'Undo/redo with history, unsaved indicators, autosave recovery copy'],
      ['done', 'Save/export with verification and backups; package report'],
      ['done', 'Validation: XML syntax, image headers, MAML image references, component layout'],
      ['partial', 'Reference package and resource copy', 'Local .mtz files and supported Theme Manager cache modules work; unsupported cache types may be omitted with warnings.'],
      ['planned', 'MAML runtime preview for lock screens, clocks and widgets'],
      ['planned', 'Nine-patch editor and icon mask tools'],
      ['planned', 'Round-trip checks against representative MIUI/HyperOS sample packages'],
    ],
  },
  {
    area: 'Device (ADB)',
    items: [
      ['done', 'Native adb discovery, device list and states', 'No ADB, unauthorized, offline and multiple-device cases are reported.'],
      ['done', 'Device details', 'Model, HyperOS/MIUI and Android versions, resolution, density, Theme Manager version.'],
      ['done', 'Browse Theme Manager cached themes and local previews over ADB', 'Opening a theme loads supported cached modules into a read-only reference; rights records and the phone remain untouched.'],
      ['done', 'Screenshots with timeout and cancellation; optional periodic refresh (not a live stream)'],
      ['done', 'Copy package to device with explicit confirmation and size verification'],
      ['planned', 'Live screen mirroring (e.g. scrcpy integration)'],
      ['planned', 'Apply a theme on the device', 'Needs a supported, verified Theme Manager flow and a way back to the previous theme. Not attempted.'],
    ],
  },
  {
    area: 'Online themes',
    items: [
      ['done', 'Browse public catalog shelves, quick links and category cards', 'Read-only, anonymous, loaded only on request.'],
      ['planned', 'Theme listings inside shelves', 'Verified calls return shelves without products; needs a confirmed product-list request.'],
      ['planned', 'Theme details and downloads', 'Not implemented until a product ID and download flow are verified. Paid/DRM rights checks are never bypassed.'],
      ['done', 'Open supported themes already cached on a connected phone as a read-only reference', 'Selected files copied into a project include theme title and author attribution.'],
      ['planned', 'Open a theme downloaded directly from the online catalog as a reference'],
    ],
  },
];

const ICON = { done: CircleCheck, partial: CircleDot, planned: CircleDashed };
const LABEL = { done: 'Available', partial: 'Partial', planned: 'Planned' };
const BADGE = { done: 'badge-ok', partial: 'badge-warn', planned: 'badge-outline' };

export function RoadmapView() {
  return (
    <div className="view">
      <div className="view-pad" style={{ maxWidth: 920 }}>
        <div className="view-header">
          <div>
            <h1>Roadmap & limitations</h1>
            <div className="sub">What this build can do today, and what is planned. Planned items have no active controls in the app.</div>
          </div>
        </div>
        {ITEMS.map((group) => (
          <div key={group.area} className="section">
            <div className="section-head">
              <h2>{group.area}</h2>
            </div>
            <div className="surface">
              {group.items.map(([status, title, note]) => {
                const Icon = ICON[status];
                return (
                  <div key={title} className="shelf-row" style={{ alignItems: 'flex-start' }}>
                    <Icon width={15} className={status === 'done' ? 'ok' : status === 'partial' ? 'warn' : 'faint'} style={{ marginTop: 2, flex: 'none' }} />
                    <div className="grow">
                      <div>{title}</div>
                      {note && <div className="muted" style={{ fontSize: 13 }}>{note}</div>}
                    </div>
                    <span className={`badge ${BADGE[status]}`}>{LABEL[status]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
