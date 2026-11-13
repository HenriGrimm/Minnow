/**
 * Show Activity records as notification cards. The record is the durable
 * copy (the bell); the card is the short-lived view that opens its source.
 */

import { isAskQuestionDomVisible, subscribeAskQuestionDisplayContext } from '../chat/ask-question-display';
import { getAppById } from '../os/app-registry';
import { getOsView } from '../os/instances';
import { sessionState } from '../state/sessions';
import type { IconName } from '../ui/icon';
import { getSharedChatHost } from '../ui/shared-chat-host-state';
import type { NotifyAction, NotifyHandle, NotifyOptions, NotifyTone } from '../ui/toast';
import { onNewNotification } from './push';
import { subscribeNotifications } from './store';
import type { NotificationKind, NotificationRecord } from './types';

interface CardKind {
  tone: NotifyTone;
  icon: IconName;
  /** Card title; omitted kinds use the record's own title. */
  label?: string;
  action?: string;
}

/**
 * Kinds that earn a card. The rest (starts, routine completions, Brain
 * captures that already show a memory card, device requests with their own
 * card) stay in Activity only.
 */
const CARD_KINDS: Partial<Record<NotificationKind, CardKind>> = {
  chat_turn_complete: { tone: 'success', icon: 'appChat', label: 'Agent finished' },
  chat_turn_error: { tone: 'error', icon: 'appChat', label: 'Turn failed' },
  chat_question: { tone: 'attention', icon: 'help', label: 'The agent has a question', action: 'Answer' },
  agent_wait: { tone: 'attention', icon: 'clock', label: 'The agent is waiting on you', action: 'Open chat' },
  sub_agent_failed: { tone: 'error', icon: 'boardView', label: 'Sub-agent stopped' },
  task_failed: { tone: 'error', icon: 'boardView', label: 'Task failed' },
  task_quarantined: { tone: 'error', icon: 'boardView', label: 'Task set aside' },
  board_complete: { tone: 'success', icon: 'boardView', label: 'Board finished' },
  board_blocked: { tone: 'attention', icon: 'boardView', label: 'Board is blocked', action: 'Open board' },
  provider_quota: { tone: 'error', icon: 'metricCtx' },
  issue_agent_question: { tone: 'attention', icon: 'appIssues', label: 'The issue agent has a question', action: 'Answer' },
  issue_agent_pr: { tone: 'success', icon: 'gitPullRequest', label: 'Pull request opened' },
  issue_agent_failed: { tone: 'error', icon: 'appIssues', label: 'Issue agent failed' },
  scheduler: { tone: 'info', icon: 'appScheduler' },
};

/** Card options for a record, or null when the kind stays in Activity only. */
export function notificationCardOptions(
  record: NotificationRecord,
  open: (record: NotificationRecord) => void,
): NotifyOptions | null {
  const kind = CARD_KINDS[record.kind];
  if (!kind) return null;
  const source = getAppById(record.appId)?.name ?? 'Minnow';
  const title = kind.label ?? record.title;
  const context = kind.label && record.title !== source ? record.title : undefined;
  const actions: NotifyAction[] = kind.action
    ? [{ label: kind.action, variant: 'primary', run: () => open(record) }]
    : [];
  return {
    tone: kind.tone,
    icon: kind.icon,
    source,
    context,
    title,
    message: record.preview,
    dedupeKey: `activity:${record.dedupeKey ?? record.id}`,
    open: () => open(record),
    openLabel: record.chatId ? 'Open chat' : `Open ${source}`,
    actions,
  };
}

let stop: (() => void) | null = null;

function shouldDismissCard(record: NotificationRecord): boolean {
  if (record.resolved) return true;
  if (record.kind !== 'chat_question' && record.kind !== 'issue_agent_question') return false;
  if (!record.chatId) return false;
  const shared = getSharedChatHost(record.chatId);
  if (shared) {
    const { shell } = shared;
    const layer = shell.closest('.mn-os-app-layer');
    return shell.isConnected && !shell.closest('[hidden], [inert]') &&
      (!layer || layer.classList.contains('is-active'));
  }
  if (document.documentElement.classList.contains('mn-mobile-app') || getOsView() === 'workspaces') return false;
  return Boolean(sessionState?.chats.length && isAskQuestionDomVisible(record.chatId));
}

/** Raise a card for each new unread Activity record (call once from main.ts). */
export function initNotificationCards(): () => void {
  if (stop) return stop;
  const handles = new Map<NotificationRecord, NotifyHandle>();
  let disposed = false;
  const syncCards = () => {
    for (const [record, handle] of handles) {
      if (handle.isOpen && shouldDismissCard(record)) handle.dismiss();
      if (!handle.isOpen) handles.delete(record);
    }
  };
  const unsubscribe = subscribeNotifications(syncCards);
  const unsubscribeDisplay = subscribeAskQuestionDisplayContext(syncCards);
  const dispose = onNewNotification((record) => {
    const openTarget = (target: NotificationRecord) => {
      void import('./navigate').then((m) => m.openNotificationTarget(target));
    };
    const options = notificationCardOptions(record, openTarget);
    if (!options) return;
    void import('../ui/toast').then(({ notify }) => {
      if (disposed || shouldDismissCard(record)) return;
      const handle = notify(options);
      if (handle) handles.set(record, handle);
    });
  });
  stop = () => {
    disposed = true;
    dispose();
    unsubscribe();
    unsubscribeDisplay();
    for (const handle of handles.values()) handle.dismiss();
    handles.clear();
    stop = null;
  };
  return stop;
}
