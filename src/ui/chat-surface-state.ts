import type { Chat, Message } from '../types';
import { chatMutationVersion } from '../state/chat-mutation-version';

interface MountedChat {
  chat: Chat;
  history: Message[];
  length: number;
  updatedAt: number;
  revision: number;
  mode: Chat['modeId'];
  last: Message | undefined;
  content: unknown;
  anchor: Element;
  transcript?: { start: number; messages: { message: Message; json: string }[] };
}

const mounted = new WeakMap<HTMLElement, MountedChat>();
const contentOf = (row: Message | undefined): unknown => row && 'content' in row ? row.content : undefined;

/** Track only the currently mounted view; no detached transcript DOM is retained. */
export function rememberChatSurface(area: HTMLElement, chat: Chat): void {
  const anchor = area.querySelector('.msg[data-history-index]') ?? area.firstElementChild;
  if (!anchor) { mounted.delete(area); return; }
  const start = Number(area.dataset.historyStart);
  const previous = mounted.get(area);
  const transcript = chat.chatCommandVersion === 1 && Number.isSafeInteger(start) && start >= 0 &&
    !area.classList.contains('chat-area--hub') && (chat.history.length > 0 || area.querySelector('.msg--sending'))
    ? { start, messages: chat.history.slice(start).map((message, offset) => {
      const prior = previous?.chat === chat ? previous.transcript?.messages[start + offset - previous.transcript.start] : undefined;
      return prior?.message === message ? prior : { message, json: JSON.stringify(message) };
    }) } : undefined;
  mounted.set(area, { chat, history: chat.history, length: chat.history.length,
    updatedAt: chat.updatedAt, revision: chatMutationVersion(chat), mode: chat.modeId, last: chat.history.at(-1),
    content: contentOf(chat.history.at(-1)), anchor, transcript });
}

/** Append-only server frames keep mounted messages, disclosures and the history pager alive. */
export function chatHistoryAppendStart(area: HTMLElement, chat: Chat): number | undefined {
  const state = mounted.get(area);
  if (!state?.transcript || state.chat !== chat || state.mode !== chat.modeId ||
      state.length > chat.history.length || !area.contains(state.anchor)) return;
  const { start, messages } = state.transcript;
  if (Number(area.dataset.historyStart) !== start) return;
  for (let i = start; i < state.length; i++) {
    const prior = messages[i - start];
    if (prior.message !== chat.history[i] && prior.json !== JSON.stringify(chat.history[i])) return;
  }
  if (chat.history.slice(state.length).some(message => message.role === 'context' || message.role === 'injection')) return;
  return state.length;
}

export function forgetChatSurface(area: HTMLElement): void {
  mounted.delete(area);
}

/** A repaint of the same conversation keeps pages the reader already requested. */
export function retainedChatHistoryStart(area: HTMLElement, chat: Chat): number | undefined {
  const state = mounted.get(area);
  if (state?.chat !== chat || !area.contains(state.anchor)) return undefined;
  const start = Number(area.dataset.historyStart);
  return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
}

/** Session mutations call touchChat; reference checks also fence replacement and append paths. */
export function hasCurrentChatSurface(area: HTMLElement, chat: Chat): boolean {
  const state = mounted.get(area);
  return Boolean(state && state.chat === chat && state.history === chat.history &&
    state.length === chat.history.length && state.updatedAt === chat.updatedAt &&
    state.revision === chatMutationVersion(chat) &&
    state.mode === chat.modeId && state.last === chat.history.at(-1) &&
    state.content === contentOf(chat.history.at(-1)) && area.contains(state.anchor));
}
