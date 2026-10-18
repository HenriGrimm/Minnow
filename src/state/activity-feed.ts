import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { kindLabel } from '../notifications/preview';
import type { NotificationRecord } from '../notifications/types';
import type { Chat } from '../types';
import { formatAgentActivityStatusLine, type AgentActivityRow } from './agent-activity-registry';

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
  return row.status === 'pending_question' ? 'question' : 'running';
}

export function activityNeedsAttention(item: ActivityItem): boolean {
  return item.status === 'question' || (!item.resolved && (item.status === 'blocked' || item.status === 'failed'));
}

/** Count individual agents, including nested workers, rather than parent work items. */
export function getRunningAgentCount(feed: ActivityFeed): number {
  const active = new Set<string>();
  for (const item of feed.running) {
    if (!item.live) active.add(item.id);
    for (const row of [...(item.live ? [item.live] : []), ...item.children]) {
      if (row.status === 'queued' || row.status === 'waiting' || row.status === 'pending_question') continue;
      active.add(row.id);
    }
  }
  return active.size;
}

/** Project runtime snapshots and session outcomes into one row per piece of work. */
export function buildActivityFeed(input: ActivityFeedInput): ActivityFeed {
  const scope = normalizeWorkspacePath(input.workspacePath);
  const chats = new Map(input.chats.map((chat) => [chat.id, chat]));
  const inScope = (path?: string) => !scope || normalizeWorkspacePath(path ?? '') === scope;
  const items = new Map<string, ActivityItem>();
  const mainByChat = new Map<string, ActivityItem>();
  const scopedLive = input.live.filter((row) => inScope(chats.get(row.chatId)?.workspacePath));

  for (const row of scopedLive.filter((candidate) => candidate.kind === 'main_turn')) {
    const chat = chats.get(row.chatId);
    const run = [...(chat?.runs ?? [])].reverse().find((candidate) => candidate.status === 'running');
    const id = run ? `turn:${run.runId}` : row.id;
    const item: ActivityItem = {
      id, title: row.chatTitle, status: liveStatus(row), detail: formatAgentActivityStatusLine(row),
      source: row.label || 'Chat', timestamp: row.startedAtMs, chatId: row.chatId, live: row,
      children: [], notifications: [], unread: false, resolved: false, background: false,
    };
    items.set(id, item);
    mainByChat.set(row.chatId, item);
  }

  for (const chatId of input.pendingChatIds) {
    const existing = mainByChat.get(chatId);
    if (existing) {
      existing.status = 'question';
      existing.detail = 'Waiting for your input';
      continue;
    }
    const chat = chats.get(chatId);
    if (!chat || !inScope(chat.workspacePath)) continue;
    const run = [...(chat.runs ?? [])].reverse().find((candidate) => candidate.status === 'running');
    const item: ActivityItem = {
      id: run ? `turn:${run.runId}` : `main:${chatId}`, title: chat.name || 'Chat', status: 'question',
      detail: 'Waiting for your input', source: 'Chat', timestamp: chat.updatedAt ?? Date.now(), chatId,
      children: [], notifications: [], unread: false, resolved: false, background: false,
    };
    items.set(item.id, item);
    mainByChat.set(chatId, item);
  }

  for (const row of scopedLive.filter((candidate) => candidate.kind !== 'main_turn')) {
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
    item.unread ||= !record.read;
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
    item.resolved = record.resolved === true;
  }

  const all = [...items.values()];
  const attention = all.filter(activityNeedsAttention).sort((a, b) => Number(b.status === 'question') - Number(a.status === 'question') || b.timestamp - a.timestamp);
  const running = all.filter((item) => item.status === 'running' && !item.background).sort((a, b) => a.timestamp - b.timestamp);
  const background = all.filter((item) => item.status === 'running' && item.background);
  const recent = all.filter((item) => item.status !== 'running' && !activityNeedsAttention(item)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  return {
    attention, running, background, recent, runningCount: running.length + background.length,
    unreadCount: recent.filter((item) => item.unread).length,
  };
}
