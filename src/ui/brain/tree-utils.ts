import type { BrainPageMeta, BrainTreeNode } from '../../brain/types';

/** Whether a page path is under workspaces/<key>/archive/. */
export function isBrainArchivePagePath(relPath: string): boolean {
  return /\/workspaces\/[^/]+\/archive\//.test(relPath.replace(/\\/g, '/'));
}

/** Legacy wiki view: exclude agent memories, and archives unless requested. */
export function filterBrainTreeForDisplay(
  tree: BrainTreeNode | Record<string, BrainTreeNode> | null | undefined,
  showArchives: boolean,
): Record<string, BrainTreeNode> {
  if (!tree || typeof tree !== 'object') {
    return (tree ?? {}) as Record<string, BrainTreeNode>;
  }

  const walk = (
    node: BrainTreeNode | Record<string, BrainTreeNode>,
  ): BrainTreeNode | Record<string, BrainTreeNode> | null => {
    if ('type' in node && node.type === 'page') {
      const isMemory = node.path.replace(/\\/g, '/').startsWith('memory/');
      return isMemory || (!showArchives && isBrainArchivePagePath(node.path)) ? null : node;
    }
    if ('type' in node && node.type === 'folder' && node.children) {
      const children: Record<string, BrainTreeNode> = {};
      for (const [key, child] of Object.entries(node.children)) {
        const next = walk(child);
        if (next) children[key] = next as BrainTreeNode;
      }
      return Object.keys(children).length
        ? { type: 'folder', children }
        : null;
    }
    const out: Record<string, BrainTreeNode> = {};
    for (const [key, child] of Object.entries(node)) {
      if (!child || typeof child !== 'object') continue;
      const next = walk(child as BrainTreeNode);
      if (next) out[key] = next as BrainTreeNode;
    }
    return Object.keys(out).length ? out : null;
  };

  const filtered = walk(tree);
  return (filtered && typeof filtered === 'object' ? filtered : {}) as Record<
    string,
    BrainTreeNode
  >;
}

/** Flatten tree nodes into page metadata rows (for backlinks). */
export function flattenBrainTree(
  tree: BrainTreeNode | Record<string, BrainTreeNode> | null | undefined,
): BrainPageMeta[] {
  const pages: BrainPageMeta[] = [];
  if (!tree || typeof tree !== 'object') return pages;

  const walk = (node: BrainTreeNode | Record<string, BrainTreeNode>): void => {
    if ('type' in node && node.type === 'page') {
      pages.push(node);
      return;
    }
    if ('type' in node && node.type === 'folder' && node.children) {
      for (const child of Object.values(node.children)) {
        walk(child);
      }
      return;
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') walk(child as BrainTreeNode);
    }
  };

  walk(tree);
  return pages;
}

/** Compute inbound wikilink paths for a target page path. */
export function computeBrainBacklinks(
  pages: BrainPageMeta[],
  targetPath: string,
): string[] {
  const key = targetPath.replace(/\\/g, '/').replace(/\.md$/i, '');
  const inbound = new Set<string>();
  for (const page of pages) {
    for (const link of page.links ?? []) {
      const normalized = link.replace(/\\/g, '/').replace(/\.md$/i, '');
      if (normalized === key) inbound.add(page.path);
    }
  }
  return [...inbound].sort();
}
