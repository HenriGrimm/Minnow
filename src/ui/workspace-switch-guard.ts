import { getOpenViewerTabPaths } from './file-viewer-tab-store';
import { setWorkspacePath } from '../config/workspace-api';
import {
  getCurrentWorkspaceInfo,
  isCurrentWindowWorkspace,
} from '../state/workspace';

let retargetInProgress = false;

/**
 * Switch this window's workspace.
 *
 * In a workspace-bound Electron window the switch is "tell main this view is now
 * folder X", and main replaces the view. Everything the old in-renderer teardown
 * rebuilt — file panel, terminal tabs, chats, issues — is persisted per workspace
 * on disk, so a fresh renderer is strictly safer than a partial reset.
 *
 * The browser and any older shell still have a single global workspace, so they
 * keep the in-place refresh.
 */
export async function executeWorkspaceSwitch(
  absPath: string,
): Promise<import('../config/workspace-api').WorkspaceInfo | null> {
  // Same folder, possibly different spelling — do not PUT or replace the view.
  if (isCurrentWindowWorkspace(absPath)) {
    return getCurrentWorkspaceInfo();
  }

  // Also taken by a window still at the folder gate: picking there has to bind
  // the view to the folder, not repoint a global.
  const retarget = window.minnow?.window?.switchWorkspace;
  if (retarget) {
    if (retargetInProgress) return null;
    retargetInProgress = true;
    const wasInert = document.body.inert;
    try {
      if (getOpenViewerTabPaths().length) {
        const { confirmWorkspaceDrafts } = await import('./file-viewer');
        if (!(await confirmWorkspaceDrafts())) return null;
      }
      // Prevent another keystroke from creating a draft while the requests are in flight.
      document.body.inert = true;
      const info = await setWorkspacePath(absPath);
      const result = await retarget(absPath);
      if (!result.ok) {
        const { setStatus } = await import('./status');
        setStatus('err', result.error);
        return null;
      }
      return info;
    } finally {
      document.body.inert = wasInert;
      retargetInProgress = false;
    }
  }

  const info = await setWorkspacePath(absPath);
  const { applyWorkspaceSwitch } = await import('./workspace-button');
  await applyWorkspaceSwitch(info);
  return info;
}
