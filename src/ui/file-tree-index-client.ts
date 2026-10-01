let refreshNeeded = false;
let revision = 0;

export function invalidateSharedFileIndex(): void {
  refreshNeeded = true;
  revision++;
}

/** One indexed file-list request instead of a request for every directory. */
export async function fetchSharedFileIndex(
  root: string,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<string[] | { error: string }> {
  const requestRevision = revision;
  const params = new URLSearchParams({ path: root });
  if (workspaceRoot) params.set('workspaceRoot', workspaceRoot);
  if (refreshNeeded) params.set('refresh', '1');
  try {
    const response = await fetch(`/api/brain/code/files?${params}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const data = await response.json() as { files?: string[]; error?: string };
    if (!response.ok || !Array.isArray(data.files)) {
      return { error: data.error || 'Could not search project files' };
    }
    if (revision === requestRevision) refreshNeeded = false;
    return data.files;
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not search project files' };
  }
}

/** Paint names before content completes; obsolete requests cannot paint either phase. */
export async function resolveFileTreeSearch(
  index: Promise<string[] | { error: string }>,
  content: Promise<string>,
  isCurrent: () => boolean,
  paintNames: (paths: string[]) => void,
): Promise<{ paths: string[]; content: string } | { error: string } | null> {
  const paths = await index;
  if (!isCurrent()) return null;
  if ('error' in paths) return paths;
  paintNames(paths);
  const result = await content;
  return isCurrent() ? { paths, content: result } : null;
}
