import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { kindLabel } from '../notifications/preview';
import type { NotificationRecord } from '../notifications/types';
import type { Chat } from '../types';
import { countRunningAgentRows, formatAgentActivityStatusLine, type AgentActivityRow } from './agent-activity-registry';

export type ActivityStatus = 'running' | 'question' | 'blocked' | 'failed' | 'completed' | 'stopped';

export interface ActivityItem {
  id: string;
  title: string;
  status: ActivityStatus;
  detail: string;
  source: string;
  timestamp: number;
  chatId?: string;
  live?: AgentActivityRow;
  children: AgentActivityRow[];
  notifications: NotificationRecord[];
  unread: boolean;
  resolved: boolean;
  background: boolean;
  requestId?: string;
  requestKind?: 'question' | 'approval';
  activityCursor?: Chat['agentActivityCursor'];
}

export interface ActivityFeed {
  attention: ActivityItem[];
  running: ActivityItem[];
  background: ActivityItem[];
  recent: ActivityItem[];
  runningCount: number;
  unreadCount: number;
}

export interface ActivityFeedInput {
  chats: readonly Chat[];
  live: readonly AgentActivityRow[];
  notifications: readonly NotificationRecord[];
  pendingChatIds: ReadonlySet<string>;
  workspacePath: string;
}

const QUESTIONS = new Set(['chat_question', 'issue_agent_question']);
const FAILURES = new Set(['chat_turn_error', 'task_failed', 'sub_agent_failed', 'issue_agent_failed']);
const BLOCKED = new Set(['task_quarantined', 'board_blocked', 'provider_quota', 'issue_agent_pr']);

function notificationStatus(record: NotificationRecord): ActivityStatus {
  if (record.activityStatus) return record.activityStatus;
  if (QUESTIONS.has(record.kind)) return 'question';
  if (FAILURES.has(record.kind)) return 'failed';
  if (BLOCKED.has(record.kind)) return 'blocked';
  return 'completed';
}

function liveStatus(row: AgentActivityRow): ActivityStatus {
  if (row.status === 'pending_question' || row.status === 'pending_approval') return 'question';
  if (row.status === 'recovery_required') return 'blocked';
  if (row.status === 'failed' || row.status === 'completed' || row.status === 'stopped') return row.status;
  return 'running';
}

export function activityNeedsAttention(item: ActivityItem): boolean {
  return item.status === 'question' || (!item.resolved && (item.status === 'blocked' || item.status === 'failed'));
}

/** Count individual agents, including nested workers, rather than parent work items. */
export function getRunningAgentCount(feed: ActivityFeed): number {
  const items = [...feed.running, ...feed.background];
  return countRunningAgentRows(items.flatMap(item => [...(item.live ? [item.live] : []), ...item.children])) + items.filter(item => !item.live).length;
}

/** Project runtime snapshots and session outcomes into one row per piece of work. */
export function buildActivityFeed(input: ActivityFeedInput): ActivityFeed {
  const scope = normalizeWorkspacePath(input.workspacePath);
  const chats = new Map(input.chats.map((chat) => [chat.id, chat]));
  const inScope = (path?: string) => !scope || normalizeWorkspacePath(path ?? '') === scope;
  const items = new Map<string, ActivityItem>();
  const mainByChat = new Map<string, ActivityItem>();
  const scopedLive = input.live.filter((row) => inScope(chats.get(row.chatId)?.workspacePath));

  for (const row of scopedLive.filter((candidate) => candidate.kind === 'main_turn' || candidate.kind === 'agent_chat')) {
    const chat = chats.get(row.chatId);
    const run = [...(chat?.runs ?? [])].reverse().find((candidate) => candidate.status === 'running');
    const id = row.kind === 'agent_chat' ? row.id : run ? `turn:${run.runId}` : row.id;
    const item: ActivityItem = {
      id, title: row.chatTitle, status: liveStatus(row), detail: formatAgentActivityStatusLine(row),
      source: row.label || 'Chat', timestamp: row.updatedAtMs ?? row.startedAtMs, chatId: row.chatId, live: row,
      children: [], notifications: [], unread: row.unread === true, resolved: false, background: false,
      requestId: row.requestIds?.[0], activityCursor: row.activityCursor,
      requestKind: chat?.agentRequestSummary?.find(request => request.requestId === row.requestIds?.[0])?.kind,
    };
    items.set(id, item);
    if (!mainByChat.has(row.chatId) || item.status === 'running' || item.status === 'question') mainByChat.set(row.chatId, item);
  }

  for (const chatId of input.pendingChatIds) {
    const existing = mainByChat.get(chatId);
    if (existing) {
      existing.status = 'question';
      existing.detail = existing.live?.status === 'pending_approval' ? 'Needs approval' : 'Waiting for your input';
      continue;
    }
    const chat = chats.get(chatId);
    if (!chat || !inScope(chat.workspacePath)) continue;
    const run = [...(chat.runs ?? [])].reverse().find((candidate) => candidate.status === 'running');
    const item: ActivityItem = {
      id: run ? `turn:${run.runId}` : `main:${chatId}`, title: chat.name || 'Chat', status: 'question',
      detail: chat.agentRequestSummary?.some(request => request.kind === 'approval') ? 'Needs approval' : 'Waiting for your input', source: 'Chat', timestamp: chat.updatedAt ?? Date.now(), chatId,
      children: [], notifications: [], unread: false, resolved: false, background: false,
      requestId: chat.agentRequestSummary?.[0]?.requestId, requestKind: chat.agentRequestSummary?.[0]?.kind,
    };
    items.set(item.id, item);
    mainByChat.set(chatId, item);
  }

  for (const row of scopedLive.filter((candidate) => candidate.kind !== 'main_turn' && candidate.kind !== 'agent_chat')) {
    const parent = mainByChat.get(row.chatId);
    if (row.kind === 'sub_agent' && parent) {
      parent.children.push(row);
      continue;
    }
    const id = row.kind === 'sub_agent' && row.chatId ? `agents:${row.chatId}` : row.id;
    const existing = items.get(id);
    if (existing) {
      existing.children.push(row);
      continue;
    }
    items.set(id, {
      id, title: row.kind === 'title_job' ? 'Naming chat' : row.chatTitle, status: liveStatus(row),
      detail: formatAgentActivityStatusLine(row), source: row.label, timestamp: row.startedAtMs,
      chatId: row.chatId, live: row, children: row.kind === 'sub_agent' ? [row] : [],
      notifications: [], unread: false, resolved: false, background: row.kind === 'title_job',
    });
  }

  for (const record of [...input.notifications].sort((a, b) => Number(a.kind.startsWith('sub_agent_')) - Number(b.kind.startsWith('sub_agent_')) || a.createdAt - b.createdAt)) {
    if (!inScope(record.workspacePath ?? chats.get(record.chatId ?? '')?.workspacePath)) continue;
    const status = notificationStatus(record);
    const isQuestion = status === 'question';
    if (record.activityId?.startsWith('sub:') && input.chats.some(chat => chat.subAgentRuns?.some(run => Boolean(run.childChatId) && record.activityId === `sub:${run.runId}`))) continue;
    const parent = record.parentActivityId ? items.get(record.parentActivityId) : undefined;
    const liveParent = record.chatId ? mainByChat.get(record.chatId) : undefined;
    const nested = record.kind === 'sub_agent_complete' || record.kind === 'sub_agent_failed';
    const id = parent?.id ?? ((isQuestion || (nested && !record.parentActivityId)) && liveParent ? liveParent.id : record.activityId ?? record.id);
    let item = items.get(id);
    if (isQuestion && !input.pendingChatIds.has(record.chatId ?? '') && !item) continue;
    if (!item) {
      item = {
        id, title: record.title, status, detail: record.preview, source: kindLabel(record.kind),
        timestamp: record.createdAt, chatId: record.chatId, children: [], notifications: [],
        unread: false, resolved: record.resolved === true, background: false,
      };
      items.set(id, item);
    }
    item.notifications.push(record);
    const canonicalChat = record.chatId ? chats.get(record.chatId) : undefined;
    const canonicalOutcome = record.activityId === `execution:${canonicalChat?.agentExecution?.executionId}` && canonicalChat?.chatCommandVersion === 1;
    item.unread ||= canonicalOutcome ? canonicalChat.unread === true : !record.read;
    if (canonicalOutcome && !canonicalChat.turnError && !canonicalChat.unread && ['failed', 'recovery_required'].includes(canonicalChat.agentExecution!.status)) item.resolved = true;
    if (isQuestion && input.pendingChatIds.has(record.chatId ?? '')) {
      item.detail = record.preview;
      if (!item.live) item.timestamp = record.createdAt;
    }
    if (item.live || mainByChat.get(item.chatId ?? '') === item) continue;
    if (nested && parent) continue;
    if (isQuestion && !input.pendingChatIds.has(record.chatId ?? '')) continue;
    item.title = record.title;
    item.status = status;
    item.detail = record.preview;
    item.source = kindLabel(record.kind);
    item.timestamp = record.createdAt;
    item.resolved ||= record.resolved === true;
  }

  const all = [...items.values()];
  const completedByChat = new Map<string, number>();
  for (const item of all) {
    if (!item.chatId || item.status !== 'completed' || !item.notifications.some((record) => record.kind === 'chat_turn_complete' && notificationStatus(record) === 'completed')) continue;
    completedByChat.set(item.chatId, Math.max(completedByChat.get(item.chatId) ?? -Infinity, item.timestamp));
  }
  for (const item of all) {
    // A successful later reply supersedes chat errors, not unrelated task or review alerts.
    if (item.status === 'failed' && item.chatId && item.notifications.every((record) => record.kind === 'chat_turn_error') && (completedByChat.get(item.chatId) ?? -Infinity) > item.timestamp) {
      item.resolved = true;
    }
  }
  const attention = all.filter(activityNeedsAttention).sort((a, b) => Number(b.status === 'question') - Number(a.status === 'question') || b.timestamp - a.timestamp);
  const running = all.filter((item) => item.status === 'running' && !item.background).sort((a, b) => a.timestamp - b.timestamp);
  const background = all.filter((item) => item.status === 'running' && item.background);
  const recent = all.filter((item) => item.status !== 'running' && !activityNeedsAttention(item)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  return {
    attention, running, background, recent, runningCount: running.length + background.length,
    unreadCount: recent.filter((item) => item.unread).length,
  };
}
