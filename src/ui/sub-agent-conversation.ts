import { apiMessageContentToText } from '../api/message-content';
import type { ApiMessageContent, Chat, Message, PersistedSubAgentRun } from '../types';
import type { SubAgentRun } from '../agents/types';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';
import { assistantTranscriptThinkingSegments } from './transcript-view';
import { createEmbeddedChatTranscript } from './embedded-chat-transcript';
import type { SubAgentTranscriptLive } from './sub-agent-live-status';

/** Adapt older journal/API rows to chat history for presentation only. */
function legacySubAgentChat(run: SubAgentRun | PersistedSubAgentRun, messages: unknown[], workspacePath: string, summary?: string): Chat {
  const history: Message[] = [];
  const hasAssignment = messages.some(raw => (raw as Message | null)?.role === 'user');
  const offset = hasAssignment || !run.task ? 0 : 1;
  if (offset) history.push({ role: 'user', content: run.task });
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Message & Record<string, unknown>;
    if (row.role === 'assistant') {
      const thinking = assistantTranscriptThinkingSegments(row);
      history.push({ ...row, content: apiMessageContentToText(row.content), thinking });
    } else if (row.role === 'context' && row.compaction?.foldThroughIndex != null && offset) {
      history.push({ ...row, compaction: { ...row.compaction, foldThroughIndex: row.compaction.foldThroughIndex + offset } });
    } else if (row.role === 'user' || row.role === 'tool' || row.role === 'context' || row.role === 'injection') {
      history.push(row);
    }
  }
  if (summary && !subAgentFinalResponse(history)) {
    history.push({ role: 'assistant', content: summary, ...(run.status === 'failed' ? { failed: true as const }
      : run.status === 'cancelled' ? { stopped: true } : {}) });
  }
  return { id: run.runId, name: run.title || run.type, workspacePath, modelId: run.modelId ?? '', history,
    updatedAt: 0, lastStats: null, modelInfo: {} };
}

export function createLegacySubAgentTranscript(transcript: ReturnType<typeof createEmbeddedChatTranscript>, workspacePath: string) {
  let cached: { chat: Chat; metadata: string; messages: unknown[] } | undefined;
  return (run: SubAgentRun | PersistedSubAgentRun, live?: SubAgentTranscriptLive) => {
    let messages = run.messages ?? [];
    const tail = messages.at(-1) as Record<string, unknown> | undefined;
    // The legacy stream also mirrors the open thought into its last journal row.
    if (live?.partialReasoning && tail?.role === 'assistant' && !tail.content && !tail.tool_calls
        && assistantTranscriptThinkingSegments(tail).join('\n').trim() === live.partialReasoning.trim()) {
      messages = messages.slice(0, -1);
    }
    const summary = !live && (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
      ? run.structuredOutcome?.summary ?? legacyOutcomeFromSummary(run.summary ?? '')?.summary : undefined;
    const metadata = JSON.stringify([run.runId, run.task, run.status, summary]);
    if (!cached || cached.metadata !== metadata || cached.messages.length !== messages.length ||
        cached.messages.some((row, index) => row !== messages[index] && JSON.stringify(row) !== JSON.stringify(messages[index]))) {
      cached = { metadata, messages, chat: legacySubAgentChat(run, messages, workspacePath, summary) };
    }
    const partial = live ? {
      phase: live.phase,
      currentTool: live.currentToolName,
      lastThinking: live.partialReasoning,
      lastDelta: live.partialText,
    } : undefined;
    const pendingToolStatus = run.status === 'cancelled' || run.status === 'failed' ? 'stopped' : undefined;
    transcript.sync(cached.chat, partial, pendingToolStatus);
  };
}

/** Only prose after the last tool call can be the agent's final response. */
export function subAgentFinalResponse(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i] as Record<string, unknown> | null;
    if (!row || row.role !== 'assistant') continue;
    if (Array.isArray(row.tool_calls) && row.tool_calls.length) return '';
    const text = apiMessageContentToText(row.content as ApiMessageContent).trim();
    if (text) return text;
  }
  return '';
}
