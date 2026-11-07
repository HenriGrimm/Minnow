import type { Chat } from '../types';
import {
  applyChatRunTargetChoice,
  getChatWorktreeSetupError,
  isChatWorktreeSetupPending,
  subscribeChatWorktreeSetup,
} from '../state/chat-worktree';
import { findChatById, getActiveChat, scheduleSaveSessions, sessionState, touchChat } from '../state/sessions';
import { subscribeManagedChatMetadata } from '../chat/managed-chat-view';
import { getActiveChatMountElement } from './chat-mount';
import { createGitWorktreeIcon } from './git-worktree-icons';
import { scrollChatIfPinned } from './chat-scroll';
import { teardownHub } from './hub';

/** Keep setup visible across chat switches and transcript repaints. */
export function syncChatWorktreeSetup(chat: Chat, mount: HTMLElement | null): void {
  if (!mount) return;
  const previous = mount.querySelector<HTMLElement>('.chat-worktree-setup');
  if (!chat.worktreeSetupRequired) {
    previous?.remove();
    return;
  }
  if (mount.querySelector('#vibeHub')) teardownHub();
  const serverSetup = chat.chatCommandVersion === 1 ? chat.workspacePreparation : undefined;
  const pending = isChatWorktreeSetupPending(chat.id) || serverSetup?.status === 'pending' || serverSetup?.status === 'preparing';
  const error = pending ? '' : serverSetup?.error || getChatWorktreeSetupError(chat.id) || 'Setup did not finish. Retry setup or return to Local before sending.';
  const key = `${chat.id}:${pending}:${error}`;
  if (previous?.dataset.state === key) return;

  const row = document.createElement('section');
  row.className = 'chat-worktree-setup';
  row.dataset.state = key;
  row.dataset.chatId = chat.id;
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');
  row.setAttribute('aria-busy', String(pending));
  row.append(createGitWorktreeIcon('worktree', 'chat-worktree-setup__icon'));

  const body = document.createElement('div');
  body.className = 'chat-worktree-setup__body';
  const heading = document.createElement('strong');
  heading.textContent = pending ? 'Setting up your worktree' : 'Worktree setup needs attention';
  const detail = document.createElement('p');
  detail.textContent = pending
    ? 'Creating an isolated checkout and preparing project dependencies. Your chat will use this checkout.'
    : error;
  body.append(heading, detail);
  if (pending) {
    const progress = document.createElement('div');
    progress.className = 'chat-worktree-setup__progress';
    progress.setAttribute('aria-hidden', 'true');
    body.append(progress);
  } else {
    const actions = document.createElement('div');
    actions.className = 'chat-worktree-setup__actions';
    for (const [label, kind] of [['Retry setup', 'automatic'], ['Back to Local', 'local']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        void applyChatRunTargetChoice(chat, { kind }).then(async result => {
          if (!result.ok || sessionState?.activeId !== chat.id) return;
          const panel = await import('./git-panel');
          if (sessionState?.activeId !== chat.id) return;
          panel.clearPanelCwdUserOverride();
          panel.syncPanelFromActiveChat({ forceFileTree: true });
        }).catch(() => {}).finally(() => {
          touchChat(chat);
          scheduleSaveSessions();
        });
        touchChat(chat);
        scheduleSaveSessions();
      });
      actions.append(button);
    }
    body.append(actions);
  }
  row.append(body);
  if (previous) previous.replaceWith(row);
  else mount.append(row);
}

subscribeChatWorktreeSetup(chat => {
  if (typeof document === 'undefined' || sessionState?.activeId !== chat.id) return;
  syncChatWorktreeSetup(chat, getActiveChatMountElement());
  if (getActiveChat().id === chat.id) scrollChatIfPinned();
});
subscribeManagedChatMetadata(chatId => {
  if (typeof document === 'undefined' || sessionState?.activeId !== chatId) return;
  const chat = findChatById(chatId);
  if (chat) syncChatWorktreeSetup(chat, getActiveChatMountElement());
});
