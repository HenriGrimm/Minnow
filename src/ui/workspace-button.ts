import { isOsShellEnabled } from '../os/page-bridge';
import type { WorkspaceInfo } from '../config/workspace-api';
import { executeWorkspaceSwitch, dismissBoardViewOutsideWorkspace } from './workspace-switch-guard';
import {
  getWorkspacePath,
  loadWorkspaceFromServer,
  setWorkspaceFromServer,
} from '../state/workspace';
import { getLocalServerAvailable } from '../tools/client';
import { clearCachesForWorkspace } from '../tools/result-cache';
import { setStatus } from './status';
import { applyWorkspaceScopedSession } from './sidebar';
import { openWorkspaceFolderPicker } from './workspace-folder-picker';
import { bindShellOverlayTrigger, closeShellOverlay, isShellOverlayOpen } from './shell-overlay-state';
import {
  closeWorkspaceMenu,
  configureWorkspaceRecentMenu,
  setWorkspaceMenuDeps,
  toggleWorkspaceMenu,
} from './workspace-recent-menu';

function getWorkspaceButton(): HTMLButtonElement | null {
  return document.getElementById('btnWorkspace') as HTMLButtonElement | null;
}

function getWorkspacePathLabel(): HTMLElement | null {
  return document.getElementById('workspacePathLabel');
}

/** Reflect current workspace on the top bar button and folder name label. */
export function updateWorkspaceButtonLabel(label: string, fullPath: string): void {
  const btn = getWorkspaceButton();
  if (!btn) return;
  const short = label.trim() || 'Workspace';
  const path = fullPath.trim();
  const pathTooltip = path || 'Choose workspace folder';
  btn.title = pathTooltip;
  btn.setAttribute('aria-label', `Workspace: ${short}. Click to open recent workspaces.`);
  btn.setAttribute('aria-haspopup', isOsShellEnabled() ? 'dialog' : 'menu');

  const pathLabel = getWorkspacePathLabel();
  const control = (pathLabel?.closest('.workspace-control') as HTMLElement | null) ?? null;
  if (!pathLabel) return;
  if (path) {
    pathLabel.textContent = short;
    pathLabel.title = path;
    pathLabel.hidden = false;
    btn.setAttribute('aria-describedby', 'workspacePathLabel');
    if (control) control.title = path;
  } else {
    pathLabel.textContent = '';
    pathLabel.removeAttribute('title');
    pathLabel.hidden = true;
    btn.removeAttribute('aria-describedby');
    if (control) control.removeAttribute('title');
  }
}

/**
 * Shared refresh after PUT, native picker, or recent-workspace menu — label, file tree, chats.
 */
export async function applyWorkspaceSwitch(info: WorkspaceInfo): Promise<void> {
  const previousPath = getWorkspacePath();
  await dismissBoardViewOutsideWorkspace(info.path);
  clearCachesForWorkspace(previousPath);
  setWorkspaceFromServer(info);
  updateWorkspaceButtonLabel(info.label, info.path);
  const { persistFilePanelForWorkspace, reloadFilePanelForWorkspace } = await import(
    '../state/file-panel'
  );
  const { persistTerminalForWorkspace, reloadTerminalForWorkspace } = await import(
    '../config/terminal-meta'
  );
  await persistFilePanelForWorkspace(previousPath);
  await persistTerminalForWorkspace(previousPath);
  await reloadFilePanelForWorkspace(info.path);
  await reloadTerminalForWorkspace(info.path);
  const { teardownCodeBrainMapBeforeChatPaint } = await import('./code-brain-map');
  const closedCodeMap = teardownCodeBrainMapBeforeChatPaint();
  const { teardownIssuesEmbedBeforeChatPaint } = await import('./issues-page');
  const closedIssuesEmbed = teardownIssuesEmbedBeforeChatPaint();
  const { syncFileTreeToPanelWorktree } = await import('./file-tree');
  await Promise.all([
    applyWorkspaceScopedSession(info.path, previousPath, { skipFileTreeSync: true }),
    syncFileTreeToPanelWorktree(undefined, { force: true }),
  ]);
  if (closedCodeMap || closedIssuesEmbed) {
    const { getActiveChat } = await import('../state/sessions');
    const { renderChatFromHistory } = await import('./messages');
    renderChatFromHistory(getActiveChat());
  }

  setStatus('ok', `Workspace: ${info.label}`);
  const { refreshHubLiveData } = await import('./hub');
  refreshHubLiveData();
  const { isSuperPlanPageMounted, refreshSuperPlanLibrary } = await import('./super-plan-page');
  if (isSuperPlanPageMounted()) {
    refreshSuperPlanLibrary();
  }

  const { clearPanelCwdUserOverride, refreshGitPanel } = await import('./git-panel');
  clearPanelCwdUserOverride();
  const { resetRegisteredWorktreePathCache } = await import('../lib/worktree-allowlist-client');
  resetRegisteredWorktreePathCache();
  void refreshGitPanel();
  const { isSourceControlCenterOpen, refreshSourceControlCenter } = await import(
    './source-control-center'
  );
  if (isSourceControlCenterOpen()) {
    refreshSourceControlCenter();
  }
  const { isBoardsViewOpen, refreshBoardsViewAfterWorkspaceSwitch } = await import(
    '../orchestrator/boards-view'
  );
  if (isBoardsViewOpen()) {
    refreshBoardsViewAfterWorkspaceSwitch();
  }
  const { isDevServerScreenOpen, refreshDevServerWorktreesAfterWorkspaceSwitch } = await import(
    './dev-server-screen'
  );
  if (isDevServerScreenOpen()) {
    refreshDevServerWorktreesAfterWorkspaceSwitch();
  }
}

/** Load workspace from server and refresh top bar + file tree. */
export async function refreshWorkspaceUi(): Promise<void> {
  const info = await loadWorkspaceFromServer();
  if (info?.path) {
    updateWorkspaceButtonLabel(info.label, info.path);
  }
}

/** Guarded workspace switch used by the top bar, welcome page, and deep links. */
export { executeWorkspaceSwitch } from './workspace-switch-guard';

async function onOpenNewWorkspace(): Promise<void> {
  if (!getLocalServerAvailable()) {
    setStatus('err', 'Workspace requires Minnow running locally');
    return;
  }

  setStatus('spin', 'Choose workspace folder…');
  try {
    const initialPath = getWorkspacePath();
    const result = await openWorkspaceFolderPicker({
      initialPath: initialPath || undefined,
    });
    if (result.cancelled) {
      setStatus('ok', 'Workspace unchanged');
      return;
    }
    if (!result.path) {
      setStatus('err', 'No folder selected');
      return;
    }

    const info = await executeWorkspaceSwitch(result.path);
    if (!info) {
      setStatus('ok', 'Workspace unchanged');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
  }
}

/** Wire top bar workspace folder control. */
export function initWorkspaceButton(): void {
  const btn = getWorkspaceButton();
  if (!btn) return;

  bindShellOverlayTrigger(btn, 'workspace');
  btn.setAttribute('aria-controls', 'osWorkspaceGate');
  setWorkspaceMenuDeps({
    isServerAvailable: getLocalServerAvailable,
    reportStatus: setStatus,
  });

  configureWorkspaceRecentMenu({
    onSelectWorkspace: async (absPath) => {
      const info = await executeWorkspaceSwitch(absPath);
      if (!info) {
        setStatus('ok', 'Workspace unchanged');
      }
    },
    onOpenNew: onOpenNewWorkspace,
  });

  btn.addEventListener('click', () => {
    if (isOsShellEnabled()) {
      void import('../os/workspace-gate').then((m) => {
        if (isShellOverlayOpen('workspace')) closeShellOverlay();
        else m.openWorkspaceGate({ switch: true });
      });
      return;
    }
    void toggleWorkspaceMenu(btn);
  });

  // The folder name is part of the control: pressing it runs the button's action.
  getWorkspacePathLabel()?.addEventListener('click', () => {
    btn.click();
  });

  void refreshWorkspaceUi();
}

export { closeWorkspaceMenu };
