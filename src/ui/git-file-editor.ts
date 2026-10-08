import { gitFileDiff } from '../state/git-api';

let requestGeneration = 0;

/** Fetch both versions before opening the full file in CodeMirror. */
export async function openGitFileEditor(options: { path: string; staged: boolean; cwd?: string }): Promise<
  { ok: true } | { ok: false; cancelled?: boolean; error?: string }
> {
  const request = ++requestGeneration;
  const isCurrent = () => request === requestGeneration;
  const result = await gitFileDiff({ path: options.path, cached: options.staged, cwd: options.cwd });
  if (!isCurrent()) return { ok: false, cancelled: true };
  if (!result.ok) return { ok: false, error: result.error };
  const viewer = await import('./file-viewer');
  if (!isCurrent()) return { ok: false, cancelled: true };
  if (result.binary) {
    await viewer.openFileInViewer(options.path);
    return { ok: true };
  }
  const opened = await viewer.openGitFileInEditor({ ...options,
    before: result.before ?? '', after: result.after ?? '', deleted: result.deleted, isCurrent });
  return opened ? { ok: true } : { ok: false, cancelled: true };
}
