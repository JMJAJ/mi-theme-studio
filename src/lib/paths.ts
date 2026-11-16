// Package path helpers; mirrors src-tauri/src/package/paths.rs.
// Files inside component archives are addressed as `outer!/inner/path`.

export const NESTED_SEP = '!/';

export function splitNested(path: string): [string, string | null] {
  const index = path.indexOf(NESTED_SEP);
  return index === -1 ? [path, null] : [path.slice(0, index), path.slice(index + NESTED_SEP.length)];
}

export function fileName(path: string): string {
  const [outer, inner] = splitNested(path);
  const tail = inner ?? outer;
  const parts = tail.split('/');
  return parts[parts.length - 1] || tail;
}

/** Parent folder; `icons!/` for direct children of a component archive. */
export function parentOf(path: string): string {
  const [outer, inner] = splitNested(path);
  if (inner !== null) {
    const index = inner.lastIndexOf('/');
    return index === -1 ? `${outer}${NESTED_SEP}` : `${outer}${NESTED_SEP}${inner.slice(0, index)}`;
  }
  const index = outer.lastIndexOf('/');
  return index === -1 ? '' : outer.slice(0, index);
}

export function joinPath(folder: string, name: string): string {
  if (!folder) return name;
  if (folder.endsWith(NESTED_SEP) || folder.endsWith('/')) return `${folder}${name}`;
  return `${folder}/${name}`;
}

export function extension(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** Human readable location, e.g. `icons ▸ res/drawable-xxhdpi`. */
export function displayFolder(folder: string): string {
  if (!folder) return 'Package root';
  const [outer, inner] = splitNested(folder);
  if (inner === null) return folder.endsWith(NESTED_SEP) ? `${folder.slice(0, -2)} ▸` : outer;
  return inner ? `${outer} ▸ ${inner}` : `${outer} ▸`;
}

/** Normalise a folder key: a component name becomes `name!/`. */
export function folderKey(path: string, isContainer: boolean): string {
  return isContainer ? `${path}${NESTED_SEP}` : path;
}

const INVALID = /[\\/:*?"<>|\u0000-\u001f]/;

export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed === '.' || trimmed === '..') return 'This name is reserved.';
  const bad = trimmed.match(INVALID);
  if (bad) return `The character “${bad[0]}” is not allowed.`;
  if (trimmed.endsWith('!')) return 'Names cannot end with “!”.';
  return null;
}
