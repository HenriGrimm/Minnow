import { getChatAbort } from '../app-state';
import { resolveIssueChatQuestionHost } from '../chat/issue-chat-host';
import { resolveHomeQuestionHost } from '../home/question-host';
import {
  isAskQuestionDomVisible,
  notifyAskQuestionDisplayContextChanged,
} from '../chat/ask-question-display';
import { registerAskQuestionDisplayContextSync } from '../chat/ask-question-display-sync';
import { isActiveChatStreaming } from '../chat/streaming-state';
import { notifyAskQuestionFinished, notifyAskQuestionShown } from '../notifications/ask-question';
import { getActiveChat } from '../state/sessions';
import {
  ASK_QUESTION_OTHER_ID,
  isAskQuestionMultiSelect,
  normalizeAskQuestionItem,
  stringifyAskQuestionResult,
  type AskQuestionArgs,
  type AskQuestionItem,
  type AskQuestionToolResult,
} from '../tools/ask-question-types';
import { iconHtml } from './icon';
import {
  areAllDraftsValid,
  buildAnswerEntries,
  isDraftValidForQuestion,
  type AskQuestionAnswerDraft,
} from './question-cards-state';
import { getActiveComposerSurface } from './composer-surface';
import { setComposerStreamingMode } from './composer-send';
import {
  addSidebarInputPendingChatId,
  removeSidebarInputPendingChatId,
} from './chat-item-dot';
import { resolveOrchestratePlanScreenQuestionHost } from './orchestrate-plan-screen';
import { resolveBoardOnboardingQuestionHost } from './orchestrate-board-onboarding-questions';
import { resolvePromptComposerShell, resolveQuestionHost } from './prompt-host-resolve';
import {
  acquireUserPromptLock,
  isUserPromptLocked,
  releaseUserPromptLock,
} from './user-prompt-lock';

export interface QuestionCardsModalContext {
  subAgentType?: string;
}

export interface QuestionCardsModalOptions {
  /** When set, render inside this element instead of #questionHost. */
  host?: HTMLElement;
  /** Skip global composer lock and main-column pending class (plan screen embed). */
  embedded?: boolean;
  /** Plan-screen / tool-loop chat id (resolves embedded host when host omitted). */
  chatId?: string;
}

type ActiveQuestionModalState = {
  host: HTMLElement;
  chatId: string;
  embedded: boolean;
  parked: boolean;
  composerShell: HTMLElement | null;
  msgInput: HTMLTextAreaElement | null;
  sendBtn: HTMLButtonElement | null;
  prevInputDisabled: boolean;
  prevSendDisabled: boolean;
  /** Live panel node; parked instances keep this off the shared host. */
  panel: HTMLElement;
  /** Off-DOM holder so another chat's mount cannot destroy this strip. */
  stash: DocumentFragment;
  cancel: () => void;
};

/** One pending strip per chat; only the foreground chat's panel sits in the shared host. */
const modalsByChatId = new Map<string, ActiveQuestionModalState>();

const PLAN_SCREEN_QUESTIONS_HOST_ID = 'orchestratePlanScreenQuestions';
const BOARD_ONBOARDING_QUESTIONS_HOST_ID = 'boardOnboardingQuestions';
const ONBOARDING_GUIDE_QUESTIONS_HOST_ID = 'onboardingGuideQuestions';

const EMBEDDED_QUESTIONS_HOST_IDS = new Set([
  'homeFlowQuestions',
  PLAN_SCREEN_QUESTIONS_HOST_ID,
  BOARD_ONBOARDING_QUESTIONS_HOST_ID,
  ONBOARDING_GUIDE_QUESTIONS_HOST_ID,
]);

/** Pause after a single-choice pick so the selection is visible before the card flips. */
const AUTO_ADVANCE_DELAY_MS = 220;

/** Longest option label that still reads well as a chip. */
const CHIP_LABEL_MAX = 24;

type QuestionCard = {
  root: HTMLElement;
  promptId: string;
  rows: HTMLLabelElement[];
  inputs: HTMLInputElement[];
  otherRow: HTMLElement;
  otherInput: HTMLInputElement;
};

/** Short, undescribed options lay out as a row of chips instead of a list. */
function prefersChipLayout(q: AskQuestionItem): boolean {
  return (
    q.options.length > 0 &&
    q.options.length <= 6 &&
    q.options.every((o) => !o.description && o.label.length <= CHIP_LABEL_MAX)
  );
}

function getActiveHTMLElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!active || typeof (active as HTMLElement).focus !== 'function') return null;
  return active as HTMLElement;
}

function isEmbeddedQuestionsHost(host: HTMLElement): boolean {
  return EMBEDDED_QUESTIONS_HOST_IDS.has(host.id);
}

export function isAskQuestionModalOpenForChat(chatId: string): boolean {
  return modalsByChatId.has(chatId.trim());
}

/** True when the open strip is embedded in the Super Plan / plan screen host. */
export function isAskQuestionModalOnPlanScreenHost(): boolean {
  for (const state of modalsByChatId.values()) {
    if (
      !state.parked &&
      state.embedded &&
      state.host.id === PLAN_SCREEN_QUESTIONS_HOST_ID
    ) {
      return true;
    }
  }
  return false;
}

function activateComposerQuestionChrome(state: ActiveQuestionModalState): void {
  state.embedded = false;
  state.parked = false;
  acquireUserPromptLock();
  state.composerShell?.classList.add('main-column--question-pending');
  addSidebarInputPendingChatId(state.chatId);
  state.panel.classList.remove('question-cards-panel--embedded');
  const surfaceClass = resolveQuestionPanelSurfaceClass(state.host);
  if (surfaceClass) {
    state.panel.classList.add(surfaceClass);
  }
  state.host.hidden = false;
}

function restoreComposerAfterQuestion(
  state: ActiveQuestionModalState,
  focusOverride?: HTMLElement | null,
  options?: { suppressFocus?: boolean },
): void {
  state.composerShell?.classList.remove('main-column--question-pending');
  if (!state.host.hasChildNodes()) {
    state.host.hidden = true;
  }
  releaseUserPromptLock();
  if (!isUserPromptLocked()) {
    if (state.msgInput) {
      state.msgInput.disabled = isActiveChatStreaming()
        ? false
        : state.prevInputDisabled;
    }
    if (state.sendBtn) {
      if (isActiveChatStreaming()) {
        setComposerStreamingMode('streaming');
      } else {
        state.sendBtn.disabled = state.prevSendDisabled;
      }
    }
    if (!options?.suppressFocus) {
      const focusTarget =
        focusOverride?.isConnected ? focusOverride : state.msgInput;
      focusTarget?.focus();
    }
  }
}

function deactivateComposerQuestionChrome(
  state: ActiveQuestionModalState,
  focusOverride?: HTMLElement | null,
  options?: { suppressFocus?: boolean },
): void {
  restoreComposerAfterQuestion(state, focusOverride, options);
  removeSidebarInputPendingChatId(state.chatId);
}

function activateEmbeddedQuestionChrome(state: ActiveQuestionModalState): void {
  state.embedded = true;
  state.parked = false;
  state.composerShell?.classList.remove('main-column--question-pending');
  addSidebarInputPendingChatId(state.chatId);
  releaseUserPromptLock();
  state.panel.classList.add('question-cards-panel--embedded');
  state.panel.classList.remove(
    'question-cards-panel--os-dock',
    'question-cards-panel--chat-app',
  );
  state.host.hidden = false;
}

/** True when key/focus handlers should act on this strip (not a parked sibling). */
function isModalForeground(state: ActiveQuestionModalState): boolean {
  if (state.parked) return false;
  if (!state.panel.isConnected) return false;
  if (state.host.hidden) return false;
  return state.host.contains(state.panel);
}

function parkOthersOnHost(host: HTMLElement, except?: ActiveQuestionModalState): void {
  for (const other of modalsByChatId.values()) {
    if (other === except) continue;
    if (other.panel.parentNode === host || (!other.parked && other.host === host)) {
      parkQuestionModal(other);
    }
  }
}

function attachPanelToHost(state: ActiveQuestionModalState, newHost: HTMLElement): void {
  parkOthersOnHost(newHost, state);
  if (state.panel.parentNode !== newHost) {
    newHost.appendChild(state.panel);
  }
  newHost.hidden = false;
  const prevHost = state.host;
  if (prevHost !== newHost && !prevHost.hasChildNodes() && isEmbeddedQuestionsHost(prevHost)) {
    prevHost.hidden = true;
  }
  state.host = newHost;
  state.parked = false;
}

function parkQuestionModal(state: ActiveQuestionModalState): void {
  if (state.parked) return;
  state.parked = true;
  // Detach only from the shared composer host so another chat can mount there.
  // Dedicated plan/board hosts keep their panel; hiding is enough.
  if (!isEmbeddedQuestionsHost(state.host) && state.panel.parentNode === state.host) {
    state.stash.appendChild(state.panel);
  }
  if (!state.host.hasChildNodes() || isEmbeddedQuestionsHost(state.host)) {
    state.host.hidden = true;
  }
  if (!state.embedded) {
    restoreComposerAfterQuestion(state, null, { suppressFocus: true });
  }
  addSidebarInputPendingChatId(state.chatId);
}

function unparkQuestionModal(state: ActiveQuestionModalState): void {
  if (!state.parked) return;
  if (!isAskQuestionDomVisible(state.chatId)) return;

  const homeHost = resolveHomeQuestionHost(state.chatId);
  if (homeHost) {
    attachPanelToHost(state, homeHost);
    activateEmbeddedQuestionChrome(state);
    return;
  }

  const planHost = resolveIssueChatQuestionHost(state.chatId) ?? resolveOrchestratePlanScreenQuestionHost(state.chatId);
  if (planHost) {
    attachPanelToHost(state, planHost);
    activateEmbeddedQuestionChrome(state);
    return;
  }

  const boardHost = resolveBoardOnboardingQuestionHost(state.chatId);
  if (boardHost) {
    attachPanelToHost(state, boardHost);
    activateEmbeddedQuestionChrome(state);
    return;
  }

  const host = resolveQuestionHost();
  if (!host) return;
  attachPanelToHost(state, host);
  state.composerShell = resolvePromptComposerShell();
  const surface = getActiveComposerSurface();
  state.msgInput = surface.inputEl;
  state.sendBtn = surface.sendBtnEl;
  activateComposerQuestionChrome(state);
}

/** Hide the strip when leaving the owning chat; restore when returning. */
export function syncAskQuestionModalOnChatSwitch(
  fromChatId: string | null | undefined,
  toChatId: string,
): void {
  if (fromChatId && fromChatId !== toChatId) {
    const leaving = modalsByChatId.get(fromChatId);
    if (leaving && !leaving.parked) parkQuestionModal(leaving);
  }
  const arriving = modalsByChatId.get(toChatId);
  if (arriving?.parked) unparkQuestionModal(arriving);
}

/** Park or restore strips when the foreground app or overlay changes. */
export function syncAskQuestionModalOnDisplayContextChange(): void {
  for (const state of modalsByChatId.values()) {
    if (!isAskQuestionDomVisible(state.chatId) && !state.parked) {
      if (
        state.embedded &&
        state.host.id !== 'homeFlowQuestions' &&
        isEmbeddedQuestionsHost(state.host) &&
        state.host.isConnected
      ) {
        continue;
      }
      parkQuestionModal(state);
    }
  }
  for (const state of modalsByChatId.values()) {
    if (isAskQuestionDomVisible(state.chatId) && state.parked) {
      unparkQuestionModal(state);
    }
  }
}

function migrateQuestionModalToHost(
  state: ActiveQuestionModalState,
  newHost: HTMLElement,
): boolean {
  if (state.host === newHost && state.panel.parentNode === newHost) {
    newHost.hidden = false;
    state.parked = false;
    return true;
  }

  const prevHost = state.host;
  attachPanelToHost(state, newHost);

  if (state.embedded && !isEmbeddedQuestionsHost(newHost)) {
    activateComposerQuestionChrome(state);
  } else if (!state.embedded && isEmbeddedQuestionsHost(newHost)) {
    activateEmbeddedQuestionChrome(state);
  }

  if (isEmbeddedQuestionsHost(prevHost) && !prevHost.hasChildNodes()) {
    prevHost.hidden = true;
  }

  return true;
}

function resolveModalForMigrate(): ActiveQuestionModalState | undefined {
  const unparked = [...modalsByChatId.values()].filter((m) => !m.parked);
  if (unparked.length === 1) return unparked[0];
  if (unparked.length > 1) {
    return unparked.find((m) => m.panel.isConnected) ?? unparked[0];
  }
  return [...modalsByChatId.values()].find((m) => m.panel.isConnected);
}

/** Move a question strip to another host (plan screen ↔ composer) without cancelling. */
export function migrateActiveQuestionModalToHost(newHost: HTMLElement): boolean {
  const state = resolveModalForMigrate();
  if (!state) return false;
  return migrateQuestionModalToHost(state, newHost);
}

export function forceCloseAskQuestionModalForChat(chatId?: string): void {
  const trimmed = chatId?.trim();
  if (!trimmed) {
    forceCloseAskQuestionModal();
    return;
  }
  modalsByChatId.get(trimmed)?.cancel();
}

/** Close every pending strip (Stop all activity). */
export function forceCloseAskQuestionModal(): void {
  for (const state of [...modalsByChatId.values()]) {
    state.cancel();
  }
}

export function resetQuestionCardsModalForTests(): void {
  forceCloseAskQuestionModal();
  modalsByChatId.clear();
}

function getQuestionHost(): HTMLElement | null {
  return resolveQuestionHost();
}

function getQuestionComposerShell(): HTMLElement | null {
  return resolvePromptComposerShell();
}

/** Surface-specific panel class for dock / chat-app / code bench styling. */
function resolveQuestionPanelSurfaceClass(host: HTMLElement): string {
  if (host.id === 'desktopQuestionHost' || host.closest('.mn-os-composer-dock')) {
    return 'question-cards-panel--os-dock';
  }
  if (host.id === 'chatAppQuestionHost' || host.closest('.chat-app-composer')) {
    return 'question-cards-panel--chat-app';
  }
  return '';
}

function getOrCreateDraft(
  drafts: Map<string, AskQuestionAnswerDraft>,
  questionId: string,
): AskQuestionAnswerDraft {
  let d = drafts.get(questionId);
  if (!d) {
    d = { selectedIds: [], otherText: '' };
    drafts.set(questionId, d);
  }
  return d;
}

/**
 * Shows the question strip and resolves with structured JSON (answered or cancelled).
 * If the owning chat is not the visible surface, the panel is created parked (off-DOM)
 * so another chat's strip can occupy the shared host without mixing questions.
 */
export function showQuestionCardsModal(
  args: AskQuestionArgs,
  context: QuestionCardsModalContext = {},
  options: QuestionCardsModalOptions = {},
): Promise<AskQuestionToolResult> {
  return new Promise((resolve) => {
    const chatIdForAbort = options.chatId?.trim() || getActiveChat().id;

    let embedded = options.embedded === true;
    let host = options.host;
    const homeHost = resolveHomeQuestionHost(chatIdForAbort);
    if (!host && homeHost) { host = homeHost; embedded = true; }
    if (!host && options.chatId) {
      const planHost = resolveIssueChatQuestionHost(options.chatId) ?? resolveOrchestratePlanScreenQuestionHost(options.chatId);
      if (planHost) {
        host = planHost;
        embedded = true;
      } else {
        const boardHost = resolveBoardOnboardingQuestionHost(options.chatId);
        if (boardHost) {
          host = boardHost;
          embedded = true;
        }
      }
    }
    // Dedicated embed hosts (plan/board) mount immediately. Composer host only
    // when this chat is the visible surface — otherwise park off-DOM.
    const shouldShowNow =
      isAskQuestionDomVisible(chatIdForAbort) || (embedded && Boolean(host));
    if (!host && shouldShowNow) {
      host = getQuestionHost() ?? undefined;
    }
    if (!host) {
      host = document.createElement('div');
      host.className = 'question-host';
      host.hidden = true;
    }

    const composerShell = getQuestionComposerShell();
    const { inputEl: msgInput, sendBtnEl: sendBtn } = getActiveComposerSurface();
    const prevInputDisabled = msgInput?.disabled ?? false;
    const prevSendDisabled = sendBtn?.disabled ?? false;
    const stash = document.createDocumentFragment();

    if (shouldShowNow) {
      parkOthersOnHost(host);
      if (!embedded) {
        acquireUserPromptLock();
        composerShell?.classList.add('main-column--question-pending');
      }
      addSidebarInputPendingChatId(chatIdForAbort);
      host.hidden = false;
    } else {
      addSidebarInputPendingChatId(chatIdForAbort);
    }

    const drafts = new Map<string, AskQuestionAnswerDraft>();
    let cardIndex = 0;
    const questions = args.questions.map((q) => normalizeAskQuestionItem(q));

    const surfaceClass = resolveQuestionPanelSurfaceClass(host);
    const panelClasses = ['question-cards-panel'];
    if (embedded) panelClasses.push('question-cards-panel--embedded');
    if (surfaceClass) panelClasses.push(surfaceClass);

    const panel = document.createElement('div');
    panel.className = panelClasses.join(' ');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', args.title?.trim() || 'Assistant questions');
    panel.tabIndex = -1;

    const previousFocus = getActiveHTMLElement();

    const multiQuestion = questions.length > 1;

    const header = document.createElement('div');
    header.className = 'question-cards-panel__header';

    // One tab per question; an answered tab shows its answer instead of the prompt.
    const tabs = document.createElement('div');
    tabs.className = 'question-cards-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Questions');
    const tabButtons = questions.map((q, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'question-cards-tab';
      tab.setAttribute('role', 'tab');
      tab.title = q.prompt;
      tab.addEventListener('click', () => goToCard(i));
      tabs.appendChild(tab);
      return tab;
    });

    if (multiQuestion) {
      header.appendChild(tabs);
    } else if (args.title) {
      const eyebrow = document.createElement('p');
      eyebrow.className = 'question-cards-panel__eyebrow';
      eyebrow.textContent = args.title;
      header.appendChild(eyebrow);
    }

    const headerActions = document.createElement('div');
    headerActions.className = 'question-cards-panel__header-actions';

    if (context.subAgentType) {
      const badge = document.createElement('span');
      badge.className = 'question-cards-badge';
      badge.textContent = `Sub-agent · ${context.subAgentType}`;
      headerActions.appendChild(badge);
    }

    const btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'question-cards-icon-btn';
    btnClose.setAttribute('aria-label', 'Close and cancel questions');
    btnClose.title = 'Cancel (Esc)';
    btnClose.innerHTML = iconHtml('close');
    headerActions.appendChild(btnClose);

    header.appendChild(headerActions);
    // A lone close button floats beside the prompt instead of taking a row of its own.
    if (!header.querySelector('.question-cards-tabs, .question-cards-panel__eyebrow, .question-cards-badge')) {
      header.classList.add('question-cards-panel__header--floating');
    }

    const cardBody = document.createElement('div');
    cardBody.className = 'question-cards-panel__body';
    const cards = questions.map((q, i) => buildCard(q, i));
    for (const card of cards) cardBody.appendChild(card.root);

    const footer = document.createElement('div');
    footer.className = 'question-cards-panel__footer';

    const hints = document.createElement('p');
    hints.className = 'question-cards-hints';

    const validation = document.createElement('p');
    validation.className = 'question-cards-validation';
    validation.setAttribute('role', 'status');
    validation.setAttribute('aria-live', 'polite');
    validation.hidden = true;

    const btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.className = 'question-cards-next';
    btnNext.textContent = 'Next';

    const btnSubmit = document.createElement('button');
    btnSubmit.type = 'button';
    btnSubmit.className = 'question-cards-submit';

    footer.append(hints, validation, btnNext, btnSubmit);
    panel.append(header, cardBody, footer);

    const modalState: ActiveQuestionModalState = {
      host,
      chatId: chatIdForAbort,
      embedded,
      parked: !shouldShowNow,
      composerShell,
      msgInput,
      sendBtn,
      prevInputDisabled,
      prevSendDisabled,
      panel,
      stash,
      cancel: () => {},
    };

    if (shouldShowNow) {
      host.appendChild(panel);
    } else {
      stash.appendChild(panel);
    }
    modalsByChatId.set(chatIdForAbort, modalState);
    notifyAskQuestionDisplayContextChanged();

    let settled = false;
    let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: AskQuestionToolResult): void => {
      if (settled) return;
      settled = true;
      notifyAskQuestionFinished(chatIdForAbort, args);
      cancelAutoAdvance();
      document.removeEventListener('keydown', onDocKeyDown, true);
      if (abortListener) {
        getChatAbort(chatIdForAbort)?.signal.removeEventListener('abort', abortListener);
      }
      const modal = modalsByChatId.get(chatIdForAbort);
      const ownedFocus = panel.contains(document.activeElement);
      modalsByChatId.delete(chatIdForAbort);
      if (modal?.panel.parentNode) {
        modal.panel.remove();
      }
      if (modal && !modal.embedded && !modal.parked) {
        deactivateComposerQuestionChrome(modal, previousFocus, { suppressFocus: !ownedFocus });
      } else {
        removeSidebarInputPendingChatId(chatIdForAbort);
        if (ownedFocus && previousFocus?.isConnected && modal && !modal.parked) {
          previousFocus.focus();
        }
      }
      if (modal?.host && !modal.host.hasChildNodes()) {
        modal.host.hidden = true;
      }
      notifyAskQuestionDisplayContextChanged();
      resolve(result);
    };

    modalState.cancel = () => finish({ status: 'cancelled', answers: [] });

    const abortListener = (): void => {
      finish({ status: 'cancelled', answers: [] });
    };
    const abortSignal = getChatAbort(chatIdForAbort)?.signal;
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener('abort', abortListener, { once: true });
    }

    function cancelAutoAdvance(): void {
      if (autoAdvanceTimer !== null) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
    }

    function keyHint(n: number): HTMLElement {
      const kbd = document.createElement('kbd');
      kbd.className = 'question-cards-key';
      kbd.setAttribute('aria-hidden', 'true');
      kbd.textContent = n <= 9 ? String(n) : '';
      return kbd;
    }

    /**
     * Builds one question once. Selection changes only toggle classes and
     * `checked` (see {@link syncSelection}), so nothing re-renders under the pointer.
     */
    function buildCard(q: AskQuestionItem, index: number): QuestionCard {
      const multi = isAskQuestionMultiSelect(q);
      const root = document.createElement('section');
      root.className = 'question-cards-card';

      const promptId = `question-cards-prompt-${index}-${q.id}`;
      const promptEl = document.createElement('h2');
      promptEl.className = 'question-cards-prompt';
      promptEl.id = promptId;
      promptEl.textContent = q.prompt;

      const list = document.createElement('div');
      list.className = prefersChipLayout(q)
        ? 'question-cards-options question-cards-options--chips'
        : 'question-cards-options';
      list.setAttribute('role', multi ? 'group' : 'radiogroup');
      list.setAttribute('aria-labelledby', promptId);

      const groupName = `ask-q-${index}-${q.id}`;
      const rows: HTMLLabelElement[] = [];
      const inputs: HTMLInputElement[] = [];
      q.options.forEach((opt, i) => {
        const row = document.createElement('label');
        row.className = 'question-cards-option';
        const input = document.createElement('input');
        input.type = multi ? 'checkbox' : 'radio';
        if (!multi) input.name = groupName;
        input.value = opt.id;
        input.addEventListener('change', () => toggleOption(q, opt.id, input.checked));
        const label = document.createElement('span');
        label.className = 'question-cards-option-label';
        label.textContent = opt.label;
        row.append(input, keyHint(i + 1), label);
        if (opt.description) {
          const desc = document.createElement('span');
          desc.className = 'question-cards-option-desc';
          desc.textContent = opt.description;
          row.appendChild(desc);
        }
        list.appendChild(row);
        rows.push(row);
        inputs.push(input);
      });

      // "Other" is a text field in the list itself: typing selects it.
      const otherRow = document.createElement('div');
      otherRow.className = 'question-cards-option question-cards-option--other';
      const otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.className = 'question-cards-other-input';
      otherInput.placeholder = 'Something else…';
      otherInput.setAttribute('aria-label', 'Other answer');
      otherInput.addEventListener('input', () => setOtherText(q, otherInput.value));
      otherRow.append(keyHint(q.options.length + 1), otherInput);
      otherRow.addEventListener('click', (ev) => {
        if (ev.target !== otherInput) otherInput.focus();
      });
      list.appendChild(otherRow);

      root.append(promptEl, list);
      return { root, promptId, rows, inputs, otherRow, otherInput };
    }

    function toggleOption(q: AskQuestionItem, optionId: string, checked: boolean): void {
      const d = getOrCreateDraft(drafts, q.id);
      d.otherText = '';
      if (isAskQuestionMultiSelect(q)) {
        const kept = d.selectedIds.filter((id) => id !== optionId && id !== ASK_QUESTION_OTHER_ID);
        d.selectedIds = checked ? [...kept, optionId] : kept;
        syncSelection();
        return;
      }
      d.selectedIds = [optionId];
      syncSelection();
      advanceAfterSingleSelect();
    }

    function setOtherText(q: AskQuestionItem, text: string): void {
      cancelAutoAdvance();
      const d = getOrCreateDraft(drafts, q.id);
      d.otherText = text;
      if (text.trim()) {
        d.selectedIds = [ASK_QUESTION_OTHER_ID];
      } else if (d.selectedIds.includes(ASK_QUESTION_OTHER_ID)) {
        d.selectedIds = [];
      }
      syncSelection();
    }

    function summarizeDraft(q: AskQuestionItem): string {
      const d = drafts.get(q.id);
      if (!d || !isDraftValidForQuestion(q, d)) return '';
      if (d.selectedIds.includes(ASK_QUESTION_OTHER_ID)) return d.otherText.trim();
      return d.selectedIds
        .map((id) => q.options.find((o) => o.id === id)?.label ?? id)
        .join(', ');
    }

    function syncSelection(): void {
      questions.forEach((q, i) => {
        const card = cards[i];
        const picked = drafts.get(q.id)?.selectedIds ?? [];
        q.options.forEach((opt, j) => {
          const on = picked.includes(opt.id);
          card.inputs[j].checked = on;
          card.rows[j].classList.toggle('question-cards-option--selected', on);
        });
        const otherOn = picked.includes(ASK_QUESTION_OTHER_ID);
        card.otherRow.classList.toggle('question-cards-option--selected', otherOn);
        if (!otherOn && card.otherInput.value && document.activeElement !== card.otherInput) {
          card.otherInput.value = '';
        }

        const tab = tabButtons[i];
        const answer = summarizeDraft(q);
        const current = i === cardIndex;
        tab.textContent = answer || q.prompt;
        tab.classList.toggle('question-cards-tab--answered', Boolean(answer));
        tab.classList.toggle('question-cards-tab--current', current);
        tab.setAttribute('aria-selected', String(current));
        tab.tabIndex = current ? 0 : -1;
      });
      syncFooter();
    }

    function syncFooter(): void {
      const q = questions[cardIndex];
      const multiSelect = isAskQuestionMultiSelect(q);
      const onLast = cardIndex === questions.length - 1;
      btnNext.hidden = onLast;
      btnSubmit.hidden = !onLast;
      btnSubmit.textContent = multiQuestion ? 'Send answers' : 'Continue';
      const keys = Math.min(9, q.options.length + 1);
      const parts = [
        multiSelect ? `1–${keys} to toggle · Enter to continue` : `1–${keys} to pick`,
      ];
      if (multiQuestion) parts.push('←→ to switch');
      parts.push('Esc to cancel');
      hints.textContent = parts.join(' · ');
      validation.hidden = true;
      hints.hidden = false;
    }

    function showValidation(message: string): void {
      validation.textContent = message;
      validation.hidden = false;
      hints.hidden = true;
    }

    function showCard(): void {
      cards.forEach((card, i) => {
        const current = i === cardIndex;
        card.root.classList.toggle('question-cards-card--current', current);
        card.root.toggleAttribute('inert', !current);
        card.root.setAttribute('aria-hidden', String(!current));
      });
      panel.setAttribute('aria-labelledby', cards[cardIndex].promptId);
      syncSelection();
    }

    /** Focus the picked option on the current card, else its first option. */
    function focusCardControl(): void {
      const card = cards[cardIndex];
      const picked = card.inputs.find((input) => input.checked);
      if (picked) {
        picked.focus();
      } else if (card.otherRow.classList.contains('question-cards-option--selected')) {
        card.otherInput.focus();
      } else {
        (card.inputs[0] ?? card.otherInput).focus();
      }
    }

    function goToCard(next: number): void {
      if (next < 0 || next >= questions.length || next === cardIndex) return;
      cancelAutoAdvance();
      const keepFocus = panel.contains(document.activeElement);
      cardIndex = next;
      showCard();
      if (keepFocus) focusCardControl();
    }

    function submitAnswers(): void {
      cancelAutoAdvance();
      if (!areAllDraftsValid(questions, drafts)) {
        const firstOpen = questions.findIndex((q) => !isDraftValidForQuestion(q, drafts.get(q.id)));
        goToCard(firstOpen);
        showValidation(multiQuestion ? 'Answer every question to send.' : 'Pick an answer first.');
        return;
      }
      finish({ status: 'answered', answers: buildAnswerEntries(questions, drafts) });
    }

    /** Enter: move on from an answered card, or send from the last one. */
    function confirmCurrentCard(): void {
      const q = questions[cardIndex];
      if (!isDraftValidForQuestion(q, drafts.get(q.id))) {
        showValidation(isAskQuestionMultiSelect(q) ? 'Pick at least one answer.' : 'Pick an answer first.');
        return;
      }
      if (cardIndex < questions.length - 1) goToCard(cardIndex + 1);
      else submitAnswers();
    }

    function tryAutoSubmitAfterSingleSelect(): void {
      if (questions.length !== 1) return;
      const only = questions[0];
      if (isAskQuestionMultiSelect(only)) return;
      if (!areAllDraftsValid(questions, drafts)) return;
      finish({ status: 'answered', answers: buildAnswerEntries(questions, drafts) });
    }

    /**
     * Picking a preset answer on a single-choice card moves to the next card in the
     * batch (short delay so the selection is visible first). The last card stays put
     * so the user can review before sending.
     */
    function advanceAfterSingleSelect(): void {
      if (questions.length === 1) {
        tryAutoSubmitAfterSingleSelect();
        return;
      }
      const from = cardIndex;
      cancelAutoAdvance();
      if (from >= questions.length - 1) {
        if (areAllDraftsValid(questions, drafts) && panel.contains(document.activeElement)) {
          btnSubmit.focus();
        }
        return;
      }
      autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        if (settled || cardIndex !== from) return;
        goToCard(from + 1);
      }, AUTO_ADVANCE_DELAY_MS);
    }

    btnNext.addEventListener('click', () => goToCard(cardIndex + 1));
    btnSubmit.addEventListener('click', submitAnswers);
    btnClose.addEventListener('click', () => finish({ status: 'cancelled', answers: [] }));

    const onDocKeyDown = (ev: KeyboardEvent): void => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (!modal || !isModalForeground(modal) || !panel.contains(document.activeElement)) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish({ status: 'cancelled', answers: [] });
        return;
      }
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const active = document.activeElement;
      const card = cards[cardIndex];
      if (active === card.otherInput) {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          confirmCurrentCard();
        }
        return;
      }
      if (isTypingInModal(panel, active)) return;
      if (/^[1-9]$/.test(ev.key)) {
        const q = questions[cardIndex];
        const n = Number(ev.key);
        if (n <= q.options.length) {
          ev.preventDefault();
          const input = card.inputs[n - 1];
          input.focus();
          toggleOption(q, q.options[n - 1].id, isAskQuestionMultiSelect(q) ? !input.checked : true);
        } else if (n === q.options.length + 1) {
          ev.preventDefault();
          card.otherInput.focus();
        }
        return;
      }
      if (ev.key === 'Enter' && active?.tagName !== 'BUTTON') {
        ev.preventDefault();
        confirmCurrentCard();
        return;
      }
      if (ev.key === 'ArrowLeft' && multiQuestion) {
        ev.preventDefault();
        goToCard(cardIndex - 1);
        return;
      }
      if (ev.key === 'ArrowRight' && multiQuestion) {
        ev.preventDefault();
        goToCard(cardIndex + 1);
      }
    };

    document.addEventListener('keydown', onDocKeyDown, true);
    showCard();

    notifyAskQuestionShown(chatIdForAbort, args);

    requestAnimationFrame(() => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (!modal || !isModalForeground(modal)) return;
      host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      focusCardControl();
    });
  });
}

function isTypingInModal(panel: HTMLElement, el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (!panel.contains(el)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (tag === 'INPUT') {
    const inp = el as HTMLInputElement;
    const t = inp.type;
    if (t === 'text' || t === 'search' || t === 'url' || t === 'email') return !inp.readOnly;
  }
  return false;
}

/** Runs the UI and returns JSON string for tool content. */
export async function runAskQuestionModal(
  args: AskQuestionArgs,
  context: QuestionCardsModalContext,
): Promise<string> {
  const result = await showQuestionCardsModal(args, context);
  return stringifyAskQuestionResult(result);
}

// Defer until after module init — ask-question-display ↔ orchestrate-plan-screen cycle.
queueMicrotask(() => {
  registerAskQuestionDisplayContextSync(syncAskQuestionModalOnDisplayContextChange);
});
