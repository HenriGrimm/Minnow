/**
 * "Needs you": every pending agent question or approval in this workspace,
 * answerable from the sidebar. A single single-choice question answers in one
 * click or with a typed reply; richer questions open their chat. Approvals allow
 * once or deny. Archived chats still surface here, tagged, so a question is
 * never hidden behind the Archive view.
 */
import type { Chat } from '../types';
import type { ChatRequest } from '../../server/chats/contracts';
import { readManagedChatRequestPage, respondManagedChatRequest } from '../chat/managed-chat-client';
import { applySharedChatAttention, findChatById } from '../state/sessions';
import { isChatArchived } from '../state/chat-archive';
import { ASK_QUESTION_OTHER_ID, validateAskQuestionArgs, type AskQuestionItem } from '../tools/ask-question-types';
import { buildAnswerEntries, type AskQuestionAnswerDraft } from './question-cards-state';
import { syncChatItemDotsInDom } from './chat-item-dot';
import { fillProducerLogo } from './agent-model-mark';
import { createIcon } from './icon';

export interface NeedsYouHooks {
  /** Repaint the sidebar once requests load or an answer lands. */
  rerender: () => void;
  /** Open the chat, focusing the request when given. */
  openChat: (chatId: string, requestId?: string) => void;
}

interface RequestCache { key: string; requests: ChatRequest[]; loading: boolean; failed: boolean }
interface Confirmation { chatId: string; text: string; tone: 'ok' | 'muted'; until: number }

const CONFIRM_MS = 5000;
const caches = new Map<string, RequestCache>();
const cards = new Map<string, HTMLElement>();
const busy = new Set<string>();
const errors = new Map<string, string>();
const confirmations = new Map<string, Confirmation>();
const doneLines = new Map<string, HTMLElement>();
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

export function resetSidebarNeedsYouForTests(): void {
  caches.clear(); cards.clear(); busy.clear(); errors.clear(); confirmations.clear(); doneLines.clear();
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = null;
}

function pendingIds(chat: Chat): string[] {
  return (chat.agentRequestSummary ?? []).map(item => item.requestId);
}

function ensureRequests(chat: Chat, hooks: NeedsYouHooks): RequestCache {
  const key = pendingIds(chat).join(',');
  let cache = caches.get(chat.id);
  if (cache && cache.key === key) return cache;
  cache = { key, requests: cache?.requests ?? [], loading: true, failed: false };
  caches.set(chat.id, cache);
  const current = cache;
  void readManagedChatRequestPage(chat.id).then(page => {
    current.requests = page.requests;
  }).catch(() => {
    current.failed = true;
  }).finally(() => {
    current.loading = false;
    if (caches.get(chat.id) === current) hooks.rerender();
  });
  return cache;
}

function age(createdAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - createdAt) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function scheduleConfirmationExpiry(hooks: NeedsYouHooks): void {
  if (confirmTimer) clearTimeout(confirmTimer);
  const next = Math.min(...[...confirmations.values()].map(item => item.until));
  if (!Number.isFinite(next)) { confirmTimer = null; return; }
  confirmTimer = setTimeout(() => {
    const now = Date.now();
    for (const [id, item] of confirmations) if (item.until <= now) confirmations.delete(id);
    hooks.rerender();
  }, Math.max(0, next - Date.now()) + 20);
  (confirmTimer as { unref?: () => void }).unref?.();
}

async function respond(chatId: string, request: ChatRequest, answer: unknown, confirmation: Omit<Confirmation, 'chatId' | 'until'>, hooks: NeedsYouHooks): Promise<void> {
  if (busy.has(request.requestId)) return;
  busy.add(request.requestId); errors.delete(request.requestId); hooks.rerender();
  try {
    const saved = await respondManagedChatRequest(chatId, request.requestId, answer);
    const chat = findChatById(chatId);
    if (chat) {
      applySharedChatAttention(chatId, {
        agentRequests: [...(chat.agentRequests ?? []).filter(item => item.requestId !== saved.requestId), saved],
        agentRequestSummary: (chat.agentRequestSummary ?? []).filter(item => item.requestId !== saved.requestId),
      });
    }
    confirmations.set(request.requestId, { chatId, ...confirmation, until: Date.now() + CONFIRM_MS });
    cards.delete(request.requestId);
    scheduleConfirmationExpiry(hooks);
    syncChatItemDotsInDom();
  } catch (error) {
    // Another surface may have answered first, or the request expired.
    errors.set(request.requestId, error instanceof Error ? error.message : 'The answer could not be saved.');
    caches.delete(chatId);
  } finally {
    busy.delete(request.requestId);
    hooks.rerender();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function head(chat: Chat, request: ChatRequest | null, hooks: NeedsYouHooks): HTMLElement {
  const row = el('div', 'needs-you-card__head');
  const logo = el('span', 'needs-you-card__logo');
  logo.setAttribute('aria-hidden', 'true');
  fillProducerLogo(logo, chat.agentExecution?.resolvedModel?.modelId ?? chat.modelId ?? '', chat.agentExecution?.resolvedModel?.providerId ?? chat.providerId ?? '');
  const name = el('button', 'needs-you-card__chat', chat.name);
  name.type = 'button';
  name.title = `Open ${chat.name}`;
  name.addEventListener('click', () => hooks.openChat(chat.id, request?.requestId));
  row.append(logo, name);
  if (isChatArchived(chat)) row.append(el('span', 'needs-you-card__tag', 'Archived'));
  if (request) {
    const time = el('time', 'needs-you-card__age', age(request.createdAt));
    time.dateTime = new Date(request.createdAt).toISOString();
    row.append(time);
  }
  return row;
}

function action(label: string, className: string, run: () => void): HTMLButtonElement {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', run);
  return button;
}

function questionBody(card: HTMLElement, chat: Chat, request: ChatRequest, hooks: NeedsYouHooks): void {
  const parsed = validateAskQuestionArgs(request.presentation.question);
  const questions: AskQuestionItem[] = parsed.ok ? parsed.args.questions : [];
  const only = questions.length === 1 && !questions[0]!.allow_multiple ? questions[0]! : null;
  card.append(el('p', 'needs-you-card__prompt', questions[0]?.prompt ?? request.title));
  if (!only) {
    if (questions.length > 1) card.append(el('p', 'needs-you-card__sub', `${questions.length} questions`));
    const actions = el('div', 'needs-you-card__actions');
    actions.append(action('Answer in chat', 'needs-you-card__primary', () => hooks.openChat(chat.id, request.requestId)));
    card.append(actions);
    return;
  }
  const answer = (selectedIds: string[], otherText: string, text: string) => {
    const drafts = new Map<string, AskQuestionAnswerDraft>([[only.id, { selectedIds, otherText }]]);
    void respond(chat.id, request, { status: 'answered', answers: buildAnswerEntries([only], drafts) }, { text: `Answered: ${text}`, tone: 'ok' }, hooks);
  };
  const options = el('div', 'needs-you-card__options');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', only.prompt);
  for (const option of only.options) {
    const button = action(option.label, 'needs-you-card__option', () => answer([option.id], '', option.label));
    if ('description' in option && option.description) button.title = option.description;
    options.append(button);
  }
  const reply = el('form', 'needs-you-card__reply');
  const inputId = `needs-you-reply-${request.requestId}`;
  const label = el('label', 'needs-you-card__sr', `Reply to ${chat.name}`);
  label.htmlFor = inputId;
  const input = el('input', 'needs-you-card__input');
  input.id = inputId;
  input.placeholder = 'Or type a reply…';
  input.autocomplete = 'off';
  const send = el('button', 'needs-you-card__send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send reply');
  send.append(createIcon('arrowUp', { size: 12 }));
  reply.append(label, input, send);
  reply.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (text) answer([ASK_QUESTION_OTHER_ID], text, `“${text}”`);
  });
  card.append(options, reply);
}

function approvalBody(card: HTMLElement, chat: Chat, request: ChatRequest, hooks: NeedsYouHooks): void {
  card.append(el('p', 'needs-you-card__sub', request.title || 'Wants to use a tool'));
  const preview = request.presentation.argsPreview;
  const command = typeof preview === 'string' ? preview.split('\n').find(line => line.trim()) ?? '' : '';
  if (command) {
    const code = el('code', 'needs-you-card__code', command.trim());
    code.title = typeof preview === 'string' ? preview : command;
    card.append(code);
  }
  const actions = el('div', 'needs-you-card__actions');
  actions.append(
    action('Allow once', 'needs-you-card__primary', () => void respond(chat.id, request, { decision: 'allow_once' }, { text: `Allowed: ${request.title || 'tool call'}`, tone: 'ok' }, hooks)),
    action('Deny', 'needs-you-card__secondary', () => void respond(chat.id, request, { decision: 'deny' }, { text: `Denied: ${request.title || 'tool call'}`, tone: 'muted' }, hooks)),
    action('Open chat', 'needs-you-card__link', () => hooks.openChat(chat.id, request.requestId)),
  );
  card.append(actions);
}

function buildCard(chat: Chat, request: ChatRequest, hooks: NeedsYouHooks): HTMLElement {
  const card = el('article', 'needs-you-card');
  card.dataset.requestId = request.requestId;
  card.dataset.chatId = chat.id;
  card.setAttribute('aria-label', `${request.kind === 'approval' ? 'Approval' : 'Question'} from ${chat.name}`);
  card.append(head(chat, request, hooks));
  if (request.kind === 'approval') approvalBody(card, chat, request, hooks);
  else questionBody(card, chat, request, hooks);
  const error = el('p', 'needs-you-card__error');
  error.setAttribute('role', 'status');
  card.append(error);
  return card;
}

/** A chat whose requests are still loading, or could not be read. */
function placeholderCard(chat: Chat, cache: RequestCache, hooks: NeedsYouHooks): HTMLElement {
  const card = el('article', 'needs-you-card needs-you-card--placeholder');
  card.dataset.chatId = chat.id;
  card.append(head(chat, null, hooks), el('p', 'needs-you-card__sub', cache.failed ? 'Waiting for your answer' : 'Loading…'));
  const actions = el('div', 'needs-you-card__actions');
  actions.append(action('Open chat', 'needs-you-card__primary', () => hooks.openChat(chat.id)));
  card.append(actions);
  return card;
}

function confirmationLine(id: string, item: Confirmation): HTMLElement {
  const line = el('div', `needs-you-done needs-you-done--${item.tone}`);
  line.dataset.requestId = id;
  line.setAttribute('role', 'status');
  line.append(createIcon('check', { size: 12 }), el('span', 'needs-you-done__text', item.text), el('span', 'needs-you-done__after', item.tone === 'ok' ? 'resuming' : 'agent notified'));
  return line;
}

/**
 * Rebuild the section in place. Cards are kept by request id, so a reply being
 * typed survives the sidebar repainting around it.
 */
export function syncSidebarNeedsYou(section: HTMLElement, chats: readonly Chat[], hooks: NeedsYouHooks): void {
  const nodes: HTMLElement[] = [];
  const live = new Set<string>();
  let openCount = 0;
  for (const chat of chats) {
    const ids = pendingIds(chat);
    if (!ids.length) continue;
    const cache = ensureRequests(chat, hooks);
    const requests = cache.requests.filter(request => request.state === 'pending' && ids.includes(request.requestId));
    if (!requests.length) {
      if (cache.loading || cache.failed) { nodes.push(placeholderCard(chat, cache, hooks)); openCount += ids.length; }
      continue;
    }
    for (const request of requests) {
      if (confirmations.has(request.requestId)) continue;
      openCount++;
      live.add(request.requestId);
      let card = cards.get(request.requestId);
      if (!card) { card = buildCard(chat, request, hooks); cards.set(request.requestId, card); }
      const pending = busy.has(request.requestId);
      card.setAttribute('aria-busy', String(pending));
      for (const control of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button:not(.needs-you-card__chat), input')) control.disabled = pending;
      const error = card.querySelector<HTMLElement>('.needs-you-card__error');
      if (error) error.textContent = errors.get(request.requestId) ?? '';
      nodes.push(card);
    }
  }
  for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);
  const now = Date.now();
  for (const [id, item] of confirmations) {
    if (item.until <= now) { doneLines.delete(id); continue; }
    let line = doneLines.get(id);
    if (!line) { line = confirmationLine(id, item); doneLines.set(id, line); }
    nodes.push(line);
  }

  section.hidden = nodes.length === 0;
  let header = section.querySelector<HTMLElement>(':scope > .needs-you__head');
  if (!header) {
    header = el('div', 'needs-you__head');
    header.append(el('span', 'needs-you__title', 'Needs you'), el('span', 'needs-you__count'));
  }
  const count = header.querySelector<HTMLElement>('.needs-you__count')!;
  count.textContent = String(openCount);
  count.hidden = openCount === 0;
  section.setAttribute('aria-label', openCount ? `Needs you, ${openCount} waiting` : 'Needs you');
  const desired = [header, ...nodes];
  if (desired.length !== section.children.length || desired.some((node, index) => section.children[index] !== node)) {
    section.replaceChildren(...desired);
  }
}
