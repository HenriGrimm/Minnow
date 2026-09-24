import { getChatAbort } from '../app-state';
import {
  isAskQuestionDomVisible,
  notifyAskQuestionDisplayContextChanged,
} from '../chat/ask-question-display';
import { registerAskQuestionDisplayContextSync } from '../chat/ask-question-display-sync';
import { isActiveChatStreaming } from '../chat/streaming-state';
import { notifyAskQuestionShown } from '../notifications/ask-question';
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
  PLAN_SCREEN_QUESTIONS_HOST_ID,
  BOARD_ONBOARDING_QUESTIONS_HOST_ID,
  ONBOARDING_GUIDE_QUESTIONS_HOST_ID,
]);

/** Pause after a single-choice pick so the selection is visible before the card flips. */
const AUTO_ADVANCE_DELAY_MS = 220;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getActiveHTMLElement(): HTMLElement | null {
  const active = document.activeElement;
  if (!active || typeof (active as HTMLElement).focus !== 'function') return null;
  return active as HTMLElement;
}

/** Focusable controls inside the open question panel (visible, enabled). */
function listPanelFocusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.hidden &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.hasAttribute('disabled'),
  );
}

function focusFirstPanelControl(panel: HTMLElement): void {
  const nodes = listPanelFocusables(panel);
  const firstOption = panel.querySelector<HTMLElement>(
    '.question-cards-options input:not([disabled])',
  );
  (firstOption ?? nodes[0])?.focus();
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
): void {
  restoreComposerAfterQuestion(state, focusOverride);
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

  const planHost = resolveOrchestratePlanScreenQuestionHost(state.chatId);
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
    if (!host && options.chatId) {
      const planHost = resolveOrchestratePlanScreenQuestionHost(options.chatId);
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
      if (!embedded) host.hidden = false;
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
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', args.title?.trim() || 'Assistant questions');
    panel.tabIndex = -1;

    const previousFocus = getActiveHTMLElement();

    const header = document.createElement('div');
    header.className = 'question-cards-panel__header';

    const headerMain = document.createElement('div');
    headerMain.className = 'question-cards-panel__header-main';

    if (args.title) {
      const eyebrow = document.createElement('p');
      eyebrow.className = 'question-cards-panel__eyebrow';
      eyebrow.textContent = args.title;
      headerMain.appendChild(eyebrow);
    }

    const headerActions = document.createElement('div');
    headerActions.className = 'question-cards-panel__header-actions';

    const nav = document.createElement('div');
    nav.className = 'question-cards-nav';
    nav.hidden = questions.length <= 1;
    const btnPrev = document.createElement('button');
    btnPrev.type = 'button';
    btnPrev.className = 'question-cards-nav-btn';
    btnPrev.setAttribute('aria-label', 'Previous question');
    btnPrev.innerHTML = iconHtml('chevronLeft');
    const indicator = document.createElement('span');
    indicator.className = 'question-cards-nav-indicator';
    const btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.className = 'question-cards-nav-btn';
    btnNext.setAttribute('aria-label', 'Next question');
    btnNext.innerHTML = iconHtml('chevronRight');
    nav.append(btnPrev, indicator, btnNext);
    headerActions.appendChild(nav);

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
    btnClose.innerHTML = iconHtml('close');
    headerActions.appendChild(btnClose);

    header.append(headerMain, headerActions);

    const cardBody = document.createElement('div');
    cardBody.className = 'question-cards-panel__body';

    const footer = document.createElement('div');
    footer.className = 'question-cards-panel__footer';

    const btnSubmit = document.createElement('button');
    btnSubmit.type = 'button';
    btnSubmit.className = 'question-cards-submit';
    btnSubmit.textContent = 'Submit answers';

    const validation = document.createElement('p');
    validation.className = 'question-cards-validation';
    validation.setAttribute('role', 'status');
    validation.setAttribute('aria-live', 'polite');
    validation.hidden = true;

    const hints = document.createElement('p');
    hints.className = 'question-cards-hints';
    hints.textContent = 'Esc to cancel · Arrow keys to change card';

    footer.append(validation, btnSubmit, hints);
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
    let trapFocusHandler: ((ev: KeyboardEvent) => void) | null = null;
    let focusInHandler: ((ev: FocusEvent) => void) | null = null;

    const detachFocusTrap = (): void => {
      if (trapFocusHandler) {
        panel.removeEventListener('keydown', trapFocusHandler);
        trapFocusHandler = null;
      }
      if (focusInHandler) {
        document.removeEventListener('focusin', focusInHandler, true);
        focusInHandler = null;
      }
    };

    const finish = (result: AskQuestionToolResult): void => {
      if (settled) return;
      settled = true;
      cancelAutoAdvance();
      detachFocusTrap();
      document.removeEventListener('keydown', onDocKeyDown, true);
      if (abortListener) {
        getChatAbort(chatIdForAbort)?.signal.removeEventListener('abort', abortListener);
      }
      const modal = modalsByChatId.get(chatIdForAbort);
      modalsByChatId.delete(chatIdForAbort);
      if (modal?.panel.parentNode) {
        modal.panel.remove();
      }
      if (modal && !modal.embedded && !modal.parked) {
        deactivateComposerQuestionChrome(modal, previousFocus);
      } else {
        removeSidebarInputPendingChatId(chatIdForAbort);
        if (previousFocus?.isConnected && modal && !modal.parked) {
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
     * so the user can review before submitting.
     */
    function advanceAfterSingleSelect(): void {
      if (questions.length === 1) {
        tryAutoSubmitAfterSingleSelect();
        return;
      }
      const from = cardIndex;
      if (from >= questions.length - 1) return;
      cancelAutoAdvance();
      autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        if (settled || cardIndex !== from) return;
        const keepFocus = panel.contains(document.activeElement);
        cardIndex = from + 1;
        showCard();
        if (keepFocus) focusFirstPanelControl(panel);
      }, AUTO_ADVANCE_DELAY_MS);
    }

    function syncSubmitLabel(): void {
      const singleMulti =
        questions.length === 1 && isAskQuestionMultiSelect(questions[0]);
      btnSubmit.textContent = singleMulti ? 'Continue' : 'Submit answers';
    }

    function syncNav(): void {
      const last = questions.length - 1;
      btnPrev.disabled = cardIndex <= 0;
      btnNext.disabled = cardIndex >= last;
      indicator.textContent = `${cardIndex + 1} / ${questions.length}`;
      const onLast = cardIndex === last;
      const allValid = areAllDraftsValid(questions, drafts);
      const current = questions[cardIndex];
      const multiSelect = isAskQuestionMultiSelect(current);
      btnSubmit.hidden = !onLast;
      btnSubmit.disabled = !allValid;
      syncSubmitLabel();
      if (onLast && !allValid) {
        validation.textContent = multiSelect
          ? 'Select at least one answer, then continue.'
          : 'Answer every question to continue.';
        validation.hidden = false;
      } else {
        validation.textContent = '';
        validation.hidden = true;
      }
      hints.textContent = multiSelect
        ? 'Select all that apply, then continue · Esc to cancel'
        : 'Esc to cancel · Arrow keys to change card';
    }

    function renderQuestion(q: AskQuestionItem): void {
      cardBody.replaceChildren();

      const promptEl = document.createElement('h2');
      promptEl.className = 'question-cards-prompt';
      promptEl.id = `question-cards-prompt-${q.id}`;
      promptEl.textContent = q.prompt;
      panel.setAttribute('aria-labelledby', promptEl.id);
      cardBody.appendChild(promptEl);

      const list = document.createElement('div');
      list.className = 'question-cards-options';
      list.dataset.optionCount = String(q.options.length + 1);
      list.setAttribute('role', isAskQuestionMultiSelect(q) ? 'group' : 'radiogroup');
      list.setAttribute(
        'aria-label',
        isAskQuestionMultiSelect(q) ? 'Select one or more answers' : 'Select one answer',
      );

      const draft = getOrCreateDraft(drafts, q.id);
      const groupName = `ask-q-${q.id}`;

      for (const opt of q.options) {
        const row = document.createElement('label');
        row.className = 'question-cards-option';
        const selected = draft.selectedIds.includes(opt.id);
        if (selected) row.classList.add('question-cards-option--selected');

        const input = document.createElement('input');
        if (isAskQuestionMultiSelect(q)) {
          input.type = 'checkbox';
          input.checked = selected;
          input.addEventListener('change', () => {
            const d = getOrCreateDraft(drafts, q.id);
            if (input.checked) {
              d.selectedIds = d.selectedIds.filter((id) => id !== ASK_QUESTION_OTHER_ID);
              if (!d.selectedIds.includes(opt.id)) d.selectedIds.push(opt.id);
            } else {
              d.selectedIds = d.selectedIds.filter((id) => id !== opt.id);
            }
            renderQuestion(q);
            syncNav();
          });
        } else {
          input.type = 'radio';
          input.name = groupName;
          input.value = opt.id;
          input.checked = selected && !draft.selectedIds.includes(ASK_QUESTION_OTHER_ID);
          input.addEventListener('change', () => {
            const d = getOrCreateDraft(drafts, q.id);
            d.selectedIds = [opt.id];
            d.otherText = '';
            renderQuestion(q);
            syncNav();
            advanceAfterSingleSelect();
          });
        }

        const textWrap = document.createElement('span');
        textWrap.className = 'question-cards-option-text';
        const title = document.createElement('span');
        title.className = 'question-cards-option-label';
        title.textContent = opt.label;
        textWrap.appendChild(title);
        if (opt.description) {
          const desc = document.createElement('span');
          desc.className = 'question-cards-option-desc';
          desc.textContent = opt.description;
          textWrap.appendChild(desc);
        }
        row.append(input, textWrap);
        list.appendChild(row);
      }

      const otherRow = document.createElement('label');
      otherRow.className = 'question-cards-option question-cards-option--other';
      const otherSelected = draft.selectedIds.includes(ASK_QUESTION_OTHER_ID);
      if (otherSelected) otherRow.classList.add('question-cards-option--selected');

      const otherInput = document.createElement('input');
      if (isAskQuestionMultiSelect(q)) {
        otherInput.type = 'checkbox';
        otherInput.checked = otherSelected;
        otherInput.addEventListener('change', () => {
          const d = getOrCreateDraft(drafts, q.id);
          if (otherInput.checked) {
            d.selectedIds = [ASK_QUESTION_OTHER_ID];
          } else {
            d.selectedIds = [];
            d.otherText = '';
          }
          renderQuestion(q);
          syncNav();
        });
      } else {
        otherInput.type = 'radio';
        otherInput.name = groupName;
        otherInput.value = ASK_QUESTION_OTHER_ID;
        otherInput.checked = otherSelected;
        otherInput.addEventListener('change', () => {
          const d = getOrCreateDraft(drafts, q.id);
          d.selectedIds = [ASK_QUESTION_OTHER_ID];
          renderQuestion(q);
          syncNav();
        });
      }

      const otherTextWrap = document.createElement('span');
      otherTextWrap.className = 'question-cards-option-text';
      const otherLabel = document.createElement('span');
      otherLabel.className = 'question-cards-option-label';
      otherLabel.textContent = 'Other';
      otherTextWrap.appendChild(otherLabel);

      otherRow.append(otherInput, otherTextWrap);
      list.appendChild(otherRow);

      const otherFieldWrap = document.createElement('div');
      otherFieldWrap.className = 'question-cards-other-field';
      otherFieldWrap.hidden = !otherSelected;
      const ta = document.createElement('textarea');
      ta.className = 'question-cards-other-input';
      ta.rows = 2;
      ta.placeholder = 'Please specify…';
      ta.value = draft.otherText;
      ta.addEventListener('input', () => {
        getOrCreateDraft(drafts, q.id).otherText = ta.value;
        syncNav();
      });
      otherFieldWrap.appendChild(ta);
      cardBody.appendChild(list);
      cardBody.appendChild(otherFieldWrap);

      if (otherSelected) {
        requestAnimationFrame(() => ta.focus());
      }
    }

    function showCard(): void {
      renderQuestion(questions[cardIndex]);
      syncNav();
    }

    btnPrev.addEventListener('click', () => {
      cancelAutoAdvance();
      if (cardIndex > 0) {
        cardIndex -= 1;
        showCard();
      }
    });
    btnNext.addEventListener('click', () => {
      cancelAutoAdvance();
      if (cardIndex < questions.length - 1) {
        cardIndex += 1;
        showCard();
      }
    });

    btnSubmit.addEventListener('click', () => {
      cancelAutoAdvance();
      if (!areAllDraftsValid(questions, drafts)) return;
      const answers = buildAnswerEntries(questions, drafts);
      finish({ status: 'answered', answers });
    });

    btnClose.addEventListener('click', () => finish({ status: 'cancelled', answers: [] }));

    const onDocKeyDown = (ev: KeyboardEvent): void => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (!modal || !isModalForeground(modal)) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish({ status: 'cancelled', answers: [] });
        return;
      }
      if (ev.key === 'ArrowLeft' && !isTypingInModal(panel, document.activeElement)) {
        ev.preventDefault();
        btnPrev.click();
        return;
      }
      if (ev.key === 'ArrowRight' && !isTypingInModal(panel, document.activeElement)) {
        ev.preventDefault();
        btnNext.click();
        return;
      }
    };

    trapFocusHandler = (ev: KeyboardEvent): void => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (ev.key !== 'Tab' || !modal || !isModalForeground(modal)) return;
      const nodes = listPanelFocusables(panel);
      if (nodes.length === 0) return;
      const active = document.activeElement as HTMLElement;
      const index = nodes.indexOf(active);
      const from = index >= 0 ? index : 0;
      ev.preventDefault();
      const next = ev.shiftKey
        ? nodes[(from - 1 + nodes.length) % nodes.length]
        : nodes[(from + 1) % nodes.length];
      next.focus();
    };
    panel.addEventListener('keydown', trapFocusHandler);

    focusInHandler = (ev: FocusEvent): void => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (!modal || !isModalForeground(modal) || settled) return;
      const target = ev.target;
      if (target instanceof HTMLElement && panel.contains(target)) return;
      focusFirstPanelControl(panel);
    };
    document.addEventListener('focusin', focusInHandler, true);

    document.addEventListener('keydown', onDocKeyDown, true);
    showCard();

    notifyAskQuestionShown(chatIdForAbort, args);

    requestAnimationFrame(() => {
      const modal = modalsByChatId.get(chatIdForAbort);
      if (!modal || !isModalForeground(modal)) return;
      host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (questions.length === 1) {
        focusFirstPanelControl(panel);
      } else {
        btnPrev.focus();
      }
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
