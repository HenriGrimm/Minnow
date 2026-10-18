import { cancelChatHistoryBackfill, renderChatFromHistory } from './messages';
import { isMainColumnOverlaySuppressingChatDom } from './main-column-overlay';
import { getActiveChat } from '../state/sessions';
import { teardownHub } from './hub';
import type { Chat } from '../types';
import { getSharedChatHost, setSharedChatHost } from './shared-chat-host-state';
import { registerComposerSurface } from './composer-surface';
import { bindSharedChatScroll, invalidateChatScrollRootCache } from './chat-scroll';
import { disposeChatWorkView } from './chat-work';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import '../styles/shared-chat-host.css';

let releaseCurrent: (() => void) | undefined;

/** Move the actual composer, approval slots and metrics; never clone controls or handlers. */
export function mountSharedChatHost(host: HTMLElement, chat: Chat, app: 'home' | 'issues', options: { openPlan?: (path: string) => void } = {}): { dispose: () => void; focus: (text?: string) => void } {
  releaseCurrent?.();
  teardownHub();
  const shell = document.createElement('section');
  shell.className = 'main-column shared-chat-host';
  const transcript = document.createElement('div');
  transcript.className = 'chat-area shared-chat-host__transcript';
  transcript.setAttribute('aria-label', 'Conversation');
  const viewport = document.createElement('div');
  viewport.className = 'chat-viewport';
  viewport.append(transcript);
  shell.append(viewport);
  host.append(shell);
  const parked: { node: HTMLElement; marker: Comment }[] = [];
  const column = document.getElementById('mainColumn');
  const promptClasses = ['main-column--question-pending', 'main-column--tool-approval-pending'];
  for (const name of promptClasses) {
    column?.classList.remove(name);
  }
  for (const node of column?.querySelectorAll<HTMLElement>(':scope > #toolApprovalHost, :scope > #questionHost, :scope > #composerRunStatus, :scope > .input-bar, :scope > #statsStrip') ?? []) {
    const marker = document.createComment('shared chat return slot');
    node.before(marker); parked.push({ node, marker }); shell.append(node);
  }
  const jumpDock = column?.querySelector<HTMLElement>(':scope > .chat-viewport > .chat-viewport-dock');
  if (jumpDock) {
    const marker = document.createComment('shared chat jump return slot');
    jumpDock.before(marker); parked.push({ node: jumpDock, marker }); viewport.append(jumpDock);
  }
  setSharedChatHost({ chatId: chat.id, transcript, shell, openPlan: options.openPlan });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  const unregister = registerComposerSurface(app, { inputEl: input, sendBtnEl: document.getElementById('sendBtn') as HTMLButtonElement | null });
  bindSharedChatScroll();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelChatHistoryBackfill();
    disposeChatWorkView(transcript);
    if (getSharedChatHost()?.transcript === transcript) setSharedChatHost(null);
    for (const { node, marker } of parked) { marker.replaceWith(node); }
    unregister(); shell.remove(); invalidateChatScrollRootCache();
    if (releaseCurrent === dispose) releaseCurrent = undefined;
    notifyAskQuestionDisplayContextChanged();
    queueMicrotask(() => {
      if (!getSharedChatHost() && document.getElementById('chatArea') && !isMainColumnOverlaySuppressingChatDom()) renderChatFromHistory(getActiveChat());
    });
  };
  releaseCurrent = dispose;
  shell.inert = true;
  const ready = import('./sidebar').then(async ({ switchChat }) => {
    if (disposed) return;
    await switchChat(chat.id);
    if (disposed) return;
    shell.inert = false;
    notifyAskQuestionDisplayContextChanged();
  }).catch(error => {
    if (!disposed) transcript.textContent = `Could not open conversation: ${error instanceof Error ? error.message : String(error)}`;
  });
  return { dispose, focus(text) {
    void ready.then(() => {
      if (!input || disposed) return;
      if (text !== undefined) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
      input.focus();
    });
  } };
}
