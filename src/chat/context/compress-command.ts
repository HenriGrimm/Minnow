import {
  agentContextBudgetFromWorkAgent,
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  SUMMARY_HEADER,
} from '../context-budget';
import { resolveActiveWorkAgent } from '../../agents/resolve-work-agent';
import { resolveWorkAgentContextPolicy } from '../resolve-context-policy';
import { getActiveProvider } from '../../providers/store';
import { renderChatFromHistory } from '../../ui/messages';
import { setStatus } from '../../ui/status';
import {
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../../state/sessions';
import { isChatStreaming } from '../streaming-state';
import type { Chat } from '../../types';
import { appendContextNoticeIfNeeded } from './context-notice';
import { planCompress, type CompressPlan } from './compress-plan';
import { summarizeDroppedTurns } from './llm-summarize';
import { parseCompressSlashInput } from './parse-compress-command';

export type CompressCommandDispatch = 'handled' | null;

function rebuildHistoryAfterCompress(chat: Chat, plan: CompressPlan, summaryBody: string): void {
  chat.history = [
    { role: 'user', content: `${SUMMARY_HEADER}${summaryBody.trim()}` },
    ...plan.kept,
  ];
  appendContextNoticeIfNeeded(chat, {
    policy: 'summarize',
    droppedTurns: plan.droppedTurns,
    summaryText: summaryBody,
  });
  touchChat(chat);
}

/**
 * Handle `/compress` (alias `/summarize`) before normal send.
 */
export async function handleCompressCommand(
  chat: Chat,
  rawText: string,
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<CompressCommandDispatch> {
  if (!parseCompressSlashInput(rawText)) return null;

  if (isChatStreaming(chat.id)) {
    setStatus('err', 'Wait for the current reply to finish');
    return 'handled';
  }

  const activeWorkAgent = resolveActiveWorkAgent(chat);
  const agentConfig = activeWorkAgent
    ? agentContextBudgetFromWorkAgent(
        activeWorkAgent,
        resolveWorkAgentContextPolicy(activeWorkAgent.id),
      )
    : { enforcementPolicy: DEFAULT_CONTEXT_ENFORCEMENT_POLICY };

  const minRecentTurns = Math.max(1, Math.floor(agentConfig.minRecentTurns ?? 2));
  const summaryReserveTokens = Math.max(
    64,
    Math.floor(agentConfig.summaryReserveTokens ?? 512),
  );

  const plan = planCompress(chat.history, minRecentTurns);
  if (!plan) {
    setStatus('err', `Need more than ${minRecentTurns} turns to compress`);
    return 'handled';
  }

  setStatus('spin', 'Compressing chat…');

  try {
    await getActiveProvider(providerId);
    const { summaryBody } = await summarizeDroppedTurns({
      droppedText: plan.droppedText,
      providerId,
      modelId,
      summaryReserveTokens,
      signal,
    });

    if (!summaryBody.trim()) {
      setStatus('err', 'Nothing to compress');
      return 'handled';
    }

    rebuildHistoryAfterCompress(chat, plan, summaryBody);
    scheduleSaveSessions();
    renderChatFromHistory(getActiveChat());
    setStatus('ok', 'Chat compressed');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      setStatus('err', 'Compress cancelled');
    } else {
      setStatus('err', 'Compress failed');
    }
  }

  return 'handled';
}
