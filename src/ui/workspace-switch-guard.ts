import { appConfirm } from './app-dialog';
import { getOpenViewerTabPaths } from './file-viewer-tab-store';
import { setWorkspacePath } from '../config/workspace-api';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import {
  listBoards,
  stopBoard,
  type BoardSummary,
} from '../orchestrator/client';
import {
  getGroupsForWorkspace,
  isLeftoverBoardRunning,
} from '../state/chat-groups';
import { markGroupDirty, scheduleSaveSessions, sessionState } from '../state/sessions';
import {
  getCurrentWorkspaceInfo,
  getWorkspacePath,
  isCurrentWindowWorkspace,
} from '../state/workspace';
import type { ChatGroup } from '../types';

/** How long a workspace switch waits for V2 stop before continuing the PUT. */
export const V2_BOARD_STOP_TIMEOUT_MS = 2_500;

/** Injected in tests so V2 list/stop do not need a live `/api/boards` server. */
let listV2Boards: () => Promise<BoardSummary[]> = listBoards;
let stopV2Board: (boardId: string) => Promise<void> = stopBoard;
let v2StopTimeoutMs = V2_BOARD_STOP_TIMEOUT_MS;
let retargetInProgress = false;

/** Test seam for V2 switch-guard list/stop. Pass null to restore defaults. */
export function setV2WorkspaceSwitchDepsForTests(
  deps: {
    listBoards?: () => Promise<BoardSummary[]>;
    stopBoard?: (boardId: string) => Promise<void>;
    stopTimeoutMs?: number;
  } | null,
): void {
  listV2Boards = deps?.listBoards ?? listBoards;
  stopV2Board = deps?.stopBoard ?? stopBoard;
  v2StopTimeoutMs = deps?.stopTimeoutMs ?? V2_BOARD_STOP_TIMEOUT_MS;
}

/** Resolve when `ms` elapses so a hung stop cannot block the workspace PUT. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ask the engine to stop, but do not wait forever. */
async function stopV2BoardBestEffort(boardId: string): Promise<void> {
  try {
    await Promise.race([stopV2Board(boardId), delay(v2StopTimeoutMs)]);
  } catch (err) {
    console.warn('[workspace] failed to stop V2 board', boardId, err);
  }
}

/** True when a board still has active orchestration work that must not be orphaned. */
export function isBoardBlockingWorkspaceSwitch(group: ChatGroup): boolean {
  if (isLeftoverBoardRunning(group)) return true;
  const board = group.orchestrateBoard;
  if (!board) return false;
  return board.tasks.some(
    (t) =>
      Boolean(t.chatId?.trim()) &&
      (t.status === 'in_progress' || t.status === 'testing' || t.status === 'merging'),
  );
}

/** V1 boards in the given workspace that would be orphaned by a switch away. */
export function getBlockingBoardsForWorkspace(workspacePath?: string): ChatGroup[] {
  if (!sessionState) return [];
  const ws = normalizeWorkspacePath(workspacePath ?? getWorkspacePath());
  return getGroupsForWorkspace(ws).filter(isBoardBlockingWorkspaceSwitch);
}

/** Running V2 boards for the live workspace (the list API is already scoped). */
export async function getBlockingV2BoardsForWorkspace(): Promise<BoardSummary[]> {
  try {
    const boards = await listV2Boards();
    return boards.filter((board) => board.status === 'running');
  } catch {
    return [];
  }
}

/** Whether switching from the current workspace to targetPath needs a V1 board stop confirm. */
export function isWorkspaceSwitchBlockedByRunningBoard(targetPath: string): boolean {
  const current = normalizeWorkspacePath(getWorkspacePath());
  const target = normalizeWorkspacePath(targetPath);
  if (!current || current === target) return false;
  return getBlockingBoardsForWorkspace(current).length > 0;
}

/** Hide board view when the open board folder belongs to another workspace. */
export async function dismissBoardViewOutsideWorkspace(workspacePath: string): Promise<void> {
  const { getActiveBoardGroup } = await import('../state/chat-groups');
  const activeBoard = getActiveBoardGroup();
  if (
    activeBoard &&
    normalizeWorkspacePath(activeBoard.workspacePath) !== normalizeWorkspacePath(workspacePath)
  ) {
    const { exitBoardViewForNavigation } = await import('./exit-board-view');
    exitBoardViewForNavigation();
  }

  const { deselectBoardForWorkspaceSwitch } = await import('../orchestrator/boards-view');
  // Always forget last-opened V2 journal so a different workspace cannot resume it.
  deselectBoardForWorkspaceSwitch();
}

type NamedBoard = { name?: string };

/** User-facing confirm copy for one or more blocking boards. */
export function formatWorkspaceSwitchBoardConfirmMessage(groups: readonly NamedBoard[]): string {
  if (groups.length === 1) {
    const name = groups[0]?.name?.trim() || 'Orchestrate board';
    return (
      `${name} is still running in this workspace.\n\n` +
      'Stop the board and switch workspace? In-flight agent chats will be cancelled.'
    );
  }
  return (
    `${groups.length} orchestrator boards are still running in this workspace.\n\n` +
    'Stop all boards and switch workspace? In-flight agent chats will be cancelled.'
  );
}

/** When a board is active, prompt to stop cleanly or cancel the switch. */
export async function confirmAndStopBoardsForWorkspaceSwitch(
  targetPath: string,
): Promise<boolean> {
  const current = normalizeWorkspacePath(getWorkspacePath());
  const target = normalizeWorkspacePath(targetPath);
  if (!current || current === target) {
    return true;
  }

  const v1 = getBlockingBoardsForWorkspace(current);
  const v2 = await getBlockingV2BoardsForWorkspace();
  if (v1.length === 0 && v2.length === 0) {
    return true;
  }

  const named: NamedBoard[] = [
    ...v1,
    ...v2.map((board) => ({ name: board.name?.trim() || 'Orchestrate board' })),
  ];
  const proceed = await appConfirm(formatWorkspaceSwitchBoardConfirmMessage(named));
  if (!proceed) {
    return false;
  }

  for (const group of v1) {
    if (group.orchestrateBoard) {
      group.orchestrateBoard.status = 'stopped';
      markGroupDirty(group.id);
    }
    const { stopGeneration } = await import('../chat/stop-generation');
    for (const task of group.orchestrateBoard?.tasks ?? []) {
      const chatId = task.chatId?.trim();
      if (chatId) stopGeneration(chatId, 'user');
    }
    const plannerId = group.plannerChatId?.trim();
    if (plannerId) stopGeneration(plannerId, 'user');
  }
  if (v1.length > 0) {
    scheduleSaveSessions();
  }
  await Promise.all(v2.map((board) => stopV2BoardBestEffort(board.boardId)));

  const { exitBoardViewForNavigation } = await import('./exit-board-view');
  exitBoardViewForNavigation();
  return true;
}

/**
 * Warn — but do not stop — when boards are running and the window is about to be
 * retargeted. With one workspace per view the boards keep running server-side in
 * the folder they belong to; nothing is orphaned, so the confirm is informational.
 */
async function confirmRetargetWithRunningBoards(targetPath: string): Promise<boolean> {
  const current = normalizeWorkspacePath(getWorkspacePath());
  const target = normalizeWorkspacePath(targetPath);
  if (!current || current === target) return true;

  const v1 = getBlockingBoardsForWorkspace(current);
  const v2 = await getBlockingV2BoardsForWorkspace();
  if (v1.length === 0 && v2.length === 0) return true;

  const count = v1.length + v2.length;
  const noun = count === 1 ? 'board is' : 'boards are';
  return appConfirm(
    `${count} orchestrator ${noun} still running in this workspace.

` +
      'They keep running in the background. Switch this window to another folder?',
  );
}

/**
 * Guard, then switch this window's workspace.
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
      if (!(await confirmRetargetWithRunningBoards(absPath))) return null;
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

  const allowed = await confirmAndStopBoardsForWorkspaceSwitch(absPath);
  if (!allowed) {
    return null;
  }
  const info = await setWorkspacePath(absPath);
  const { applyWorkspaceSwitch } = await import('./workspace-button');
  await applyWorkspaceSwitch(info);
  return info;
}
