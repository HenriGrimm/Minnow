import { getChatRunActivity, subscribeChatRunActivity, type ChatRunActivityStatus } from '../state/chat-run-activity';
import { findChatById } from '../state/sessions';
import type { IssueCard } from '../types';
import { issueAgentCaption } from '../issues/work-state';
import { findIssueById } from '../state/issues-store';
import { subscribeIssueChatQuestions } from '../chat/issue-chat-host';

const captions: Record<ChatRunActivityStatus, string> = {
  running: 'Chat running', completed: 'Chat finished', failed: 'Chat failed',
  stopped: 'Chat stopped', interrupted: 'Chat interrupted',
};
let subscribed = false;
function paint(slot: HTMLElement): void {
  const ids = JSON.parse(slot.dataset.issueChatActivity ?? '[]') as string[];
  const states = ids.map((id) => getChatRunActivity(id, findChatById(id))).filter(Boolean) as ChatRunActivityStatus[];
  const status = states.includes('running') ? 'running' : states[0];
  slot.hidden = !status;
  slot.classList.toggle('is-running', status === 'running');
  slot.textContent = status ? captions[status] : '';
  slot.title = status === 'completed' ? 'The linked chat finished its turn. Completed implementation work moves to Review.' : slot.textContent;
}
function refresh(): void {
  document.querySelectorAll<HTMLElement>('[data-issue-agent-activity]').forEach((slot) => {
    const issue = findIssueById(slot.dataset.issueAgentActivity ?? '');
    if (issue) paintAgent(slot, issue);
  });
  document.querySelectorAll<HTMLElement>('[data-issue-chat-activity]').forEach(paint);
  document.querySelectorAll<HTMLElement>('[data-linked-chat-activity]').forEach((slot) => {
    const id = slot.dataset.linkedChatActivity ?? '';
    const status = getChatRunActivity(id, findChatById(id));
    slot.textContent = status ? captions[status].replace('Chat ', '') : 'Ready';
    slot.classList.toggle('is-running', status === 'running');
  });
}
function paintAgent(slot: HTMLElement, issue: IssueCard): void {
  const state = issueAgentCaption(issue);
  slot.textContent = state.text;
  slot.title = issue.agent?.error || state.text;
  slot.classList.toggle('is-running', state.tone === 'running');
  slot.classList.toggle('is-waiting', state.tone === 'waiting');
  slot.classList.toggle('is-failed', state.tone === 'failed');
  slot.classList.toggle('is-review', state.tone === 'review');
}
export function createIssueAgentActivity(issue: IssueCard): HTMLElement {
  if (!subscribed) { subscribed = true; subscribeChatRunActivity(refresh); subscribeIssueChatQuestions(refresh); }
  const slot = document.createElement('span');
  slot.className = 'issues-chat-activity';
  slot.dataset.issueAgentActivity = issue.id;
  slot.setAttribute('role', 'status');
  paintAgent(slot, issue);
  return slot;
}
export function createIssueChatActivity(issue: IssueCard): HTMLElement {
  if (!subscribed) { subscribed = true; subscribeChatRunActivity(refresh); subscribeIssueChatQuestions(refresh); }
  const slot = document.createElement('span');
  slot.className = 'issues-chat-activity';
  slot.setAttribute('role', 'status');
  // Most recently attached chat first; any live linked chat wins over terminal work.
  slot.dataset.issueChatActivity = JSON.stringify([...(issue.chatIds ?? [])].reverse());
  paint(slot);
  return slot;
}

export function paintLinkedChatActivity(slot: HTMLElement, chatId: string): void {
  slot.dataset.linkedChatActivity = chatId;
  const status = getChatRunActivity(chatId, findChatById(chatId));
  slot.textContent = status ? captions[status].replace('Chat ', '') : 'Ready';
  slot.classList.toggle('is-running', status === 'running');
}
