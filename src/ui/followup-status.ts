/**
 * Follow-up chain panel in the transcript (MIN-206).
 *
 * Shows what the armed chain still owes and lets the user stop it. Mirrors the
 * /loop panel's lifecycle (one panel per chat, appended to the transcript).
 */

import { isStreamDomVisible } from '../chat/streaming-state';
import {
  clearFollowupChain,
  findChatById,
  getFollowupChain,
  sessionState,
} from '../state/sessions';
import type { Chat } from '../types';
import { appendChatTranscriptNode } from './chat-mount';
import { scrollChatIfPinned } from './chat-scroll';

const FOLLOWUP_STATUS_CLASS = 'followup-status';
const panelByChatId = new Map<string, HTMLElement>();

function buildStopButton(chat: Chat): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'followup-status__stop icon-btn';
  btn.textContent = '×';
  btn.title = 'Stop follow-up chain';
  btn.setAttribute('aria-label', 'Stop follow-up chain');
  btn.addEventListener('click', () => {
    clearFollowupChain(chat);
    syncFollowupStatusUi(chat.id);
  });
  return btn;
}

function buildFollowupStatusPanel(chat: Chat, index: number, total: number, remaining: number): HTMLElement {
  const panel = document.createElement('div');
  panel.className = FOLLOWUP_STATUS_CLASS;
  panel.dataset.chatId = chat.id;

  const header = document.createElement('div');
  header.className = 'followup-status__header';

  const title = document.createElement('span');
  title.className = 'followup-status__title';
  title.textContent = 'Follow-up chain';

  const runs = document.createElement('span');
  runs.className = 'followup-status__runs';
  runs.textContent = `${index} of ${total} started · ${remaining} to go`;

  const actions = document.createElement('div');
  actions.className = 'followup-status__actions';
  actions.appendChild(buildStopButton(chat));

  header.appendChild(title);
  header.appendChild(runs);
  header.appendChild(actions);

  const task = document.createElement('p');
  task.className = 'followup-status__task';
  const promptText = getFollowupChain(chat)?.promptText.trim() ?? '';
  task.textContent = promptText
    ? `Next task: ${promptText}`
    : 'Next task chosen by the agent when the chain advances';
  if (promptText) task.title = promptText;

  panel.appendChild(header);
  panel.appendChild(task);
  return panel;
}

function hideFollowupStatusPanel(chatId: string): void {
  const panel = panelByChatId.get(chatId);
  if (panel) {
    if (panel.isConnected) {
      panel.remove();
    }
    panelByChatId.delete(chatId);
  }
}

function showFollowupStatusPanel(chat: Chat): void {
  const chain = getFollowupChain(chat);
  if (!chain) {
    hideFollowupStatusPanel(chat.id);
    return;
  }

  hideFollowupStatusPanel(chat.id);
  const panel = buildFollowupStatusPanel(chat, chain.index, chain.total, chain.remaining);
  panelByChatId.set(chat.id, panel);
  appendChatTranscriptNode(panel);
  scrollChatIfPinned();
}

/** Sync the chain panel for one chat (defaults to the active chat). */
export function syncFollowupStatusUi(chatId?: string): void {
  if (typeof document === 'undefined') return;

  const id = chatId ?? sessionState?.activeId;
  if (!id) return;

  for (const otherId of panelByChatId.keys()) {
    if (otherId !== id) hideFollowupStatusPanel(otherId);
  }

  const chat = findChatById(id);
  if (!chat || !getFollowupChain(chat) || !isStreamDomVisible(chat.id)) {
    hideFollowupStatusPanel(id);
    return;
  }

  showFollowupStatusPanel(chat);
}

/** Back-compat alias used across boot, send, and runner paths. */
export function syncFollowupActiveHint(): void {
  if (typeof document === 'undefined') return;
  syncFollowupStatusUi(sessionState?.activeId ?? undefined);
}
