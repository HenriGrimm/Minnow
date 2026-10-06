import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';
import {
  getGroupsForWorkspace,
  isLeftoverBoardRunning,
} from '../state/chat-groups';
import { getWorkspacePath } from '../state/workspace';
import { sessionState } from '../state/sessions';
import type { ChatGroup, LeftoverBoardTask } from '../types';
import type { BoardSummary } from '../orchestrator/client';
import { ORCHESTRATE_HUB_ROOT_ID } from './orchestrate-hub';

const BOARDS_ROOT_ID = 'orchestratorBoardsRoot';
const ACTIVITY_DOT_CLASS = 'code-views__activity-dot';
const POLL_MS = 5_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let v2Running = false;
let refreshing = false;
let unsubscribeVisibility: (() => void) | null = null;

/** True when the Orchestrate hub or V2 boards surface owns the main column. */
export function isOrchestrateCodeViewOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.getElementById(ORCHESTRATE_HUB_ROOT_ID) ||
      document.getElementById(BOARDS_ROOT_ID),
  );
}

function leftoverBoardHasLiveWork(group: ChatGroup): boolean {
  if (isLeftoverBoardRunning(group)) return true;
  const board = group.orchestrateBoard;
  if (!board) return false;
  return board.tasks.some(
    (task: LeftoverBoardTask) =>
      Boolean(task.chatId?.trim()) &&
      (task.status === 'in_progress' ||
        task.status === 'testing' ||
        task.status === 'merging'),
  );
}

/** Synchronous check for V1 board folders with in-flight orchestration work. */
function hasV1BoardWorkInWorkspace(): boolean {
  if (!sessionState) return false;
  const workspacePath = getWorkspacePath();
  return getGroupsForWorkspace(workspacePath).some(leftoverBoardHasLiveWork);
}

function boardSummaryIsRunning(board: BoardSummary): boolean {
  if (board.finished || board.status !== 'running') return false;
  const stamped = board.workspacePath?.trim();
  if (!stamped) return true;
  return normalizeWorkspacePath(stamped) === normalizeWorkspacePath(getWorkspacePath());
}

/** Push V2 running state from an already-fetched board list (boards view poll). */
export function updateV2BoardActivityFromSummaries(boards: BoardSummary[]): void {
  v2Running = boards.some(boardSummaryIsRunning);
  syncCodeViewsOrchestrateButton();
}

async function refreshV2BoardActivity(): Promise<void> {
  if (refreshing || isRenderIdle()) return;
  refreshing = true;
  try {
    const { listBoards } = await import('../orchestrator/client');
    const boards = await listBoards();
    v2Running = boards.some(boardSummaryIsRunning);
  } catch {
    // Server may be offline during boot; keep the last known state.
  } finally {
    refreshing = false;
  }
  syncCodeViewsOrchestrateButton();
}

function ensureActivityDot(btn: HTMLElement): HTMLElement {
  let dot = btn.querySelector<HTMLElement>(`.${ACTIVITY_DOT_CLASS}`);
  if (!dot) {
    dot = document.createElement('span');
    dot.className = ACTIVITY_DOT_CLASS;
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
  }
  return dot;
}

/** Sync pressed state and the running-board activity dot on `#btnOrchestrate`. */
export function syncCodeViewsOrchestrateButton(): void {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btnOrchestrate');
  if (!btn) return;

  const open = isOrchestrateCodeViewOpen();
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.classList.toggle('icon-btn--active', open);

  const boardActive = hasV1BoardWorkInWorkspace() || v2Running;
  const showDot = boardActive && !open;
  const dot = ensureActivityDot(btn);
  dot.hidden = !showDot;
  dot.classList.toggle('is-live', showDot);
  btn.classList.toggle('code-views__btn--board-active', showDot);
  btn.title = showDot ? 'Orchestrate (board running)' : 'Orchestrate';
}

/** Start polling V2 board status and wire the code-views Orchestrate button. */
export function initCodeViewsOrchestrateButton(): void {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btnOrchestrate');
  if (!btn || btn.dataset.codeViewsOrchestrateWired === '1') return;
  btn.dataset.codeViewsOrchestrateWired = '1';

  syncCodeViewsOrchestrateButton();
  void refreshV2BoardActivity();
  if (pollTimer === null) {
    pollTimer = setInterval(() => void refreshV2BoardActivity(), POLL_MS);
    unsubscribeVisibility = subscribeRenderIdle((idle) => {
      if (!idle) void refreshV2BoardActivity();
    });
  }
}

/** Clear poll timer between tests. */
export function resetCodeViewsOrchestrateButtonForTests(): void {
  unsubscribeVisibility?.();
  unsubscribeVisibility = null;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  v2Running = false;
}
