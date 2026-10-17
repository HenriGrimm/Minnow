import type { Chat, IssueCard, IssueActivityEntry } from '../types';
import { isIssueChatQuestionPending } from '../chat/issue-chat-host';
import { findChatById } from '../state/sessions';
import { getChatRunActivity, type ChatRunActivityStatus } from '../state/chat-run-activity';

export function linkedIssueChats(issue: IssueCard): Chat[] {
  const ids = [...(issue.chatIds ?? [])];
  if (issue.agent?.chatId && !ids.includes(issue.agent.chatId)) ids.push(issue.agent.chatId);
  return ids.map((id) => findChatById(id)).filter((chat): chat is Chat => Boolean(chat));
}

export function issueWorkChat(issue: IssueCard): Chat | undefined {
  const chats = linkedIssueChats(issue).reverse();
  return chats.find((chat) => getChatRunActivity(chat.id, chat) === 'running') ?? chats[0];
}

export function issueDelivery(issue: IssueCard): IssueActivityEntry | undefined {
  const events = [...(issue.activity ?? [])].reverse();
  const latest = events.find((entry) => entry.kind === 'work-merged' || entry.kind === 'chat-started');
  return latest?.kind === 'work-merged' ? latest : undefined;
}

export function issueAgentCaption(issue: IssueCard): { text: string; tone: string; status?: ChatRunActivityStatus } {
  const chat = issueWorkChat(issue);
  const status = chat ? getChatRunActivity(chat.id, chat) : null;
  if (issue.agent?.phase === 'awaiting_input' || chat && isIssueChatQuestionPending(chat.id)) return { text: 'Needs input', tone: 'waiting' };
  if (status === 'running') return { text: 'Working', tone: 'running', status };
  if (issue.agent?.phase === 'running' || issue.agent?.phase === 'queued') return { text: issue.agent.step || (issue.agent.phase === 'running' ? 'Working' : 'Queued'), tone: 'running' };
  if (status === 'failed' || status === 'stopped' || status === 'interrupted') return { text: status === 'failed' ? 'Chat failed' : status === 'stopped' ? 'Stopped' : 'Interrupted', tone: 'failed', status };
  const delivery = issueDelivery(issue);
  if (delivery && (!chat || delivery.data?.chatId === chat.id)) return { text: 'Merged', tone: 'review' };
  if (status === 'completed') return { text: 'Chat finished', tone: 'review', status };
  if (issue.agent) return { text: issue.agent.step || issue.agent.phase.replace(/_/g, ' '), tone: issue.agent.phase };
  return { text: chat ? 'Ready' : '—', tone: '' };
}
