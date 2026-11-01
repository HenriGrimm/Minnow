import { isMinnowElectronShell } from '../tools/minnow-shell';
import { isLocalServerAvailable } from '../tools/config';
import { buildFileTreeToolContext } from './file-tree-listing-root';
import { setStatus } from './status';

export interface RevealInSystemExplorerResult {
  ok: boolean;
  message: string;
}

function isElectronHostRevealAvailable(): boolean {
  return (
    isMinnowElectronShell() &&
    typeof window.minnow?.shell?.revealInExplorer === 'function'
  );
}

/** POST /api/workspace/reveal-in-explorer for the given tree path. */
export async function revealPathInSystemExplorer(
  workspaceRelativePath: string,
  cwd?: string,
): Promise<RevealInSystemExplorerResult> {
  const trimmed = workspaceRelativePath?.trim();
  if (!trimmed) {
    const message = 'Path is required';
    setStatus('err', message);
    return { ok: false, message };
  }

  if (!isLocalServerAvailable()) {
    const message = 'Open Minnow to open paths in the system explorer.';
    setStatus('err', message);
    return { ok: false, message };
  }

  const useHostShell = isElectronHostRevealAvailable();

  try {
    const workspaceRoot = cwd ?? buildFileTreeToolContext().workspaceRoot;
    const response = await fetch('/api/workspace/reveal-in-explorer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: trimmed,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(useHostShell ? { openViaHostShell: true } : {}),
      }),
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; path?: string; kind?: 'file' | 'dir' }
      | null;

    if (!response.ok || !data?.ok) {
      const message =
        (data && typeof data.error === 'string' && data.error) ||
        `Could not open in system explorer (${response.status})`;
      setStatus('err', message);
      return { ok: false, message };
    }

    if (useHostShell && data.path && (data.kind === 'file' || data.kind === 'dir')) {
      const hostResult = await window.minnow!.shell!.revealInExplorer(data.path, data.kind);
      if (!hostResult.ok) {
        const message = hostResult.error || 'Could not open in system explorer';
        setStatus('err', message);
        return { ok: false, message };
      }
    }

    return { ok: true, message: 'Opened in system explorer' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
    return { ok: false, message };
  }
}
