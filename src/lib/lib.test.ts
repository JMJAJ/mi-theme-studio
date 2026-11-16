import { describe, expect, it } from 'vitest';
import { displayFolder, extension, fileName, joinPath, parentOf, splitNested, validateName } from './paths';
import { buildTree, filterTree, flattenTree, folderOptions } from './tree';
import { formatBytes, plural, relativeTime } from './format';
import { matches, parseShortcut } from './shortcuts';
import type { ContainerInfo, FileInfo } from './types';

function file(path: string, extra: Partial<FileInfo> = {}): FileInfo {
  return {
    path,
    size: 10,
    kind: 'image',
    component: 'other',
    format: 'PNG',
    width: 1,
    height: 1,
    ninePatch: false,
    density: null,
    status: 'original',
    rev: 1,
    compression: 'deflated',
    ...extra,
  };
}

describe('paths', () => {
  it('splits and joins nested paths', () => {
    expect(splitNested('icons!/res/a.png')).toEqual(['icons', 'res/a.png']);
    expect(splitNested('wallpaper/a.jpg')).toEqual(['wallpaper/a.jpg', null]);
    expect(fileName('icons!/res/a.png')).toBe('a.png');
    expect(parentOf('icons!/res/a.png')).toBe('icons!/res');
    expect(parentOf('icons!/a.png')).toBe('icons!/');
    expect(parentOf('description.xml')).toBe('');
    expect(joinPath('icons!/', 'a.png')).toBe('icons!/a.png');
    expect(joinPath('wallpaper', 'a.png')).toBe('wallpaper/a.png');
    expect(extension('a/bg.9.png')).toBe('png');
    expect(displayFolder('icons!/res')).toBe('icons ▸ res');
    expect(displayFolder('')).toBe('Package root');
  });

  it('validates names like the backend', () => {
    expect(validateName('ok.png')).toBeNull();
    expect(validateName('a/b')).not.toBeNull();
    expect(validateName('..')).not.toBeNull();
    expect(validateName('what?.png')).not.toBeNull();
    expect(validateName('  ')).not.toBeNull();
  });
});

describe('tree', () => {
  const containers: ContainerInfo[] = [
    { name: 'icons', component: 'icons', files: 2, bytes: 20, status: 'modified', originalBytes: 100 },
  ];
  const files = [
    file('description.xml', { kind: 'xml' }),
    file('icons!/res/drawable-xxhdpi/b.png'),
    file('icons!/res/drawable-xxhdpi/a.png', { status: 'added' }),
    file('wallpaper/default_wallpaper.jpg'),
  ];

  it('builds folders, containers and counts', () => {
    const tree = buildTree(files, containers);
    expect(tree.map((n) => n.name)).toEqual(['icons', 'wallpaper', 'description.xml']);
    const icons = tree[0];
    expect(icons.type).toBe('container');
    expect(icons.folder).toBe('icons!/');
    expect(icons.fileCount).toBe(2);
    expect(icons.changed).toBe(true);
    const drawable = icons.children[0].children[0];
    expect(drawable.key).toBe('icons!/res/drawable-xxhdpi');
    expect(drawable.children.map((n) => n.name)).toEqual(['a.png', 'b.png']);
  });

  it('flattens only expanded nodes and filters', () => {
    const tree = buildTree(files, containers);
    expect(flattenTree(tree, new Set()).length).toBe(3);
    expect(flattenTree(tree, new Set(['icons'])).length).toBe(4);
    expect(flattenTree(tree, new Set(), true).length).toBe(8);
    const filtered = filterTree(tree, (f) => f.status === 'added');
    expect(flattenTree(filtered, new Set(), true).map((r) => r.node.name)).toEqual(['icons', 'res', 'drawable-xxhdpi', 'a.png']);
    expect(folderOptions(tree).map((o) => o.key)).toContain('icons!/res/drawable-xxhdpi');
  });
});

describe('format', () => {
  it('formats values', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'file')).toBe('2 files');
    expect(relativeTime(1000, 3000)).toBe('just now');
    expect(relativeTime(0, 120_000)).toBe('2 min ago');
  });
});

describe('shortcuts', () => {
  const ev = (key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}, code?: string) => ({
    key,
    code,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });
  it('matches modifiers exactly', () => {
    expect(parseShortcut('Ctrl+Shift+S')).toEqual({ ctrl: true, shift: true, alt: false, key: 's' });
    expect(matches('Ctrl+S', ev('s', { ctrl: true }))).toBe(true);
    expect(matches('Ctrl+S', ev('S', { ctrl: true, shift: true }))).toBe(false);
    expect(matches('Ctrl+Shift+S', ev('S', { ctrl: true, shift: true }))).toBe(true);
    expect(matches('F2', ev('F2'))).toBe(true);
    expect(matches('Ctrl+/', ev('?', { ctrl: true, shift: false }, 'Slash'))).toBe(true);
    expect(matches('Delete', ev('Delete'))).toBe(true);
  });
});

describe('interface zoom', () => {
  it('steps through presets and clamps', async () => {
    const { stepZoom, clampZoom, MIN_ZOOM, MAX_ZOOM } = await import('../state/zoom');
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('matches zoom keys by physical key', () => {
    const key = (k: string, code: string, shift = false) => ({ key: k, code, ctrlKey: true, metaKey: false, shiftKey: shift, altKey: false });
    expect(matches('Ctrl+=', key('=', 'Equal'))).toBe(true);
    expect(matches('Ctrl+Shift+=', key('+', 'Equal', true))).toBe(true);
    expect(matches('Ctrl+-', key('-', 'Minus'))).toBe(true);
    expect(matches('Ctrl+NumpadAdd', key('+', 'NumpadAdd'))).toBe(true);
    expect(matches('Ctrl+0', key('0', 'Digit0'))).toBe(true);
    expect(parseShortcut('Ctrl++').key).toBe('+');
  });
});

describe('nine-patch math', () => {
  it('normalizes ranges and stretches segments', async () => {
    const { normalizeRanges, stretchSegments } = await import('../components/views/NinePatchEditor');
    expect(normalizeRanges([[5, 3], [1, 2], [2, 4], [9, 20], [7, 7]], 10)).toEqual([[1, 5], [9, 10]]);
    const segs = stretchSegments([[2, 4]], 6, 10);
    expect(segs.map((s) => [s.from, s.to, s.stretch, s.destLen])).toEqual([
      [0, 2, false, 2],
      [2, 4, true, 6],
      [4, 6, false, 2],
    ]);
    // Two stretch areas share the free space by their source size.
    const two = stretchSegments([[0, 1], [3, 6]], 6, 14);
    expect(two.filter((s) => s.stretch).map((s) => s.destLen)).toEqual([3, 9]);
  });
});
