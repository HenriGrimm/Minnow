import { subscribeModelSelection } from '../models/selection';
import { StreamEventSource as EventSource } from '../api/stream-event-source';
import '../styles/orchestrator-boards.css';
import '../styles/transcript-view.css';
import '../styles/orchestrate-plan-screen.css';

import type { BoardState, ParseError, TaskEditChanges } from '../../server/orchestrator/core/types';
import { DEFAULT_BOARD_CONCURRENCY } from '../../server/orchestrator/core/derive.js';
import {
  createBoardClient,
  createBoardFromPlan,
  createBoardListClient,
  deleteBoard,
  PlanParseFailure,
  readAttemptTranscript,
  readJournal,
  readBoardReport,
  readTaskFileDiff,
  readTaskFiles,
  type BoardClient,
  type BoardListClient,
  type BoardSummary,
} from './client';
import { appConfirm, isAppDialogOpen } from '../ui/app-dialog';
import { isDialogOpen } from '../ui/components/dialog';
import { isolateModalBackground, trapTabKey } from '../ui/components/internal';
import { resetTargets, rewindCascade } from '../../server/orchestrator/core/rewind.js';
import { resyncHasWork } from '../../server/orchestrator/core/plan-resync.js';
import { describeResync } from './plan-resync-summary';
import { withSessionToken } from '../api/session-token';
import {
  formatElapsed,
  renderBoardHeader,
  renderBoardSkeleton,
  renderMergeQueue,
  renderRunLedger,
  renderTaskList,
  renderTimeline,
  pendingDependents,
  runningAttempt,
  syncTaskCardActivity,
  type FileDiffView,
  type TaskFilesView,
  type TranscriptView,
} from './board-render';
import {
  renderBoardReport,
  wantsReportScreen,
} from './board-report';
import {
  renderTaskDetail,
  applyTaskDetailTurnEvent,
  resetTaskDetailLogUi,
  resetTaskDetailUi,
  runningAgentAttempt,
  settleSpecEdit,
  syncTaskDetailOverlay,
} from './task-detail';
import {
  discoverOrchestratePlans,
  type DiscoverOrchestratePlansResult,
} from '../chat/plans/list-plans';
import { button, el, empty, pill } from './dom';
import { createIcon } from '../ui/icon';
import { createBackToChatButton } from '../ui/back-to-chat';
import { closeContextMenu, deferUntilContextMenuClosed, isContextMenuOpen, openContextMenu } from '../ui/context-menu';
import { markPreviewOccluder, unmarkPreviewOccluder } from '../ui/preview-occlusion';
import { refreshGraphiteSurfaceLayout, usesGraphiteContentTabs } from '../ui/surfaces/surface-bridge';
import {
  attachV2BoardHeaderInstruments,
  detachV2BoardHeaderInstruments,
  teardownV2BoardHeaderInstruments,
} from './board-header-v2';
import { ensureBoardModelBound } from './board-model-bind';
import { transcriptStructureKey } from './transcript-adapter';
import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import { isBoardJournalReasoning } from './board-journal-reasoning';
import { isExecutableOrchestratePlan } from '../chat/plans/plan-path';
import {
  mountPlanPreviewContent,
  readPlanArtifactMarkdown,
} from '../chat/plans/plan-preview';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import { gitBranches, type GitOpResult } from '../state/git-api';
import { getActiveChat } from '../state/sessions';
import { refreshMetricsStripForChat, updateStrip } from '../ui/stats';
import { boardUsage } from './board-usage';
import { attemptInterruption } from './attempt-status';
import { collectBoardAttention, createBoardAttentionInbox, type BoardAttentionItem } from './board-attention';
import {
  cancelPlanRepair,
  startPlanRepair,
  type StartPlanRepairInput,
  type StartPlanRepairResult,
} from './plan-repair';

const PLAN_LIST_HINTS: Record<string, string> = {
  server_off: 'Open or restart Minnow to list plans.',
  no_plans_dir: 'No documentation/plans folder in this workspace.',
};

function shortPlanLabel(fullPath: string): string {
  return fullPath.replace(/^documentation\/plans\//, '');
}

let askPlanPreviewRequestId = 0;

async function refreshAskPlanPreview(
  planPath: string,
  elements: { section: HTMLElement; pathChip: HTMLElement; previewMount: HTMLElement },
): Promise<void> {
  const trimmed = planPath.trim();
  if (!trimmed || !isExecutableOrchestratePlan(trimmed)) {
    elements.section.hidden = true;
    elements.pathChip.textContent = '';
    elements.pathChip.removeAttribute('title');
    elements.previewMount.replaceChildren();
    return;
  }

  const requestId = (askPlanPreviewRequestId += 1);
  elements.section.hidden = false;
  elements.pathChip.textContent = shortPlanLabel(trimmed);
  elements.pathChip.title = trimmed;
  elements.previewMount.replaceChildren();
  const loading = el('p', 'orchestrate-hub__plan-preview-loading', 'Loading plan…');
  elements.previewMount.appendChild(loading);

  try {
    const markdown = await readPlanArtifactMarkdown(trimmed);
    if (requestId !== askPlanPreviewRequestId) return;
    mountPlanPreviewContent(elements.previewMount, markdown, { modeId: 'plan' });
  } catch {
    if (requestId !== askPlanPreviewRequestId) return;
    elements.previewMount.replaceChildren();
    elements.previewMount.appendChild(
      el('p', 'orchestrate-plan-screen__preview-empty', 'Could not load plan file.'),
    );
  }
}

export const BOARDS_ROOT_ID = 'orchestratorBoardsRoot';
const CHAT_AREA_CLASS = 'chat-area--orchestrator-boards';
const MAIN_COLUMN_CLASS = 'main-column--orchestrator-boards';

const TIMELINE_LIMIT = 300;
const TIMELINE_POPOVER_ID = 'ov2-timeline-popover';

interface Surface {
  root: HTMLElement;
  listPane: HTMLElement;
  boardPane: HTMLElement;
  desktopLayout: boolean;
  resizeObserver?: ResizeObserver;
}

let surface: Surface | null = null;
let taskModal: { overlay: HTMLElement; release: () => void } | null = null;
let list: BoardListClient | null = null;
let client: BoardClient | null = null;
let unsubscribeBoard: (() => void) | null = null;
let unsubscribeLive: (() => void) | null = null;
let unsubscribeList: (() => void) | null = null;

let selectedBoardId: string | null = null;
/**
 * Survives teardown so leaving Boards and coming back reconnects the last
 * journal instead of painting a selected rail row over a skeleton (no client).
 */
let lastOpenedBoardId: string | null = null;
let selectedTaskId: string | null = null;
const BOARD_PANES = ['Waves', 'Verification', 'Activity'] as const;
type BoardPane = typeof BOARD_PANES[number];
let selectedPane: BoardPane = 'Waves';
let journalView: {
  boardId: string;
  events: readonly Record<string, unknown>[];
  truncated: boolean;
} | null = null;
let journalLoad: { boardId: string; error?: string } | null = null;
let timelinePopover: {
  root: HTMLElement;
  anchor: HTMLButtonElement;
  close: (restoreFocus?: boolean) => void;
} | null = null;
const pendingTasks = new Set<string>();
let notice: { text: string; tone: 'info' | 'warn' | 'bad' } | null = null;
let attentionInbox: ReturnType<typeof createBoardAttentionInbox> | null = null;
/** A plan re-sync is in flight; one at a time. */
let resyncing = false;
let transcript: TranscriptView | null = null;
let taskFiles: TaskFilesView | null = null;
const fileDiffs = new Map<string, FileDiffView>();
const expandedFiles = new Set<string>();
const confirmingDelete = new Set<string>();
let renamingBoardId: string | null = null;
const finishReportByBoard = new Map<string, string>();
const finishReportSeq = new Map<string, number>();
const finishReportLoads = new Set<string>();
const reportDismissed = new Set<string>();
/** First-paint seed per board. Catalog retries use the menubar watcher, not every SSE paint. */
const modelSeedAttempted = new Set<string>();
const modelSeedInflight = new Set<string>();
let stopModelSelectSeedWatch: (() => void) | null = null;

// ── Mount ────────────────────────────────────────────────────────────────────

export function isBoardsViewOpen(): boolean {
  return Boolean(document.getElementById(BOARDS_ROOT_ID));
}

/** Drop last-opened memory when the Code workspace changes. */
export function forgetLastOpenedBoard(): void {
  lastOpenedBoardId = null;
  persistLastOpenedBoardId(null);
}

export function deselectBoardForWorkspaceSwitch(): void {
  forgetLastOpenedBoard();
  if (!isBoardsViewOpen()) return;
  selectBoard(null);
}

export function refreshBoardsViewAfterWorkspaceSwitch(): void {
  if (!isBoardsViewOpen()) return;
  void list?.refresh();
}

export async function openBoardsView(options: { fromPlan?: boolean } = {}): Promise<void> {
  if (isBoardsViewOpen()) {
    // Hash / rail re-entry while already mounted: reconnect if teardown-equivalent
    // left a selected id with no live client (skeleton forever until another click).
    if (selectedBoardId && !client) reconnectBoard(selectedBoardId);
    void list?.refresh();
    return;
  }

  const { closeOtherCodeStageViews, stripMainColumnOverlayClasses, notifyCodeStageViewChanged } =
    await import('../ui/main-column-overlay');
  await closeOtherCodeStageViews('boards');

  const area = document.getElementById('chatArea');
  if (!area) return;

  const root = el('div', 'ov2 ob-shell');
  root.id = BOARDS_ROOT_ID;
  const listPane = el('aside', 'ov2__list ob-rail');
  const boardPane = el('section', 'ov2__board ob-main');
  boardPane.tabIndex = -1;
  const header = el('header', 'ov2__stage-header');
  header.dataset.appTitlebar = '';
  const heading = el('div', 'ov2__stage-heading');
  heading.append(createBackToChatButton(), el('h1', 'ov2__list-title', 'Boards'));
  header.append(heading, button({
    label: 'New board',
    title: 'Create a board from a plan file',
    onClick: () => openAskPane(),
  }));
  root.append(header, listPane, boardPane);

  area.replaceChildren(root);
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_CLASS);
  refreshGraphiteSurfaceLayout();
  surface = { root, listPane, boardPane, desktopLayout: false };
  syncBoardsLayout(surface);
  if (typeof ResizeObserver === 'function') {
    const mounted = surface;
    mounted.resizeObserver = new ResizeObserver(() => {
      if (surface === mounted && syncBoardsLayout(mounted)) paintBoard();
    });
    mounted.resizeObserver.observe(root);
  }
  document.addEventListener('keydown', onBoardsDocumentKeydown);

  list = createBoardListClient();
  let listedBoardIds = new Set<string>();
  unsubscribeList = list.subscribe(() => {
    const boards = list?.getBoards() ?? [];
    // An in-flight list request may predate a newly created board.
    if (selectedBoardId && listedBoardIds.has(selectedBoardId) && !boards.some((b) => b.boardId === selectedBoardId)) {
      if (lastOpenedBoardId === selectedBoardId) forgetLastOpenedBoard();
      selectBoard(null);
    }
    listedBoardIds = new Set(boards.map((board) => board.boardId));
    paintList();
    void import('../ui/code-views-orchestrate-button').then((m) =>
      m.updateV2BoardActivityFromSummaries(boards),
    );
  });
  list.start();

  paintList();
  if (!options.fromPlan) resumeLastOpenedBoard();
  syncRailButton();
  notifyCodeStageViewChanged();
}

export function teardownBoardsView(): void {
  if (typeof document === 'undefined') return;
  closeTimelinePopover(false);
  attentionInbox?.dispose();
  attentionInbox = null;
  surface?.resizeObserver?.disconnect();
  document.removeEventListener('keydown', onBoardsDocumentKeydown);
  unsubscribeBoard?.();
  unsubscribeBoard = null;
  unsubscribeLive?.();
  unsubscribeLive = null;
  client?.close();
  client = null;
  unsubscribeList?.();
  unsubscribeList = null;
  list?.stop();
  list = null;

  askPlanPreviewRequestId = 0;
  stopElapsedTicker();
  teardownV2BoardHeaderInstruments();
  stopWatchingModelSelectForSeed();
  modelSeedAttempted.clear();
  modelSeedInflight.clear();
  closeTaskDetail();
  document.getElementById(BOARDS_ROOT_ID)?.remove();
  const area = document.getElementById('chatArea');
  area?.classList.remove(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.remove(MAIN_COLUMN_CLASS);
  refreshGraphiteSurfaceLayout();
  document.getElementById('statsExpandBtn')?.setAttribute('aria-label', 'Show inference metrics');
  try { refreshMetricsStripForChat(getActiveChat()); } catch { /* Sessions may still be loading. */ }
  surface = null;
  // Keep lastOpenedBoardId; drop selectedBoardId so paint cannot show a live
  // selection without a client if anything renders during unmount.
  if (selectedBoardId) rememberOpenedBoard(selectedBoardId);
  selectedBoardId = null;
  pendingTasks.clear();
  confirmingDelete.clear();
  renamingBoardId = null;
  notice = null;
  syncRailButton();
}

function onBoardsDocumentKeydown(event: KeyboardEvent): void {
  if ((event.key !== 'Escape' && event.key !== 'Tab') || event.defaultPrevented
    || isContextMenuOpen() || isAppDialogOpen() || isDialogOpen()) return;
  if (!surface || !selectedTaskId) return;
  const panel = taskModal?.overlay.querySelector<HTMLElement>('.ov2-detail');
  if (!panel) return;
  if (event.key === 'Tab') {
    trapTabKey(panel, event);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  selectTaskDetail(null);
}

function selectTaskDetail(taskId: string | null): void {
  const previous = selectedTaskId;
  closeTaskDetail();
  selectedTaskId = taskId;
  const selected = taskId ? client?.getState()?.tasks.get(taskId) : undefined;
  const activeAttempt = selected ? runningAgentAttempt(selected) : null;
  paintBoard();
  if (taskId === null && previous) {
    surface?.root
      .querySelector<HTMLElement>(`[data-focus-key="task:${CSS.escape(previous)}"]`)
      ?.focus({ preventScroll: true });
    return;
  }
  if (selected) {
    taskModal?.overlay.querySelector<HTMLElement>('.ov2-detail')?.focus({ preventScroll: true });
    void loadTaskFiles(selected.id);
    if (activeAttempt) void toggleTranscript(activeAttempt.attemptId);
  }
}

export async function closeBoardsView(options?: {
  skipNavigate?: boolean;
  restoreChat?: boolean;
}): Promise<void> {
  if (!isBoardsViewOpen()) return;

  teardownBoardsView();

  const { dismissActiveBoardView } = await import('../state/chat-groups');
  dismissActiveBoardView();

  const { notifyCodeStageViewChanged } = await import('../ui/main-column-overlay');

  if (!options?.skipNavigate) {
    const { navigateToCodeChatIfCurrentSection } = await import('../os/router');
    navigateToCodeChatIfCurrentSection('boards');
    navigateToCodeChatIfCurrentSection('orchestrate');
  }

  if (options?.restoreChat === false) {
    notifyCodeStageViewChanged();
    return;
  }

  const { sessionState } = await import('../state/sessions');
  const targetId = sessionState?.activeId;
  const chat = targetId ? sessionState?.chats.find((c) => c.id === targetId) : undefined;
  const area = document.getElementById('chatArea');
  if (chat) {
    const { renderChatFromHistory } = await import('../ui/messages');
    renderChatFromHistory(chat);
  } else if (area) {
    area.replaceChildren();
  }

  const { notifyAskQuestionDisplayContextChanged } = await import(
    '../chat/ask-question-display'
  );
  notifyAskQuestionDisplayContextChanged();
  void import('../ui/preview-electron-visibility').then((m) =>
    m.scheduleElectronPreviewHostVisibilitySync(),
  );
  notifyCodeStageViewChanged();
}

function syncRailButton(): void {
  void import('../ui/code-views-orchestrate-button').then((m) =>
    m.syncCodeViewsOrchestrateButton(),
  );
}

// ── Selection ────────────────────────────────────────────────────────────────

function lastOpenedStorageKey(): string | null {
  const workspace = getWorkspacePath().trim();
  if (!workspace) return null;
  return `minnow.v2.lastOpenedBoardId:${workspace}`;
}

/** sessionStorage so a SPA reload still lands on the last journal for this workspace. */
function persistLastOpenedBoardId(boardId: string | null): void {
  try {
    const key = lastOpenedStorageKey();
    if (!key || typeof sessionStorage === 'undefined') return;
    if (boardId) sessionStorage.setItem(key, boardId);
    else sessionStorage.removeItem(key);
  } catch {
    // Private mode / missing storage — in-memory lastOpenedBoardId still works.
  }
}

function readPersistedLastOpenedBoardId(): string | null {
  try {
    const key = lastOpenedStorageKey();
    if (!key || typeof sessionStorage === 'undefined') return null;
    const stored = sessionStorage.getItem(key)?.trim();
    return stored || null;
  } catch {
    return null;
  }
}

function rememberOpenedBoard(boardId: string): void {
  lastOpenedBoardId = boardId;
  persistLastOpenedBoardId(boardId);
}

function resumeLastOpenedBoard(): void {
  const resumeId = lastOpenedBoardId ?? selectedBoardId ?? readPersistedLastOpenedBoardId();
  if (!resumeId) {
    paintBoard();
    return;
  }
  reconnectBoard(resumeId);
}

/** Open (or reopen) a journal: always attach a client, even if the id is unchanged. */
function reconnectBoard(boardId: string): void {
  // selectBoard no-ops when the id matches *and* a client exists. After teardown
  // the id can still be set with client === null — that is the skeleton bug.
  if (selectedBoardId === boardId) selectedBoardId = null;
  selectBoard(boardId);
}

function selectBoard(boardId: string | null): void {
  // Same id with a live client is a no-op. Same id with no client must reconnect.
  if (boardId === selectedBoardId && (boardId === null || client)) return;
  attentionInbox?.dispose();
  attentionInbox = null;
  unsubscribeBoard?.();
  unsubscribeBoard = null;
  unsubscribeLive?.();
  unsubscribeLive = null;
  client?.close();
  client = null;

  selectedBoardId = boardId;
  if (boardId) rememberOpenedBoard(boardId);
  closeTaskDetail();
  selectedPane = 'Waves';
  closeTimelinePopover(false);
  journalView = null;
  journalLoad = null;
  pendingTasks.clear();
  confirmingDelete.clear();
  renamingBoardId = null;
  notice = null;

  if (boardId) {
    client = createBoardClient(boardId, { openStream, onTurnEvent: frame => {
      if (selectedBoardId !== boardId) return;
      const overlay = taskModal?.overlay;
      if (overlay) applyTaskDetailTurnEvent(overlay, frame.attemptId, frame.event, frame.roundIndex);
    } });
    unsubscribeBoard = client.subscribe(() => paintBoard());
    unsubscribeLive = client.subscribeLive(scheduleLiveUi);
    client.connect();
  }
  paintList();
  paintBoard();
}

export function showBoard(boardId: string): void {
  selectBoard(boardId);
  void list?.refresh();
}

/** Keep the originating plan visible through creation, failure, and repair. */
export async function mountBoardFromPlan(
  pane: HTMLElement,
  planPath: string,
  handlers: AskPaneHandlers,
): Promise<{ boardId: string } | null> {
  const createBoard = handlers.createBoard ?? createBoardFromPlan;
  const wrap = el('div', 'ov2-create');
  wrap.dataset.planLaunch = 'true';
  wrap.appendChild(el('h2', 'ov2-create__title', 'Creating board…'));
  wrap.appendChild(el('p', 'orchestrate-plan-screen__path', planPath));
  wrap.setAttribute('aria-busy', 'true');
  pane.replaceChildren(wrap);
  try {
    const { boardId } = await createBoard(planPath);
    if (pane.contains(wrap)) handlers.onCreated(boardId);
    return { boardId };
  } catch (err) {
    if (!pane.contains(wrap)) return null;
    wrap.querySelector('h2')!.textContent = 'Could not create board';
    const retry = button({
      label: 'Retry',
      onClick: () => { void mountBoardFromPlan(pane, planPath, handlers); },
    });
    wrap.append(renderCreateError(err, {
      planPath,
      createBoard,
      onCreated: handlers.onCreated,
      startPlanRepair: handlers.startPlanRepair,
      cancelPlanRepair: handlers.cancelPlanRepair,
      setBusy: (busy) => { retry.disabled = busy; },
    }), retry);
    return null;
  } finally {
    wrap.setAttribute('aria-busy', 'false');
  }
}

export async function createAndShowBoardFromPlan(planPath: string, options: Parameters<typeof createBoardFromPlan>[1] = {}): Promise<{ boardId: string } | null> {
  await openBoardsView({ fromPlan: true });
  if (!surface) return null;
  selectBoard(null);
  return mountBoardFromPlan(surface.boardPane, planPath, { onCreated: showBoard, createBoard: (path, overrides) => createBoardFromPlan(path, { ...options, ...overrides }) });
}

function openStream(url: string): EventSource {
  return new EventSource(withSessionToken(url));
}

// ── Board list ───────────────────────────────────────────────────────────────

function paintList(): void {
  if (!surface) return;
  const pane = surface.listPane;
  pane.replaceChildren();

  const head = el('div', 'ov2__list-head');
  const heading = el('div', 'ov2__stage-heading');
  heading.append(createBackToChatButton(), el('h1', 'ov2__list-title', 'Boards'));
  head.appendChild(heading);
  if (document.documentElement.classList.contains('mn-graphite-apps')) {
    const add = el('button', 'ov2__graphite-add');
    add.type = 'button';
    add.title = 'Create a board from a plan file';
    add.setAttribute('aria-label', 'New board');
    add.append(createIcon('plus', { size: 13 }));
    add.addEventListener('click', () => openAskPane());
    head.append(add);
  } else head.appendChild(button({
      label: 'New board',
      title: 'Create a board from a plan file',
      variant: 'primary',
      onClick: () => openAskPane(),
    }));
  pane.appendChild(head);

  const boards = list?.getBoards() ?? [];
  if (boards.length === 0) {
    pane.appendChild(empty('No boards yet. Pick a plan in the main pane to start one.'));
  } else {
    const items = el('ul', 'ov2__boards');
    for (const board of boards) items.appendChild(renderListItem(board));
    pane.appendChild(items);
  }

  const error = list?.getError();
  if (error) {
    pane.appendChild(el('p', 'ov2__list-error', `Could not refresh the list: ${error.message}`));
  }

  const help = el('aside', 'ov2__graphite-help');
  const helpTitle = el('strong', undefined, 'How boards run');
  helpTitle.prepend(createIcon('help', { size: 14 }));
  help.append(helpTitle, el('p', undefined, 'A plan becomes waves. Agents work in isolated worktrees, and each wave advances when its checks pass.'));
  pane.append(help);
}

function renderListItem(board: BoardSummary): HTMLElement {
  const item = el('li', 'ov2__board-item');
  const btn = el('button', 'ov2__board-btn');
  btn.type = 'button';
  btn.dataset.focusKey = `board:${board.boardId}`;
  const selected = board.boardId === selectedBoardId;
  if (selected) btn.classList.add('is-selected');
  btn.setAttribute('aria-current', selected ? 'true' : 'false');
  btn.addEventListener('click', () => selectBoard(board.boardId));

  btn.appendChild(el('span', 'ov2__board-name', board.name || board.boardId));
  const meta = el('span', 'ov2__board-meta');
  btn.dataset.status = board.finished ? 'finished' : board.stopReason === 'paused' ? 'paused' : board.status;
  meta.appendChild(
    pill(
      board.finished ? 'finished' : board.stopReason === 'paused' ? 'paused' : board.status === 'running' && board.attentionCount ? 'action needed' : board.status === 'running' && board.waitingCount ? 'recovering' : board.status,
      board.finished ? 'good' : board.status === 'running' ? 'live' : 'neutral',
    ),
  );
  meta.appendChild(el('span', undefined, `${board.taskCount} tasks`));
  if (board.status === 'running') {
    const n = board.concurrency;
    meta.appendChild(el('span', undefined, `${n} agent${n === 1 ? '' : 's'}`));
  }
  btn.appendChild(meta);
  item.appendChild(btn);

  const confirming = confirmingDelete.has(board.boardId);
  const remove = el('button', `ov2__board-delete${confirming ? ' is-confirming' : ''}`);
  remove.type = 'button';
  remove.dataset.focusKey = `delete:${board.boardId}`;
  const deleteLabel = confirming ? 'Delete the journal too?' : `Delete ${board.boardId}`;
  remove.setAttribute('aria-label', deleteLabel);
  remove.title = confirming
    ? `Deleting ${board.boardId} removes its journal — the only record of what the run did.`
    : deleteLabel;
  remove.appendChild(createIcon('trash', { className: 'ov2__board-delete-icon', size: 12 }));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!confirming) {
      confirmingDelete.clear();
      confirmingDelete.add(board.boardId);
      paintList();
      return;
    }
    confirmingDelete.delete(board.boardId);
    void commandDeleteBoard(board.boardId);
  });
  item.appendChild(remove);
  return item;
}

async function commandDeleteBoard(boardId: string): Promise<void> {
  try {
    await deleteBoard(boardId);
    if (lastOpenedBoardId === boardId) forgetLastOpenedBoard();
    if (selectedBoardId === boardId) selectBoard(null);
    await list?.refresh();
    paintList();
  } catch (err) {
    notice = {
      text: `Could not delete ${boardId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
    paintBoard();
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function fillBoardsPlanSelect(
  sel: HTMLSelectElement,
  hintEl: HTMLElement,
  options: {
    discoverPlans?: () => Promise<DiscoverOrchestratePlansResult>;
  } = {},
): Promise<DiscoverOrchestratePlansResult> {
  const discoverFn = options.discoverPlans ?? discoverOrchestratePlans;
  const { plans, error } = await discoverFn();

  sel.replaceChildren();
  const emptyOpt = el('option');
  emptyOpt.value = '';
  emptyOpt.textContent = 'Select plan…';
  sel.appendChild(emptyOpt);

  for (const planPath of plans) {
    const opt = el('option');
    opt.value = planPath;
    opt.textContent = shortPlanLabel(planPath);
    sel.appendChild(opt);
  }

  sel.value = !error && plans.length === 1 ? plans[0]! : '';

  hintEl.textContent = '';
  hintEl.classList.add('hidden');
  if (error) {
    hintEl.textContent = PLAN_LIST_HINTS[error] ?? 'Could not load plans.';
    hintEl.classList.remove('hidden');
  } else if (plans.length === 0) {
    hintEl.textContent = 'No plans yet. Use Plan mode or add documentation/plans/.';
    hintEl.classList.remove('hidden');
  }

  return { plans, error };
}

export type PlanRepairFn = (
  input: StartPlanRepairInput,
) => Promise<StartPlanRepairResult>;

function createStartingBranchPicker(inputClass: string) {
  const field = el('label', 'ov2-create__field');
  field.appendChild(el('span', undefined, 'Starting branch'));
  const select = el('select', inputClass);
  select.setAttribute('aria-label', 'Starting branch');
  const fallback = el('option', undefined, 'Current branch');
  fallback.value = '';
  select.appendChild(fallback);
  select.disabled = true;
  field.appendChild(select);
  return {
    field,
    select,
    async load(discover = () => gitBranches(getWorkspacePath())) {
      try {
        const result = await discover();
        if (!result.ok) {
          select.title = result.error ?? 'Could not load branches. Uses the current branch.';
          return;
        }
        const branches = [...new Set([...(result.local ?? []), ...(result.remote ?? [])])];
        for (const branch of branches) {
          const option = el('option', undefined, branch);
          option.value = branch;
          select.appendChild(option);
        }
        if (result.current && branches.includes(result.current)) select.value = result.current;
        select.disabled = branches.length === 0;
      } catch {
        select.title = 'Could not load branches. Uses the current branch.';
      }
    },
  };
}

export interface CreateFormHandlers {
  discoverBranches?: () => Promise<GitOpResult>;
  discoverPlans?: () => Promise<DiscoverOrchestratePlansResult>;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string; baseBranch?: string },
  ) => Promise<{ boardId: string }>;
  onCreated: (boardId: string) => void;
  onCancel: () => void;
  /** Test seam — production uses `startPlanRepair`. */
  startPlanRepair?: PlanRepairFn;
  cancelPlanRepair?: (planPath: string) => void;
}

export interface AskPaneHandlers {
  discoverBranches?: () => Promise<GitOpResult>;
  discoverPlans?: () => Promise<DiscoverOrchestratePlansResult>;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string; baseBranch?: string },
  ) => Promise<{ boardId: string }>;
  onCreated: (boardId: string) => void;
  /** Test seam — production uses `startPlanRepair`. */
  startPlanRepair?: PlanRepairFn;
  cancelPlanRepair?: (planPath: string) => void;
}

/** Context the parse pane needs to run Repair without leaving Boards. */
export interface CreateErrorRepairContext {
  planPath: string;
  boardId?: string;
  createBoard: (
    planPath: string,
    options?: { boardId?: string; markdown?: string; baseBranch?: string },
  ) => Promise<{ boardId: string }>;
  onCreated: (boardId: string) => void;
  startPlanRepair?: PlanRepairFn;
  cancelPlanRepair?: (planPath: string) => void;
  setBusy?: (busy: boolean) => void;
}

export async function mountBoardsAskPane(
  pane: HTMLElement,
  handlers: AskPaneHandlers,
): Promise<void> {
  const branchPicker = createStartingBranchPicker('orchestrate-hub__plan-select');
  const createBoard: NonNullable<AskPaneHandlers['createBoard']> = (planPath, options) =>
    (handlers.createBoard ?? createBoardFromPlan)(planPath, {
      ...options,
      ...(branchPicker.select.value ? { baseBranch: branchPicker.select.value } : {}),
    });
  pane.replaceChildren();

  const wrap = el('div', 'ob-pane--ask');
  const ask = el('div', 'ob-ask');

  ask.appendChild(el('p', 'ob-ask__eyebrow orchestrate-hub__eyebrow', 'Orchestrate'));
  ask.appendChild(el('h1', 'ob-ask__title orchestrate-hub__title', 'Boards & plans'));
  ask.appendChild(
    el(
      'p',
      'ob-ask__lede orchestrate-hub__lede',
      'Run a plan as a board, or resume work already listed in the rail.',
    ),
  );

  const workspaceLine = el('p', 'ob-ask__workspace orchestrate-hub__workspace');
  workspaceLine.id = 'orchestrateHubWorkspace';
  const workspaceLabel = getWorkspaceLabel().trim();
  const workspacePath = getWorkspacePath().trim();
  const workspaceDisplay = workspaceLabel || workspacePath;
  if (workspaceDisplay) {
    workspaceLine.textContent = workspaceDisplay;
    if (workspacePath && workspacePath !== workspaceDisplay) {
      workspaceLine.title = workspacePath;
    }
  } else {
    workspaceLine.classList.add('hidden');
    workspaceLine.setAttribute('aria-hidden', 'true');
  }
  ask.appendChild(workspaceLine);

  const sec = el('span', 'ob-ask__sec hub-strip__label', 'Start from plan');
  sec.id = 'orchestrateHubPlanLabel';

  const workflow = el('section', 'orchestrate-hub__workflow');
  workflow.setAttribute('aria-labelledby', 'orchestrateHubPlanLabel');

  const field = el('div', 'ob-ask__field orchestrate-hub__workflow-body');
  const sel = el('select', 'orchestrate-hub__plan-select') as HTMLSelectElement;
  sel.id = 'orchestrateHubPlanSelect';
  sel.setAttribute('aria-label', 'Orchestrate plan file');
  const loadingOpt = el('option');
  loadingOpt.value = '';
  loadingOpt.textContent = 'Loading plans…';
  sel.appendChild(loadingOpt);
  sel.disabled = true;

  const workflowActions = el('div', 'ob-ask__actions orchestrate-hub__workflow-actions');
  const secondaryActions = el('div', 'orchestrate-hub__workflow-secondary');

  const refreshBtn = el('button', 'orchestrate-hub__plan-refresh', 'Refresh') as HTMLButtonElement;
  refreshBtn.type = 'button';
  refreshBtn.id = 'orchestrateHubPlanRefresh';
  refreshBtn.title = 'Reload plan list from workspace';

  const makePlanBtn = el(
    'button',
    'orchestrate-hub__make-plan-btn',
    'Make a plan',
  ) as HTMLButtonElement;
  makePlanBtn.type = 'button';
  makePlanBtn.id = 'orchestrateHubMakePlan';

  secondaryActions.append(refreshBtn, makePlanBtn);

  const startBtn = el('button', 'orchestrate-hub__start-btn', 'Open board') as HTMLButtonElement;
  startBtn.type = 'button';
  startBtn.id = 'orchestrateHubStartBoard';
  startBtn.disabled = true;

  workflowActions.append(secondaryActions, startBtn);
  field.append(sel, branchPicker.field, workflowActions);

  const hint = el('p', 'orchestrate-hub__plan-hint hidden');
  hint.id = 'orchestrateHubPlanHint';
  hint.setAttribute('role', 'status');

  const errors = el('div', 'ov2-create__errors');
  errors.id = 'orchestrateBoardsAskErrors';

  const previewSection = el('div', 'orchestrate-hub__plan-preview');
  previewSection.id = 'orchestrateHubPlanPreview';
  previewSection.hidden = true;
  previewSection.setAttribute('aria-live', 'polite');

  const pathChip = el('p', 'orchestrate-plan-screen__path');
  pathChip.id = 'orchestrateHubPlanPreviewPath';

  const previewWrap = el('div', 'orchestrate-plan-screen__preview-wrap');
  const previewMount = el('div', 'orchestrate-plan-screen__preview');
  previewMount.id = 'orchestrateHubPlanPreviewMount';
  previewWrap.appendChild(previewMount);
  previewSection.append(pathChip, previewWrap);

  workflow.append(sec, field, hint, errors, previewSection);
  ask.appendChild(workflow);
  wrap.appendChild(ask);
  pane.appendChild(wrap);

  const previewElements = {
    section: previewSection,
    pathChip,
    previewMount,
  };

  // While Repair is running, keep the picker and Open board locked.
  let repairBusy = false;

  const syncStartDisabled = () => {
    const path = sel.value.trim();
    startBtn.disabled = repairBusy || !path || !isExecutableOrchestratePlan(path);
  };

  const syncPlanPreview = () => {
    void refreshAskPlanPreview(sel.value, previewElements);
  };

  const loadPlans = async () => {
    sel.disabled = true;
    await fillBoardsPlanSelect(sel, hint, {
      ...(handlers.discoverPlans ? { discoverPlans: handlers.discoverPlans } : {}),
    });
    sel.disabled = repairBusy;
    syncStartDisabled();
    syncPlanPreview();
  };

  sel.addEventListener('change', () => {
    errors.replaceChildren();
    syncStartDisabled();
    syncPlanPreview();
  });

  refreshBtn.addEventListener('click', () => {
    void loadPlans();
  });

  makePlanBtn.addEventListener('click', () => {
    void import('../ui/orchestrate-plan-screen').then((m) => m.openOrchestratePlanScreen());
  });

  startBtn.addEventListener('click', () => {
    const planPath = sel.value.trim();
    if (!planPath || !isExecutableOrchestratePlan(planPath)) return;
    errors.replaceChildren();
    startBtn.disabled = true;
    startBtn.textContent = 'Creating…';
    void createBoard(planPath)
      .then(({ boardId }) => {
        handlers.onCreated(boardId);
      })
      .catch((err: unknown) => {
        errors.replaceChildren(
          renderCreateError(err, {
            planPath,
            createBoard,
            onCreated: handlers.onCreated,
            ...(handlers.startPlanRepair ? { startPlanRepair: handlers.startPlanRepair } : {}),
            ...(handlers.cancelPlanRepair ? { cancelPlanRepair: handlers.cancelPlanRepair } : {}),
            setBusy: (busy) => {
              repairBusy = busy;
              sel.disabled = busy;
              if (busy) startBtn.disabled = true;
              else syncStartDisabled();
            },
          }),
        );
      })
      .finally(() => {
        startBtn.textContent = 'Open board';
        syncStartDisabled();
      });
  });

  await branchPicker.load(handlers.discoverBranches);
  await loadPlans();
  sel.focus();
}

function paintAskErrors(pane: HTMLElement): void {
  const slot = pane.querySelector('#orchestrateBoardsAskErrors');
  if (!(slot instanceof HTMLElement)) return;
  slot.replaceChildren();
  if (!notice) return;
  const line = el('p', `ov2-notice ov2-notice--${notice.tone}`, notice.text);
  line.setAttribute('role', 'status');
  slot.appendChild(line);
}

function openAskPane(): void {
  if (!surface) return;
  surface.boardPane.querySelector('[data-plan-launch]')?.remove();
  if (selectedBoardId) {
    selectBoard(null);
  } else {
    paintBoard();
  }
  const sel = document.getElementById('orchestrateHubPlanSelect');
  if (sel instanceof HTMLSelectElement) sel.focus();
}

export async function mountCreateForm(
  pane: HTMLElement,
  handlers: CreateFormHandlers,
): Promise<void> {
  const branchPicker = createStartingBranchPicker('ov2-create__input');
  const createBoard: NonNullable<CreateFormHandlers['createBoard']> = (planPath, options) =>
    (handlers.createBoard ?? createBoardFromPlan)(planPath, {
      ...options,
      ...(branchPicker.select.value ? { baseBranch: branchPicker.select.value } : {}),
    });
  pane.replaceChildren();

  const form = el('form', 'ov2-create');
  form.appendChild(el('h2', 'ov2-create__title', 'New board'));
  form.appendChild(
    el(
      'p',
      'ov2-create__hint',
      'The plan is parsed, not interpreted by a model. A plan that does not parse ' +
        'is refused with line numbers rather than turned into a board with tasks missing.',
    ),
  );

  const pathField = el('div', 'ov2-create__field');
  pathField.appendChild(el('span', undefined, 'Plan'));
  const pathRow = el('div', 'ov2-create__field-row');
  const pathSelect = el('select', 'ov2-create__input');
  pathSelect.required = true;
  pathSelect.setAttribute('aria-label', 'Plan');
  const loadingOpt = el('option');
  loadingOpt.value = '';
  loadingOpt.textContent = 'Loading plans…';
  pathSelect.appendChild(loadingOpt);
  pathSelect.disabled = true;
  pathRow.appendChild(pathSelect);
  pathField.appendChild(pathRow);
  form.appendChild(pathField);

  const pathHint = el('p', 'ov2-create__hint hidden');
  pathHint.setAttribute('role', 'status');
  form.appendChild(pathHint);
  form.appendChild(branchPicker.field);

  const idLabel = el('label', 'ov2-create__field');
  idLabel.appendChild(el('span', undefined, 'Board id (optional)'));
  const idInput = el('input', 'ov2-create__input');
  idInput.type = 'text';
  idInput.placeholder = 'derived from the plan name';
  idLabel.appendChild(idInput);
  form.appendChild(idLabel);

  const errors = el('div', 'ov2-create__errors');
  form.appendChild(errors);

  const actions = el('div', 'ov2-create__actions');
  const submit = el('button', 'ov2-btn ov2-btn--primary', 'Create');
  submit.type = 'submit';
  submit.disabled = true;
  actions.appendChild(submit);
  actions.appendChild(button({ label: 'Cancel', variant: 'ghost', onClick: handlers.onCancel }));
  form.appendChild(actions);

  // While Repair is running, keep the plan picker and Create locked.
  let repairBusy = false;

  const syncSubmitEnabled = () => {
    submit.disabled = repairBusy || !pathSelect.value.trim();
  };

  const loadPlans = async () => {
    pathSelect.disabled = true;
    await fillBoardsPlanSelect(pathSelect, pathHint, {
      ...(handlers.discoverPlans ? { discoverPlans: handlers.discoverPlans } : {}),
    });
    pathSelect.disabled = repairBusy;
    syncSubmitEnabled();
  };

  pathRow.appendChild(
    button({
      label: 'Refresh',
      title: 'Reload plan list from the workspace',
      variant: 'ghost',
      onClick: () => void loadPlans(),
    }),
  );

  pathSelect.addEventListener('change', syncSubmitEnabled);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const planPath = pathSelect.value.trim();
    if (!planPath) return;
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = 'Creating…';
    void createBoard(planPath, {
      ...(idInput.value.trim() ? { boardId: idInput.value.trim() } : {}),
    })
      .then(({ boardId }) => {
        handlers.onCreated(boardId);
      })
      .catch((err: unknown) => {
        errors.replaceChildren(
          renderCreateError(err, {
            planPath,
            ...(idInput.value.trim() ? { boardId: idInput.value.trim() } : {}),
            createBoard,
            onCreated: handlers.onCreated,
            ...(handlers.startPlanRepair ? { startPlanRepair: handlers.startPlanRepair } : {}),
            ...(handlers.cancelPlanRepair ? { cancelPlanRepair: handlers.cancelPlanRepair } : {}),
            setBusy: (busy) => {
              repairBusy = busy;
              pathSelect.disabled = busy;
              if (busy) submit.disabled = true;
              else syncSubmitEnabled();
            },
          }),
        );
      })
      .finally(() => {
        submit.textContent = 'Create';
        syncSubmitEnabled();
      });
  });

  pane.appendChild(form);
  await branchPicker.load(handlers.discoverBranches);
  await loadPlans();
  pathSelect.focus();
}

function paintParseErrorList(items: HTMLElement, errors: ParseError[]): void {
  items.replaceChildren();
  for (const error of errors) {
    const item = el('li', 'ov2-create__parse-item');
    item.appendChild(el('span', 'ov2-create__parse-loc', `line ${error.line}:${error.column}`));
    item.appendChild(el('span', 'ov2-create__parse-msg', error.message));
    if (error.hint) item.appendChild(el('span', 'ov2-create__parse-hint', error.hint));
    items.appendChild(item);
  }
}

/** Parse errors plus optional Repair, which stays on Boards and retries Open board. */
function renderCreateError(err: unknown, repair?: CreateErrorRepairContext): HTMLElement {
  if (!(err instanceof PlanParseFailure)) {
    return el('p', 'ov2-create__error', err instanceof Error ? err.message : String(err));
  }

  const wrap = el('div', 'ov2-create__parse');
  const title = el('p', 'ov2-create__parse-title', 'The plan does not parse:');
  wrap.appendChild(title);

  const items = el('ul', 'ov2-create__parse-list');
  paintParseErrorList(items, err.errors);
  wrap.appendChild(items);

  if (!repair?.planPath) return wrap;

  // Latest errors go back to the agent on a second Repair click — the original
  // PlanParseFailure is frozen after the first Open board.
  let currentErrors: ParseError[] = [...err.errors];

  const status = el('p', 'ov2-create__parse-status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  wrap.appendChild(status);

  const actions = el('div', 'ov2-create__parse-actions');
  const startRepair = repair.startPlanRepair ?? startPlanRepair;
  const cancelRepair = repair.cancelPlanRepair ?? cancelPlanRepair;

  let running = false;
  let succeeded = false;

  const setRunning = (next: boolean) => {
    running = next;
    wrap.setAttribute('aria-busy', next ? 'true' : 'false');
    title.textContent = next ? 'Repairing plan…' : 'The plan does not parse:';
    repairBtn.disabled = next;
    cancelBtn.hidden = !next;
    repair.setBusy?.(next);
  };

  const repairBtn = button({
    label: 'Repair',
    title: 'Fix this plan to the required schema, then open the board',
    variant: 'primary',
    onClick: () => {
      if (running) return;
      status.hidden = true;
      status.textContent = '';
      setRunning(true);
      succeeded = false;
      void startRepair({
        planPath: repair.planPath,
        errors: currentErrors,
        ...(repair.boardId ? { boardId: repair.boardId } : {}),
        createBoard: repair.createBoard,
      })
        .then((result) => {
          if (result.ok) {
            succeeded = true;
            repair.onCreated(result.boardId);
            return;
          }
          if ('alreadyRunning' in result && result.alreadyRunning) {
            status.hidden = false;
            status.textContent = 'Repair is already running.';
            return;
          }
          if ('parseFailure' in result && result.parseFailure) {
            currentErrors = [...result.parseFailure.errors];
            paintParseErrorList(items, currentErrors);
            return;
          }
          status.hidden = false;
          status.textContent = 'error' in result ? result.error : 'Plan repair failed';
        })
        .finally(() => {
          if (!succeeded) setRunning(false);
        });
    },
  });

  const cancelBtn = button({
    label: 'Cancel',
    onClick: () => {
      cancelRepair(repair.planPath);
    },
  });
  cancelBtn.hidden = true;

  actions.append(repairBtn, cancelBtn);
  wrap.appendChild(actions);
  return wrap;
}

function captureFocus(): { key: string; selectionStart: number | null } | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !surface?.root.contains(active)) return null;
  const key = active.dataset?.focusKey;
  if (!key) return null;
  const input = active as HTMLInputElement;
  return {
    key,
    selectionStart: typeof input.selectionStart === 'number' ? input.selectionStart : null,
  };
}

function restoreFocus(captured: { key: string; selectionStart: number | null } | null): void {
  if (!captured || !surface) return;
  const target = surface.root.querySelector<HTMLElement>(
    `[data-focus-key="${CSS.escape(captured.key)}"]`,
  );
  if (!target || (target as HTMLButtonElement).disabled) {
    if (captured.key.startsWith('detail-action:')) taskModal?.overlay.querySelector<HTMLElement>('[data-focus-key="detail-menu"]')?.focus();
    return;
  }
  if (target === document.activeElement) return;
  target.focus({ preventScroll: true });
  if (captured.selectionStart === null) return;
  const input = target as HTMLInputElement;
  try {
    input.setSelectionRange(captured.selectionStart, captured.selectionStart);
  } catch {}
}

// ── Board ────────────────────────────────────────────────────────────────────

function syncBoardsLayout(mounted: Surface): boolean {
  const width = mounted.root.getBoundingClientRect().width;
  const desktopLayout = width >= 840 && document.documentElement.classList.contains('mn-graphite-apps');
  if (mounted.desktopLayout === desktopLayout) return false;
  mounted.desktopLayout = desktopLayout;
  mounted.root.classList.toggle('is-graphite-overview', desktopLayout);
  return true;
}

function closeTaskDetail(): void {
  selectedTaskId = null;
  if (taskModal) {
    if (taskModal.overlay.querySelector('.mn-menu')) closeContextMenu({ restoreFocus: false });
    taskModal.release();
    unmarkPreviewOccluder(taskModal.overlay);
    taskModal.overlay.remove();
  }
  taskModal = null;
  clearTaskDetailState();
}

function mountTaskDetail(root: HTMLElement, overlay: HTMLElement): void {
  root.appendChild(overlay);
  taskModal = {
    overlay,
    release: isolateModalBackground(overlay, overlay.closest<HTMLElement>('#osStage') ?? document.body),
  };
  markPreviewOccluder(overlay, 'dialog');
}

function paintBoard(): void {
  if (!surface) return;
  // Journal events can repaint the entire board while a task actions menu is
  // open. Keep its anchor stable until the user dismisses or chooses an item.
  if (deferUntilContextMenuClosed(paintBoard)) return;
  // Board paints replace the header that owns the popover trigger.
  closeTimelinePopover(false);
  const pane = surface.boardPane;

  if (!selectedBoardId) {
    attentionInbox?.update([]);
    updateStrip({}, {}, undefined, { costUsd: null, board: true });
    if (pane.querySelector('[data-plan-launch]')) return;
    detachV2BoardHeaderInstruments();
    closeTaskDetail();
    pane.classList.add('ov2__board--ask');
    if (pane.querySelector('.ob-pane--ask')) {
      paintAskErrors(pane);
      return;
    }
    void mountBoardsAskPane(pane, {
      onCreated: (boardId) => {
        pane.classList.remove('ov2__board--ask');
        void list?.refresh();
        selectBoard(boardId);
      },
    });
    return;
  }

  pane.classList.remove('ov2__board--ask');

  const state = client?.getState() ?? null;
  if (!state) {
    attentionInbox?.update([]);
    updateStrip({}, {}, undefined, { costUsd: null, board: true });
    detachV2BoardHeaderInstruments();
    closeTaskDetail();
    pane.replaceChildren(renderBoardSkeleton());
    return;
  }

  const metrics = boardUsage(state, client?.getLiveRounds());
  updateStrip(metrics.stats, metrics.usage, undefined, { costUsd: null, board: true });
  const metricsButton = document.getElementById('statsExpandBtn');
  metricsButton?.setAttribute('aria-label', `Show board metrics, ${metrics.measured} measured attempts or rounds, ${metrics.active} active attempts`);

  const connected = client?.isConnected() ?? false;
  const scrollTop = pane.scrollTop;
  const focused = captureFocus();
  detachV2BoardHeaderInstruments();
  pane.replaceChildren();
  const header = renderBoardHeader(state, connected, renderControls(state), surface.desktopLayout);
  pane.appendChild(header);
  const recoveryClient = client;
  const headerControls = pane.querySelector('.board-header__controls');
  let attention: BoardAttentionItem[] = [];
  if (headerControls instanceof HTMLElement) {
    attentionInbox ??= createBoardAttentionInbox();
    headerControls.prepend(attentionInbox.element);
    attention = collectBoardAttention(state, {
      resetTask: (taskId) => {
        attentionInbox?.close();
        void commandResetTask(taskId);
      },
      fixFinal: () => {
        attentionInbox?.close();
        void commandRerun();
      },
      checkRecovery: async (key) => {
        if (!recoveryClient?.checkRecovery) throw new Error('Reconnect to check recovery.');
        await recoveryClient.checkRecovery(key);
      },
    }, client?.getEngineErrors(), notice);
    attentionInbox.update(attention);
    attachV2BoardHeaderInstruments(headerControls, state, {
      setModel: commandSetModel,
      onNeedModel: () => {
        notice = { text: 'Pick a model for this board first.', tone: 'warn' };
        paintBoard();
      },
    });
  }
  maybeSeedBoardModel(state);

  const showReport = showingReport(state);
  if (finishReportSeq.get(selectedBoardId!) !== client?.getSeq()) {
    finishReportByBoard.delete(selectedBoardId!);
  }
  if (showReport) {
    const cached = selectedBoardId ? (finishReportByBoard.get(selectedBoardId) ?? null) : null;
    if (!cached && selectedBoardId) void loadFinishReport(selectedBoardId);
    pane.appendChild(
      renderBoardReport(state, cached, Boolean(selectedBoardId) && !cached, {
        dismiss: () => {
          if (selectedBoardId) reportDismissed.add(selectedBoardId);
          paintBoard();
        },
        reopen: () => void commandRerun(),
        fixFinal: () => void commandRerun(),
        resetTask: (taskId: string) => void commandResetTask(taskId),
      }),
    );
    closeTaskDetail();
    pane.scrollTop = scrollTop;
    restoreFocus(focused);
    return;
  }

  const actions = boardActions();
  const options = boardViewOptions();

  const body = el('div', 'ov2__board-body');
  if (surface.desktopLayout) {
    header.append(renderBoardPaneTabs(attention.length));
    body.id = 'graphite-board-pane';
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', `graphite-board-tab-${selectedPane.toLowerCase()}`);
  }
  if (surface.desktopLayout && selectedPane !== 'Waves') {
    closeTaskDetail();
    body.append(selectedPane === 'Activity' ? renderBoardActivity(state.boardId) : renderBoardVerification(state));
    pane.append(body);
    pane.scrollTop = scrollTop;
    restoreFocus(focused);
    return;
  }
  const warning = surface.desktopLayout ? attention.find(item => item.tone === 'warn' || item.tone === 'bad') : undefined;
  if (warning) {
    const notice = el('section', 'ov2__board-warning');
    notice.dataset.tone = warning.tone;
    const copy = el('div');
    copy.append(el('strong', undefined, warning.title), el('p', undefined, warning.subtitle));
    const review = el('button', 'board-btn board-btn--compact', 'Review');
    review.type = 'button';
    review.addEventListener('click', () => attentionInbox?.element.click());
    notice.append(createIcon(warning.icon, { size: 16 }), copy, review);
    body.append(notice);
  }
  body.append(renderTaskList(state, actions, options), renderMergeQueue(state));
  pane.append(body);

  const selected = selectedTaskId ? state.tasks.get(selectedTaskId) : undefined;
  pane.scrollTop = scrollTop;
  const existingOverlay = taskModal?.overlay;
  if (!selected) {
    if (taskModal || selectedTaskId) closeTaskDetail();
  } else if (existingOverlay) {
    const attemptId = transcript?.attemptId;
    if (attemptId && !selected.attempts.some((attempt) => attempt.attemptId === attemptId)) {
      transcript = null;
      resetTaskDetailLogUi();
    }
    syncTaskDetailOverlay(existingOverlay, state, selected, actions, boardViewOptions());
  } else {
    mountTaskDetail(surface.root, renderTaskDetail(state, selected, actions, options));
  }
  syncLogPolling(state);
  syncElapsedTicker(state);

  restoreFocus(focused);
}

function renderBoardPaneTabs(attentionCount: number): HTMLElement {
  const tabs = el('div', 'ov2__view-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Board views');
  function select(next: BoardPane): void {
    if (selectedPane === next) return;
    selectedPane = next;
    if (next !== 'Waves') closeTaskDetail();
    paintBoard();
    document.getElementById(`graphite-board-tab-${next.toLowerCase()}`)?.focus({ preventScroll: true });
  }
  for (const name of BOARD_PANES) {
    const tab = el('button', 'ov2__view-tab', name);
    tab.type = 'button';
    tab.id = `graphite-board-tab-${name.toLowerCase()}`;
    tab.dataset.focusKey = `board-view:${name}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'graphite-board-pane');
    tab.setAttribute('aria-selected', String(name === selectedPane));
    tab.tabIndex = name === selectedPane ? 0 : -1;
    if (name === 'Waves' && attentionCount) {
      tab.append(el('span', 'ov2__view-tab-count', String(attentionCount)));
      tab.setAttribute('aria-label', `Waves, ${attentionCount} board notices`);
    }
    tab.addEventListener('click', () => select(name));
    tabs.append(tab);
  }
  tabs.addEventListener('keydown', (event) => {
    const index = BOARD_PANES.indexOf(selectedPane);
    const next = event.key === 'Home' ? BOARD_PANES[0] : event.key === 'End' ? BOARD_PANES[BOARD_PANES.length - 1]
      : event.key === 'ArrowRight' ? BOARD_PANES[(index + 1) % BOARD_PANES.length]
        : event.key === 'ArrowLeft' ? BOARD_PANES[(index + BOARD_PANES.length - 1) % BOARD_PANES.length] : null;
    if (!next) return;
    event.preventDefault();
    select(next);
  });
  return tabs;
}

function renderBoardVerification(state: BoardState): HTMLElement {
  const section = el('section', 'ov2__verification');
  section.append(el('h3', undefined, 'Verification'));
  const ledger = renderRunLedger(state, boardActions());
  if (ledger) section.append(ledger);
  else {
    const list = el('ul', 'ov2__verification-list');
    for (const task of state.tasks.values()) {
      if (!task.testSpec) continue;
      const test = task.attempts.filter(attempt => attempt.role === 'tester' && !attempt.retired).at(-1);
      const status = test?.ended ? (test.outcome === 'pass' ? 'Passed' : test.outcome || 'Ended') : test ? 'Running' : 'Waiting';
      const row = el('li');
      row.append(el('code', undefined, task.id), el('span', undefined, task.title),
        pill(status, status === 'Passed' ? 'good' : test?.ended ? 'warn' : 'neutral'));
      list.append(row);
    }
    section.append(list.children.length ? list : el('p', 'ov2-notice', 'There are no task checks to show yet.'));
  }
  return section;
}

function renderBoardActivity(boardId: string): HTMLElement {
  const section = el('section', 'ov2__activity');
  const heading = el('header', 'ov2__activity-header');
  const refresh = el('button', 'board-btn board-btn--compact', 'Refresh');
  refresh.type = 'button';
  refresh.addEventListener('click', () => void loadTimeline());
  heading.append(el('h3', undefined, 'Activity'), refresh);
  const content = el('div', 'ov2__activity-content');
  if (journalView?.boardId === boardId) content.append(renderTimeline(journalView.events, journalView.truncated));
  else if (journalLoad?.error) content.append(el('p', 'ov2-notice ov2-notice--warn', journalLoad.error));
  else {
    content.textContent = 'Loading activity…';
    void loadTimeline();
  }
  section.append(heading, content);
  return section;
}

function boardActions() {
  return {
    startTask: (taskId: string) => void commandStartTask(taskId),
    abandonTask: (taskId: string) => void commandAbandonTask(taskId),
    skipTask: (taskId: string) => void commandSkipTask(taskId),
    mergeAndSkipTask: (taskId: string) => void commandMergeAndSkipTask(taskId),
    editTask: (taskId: string, changes: TaskEditChanges) =>
      void commandEditTask(taskId, changes),
    resetTask: (taskId: string) => void commandResetTask(taskId),
    rewindTask: (taskId: string) => void commandRewindTask(taskId),
    rerun: (taskIds?: string[]) => void commandRerun(taskIds),
    select: (taskId: string | null) => selectTaskDetail(taskId),
    openTranscript: (attemptId: string) => void toggleTranscript(attemptId),
    toggleFileDiff: (path: string) => void toggleFileDiff(path),
    openFile: (path: string) => void openTaskFile(path),
  };
}

function boardViewOptions() {
  return {
    selectedTaskId,
    desktopLayout: surface?.desktopLayout,
    pendingTaskIds: pendingTasks,
    liveActivity: client?.getLiveActivity(),
    attemptStartedAt: client?.getAttemptStartedAt(),
    attemptEndedAt: client?.getAttemptEndedAt(),
    now: Date.now(),
    engineErrors: client?.getEngineErrors(),
    transcript,
    files: taskFilesView(),
    taskNotice: notice,
  };
}

/**
 * Live thinking/tool frames: patch cards and the open thread. Never paintBoard —
 * replacing the card between mousedown and mouseup is why detail would not open.
 */
function patchLiveUi(): void {
  if (!surface || !client) return;
  const boardState = client.getState();
  if (boardState) {
    const metrics = boardUsage(boardState, client.getLiveRounds());
    updateStrip(metrics.stats, metrics.usage, undefined, { costUsd: null, board: true });
    document.getElementById('statsExpandBtn')?.setAttribute('aria-label',
      `Show board metrics, ${metrics.measured} measured attempts or rounds, ${metrics.active} active attempts`);
  }
  const live = client.getLiveActivity();
  const started = client.getAttemptStartedAt();
  const now = Date.now();
  for (const [taskId, activity] of live) {
    const task = boardState?.tasks.get(taskId);
    const attempt = task ? runningAttempt(task) : null;
    if (!boardState || !attempt || attempt.attemptId !== activity.attemptId || attemptInterruption(boardState, attempt)) continue;
    const card = surface.root.querySelector<HTMLElement>(
      `.ov2-task[data-task-id="${CSS.escape(taskId)}"]`,
    );
    if (!card) continue;
    syncTaskCardActivity(card, activity, started.get(activity.attemptId) ?? null, now);
  }

  const overlay = taskModal?.overlay;
  const state = client.getState();
  const task = selectedTaskId && state ? state.tasks.get(selectedTaskId) : undefined;
  if (!overlay || !task || !state) return;
  syncTaskDetailOverlay(overlay, state, task, boardActions(), boardViewOptions(), {
    syncWork: false,
    thread: 'tail',
  });
}

const scheduleLiveUi = scheduleAnimationFrame(patchLiveUi);

// ── Elapsed clocks ───────────────────────────────────────────────────────────

let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function stopElapsedTicker(): void {
  if (elapsedTimer === null) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

/**
 * Tick the running clocks in place.
 *
 * Repainting the board once a second would tear down the model chip, the
 * transcript and the focus ring for the sake of one number, so the clocks carry
 * their own start time and only their text changes.
 */
function syncElapsedTicker(state: BoardState): void {
  const anyRunning = [...state.tasks.values()].some((task) => {
    const attempt = runningAttempt(task);
    return attempt && !attemptInterruption(state, attempt);
  });
  if (!anyRunning || !surface) {
    stopElapsedTicker();
    return;
  }
  if (elapsedTimer !== null) return;
  elapsedTimer = setInterval(() => {
    const root = surface?.root;
    if (!root) {
      stopElapsedTicker();
      return;
    }
    const clocks = root.querySelectorAll<HTMLElement>('.ov2-activity__elapsed[data-started-at]');
    if (clocks.length === 0) {
      stopElapsedTicker();
      return;
    }
    const now = Date.now();
    for (const clock of clocks) {
      const startedAt = Number(clock.dataset.startedAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
      clock.textContent = formatElapsed(now - startedAt);
    }
  }, 1_000);
}

function clearTaskDetailState(): void {
  transcript = null;
  taskFiles = null;
  fileDiffs.clear();
  expandedFiles.clear();
  stopLogPolling();
  resetTaskDetailUi();
  finalTranscriptAttemptId = null;
}

const LOG_POLL_MS = 1_200;
let logPollTimer: ReturnType<typeof setInterval> | null = null;
let transcriptRefreshController: AbortController | null = null;
let finalTranscriptAttemptId: string | null = null;

function stopLogPolling(cancelPending = true): void {
  if (cancelPending) {
    transcriptRefreshController?.abort();
    transcriptRefreshController = null;
  }
  if (logPollTimer === null) return;
  clearInterval(logPollTimer);
  logPollTimer = null;
}

function syncLogPolling(state: BoardState): void {
  const attemptId = transcript?.attemptId;
  const task = selectedTaskId ? state.tasks.get(selectedTaskId) : undefined;
  const attempt = attemptId
    ? task?.attempts.find((candidate) => candidate.attemptId === attemptId)
    : undefined;
  const wanted = Boolean(attempt && !attempt.ended);
  if (!wanted) {
    stopLogPolling(false);
    if (attempt?.ended && transcript?.status === 'ready' && finalTranscriptAttemptId !== attempt.attemptId) {
      finalTranscriptAttemptId = attempt.attemptId;
      transcriptRefreshController?.abort();
      transcriptRefreshController = null;
      void refreshTranscript(attempt.attemptId);
    }
    return;
  }
  if (logPollTimer !== null) return;
  logPollTimer = setInterval(() => {
    if (document.hidden || !transcript || transcript.status === 'loading') return;
    void refreshTranscript(transcript.attemptId);
  }, LOG_POLL_MS);
}

async function refreshTranscript(attemptId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  if (transcriptRefreshController) return;
  const controller = new AbortController();
  transcriptRefreshController = controller;
  try {
    const result = await readAttemptTranscript(boardId, attemptId, { limit: 500,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    if (controller.signal.aborted) return;
    if (transcript?.attemptId !== attemptId || boardId !== selectedBoardId) return;
    const previous = transcript;
    const sameStructure =
      previous?.status === 'ready' &&
      transcriptStructureKey(previous.events) === transcriptStructureKey(result.events);
    transcript = { attemptId, status: 'ready', ...result };
    const overlay = taskModal?.overlay;
    const state = client?.getState();
    const task = selectedTaskId && state ? state.tasks.get(selectedTaskId) : undefined;
    if (overlay && task && state) {
      syncTaskDetailOverlay(overlay, state, task, boardActions(), boardViewOptions(), {
        syncWork: false,
        thread: sameStructure ? 'tail' : 'body',
      });
      return;
    }
    paintBoard();
  } catch {} finally {
    if (transcriptRefreshController === controller) transcriptRefreshController = null;
  }
}

function taskFilesView(): TaskFilesView | null {
  if (!taskFiles) return null;
  return { ...taskFiles, diffs: fileDiffs, expanded: expandedFiles };
}

async function loadTaskFiles(taskId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  if (taskFiles?.taskId === taskId && taskFiles.status !== 'error') return;

  const loading: TaskFilesView = {
    taskId,
    status: 'loading',
    source: 'planned',
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
    diffs: fileDiffs,
    expanded: expandedFiles,
  };
  taskFiles = loading;
  paintBoard();
  try {
    const result = await readTaskFiles(boardId, taskId);
    if (taskFiles !== loading) return;
    taskFiles = { ...taskFiles, ...result, status: 'ready' };
  } catch (err) {
    if (taskFiles !== loading) return;
    taskFiles = {
      ...taskFiles,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  paintBoard();
}

async function toggleFileDiff(path: string): Promise<void> {
  const boardId = selectedBoardId;
  const taskId = selectedTaskId;
  if (!boardId || !taskId) return;

  if (expandedFiles.has(path)) {
    expandedFiles.delete(path);
    paintBoard();
    return;
  }
  expandedFiles.add(path);
  if (fileDiffs.get(path)?.status === 'ready') {
    paintBoard();
    return;
  }
  const loading: FileDiffView = { status: 'loading', lines: [], truncated: false };
  fileDiffs.set(path, loading);
  paintBoard();
  try {
    const result = await readTaskFileDiff(boardId, taskId, path);
    if (fileDiffs.get(path) !== loading) return;
    fileDiffs.set(
      path,
      result
        ? { status: 'ready', lines: result.lines, truncated: result.truncated }
        : { status: 'ready', lines: [], truncated: false },
    );
  } catch (err) {
    if (fileDiffs.get(path) !== loading) return;
    fileDiffs.set(path, {
      status: 'error',
      lines: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  paintBoard();
}

async function openTaskFile(path: string): Promise<void> {
  const { openFileInViewer } = await import('../ui/file-viewer');
  if (usesGraphiteContentTabs()) await closeBoardsView();
  await openFileInViewer(path);
}

async function toggleTranscript(attemptId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  finalTranscriptAttemptId = null;
  if (transcript?.attemptId === attemptId) {
    transcript = null;
    resetTaskDetailLogUi();
    paintBoard();
    return;
  }
  resetTaskDetailLogUi();
  const loading: TranscriptView = { attemptId, status: 'loading', events: [], truncated: false, capped: false };
  transcript = loading;
  paintBoard();
  try {
    const result = await readAttemptTranscript(boardId, attemptId, { limit: 500 });
    if (transcript !== loading) return;
    transcript = { attemptId, status: 'ready', ...result };
  } catch (err) {
    if (transcript !== loading) return;
    transcript = {
      attemptId,
      status: 'error',
      events: [],
      truncated: false,
      capped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  paintBoard();
}

function renderControls(state: BoardState): HTMLElement {
  const controls = el('div', 'board-header__controls');
  const finished = state.finished;
  const running = state.status === 'running';
  const paused = state.stopReason === 'paused';

  const modelSlot = el('div', 'board-header__model-slot mn-os-mb-model-slot');
  modelSlot.title = state.model
    ? `${state.model.providerId} / ${state.model.id}`
    : 'Unbound: attempts use the Autopilot planner model.';
  controls.appendChild(modelSlot);

  const settings = el('div', 'board-header__settings');
  settings.setAttribute('role', 'group');
  settings.setAttribute('aria-label', 'Run settings');
  settings.appendChild(renderConcurrencyControl(state, finished, running));
  controls.appendChild(settings);

  const rerunInstead = finished;
  const runBtn = el(
    'button',
    running ? 'board-header__run-btn board-header__run-btn--stop' : 'board-header__run-btn',
  );
  runBtn.type = 'button';
  runBtn.disabled = false;
  runBtn.textContent = running ? 'Pause' : paused ? 'Resume' : rerunInstead ? 'Rerun' : 'Start';
  runBtn.setAttribute(
    'aria-label',
    running ? 'Pause board' : paused ? 'Resume board' : rerunInstead ? 'Rerun failed work' : 'Start board',
  );
  runBtn.title = running
    ? 'Pause chats at the next model or tool boundary. Current operations may finish; Resume continues the same chats.'
    : paused
      ? 'Continue the paused chats with their current context and work.'
      : rerunInstead
        ? 'Reopen failed tasks (or add a fix task) and start the board again, with the agent count set beside this button.'
        : 'Start the reconcile loop. One agent works through tasks in order; more than one works on tasks in parallel.';
  runBtn.addEventListener('click', () => {
    if (running) void commandPause();
    else if (rerunInstead) void commandRerun();
    else void commandStart(readConcurrencyInput());
  });
  controls.appendChild(runBtn);
  if (running || paused) {
    const stop = el('button', 'board-btn board-btn--compact', 'Stop');
    stop.type = 'button';
    stop.title = 'End current attempts. Start runs replacement attempts using retained work.';
    stop.addEventListener('click', () => void commandStop());
    controls.appendChild(stop);
  }

  if (wantsReportScreen(state)) {
    const onReport = showingReport(state);
    const toggle = el('button', 'board-btn board-btn--compact board-header__dashboard-toggle');
    toggle.type = 'button';
    toggle.textContent = onReport ? 'Board' : 'Report';
    toggle.title = onReport ? 'Return to the kanban board' : 'Open the run report';
    toggle.setAttribute('aria-label', onReport ? 'Back to board' : 'Open run report');
    toggle.addEventListener('click', () => {
      if (!selectedBoardId) return;
      if (onReport) reportDismissed.add(selectedBoardId);
      else reportDismissed.delete(selectedBoardId);
      paintBoard();
    });
    controls.appendChild(toggle);
  }

  if (!showingReport(state) && !surface?.desktopLayout) {
    const timelineBtn = el('button', 'board-btn board-btn--compact board-timeline-btn');
    timelineBtn.type = 'button';
    timelineBtn.textContent = 'Timeline';
    timelineBtn.title = 'Show the journal';
    timelineBtn.setAttribute('aria-label', 'Show board timeline');
    timelineBtn.setAttribute('aria-haspopup', 'dialog');
    timelineBtn.setAttribute('aria-expanded', 'false');
    timelineBtn.addEventListener('click', () => toggleTimelinePopover(timelineBtn));
    controls.appendChild(timelineBtn);
  }

  const sync = el('button', 'board-btn board-btn--compact', resyncing ? 'Syncing…' : 'Sync plan');
  sync.type = 'button';
  sync.disabled = resyncing;
  sync.title = `Pull changes from ${state.planPath} into this board. You see what will change first.`;
  sync.dataset.focusKey = 'board-resync';
  sync.addEventListener('click', () => void commandResyncPlan());
  const rename = renderRenameControl(state);
  if (surface?.desktopLayout && renamingBoardId !== state.boardId) {
    const more = el('button', 'board-btn board-btn--compact ov2__graphite-more');
    more.type = 'button';
    more.title = 'Board actions';
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.append(createIcon('more', { size: 14 }));
    more.addEventListener('click', () => openContextMenu({
      anchor: more, label: 'Board actions',
      items: [
        { id: 'sync-plan', label: sync.textContent!, disabled: sync.disabled, onSelect: () => sync.click() },
        { id: 'rename-board', label: 'Rename board', onSelect: () => rename.click() },
      ],
    }));
    controls.append(more);
  } else controls.append(sync, rename);
  return controls;
}

function renderConcurrencyControl(
  state: BoardState,
  finished: boolean,
  running: boolean,
): HTMLElement {
  const wrap = el('div', 'board-header__concurrency');
  wrap.title =
    'Agents running at once. Each is a model call and a worktree. There is no hard cap; pick what this machine can hold. Changing it while running takes effect on the next tick; agents already working keep going.';

  const label = el('span', 'board-header__field-label', surface?.desktopLayout ? 'Parallel' : 'Agents');
  wrap.appendChild(label);

  const input = el('input', 'board-header__concurrency-input');
  input.type = 'number';
  input.min = '1';
  input.max = '64';
  const shownN =
    state.status === 'created' ? DEFAULT_BOARD_CONCURRENCY : state.concurrency;
  input.value = String(shownN);
  input.setAttribute('aria-label', 'Agents running at once');
  input.id = 'ov2-concurrency-input';
  input.dataset.focusKey = 'board-concurrency';
  input.disabled = false;
  input.addEventListener('change', () => {
    if (!running || finished) return;
    void commandConcurrency(readConcurrencyInput());
  });
  if (surface?.desktopLayout) {
    wrap.classList.add('board-header__concurrency--stepper');
    const step = (delta: -1 | 1, text: string, labelText: string): HTMLButtonElement => {
      const control = el('button', 'board-header__concurrency-step', text);
      control.type = 'button';
      control.setAttribute('aria-label', labelText);
      control.dataset.focusKey = delta < 0 ? 'board-concurrency-down' : 'board-concurrency-up';
      control.addEventListener('click', () => {
        if (delta < 0) input.stepDown(); else input.stepUp();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return control;
    };
    wrap.append(step(-1, '−', 'Decrease parallel agents'), input, step(1, '+', 'Increase parallel agents'));
  } else wrap.append(input);
  return wrap;
}

function renderRenameControl(state: BoardState): HTMLElement {
  if (renamingBoardId !== state.boardId) {
    const btn = el('button', 'board-btn board-btn--compact', 'Rename');
    btn.type = 'button';
    btn.title = 'Rename this board';
    btn.addEventListener('click', () => {
      renamingBoardId = state.boardId;
      paintBoard();
      surface?.boardPane
        .querySelector<HTMLInputElement>('[data-focus-key="board-rename"]')
        ?.select();
    });
    return btn;
  }

  const form = el('form', 'board-header__rename');
  const input = el('input', 'board-header__rename-input');
  input.type = 'text';
  input.value = state.name || state.boardId;
  input.maxLength = 200;
  input.setAttribute('aria-label', 'Board name');
  input.dataset.focusKey = 'board-rename';
  form.appendChild(input);

  const save = el('button', 'board-btn board-btn--compact board-btn--primary', 'Save');
  save.type = 'submit';
  form.appendChild(save);
  const cancel = el('button', 'board-btn board-btn--compact', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    renamingBoardId = null;
    paintBoard();
  });
  form.appendChild(cancel);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    renamingBoardId = null;
    void commandRename(name);
  });
  return form;
}

function readConcurrencyInput(): number {
  const input = surface?.boardPane.querySelector<HTMLInputElement>('#ov2-concurrency-input');
  const n = Number(input?.value);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_BOARD_CONCURRENCY;
  return Math.min(64, n);
}

function showingReport(state: BoardState): boolean {
  return Boolean(selectedBoardId) && wantsReportScreen(state) && !reportDismissed.has(selectedBoardId!);
}

async function loadFinishReport(boardId: string): Promise<void> {
  if (finishReportLoads.has(boardId)) return;
  const source = client;
  const seq = source?.getSeq();
  finishReportLoads.add(boardId);
  try {
    const { markdown } = await readBoardReport(boardId);
    if (source !== client || seq !== source?.getSeq()) return;
    finishReportByBoard.set(boardId, markdown);
    finishReportSeq.set(boardId, seq ?? 0);
    if (selectedBoardId === boardId) paintBoard();
  } catch {} finally {
    finishReportLoads.delete(boardId);
    if (selectedBoardId === boardId && source === client && seq !== source?.getSeq()) paintBoard();
  }
}

function positionTimelinePopover(anchor: HTMLElement, popover: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const width = popover.offsetWidth || 540;
  const height = popover.offsetHeight || 420;
  const top = Math.max(
    margin,
    Math.min(rect.bottom + gap, window.innerHeight - height - margin),
  );
  const left = Math.max(
    margin,
    Math.min(rect.right - width, window.innerWidth - width - margin),
  );
  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
}

function closeTimelinePopover(restoreFocus = true): void {
  const open = timelinePopover;
  if (!open) return;
  timelinePopover = null;
  open.close(restoreFocus);
}

function toggleTimelinePopover(anchor: HTMLButtonElement): void {
  if (timelinePopover?.anchor === anchor) {
    closeTimelinePopover();
    return;
  }
  closeTimelinePopover(false);

  const popover = el('section', 'ov2-timeline-popover');
  popover.id = TIMELINE_POPOVER_ID;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.tabIndex = -1;

  const head = el('div', 'ov2-timeline-popover__head');
  const title = el('h3', 'ov2-timeline-popover__title', 'Timeline');
  title.id = `${TIMELINE_POPOVER_ID}-title`;
  popover.setAttribute('aria-labelledby', title.id);
  head.appendChild(title);
  const close = el('button', 'ov2-timeline-popover__close', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => closeTimelinePopover());
  head.appendChild(close);
  const body = el('div', 'ov2-timeline-popover__body');
  body.textContent = 'Loading…';
  popover.append(head, body);
  document.body.appendChild(popover);
  positionTimelinePopover(anchor, popover);
  anchor.setAttribute('aria-controls', popover.id);
  anchor.setAttribute('aria-expanded', 'true');

  const closeFromOutside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (popover.contains(target) || anchor.contains(target)) return;
    closeTimelinePopover(false);
  };
  const closeFromEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeTimelinePopover();
  };
  const reposition = () => positionTimelinePopover(anchor, popover);
  const closePopover = (restoreFocus = true) => {
    document.removeEventListener('pointerdown', closeFromOutside, true);
    document.removeEventListener('keydown', closeFromEscape, true);
    window.removeEventListener('resize', reposition);
    popover.remove();
    anchor.removeAttribute('aria-controls');
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor.isConnected) anchor.focus();
  };
  timelinePopover = { root: popover, anchor, close: closePopover };
  document.addEventListener('pointerdown', closeFromOutside, true);
  document.addEventListener('keydown', closeFromEscape, true);
  window.addEventListener('resize', reposition);

  if (journalView?.boardId === selectedBoardId) {
    body.replaceChildren(renderTimeline(journalView.events, journalView.truncated));
  } else {
    void loadTimeline();
  }
}

async function loadTimeline(): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId || (journalLoad?.boardId === boardId && !journalLoad.error)) return;
  const load: NonNullable<typeof journalLoad> = { boardId };
  journalLoad = load;
  const update = (renderContent: () => HTMLElement): void => {
    surface?.boardPane.querySelector('.ov2__activity-content')?.replaceChildren(renderContent());
    const popup = timelinePopover;
    if (popup) {
      popup.root.querySelector('.ov2-timeline-popover__body')?.replaceChildren(renderContent());
      positionTimelinePopover(popup.anchor, popup.root);
    }
  };
  try {
    const { events, truncated } = await readJournal(boardId, { limit: TIMELINE_LIMIT });
    if (boardId !== selectedBoardId || journalLoad !== load) return;
    journalView = { boardId, events, truncated };
    journalLoad = null;
    update(() => renderTimeline(events, truncated));
  } catch (err) {
    if (boardId !== selectedBoardId || journalLoad !== load) return;
    load.error = err instanceof Error ? err.message : String(err);
    update(() => el('p', 'ov2-notice ov2-notice--warn', load.error));
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function run(what: string, command: () => Promise<void>): Promise<void> {
  try {
    await command();
    notice = null;
  } catch (err) {
    notice = { text: `${what} failed: ${err instanceof Error ? err.message : String(err)}`, tone: 'bad' };
    paintBoard();
  }
}

function boardModelIsBound(state: BoardState | null): boolean {
  return Boolean(state?.model?.providerId?.trim() && state?.model?.id?.trim());
}

function stopWatchingModelSelectForSeed(): void {
  stopModelSelectSeedWatch?.();
  stopModelSelectSeedWatch = null;
}

/** Retry seed once the menubar catalog fills in, if this board is still unbound. */
function watchModelSelectForSeed(): void {
  if (stopModelSelectSeedWatch) return;
  const sel = document.getElementById('modelSelect');
  if (!(sel instanceof HTMLSelectElement)) return;

  const retry = () => {
    const boardId = selectedBoardId;
    if (!boardId || !client) return;
    const state = client.getState();
    if (boardModelIsBound(state)) {
      stopWatchingModelSelectForSeed();
      return;
    }
    void seedBoardModelNow(boardId, state);
  };

  const unsubscribe = subscribeModelSelection(retry);
  sel.addEventListener('change', retry);
  const observer = new MutationObserver(retry);
  observer.observe(sel, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['value'],
  });
  stopModelSelectSeedWatch = () => {
    unsubscribe();
    sel.removeEventListener('change', retry);
    observer.disconnect();
  };
}

async function seedBoardModelNow(boardId: string, state: BoardState | null): Promise<void> {
  if (!client || selectedBoardId !== boardId || modelSeedInflight.has(boardId)) return;
  modelSeedInflight.add(boardId);
  try {
    const ok = await ensureBoardModelBound({
      state,
      setModel: async (providerId, id) => {
        await client?.setModel({ providerId, id });
      },
    });
    if (ok) stopWatchingModelSelectForSeed();
    else watchModelSelectForSeed();
  } catch {
    watchModelSelectForSeed();
  } finally {
    modelSeedInflight.delete(boardId);
  }
}

function maybeSeedBoardModel(state: BoardState): void {
  const boardId = selectedBoardId;
  if (!boardId || !client) return;
  if (boardModelIsBound(state)) {
    modelSeedAttempted.add(boardId);
    stopWatchingModelSelectForSeed();
    return;
  }
  if (modelSeedAttempted.has(boardId)) {
    watchModelSelectForSeed();
    return;
  }
  modelSeedAttempted.add(boardId);
  void seedBoardModelNow(boardId, state);
}

async function seedBoundModelBeforeStart(): Promise<void> {
  if (!client) return;
  await ensureBoardModelBound({
    state: client.getState(),
    setModel: async (providerId, id) => {
      await client?.setModel({ providerId, id });
    },
  });
}

function commandStart(concurrency: number): Promise<void> {
  return run('Start', async () => {
    await seedBoundModelBeforeStart();
    await client?.start(concurrency);
    void list?.refresh();
  });
}

function commandPause(): Promise<void> {
  return run('Pause', async () => {
    await client?.pause();
    void list?.refresh();
  });
}

function commandStop(): Promise<void> {
  return run('Stop', async () => {
    await client?.stop();
    void list?.refresh();
  });
}

function commandConcurrency(n: number): Promise<void> {
  return run('Concurrency', async () => {
    await client?.setConcurrency(n);
    void list?.refresh();
  });
}

function commandSetModel(providerId: string, id: string, reasoning: string): Promise<void> {
  return run('Model', async () => {
    await client?.setModel({
      providerId,
      id,
      ...(isBoardJournalReasoning(reasoning) ? { reasoning } : {}),
    });
  });
}

function commandRename(name: string): Promise<void> {
  return run('Rename', async () => {
    await client?.rename(name);
    void list?.refresh();
  });
}

async function commandResyncPlan(): Promise<void> {
  if (!client || resyncing) return;
  const source = client;
  resyncing = true;
  paintBoard();
  try {
    const preview = await source.resyncPlan(true);
    const { changes, skipped } = describeResync(preview.result);
    if (!resyncHasWork(preview.result)) {
      notice = skipped.length
        ? { text: ['Nothing from the plan can be applied.', ...skipped].join('\n'), tone: 'warn' }
        : { text: 'The board already matches the plan.', tone: 'info' };
      return;
    }
    const running =
      source.getState()?.status === 'running' &&
      (preview.result.adds.length > 0 || preview.result.updates.some((u) => u.changes.dependsOn))
        ? '\n\nThe board is Running, so new or freed tasks may start right away.'
        : '';
    const confirmed = await appConfirm(
      [
        ...changes,
        ...(skipped.length ? ['', 'Left as is:', ...skipped] : []),
      ].join('\n') +
        `\n\nThe plan file is not changed; history on existing cards is kept.${running}`,
      { title: 'Sync from plan', confirmLabel: 'Apply' },
    );
    if (!confirmed || source !== client) return;
    const applied = await source.resyncPlan(false);
    const after = describeResync(applied.result);
    notice = after.skipped.length
      ? {
          text: [`Synced from the plan: ${after.changes.length} change(s).`, ...after.skipped].join('\n'),
          tone: 'warn',
        }
      : null;
  } catch (err) {
    const detail =
      err instanceof PlanParseFailure ? err.message : err instanceof Error ? err.message : String(err);
    notice = { text: `Could not sync from the plan: ${detail}`, tone: 'bad' };
  } finally {
    resyncing = false;
    paintBoard();
  }
}

async function commandAbandonTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    const abandoned = await client.abandonTask(taskId);
    notice = abandoned
      ? null
      : { text: `${taskId} has already finished.`, tone: 'warn' };
  } catch (err) {
    notice = {
      text: `Could not abandon ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

async function commandMergeAndSkipTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  const source = client;
  const confirmed = await appConfirm(
    `Merge the retained work for ${taskId} and skip its remaining checks? Dependent tasks can run after the merge succeeds. If it fails, the task stays unresolved and its work remains available.`,
    { title: 'Merge and skip task', confirmLabel: 'Merge and skip' },
  );
  if (!confirmed || source !== client) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    const result = await source.mergeAndSkipTask(taskId);
    notice = result.ok ? null : { text: result.error ?? `${taskId} could not be merged.`, tone: 'warn' };
  } catch (err) {
    notice = { text: `Could not merge ${taskId}: ${err instanceof Error ? err.message : String(err)}`, tone: 'bad' };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

async function commandSkipTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  const source = client;
  const state = source.getState();
  const task = state?.tasks.get(taskId);
  if (!state || !task) return;
  const dependents = pendingDependents(state, taskId);
  const running = task.attempts.some((a) => !a.ended) ? ' Its running agent is stopped.' : '';
  const freed =
    state.status === 'running' && dependents.length > 0
      ? ' The board is Running, so freed tasks may start right away.'
      : '';
  const warning = dependents.length
    ? `Warning: ${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on ${taskId} and will run without its changes. They may fail because work they expect is missing.`
    : `Warning: nothing on the board depends on ${taskId}, but the final test may still fail without its changes.`;
  const confirmed = await appConfirm(
    [
      `Skip ${taskId}? It counts as done without merging, so the tasks that depend on it can run.${running}${freed}`,
      '',
      warning,
      '',
      'Retry or Reset brings it back.',
    ].join('\n'),
    { title: 'Skip task', confirmLabel: 'Skip', danger: true },
  );
  if (!confirmed || source !== client) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    const result = await source.skipTask(taskId);
    notice = result.ok
      ? null
      : { text: result.error ?? `${taskId} could not be skipped.`, tone: 'warn' };
  } catch (err) {
    notice = {
      text: `Could not skip ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

function runningResetNote(status: BoardState['status']): string {
  return status === 'running'
    ? ' The board is Running, so these cards may start again on their own.'
    : '';
}

async function commandEditTask(taskId: string, changes: TaskEditChanges): Promise<void> {
  if (!client) return;
  let error: string | null = null;
  try {
    const result = await client.editTask(taskId, changes);
    if (!result.ok) error = result.error ?? `${taskId} could not be edited.`;
  } catch (err) {
    error = `Could not save ${taskId}: ${err instanceof Error ? err.message : String(err)}`;
  }
  settleSpecEdit(taskId, error);
  paintBoard();
}

async function commandResetTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  const state = client.getState();
  if (!state) return;
  const plan = resetTargets(state, taskId);
  if (!plan.ok) {
    notice = { text: plan.error, tone: 'warn' };
    paintBoard();
    return;
  }
  const confirmed = await appConfirm(
    `Reset ${taskId} from scratch? This deletes its attempt history, transcript, worktree, and branch. The card returns to Planned. Integration is not changed. Retry keeps history; this does not.${runningResetNote(state.status)}`,
    { title: 'Reset task', confirmLabel: 'Reset', danger: true },
  );
  if (!confirmed) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    const result = await client.resetTask(taskId);
    notice = result.ok
      ? null
      : { text: result.error ?? `${taskId} could not be reset.`, tone: 'warn' };
  } catch (err) {
    notice = {
      text: `Could not reset ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

async function commandRewindTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  const state = client.getState();
  if (!state) return;
  let taskIds = [taskId];
  try {
    const journal = await readJournal(client.boardId);
    const plan = rewindCascade(state, journal.events, taskId);
    if (!plan.ok) {
      notice = { text: plan.error, tone: 'warn' };
      paintBoard();
      return;
    }
    taskIds = plan.taskIds;
  } catch (err) {
    notice = {
      text: `Could not plan rewind for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
    paintBoard();
    return;
  }
  const confirmed = await appConfirm(
    `Rewind from ${taskId}? This restores the integration branch to before this merge and resets ${taskIds.join(', ')}. Later merged work is discarded from git. This is not Reset (Reset cannot touch a merged card).${runningResetNote(state.status)}`,
    { title: 'Rewind merge', confirmLabel: 'Rewind', danger: true },
  );
  if (!confirmed) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    const result = await client.rewindTask(taskId);
    notice = result.ok
      ? null
      : { text: result.error ?? `${taskId} could not be rewound.`, tone: 'warn' };
  } catch (err) {
    notice = {
      text: `Could not rewind ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

async function commandStartTask(taskId: string): Promise<void> {
  if (!client || pendingTasks.has(taskId)) return;
  pendingTasks.add(taskId);
  paintBoard();
  try {
    await seedBoundModelBeforeStart();
    const started = await client.startTask(taskId);
    notice = started
      ? null
      : {
          text: `${taskId} cannot start right now.`,
          tone: 'warn',
        };
  } catch (err) {
    notice = {
      text: `Could not start ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'bad',
    };
  } finally {
    pendingTasks.delete(taskId);
    paintBoard();
  }
}

async function commandRerun(taskIds?: string[]): Promise<void> {
  if (!client || !selectedBoardId) return;
  return run('Rerun', async () => {
    const result = await client!.rerun(taskIds, readConcurrencyInput());
    if (!result.ok) {
      notice = { text: 'Nothing to rerun.', tone: 'warn' };
      return;
    }
    finishReportByBoard.delete(selectedBoardId!);
    reportDismissed.delete(selectedBoardId!);
    void list?.refresh();
  });
}

/** Clear mount + last-opened memory between tests. */
export function resetBoardsViewForTests(): void {
  teardownBoardsView();
  forgetLastOpenedBoard();
  selectedBoardId = null;
}
