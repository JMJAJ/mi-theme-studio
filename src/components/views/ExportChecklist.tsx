// "Is it ready?" in plain words, before export: what is fine, what will look
// wrong or be refused, why, and a button that takes you to the fix.
import { useEffect, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleX } from 'lucide-react';
import { api } from '../../lib/api';
import { formatBytes, plural } from '../../lib/format';
import type { MetadataView } from '../../lib/types';
import * as A from '../../state/actions';
import { formatVersion, useThemeCompatibility } from '../../state/compat';
import { useStore } from '../../state/store';

interface Check {
  state: 'ok' | 'warn' | 'bad';
  title: string;
  why: string;
  fix?: { label: string; run: () => void };
}

const field = (view: MetadataView | null, name: string) => view?.fields.find((f) => f.name === name && f.attributes.length === 0)?.value?.trim() || null;

export function ExportChecklist() {
  const project = useStore((s) => s.project)!;
  const validation = useStore((s) => s.validation);
  const [meta, setMeta] = useState<MetadataView | null | undefined>(undefined);
  const descRev = project.files.find((f) => f.path === 'description.xml')?.rev;
  useEffect(() => {
    api.metadataGet().then(setMeta).catch(() => setMeta(null));
  }, [descRev]);

  const compat = useThemeCompatibility();
  const has = (part: string) => project.files.some((f) => f.component === part);
  const parts = new Set(project.files.map((f) => f.component).filter((c) => !['other', 'previews'].includes(c)));
  const checks: Check[] = [];

  if (descRev === undefined) {
    checks.push({ state: 'bad', title: 'No theme details file', why: 'Every theme needs description.xml with its name; Theme Manager cannot list a package without it.', fix: { label: 'Add details', run: () => A.goTo('design', 'info') } });
  } else if (meta !== undefined) {
    const missing = [!field(meta, 'title') && 'name', !(field(meta, 'designer') ?? field(meta, 'author')) && 'designer', !field(meta, 'version') && 'version'].filter(Boolean) as string[];
    checks.push(
      missing.length
        ? { state: missing.includes('name') ? 'bad' : 'warn', title: `Theme details are missing: ${missing.join(', ')}`, why: 'These are shown in Theme Manager’s list and detail page. A theme without a name shows up blank.', fix: { label: 'Edit details', run: () => A.goTo('design', 'info') } }
        : { state: 'ok', title: 'Name, designer and version are filled in', why: 'This is what Theme Manager shows for the theme.' },
    );
  }

  checks.push(
    parts.size
      ? { state: 'ok', title: `Changes ${plural(parts.size, 'part')} of the phone`, why: 'The theme has something to apply.' }
      : { state: 'bad', title: 'The theme is empty', why: 'It has no wallpapers, icons, fonts or other parts yet, so applying it changes nothing.', fix: { label: 'Add parts', run: () => A.goTo('design') } },
  );

  checks.push(
    has('previews')
      ? { state: 'ok', title: 'Has preview pictures', why: 'Theme Manager shows these as the theme’s cover and screenshots.' }
      : { state: 'warn', title: 'No preview pictures', why: 'Without files in preview/ the theme has a blank cover in Theme Manager. It still applies.', fix: { label: 'Add previews', run: () => A.goTo('design', 'previews') } },
  );

  if (!validation) {
    checks.push({ state: 'warn', title: 'Not checked for broken files yet', why: 'Validation looks for invalid XML, damaged images and layout files that point at missing pictures.', fix: { label: 'Check now', run: () => void A.runValidation(false) } });
  } else if (validation.errors) {
    checks.push({ state: 'bad', title: `${plural(validation.errors, 'error')} in the files`, why: 'Broken XML or images can make a part fail to apply, or the whole theme be refused. The list is under Problems below.', fix: { label: 'Check again', run: () => void A.runValidation(false) } });
  } else {
    checks.push({
      state: validation.warnings ? 'warn' : 'ok',
      title: validation.warnings ? `No errors, ${plural(validation.warnings, 'warning')}` : 'No broken files found',
      why: validation.warnings ? 'Warnings usually still apply, but are worth a look under Problems below.' : `${plural(validation.checkedFiles, 'file')} checked, including XML and image headers.`,
    });
  }

  if (compat) {
    checks.push(
      compat.supported
        ? { state: 'ok', title: 'Fits the connected phone', why: compat.deviceFormat !== null ? `The phone supports theme format ${formatVersion(compat.deviceFormat)}${compat.themeUiVersion !== null ? `; this theme is ${compat.themeUiVersion}` : ''}.` : 'The phone did not report a theme format, so nothing to compare.' }
        : { state: 'warn', title: 'Made for a newer system than the connected phone', why: `Theme format ${compat.themeUiVersion ?? '?'}, the phone supports up to ${formatVersion(compat.deviceFormat)}. Parts built for the newer format may be refused or look wrong there. Phones on newer systems are fine.`, fix: { label: 'Theme details', run: () => A.goTo('design', 'info') } },
    );
  }

  const big = project.totalBytes > 150 * 1024 * 1024;
  checks.push({
    state: big ? 'warn' : 'ok',
    title: `Package size ${formatBytes(project.totalBytes)}`,
    why: big ? 'Very large themes are slow to copy and apply. Oversized wallpapers and sounds are the usual cause.' : 'A normal size for a theme.',
  });

  const bad = checks.filter((c) => c.state === 'bad').length;
  const warn = checks.filter((c) => c.state === 'warn').length;

  return (
    <div className="section checklist">
      <div className="section-head">
        <h2>Ready to export?</h2>
        <span className={bad ? 'err' : warn ? 'warn' : 'ok'}>{bad ? `${plural(bad, 'thing')} to fix first` : warn ? `Yes, with ${plural(warn, 'note')}` : 'Yes, everything looks fine'}</span>
      </div>
      <div className="surface checklist-list">
        {checks.map((c) => (
          <div key={c.title} className="checklist-row">
            {c.state === 'ok' ? <CircleCheck className="ok" /> : c.state === 'warn' ? <AlertTriangle className="warn" /> : <CircleX className="err" />}
            <div className="grow">
              <div className="checklist-title">{c.title}</div>
              <div className="muted">{c.why}</div>
            </div>
            {c.fix && (
              <button className="btn btn-sm" onClick={c.fix.run}>
                {c.fix.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
