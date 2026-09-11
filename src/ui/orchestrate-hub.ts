import '../styles/orchestrate-hub.css';
import '../styles/ob-page.css';

import {
  mountPlanPreviewContent,
  readPlanArtifactMarkdown,
} from '../chat/plans/plan-preview';
import {
  isExecutableOrchestratePlan,
} from '../chat/plans/plan-path';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { normalizeModeId } from '../chat/modes/types';
import {
  getGroupsForWorkspace,
  getLastBoardGroup,
  openBoardGroup,
  isLeftoverBoardRunning,
} from '../state/chat-groups';
import { getActiveChat, sessionState } from '../state/sessions';
import type { Chat, ChatGroup } from '../types';
import { getWorkspaceLabel, getWorkspacePath } from '../state/workspace';
import {
  populateOrchestratePlanSelect,
  persistOrchestratePlanPathFromSelectValue,
  shortPlanLabel,
} from './orchestrate-plan-picker';
import { setChatMode } from './mode-selector';
import { launchBoardFromPlan } from './orchestrate-launch';
import { switchChat } from './sidebar';
import { renderChatFromHistory } from './messages';
import { closeCodeOverview, isCodeOverviewOpen } from './code-overview';
import { teardownCodeBrainMapBeforeChatPaint } from './code-brain-map';
import { teardownIssuesEmbedBeforeChatPaint } from './issues-page';
import { notifyCodeStageViewChanged, stripMainColumnOverlayClasses } from './main-column-overlay';
import { teardownHub } from './hub';
import { closeBoardChatEmbedForTeardown } from './orchestrate-board-chat';
import { teardownOrchestratePlanScreen } from './orchestrate-plan-screen';
import { openOrchestratePlanScreen } from './orchestrate-plan-screen';
import {
  buildOrchestratePageShell,
  disposeOrchestratePageShell,
  OB_CHAT_AREA_CLASS,
  paintOrchestrateBoardRail,
} from './orchestrate-page-shell';
export const ORCHESTRATE_HUB_ROOT_ID = 'orchestrateHub';

let hubReturnChatId: string | null = null;
/** Bumps on each preview fetch so stale read_file results are ignored. */
let hubPlanPreviewRequestId = 0;

export interface OrchestrateHubPlanPreviewElements {
  section: HTMLElement;
  pathChip: HTMLElement;
  previewMount: HTMLElement;
}

// ── Hub chrome ───────────────────────────────────────────────────────────────

/**
 * Load and render the selected plan file into the hub preview panel (plan screen parity).
 */
export async function refreshOrchestrateHubPlanPreview(
  planPath: string,
  elements: OrchestrateHubPlanPreviewElements,
): Promise<void> {
  const trimmed = planPath.trim();
  if (!trimmed || !isExecutableOrchestratePlan(trimmed)) {
    elements.section.hidden = true;
    elements.pathChip.textContent = '';
    elements.pathChip.removeAttribute('title');
    elements.previewMount.replaceChildren();
    return;
  }

  const requestId = (hubPlanPreviewRequestId += 1);
  elements.section.hidden = false;
  elements.pathChip.textContent = shortPlanLabel(trimmed);
  elements.pathChip.title = trimmed;
  elements.previewMount.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'orchestrate-hub__plan-preview-loading';
  loading.textContent = 'Loading plan…';
  elements.previewMount.appendChild(loading);

  try {
    const markdown = await readPlanArtifactMarkdown(trimmed);
    if (requestId !== hubPlanPreviewRequestId) return;
    mountPlanPreviewContent(elements.previewMount, markdown, { modeId: 'plan' });
  } catch {
    if (requestId !== hubPlanPreviewRequestId) return;
    elements.previewMount.replaceChildren();
    const err = document.createElement('p');
    err.className = 'orchestrate-plan-screen__preview-empty';
    err.textContent = 'Could not load plan file.';
    elements.previewMount.appendChild(err);
  }
}

/** True when the orchestrate hub is mounted in #chatArea. */
export function isOrchestrateHubMounted(): boolean {
  return Boolean(document.getElementById(ORCHESTRATE_HUB_ROOT_ID));
}

function syncTopBarOrchestrateButton(): void {
  void import('./code-views-orchestrate-button').then((m) =>
    m.syncCodeViewsOrchestrateButton(),
  );
}

/** Remove orchestrate hub chrome and restore the prior chat view. */
export function teardownOrchestrateHub(): void {
  if (typeof document === 'undefined') {
    hubReturnChatId = null;
    return;
  }
  const root = document.getElementById(ORCHESTRATE_HUB_ROOT_ID);
  if (root) {
    disposeOrchestratePageShell(root);
    root.remove();
  }
  const area = document.getElementById('chatArea');
  area?.classList.remove('chat-area--orchestrate-hub', OB_CHAT_AREA_CLASS);
  hubReturnChatId = null;
  syncTopBarOrchestrateButton();
  notifyAskQuestionDisplayContextChanged();
  notifyCodeStageViewChanged();
}

// ── Board list ───────────────────────────────────────────────────────────────

/** Workspace folders that have an orchestrate board or plan path. */
export function listWorkspaceOrchestrateBoardGroups(
  workspacePath: string,
): ChatGroup[] {
  if (!sessionState) return [];
  return getGroupsForWorkspace(workspacePath)
    .filter(
      (group) =>
        Boolean(group.orchestrateBoard) || Boolean(group.orchestratePlanPath?.trim()),
    )
    .sort((a, b) => boardGroupSortKey(b) - boardGroupSortKey(a));
}

/** @deprecated Use {@link listWorkspaceOrchestrateBoardGroups}. */
export function listWorkspaceOrchestrateBoardChats(workspacePath: string): Chat[] {
  return listWorkspaceOrchestrateBoardGroups(workspacePath)
    .map((group) =>
      group.plannerChatId
        ? sessionState?.chats.find((c) => c.id === group.plannerChatId)
        : undefined,
    )
    .filter((c): c is Chat => Boolean(c));
}

function boardGroupSortKey(group: ChatGroup): number {
  const boardUpdated = group.orchestrateBoard?.lastUpdatedAt;
  if (typeof boardUpdated === 'number' && boardUpdated > 0) return boardUpdated;
  return group.createdAt;
}

function openBoardGroupFromHub(groupId: string, plannerChatId?: string): void {
  teardownOrchestrateHub();
  if (!sessionState) return;
  if (plannerChatId && sessionState.activeId !== plannerChatId) {
    switchChat(plannerChatId);
  }
  const chat = getActiveChat();
  if (normalizeModeId(chat.modeId) !== 'orchestrate') {
    setChatMode('orchestrate');
  }
  openBoardGroup(groupId);
}

function startBoardFromHub(planSelect: HTMLSelectElement): void {
  const path = planSelect.value.trim();
  if (!path || !isExecutableOrchestratePlan(path)) return;
  teardownOrchestrateHub();
  void launchBoardFromPlan(path);
}

/** Re-render board rail when session groups change (e.g. planner chat deleted). */
export function refreshOrchestrateHubBoardList(): void {
  const container = document.getElementById('orchestrateHubBoardsRow');
  if (!container) return;
  const filterInput = document.querySelector(
    '.ob-page .ob-rail__filter-input',
  ) as HTMLInputElement | null;
  paintOrchestrateBoardRail(container, {
    filterText: filterInput?.value ?? '',
    onSelectBoard: openBoardGroupFromHub,
    onEmptyAction: () => {
      document.getElementById('orchestrateHubPlanSelect')?.focus();
    },
  });
}

/** Re-populate the hub plan dropdown from the workspace. */
export async function refreshOrchestrateHubPlanList(): Promise<void> {
  if (!isOrchestrateHubMounted()) return;
  const sel = document.getElementById('orchestrateHubPlanSelect');
  const hint = document.getElementById('orchestrateHubPlanHint');
  if (!(sel instanceof HTMLSelectElement) || !(hint instanceof HTMLElement)) return;
  await loadHubPlans(sel, hint, getActiveChat());
  const startBtn = document.getElementById('orchestrateHubStartBoard');
  if (startBtn instanceof HTMLButtonElement) {
    const path = sel.value.trim();
    startBtn.disabled = !path || !isExecutableOrchestratePlan(path);
  }
  const section = document.getElementById('orchestrateHubPlanPreview');
  const pathChip = document.getElementById('orchestrateHubPlanPreviewPath');
  const previewMount = document.getElementById('orchestrateHubPlanPreviewMount');
  if (
    section instanceof HTMLElement &&
    pathChip instanceof HTMLElement &&
    previewMount instanceof HTMLElement
  ) {
    await refreshOrchestrateHubPlanPreview(sel.value, { section, pathChip, previewMount });
  }
}

async function loadHubPlans(
  sel: HTMLSelectElement,
  hint: HTMLElement,
  chat: Chat,
): Promise<void> {
  await populateOrchestratePlanSelect(sel, hint, chat, {
    autoSelectSingle: false,
  });
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function buildOrchestrateHubDom(): HTMLElement {
  let filterText = '';

  const { page, main, railList, filterInput } = buildOrchestratePageShell({
    rootId: ORCHESTRATE_HUB_ROOT_ID,
    ariaLabel: 'Orchestrate boards',
    extraRootClass: 'orchestrate-hub-root',
    onNewBoard: () => {
      document.getElementById('orchestrateHubPlanSelect')?.focus();
    },
  });

  const paintRail = () => {
    paintOrchestrateBoardRail(railList, {
      filterText,
      onSelectBoard: openBoardGroupFromHub,
      onEmptyAction: () => {
        document.getElementById('orchestrateHubPlanSelect')?.focus();
      },
    });
  };

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    paintRail();
  });

  const pane = document.createElement('div');
  pane.className = 'ob-pane--ask';

  const ask = document.createElement('div');
  ask.className = 'ob-ask';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'ob-ask__eyebrow orchestrate-hub__eyebrow';
  eyebrow.textContent = 'Orchestrate';

  const heading = document.createElement('h1');
  heading.className = 'ob-ask__title orchestrate-hub__title';
  heading.textContent = 'Boards & plans';

  const lede = document.createElement('p');
  lede.className = 'ob-ask__lede orchestrate-hub__lede';
  lede.textContent = 'Run a plan as a board, or resume work already linked to this workspace.';

  const workspaceLine = document.createElement('p');
  workspaceLine.id = 'orchestrateHubWorkspace';
  workspaceLine.className = 'ob-ask__workspace orchestrate-hub__workspace';
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

  const sec = document.createElement('span');
  sec.id = 'orchestrateHubPlanLabel';
  sec.className = 'ob-ask__sec hub-strip__label';
  sec.textContent = 'Start from plan';

  const workflow = document.createElement('section');
  workflow.className = 'orchestrate-hub__workflow';
  workflow.setAttribute('aria-labelledby', 'orchestrateHubPlanLabel');

  const field = document.createElement('div');
  field.className = 'ob-ask__field orchestrate-hub__workflow-body';

  const sel = document.createElement('select');
  sel.id = 'orchestrateHubPlanSelect';
  sel.className = 'orchestrate-hub__plan-select';
  sel.setAttribute('aria-label', 'Orchestrate plan file');

  const workflowActions = document.createElement('div');
  workflowActions.className = 'ob-ask__actions orchestrate-hub__workflow-actions';

  const secondaryActions = document.createElement('div');
  secondaryActions.className = 'orchestrate-hub__workflow-secondary';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'orchestrate-hub__plan-refresh';
  refreshBtn.id = 'orchestrateHubPlanRefresh';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.title = 'Reload plan list from workspace';

  const makePlanBtn = document.createElement('button');
  makePlanBtn.type = 'button';
  makePlanBtn.className = 'orchestrate-hub__make-plan-btn';
  makePlanBtn.id = 'orchestrateHubMakePlan';
  makePlanBtn.textContent = 'Make a plan';

  secondaryActions.append(refreshBtn, makePlanBtn);

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'orchestrate-hub__start-btn';
  startBtn.id = 'orchestrateHubStartBoard';
  startBtn.textContent = 'Open board';

  workflowActions.append(secondaryActions, startBtn);
  field.append(sel, workflowActions);

  const hint = document.createElement('p');
  hint.id = 'orchestrateHubPlanHint';
  hint.className = 'orchestrate-hub__plan-hint hidden';
  hint.setAttribute('role', 'status');

  const previewSection = document.createElement('div');
  previewSection.id = 'orchestrateHubPlanPreview';
  previewSection.className = 'orchestrate-hub__plan-preview';
  previewSection.hidden = true;
  previewSection.setAttribute('aria-live', 'polite');

  const pathChip = document.createElement('p');
  pathChip.className = 'orchestrate-plan-screen__path';
  pathChip.id = 'orchestrateHubPlanPreviewPath';

  const previewWrap = document.createElement('div');
  previewWrap.className = 'orchestrate-plan-screen__preview-wrap';

  const previewMount = document.createElement('div');
  previewMount.className = 'orchestrate-plan-screen__preview';
  previewMount.id = 'orchestrateHubPlanPreviewMount';
  previewWrap.appendChild(previewMount);
  previewSection.append(pathChip, previewWrap);

  const previewElements: OrchestrateHubPlanPreviewElements = {
    section: previewSection,
    pathChip,
    previewMount,
  };

  workflow.append(sec, field, hint, previewSection);
  ask.append(eyebrow, heading, lede, workspaceLine, workflow);
  pane.appendChild(ask);
  main.appendChild(pane);

  const chat = getActiveChat();

  const syncStartDisabled = () => {
    const path = sel.value.trim();
    startBtn.disabled = !path || !isExecutableOrchestratePlan(path);
  };

  const syncPlanPreview = () => {
    void refreshOrchestrateHubPlanPreview(sel.value, previewElements);
  };

  sel.addEventListener('change', () => {
    persistOrchestratePlanPathFromSelectValue(getActiveChat(), sel.value);
    syncStartDisabled();
    syncPlanPreview();
  });

  refreshBtn.addEventListener('click', () => {
    void loadHubPlans(sel, hint, getActiveChat()).then(() => {
      syncStartDisabled();
      syncPlanPreview();
    });
  });

  makePlanBtn.addEventListener('click', () => {
    void openOrchestratePlanScreen();
  });

  startBtn.addEventListener('click', () => startBoardFromHub(sel));

  void loadHubPlans(sel, hint, chat).then(() => {
    syncStartDisabled();
    syncPlanPreview();
  });
  paintRail();

  return page;
}

// ── Landing ──────────────────────────────────────────────────────────────────

/** Paint orchestrate hub into #chatArea (replaces current main view). */
/** Where entering Orchestrator should land: the board you were last inside, else the most recently active running board, else the hub itself. */
export function resolveOrchestrateLandingTarget(): ChatGroup | null {
  if (!sessionState) return null;

  const last = getLastBoardGroup();
  if (last?.orchestrateBoard) return last;

  const workspace = getWorkspacePath();
  const running = listWorkspaceOrchestrateBoardGroups(workspace).filter(
    (group) => isLeftoverBoardRunning(group),
  );
  return running[0] ?? null;
}

export interface RenderOrchestrateHubOptions {
  /** Skip the resume and show the hub itself. */
  preferNew?: boolean;
}

/**
 * Enter Orchestrate: open the V2 Boards surface. No planner chat.
 */
export function openOrchestrateLanding(_options?: RenderOrchestrateHubOptions): void {
  teardownOrchestrateHub();
  void import('../orchestrator/boards-view').then(async (m) => {
    await m.openBoardsView();
    const { navigateToCodeBoards } = await import('../os/router');
    navigateToCodeBoards();
  });
}

export function renderOrchestrateHub(): void {
  void import('./main-column-overlay').then((m) => {
    void m.closeOtherCodeStageViews('orchestrate');
  });
  teardownOrchestratePlanScreen();
  teardownHub();
  teardownCodeBrainMapBeforeChatPaint();
  teardownIssuesEmbedBeforeChatPaint();
  if (isCodeOverviewOpen()) {
    closeCodeOverview({ skipNavigate: true, restoreChat: false });
  }
  void import('./dev-server-screen').then((m) => {
    if (m.isDevServerScreenOpen()) {
      m.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
    }
  });
  const area = document.getElementById('chatArea');
  if (!area) return;
  closeBoardChatEmbedForTeardown();
  if (!hubReturnChatId && sessionState?.activeId) {
    hubReturnChatId = sessionState.activeId;
  }
  area.replaceChildren();
  area.appendChild(buildOrchestrateHubDom());
  stripMainColumnOverlayClasses();
  area.classList.add('chat-area--orchestrate-hub', OB_CHAT_AREA_CLASS);
  document.getElementById('mainColumn')?.classList.remove('main-column--board-view');
  syncTopBarOrchestrateButton();
  notifyAskQuestionDisplayContextChanged();
  notifyCodeStageViewChanged();
  void import('../os/router').then((m) => m.syncCodeSectionHash('orchestrate'));
}

/** Close hub and restore the chat that was active when the hub opened. */
export function closeOrchestrateHub(): void {
  if (!isOrchestrateHubMounted()) return;
  const returnId = hubReturnChatId;
  teardownOrchestrateHub();
  if (!sessionState) {
    void import('../os/router').then((m) => m.navigateToCodeChatIfCurrentSection('orchestrate'));
    return;
  }
  const targetId =
    returnId && sessionState.chats.some((c) => c.id === returnId)
      ? returnId
      : sessionState.activeId;
  const chat = sessionState.chats.find((c) => c.id === targetId);
  if (chat) renderChatFromHistory(chat);
  void import('../os/router').then((m) => m.navigateToCodeChatIfCurrentSection('orchestrate'));
}

/** Toggle the V2 Boards surface from the Orchestrate top-bar button. */
export function toggleOrchestrateHubFromTopbar(): void {
  void import('../orchestrator/boards-view').then(async (m) => {
    if (m.isBoardsViewOpen()) {
      await m.closeBoardsView();
      return;
    }
    await m.openBoardsView();
    const { navigateToCodeBoards } = await import('../os/router');
    navigateToCodeBoards();
  });
}

/** Wire top-bar button (idempotent). */
export function initOrchestrateHub(): void {
  void import('./code-views-orchestrate-button').then((m) =>
    m.initCodeViewsOrchestrateButton(),
  );
}

/** Clear hub state between tests. */
export function resetOrchestrateHubForTests(): void {
  hubReturnChatId = null;
  hubPlanPreviewRequestId = 0;
  teardownOrchestrateHub();
}
