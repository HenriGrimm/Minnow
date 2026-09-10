import { appAlert, appConfirm, appPrompt } from './app-dialog';
/** Orchestrate planning screen — full #chatArea overlay for Plan-mode authoring. */

import '../styles/orchestrate-plan-screen.css';

import { findLastPlanSavePath } from '../chat/plans/plan-from-history';
import {
  mountPlanPreviewContent,
  readPlanArtifactMarkdown,
} from '../chat/plans/plan-preview';
import {
  isExecutableOrchestratePlan,
} from '../chat/plans/plan-path';
import { normalizeModeId } from '../chat/modes/types';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import {
  cancelSuperPlan,
  getSuperPlanCheckpointKind,
  isSuperPlanAdvancing,
  isSuperPlanStalled,
  pauseSuperPlan,
  resumeSuperPlanAfterUser,
  resumeSuperPlanPipeline,
  retrySuperPlanStage,
  rewindSuperPlanToStage,
  skipSuperPlanStage,
  startSuperPlan,
  subscribeSuperPlanView,
} from '../chat/super-plan/client';
import {
  SUPER_PLAN_STAGE_LABELS,
  type SuperPlanStageId,
} from '../chat/super-plan/types';
import { isFirstUserMessagePending } from '../chat/titles/schedule';
import {
  getMainTurnActivity,
  subscribeMainTurnActivity,
} from '../chat/main-turn-activity';
import { isChatStreaming, subscribeChatStreamEnd } from '../chat/streaming-state';
import { stopGeneration } from '../chat/stop-generation';
import {
  findChatById,
  getActiveChat,
  removeChatById,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import type { Chat } from '../types';
import {
  buildHistoryUserContent,
  runChatTurn,
} from '../chat/messaging';
import { detectLocalServer, executeTool } from '../tools/client';
import { isLocalServerAvailable } from '../tools/config';
import { setChatMode } from './mode-selector';
import { teardownHub } from './hub';
import {
  closeOrchestrateHub,
  isOrchestrateHubMounted,
  renderOrchestrateHub,
  teardownOrchestrateHub,
} from './orchestrate-hub';
import { shortPlanLabel } from './orchestrate-plan-picker';
import { launchBoardFromPlan } from './orchestrate-launch';
import { applyComposerDraftForChat, persistComposerDraftOnChat } from './composer-draft';
import { getActiveComposerSurface } from './composer-surface';
import { createChatWithMode, renderSidebar, switchChat } from './sidebar';
import { renderChatFromHistory } from './messages';
import {
  forceCloseAskQuestionModalForChat,
  isAskQuestionModalOnPlanScreenHost,
  isAskQuestionModalOpenForChat,
  migrateActiveQuestionModalToHost,
} from './question-cards-modal';
import {
  PLAN_PROGRESS_MOUNT_ID,
  PlanProgressPanel,
  SUPER_PLAN_DISPLAY_STEPS,
  SUPER_PLAN_STEP_TO_STAGE,
  buildPlanPreviewPopoutDom,
  prefersReducedMotion,
  regularPlanWorkingStepFromChat,
  type SuperPlanDisplayStepIndex,
} from './plan-progress-screen';
import { PlanActivityCollector } from './plan-activity-collector';
import { ResearchActivitySession } from '../research/research-activity-session';
import {
  buildSuperPlanPageDom,
  getSuperPlanQuestionsHost,
  isSuperPlanPageMounted,
  refreshSuperPlanLibrary,
  syncSuperPlanPage,
  teardownSuperPlanPage,
  SUPER_PLAN_PAGE_ROOT_ID,
  type SuperPlanPageHandlers,
} from './super-plan-page';
import { syncSuperPlanChrome } from './super-plan-chrome';
import { openSettings } from './settings-page';
import { readDefaultModelBinding } from './default-model';
import { setStatus } from './status';

import { isSuperPlanPipelineResumable } from '../chat/super-plan/client';
import { isReusableEmptyPlanChat } from '../chat/super-plan/spare-chat';
import { isChatInCurrentWorkspace, type PlanLibraryEntry } from '../chat/super-plan/plan-library';
import { getWorkspacePath } from '../state/workspace';

export const ORCHESTRATE_PLAN_SCREEN_ROOT_ID = 'orchestratePlanScreen';
export const ORCHESTRATE_PLAN_SCREEN_PROMPT_ID = 'orchestratePlanScreenPrompt';
export const ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID = 'orchestratePlanScreenQuestions';
export const ORCHESTRATE_PLAN_BANNER_ID = 'orchestratePlanBanner';

/** Rotating status lines during the working phase. */
export const ORCHESTRATE_PLAN_SCREEN_STATUS_LINES = [
  'Scanning the workspace…',
  'Mapping dependencies…',
  'Drafting waves in documentation/plans/…',
  'Scoping tasks and acceptance criteria…',
  'Checking constraints against the repo…',
  'Surfacing edge cases…',
] as const;

/** @deprecated Use {@link ORCHESTRATE_PLAN_SCREEN_STATUS_LINES}. */
export const ORCHESTRATE_PLAN_SCREEN_FISH_STATUS = ORCHESTRATE_PLAN_SCREEN_STATUS_LINES;

const CHAT_AREA_PLAN_SCREEN_CLASS = 'chat-area--plan-screen';
const CHAT_AREA_SUPER_PLAN_CLASS = 'chat-area--super-plan';
const MAIN_COLUMN_PLAN_SCREEN_CLASS = 'main-column--plan-screen';

export type OrchestratePlanScreenPhase =
  | 'prompt'
  | 'working'
  | 'super-plan-working'
  | 'questions'
  | 'spec_confirm'
  | 'preview'
  | 'error';

export interface OrchestratePlanScreenSession {
  chatId: string;
  phase: OrchestratePlanScreenPhase;
  planPath?: string;
  savedPrompt?: string;
  planScreenSuspended?: boolean;
  errorMessage?: string;
}

export interface RenderOrchestratePlanScreenOptions {
  phase: OrchestratePlanScreenPhase;
  chatId: string;
  planPath?: string;
  savedPrompt?: string;
  errorMessage?: string;
  /** Plan or build-spec markdown for preview / spec_confirm phases. */
  previewMarkdown?: string;
  /** When true, keep the overlay torn down and only update session (banner resume sets false). */
  planScreenSuspended?: boolean;
}

let planSession: OrchestratePlanScreenSession | null = null;
let streamEndUnsubscribe: (() => void) | null = null;
let activityUnsubscribe: (() => void) | null = null;
let superPlanUnsubscribe: (() => void) | null = null;
let planProgressPanel: PlanProgressPanel | null = null;
let planActivitySession: ResearchActivitySession | null = null;
let planActivityCollector: PlanActivityCollector | null = null;
/** Set while the user is reading a plan they picked out of the library rather than the run that owns the session. */
let superPlanDocPath: string | null = null;
/** Artifact signature of the last library refresh, so ticks do not re-list. */
let lastSuperPlanArtifacts = '';

// ── Session ──────────────────────────────────────────────────────────────────

function ensureStreamEndListener(): void {
  if (streamEndUnsubscribe) return;
  streamEndUnsubscribe = subscribeChatStreamEnd((chatId) => {
    void onPlanSessionStreamEnd(chatId);
  });
}

/** True when either plan screen root (centered overlay or Super Plan page) is in #chatArea. */
export function isOrchestratePlanScreenMounted(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID) ||
      document.getElementById(SUPER_PLAN_PAGE_ROOT_ID),
  );
}

/** User switched away while a plan session exists (DOM torn down, session kept). */
export function isOrchestratePlanScreenSuspended(): boolean {
  return Boolean(planSession?.planScreenSuspended);
}

/**
 * Chat stream/tool bubbles should not mount for this chat while the plan screen owns the view.
 */
export function isOrchestratePlanScreenSuppressingChatDom(chatId?: string): boolean {
  if (!isOrchestratePlanScreenMounted()) return false;
  if (isOrchestratePlanScreenSuspended()) return false;
  const session = planSession;
  if (!session?.chatId) return false;
  if (chatId && session.chatId !== chatId) return false;
  return true;
}

/** Active or suspended plan-screen session (banner / stream-end wiring). */
export function getOrchestratePlanScreenSession(): OrchestratePlanScreenSession | null {
  return planSession ? { ...planSession } : null;
}

/** @deprecated Prefer {@link getOrchestratePlanScreenSession}. */
export function getOrchestratePlanScreenOwnerChatId(): string | null {
  return planSession?.chatId ?? null;
}

export function isOrchestratePlanScreenSessionActive(chat: Chat): boolean {
  return Boolean(planSession && planSession.chatId === chat.id);
}

export function isOrchestratePlanScreenSuspendedForChat(chat: Chat): boolean {
  return Boolean(
    planSession &&
      planSession.chatId === chat.id &&
      planSession.planScreenSuspended &&
      !isOrchestratePlanScreenMounted(),
  );
}

export { isSuperPlanPipelineResumable } from '../chat/super-plan/client';

/** True when persisted {@link Chat.superPlanView} should rebuild the plan-screen session after reload (includes user-stopped/cancelled runs; excludes finished). */
export function isSuperPlanPlanScreenRestorable(chat: Chat): boolean {
  if (normalizeModeId(chat.modeId) !== 'super-plan') return false;
  const sp = chat.superPlanView;
  if (!sp) return false;
  if (sp.activeStage === 'present') {
    const record = sp.stages.present;
    if (record?.status === 'done') return false;
  }
  return true;
}

export function derivePlanScreenPhaseFromSuperPlan(chat: Chat): OrchestratePlanScreenPhase {
  const checkpoint = getSuperPlanCheckpointKind(chat);
  if (checkpoint === 'spec_confirm') return 'spec_confirm';
  if (checkpoint === 'present') return 'preview';
  const sp = chat.superPlanView!;
  const record = sp.stages[sp.activeStage];
  if (record?.status === 'error' && !sp.cancelled) return 'error';
  if (
    sp.activeStage === 'grill' &&
    (record?.status === 'running' || isChatStreaming(chat.id))
  ) {
    return 'questions';
  }
  return 'super-plan-working';
}

function resolvePlanSessionArtifactPath(
  chat: Chat,
  phase: OrchestratePlanScreenPhase,
): string | undefined {
  const sp = chat.superPlanView;
  if (!sp) return undefined;
  if (phase === 'spec_confirm') {
    return (
      sp.stages.spec_confirm?.artifactPath?.trim() || sp.specPath?.trim() || undefined
    );
  }
  if (phase === 'preview') {
    return (
      sp.stages.present?.artifactPath?.trim() ||
      sp.planPath?.trim() ||
      findLastPlanSavePath(chat.history) ||
      undefined
    );
  }
  return sp.planPath?.trim() || undefined;
}

/** Rebuild the in-memory plan-screen session from persisted {@link Chat.superPlanView} after reload or when returning to Code without an active overlay session. */
export function restoreOrchestratePlanScreenSessionFromChat(chat: Chat): boolean {
  if (planSession?.chatId === chat.id) return true;
  if (!isSuperPlanPlanScreenRestorable(chat)) return false;

  const sp = chat.superPlanView!;
  const record = sp.stages[sp.activeStage];
  const phase = derivePlanScreenPhaseFromSuperPlan(chat);
  planSession = {
    chatId: chat.id,
    phase,
    planPath: resolvePlanSessionArtifactPath(chat, phase),
    savedPrompt: sp.prompt,
    planScreenSuspended: true,
    errorMessage:
      record?.status === 'error' && !sp.cancelled
        ? record.error?.trim() ||
          'Super Plan stopped with an error. Open the chat to review.'
        : undefined,
  };
  ensureStreamEndListener();
  wireSuperPlanControllerListener(chat);
  return true;
}

/** Suspend overlay when leaving the plan chat via sidebar (keeps session). */
export function suspendOrchestratePlanScreenOnLeave(leavingChatId: string): void {
  if (!planSession || planSession.chatId !== leavingChatId) return;
  if (!isOrchestratePlanScreenMounted()) return;
  preservePlanScreenQuestionsPhase();
  planSession.planScreenSuspended = true;
  teardownOrchestratePlanScreenDom({
    keepQuestionsInComposer: true,
    chatId: leavingChatId,
  });
}

/** Suspend overlay when foregrounding another Minnow app (keep grill questions in composer). */
export function suspendOrchestratePlanScreenOnAppLeave(leavingChatId: string): void {
  if (!planSession || planSession.chatId !== leavingChatId) return;
  if (!isOrchestratePlanScreenMounted()) return;
  preservePlanScreenQuestionsPhase();
  planSession.planScreenSuspended = true;
  teardownOrchestratePlanScreenDom({
    keepQuestionsInComposer: true,
    chatId: leavingChatId,
  });
}

function preservePlanScreenQuestionsPhase(): void {
  if (!planSession) return;
  if (
    planSession.phase === 'questions' ||
    planSession.phase === 'super-plan-working' ||
    planSession.phase === 'working'
  ) {
    if (isAskQuestionModalOpenForChat(planSession.chatId)) {
      planSession.phase = 'questions';
    }
  }
}

function preparePlanScreenQuestionsBeforeTeardown(
  chatId: string,
  options: { keepQuestionsInComposer?: boolean } = {},
): void {
  if (!isAskQuestionModalOpenForChat(chatId)) {
    return;
  }
  if (isAskQuestionModalOnPlanScreenHost()) {
    if (options.keepQuestionsInComposer) {
      const composerHost = document.getElementById('questionHost');
      if (composerHost && migrateActiveQuestionModalToHost(composerHost)) {
        if (planSession) planSession.phase = 'questions';
        return;
      }
    }
    forceCloseAskQuestionModalForChat(chatId);
    return;
  }
  if (options.keepQuestionsInComposer) {
    if (planSession) planSession.phase = 'questions';
    return;
  }
  forceCloseAskQuestionModalForChat(chatId);
}

/** Scroll viewport that hosts the floating resume banner (sibling of #chatArea). */
function resolvePlanScreenBannerHost(area: HTMLElement): HTMLElement {
  const viewport = area.closest('.chat-viewport');
  if (viewport instanceof HTMLElement) return viewport;
  return area.parentElement ?? area;
}

/** Remove the suspended-session resume banner from the chat viewport. */
export function removeOrchestratePlanScreenSuspendedBanner(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(ORCHESTRATE_PLAN_BANNER_ID)?.remove();
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/** Remove overlay nodes only; session state is preserved. */
export function teardownOrchestratePlanScreenDom(
  options: { keepQuestionsInComposer?: boolean; chatId?: string } = {},
): void {
  if (typeof document === 'undefined') return;
  if (options.chatId) {
    preparePlanScreenQuestionsBeforeTeardown(options.chatId, options);
  }
  resetPlanScreenDomMounts();
  removeOrchestratePlanScreenSuspendedBanner();
  superPlanDocPath = null;
  document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID)?.remove();
  document.getElementById(SUPER_PLAN_PAGE_ROOT_ID)?.remove();
  document
    .getElementById('chatArea')
    ?.classList.remove(CHAT_AREA_PLAN_SCREEN_CLASS, CHAT_AREA_SUPER_PLAN_CLASS);
  document
    .getElementById('mainColumn')
    ?.classList.remove(MAIN_COLUMN_PLAN_SCREEN_CLASS);
  syncSuperPlanChrome(false);
  notifyAskQuestionDisplayContextChanged();
}

/** Remove overlay and clear plan-screen session. */
export function teardownOrchestratePlanScreen(): void {
  const chatId = planSession?.chatId;
  teardownOrchestratePlanScreenDom(chatId ? { chatId } : {});
  planSession = null;
}

export function resetOrchestratePlanScreenForTests(): void {
  planSession = null;
  if (streamEndUnsubscribe) {
    streamEndUnsubscribe();
    streamEndUnsubscribe = null;
  }
  superPlanUnsubscribe?.();
  superPlanUnsubscribe = null;
  teardownOrchestratePlanScreenDom();
}

/**
 * True when the plan screen owns an in-flight turn for this chat (mounted, not suspended).
 */
export function isOrchestratePlanScreenOwningChat(chatId: string): boolean {
  const session = planSession;
  if (!session || session.chatId !== chatId || session.planScreenSuspended) {
    return false;
  }
  if (!isOrchestratePlanScreenMounted()) return false;
  return (
    session.phase === 'working' ||
    session.phase === 'super-plan-working' ||
    session.phase === 'questions'
  );
}

/**
 * Embedded ask_question host while planning; moves session to `questions` during working.
 */
export function resolveOrchestratePlanScreenQuestionHost(
  forChatId?: string,
): HTMLElement | null {
  const session = planSession;
  if (!session?.chatId) return null;
  const targetChatId = forChatId?.trim() || getActiveChat().id;
  if (session.chatId !== targetChatId) return null;
  if (!isOrchestratePlanScreenMounted() || isOrchestratePlanScreenSuspended()) {
    return null;
  }
  if (session.phase !== 'working' && session.phase !== 'super-plan-working' && session.phase !== 'questions') {
    return null;
  }
  if (session.phase === 'working' || session.phase === 'super-plan-working') {
    session.phase = 'questions';
  }
  if (isSuperPlanPageMounted()) {
    return getSuperPlanQuestionsHost();
  }
  let host = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
  if (!host) {
    renderOrchestratePlanScreen({
      phase: 'questions',
      chatId: session.chatId,
      savedPrompt: session.savedPrompt,
      planPath: session.planPath,
      errorMessage: session.errorMessage,
    });
    host = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
  }
  if (host) host.hidden = false;
  return host;
}

function resolvePlanScreenWorkingPhase(chat: Chat): 'working' | 'super-plan-working' {
  return normalizeModeId(chat.modeId) === 'super-plan' ? 'super-plan-working' : 'working';
}

/** Confirm + rewind when the user clicks a completed stage in the pipeline column. */
async function handleSuperPlanStageRework(
  chatId: string,
  stageId: SuperPlanStageId,
): Promise<void> {
  const chat = findChatById(chatId);
  if (!chat?.superPlanView || chat.superPlanView.cancelled) return;
  const confirmed = await appConfirm(
    `Rework the pipeline from "${SUPER_PLAN_STAGE_LABELS[stageId]}"? Later stages will run again.`,
  );
  if (!confirmed) return;
  if (planSession?.chatId === chat.id) {
    planSession.phase = 'super-plan-working';
  }
  void rewindSuperPlanToStage(chat, stageId);
}

/** Confirm + rewind when the user clicks a completed stepper node. */
async function handleSuperPlanStepRework(chatId: string, stepIndex: number): Promise<void> {
  const chat = findChatById(chatId);
  if (!chat?.superPlanView || chat.superPlanView.cancelled) return;
  const stageId = SUPER_PLAN_STEP_TO_STAGE[stepIndex as SuperPlanDisplayStepIndex];
  if (!stageId) return;
  const stepLabel =
    SUPER_PLAN_DISPLAY_STEPS[stepIndex]?.label ?? SUPER_PLAN_STAGE_LABELS[stageId];
  const confirmed = await appConfirm(
    `Rework the pipeline from "${stepLabel}"? Later stages will run again.`,
  );
  if (!confirmed) return;
  if (planSession?.chatId === chat.id) {
    planSession.phase = 'super-plan-working';
    renderOrchestratePlanScreen({
      phase: 'super-plan-working',
      chatId: chat.id,
      savedPrompt: planSession.savedPrompt,
    });
  }
  void rewindSuperPlanToStage(chat, stageId);
}

// ── Working phase ────────────────────────────────────────────────────────────

function mountPlanProgressPanel(chat: Chat): void {
  const mount = document.getElementById(PLAN_PROGRESS_MOUNT_ID);
  if (!mount) return;

  const variant =
    normalizeModeId(chat.modeId) === 'super-plan' ? 'super-plan' : 'regular-plan';
  planProgressPanel?.destroy();
  planProgressPanel = new PlanProgressPanel(mount, {
    variant,
    reducedMotion: prefersReducedMotion(),
    ...(variant === 'super-plan'
      ? { onStepClick: (stepIndex: number) => void handleSuperPlanStepRework(chat.id, stepIndex) }
      : {}),
  });
  planProgressPanel.reset();

  if (variant === 'super-plan' && chat.superPlanView) {
    const activity = getMainTurnActivity(chat.id);
    planProgressPanel.applySuperPlanState(chat.superPlanView, {
      phase: activity?.phase ?? null,
      currentTool: activity?.currentTool ?? undefined,
    });
  } else {
    const activity = getMainTurnActivity(chat.id);
    const step = regularPlanWorkingStepFromChat(
      chat,
      activity?.phase ?? null,
      activity?.currentTool ?? undefined,
    );
    planProgressPanel.applyRegularPlanStep(step);
  }
}

function syncPlanProgressFromChat(chat: Chat): void {
  if (!planProgressPanel) return;
  if (normalizeModeId(chat.modeId) === 'super-plan' && chat.superPlanView) {
    const activity = getMainTurnActivity(chat.id);
    planProgressPanel.applySuperPlanState(chat.superPlanView, {
      phase: activity?.phase ?? null,
      currentTool: activity?.currentTool ?? undefined,
    });
    syncWorkingPhaseControls(chat);
    return;
  }
  const activity = getMainTurnActivity(chat.id);
  const step = regularPlanWorkingStepFromChat(
    chat,
    activity?.phase ?? null,
    activity?.currentTool ?? undefined,
  );
  planProgressPanel.applyRegularPlanStep(step);
}

/** Toggle Pause/Resume visibility on the working screen from live pipeline state. */
function syncWorkingPhaseControls(chat: Chat): void {
  if (typeof document === 'undefined') return;
  const root = document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID);
  if (!root) return;
  const pauseBtn = root.querySelector('[data-plan-pause]') as HTMLButtonElement | null;
  const resumeBtn = root.querySelector('[data-plan-resume]') as HTMLButtonElement | null;
  const skipInterviewBtn = root.querySelector(
    '[data-plan-skip-interview]',
  ) as HTMLButtonElement | null;
  if (!pauseBtn && !resumeBtn && !skipInterviewBtn) return;
  const paused = Boolean(chat.superPlanView?.paused);
  const stalled = !paused && isSuperPlanStalled(chat) && !isSuperPlanAdvancing(chat.id);
  const showResume = paused || stalled;
  if (pauseBtn) pauseBtn.hidden = showResume;
  if (resumeBtn) resumeBtn.hidden = !showResume;
  if (skipInterviewBtn) skipInterviewBtn.hidden = chat.superPlanView?.activeStage !== 'grill';
}

function wirePlanScreenActivityListener(chatId: string): void {
  activityUnsubscribe?.();
  activityUnsubscribe = subscribeMainTurnActivity(() => {
    if (!isOrchestratePlanScreenMounted() || !planSession) return;
    if (planSession.chatId !== chatId) return;
    const chat = findChatById(chatId);
    if (!chat) return;
    syncPlanProgressFromChat(chat);
  });
}

function chatMatchesOpenWorkspace(chat: Chat): boolean {
  const ws = getWorkspacePath();
  if (!ws?.trim()) return true;
  return isChatInCurrentWorkspace(chat);
}

function findReusableEmptyPlanChat(
  modeId: 'plan' | 'super-plan',
  excludeChatId?: string,
): Chat | null {
  if (!sessionState) return null;
  // A live Super Plan often still has history: [] (lazy summaries or pre-interview).
  // isReusableEmptyPlanChat requires no superPlan and a truly empty transcript.
  const hit = sessionState.chats.find((c) => {
    if (excludeChatId && c.id === excludeChatId) return false;
    if (!isReusableEmptyPlanChat(c, modeId)) return false;
    if (!chatMatchesOpenWorkspace(c)) return false;
    if (isChatStreaming(c.id)) return false;
    if (isSuperPlanAdvancing(c.id)) return false;
    return true;
  });
  return hit ?? null;
}

function resolveOrCreatePlanChat(excludeChatId?: string): Chat {
  const targetMode =
    normalizeModeId(getActiveChat().modeId) === 'super-plan' ? 'super-plan' : 'plan';
  const active = getActiveChat();
  const activeIsSpare =
    (!excludeChatId || active.id !== excludeChatId) &&
    isReusableEmptyPlanChat(active, targetMode) &&
    chatMatchesOpenWorkspace(active) &&
    !isChatStreaming(active.id) &&
    !isSuperPlanAdvancing(active.id);
  if (activeIsSpare) {
    setChatMode(targetMode);
    return active;
  }
  const reusable = findReusableEmptyPlanChat(targetMode, excludeChatId);
  if (reusable) {
    if (sessionState && sessionState.activeId !== reusable.id) {
      switchChat(reusable.id);
    }
    setChatMode(targetMode);
    return getActiveChat();
  }
  const created = createChatWithMode({ modeId: targetMode });
  if (created.ok && created.chatId && sessionState) {
    if (sessionState.activeId !== created.chatId) {
      switchChat(created.chatId);
    }
    return sessionState.chats.find((c) => c.id === created.chatId) ?? getActiveChat();
  }
  return getActiveChat();
}

/** True when the plan screen may repaint #chatArea for this chat right now. */
function canRepaintPlanScreen(chat: Chat): boolean {
  const session = planSession;
  if (!session || session.chatId !== chat.id) return false;
  if (session.planScreenSuspended) return false;
  return getActiveChat().id === chat.id;
}

/** Refresh the suspended banner text in place (transcript stays untouched). */
function refreshSuspendedPlanBanner(chat: Chat): void {
  if (typeof document === 'undefined') return;
  if (!planSession || planSession.chatId !== chat.id) return;
  const banner = document.getElementById(ORCHESTRATE_PLAN_BANNER_ID);
  if (!banner) return;
  const text = banner.querySelector('.orchestrate-plan-screen-banner__text');
  if (text) text.textContent = suspendedPlanBannerText(getOrchestratePlanScreenSession());
}

async function syncPlanScreenFromSuperPlan(chat: Chat): Promise<void> {
  const session = planSession;
  if (!session || session.chatId !== chat.id) return;

  if (isSuperPlanPageMounted() && !superPlanDocPath) {
    session.phase = derivePlanScreenPhaseFromSuperPlan(chat);
    session.planPath =
      resolvePlanSessionArtifactPath(chat, session.phase) ?? session.planPath;
    if (!canRepaintPlanScreen(chat)) {
      refreshSuspendedPlanBanner(chat);
      return;
    }
    syncSuperPlanPage(chat);
    const artifacts = `${chat.superPlanView?.specPath ?? ''}|${chat.superPlanView?.planPath ?? ''}`;
    if (artifacts !== lastSuperPlanArtifacts) {
      lastSuperPlanArtifacts = artifacts;
      refreshSuperPlanLibrary();
    }
    return;
  }

  const checkpoint = getSuperPlanCheckpointKind(chat);
  if (checkpoint === 'spec_confirm') {
    const specPath =
      chat.superPlanView?.stages.spec_confirm?.artifactPath?.trim() ||
      chat.superPlanView?.specPath?.trim() ||
      '';
    session.phase = 'spec_confirm';
    session.planPath = specPath;
    if (!canRepaintPlanScreen(chat)) {
      refreshSuspendedPlanBanner(chat);
      return;
    }
    const previewMarkdown = specPath ? await readPlanArtifactMarkdown(specPath) : '';
    renderOrchestratePlanScreen({
      phase: 'spec_confirm',
      chatId: chat.id,
      planPath: specPath,
      savedPrompt: session.savedPrompt,
      previewMarkdown,
    });
    return;
  }

  if (checkpoint === 'present') {
    const planPath =
      chat.superPlanView?.stages.present?.artifactPath?.trim() ||
      chat.superPlanView?.planPath?.trim() ||
      findLastPlanSavePath(chat.history) ||
      '';
    session.phase = 'preview';
    session.planPath = planPath;
    if (!canRepaintPlanScreen(chat)) {
      refreshSuspendedPlanBanner(chat);
      return;
    }
    const previewMarkdown = planPath
      ? await readPlanArtifactMarkdown(planPath)
      : '';
    renderOrchestratePlanScreen({
      phase: 'preview',
      chatId: chat.id,
      planPath,
      savedPrompt: session.savedPrompt,
      previewMarkdown,
    });
    return;
  }

  const activeStage = chat.superPlanView?.activeStage;
  const stageStatus = activeStage ? chat.superPlanView?.stages[activeStage]?.status : undefined;
  if (stageStatus === 'error' && !chat.superPlanView?.cancelled) {
    session.phase = 'error';
    session.errorMessage =
      chat.superPlanView?.stages[activeStage!]?.error ??
      'Super Plan stopped with an error. Open the chat to review.';
    if (!canRepaintPlanScreen(chat)) {
      refreshSuspendedPlanBanner(chat);
      return;
    }
    renderOrchestratePlanScreen({
      phase: 'error',
      chatId: chat.id,
      savedPrompt: session.savedPrompt,
      errorMessage: session.errorMessage,
    });
    return;
  }

  const wasCheckpointPhase =
    session.phase === 'spec_confirm' || session.phase === 'preview' || session.phase === 'error';
  const keepQuestions =
    session.phase === 'questions' && isAskQuestionModalOpenForChat(chat.id);
  session.phase = keepQuestions ? 'questions' : 'super-plan-working';
  if (!canRepaintPlanScreen(chat)) {
    refreshSuspendedPlanBanner(chat);
    return;
  }
  if (wasCheckpointPhase || !document.getElementById(PLAN_PROGRESS_MOUNT_ID)) {
    renderOrchestratePlanScreen({
      phase: session.phase,
      chatId: chat.id,
      savedPrompt: session.savedPrompt,
    });
    return;
  }
  syncPlanProgressFromChat(chat);
  syncWorkingPhaseControls(chat);
}

function wireSuperPlanControllerListener(chat: Chat): void {
  superPlanUnsubscribe?.();
  superPlanUnsubscribe = subscribeSuperPlanView((updated) => {
    if (updated.id !== chat.id) return;
    if (
      planSession &&
      planSession.chatId === updated.id &&
      updated.superPlanView &&
      isOrchestratePlanScreenMounted() &&
      !planSession.planScreenSuspended
    ) {
      syncPlanProgressFromChat(updated);
    }
    void syncPlanScreenFromSuperPlan(updated);
  });
}

async function onPlanSessionStreamEnd(chatId: string): Promise<void> {
  const session = planSession;
  if (!session || session.chatId !== chatId) return;
  if (session.phase !== 'working' && session.phase !== 'super-plan-working' && session.phase !== 'questions') {
    return;
  }

  const chat = findChatById(chatId);
  if (!chat) return;

  if (normalizeModeId(chat.modeId) === 'super-plan' && chat.superPlanView) {
    await syncPlanScreenFromSuperPlan(chat);
    return;
  }

  const planPath = findLastPlanSavePath(chat.history);
  if (planPath) {
    const previewMarkdown = await readPlanArtifactMarkdown(planPath);
    if (planSession) {
      planSession.planPath = planPath;
      planSession.phase = 'preview';
    }
    if (planSession?.planScreenSuspended && getActiveChat().id === chatId) {
      renderChatFromHistory(chat);
      return;
    }
    renderOrchestratePlanScreen({
      phase: 'preview',
      chatId,
      planPath,
      savedPrompt: session.savedPrompt,
      previewMarkdown,
    });
    return;
  }

  if (!isChatStreaming(chatId)) {
    renderOrchestratePlanScreen({
      phase: 'error',
      chatId,
      savedPrompt: session.savedPrompt,
      errorMessage:
        'Planning finished without a saved plan file. Try again or open the chat to review.',
    });
  }
}

export interface StartPlanningFromPromptOptions {
  /** Keep the active chat (composer send) instead of reusing/creating an empty plan chat. */
  useActiveChat?: boolean;
}

/** Whether a composer send should open the plan screen and start the Super Plan pipeline. */
export function shouldRouteComposerSendToSuperPlan(
  chat: Chat,
  opts: {
    userText: string;
    skillId: string | null;
    attachmentCount: number;
  },
): boolean {
  if (normalizeModeId(chat.modeId) !== 'super-plan') return false;
  if (!opts.userText.trim()) return false;
  if (opts.skillId) return false;
  if (opts.attachmentCount > 0) return false;
  if (chat.superPlanView && !chat.superPlanView.cancelled) return false;
  if (isOrchestratePlanScreenOwningChat(chat.id)) return false;
  return true;
}

// ── Start planning ───────────────────────────────────────────────────────────

async function startPlanningFromPrompt(
  promptText: string,
  options?: StartPlanningFromPromptOptions,
): Promise<void> {
  teardownOrchestrateHub();
  let chat = options?.useActiveChat ? getActiveChat() : resolveOrCreatePlanChat();

  if (
    normalizeModeId(chat.modeId) === 'super-plan' &&
    isSuperPlanPipelineResumable(chat) &&
    chat.superPlanView!.prompt.trim() !== promptText.trim()
  ) {
    // Never replace a live pipeline with a different brief — open a spare chat.
    chat = resolveOrCreatePlanChat(chat.id);
  }

  const isSuper = normalizeModeId(chat.modeId) === 'super-plan';
  if (
    isSuper &&
    isSuperPlanPipelineResumable(chat) &&
    chat.superPlanView!.prompt.trim() !== promptText.trim()
  ) {
    // Still on the live chat (no spare could be allocated) — refuse rather than mix runs.
    return;
  }

  // Init Super Plan *before* mounting the page so PlanActivityCollector.start()
  // cannot replay the previous run's activityLog into the new buffer.
  if (isSuper) {
    const existing = chat.superPlanView;
    const finished = existing?.stages.present?.status === 'done';
    const samePromptResume =
      Boolean(existing) &&
      !existing!.cancelled &&
      !finished &&
      existing!.prompt.trim() === promptText.trim();
    if (!samePromptResume) {
      delete chat.superPlanView;
      renderSidebar();
    }
  }

  ensureStreamEndListener();

  planSession = {
    chatId: chat.id,
    phase: resolvePlanScreenWorkingPhase(chat),
    savedPrompt: promptText,
    planScreenSuspended: false,
  };

  renderOrchestratePlanScreen({
    phase: planSession.phase,
    chatId: chat.id,
    savedPrompt: promptText,
  });

  if (isSuper) {
    wireSuperPlanControllerListener(chat);
    await startSuperPlan(chat, promptText);
    return;
  }

  const rawText = promptText;
  const userText = rawText;
  const skillId = null;
  const displayText = userText;
  const historyContent = buildHistoryUserContent(displayText, []);

  await detectLocalServer();
  await runChatTurn({
    chat,
    pushUser: true,
    rawText,
    userText,
    skillId,
    displayText,
    historyContent,
    validAttachments: [],
    titleSeed: userText,
    shouldScheduleTitle: isFirstUserMessagePending(chat),
    skillBody: null,
  });
}

function openBoardWithPlan(planPath: string): void {
  teardownOrchestratePlanScreen();
  teardownOrchestrateHub();
  void launchBoardFromPlan(planPath);
}

function suspendToViewChat(chat: Chat): void {
  if (!planSession) return;
  preservePlanScreenQuestionsPhase();
  planSession.planScreenSuspended = true;
  teardownOrchestratePlanScreenDom({
    keepQuestionsInComposer: true,
    chatId: chat.id,
  });
  if (sessionState && sessionState.activeId !== chat.id) {
    switchChat(chat.id);
  } else {
    renderChatFromHistory(chat);
  }
}

/** Composer draft prefilled when opening a new Plan chat to revise an existing artifact. */
export function buildRevisePlanComposerDraft(planPath: string, savedPrompt?: string): string {
  const trimmed = planPath.trim();
  let draft = `Revise the plan at ${trimmed}:\n\n`;
  const saved = savedPrompt?.trim();
  if (saved) {
    draft += `(Original planning request: ${saved})\n`;
  }
  return draft;
}

/** Tear down the preview screen and open a normal Plan chat with an editable revise draft. */
function startRevisePlanFromPath(
  planPath: string,
  options: { savedPrompt?: string } = {},
): void {
  const trimmed = planPath.trim();
  if (!trimmed) return;

  teardownOrchestratePlanScreen();

  const created = createChatWithMode({
    modeId: 'plan',
    orchestratePlanPath: trimmed,
  });
  if (!created.ok || !created.chatId || !sessionState) return;

  const chat = sessionState.chats.find((c) => c.id === created.chatId);
  if (!chat) return;

  const draft = buildRevisePlanComposerDraft(trimmed, options.savedPrompt);
  persistComposerDraftOnChat(chat, draft);
  applyComposerDraftForChat(chat);
  scheduleSaveSessions();
  getActiveComposerSurface().inputEl?.focus();
}

function buildPlanPreviewActionHandlers(
  opts: RenderOrchestratePlanScreenOptions,
  planPath: string,
): import('./plan-progress-screen').PlanPreviewActionHandlers {
  return {
    onRevise: () => {
      if (!planPath.trim()) return;
      const saved = opts.savedPrompt?.trim() ?? planSession?.savedPrompt?.trim();
      void startRevisePlanFromPath(planPath, { savedPrompt: saved });
    },
    onStartOrchestrator: () => {
      if (planPath) openBoardWithPlan(planPath);
    },
    onBuild: () => {
      if (!planPath) return;
      teardownOrchestratePlanScreen();
      createChatWithMode({
        modeId: 'build',
        orchestratePlanPath: planPath,
        initialUserMessage: `Implement the plan at ${planPath}.`,
      });
    },
  };
}

function appendWorkingPhaseContent(
  inner: HTMLElement,
  opts: RenderOrchestratePlanScreenOptions,
  isSuperPlan: boolean,
): void {
  appendPlanScreenHeader(
    inner,
    isSuperPlan ? 'Super Plan' : 'Orchestrate',
    'Planning in progress',
    isSuperPlan
      ? 'The Super Plan pipeline runs through interview, spec, research, draft, review, and polish. Answer questions below or open the chat to inspect tool calls.'
      : 'Status updates here. Answer any questions below, or open the chat to inspect tool calls.',
  );

  const progressMount = document.createElement('div');
  progressMount.id = PLAN_PROGRESS_MOUNT_ID;
  progressMount.className = 'orchestrate-plan-screen__progress-mount';
  progressMount.setAttribute('role', 'status');
  progressMount.setAttribute('aria-live', 'polite');

  const questionsHost = document.createElement('div');
  questionsHost.id = ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID;
  questionsHost.className = 'orchestrate-plan-screen__questions';
  questionsHost.hidden = opts.phase !== 'questions';

  const actions = document.createElement('div');
  actions.className =
    'orchestrate-plan-screen__actions orchestrate-plan-screen__actions--spread';

  const actionsStart = document.createElement('div');
  actionsStart.className = 'orchestrate-plan-screen__actions-start';

  const viewChatBtn = document.createElement('button');
  viewChatBtn.type = 'button';
  viewChatBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
  viewChatBtn.textContent = 'View chat';
  viewChatBtn.addEventListener('click', () => {
    const chat = findChatById(opts.chatId);
    if (chat) suspendToViewChat(chat);
  });

  startPlanActivitySession(opts.chatId);

  const actionsEnd = document.createElement('div');
  actionsEnd.className = 'orchestrate-plan-screen__actions-start';

  if (isSuperPlan) {
    const chat = findChatById(opts.chatId);
    const paused = Boolean(chat?.superPlanView?.paused);
    const stalled = Boolean(
      chat && !paused && isSuperPlanStalled(chat) && !isSuperPlanAdvancing(chat.id),
    );
    const activeStage = chat?.superPlanView?.activeStage;

    const skipInterviewBtn = document.createElement('button');
    skipInterviewBtn.type = 'button';
    skipInterviewBtn.className =
      'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    skipInterviewBtn.dataset.planSkipInterview = 'true';
    skipInterviewBtn.textContent = 'Skip interview';
    skipInterviewBtn.title =
      'Skip the interview questions and go straight to writing the build spec';
    skipInterviewBtn.hidden = activeStage !== 'grill';
    skipInterviewBtn.addEventListener('click', () => {
      const target = findChatById(opts.chatId);
      if (target) void skipSuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    });

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    pauseBtn.dataset.planPause = 'true';
    pauseBtn.textContent = 'Pause';
    pauseBtn.hidden = paused || stalled;
    pauseBtn.addEventListener('click', () => {
      const target = findChatById(opts.chatId);
      if (target) pauseSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    });

    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
    resumeBtn.dataset.planResume = 'true';
    resumeBtn.textContent = 'Resume';
    resumeBtn.hidden = !(paused || stalled);
    resumeBtn.addEventListener('click', () => {
      const target = findChatById(opts.chatId);
      if (target) void resumeSuperPlanPipeline(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--danger';
    stopBtn.textContent = 'Stop';
    stopBtn.title = 'Cancel the Super Plan pipeline (a new run starts fresh)';
    stopBtn.addEventListener('click', () => {
      const target = findChatById(opts.chatId);
      if (target?.superPlanView) {
        cancelSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
      } else {
        stopGeneration(opts.chatId);
      }
    });

    actionsEnd.append(skipInterviewBtn, pauseBtn, resumeBtn, stopBtn);
  } else {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--danger';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => {
      stopGeneration(opts.chatId);
    });
    actionsEnd.appendChild(stopBtn);
  }

  actionsStart.append(viewChatBtn);
  actions.append(actionsStart, actionsEnd);
  inner.append(progressMount, questionsHost, actions);
  mountPlanActivityButton(actionsStart);

  const afterPaint =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: () => void) => {
          fn();
          return 0;
        };
  afterPaint(() => {
    const chat = findChatById(opts.chatId);
    if (chat) mountPlanProgressPanel(chat);
  });
}

// ── DOM build ────────────────────────────────────────────────────────────────

function appendPlanScreenHeader(
  parent: HTMLElement,
  eyebrow: string,
  title: string,
  lede?: string,
): void {
  const header = document.createElement('header');
  header.className = 'orchestrate-plan-screen__header';

  const eyebrowEl = document.createElement('p');
  eyebrowEl.className = 'orchestrate-plan-screen__eyebrow';
  eyebrowEl.textContent = eyebrow;

  const titleEl = document.createElement('h1');
  titleEl.className = 'orchestrate-plan-screen__title';
  titleEl.textContent = title;

  header.append(eyebrowEl, titleEl);
  if (lede?.trim()) {
    const ledeEl = document.createElement('p');
    ledeEl.className = 'orchestrate-plan-screen__lede';
    ledeEl.textContent = lede.trim();
    header.appendChild(ledeEl);
  }
  parent.appendChild(header);
}

/** Super Plan owns its own surface (rail + run pane). */
function buildSuperPlanScreenDom(
  opts: RenderOrchestratePlanScreenOptions,
  chat: Chat,
): HTMLElement {
  const handlers: SuperPlanPageHandlers = {
    onStart: (prompt) => {
      void startPlanningFromPrompt(prompt);
    },
    onPause: () => {
      const target = findChatById(opts.chatId);
      if (target) pauseSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onResume: () => {
      const target = findChatById(opts.chatId);
      if (target) void resumeSuperPlanPipeline(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onStop: () => {
      const target = findChatById(opts.chatId);
      if (target?.superPlanView) cancelSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
      else stopGeneration(opts.chatId);
    },
    onSkipInterview: () => {
      const target = findChatById(opts.chatId);
      if (target) void skipSuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onConfirmSpec: () => {
      const target = findChatById(opts.chatId);
      if (target) void resumeSuperPlanAfterUser(target, 'confirm').catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onReviseSpec: () => {
      const target = findChatById(opts.chatId);
      if (target) void resumeSuperPlanAfterUser(target, 'revise').catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onRetryStage: () => {
      const target = findChatById(opts.chatId);
      if (target) void retrySuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onSkipStage: () => {
      const target = findChatById(opts.chatId);
      if (target) void skipSuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onCancelPipeline: () => {
      const target = findChatById(opts.chatId);
      if (target) cancelSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    },
    onRework: (stageId) => {
      void handleSuperPlanStageRework(opts.chatId, stageId);
    },
    onOrchestrate: (planPath) => {
      if (planPath) openBoardWithPlan(planPath);
    },
    onBuild: (planPath) => {
      if (!planPath) return;
      teardownOrchestratePlanScreen();
      createChatWithMode({
        modeId: 'build',
        orchestratePlanPath: planPath,
        initialUserMessage: `Implement the plan at ${planPath}.`,
      });
    },
    onRevisePlan: (planPath) => {
      if (!planPath) return;
      startRevisePlanFromPath(planPath, { savedPrompt: opts.savedPrompt });
    },
    onOpenSettings: () => {
      openSettings('agent-center', { searchKey: 'modes.super-plan' });
    },
    onSelectRun: (chatId) => {
      openSuperPlanRun(chatId);
    },
    onOpenPlanFile: (path) => {
      renderSuperPlanDoc(path);
    },
    onNewPlan: () => {
      superPlanDocPath = null;
      // Mirror hub "Make a plan": a fresh compose chat, prior run left running.
      void import('./super-plan-entry').then((m) => {
        void m.openSuperPlanScreen({ preferNew: true });
      });
    },
    onDeleteEntry: (entry) => {
      void deleteSuperPlanLibraryEntry(entry);
    },
  };

  const mode: 'compose' | 'run' | 'doc' = superPlanDocPath
    ? 'doc'
    : opts.phase === 'prompt'
      ? 'compose'
      : 'run';

  return buildSuperPlanPageDom({
    chatId: opts.chatId,
    mode,
    savedPrompt: opts.savedPrompt,
    errorMessage: opts.errorMessage,
    docPath: superPlanDocPath ?? undefined,
    handlers,
  });
}

function buildPlanScreenDom(opts: RenderOrchestratePlanScreenOptions): HTMLElement {
  const superPlanChat = findChatById(opts.chatId);
  if (superPlanChat && normalizeModeId(superPlanChat.modeId) === 'super-plan') {
    return buildSuperPlanScreenDom(opts, superPlanChat);
  }

  const root = document.createElement('div');
  root.id = ORCHESTRATE_PLAN_SCREEN_ROOT_ID;
  root.className = 'orchestrate-plan-screen';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Orchestrate plan authoring');

  const chat = findChatById(opts.chatId);
  const isSuperPlanArtifact =
    opts.phase === 'spec_confirm' ||
    (opts.phase === 'preview' && chat && normalizeModeId(chat.modeId) === 'super-plan');
  if (isSuperPlanArtifact) {
    root.classList.add('orchestrate-plan-screen--super-plan-artifact');
  }

  const inner = document.createElement('div');
  inner.className = 'orchestrate-plan-screen__inner';

  if (opts.phase === 'prompt') {
    appendPlanScreenHeader(
      inner,
      'Orchestrate',
      'Make a plan',
      'Plan mode writes a markdown plan under documentation/plans/. When it is ready, open the board to run waves.',
    );

    const form = document.createElement('section');
    form.className = 'orchestrate-plan-screen__form';

    const promptLabel = document.createElement('label');
    promptLabel.className = 'orchestrate-plan-screen__prompt-label';
    promptLabel.htmlFor = ORCHESTRATE_PLAN_SCREEN_PROMPT_ID;
    promptLabel.textContent = 'What should this plan cover?';

    const prompt = document.createElement('textarea');
    prompt.id = ORCHESTRATE_PLAN_SCREEN_PROMPT_ID;
    prompt.className = 'orchestrate-plan-screen__prompt';
    prompt.rows = 8;
    prompt.placeholder =
      'Goals, constraints, tech stack, and how you want work grouped into waves…';
    if (opts.savedPrompt) prompt.value = opts.savedPrompt;

    const hint = document.createElement('p');
    hint.className = 'orchestrate-plan-screen__hint';
    hint.textContent =
      'The planner may ask follow-up questions before saving the plan file.';

    form.append(promptLabel, prompt, hint);

    const actions = document.createElement('div');
    actions.className =
      'orchestrate-plan-screen__actions orchestrate-plan-screen__actions--spread';

    const actionsStart = document.createElement('div');
    actionsStart.className = 'orchestrate-plan-screen__actions-start';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    backBtn.textContent = 'Back to hub';
    backBtn.addEventListener('click', () => {
      teardownOrchestratePlanScreen();
      if (isOrchestrateHubMounted()) {
        closeOrchestrateHub();
      } else {
        renderOrchestrateHub();
      }
    });

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
    startBtn.textContent = 'Start planning';
    startBtn.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (!text) {
        prompt.focus();
        return;
      }
      void startPlanningFromPrompt(text);
    });

    actionsStart.appendChild(backBtn);
    actions.append(actionsStart, startBtn);
    inner.append(form, actions);
  } else if (
    opts.phase === 'working' ||
    opts.phase === 'super-plan-working' ||
    opts.phase === 'questions'
  ) {
    const chat = findChatById(opts.chatId);
    const isSuperPlan =
      opts.phase === 'super-plan-working' ||
      normalizeModeId(chat?.modeId) === 'super-plan';
    appendWorkingPhaseContent(inner, opts, isSuperPlan);
  } else if (opts.phase === 'spec_confirm') {
    const specPath = opts.planPath?.trim() ?? '';
    appendPlanScreenHeader(
      inner,
      'Super Plan',
      'Confirm build spec',
      'Review the build specification below. Confirm to continue with research and drafting, or revise to regenerate the spec.',
    );

    if (specPath) {
      const pathChip = document.createElement('p');
      pathChip.className = 'orchestrate-plan-screen__path';
      pathChip.textContent = shortPlanLabel(specPath);
      pathChip.title = specPath;
      inner.appendChild(pathChip);
    }

    const previewWrap = document.createElement('div');
    previewWrap.className = 'orchestrate-plan-screen__preview-wrap';

    const previewMount = document.createElement('div');
    previewMount.className = 'orchestrate-plan-screen__preview';
    mountPlanPreviewContent(previewMount, opts.previewMarkdown ?? '', {
      modeId: 'super-plan',
      emptyLabel: '(build spec file is empty or could not be loaded)',
    });
    previewWrap.appendChild(previewMount);

    const actions = document.createElement('div');
    actions.className =
      'orchestrate-plan-screen__actions orchestrate-plan-screen__actions--spread';

    const actionsStart = document.createElement('div');
    actionsStart.className = 'orchestrate-plan-screen__actions-start';

    const viewChatBtn = document.createElement('button');
    viewChatBtn.type = 'button';
    viewChatBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    viewChatBtn.textContent = 'View chat';
    viewChatBtn.addEventListener('click', () => {
      const chat = findChatById(opts.chatId);
      if (chat) suspendToViewChat(chat);
    });

    const reviseBtn = document.createElement('button');
    reviseBtn.type = 'button';
    reviseBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    reviseBtn.textContent = 'Revise spec';
    reviseBtn.addEventListener('click', () => {
      const chat = findChatById(opts.chatId);
      if (!chat) return;
      if (planSession) planSession.phase = 'super-plan-working';
      renderOrchestratePlanScreen({
        phase: 'super-plan-working',
        chatId: opts.chatId,
        savedPrompt: opts.savedPrompt,
      });
      void resumeSuperPlanAfterUser(chat, 'revise').catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
    confirmBtn.textContent = 'Confirm spec';
    confirmBtn.addEventListener('click', () => {
      const chat = findChatById(opts.chatId);
      if (!chat) return;
      if (planSession) planSession.phase = 'super-plan-working';
      renderOrchestratePlanScreen({
        phase: 'super-plan-working',
        chatId: opts.chatId,
        savedPrompt: opts.savedPrompt,
      });
      void resumeSuperPlanAfterUser(chat, 'confirm').catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    });

    actionsStart.append(viewChatBtn, reviseBtn);
    actions.append(actionsStart, confirmBtn);
    inner.append(previewWrap, actions);
  } else if (opts.phase === 'preview') {
    const planPath = opts.planPath?.trim() ?? '';
    const chat = findChatById(opts.chatId);
    const isSuperPlan = normalizeModeId(chat?.modeId) === 'super-plan';
    appendPlanScreenHeader(
      inner,
      isSuperPlan ? 'Super Plan' : 'Orchestrate',
      'Plan ready',
      'Review the draft below, then choose how to continue.',
    );

    if (planPath) {
      const pathChip = document.createElement('p');
      pathChip.className = 'orchestrate-plan-screen__path';
      pathChip.textContent = shortPlanLabel(planPath);
      pathChip.title = planPath;
      inner.appendChild(pathChip);
    }

    const previewWrap = document.createElement('div');
    previewWrap.className = 'orchestrate-plan-screen__preview-wrap';

    const previewMount = document.createElement('div');
    previewMount.className = 'orchestrate-plan-screen__preview';
    mountPlanPreviewContent(previewMount, opts.previewMarkdown ?? '', {
      modeId: isSuperPlan ? 'super-plan' : 'plan',
    });
    previewWrap.appendChild(previewMount);

    const popout = buildPlanPreviewPopoutDom(
      buildPlanPreviewActionHandlers(opts, planPath),
      {
        orchestrateEnabled: Boolean(planPath && isExecutableOrchestratePlan(planPath)),
      },
    );

    const actions = document.createElement('div');
    actions.className =
      'orchestrate-plan-screen__actions orchestrate-plan-screen__actions--spread';

    const actionsStart = document.createElement('div');
    actionsStart.className = 'orchestrate-plan-screen__actions-start';

    const viewChatBtn = document.createElement('button');
    viewChatBtn.type = 'button';
    viewChatBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    viewChatBtn.textContent = 'View chat';
    viewChatBtn.addEventListener('click', () => {
      const chat = findChatById(opts.chatId);
      if (chat) suspendToViewChat(chat);
    });

    actionsStart.appendChild(viewChatBtn);
    actions.append(actionsStart);
    inner.append(previewWrap, popout, actions);
  } else if (opts.phase === 'error') {
    const chat = findChatById(opts.chatId);
    const isSuperPlan =
      normalizeModeId(chat?.modeId) === 'super-plan' && Boolean(chat?.superPlanView);
    const failedStage = isSuperPlan ? chat!.superPlanView!.activeStage : null;
    const stageLabel = failedStage ? SUPER_PLAN_STAGE_LABELS[failedStage] : null;

    appendPlanScreenHeader(
      inner,
      isSuperPlan ? 'Super Plan' : 'Orchestrate',
      isSuperPlan && stageLabel
        ? `Pipeline stopped at ${stageLabel}`
        : 'Planning stopped',
      isSuperPlan
        ? 'Earlier stages are kept. Retry just this stage, skip it, or open the chat to see what happened.'
        : 'The run ended without a saved plan file. Retry or open the chat to see what happened.',
    );

    const err = document.createElement('p');
    err.className = 'orchestrate-plan-screen__error';
    err.setAttribute('role', 'alert');
    err.textContent =
      opts.errorMessage?.trim() ||
      'Something went wrong while planning. Try again or view the chat.';

    const actions = document.createElement('div');
    actions.className =
      'orchestrate-plan-screen__actions orchestrate-plan-screen__actions--spread';

    const actionsStart = document.createElement('div');
    actionsStart.className = 'orchestrate-plan-screen__actions-start';

    const viewChatBtn = document.createElement('button');
    viewChatBtn.type = 'button';
    viewChatBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
    viewChatBtn.textContent = 'View chat';
    viewChatBtn.addEventListener('click', () => {
      const target = findChatById(opts.chatId);
      if (target) suspendToViewChat(target);
    });

    if (isSuperPlan) {
      const backToWorking = (): void => {
        if (planSession) planSession.phase = 'super-plan-working';
        renderOrchestratePlanScreen({
          phase: 'super-plan-working',
          chatId: opts.chatId,
          savedPrompt: opts.savedPrompt,
        });
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
      cancelBtn.textContent = 'Cancel pipeline';
      cancelBtn.addEventListener('click', () => {
        const target = findChatById(opts.chatId);
        if (target) cancelSuperPlan(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
        renderOrchestratePlanScreen({
          phase: 'prompt',
          chatId: opts.chatId,
          savedPrompt: opts.savedPrompt,
        });
      });

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
      skipBtn.textContent = stageLabel ? `Skip ${stageLabel}` : 'Skip stage';
      skipBtn.addEventListener('click', () => {
        const target = findChatById(opts.chatId);
        if (!target) return;
        backToWorking();
        void skipSuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
      });

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
      retryBtn.textContent = stageLabel ? `Retry ${stageLabel}` : 'Retry stage';
      retryBtn.addEventListener('click', () => {
        const target = findChatById(opts.chatId);
        if (!target) return;
        backToWorking();
        void retrySuperPlanStage(target).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
      });

      actionsStart.append(viewChatBtn, cancelBtn, skipBtn);
      actions.append(actionsStart, retryBtn);
    } else {
      const hubBtn = document.createElement('button');
      hubBtn.type = 'button';
      hubBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--ghost';
      hubBtn.textContent = 'Back to hub';
      hubBtn.addEventListener('click', () => {
        teardownOrchestratePlanScreen();
        renderOrchestrateHub();
      });

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--primary';
      retryBtn.textContent = 'Try again';
      retryBtn.addEventListener('click', () => {
        const saved = opts.savedPrompt?.trim() ?? planSession?.savedPrompt?.trim();
        if (saved) {
          void startPlanningFromPrompt(saved);
          return;
        }
        renderOrchestratePlanScreen({
          phase: 'prompt',
          chatId: opts.chatId,
          savedPrompt: opts.savedPrompt,
        });
      });

      actionsStart.append(viewChatBtn, hubBtn);
      actions.append(actionsStart, retryBtn);
    }
    inner.append(err, actions);
  }

  root.appendChild(inner);
  return root;
}

/** Drop progress/activity mounts before rebuilding the plan screen DOM. */
function resetPlanScreenDomMounts(): void {
  teardownSuperPlanPage();
  activityUnsubscribe?.();
  activityUnsubscribe = null;
  planActivityCollector?.stop();
  planActivityCollector = null;
  planActivitySession?.destroy();
  planActivitySession = null;
  planProgressPanel?.destroy();
  planProgressPanel = null;
}

function startPlanActivitySession(chatId: string): void {
  planActivityCollector?.stop();
  planActivitySession?.destroy();
  planActivitySession = new ResearchActivitySession();
  planActivitySession.configure({ title: 'Activity' });
  planActivitySession.reset();
  planActivityCollector = new PlanActivityCollector(chatId, planActivitySession.buffer);
  void planActivityCollector.start();
}

function mountPlanActivityButton(actionsStart: HTMLElement): void {
  if (!planActivitySession) return;
  planActivitySession.mountButton(actionsStart);
}

// ── Library ──────────────────────────────────────────────────────────────────

/** Remove a plan from the library rail (run chat, plan file, or both). */
async function deleteSuperPlanLibraryEntry(entry: PlanLibraryEntry): Promise<void> {
  const title = entry.title.trim() || 'this plan';
  const removes: string[] = [];
  if (entry.chatId) removes.push('the run chat');
  if (entry.path?.trim()) removes.push('the plan file');
  const detail = removes.length
    ? `This removes ${removes.join(' and ')}.`
    : 'This cannot be undone.';

  if (
    !(await appConfirm(`Delete "${title}"? ${detail}`, {
      confirmLabel: 'Delete',
      danger: true,
    }))
  ) {
    return;
  }

  if (entry.chatId && isChatStreaming(entry.chatId)) {
    setStatus('spin', 'Finish the current reply first');
    return;
  }

  const viewingDoc = Boolean(entry.path?.trim() && superPlanDocPath === entry.path.trim());
  const viewingRun = Boolean(
    entry.chatId && planSession?.chatId === entry.chatId && !superPlanDocPath,
  );

  if (entry.path?.trim()) {
    if (!isLocalServerAvailable()) {
      await appAlert('Start the local server to delete plan files on disk.');
      if (!entry.chatId) return;
    } else {
      setStatus('spin', 'Deleting…');
      try {
        const result = await executeTool('delete_path', { path: entry.path.trim() });
        const content = typeof result.content === 'string' ? result.content : '';
        if (content.startsWith('Error:')) {
          setStatus('err', content.replace(/^Error:\s*/i, '').trim() || 'Delete failed');
          if (!entry.chatId) return;
        }
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Delete failed');
        if (!entry.chatId) return;
      }
    }
  }

  if (entry.chatId) {
    const chat = findChatById(entry.chatId);
    if (chat?.superPlanView) {
      const live =
        entry.state === 'running' ||
        entry.state === 'waiting' ||
        entry.state === 'paused' ||
        entry.state === 'error';
      if (live) cancelSuperPlan(chat).catch((error) => setStatus('err', error instanceof Error ? error.message : 'Super Plan action failed'));
    }
    const { modelId } = readDefaultModelBinding();
    const result = removeChatById(entry.chatId, modelId);
    if (result.ok) {
      scheduleSaveSessions();
      renderSidebar();
    }
  }

  if (viewingDoc || viewingRun) {
    superPlanDocPath = null;
    const nextId = sessionState?.activeId;
    if (nextId) {
      renderOrchestratePlanScreen({ phase: 'prompt', chatId: nextId });
    }
  } else {
    refreshSuperPlanLibrary();
  }

  setStatus('idle', 'Plan deleted');
}

/** Open a Super Plan run picked from the library rail. */
function openSuperPlanRun(chatId: string): void {
  const chat = findChatById(chatId);
  if (!chat?.superPlanView || !isChatInCurrentWorkspace(chat)) return;
  superPlanDocPath = null;
  ensureStreamEndListener();
  if (sessionState && sessionState.activeId !== chatId) {
    switchChat(chatId);
  }
  renderOrchestratePlanScreen({
    phase: derivePlanScreenPhaseFromSuperPlan(chat),
    chatId,
    savedPrompt: chat.superPlanView.prompt,
  });
}

/** True when the Super Plan surface is already what this chat is showing. */
export function isSuperPlanScreenShowingChat(chatId: string): boolean {
  return Boolean(
    isSuperPlanPageMounted() &&
      planSession?.chatId === chatId &&
      !planSession.planScreenSuspended,
  );
}

/** True when the Super Plan surface is mounted, but for some other chat. */
export function isSuperPlanScreenMountedForOtherChat(chatId: string): boolean {
  return Boolean(
    isSuperPlanPageMounted() && planSession && planSession.chatId !== chatId,
  );
}

/** Paint the Super Plan surface for a chat that just came to the foreground. */
export function reopenSuperPlanScreenForChat(chat: Chat): void {
  if (normalizeModeId(chat.modeId) !== 'super-plan') return;
  if (isSuperPlanScreenShowingChat(chat.id)) return;

  const carried = planSession?.chatId === chat.id ? planSession : null;
  const phase: OrchestratePlanScreenPhase = chat.superPlanView
    ? derivePlanScreenPhaseFromSuperPlan(chat)
    : 'prompt';
  ensureStreamEndListener();
  renderOrchestratePlanScreen({
    phase,
    chatId: chat.id,
    planPath: resolvePlanSessionArtifactPath(chat, phase) ?? carried?.planPath,
    savedPrompt: chat.superPlanView?.prompt ?? carried?.savedPrompt,
  });
}

/** Show a saved plan the rail found on disk. */
function renderSuperPlanDoc(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  const chatId = planSession?.chatId ?? getActiveChat().id;
  const chat = findChatById(chatId);
  if (!chat || normalizeModeId(chat.modeId) !== 'super-plan') return;
  const area = document.getElementById('chatArea');
  if (!area) return;

  superPlanDocPath = trimmed;
  removeOrchestratePlanScreenSuspendedBanner();
  teardownHub();
  area.replaceChildren();
  area.appendChild(
    buildPlanScreenDom({
      phase: planSession?.phase ?? 'preview',
      chatId,
      savedPrompt: planSession?.savedPrompt,
    }),
  );
  area.classList.add(CHAT_AREA_PLAN_SCREEN_CLASS, CHAT_AREA_SUPER_PLAN_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_PLAN_SCREEN_CLASS);
  syncSuperPlanChrome(true);
  notifyAskQuestionDisplayContextChanged();
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Paint plan screen into #chatArea for the given phase. */
export function renderOrchestratePlanScreen(
  opts: RenderOrchestratePlanScreenOptions,
): void {
  superPlanDocPath = null;
  removeOrchestratePlanScreenSuspendedBanner();
  teardownHub();
  const prior = planSession;
  resetPlanScreenDomMounts();

  planSession = {
    chatId: opts.chatId,
    phase: opts.phase,
    planPath: opts.planPath,
    savedPrompt: opts.savedPrompt ?? prior?.savedPrompt,
    planScreenSuspended: opts.planScreenSuspended ?? false,
    errorMessage: opts.errorMessage,
  };

  const area = document.getElementById('chatArea');
  if (!area) return;
  if (
    opts.phase !== 'working' &&
    opts.phase !== 'super-plan-working' &&
    opts.phase !== 'questions'
  ) {
    planProgressPanel?.destroy();
    planProgressPanel = null;
  }
  const chat = findChatById(opts.chatId);
  const isSuperPlan = chat && normalizeModeId(chat.modeId) === 'super-plan';

  area.replaceChildren();
  area.appendChild(buildPlanScreenDom(opts));
  area.classList.add(CHAT_AREA_PLAN_SCREEN_CLASS);
  area.classList.toggle(CHAT_AREA_SUPER_PLAN_CLASS, Boolean(isSuperPlan));
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_PLAN_SCREEN_CLASS);
  document.getElementById('mainColumn')?.classList.remove('main-column--board-view');
  syncSuperPlanChrome(Boolean(isSuperPlan));

  const wiresSuperPlanListener =
    isSuperPlan &&
    (opts.phase === 'working' ||
      opts.phase === 'super-plan-working' ||
      opts.phase === 'questions' ||
      opts.phase === 'spec_confirm' ||
      opts.phase === 'preview');
  if (
    opts.phase === 'working' ||
    opts.phase === 'super-plan-working' ||
    opts.phase === 'questions'
  ) {
    wirePlanScreenActivityListener(opts.chatId);
  }
  if (wiresSuperPlanListener && chat) {
    wireSuperPlanControllerListener(chat);
  }
  notifyAskQuestionDisplayContextChanged();
}

/** Start Super Plan (or regular Plan) from the chat composer — mounts the plan screen and runs {@link startSuperPlan} / {@link runChatTurn} on the active chat. */
export async function startPlanningFromComposer(promptText: string): Promise<void> {
  const text = promptText.trim();
  if (!text) return;
  await startPlanningFromPrompt(text, { useActiveChat: true });
}

/** Open plan screen at prompt phase (entry from Orchestrate hub). */
export async function openOrchestratePlanScreen(): Promise<void> {
  teardownOrchestrateHub();
  const savedPrompt = planSession?.savedPrompt;
  const chatId = planSession?.chatId ?? getActiveChat().id;
  renderOrchestratePlanScreen({
    phase: 'prompt',
    chatId,
    savedPrompt,
  });
}

/** Banner copy for a suspended plan session (also used for in-place refresh). */
function suspendedPlanBannerText(
  session: OrchestratePlanScreenSession | null,
  chat?: Chat,
): string {
  const target = chat ?? (session ? findChatById(session.chatId) : undefined);
  if (target?.superPlanView?.cancelled) {
    return 'Super Plan was stopped. Return to the planning screen to review progress or start a new run.';
  }
  if (target?.superPlanView?.paused) {
    return 'Super Plan is paused. Return to the planning screen to resume the pipeline.';
  }
  if (session?.phase === 'preview') {
    return 'Your plan is ready. Return to the planning screen to review it.';
  }
  if (session?.phase === 'spec_confirm') {
    return 'Build spec ready for review. Return to the planning screen to confirm or revise.';
  }
  if (session?.phase === 'error') {
    return 'Planning stopped with an error. Return to the planning screen to retry or skip the stage.';
  }
  if (session?.phase === 'questions') {
    return 'Answer the grill questions below or return to the planning screen to continue the interview.';
  }
  return 'Planning in progress. Return to the planning screen to watch status and answer questions.';
}

/** Paint suspended-session banner over the chat viewport (pinned at top while scrolling). */
export function showOrchestratePlanScreenSuspendedBanner(
  area: HTMLElement,
  chat: Chat,
): void {
  if (!isOrchestratePlanScreenSuspendedForChat(chat)) {
    removeOrchestratePlanScreenSuspendedBanner();
    return;
  }
  removeOrchestratePlanScreenSuspendedBanner();
  const host = resolvePlanScreenBannerHost(area);
  const banner = document.createElement('div');
  banner.id = ORCHESTRATE_PLAN_BANNER_ID;
  banner.className = 'orchestrate-plan-screen-banner';
  banner.setAttribute('role', 'status');

  const session = getOrchestratePlanScreenSession();
  const text = document.createElement('p');
  text.className = 'orchestrate-plan-screen-banner__text';
  text.textContent = suspendedPlanBannerText(session, chat);

  const actions = document.createElement('div');
  actions.className = 'orchestrate-plan-screen-banner__actions';

  const resumeBtn = document.createElement('button');
  resumeBtn.type = 'button';
  resumeBtn.className = 'orchestrate-plan-screen-banner__resume';
  resumeBtn.textContent = 'Return to planning screen';
  resumeBtn.addEventListener('click', () => {
    void (async () => {
      if (!planSession || planSession.chatId !== chat.id) return;
      const session = planSession;
      let previewMarkdown: string | undefined;
      if (
        (session.phase === 'preview' || session.phase === 'spec_confirm') &&
        session.planPath
      ) {
        previewMarkdown = await readPlanArtifactMarkdown(session.planPath);
      }
      session.planScreenSuspended = false;
      renderOrchestratePlanScreen({
        phase: session.phase,
        chatId: session.chatId,
        planPath: session.planPath,
        savedPrompt: session.savedPrompt,
        errorMessage: session.errorMessage,
        previewMarkdown,
      });
      const afterPaint =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn: () => void) => {
              fn();
              return 0;
            };
      afterPaint(() => {
        if (isAskQuestionModalOpenForChat(session.chatId)) {
          const planHost = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
          if (planHost) {
            migrateActiveQuestionModalToHost(planHost);
            planHost.hidden = false;
          }
        }
      });
    })();
  });

  actions.append(resumeBtn);
  banner.append(text, actions);
  host.appendChild(banner);
}
