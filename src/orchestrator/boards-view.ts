import '../styles/orchestrator-boards.css';
import '../styles/transcript-view.css';
import '../styles/orchestrate-hub.css';
import '../styles/orchestrate-plan-screen.css';

import type { BoardState, ParseError } from '../../server/orchestrator/core/types';
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
import { appConfirm } from '../ui/app-dialog';
import { resetTargets, rewindCascade } from '../../server/orchestrator/core/rewind.js';
import { withSessionToken } from '../api/session-token';
import {
  formatElapsed,
  renderBoardHeader,
  renderBoardSkeleton,
  renderEngineErrors,
  renderMergeQueue,
  renderTaskList,
  renderTimeline,
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
  resetTaskDetailLogUi,
  resetTaskDetailUi,
  syncTaskDetailOverlay,
} from './task-detail';
import {
  discoverOrchestratePlans,
  type DiscoverOrchestratePlansResult,
} from '../chat/plans/list-plans';
import { button, el, empty, pill } from './dom';
import { createIcon } from '../ui/icon';
import { deferUntilContextMenuClosed } from '../ui/context-menu';
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

interface Surface {
  root: HTMLElement;
  listPane: HTMLElement;
  boardPane: HTMLElement;
}

let surface: Surface | null = null;
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
let showTimeline = false;
let journalView: {
  boardId: string;
  events: readonly Record<string, unknown>[];
  truncated: boolean;
} | null = null;
const pendingTasks = new Set<string>();
let notice: { text: string; tone: 'warn' | 'bad' } | null = null;
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

export async function openBoardsView(): Promise<void> {
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
  root.append(listPane, boardPane);

  area.replaceChildren(root);
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_CLASS);
  surface = { root, listPane, boardPane };
  document.addEventListener('keydown', onBoardsDocumentKeydown, true);

  list = createBoardListClient();
  unsubscribeList = list.subscribe(() => {
    const boards = list?.getBoards() ?? [];
    if (selectedBoardId && !boards.some((b) => b.boardId === selectedBoardId)) {
      if (lastOpenedBoardId === selectedBoardId) forgetLastOpenedBoard();
      selectBoard(null);
    }
    paintList();
    void import('../ui/code-views-orchestrate-button').then((m) =>
      m.updateV2BoardActivityFromSummaries(boards),
    );
  });
  list.start();

  paintList();
  resumeLastOpenedBoard();
  syncRailButton();
  notifyCodeStageViewChanged();
}

export function teardownBoardsView(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', onBoardsDocumentKeydown, true);
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
  document.getElementById(BOARDS_ROOT_ID)?.remove();
  const area = document.getElementById('chatArea');
  area?.classList.remove(CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.remove(MAIN_COLUMN_CLASS);
  surface = null;
  // Keep lastOpenedBoardId; drop selectedBoardId so paint cannot show a live
  // selection without a client if anything renders during unmount.
  if (selectedBoardId) rememberOpenedBoard(selectedBoardId);
  selectedBoardId = null;
  selectedTaskId = null;
  pendingTasks.clear();
  confirmingDelete.clear();
  renamingBoardId = null;
  clearTaskDetailState();
  notice = null;
  syncRailButton();
}

function onBoardsDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (!surface || !selectedTaskId) return;
  if (!surface.root.querySelector('.ov2-detail-overlay')) return;
  event.preventDefault();
  selectTaskDetail(null);
}

function selectTaskDetail(taskId: string | null): void {
  const previous = selectedTaskId;
  selectedTaskId = taskId;
  clearTaskDetailState();
  paintBoard();
  if (taskId) void loadTaskFiles(taskId);
  if (taskId === null && previous) {
    surface?.root
      .querySelector<HTMLElement>(`[data-focus-key="task:${CSS.escape(previous)}"]`)
      ?.focus();
    return;
  }
  if (taskId) {
    surface?.root.querySelector<HTMLElement>('[data-focus-key="detail-close"]')?.focus();
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
  unsubscribeBoard?.();
  unsubscribeBoard = null;
  unsubscribeLive?.();
  unsubscribeLive = null;
  client?.close();
  client = null;

  selectedBoardId = boardId;
  if (boardId) rememberOpenedBoard(boardId);
  selectedTaskId = null;
  showTimeline = false;
  journalView = null;
  clearTaskDetailState();
  pendingTasks.clear();
  confirmingDelete.clear();
  renamingBoardId = null;
  notice = null;

  if (boardId) {
    client = createBoardClient(boardId, { openStream });
    unsubscribeBoard = client.subscribe(() => paintBoard());
    unsubscribeLive = client.subscribeLive(scheduleLiveUi);
    client.connect();
  }
  paintList();
  paintBoard();
}

export function showBoard(boardId: string): void {
  selectBoard(boardId);
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
  head.appendChild(el('h1', 'ov2__list-title', 'Boards'));
  head.appendChild(
    button({
      label: 'New board',
      title: 'Create a board from a plan file',
      variant: 'primary',
      onClick: () => openAskPane(),
    }),
  );
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
}

function renderListItem(board: BoardSummary): HTMLElement {
  const item = el('li', 'ov2__board-item');
  const btn = el('button', 'ov2__board-btn');
  btn.type = 'button';
  btn.dataset.focusKey = `board:${board.boardId}`;
  if (board.boardId === selectedBoardId) btn.classList.add('is-selected');
  btn.addEventListener('click', () => selectBoard(board.boardId));

  btn.appendChild(el('span', 'ov2__board-name', board.name || board.boardId));
  const meta = el('span', 'ov2__board-meta');
  meta.appendChild(
    pill(
      board.finished ? 'finished' : board.status,
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

export interface CreateFormHandlers {
  discoverPlans?: () => Promise<DiscoverOrchestratePlansResult>;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string },
  ) => Promise<{ boardId: string }>;
  onCreated: (boardId: string) => void;
  onCancel: () => void;
  /** Test seam — production uses `startPlanRepair`. */
  startPlanRepair?: PlanRepairFn;
  cancelPlanRepair?: (planPath: string) => void;
}

export interface AskPaneHandlers {
  discoverPlans?: () => Promise<DiscoverOrchestratePlansResult>;
  createBoard?: (
    planPath: string,
    options?: { boardId?: string; markdown?: string },
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
    options?: { boardId?: string; markdown?: string },
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
  const createBoard = handlers.createBoard ?? createBoardFromPlan;
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
  field.append(sel, workflowActions);

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
    void import('../ui/super-plan-entry').then((m) => m.openSuperPlanScreen({ preferNew: true }));
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
  const createBoard = handlers.createBoard ?? createBoardFromPlan;
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
    title: 'Rewrite this plan to the required schema, then open the board',
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
  if (!target) return;
  target.focus();
  if (captured.selectionStart === null) return;
  const input = target as HTMLInputElement;
  try {
    input.setSelectionRange(captured.selectionStart, captured.selectionStart);
  } catch {}
}

// ── Board ────────────────────────────────────────────────────────────────────

function paintBoard(): void {
  if (!surface) return;
  // Journal events can repaint the entire board while a task actions menu is
  // open. Keep its anchor stable until the user dismisses or chooses an item.
  if (deferUntilContextMenuClosed(paintBoard)) return;
  const pane = surface.boardPane;

  if (!selectedBoardId) {
    detachV2BoardHeaderInstruments();
    surface.root.classList.remove('is-detail-open');
    surface.root.querySelector('.ov2-detail-overlay')?.remove();
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
    detachV2BoardHeaderInstruments();
    surface.root.classList.remove('is-detail-open');
    surface.root.querySelector('.ov2-detail-overlay')?.remove();
    pane.replaceChildren(renderBoardSkeleton());
    return;
  }

  const connected = client?.isConnected() ?? false;
  const scrollTop = pane.scrollTop;
  const focused = captureFocus();
  detachV2BoardHeaderInstruments();
  pane.replaceChildren();
  pane.appendChild(renderBoardHeader(state, connected, renderControls(state)));
  const headerControls = pane.querySelector('.board-header__controls');
  if (headerControls instanceof HTMLElement) {
    attachV2BoardHeaderInstruments(headerControls, state, {
      setModel: commandSetModel,
      onNeedModel: () => {
        notice = { text: 'Pick a model for this board first.', tone: 'warn' };
        paintBoard();
      },
    });
  }
  maybeSeedBoardModel(state);
  const errors = renderEngineErrors(client?.getEngineErrors());
  if (errors) pane.appendChild(errors);
  if (notice) {
    const line = el('p', `ov2-notice ov2-notice--${notice.tone}`, notice.text);
    line.setAttribute('role', 'status');
    pane.appendChild(line);
  }

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
    pane.scrollTop = scrollTop;
    surface.root.classList.remove('is-detail-open');
    surface.root.querySelector('.ov2-detail-overlay')?.remove();
    restoreFocus(focused);
    return;
  }

  const actions = boardActions();
  const options = boardViewOptions();

  pane.appendChild(renderTaskList(state, actions, options));
  pane.appendChild(renderMergeQueue(state));
  if (showTimeline) {
    pane.appendChild(renderTimelineSection());
    if (journalView?.boardId !== selectedBoardId) void loadTimeline();
  }
  pane.scrollTop = scrollTop;

  const selected = selectedTaskId ? state.tasks.get(selectedTaskId) : undefined;
  surface.root.classList.toggle('is-detail-open', Boolean(selected));
  const existingOverlay = surface.root.querySelector<HTMLElement>('.ov2-detail-overlay');
  if (!selected) {
    existingOverlay?.remove();
  } else if (existingOverlay && existingOverlay.dataset.taskId === selected.id) {
    const wasPopulated = (existingOverlay.dataset.attemptCount ?? '0') !== '0';
    const nowEmpty = selected.attempts.length === 0 && selected.mergedSha === null;
    if (wasPopulated && nowEmpty) {
      existingOverlay.remove();
      surface.root.appendChild(renderTaskDetail(state, selected, actions, options));
    } else {
      // Same task: patch work + thread. Remounting would restart chat animations.
      syncTaskDetailOverlay(existingOverlay, state, selected, actions, options, {
        syncWork: true,
        thread: 'auto',
      });
    }
  } else {
    existingOverlay?.remove();
    surface.root.appendChild(renderTaskDetail(state, selected, actions, options));
  }
  syncLogPolling(state);
  syncElapsedTicker(state);

  restoreFocus(focused);
}

function boardActions() {
  return {
    startTask: (taskId: string) => void commandStartTask(taskId),
    abandonTask: (taskId: string) => void commandAbandonTask(taskId),
    resetTask: (taskId: string) => void commandResetTask(taskId),
    rewindTask: (taskId: string) => void commandRewindTask(taskId),
    rerun: (taskIds?: string[]) => void commandRerun(taskIds),
    select: (taskId: string | null) => selectTaskDetail(taskId),
    openTranscript: (attemptId: string) => void toggleTranscript(attemptId),
    toggleFileDiff: (path: string) => void toggleFileDiff(path),
    openFile: (path: string) => openTaskFile(path),
  };
}

function boardViewOptions() {
  return {
    selectedTaskId,
    pendingTaskIds: pendingTasks,
    liveActivity: client?.getLiveActivity(),
    attemptStartedAt: client?.getAttemptStartedAt(),
    now: Date.now(),
    engineErrors: client?.getEngineErrors(),
    transcript,
    files: taskFilesView(),
  };
}

/**
 * Live thinking/tool frames: patch cards and the open thread. Never paintBoard —
 * replacing the card between mousedown and mouseup is why detail would not open.
 */
function patchLiveUi(): void {
  if (!surface || !client) return;
  const live = client.getLiveActivity();
  const started = client.getAttemptStartedAt();
  const now = Date.now();
  for (const [taskId, activity] of live) {
    const card = surface.root.querySelector<HTMLElement>(
      `.ov2-task[data-task-id="${CSS.escape(taskId)}"]`,
    );
    if (!card) continue;
    syncTaskCardActivity(card, activity, started.get(activity.attemptId) ?? null, now);
  }

  const overlay = surface.root.querySelector<HTMLElement>('.ov2-detail-overlay');
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
  const anyRunning = [...state.tasks.values()].some((task) =>
    task.attempts.some((attempt) => !attempt.ended),
  );
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
}

const LOG_POLL_MS = 1_200;
let logPollTimer: ReturnType<typeof setInterval> | null = null;

function stopLogPolling(): void {
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
    stopLogPolling();
    return;
  }
  if (logPollTimer !== null) return;
  logPollTimer = setInterval(() => {
    if (!transcript || transcript.status === 'loading') return;
    void refreshTranscript(transcript.attemptId);
  }, LOG_POLL_MS);
}

async function refreshTranscript(attemptId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  try {
    const result = await readAttemptTranscript(boardId, attemptId, { limit: 500 });
    if (transcript?.attemptId !== attemptId || boardId !== selectedBoardId) return;
    const previous = transcript;
    const sameStructure =
      previous?.status === 'ready' &&
      transcriptStructureKey(previous.events) === transcriptStructureKey(result.events);
    transcript = { attemptId, status: 'ready', ...result };
    const overlay = surface?.root.querySelector<HTMLElement>('.ov2-detail-overlay');
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
  } catch {}
}

function taskFilesView(): TaskFilesView | null {
  if (!taskFiles) return null;
  return { ...taskFiles, diffs: fileDiffs, expanded: expandedFiles };
}

async function loadTaskFiles(taskId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  if (taskFiles?.taskId === taskId && taskFiles.status !== 'error') return;

  taskFiles = {
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
  paintBoard();
  try {
    const result = await readTaskFiles(boardId, taskId);
    if (selectedTaskId !== taskId || boardId !== selectedBoardId) return;
    taskFiles = { ...taskFiles, ...result, status: 'ready' };
  } catch (err) {
    if (selectedTaskId !== taskId || boardId !== selectedBoardId) return;
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
  fileDiffs.set(path, { status: 'loading', lines: [], truncated: false });
  paintBoard();
  try {
    const result = await readTaskFileDiff(boardId, taskId, path);
    if (selectedTaskId !== taskId || boardId !== selectedBoardId) return;
    fileDiffs.set(
      path,
      result
        ? { status: 'ready', lines: result.lines, truncated: result.truncated }
        : { status: 'ready', lines: [], truncated: false },
    );
  } catch (err) {
    if (selectedTaskId !== taskId || boardId !== selectedBoardId) return;
    fileDiffs.set(path, {
      status: 'error',
      lines: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  paintBoard();
}

function openTaskFile(path: string): void {
  void import('../ui/file-viewer').then((m) => m.openFileInViewer(path));
}

async function toggleTranscript(attemptId: string): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  if (transcript?.attemptId === attemptId) {
    transcript = null;
    resetTaskDetailLogUi();
    paintBoard();
    return;
  }
  resetTaskDetailLogUi();
  transcript = { attemptId, status: 'loading', events: [], truncated: false, capped: false };
  paintBoard();
  try {
    const result = await readAttemptTranscript(boardId, attemptId, { limit: 500 });
    if (transcript?.attemptId !== attemptId || boardId !== selectedBoardId) return;
    transcript = { attemptId, status: 'ready', ...result };
  } catch (err) {
    if (transcript?.attemptId !== attemptId || boardId !== selectedBoardId) return;
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
  runBtn.textContent = running ? 'Stop' : rerunInstead ? 'Rerun' : 'Start';
  runBtn.setAttribute(
    'aria-label',
    running ? 'Stop board' : rerunInstead ? 'Rerun failed work' : 'Start board',
  );
  runBtn.title = running
    ? 'Stop the loop. In-flight attempts keep running until they finish; nothing new starts.'
    : rerunInstead
      ? 'Reopen failed tasks (or add a fix task) and start the board again, with the agent count set beside this button.'
      : 'Start the reconcile loop. One agent works through tasks in order; more than one works on tasks in parallel.';
  runBtn.addEventListener('click', () => {
    if (running) void commandStop();
    else if (rerunInstead) void commandRerun();
    else void commandStart(readConcurrencyInput());
  });
  controls.appendChild(runBtn);

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

  if (!showingReport(state)) {
    const timelineBtn = el('button', 'board-btn board-btn--compact board-timeline-btn');
    timelineBtn.type = 'button';
    timelineBtn.textContent = 'Timeline';
    timelineBtn.title = showTimeline ? 'Hide the journal' : 'Show the journal';
    timelineBtn.setAttribute('aria-pressed', showTimeline ? 'true' : 'false');
    timelineBtn.addEventListener('click', () => {
      showTimeline = !showTimeline;
      paintBoard();
      if (showTimeline) void loadTimeline();
    });
    controls.appendChild(timelineBtn);
  }

  controls.appendChild(renderRenameControl(state));
  return controls;
}

function renderConcurrencyControl(
  state: BoardState,
  finished: boolean,
  running: boolean,
): HTMLElement {
  const wrap = el('label', 'board-header__concurrency');
  wrap.title =
    'Agents running at once. Each is a model call and a worktree. There is no hard cap; pick what this machine can hold. Changing it while running takes effect on the next tick; agents already working keep going.';

  const label = el('span', 'board-header__field-label', 'Agents');
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
  wrap.appendChild(input);
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

function renderTimelineSection(): HTMLElement {
  const wrap = el('section', 'ov2-journal ob-sec');
  wrap.appendChild(el('h3', 'ov2-journal__title', 'Journal'));
  const body = el('div', 'ov2-journal__body');
  wrap.appendChild(body);
  wrap.dataset.role = 'journal';
  if (journalView?.boardId === selectedBoardId) {
    body.replaceChildren(renderTimeline(journalView.events, journalView.truncated));
  } else {
    body.textContent = 'Loading…';
  }
  return wrap;
}

async function loadTimeline(): Promise<void> {
  const boardId = selectedBoardId;
  if (!boardId) return;
  try {
    const { events, truncated } = await readJournal(boardId, { limit: TIMELINE_LIMIT });
    if (boardId !== selectedBoardId || !showTimeline) return;
    journalView = { boardId, events, truncated };
    const body = surface?.boardPane.querySelector<HTMLElement>('.ov2-journal__body');
    body?.replaceChildren(renderTimeline(events, truncated));
  } catch (err) {
    if (boardId !== selectedBoardId || !showTimeline) return;
    const body = surface?.boardPane.querySelector<HTMLElement>('.ov2-journal__body');
    body?.replaceChildren(
      el('p', 'ov2-notice ov2-notice--warn', err instanceof Error ? err.message : String(err)),
    );
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

  sel.addEventListener('change', retry);
  const observer = new MutationObserver(retry);
  observer.observe(sel, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['value'],
  });
  stopModelSelectSeedWatch = () => {
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

function runningResetNote(status: BoardState['status']): string {
  return status === 'running'
    ? ' The board is Running, so these cards may start again on their own.'
    : '';
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
