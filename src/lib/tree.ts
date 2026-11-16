// Builds the explorer tree from a flat snapshot.
import type { ContainerInfo, FileInfo } from './types';
import { NESTED_SEP, parentOf, splitNested } from './paths';

export type TreeNodeType = 'folder' | 'container' | 'file';

export interface TreeNode {
  /** Selection/operation key: file path, folder path, or container name. */
  key: string;
  /** Folder key used as destination when dropping/adding into this node. */
  folder: string;
  name: string;
  type: TreeNodeType;
  file?: FileInfo;
  container?: ContainerInfo;
  children: TreeNode[];
  fileCount: number;
  bytes: number;
  changed: boolean;
}

function sortNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    const rank = (n: TreeNode) => (n.type === 'file' ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  for (const node of nodes) if (node.children.length) sortNodes(node.children);
}

export function buildTree(files: FileInfo[], containers: ContainerInfo[]): TreeNode[] {
  const root: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const containerMap = new Map(containers.map((c) => [c.name, c]));

  const ensureFolder = (key: string, name: string, parent: TreeNode[], type: TreeNodeType = 'folder'): TreeNode => {
    let node = index.get(key);
    if (!node) {
      node = {
        key,
        folder: type === 'container' ? `${key}${NESTED_SEP}` : key,
        name,
        type,
        container: type === 'container' ? containerMap.get(key) : undefined,
        children: [],
        fileCount: 0,
        bytes: 0,
        changed: type === 'container' ? containerMap.get(key)?.status !== 'original' : false,
      };
      index.set(key, node);
      parent.push(node);
    }
    return node;
  };

  for (const container of containers) ensureFolder(container.name, container.name, root, 'container');

  for (const file of files) {
    const [outer, inner] = splitNested(file.path);
    let siblings = root;
    const trail: TreeNode[] = [];
    let segments: string[];
    let prefix = '';
    if (inner !== null) {
      const container = ensureFolder(outer, outer, root, 'container');
      trail.push(container);
      siblings = container.children;
      segments = inner.split('/');
      prefix = `${outer}${NESTED_SEP}`;
    } else {
      segments = outer.split('/');
    }
    for (let i = 0; i < segments.length - 1; i += 1) {
      const key = `${prefix}${segments.slice(0, i + 1).join('/')}`;
      const folder = ensureFolder(key, segments[i], siblings);
      trail.push(folder);
      siblings = folder.children;
    }
    const changed = file.status !== 'original';
    siblings.push({
      key: file.path,
      folder: parentOf(file.path),
      name: segments[segments.length - 1],
      type: 'file',
      file,
      children: [],
      fileCount: 1,
      bytes: file.size,
      changed,
    });
    for (const node of trail) {
      node.fileCount += 1;
      node.bytes += file.size;
      if (changed) node.changed = true;
    }
  }
  sortNodes(root);
  return root;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Visible rows for a virtualised tree. With `forceExpand`, every folder is open (used while filtering). */
export function flattenTree(nodes: TreeNode[], expanded: Set<string>, forceExpand = false, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const node of nodes) {
    const isOpen = node.type !== 'file' && (forceExpand || expanded.has(node.key));
    out.push({ node, depth, expanded: isOpen });
    if (isOpen) flattenTree(node.children, expanded, forceExpand, depth + 1, out);
  }
  return out;
}

/** Keep only nodes matching `predicate` (and their ancestors). */
export function filterTree(nodes: TreeNode[], predicate: (file: FileInfo) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.file && predicate(node.file)) out.push(node);
    } else {
      const children = filterTree(node.children, predicate);
      if (children.length) out.push({ ...node, children });
    }
  }
  return out;
}

/** All folder destinations (for "move to" pickers). */
export function folderOptions(nodes: TreeNode[], out: { key: string; label: string; depth: number }[] = [], depth = 0) {
  for (const node of nodes) {
    if (node.type === 'file') continue;
    out.push({ key: node.folder, label: node.name, depth });
    folderOptions(node.children, out, depth + 1);
  }
  return out;
}
