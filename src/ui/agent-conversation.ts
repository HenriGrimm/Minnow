import type { Chat, UserMessage } from '../types';
import { findChatById, sessionState } from '../state/sessions';
import { agentChatStatusLabel, chatLink, chatReadOnlyReason, projectChatRelationships } from '../state/chat-relationships';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { getSubAgentRun } from '../agents/orchestrator';
import { apiMessageContentToText } from '../api/message-content';
import { syncAgentModelControls } from './managed-chat-model';
import { upsertPersistentAgentActivity } from './persistent-agent-activity';

const messageDisclosures = new Map<string, boolean>();
const contextByMount = new WeakMap<HTMLElement, { chatId: string; header: HTMLElement }>();

/** Preserve explicit focus during a same-chat history or metadata refresh. */
export function captureAgentConversationFocus(mount: HTMLElement | null, chatId: string): () => void {
  const active = document.activeElement as HTMLElement | null;
  if (!mount || !active || !mount.contains(active)) return () => {};
  const card = active.closest<HTMLElement>('.sub-agent-card--persistent');
  const context = active.closest<HTMLElement>('.agent-chat-context');
  const message = active.closest<HTMLElement>('.agent-message');
  const group = active.closest<HTMLElement>('.sub-agent-group');
  const requests = active.closest<HTMLElement>('.managed-chat-requests');
  const owner = card?.dataset.chatId ?? context?.dataset.chatId ?? message?.dataset.chatId ?? requests?.dataset.chatId ?? group?.dataset.agentGroupKey?.split(':')[0];
  if (owner !== chatId) return () => {};
  const href = active.getAttribute('href');
  const resultSummary = Boolean(active.closest('.sub-agent-card__result'));
  const groupSummary = active.parentElement?.classList.contains('sub-agent-group');
  return () => {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== active) return;
    let next: HTMLElement | null | undefined = active.isConnected ? active : null;
    if (!next && card) {
      const row = [...mount.querySelectorAll<HTMLElement>('.sub-agent-card--persistent')].find(node => node.dataset.runId === card.dataset.runId);
      next = row?.querySelector<HTMLElement>(resultSummary ? '.sub-agent-card__result > summary' : ':scope > a');
    } else if (!next && groupSummary && group) next = [...mount.querySelectorAll<HTMLElement>('.sub-agent-group')].find(node => node.dataset.agentGroupKey === group.dataset.agentGroupKey)?.querySelector<HTMLElement>(':scope > summary');
    else if (!next && message) next = [...mount.querySelectorAll<HTMLElement>('.agent-message')].find(node => node.dataset.messageId === message.dataset.messageId && node.dataset.historyIndex === message.dataset.historyIndex)?.querySelector<HTMLElement>(href ? 'summary a' : ':scope > summary');
    else if (!next && context && href) next = [...mount.querySelectorAll<HTMLElement>('.agent-chat-context a')].find(node => node.getAttribute('href') === href);
    else if (!next && requests) next = mount.querySelector<HTMLElement>('.managed-chat-request__status');
    next?.focus({ preventScroll: true });
  };
}

function chatAnchor(chatId: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a'); link.href = chatLink(chatId); link.textContent = label;
  link.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void import('../os/chat-launch').then(module => module.launchCodeWithChat(chatId)); });
  return link;
}

/** Context travels with the normal transcript and its existing composer. */
export function syncAgentConversationHeader(chat: Chat, mount: HTMLElement): void {
  let header = mount.querySelector<HTMLElement>(':scope > .agent-chat-context');
  const relation = chat.agentConversation;
  if (!relation) { header?.remove(); return; }
  const cached = contextByMount.get(mount);
  if (!header && cached?.chatId === chat.id) header = cached.header;
  if (!header) { header = document.createElement('section'); header.className = 'agent-chat-context'; header.setAttribute('aria-label', 'Agent conversation context'); }
  header.dataset.chatId = chat.id; contextByMount.set(mount, { chatId: chat.id, header });
  const restoreFocus = captureAgentConversationFocus(mount, chat.id);
  const parent = relation.parentChatId ? findChatById(relation.parentChatId) : undefined;
  const authority = (chat as Chat & { agentAuthority?: { modeId?: string; fileWriteScope?: string; toolPermissions?: Record<string, string> } }).agentAuthority;
  const key = JSON.stringify([chat.id, parent?.name, relation, chatReadOnlyReason(chat), agentChatStatusLabel(chat), authority]);
  if (header.dataset.contextKey !== key) {
    header.dataset.contextKey = key;
    const controls = header.querySelector<HTMLElement>('.agent-chat-context__controls') ?? document.createElement('div');
    controls.className = 'agent-chat-context__controls'; controls.dataset.agentChatControls = chat.id;
    header.replaceChildren();
    const heading = document.createElement('div'); heading.className = 'agent-chat-context__heading';
    const title = document.createElement('span'); title.textContent = parent ? `Subagent of ${parent.name}` : 'Subagent · parent unavailable';
    heading.append(title);
    if (relation.parentChatId) heading.append(chatAnchor(relation.parentChatId, 'Open parent'));
    header.append(heading);
    if (relation.origin === 'legacy_import') {
      const note = document.createElement('p'); note.className = 'agent-chat-context__policy'; note.textContent = 'Continued from partial saved context. The original task stays saved; this chat does not resume its execution.'; header.append(note);
    }
    const ancestors = sessionState ? projectChatRelationships(sessionState.chats).ancestors(chat.id) : [];
    if (ancestors.length > 1) {
      const path = document.createElement('nav'); path.className = 'agent-chat-context__path'; path.setAttribute('aria-label', 'Chat ancestors');
      const visible = ancestors.length > 4 ? [ancestors[0]!, ...ancestors.slice(-2)] : ancestors;
      visible.forEach((ancestor, i) => {
        if (i) path.append(document.createTextNode(ancestors.length > 4 && i === 1 ? ' › … › ' : ' › '));
        path.append(chatAnchor(ancestor.id, ancestor.name));
      });
      header.append(path);
    }
    const state = document.createElement('span'); state.className = 'agent-chat-context__state'; state.textContent = agentChatStatusLabel(chat); header.append(state);
    const policy = document.createElement('p'); policy.className = 'agent-chat-context__policy';
    const allowed = authority?.toolPermissions ? Object.values(authority.toolPermissions).filter(permission => permission !== 'off').length : null;
    policy.textContent = authority ? `Inherited ceiling: ${authority.modeId ?? 'saved mode'}${authority.fileWriteScope ? ` · file writes: ${authority.fileWriteScope}` : ''}${allowed !== null ? ` · ${allowed} tools available` : ''}. Current settings can restrict it further.` : 'Inherited permissions apply to this agent. Current settings can restrict them further.';
    header.append(policy);
    const hint = document.createElement('p'); hint.className = 'agent-chat-context__model-hint';
    hint.textContent = chatReadOnlyReason(chat) ?? 'Model changes apply to new messages. Queued messages keep their saved model.';
    header.append(hint, controls);
  }
  if (mount.firstElementChild !== header) mount.prepend(header);
  restoreFocus();
  syncAgentModelControls(chat, header.querySelector<HTMLElement>('.agent-chat-context__controls')!);
}

export function isAttributedAgentMessage(message: UserMessage): boolean {
  const provenance = message.provenance;
  return provenance?.version === 1 && ((provenance.actor === 'agent' && provenance.kind === 'peer_message') ||
    (provenance.actor === 'system' && provenance.kind === 'delegation_result'));
}

/** Typed authorship is visibly distinct from the human's own instruction. */
export function createAttributedAgentMessage(chat: Chat, message: UserMessage, historyIndex: number): HTMLElement {
  const content = apiMessageContentToText(message.content);
  const provenance = message.provenance!;
  const result = provenance.kind === 'delegation_result';
  const assignment = !result && provenance.runId && provenance.runId === chat.agentConversation?.initialRunId;
  const run = provenance.runId ? getSubAgentRun(provenance.runId) ?? chat.subAgentRuns?.find(row => row.runId === provenance.runId) : undefined;
  const sourceId = provenance.sourceChatId;
  const source = sourceId ? findChatById(sourceId) : undefined;
  const row = document.createElement('details'); row.className = `msg agent-message${result ? ' agent-message--result' : ''}`;
  row.dataset.historyIndex = String(historyIndex); row.dataset.chatId = chat.id; row.dataset.messageId = message.messageId ?? message.commandId ?? '';
  const key = `${chat.id}:${message.messageId ?? message.commandId ?? historyIndex}`;
  row.open = messageDisclosures.get(key) ?? false;
  row.addEventListener('toggle', () => { messageDisclosures.set(key, row.open); if (messageDisclosures.size > 1024) messageDisclosures.delete(messageDisclosures.keys().next().value!); });
  const summary = document.createElement('summary');
  const heading = document.createElement('span'); heading.className = 'agent-message__title'; heading.textContent = result ? sourceId ? 'Agent result from ' : 'Agent results' : assignment ? 'Assignment from ' : 'Message from ';
  if (sourceId) heading.append(chatAnchor(sourceId, source?.name || 'Unavailable chat'));
  else if (!result) heading.append(document.createTextNode('another chat'));
  const preview = document.createElement('span'); preview.className = 'agent-message__preview'; preview.textContent = content.trim().split('\n').find(Boolean)?.slice(0, 160) ?? '';
  const received = document.createElement('span'); received.className = 'agent-message__delivery'; received.textContent = result ? 'Published result' : 'Received';
  summary.append(heading, preview, received);
  if (typeof message.createdAt === 'number' && Number.isFinite(new Date(message.createdAt).getTime())) {
    const time = document.createElement('time'); time.dateTime = new Date(message.createdAt).toISOString(); time.title = new Date(message.createdAt).toLocaleString();
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); summary.append(time);
  }
  row.append(summary);
  const body = document.createElement('div'); body.className = 'agent-message__body msg-bubble';
  setAssistantBubbleContent(body, content, { modeId: chat.modeId }); row.append(body);
  if (result && run?.childChatId) {
    const task = document.createElement('button'); task.type = 'button'; task.className = 'agent-message__task-link'; task.textContent = 'View published task';
    task.addEventListener('click', () => {
      const mount = row.closest<HTMLElement>('.chat-area') ?? row.parentElement;
      if (!mount) return;
      const activity = upsertPersistentAgentActivity(run, chat.id, mount);
      if (!activity) return;
      const group = activity.closest<HTMLDetailsElement>('.sub-agent-group'); if (group) group.open = true;
      const resultView = activity.querySelector<HTMLDetailsElement>('.sub-agent-card__result'); if (resultView) resultView.open = true;
      activity.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); activity.querySelector<HTMLElement>(':scope > a')?.focus({ preventScroll: true });
    });
    body.append(task);
  }
  if (provenance.deliveryId) row.dataset.deliveryId = provenance.deliveryId;
  if (provenance.runId) row.dataset.runId = provenance.runId;
  return row;
}
