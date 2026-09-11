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
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
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
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import type { Chat } from '../types';
import {
  buildHistoryUserContent,
  runChatTurn,
} from '../chat/messaging';
import { detectLocalServer } from '../tools/client';
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
import { createChatWithMode, switchChat } from './sidebar';
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
  buildPlanPreviewPopoutDom,
  prefersReducedMotion,
  regularPlanWorkingStepFromChat,
} from './plan-progress-screen';
import { isSuperPlanPageMounted, teardownSuperPlanPage } from './super-plan-page';
import { isSuperPlanChromeActive, syncSuperPlanChrome } from './super-plan-chrome';

import { isReusableEmptyPlanChat } from '../chat/super-plan/spare-chat';
import { isChatInCurrentWorkspace } from '../chat/super-plan/plan-library';
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

/** Regular Plan mode only; Super Plan has its own surface (`super-plan-entry.ts`). */
export type OrchestratePlanScreenPhase =
  | 'prompt'
  | 'working'
  | 'questions'
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
  /** Plan markdown for the preview phase. */
  previewMarkdown?: string;
  /** When true, keep the overlay torn down and only update session (banner resume sets false). */
  planScreenSuspended?: boolean;
}

let planSession: OrchestratePlanScreenSession | null = null;
let streamEndUnsubscribe: (() => void) | null = null;
let activityUnsubscribe: (() => void) | null = null;
let planProgressPanel: PlanProgressPanel | null = null;

// ── Session ──────────────────────────────────────────────────────────────────

function ensureStreamEndListener(): void {
  if (streamEndUnsubscribe) return;
  streamEndUnsubscribe = subscribeChatStreamEnd((chatId) => {
    void onPlanSessionStreamEnd(chatId);
  });
}

/** True when the Plan-mode authoring screen is in #chatArea. */
export function isOrchestratePlanScreenMounted(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID));
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
  if (planSession.phase === 'questions' || planSession.phase === 'working') {
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
  document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID)?.remove();
  // Callers use this to clear #chatArea of every planning surface, Super Plan included.
  teardownSuperPlanPage();
  document
    .getElementById('chatArea')
    ?.classList.remove(CHAT_AREA_PLAN_SCREEN_CLASS, CHAT_AREA_SUPER_PLAN_CLASS);
  document.getElementById('mainColumn')?.classList.remove(MAIN_COLUMN_PLAN_SCREEN_CLASS);
  if (isSuperPlanChromeActive()) syncSuperPlanChrome(false);
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
  return session.phase === 'working' || session.phase === 'questions';
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
  if (session.phase !== 'working' && session.phase !== 'questions') {
    return null;
  }
  if (session.phase === 'working') {
    session.phase = 'questions';
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

// ── Working phase ────────────────────────────────────────────────────────────

function mountPlanProgressPanel(chat: Chat): void {
  const mount = document.getElementById(PLAN_PROGRESS_MOUNT_ID);
  if (!mount) return;
  planProgressPanel?.destroy();
  planProgressPanel = new PlanProgressPanel(mount, { reducedMotion: prefersReducedMotion() });
  planProgressPanel.reset();
  syncPlanProgressFromChat(chat);
}

function syncPlanProgressFromChat(chat: Chat): void {
  if (!planProgressPanel) return;
  const activity = getMainTurnActivity(chat.id);
  const step = regularPlanWorkingStepFromChat(
    chat,
    activity?.phase ?? null,
    activity?.currentTool ?? undefined,
  );
  planProgressPanel.applyRegularPlanStep(step);
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

function findReusableEmptyPlanChat(excludeChatId?: string): Chat | null {
  if (!sessionState) return null;
  const hit = sessionState.chats.find((c) => {
    if (excludeChatId && c.id === excludeChatId) return false;
    if (!isReusableEmptyPlanChat(c, 'plan')) return false;
    if (!chatMatchesOpenWorkspace(c)) return false;
    if (isChatStreaming(c.id)) return false;
    return true;
  });
  return hit ?? null;
}

function resolveOrCreatePlanChat(excludeChatId?: string): Chat {
  const targetMode = 'plan';
  const active = getActiveChat();
  const activeIsSpare =
    (!excludeChatId || active.id !== excludeChatId) &&
    isReusableEmptyPlanChat(active, targetMode) &&
    chatMatchesOpenWorkspace(active) &&
    !isChatStreaming(active.id);
  if (activeIsSpare) {
    setChatMode(targetMode);
    return active;
  }
  const reusable = findReusableEmptyPlanChat(excludeChatId);
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

async function onPlanSessionStreamEnd(chatId: string): Promise<void> {
  const session = planSession;
  if (!session || session.chatId !== chatId) return;
  if (session.phase !== 'working' && session.phase !== 'questions') {
    return;
  }

  const chat = findChatById(chatId);
  if (!chat) return;

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

// ── Start planning ───────────────────────────────────────────────────────────

async function startPlanningFromPrompt(
  promptText: string,
  options?: StartPlanningFromPromptOptions,
): Promise<void> {
  teardownOrchestrateHub();
  const chat = options?.useActiveChat ? getActiveChat() : resolveOrCreatePlanChat();

  ensureStreamEndListener();

  planSession = {
    chatId: chat.id,
    phase: 'working',
    savedPrompt: promptText,
    planScreenSuspended: false,
  };

  renderOrchestratePlanScreen({
    phase: 'working',
    chatId: chat.id,
    savedPrompt: promptText,
  });

  const historyContent = buildHistoryUserContent(promptText, []);

  await detectLocalServer();
  await runChatTurn({
    chat,
    pushUser: true,
    rawText: promptText,
    userText: promptText,
    skillId: null,
    displayText: promptText,
    historyContent,
    validAttachments: [],
    titleSeed: promptText,
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
): void {
  appendPlanScreenHeader(
    inner,
    'Orchestrate',
    'Planning in progress',
    'Status updates here. Answer any questions below, or open the chat to inspect tool calls.',
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

  const actionsEnd = document.createElement('div');
  actionsEnd.className = 'orchestrate-plan-screen__actions-start';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'orchestrate-plan-screen__btn orchestrate-plan-screen__btn--danger';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => {
    stopGeneration(opts.chatId);
  });
  actionsEnd.appendChild(stopBtn);

  actionsStart.append(viewChatBtn);
  actions.append(actionsStart, actionsEnd);
  inner.append(progressMount, questionsHost, actions);

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

function buildPlanScreenDom(opts: RenderOrchestratePlanScreenOptions): HTMLElement {
  const root = document.createElement('div');
  root.id = ORCHESTRATE_PLAN_SCREEN_ROOT_ID;
  root.className = 'orchestrate-plan-screen';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Orchestrate plan authoring');

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
  } else if (opts.phase === 'working' || opts.phase === 'questions') {
    appendWorkingPhaseContent(inner, opts);
  } else if (opts.phase === 'preview') {
    const planPath = opts.planPath?.trim() ?? '';
    appendPlanScreenHeader(
      inner,
      'Orchestrate',
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
      modeId: 'plan',
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
    appendPlanScreenHeader(
      inner,
      'Orchestrate',
      'Planning stopped',
      'The run ended without a saved plan file. Retry or open the chat to see what happened.',
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
    inner.append(err, actions);
  }

  root.appendChild(inner);
  return root;
}

/** Drop progress/activity mounts before rebuilding the plan screen DOM. */
function resetPlanScreenDomMounts(): void {
  activityUnsubscribe?.();
  activityUnsubscribe = null;
  planProgressPanel?.destroy();
  planProgressPanel = null;
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Paint plan screen into #chatArea for the given phase. */
export function renderOrchestratePlanScreen(
  opts: RenderOrchestratePlanScreenOptions,
): void {
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
  // Plan mode and the Super Plan surface both live in #chatArea; only one at a time.
  if (isSuperPlanPageMounted()) {
    teardownSuperPlanPage();
    area.classList.remove(CHAT_AREA_SUPER_PLAN_CLASS);
    syncSuperPlanChrome(false);
  }

  area.replaceChildren();
  area.appendChild(buildPlanScreenDom(opts));
  area.classList.add(CHAT_AREA_PLAN_SCREEN_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_PLAN_SCREEN_CLASS);
  document.getElementById('mainColumn')?.classList.remove('main-column--board-view');

  if (opts.phase === 'working' || opts.phase === 'questions') {
    wirePlanScreenActivityListener(opts.chatId);
  }
  notifyAskQuestionDisplayContextChanged();
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

/** Banner copy for a suspended plan session. */
function suspendedPlanBannerText(session: OrchestratePlanScreenSession | null): string {
  if (session?.phase === 'preview') {
    return 'Your plan is ready. Return to the planning screen to review it.';
  }
  if (session?.phase === 'error') {
    return 'Planning stopped with an error. Return to the planning screen to retry.';
  }
  if (session?.phase === 'questions') {
    return 'Answer the questions below or return to the planning screen to continue.';
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
  text.textContent = suspendedPlanBannerText(session);

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
        session.phase === 'preview' &&
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
