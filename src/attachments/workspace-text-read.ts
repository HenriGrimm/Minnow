/**
 * Loads workspace text file content via the preview file API (no agent output cap).
 */

import { resolvePreviewLoadUrl } from '../ui/preview-load-url';

/** Parse byte size from get_file_metadata tool output. */
export function parseGetFileMetadataSize(metadata: string): number | null {
  const match = metadata.match(/^size:\s*(\d+)\s*bytes/m);
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isFinite(size) ? size : null;
}

/**
 * Fetches a workspace UTF-8 text file through GET /api/preview/file/…?raw=1.
 * Raw skips HTML `<base>` injection so the file viewer edits the true on-disk bytes.
 * `cacheBust` is sent as `?v=` to skip a stale cached 404 after a just-written file.
 */
export async function readWorkspaceTextFile(
  path: string,
  workspaceRoot?: string,
  cacheBust?: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = resolvePreviewLoadUrl(
    { kind: 'workspace', path },
    cacheBust,
    workspaceRoot,
    { raw: true },
  );
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`Could not read file (HTTP ${res.status})`);
  }
  return res.text();
}
