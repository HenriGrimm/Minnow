import { sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { getViewWorkspacePath } from '../state/view-workspace';
import { streamingChatIds } from '../app-state';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { resolveLastTurnMetrics } from '../usage/chat-turn-metrics';
import { EMPTY_LEDGER_TOTALS, sumSessionLedgerTotals } from '../usage/token-ledger';
import { subscribePluginContextChanged } from './events';

/** Copies of metrics only: no messages, prompts, or connection credentials. */
export function getPluginChatUsage(chatId?: string) {
  const chat = sessionState?.chats.find(chat => chat.id === (chatId ?? sessionState?.activeId));
  const workspace = getViewWorkspacePath() || getWorkspacePath();
  if (!chat || !workspacePathsEqual(chat.workspacePath ?? '', workspace)) return null;
  const entry = chat.tokenLedger?.entries.at(-1);
  return structuredClone({
    chatId: chat.id,
    workspacePath: workspace,
    streaming: streamingChatIds.has(chat.id),
    totals: chat.tokenLedger?.totals ?? EMPTY_LEDGER_TOTALS,
    bySource: chat.tokenLedger?.bySource ?? {},
    current: resolveLastTurnMetrics(chat),
    latest: entry ? {
      id: entry.id, at: entry.at, source: entry.source,
      providerId: entry.providerId, modelId: entry.modelId,
      usage: entry.usage, stats: entry.stats ?? {}, costUsd: entry.costUsd,
    } : null,
  });
}

export function getPluginWorkspaceUsage() {
  const workspacePath = getViewWorkspacePath() || getWorkspacePath();
  const chats = sessionState?.chats.filter(chat => workspacePathsEqual(chat.workspacePath ?? '', workspacePath)) ?? [];
  return { workspacePath, chatCount: chats.length, totals: sumSessionLedgerTotals(chats) };
}

export type PluginChatUsage = ReturnType<typeof getPluginChatUsage>;

/** Initial snapshot plus coalesced changes; totals include completed requests only. */
export function subscribePluginChatUsage(listener: (usage: PluginChatUsage) => void, chatId?: string): () => void {
  let last = '';
  const emit = () => {
    const usage = getPluginChatUsage(chatId);
    const key = JSON.stringify(usage);
    if (key === last) return;
    last = key;
    listener(usage);
  };
  const unsubscribe = subscribePluginContextChanged(emit);
  try { emit(); } catch (error) { unsubscribe(); throw error; }
  return unsubscribe;
}
