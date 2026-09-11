import type { CodeSectionId } from '../os/types';
import { getActiveBoardGroup } from '../state/chat-groups';
import { emitChatSidebarChanged } from './layout-events';
import { isSuperPlanChromeActive } from './super-plan-chrome';

/** View-bar / embed destinations that compete for #chatArea. */
export type CodeStageViewKeep =
  | 'overview'
  | 'dev-server'
  | 'super-plan'
  | 'orchestrate'
  | 'boards'
  | 'map'
  | 'issues'
  | 'research';

const CHAT_AREA_OVERLAY_CLASSES = [
  'chat-area--code-overview',
  'chat-area--code-brain-map',
  'chat-area--orchestrate-hub',
  'chat-area--orchestrate',
  'chat-area--orchestrator-boards',
  'chat-area--plan-screen',
  'chat-area--issues',
  'chat-area--dev-server',
  'chat-area--research',
] as const;

const MAIN_COLUMN_OVERLAY_CLASSES = [
  'main-column--code-overview',
  'main-column--code-brain-map',
  'main-column--orchestrator-boards',
  'main-column--plan-screen',
  'main-column--issues',
  'main-column--dev-server',
  'main-column--research',
] as const;

/** Remove overlay modifier classes from #chatArea and #mainColumn. */
export function stripMainColumnOverlayClasses(): void {
  const area = document.getElementById('chatArea');
  const main = document.getElementById('mainColumn');
  for (const className of CHAT_AREA_OVERLAY_CLASSES) {
    area?.classList.remove(className);
  }
  for (const className of MAIN_COLUMN_OVERLAY_CLASSES) {
    main?.classList.remove(className);
  }
}

/** True when a full-column overlay is showing and chat transcript DOM should not mount. */
export function isMainColumnOverlaySuppressingChatDom(): boolean {
  if (isCodeStageRootHidingChatSidebar()) return true;

  const area = document.getElementById('chatArea');
  if (!area) return false;
  for (const className of CHAT_AREA_OVERLAY_CLASSES) {
    if (area.classList.contains(className)) return true;
  }
  return false;
}

/** Stage roots and embeds that hide the chat rail (see code-chrome.css). */
function isCodeStageRootHidingChatSidebar(): boolean {
  if (document.getElementById('codeOverviewRoot')) return true;
  if (document.getElementById('codeBrainMapRoot')) return true;
  if (document.getElementById('orchestrateHub')) return true;
  if (document.getElementById('orchestratorBoardsRoot')) return true;
  if (document.getElementById('orchestratePlanScreen')) return true;
  if (document.getElementById('superPlanPage')) return true;
  if (document.getElementById('devServerScreenRoot')) return true;

  const area = document.getElementById('chatArea');
  if (area?.contains(document.getElementById('issuesView'))) return true;
  if (
    document.getElementById('researchView') &&
    area?.contains(document.getElementById('researchView'))
  ) {
    return true;
  }
  return false;
}

/** True while a Code view-bar destination owns the stage and the session list is hidden in CSS (same behaviour as Super Plan). */
export function isCodeStageViewHidingChatSidebar(): boolean {
  if (isSuperPlanChromeActive()) return true;
  if (isCodeStageRootHidingChatSidebar()) return true;
  if (document.getElementById('orchestrateBoardPage')) return true;
  const boardGroup = getActiveBoardGroup();
  if (boardGroup?.viewMode === 'board') return true;

  return isMainColumnOverlaySuppressingChatDom();
}

/** True when a Code view-bar overlay owns the stage, including Super Plan chrome. */
export function isCodeStageOverlayMounted(): boolean {
  if (isSuperPlanChromeActive()) return true;
  return isCodeStageRootHidingChatSidebar();
}

/** Notify Code view chrome (Chats toggle) after a stage view opens or closes. */
export function notifyCodeStageViewChanged(): void {
  emitChatSidebarChanged();
  void import('./preview-electron-visibility').then((m) => {
    m.scheduleElectronPreviewHostLayoutSync();
  });
}

/** Tear down every Code main-column overlay except `keep`. */
export async function closeOtherCodeStageViews(keep?: CodeStageViewKeep): Promise<void> {
  const area = document.getElementById('chatArea');

  if (
    keep !== 'super-plan' &&
    (isSuperPlanChromeActive() ||
      document.getElementById('superPlanPage') ||
      document.getElementById('orchestratePlanScreen'))
  ) {
    const { teardownOrchestratePlanScreen } = await import('./orchestrate-plan-screen');
    teardownOrchestratePlanScreen();
  }

  if (keep !== 'orchestrate' && document.getElementById('orchestrateHub')) {
    const hub = await import('./orchestrate-hub');
    hub.teardownOrchestrateHub();
  }

  if (keep !== 'boards' && document.getElementById('orchestratorBoardsRoot')) {
    const boards = await import('../orchestrator/boards-view');
    boards.teardownBoardsView();
  }

  if (keep !== 'overview' && document.getElementById('codeOverviewRoot')) {
    const overview = await import('./code-overview');
    overview.closeCodeOverview({ skipNavigate: true, restoreChat: false });
  }

  if (keep !== 'dev-server' && document.getElementById('devServerScreenRoot')) {
    const dev = await import('./dev-server-screen');
    if (dev.isDevServerScreenOpen()) {
      dev.closeDevServerScreen({ skipNavigate: true, restoreChat: false });
    }
  }

  if (keep !== 'map' && document.getElementById('codeBrainMapRoot')) {
    const { teardownCodeBrainMapBeforeChatPaint } = await import('./code-brain-map');
    teardownCodeBrainMapBeforeChatPaint();
  }

  if (keep !== 'issues' && area?.contains(document.getElementById('issuesView'))) {
    const { teardownIssuesEmbedBeforeChatPaint } = await import('./issues-page');
    teardownIssuesEmbedBeforeChatPaint();
  }

  if (
    keep !== 'research' &&
    document.getElementById('researchView') &&
    area?.contains(document.getElementById('researchView'))
  ) {
    const { teardownResearchPanelBeforeChatPaint } = await import('./research-panel');
    teardownResearchPanelBeforeChatPaint();
  }

  if (area?.classList.contains('chat-area--hub')) {
    const { teardownHub } = await import('./hub');
    teardownHub();
  }
}

/** Open a hash-backed Code view-bar destination. Chat is handled by app-host. */
export async function showCodeStageSection(section: CodeSectionId): Promise<void> {
  if (section === 'chat') return;
  if (section === 'overview') {
    const overview = await import('./code-overview');
    await overview.openCodeOverview();
    return;
  }
  if (section === 'dev-server') {
    const dev = await import('./dev-server-screen');
    await dev.openDevServerScreen();
    return;
  }
  if (section === 'super-plan') {
    const superPlan = await import('./super-plan-entry');
    await superPlan.openSuperPlanScreen({ skipNavigate: true });
    return;
  }
  if (section === 'orchestrate' || section === 'boards') {
    const boards = await import('../orchestrator/boards-view');
    await boards.openBoardsView();
    return;
  }
  if (section === 'map') {
    const map = await import('./code-brain-map');
    await map.openCodeBrainMap({ skipNavigate: true });
    return;
  }
}

/** Leave whichever Code stage view is active and restore the chat transcript. */
export async function closeActiveCodeStageView(): Promise<void> {
  const superPlan = await import('./super-plan-entry');
  if (superPlan.isSuperPlanScreenOpen()) {
    await superPlan.closeSuperPlanScreen();
    return;
  }

  if (document.getElementById('orchestratePlanScreen')) {
    const plan = await import('./orchestrate-plan-screen');
    const { sessionState } = await import('../state/sessions');
    plan.teardownOrchestratePlanScreen();
    const chat = sessionState?.activeId
      ? sessionState.chats.find((c) => c.id === sessionState.activeId)
      : undefined;
    if (chat) {
      const { renderChatFromHistory } = await import('./messages');
      renderChatFromHistory(chat);
    }
    return;
  }

  const boards = await import('../orchestrator/boards-view');
  if (boards.isBoardsViewOpen()) {
    await boards.closeBoardsView();
    return;
  }

  const hub = await import('./orchestrate-hub');
  if (hub.isOrchestrateHubMounted()) {
    hub.closeOrchestrateHub();
    return;
  }

  if (
    !isCodeStageOverlayMounted() &&
    (document.getElementById('orchestrateBoardPage') ||
      getActiveBoardGroup()?.viewMode === 'board')
  ) {
    const { setOrchestrateViewMode } = await import('./view-mode-toggle');
    setOrchestrateViewMode('chat');
    return;
  }

  const overview = await import('./code-overview');
  if (overview.isCodeOverviewOpen()) {
    overview.closeCodeOverview();
    return;
  }

  const dev = await import('./dev-server-screen');
  if (dev.isDevServerScreenOpen()) {
    dev.closeDevServerScreen();
    return;
  }

  const brain = await import('./code-brain-map');
  if (brain.isCodeBrainMapOpen()) {
    brain.closeCodeBrainMap();
  }
}
