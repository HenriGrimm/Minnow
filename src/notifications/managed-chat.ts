import type { Chat } from '../types';
import type { PushNotificationInput } from './types';

interface Snapshot { executionId?: string; status?: string; requests: Set<string> }
interface Metadata { baseline?: boolean }
const terminal = new Set(['completed', 'failed', 'stopped', 'recovery_required']);

/** Notifications are transitions; the durable Activity view remains the reconnect baseline. */
export function createManagedChatNotificationProducer(options: {
  chats(): readonly Chat[];
  subscribe(listener: (chatId: string, metadata?: Metadata) => void): () => void;
  push(input: PushNotificationInput): unknown;
  pushOutcome(input: PushNotificationInput): unknown;
}): () => void {
  const snapshots = new Map<string, Snapshot>();
  const observed = new Set<string>();
  const capture = (chat: Chat): Snapshot => ({ executionId: chat.agentExecution?.executionId, status: chat.agentExecution?.status,
    requests: new Set(chat.agentRequestSummary?.map(row => row.requestId) ?? []) });
  function hear(chatId: string, metadata: Metadata = {}) {
    const chat = options.chats().find(row => row.id === chatId);
    if (!chat) { snapshots.delete(chatId); return; }
    const previous = snapshots.get(chatId), next = capture(chat);
    snapshots.delete(chatId); snapshots.set(chatId, next);
    while (snapshots.size > 512) snapshots.delete(snapshots.keys().next().value!);
    const baseline = metadata.baseline === true;
    const common = { title: chat.name?.trim() || 'Agent chat', chatId, appId: 'code' as const, workspacePath: chat.workspacePath };
    for (const request of chat.agentRequestSummary ?? []) {
      const key = `request:${request.requestId}`;
      if (!baseline && !previous?.requests.has(request.requestId) && !observed.has(key)) options.push({ ...common,
        kind: 'chat_question', activityId: key, parentActivityId: next.executionId ? `execution:${next.executionId}` : undefined,
        dedupeKey: key, preview: request.kind === 'approval' ? 'Your approval is needed.' : 'Your answer is needed.', os: true });
      observed.add(key);
    }
    if (chat.chatCommandVersion === 1 && next.executionId && terminal.has(next.status!)) {
      const key = `execution:${next.executionId}`;
      const transitioned = previous?.executionId !== next.executionId || !terminal.has(previous?.status ?? '');
      const awaitingAgents = next.status === 'completed' && (chat.agentTaskAttention?.pendingCount ?? 0) > 0;
      if (!baseline && transitioned && !awaitingAgents && !observed.has(key)) {
        const failed = next.status === 'failed' || next.status === 'recovery_required';
        options.pushOutcome({ ...common, activityId: key, dedupeKey: key,
          kind: failed ? 'chat_turn_error' : 'chat_turn_complete', activityStatus: next.status === 'stopped' ? 'stopped' : failed ? 'failed' : 'completed',
          preview: next.status === 'recovery_required' ? 'This conversation needs recovery.' : failed ? 'Agent reply failed.' : next.status === 'stopped' ? 'Reply stopped.' : 'Agent reply completed.',
          ...(typeof chat.agentExecution?.settledAt === 'number' ? { createdAt: chat.agentExecution.settledAt } : {}),
          os: next.status !== 'stopped', silent: next.status === 'stopped' });
      }
      observed.add(key);
    }
    while (observed.size > 4096) observed.delete(observed.values().next().value!);
  }
  for (const chat of options.chats()) hear(chat.id, { baseline: true });
  return options.subscribe(hear);
}
