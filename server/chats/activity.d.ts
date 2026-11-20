import type { Database } from 'better-sqlite3';
import type { ModelSelection, ChatExecutionState, ChatCommandState, ChatErrorCode } from './contracts.js';
export interface ChatActivityCursor { messageSeq: number; executionId: string | null }
/** Structured refusal facts for a failed turn; `error` keeps the sanitized one-line reason. */
export interface ChatExecutionFailure {
  kind?: 'quota' | 'rate_limit' | 'unavailable'; outcome?: 'timeout'; quotaExceeded?: true; providerUnreachable?: true;
  status?: number; code?: string; resetAt?: number; retryAt?: number; providerId?: string; modelId?: string;
}
export interface ChatActivityProjection {
  agentPresentationRevision?: number;
  agentTitleCandidate: null | { commandId: string; expectedName: string };
  agentExecution: null | { executionId: string; commandId: string | null; runId: string | null; status: ChatExecutionState;
    createdAt: number; updatedAt: number; settledAt: number | null; workDurationMs?: number; modelSelection?: ModelSelection; resolvedModel?: ModelSelection;
    contextUsage?: { used: number; limit: number | null; isEstimate: boolean }; error?: string; failure?: ChatExecutionFailure; needsManualRecovery?: true };
  agentPendingCommand: null | { commandId: string; runId: string | null; state: ChatCommandState; held: boolean; errorCode?: ChatErrorCode };
  agentRequestSummary: Array<{ requestId: string; kind: 'question' | 'approval' }>;
  agentActivityCursor: ChatActivityCursor;
  unread: boolean; turnError: boolean;
}
export function readChatActivity(db: Database, chatId: string): ChatActivityProjection | null;
