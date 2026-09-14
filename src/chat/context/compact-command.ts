import { agentContextBudgetFromWorkAgent } from '../context-budget';
import { resolveActiveWorkAgent } from '../../agents/resolve-work-agent';
import { resolveWorkAgentContextPolicy } from '../resolve-context-policy';
import { resolveContextLimit } from '../context-usage';
import { renderChatFromHistory } from '../../ui/messages';
import { setStatus } from '../../ui/status';
import { getActiveChat, scheduleSaveSessions, touchChat } from '../../state/sessions';
import { isChatStreaming } from '../streaming-state';
import type { ApiMessage, Chat, ContextNoticeMessage } from '../../types';
import {
  compactMessages,
  formatCompactionStatus,
  latestCompactionCheckpoint,
  projectMessages,
  resolveCompactionConfig,
  transcriptRowsWithIds,
} from '../../../server/runner/compaction/index.js';
import { recordCompactionCheckpoint } from './context-notice';
import { parseCompactSlashInput } from './parse-compact-command';

export type CompactCommandDispatch = 'handled' | null;

export type CompactChatResult =
  | { ok: true; notice: ContextNoticeMessage; status: string }
  | { ok: false; reason: string };

/**
 * Write a manual checkpoint: fold every turn but the most recent ones into the
 * deterministic summary. History is never rewritten — the rows stay, and the
 * next send projects through the new `context` row. No completion call.
 */
export function compactChatHistory(
  chat: Chat,
  options: { notes?: string | null; modelId?: string | null } = {},
): CompactChatResult {
  const { rows, ids } = transcriptRowsWithIds<ApiMessage>(chat.history);
  if (rows.length === 0) return { ok: false, reason: 'Nothing to compact yet' };
  const latest = latestCompactionCheckpoint(chat.history);
  const agent = resolveActiveWorkAgent(chat);
  const agentConfig = agent ? agentContextBudgetFromWorkAgent(agent, resolveWorkAgentContextPolicy(agent.id)) : null;
  const windowTokens = options.modelId ? resolveContextLimit(options.modelId, chat) : null;
  const config = resolveCompactionConfig(agentConfig, windowTokens);

  const originals = new Map<number, ApiMessage>();
  rows.forEach((row, i) => originals.set(ids[i], row));
  const projected = projectMessages(rows, ids, latest?.checkpoint ?? null);
  const byRow = new Map<ApiMessage, number | null>();
  projected.messages.forEach((row, i) => byRow.set(row, projected.ids[i] ?? null));

  const out = compactMessages({
    messages: projected.messages,
    limit: Number.MAX_SAFE_INTEGER,
    window: windowTokens,
    config,
    prev: latest?.checkpoint ?? null,
    trigger: 'manual',
    notes: options.notes ?? null,
    idOf: (row) => byRow.get(row),
    originalOf: (id) => originals.get(id),
  });
  if (!out.changed || !out.checkpoint) {
    return {
      ok: false,
      reason: `Nothing to compact: the last ${config.recentTurns} turn${config.recentTurns === 1 ? '' : 's'} always stay in context`,
    };
  }
  const notice = recordCompactionCheckpoint(chat, {
    checkpoint: out.checkpoint,
    droppedTurns: out.droppedTurns,
    droppedRounds: out.droppedRounds,
    elidedRows: out.elidedRows,
    truncated: false,
    tokensBefore: out.tokensBefore,
    tokensAfter: out.tokensAfter,
  });
  touchChat(chat);
  return { ok: true, notice, status: formatCompactionStatus(out) };
}

/**
 * Handle `/compact [focus]` (aliases `/compress`, `/summarize`) before a normal send.
 */
export async function handleCompactCommand(
  chat: Chat,
  rawText: string,
  modelId?: string | null,
): Promise<CompactCommandDispatch> {
  const parsed = parseCompactSlashInput(rawText);
  if (!parsed) return null;

  if (isChatStreaming(chat.id)) {
    setStatus('err', 'Wait for the current reply to finish');
    return 'handled';
  }

  const result = compactChatHistory(chat, { notes: parsed.notes, modelId });
  if (!result.ok) {
    setStatus('err', result.reason);
    return 'handled';
  }
  scheduleSaveSessions();
  if (getActiveChat()?.id === chat.id) renderChatFromHistory(getActiveChat());
  setStatus('ok', result.status);
  return 'handled';
}
