import type { CodeWindowCommand } from '../../electron/code-window-command';
import { getAppWindowId } from './app-window';
import { isCurrentWindowWorkspace, getWorkspacePath } from '../state/workspace';
import { normalizeModeId } from '../chat/modes/types';

/** Return false when this renderer can handle the command itself. */
export async function routeCodeWindowCommand(command: CodeWindowCommand): Promise<boolean> {
  if (!getAppWindowId() && isCurrentWindowWorkspace(command.workspacePath)) return false;
  const send = window.minnow?.window?.sendCodeCommand;
  if (!send) {
    if (getAppWindowId()) throw new Error('Restart Minnow to enable Code window actions');
    return false;
  }
  if (command.issueId) {
    const { saveIssuesNow } = await import('../state/issues-store');
    await saveIssuesNow();
  }
  const result = await send({ ...command, workspacePath: command.workspacePath || getWorkspacePath() });
  if (!result.ok) throw new Error(result.error || 'Could not open Code window');
  return true;
}

async function applyCommand(command: CodeWindowCommand): Promise<void> {
  const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
  await ensureCodeWorkspaceModules();
  const { launchApp } = await import('./router');
  launchApp('code', { codeSection: 'chat' });
  if (command.kind === 'seed') {
    const { applyCodeLaunchOptions } = await import('./code-launch');
    await applyCodeLaunchOptions(
      { ...command, modeId: normalizeModeId(command.modeId), autoRun: true },
      (chatId) => {
        void (async () => {
          if (command.issueId) {
            const store = await import('../state/issues-store');
            await store.refreshIssuesFromStorage();
            store.appendIssueLinks(command.issueId, { chatId });
            await store.saveIssuesNow();
          }
          if (command.requestId) await window.minnow?.window?.reportCodeIssueLink?.(command.requestId, chatId);
        })().catch(async (error: unknown) => {
          const { showToast } = await import('../ui/toast');
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
      },
    );
  } else if (command.kind === 'file' && command.path) {
    const { openFileInViewer } = await import('../ui/file-viewer');
    await openFileInViewer(command.path);
  } else if (command.kind === 'board' && command.issueId) {
    const store = await import('../state/issues-store');
    await store.refreshIssuesFromStorage();
    const { runIssueSendToBoard } = await import('../chat/issues/pipeline');
    const result = await runIssueSendToBoard(command.issueId);
    if (!result.ok) throw new Error(result.error || 'Could not open board');
  } else if (command.chatId) {
    if (command.boardGroupId) {
      const { openBoardGroup } = await import('../state/chat-groups');
      openBoardGroup(command.boardGroupId);
      return;
    }
    const { switchChat } = await import('../ui/sidebar');
    await switchChat(command.chatId);
    if (command.runId) {
      const { openSubAgentDrawer } = await import('../ui/sub-agent-drawer');
      openSubAgentDrawer(command.runId, command.chatId);
    }
  }
}

let commandsInitialized = false;

export function initCodeWindowCommands(): void {
  if (commandsInitialized || !window.minnow?.window) return;
  commandsInitialized = true;
  window.minnow?.window?.onCodeIssueLink?.((issueId, chatId) => {
    void import('../state/issues-store').then((store) => store.appendIssueLinks(issueId, { chatId }));
  });
  if (getAppWindowId()) return;
  window.minnow?.window?.onCodeCommand?.((command) => {
    void applyCommand(command).catch(async (error: unknown) => {
      const { showToast } = await import('../ui/toast');
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
}
