import '../styles/code-brain-map.css';

import { sessionState } from '../state/sessions';
import type { CodeMapChatRequest } from './code-map/chat-request';
import { bindCodeMapChatResize } from './code-map/chat-resize';
import { setCodeMapChatId } from './code-map/chat-state';
import { bindCodeMapChatScroll, invalidateChatScrollRootCache } from './chat-scroll';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { notifyCodeStageViewChanged, stripMainColumnOverlayClasses } from './main-column-overlay';

const CODE_SECTION_ID = 'brainSection-code';
const CODE_MAP_MOUNT_ID = 'codeBrainMapMount';
const CHAT_AREA_CODE_MAP_CLASS = 'chat-area--code-brain-map';
const MAIN_COLUMN_CODE_MAP_CLASS = 'main-column--code-brain-map';

/** Where #brainSection-code lived before it was moved into the code app overlay. */
let codeSectionHome: { parent: HTMLElement; nextSibling: ChildNode | null } | null = null;
let returnChatId: string | null = null;
let composerHomes: { element: HTMLElement; parent: HTMLElement; next: ChildNode | null }[] = [];
let composerPlaceholder: string | null = null;
let disposeChatResize: (() => void) | null = null;

/** Return shared composer chrome before destroying its temporary host. */
export function closeCodeMapChat(): void {
  disposeChatResize?.();
  disposeChatResize = null;
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (input && composerPlaceholder !== null) input.placeholder = composerPlaceholder;
  composerPlaceholder = null;
  for (const { element, parent, next } of composerHomes.slice().reverse()) {
    parent.insertBefore(element, next?.parentNode === parent ? next : null);
  }
  composerHomes = [];
  setCodeMapChatId(null);
  document.getElementById('codeMapChatSidebar')?.remove();
  invalidateChatScrollRootCache();
  notifyAskQuestionDisplayContextChanged();
}

/** Start a separate saved chat beside the map, using the Code composer and engine. */
export async function openCodeMapChat(request: CodeMapChatRequest): Promise<void> {
  if (!isCodeBrainMapOpen()) return;
  const { createChatWithMode } = await import('./sidebar');
  if (!isCodeBrainMapOpen()) return;
  closeCodeMapChat();
  const result = createChatWithMode({ modeId: 'general', forceNewChat: true });
  if (!result.ok || !result.chatId) return;
  const root = document.getElementById('codeBrainMapRoot');
  if (!root) return;
  returnChatId = result.chatId;
  const sidebar = document.createElement('aside');
  sidebar.id = 'codeMapChatSidebar';
  sidebar.className = 'code-map-chat';
  sidebar.setAttribute('aria-label', 'Code map chat');
  const header = document.createElement('div');
  header.className = 'code-map-chat__header';
  const title = document.createElement('strong');
  title.textContent = 'Code map chat';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'code-map-btn';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close code map chat');
  close.addEventListener('click', closeCodeMapChat);
  header.append(title, close);
  const transcript = document.createElement('div');
  transcript.id = 'codeMapChatTranscript';
  transcript.className = 'code-map-chat__transcript chat-thread';
  sidebar.append(header, transcript);
  root.append(sidebar);
  disposeChatResize = bindCodeMapChatResize(root, sidebar);
  setCodeMapChatId(result.chatId);
  const column = document.getElementById('mainColumn');
  for (const element of column?.querySelectorAll<HTMLElement>(
    ':scope > .tool-approval-host, :scope > .question-host, :scope > .input-bar',
  ) ?? []) {
    const parent = element.parentElement!;
    composerHomes.push({ element, parent, next: element.nextSibling });
    sidebar.append(element);
  }
  bindCodeMapChatScroll();
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (input) {
    composerPlaceholder = input.placeholder;
    input.placeholder = 'Ask a follow-up…';
    input.value = '';
    input.focus();
  }
  notifyAskQuestionDisplayContextChanged();
  const chat = sessionState?.chats.find((c) => c.id === result.chatId);
  if (!chat) return;
  const sendQuestion = async (): Promise<void> => {
    try {
      const { sendProgrammaticChatText } = await import('../chat/messaging');
      await sendProgrammaticChatText(chat, request.prompt, {
        codeMap: request.card,
        parseSlash: false,
        titleSeed: request.card.question,
        requireCompletedTurn: true,
        composerSurface: {
          inputEl: input,
          sendBtnEl: document.getElementById('sendBtn') as HTMLButtonElement | null,
        },
      });
    } catch (error) {
      if (!sidebar.isConnected) return;
      // Accepted turns already own their error/recovery UI, including a deliberate Stop.
      if (chat.history.some((message) => message.role === 'user')) return;
      const notice = document.createElement('p');
      notice.className = 'code-map-chat__error';
      notice.setAttribute('role', 'alert');
      notice.textContent = error instanceof Error ? error.message : 'Could not send the question.';
      header.after(notice);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'code-map-btn';
      retry.textContent = 'Retry question';
      retry.addEventListener('click', () => {
        notice.remove();
        void sendQuestion();
      }, { once: true });
      notice.append(document.createTextNode(' '), retry);
    }
  };
  await sendQuestion();
}

/** True when the code map overlay is mounted in #chatArea. */
export function isCodeBrainMapOpen(): boolean {
  return (
    document.getElementById('chatArea')?.classList.contains(CHAT_AREA_CODE_MAP_CLASS) ?? false
  );
}

/** Default Brain app slot for #brainSection-code (before Settings). */
function getDefaultCodeSectionHome(): { parent: HTMLElement; nextSibling: ChildNode | null } | null {
  const parent = document.querySelector('#brainView .brain-content');
  const settings = document.getElementById('brainSection-settings');
  if (!parent || !(parent instanceof HTMLElement)) return null;
  return { parent, nextSibling: settings };
}

/** True when the overlay is mounted or the code section was left outside Brain. */
function isCodeMapOverlayActive(): boolean {
  if (isCodeBrainMapOpen()) return true;
  const section = document.getElementById(CODE_SECTION_ID);
  const mount = document.getElementById(CODE_MAP_MOUNT_ID);
  if (section && mount?.contains(section)) return true;
  return Boolean(document.getElementById('codeBrainMapRoot'));
}

/** Remember the Brain app slot so the code section can be restored on close. */
function rememberCodeSectionHome(section: HTMLElement): void {
  const overlayMount = document.getElementById(CODE_MAP_MOUNT_ID);
  if (overlayMount?.contains(section)) return;

  const parent = section.parentElement;
  if (!parent) return;
  codeSectionHome = { parent, nextSibling: section.nextSibling };
}

/** Move #brainSection-code back into the Brain app content area. */
export function restoreCodeSectionIfMounted(): void {
  const section = document.getElementById(CODE_SECTION_ID);
  if (!section) {
    codeSectionHome = null;
    return;
  }

  const brainContent = document.querySelector('#brainView .brain-content');
  if (brainContent?.contains(section)) {
    section.classList.remove('is-active');
    codeSectionHome = null;
    return;
  }

  const home = codeSectionHome ?? getDefaultCodeSectionHome();
  if (!home) return;

  const { parent, nextSibling } = home;
  if (nextSibling) {
    parent.insertBefore(section, nextSibling);
  } else {
    parent.appendChild(section);
  }
  section.classList.remove('is-active');
  codeSectionHome = null;
}

/** Restore the Brain code section before #chatArea is repainted (workspace switch, chat change). */
export function teardownCodeBrainMapBeforeChatPaint(): boolean {
  const hadOverlay = isCodeMapOverlayActive();
  if (!hadOverlay && !codeSectionHome) return false;

  closeCodeMapChat();

  restoreCodeSectionIfMounted();

  document.getElementById('codeBrainMapRoot')?.remove();
  stripMainColumnOverlayClasses();
  returnChatId = null;
  syncFooterButton();
  return hadOverlay;
}

function syncFooterButton(): void {
  const btn = document.getElementById('btnCodeBrainMap');
  if (!btn) return;
  const open = isCodeBrainMapOpen();
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** Overlay root; the code map section (with its own top bar and back button) mounts inside. */
function buildOverlayDom(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'code-brain-map-root';
  root.id = 'codeBrainMapRoot';

  const mount = document.createElement('div');
  mount.className = 'code-brain-map-mount';
  mount.id = CODE_MAP_MOUNT_ID;

  root.append(mount);
  return root;
}

/** Close overlays that compete for the main column. */
async function closeCompetingMainColumnViews(): Promise<void> {
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('map');
}

/** Open the Brain code section inside the Code app main column. */
export async function openCodeBrainMap(options?: { skipNavigate?: boolean }): Promise<void> {
  if (isCodeBrainMapOpen()) return;
  if (isCodeMapOverlayActive()) {
    teardownCodeBrainMapBeforeChatPaint();
  }

  await closeCompetingMainColumnViews();

  const area = document.getElementById('chatArea');
  const section = document.getElementById(CODE_SECTION_ID);
  if (!area || !section) return;

  if (!returnChatId && sessionState?.activeId) {
    returnChatId = sessionState.activeId;
  }

  area.replaceChildren();
  area.appendChild(buildOverlayDom());
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_CODE_MAP_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_CODE_MAP_CLASS);

  rememberCodeSectionHome(section);
  const mount = document.getElementById(CODE_MAP_MOUNT_ID);
  mount?.appendChild(section);
  section.classList.add('is-active');
  notifyCodeStageViewChanged();

  const { renderBrainSection } = await import('./brain/sections');
  await renderBrainSection('code');

  syncFooterButton();
  notifyAskQuestionDisplayContextChanged();
  notifyCodeStageViewChanged();
  if (!options?.skipNavigate) {
    const { syncCodeSectionHash } = await import('../os/router');
    syncCodeSectionHash('map');
  }
}

/** Tear down the overlay and restore the prior chat view. */
export function closeCodeBrainMap(): void {
  if (!isCodeMapOverlayActive()) return;

  const savedReturnChatId = returnChatId;
  teardownCodeBrainMapBeforeChatPaint();

  const area = document.getElementById('chatArea');
  const targetId =
    savedReturnChatId && sessionState?.chats.some((c) => c.id === savedReturnChatId)
      ? savedReturnChatId
      : sessionState?.activeId;

  const chat = targetId ? sessionState?.chats.find((c) => c.id === targetId) : undefined;
  if (chat) {
    void import('./messages').then((m) => m.renderChatFromHistory(chat));
  } else if (area) {
    area.replaceChildren();
  }
  notifyAskQuestionDisplayContextChanged();
  notifyCodeStageViewChanged();
  void import('../os/router').then((m) => m.navigateToCodeChatIfCurrentSection('map'));
}

/** Toggle the code map from the chat sidebar footer. */
export function toggleCodeBrainMapFromSidebar(): void {
  if (isCodeMapOverlayActive()) {
    closeCodeBrainMap();
    return;
  }
  void openCodeBrainMap();
}

let staticBindingsDone = false;

/** Wire footer toggle and back button (idempotent). */
export function initCodeBrainMap(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  document.getElementById('btnCodeBrainMap')?.addEventListener('click', () => {
    toggleCodeBrainMapFromSidebar();
  });

  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#btnCodeBrainMapBack')) {
      closeCodeBrainMap();
    }
  });

  syncFooterButton();
}
