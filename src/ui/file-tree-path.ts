export function normalizeTreePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '') || '.';
}

/** Join parent directory and entry name. */
export function joinTreePath(parent: string, name: string): string {
  const base = parent === '.' || parent === '' ? '' : normalizeTreePath(parent);
  const child = name.trim();
  if (!child) return base || '.';
  return base ? `${base}/${child}` : child;
}

/** Parent directory of a file or folder path. */
export function dirname(treePath: string): string {
  const normalized = normalizeTreePath(treePath);
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '.';
  return normalized.slice(0, idx);
}

/** Final path segment (file or folder name). */
export function basename(treePath: string): string {
  const normalized = normalizeTreePath(treePath);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/** True when `descendant` is `ancestor` or nested under it. */
export function isAncestorPath(ancestor: string, descendant: string): boolean {
  const a = normalizeTreePath(ancestor);
  const d = normalizeTreePath(descendant);
  if (a === d) return true;
  return d.startsWith(`${a}/`);
}

/** Remove expanded paths that were deleted or live under a deleted directory. */
export function pruneExpandedDirs(expandedDirs: string[], removedPath: string): string[] {
  const norm = normalizeTreePath(removedPath);
  return expandedDirs.filter((p) => {
    const ep = normalizeTreePath(p);
    return ep !== norm && !isAncestorPath(norm, ep);
  });
}

/** Remap expanded dir paths after rename/move of a file or folder. */
export function remapExpandedDirs(
  expandedDirs: string[],
  oldPath: string,
  newPath: string | null,
): string[] {
  const oldNorm = normalizeTreePath(oldPath);
  if (newPath === null) {
    return pruneExpandedDirs(expandedDirs, oldPath);
  }
  const newNorm = normalizeTreePath(newPath);
  return expandedDirs.map((p) => {
    const ep = normalizeTreePath(p);
    if (ep === oldNorm) return newNorm;
    if (isAncestorPath(oldNorm, ep)) {
      return newNorm + ep.slice(oldNorm.length);
    }
    return p;
  });
}

/** Destination path for moving `source` into folder `destDir`. */
export function computeMoveDestination(source: string, destDir: string): string | null {
  const src = normalizeTreePath(source);
  const dest = normalizeTreePath(destDir);
  const parent = dirname(src);

  if (dest === parent) return null;
  if (dest === src) return null;
  if (isAncestorPath(src, dest)) return null;

  return joinTreePath(dest, basename(src));
}

/**
 * Drop entries that live under another entry in the same list. A batch delete or
 * move of a folder already takes its children with it, so the follow-up op on the
 * child would fail against a path that no longer exists.
 */
export function dropNestedEntries<T extends { path: string }>(entries: T[]): T[] {
  const normalized = entries.map((entry) => normalizeTreePath(entry.path));
  return entries.filter((_, i) =>
    !normalized.some((other, j) => j !== i && other !== normalized[i]! && isAncestorPath(other, normalized[i]!)),
  );
}

/** Directory to paste into when focus is on a file or folder row. */
export function pasteTargetDirForPath(path: string, kind: 'file' | 'dir'): string {
  return kind === 'dir' ? path : dirname(path);
}

/** Validate a single path segment for create/rename prompts. */
export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  return true;
}
