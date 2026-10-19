/** Workspace selection for phones, refreshed on every opening. */
import { fetchWorkspace } from '../config/workspace-api';
import { getWorkspacePath } from '../state/workspace';
import { showToast } from '../ui/toast';
import { pickFromSheet } from './sheet';

let switching = false;

export async function switchWorkspaceFromSheet(): Promise<void> {
  if (switching) return;
  switching = true;
  try {
    const info = await fetchWorkspace();
    if (!info) throw new Error('Unable to load workspaces. Check your connection and try again.');
    const rows = [...(info.sandbox ? [info.sandbox] : []), ...(info.recent ?? [])]
      .filter((item, index, all) => item.exists && all.findIndex((other) => other.path === item.path) === index);
    const picked = await pickFromSheet('Workspace', [
      ...rows.map((item) => ({
        value: item.path,
        label: item.label,
        description: item.path,
        glyph: 'fi-rr-folder',
        selected: item.path === getWorkspacePath(),
      })),
      { value: '', label: 'Browse folders…', glyph: 'fi-rr-folder-open' },
    ]);
    if (picked === null) return;
    let path = picked;
    if (!path) {
      const { openWorkspaceFolderPicker } = await import('../ui/workspace-folder-picker');
      const result = await openWorkspaceFolderPicker({ initialPath: getWorkspacePath() || undefined, elevated: true });
      if (result.cancelled || !result.path) return;
      path = result.path;
    }
    if (path === getWorkspacePath()) return;
    const { executeWorkspaceSwitch } = await import('../ui/workspace-switch-guard');
    await executeWorkspaceSwitch(path);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    switching = false;
  }
}
