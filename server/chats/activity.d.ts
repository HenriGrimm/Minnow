import type { Database } from 'better-sqlite3';
import type { ModelSelection, ChatExecutionState, ChatCommandState, ChatErrorCode } from './contracts.js';
export interface ChatActivityCursor { messageSeq: number; executionId: string | null }
export interface ChatActivityProjection {
  agentPresentationRevision?: number;
  agentExecution: null | { executionId: string; commandId: string | null; runId: string | null; status: ChatExecutionState;
    createdAt: number; updatedAt: number; settledAt: number | null; modelSelection?: ModelSelection; resolvedModel?: ModelSelection;
    contextUsage?: { used: number; limit: number | null; isEstimate: boolean } };
  agentPendingCommand: null | { commandId: string; runId: string | null; state: ChatCommandState; held: boolean; errorCode?: ChatErrorCode };
  agentRequestSummary: Array<{ requestId: string; kind: 'question' | 'approval' }>;
  agentActivityCursor: ChatActivityCursor;
  unread: boolean; turnError: boolean;
}
export function readChatActivity(db: Database, chatId: string): ChatActivityProjection | null;
