// Loads a font file from a package so text can be shown in the theme's real
// typeface (part cards, the swap dialog, the phone mock-ups).
import { useEffect, useState } from 'react';
import { resourceUrl } from '../../lib/api';
import type { FileInfo, Slot } from '../../lib/types';

let seq = 0;

/** The font a theme sets as the system font, if it ships one. */
export function themeFontFile(files: FileInfo[]) {
  const fonts = files.filter((f) => f.kind === 'font' && f.component === 'fonts');
  return fonts.find((f) => /regular/i.test(f.path)) ?? fonts[0];
}

/**
 * `family` is a CSS font-family value once the font is ready, `failed` is true
 * when the webview could not render the file (it stays in the package).
 */
export function usePackageFont(file: FileInfo | undefined, slot: Slot = 'main') {
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFamily(null);
    setFailed(false);
    if (!file) return;
    let cancelled = false;
    const name = `mts-theme-font-${++seq}`;
    // "&font" keeps this request apart from any copy cached before fonts were allowed cross-origin.
    const face = new FontFace(name, `url("${resourceUrl(slot, file.path, file.rev)}&font")`);
    face
      .load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setFamily(`"${name}"`);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [file?.path, file?.rev, slot]);
  return { family, failed };
}
