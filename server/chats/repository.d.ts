import type { Database } from 'better-sqlite3';
import type { TranscriptMessage, TranscriptRecord } from '../runner/transcript-store.js';
import type {
  AgentConversationMeta, AgentProfileReference, ChatCommand, ChatCommandState,
  ChatExecutionState, ChatRequest, ChatContractIssue,
} from './contracts.js';

export interface ExecutionFence { executionId: string; ownerId: string; epoch: number }
export interface ExecutionLease extends ExecutionFence { expiresAt: number; state?: 'active' | 'released' }
export interface ProfileInput extends AgentProfileReference { snapshot: Record<string, unknown> }
export interface ProfileRecord extends ProfileInput { chatId: string }
export interface ChatShell {
  id: string; name: string; workspacePath: string; providerId: string; modelId: string;
  modeId: string; groupId: string; worktreeRoot: string; gitBranch: string;
  updatedAt: number; lastMessageAt: number; messageCount: number; lastMessagePreview: string;
  historyDigest: string; revision: number; chatCommandVersion?: 1;
  projectId?: string;
  agentConversation?: AgentConversationMeta; profileReference?: AgentProfileReference;
  [key: string]: unknown;
}
export interface CommandRecord {
  position: number; commandId: string; producerId: string; requestKey: string; chatId: string;
  inputHash: string; command: ChatCommand; effectiveCommand: ChatCommand;
  captured: Record<string, unknown>; held: boolean;
  revision: number; state: ChatCommandState; executionId: string | null; runId: string | null;
  messageId: string | null; result: unknown; error: unknown; createdAt: number; updatedAt: number;
}
export interface ExecutionInput {
  executionId: string; chatId: string; commandId?: string; runId?: string; attemptId?: string;
  kind?: 'server' | 'renderer' | 'cli' | 'scheduler'; captured?: Record<string, unknown>;
}
export interface ExecutionRecord {
  executionId: string; chatId: string; commandId: string | null; runId: string | null;
  attemptId: string | null; kind: NonNullable<ExecutionInput['kind']>; status: ChatExecutionState;
  captured: Record<string, unknown>; result: unknown; createdAt: number; updatedAt: number; settledAt: number | null;
  activatedAt: number | null;
}
export interface OutboxInput { outboxId: string; chatId?: string | null; kind: string; payload: unknown }
export interface OutboxRecord {
  outboxId: string; chatId: string | null; kind: string; payload: unknown; payloadHash: string;
  state: 'pending' | 'applying' | 'applied' | 'failed'; attempts: number;
  ownerId: string | null; expiresAt: number | null; error: unknown; createdAt: number; updatedAt: number;
}
export interface ToolIntentInput {
  invocationId: string; chatId: string; executionId: string; toolCallId: string; toolName: string; input: unknown;
}
export interface ToolInvocation {
  invocationId: string; chatId: string; executionId: string; toolCallId: string;
  toolName: string; input: unknown; state: 'intent' | 'settled' | 'recovery_required'; result?: unknown;
}
export interface MessageAppendResult { rowId: number; messageId: string; revision: number; replayed: boolean }
export interface TranscriptSnapshot extends TranscriptRecord {
  rowIds: number[];
  compaction: import('../runner/compaction').CompactionCheckpoint | null;
}
export interface ListChatOptions { workspace?: string; projectId?: string; includeChildren?: boolean; afterPosition?: number; limit?: number }

export interface ChatRepository {
  /** Server-only domain repositories share this exact connection and its transactions. */
  getDatabase(): Database;
  getActivity(chatId: string): import('./activity.js').ChatActivityProjection;
  acknowledgeActivity(chatId: string, cursor: import('./activity.js').ChatActivityCursor): import('./activity.js').ChatActivityProjection;
  updateExecutionActivity(executionId: string, updates: { resolvedModel?: import('./contracts.js').ModelSelection;
    contextUsage?: { used: number; limit: number | null; isEstimate: boolean } }, options: { fence: ExecutionFence }): import('./activity.js').ChatActivityProjection;
  setAutoResumeBlocked(chatId: string, blocked: boolean): void;
  atomic<T>(work: (repository: ChatRepository) => T): T;
  createChat(input: { id: string; [key: string]: unknown }): ChatShell;
  createChild(input: {
    chat: { id: string; [key: string]: unknown }; relation: AgentConversationMeta; profile: ProfileInput;
    projectId?: string; command?: ChatCommand; producerId?: string; requestKey?: string; outbox?: OutboxInput[];
    captured?: Record<string, unknown>; spawnIntentHash?: string;
  }): { chat: ChatShell; command: (CommandRecord & { replayed: boolean }) | null; replayed: boolean };
  getChat(chatId: string): ChatShell;
  ensureManagedChat(chatId: string, options?: { profile?: ProfileInput; projectId?: string }): ChatShell;
  configureChat(chatId: string, patch: { providerId?: string; modelId?: string; modeId?: string; name?: string; pinned?: boolean }, options?: { expectedProfileVersion?: number; profile?: ProfileInput }): ChatShell;
  manageChat(chatId: string): ChatShell;
  getRelation(chatId: string): AgentConversationMeta | null;
  getChatProjectId(chatId: string): string | null;
  getTaskAttention(chatId: string): { status: 'waiting_for_agents'; pendingCount: number } | null;
  listActiveChatIds(options: { projectId: string; limit?: number }): string[];
  saveProfile(chatId: string, profile: ProfileInput): ProfileRecord;
  getProfile(profileId: string, profileVersion: number): ProfileRecord | null;
  getLatestProfile(chatId: string): ProfileRecord | null;
  listChats(options?: ListChatOptions): Array<Partial<ChatShell> & { id: string; position: number }>;
  listChatShells(options?: ListChatOptions): Array<Partial<ChatShell> & { id: string; position: number }>;
  admitCommand(command: ChatCommand, options: { producerId: string; requestKey?: string; captured?: Record<string, unknown> }): CommandRecord & { replayed: boolean };
  findCommandReceipt(producerId: string, requestKey: string): CommandRecord | null;
  getCommand(commandId: string): CommandRecord | null;
  listCommands(options?: { chatId?: string; states?: ChatCommandState[]; limit?: number }): CommandRecord[];
  updateCommand(commandId: string, update: {
    state?: ChatCommandState; executionId?: string; runId?: string; messageId?: string; result?: unknown; error?: unknown; held?: boolean;
  }, options?: { expectedRevision?: number }): CommandRecord;
  editQueuedCommand(commandId: string, update: { message: string; expectedRevision: number }): CommandRecord;
  promoteQueuedCommand(commandId: string, update: { expectedRevision: number; executionId?: string }): CommandRecord;
  holdQueuedCommands(chatId: string, options?: { throughPosition?: number }): number;
  requeueUnconsumedSteers(chatId: string, executionId: string, options?: { held?: boolean }): number;
  createExecution(input: ExecutionInput): ExecutionRecord;
  getExecution(executionId: string): ExecutionRecord | null;
  findAttemptExecution(runId: string, attemptId: string): ExecutionRecord | null;
  markExecutionActivated(executionId: string, options: { fence: ExecutionFence }): ExecutionRecord;
  getLatestExecution(chatId: string): ExecutionRecord | null;
  listExecutions(options?: { chatId?: string; statuses?: ChatExecutionState[]; limit?: number }): ExecutionRecord[];
  claimExecution(input: ExecutionInput & { ownerId: string; leaseMs?: number }): ExecutionLease;
  getLease(chatId: string): ExecutionLease | null;
  renewLease(chatId: string, fence: ExecutionFence, leaseMs?: number): ExecutionLease;
  releaseLease(chatId: string, fence: ExecutionFence): void;
  updateExecution(executionId: string, update: { status?: ChatExecutionState; result?: unknown }, options: { fence: ExecutionFence }): ExecutionRecord;
  recoverExecution(executionId: string, options: {
    fence: ExecutionFence;
    quiescence: { verified: true; source: string; checkedAt: number; [key: string]: unknown };
    status?: 'failed' | 'stopped';
  }): ExecutionRecord;
  assertFence(chatId: string, fence: ExecutionFence): unknown;
  appendMessage(chatId: string, message: TranscriptMessage, options: {
    fence: ExecutionFence; messageId?: string; commandId?: string;
  }): MessageAppendResult;
  patchMessage(chatId: string, rowId: number, patch: Partial<TranscriptMessage>, options: {
    fence: ExecutionFence; expectedHash?: string;
  }): { rowId: number; messageId: string; revision: number };
  readMessage(chatId: string, rowId: number): { rowId: number; message: TranscriptMessage; rowHash: string } | null;
  readMessageByIdentity(chatId: string, messageId: string): { rowId: number; message: TranscriptMessage; rowHash: string } | null;
  readTranscript(chatId: string): TranscriptSnapshot | null;
  /** Trusted system-result admission, only while the managed transcript is quiescent. */
  appendAdmittedResult(commandId: string): MessageAppendResult;
  importContext(chatId: string, input: { messageId: string; content: string; createdAt: number; sourceParentChatId: string; sourceRunId: string }): MessageAppendResult;
  readExecutionFinalAssistant(executionId: string): string;
  setTranscriptMeta(chatId: string, updates: Record<string, unknown>, options: { fence: ExecutionFence }): { revision: number };
  saveRequest(request: ChatRequest, options: { fence: ExecutionFence }): ChatRequest;
  saveLegacyRequest(request: ChatRequest, options: { assertOwner(): boolean }): ChatRequest;
  getRequest(requestId: string): ChatRequest | null;
  listRequests(chatId: string, state?: ChatRequest['state'] | null): ChatRequest[];
  listRequestPresentation(chatId: string, options?: { afterRequestId?: string; limit?: number; recentLimit?: number }): {
    requests: ChatRequest[]; pendingCount: number; nextCursor: string | null; truncated: boolean;
  };
  settleRequest(requestId: string, update: { state: Exclude<ChatRequest['state'], 'pending'>; settledAt?: number; answerCommandId?: string }): ChatRequest;
  respondToRequest(requestId: string, input: { answerCommandId: string; answer: unknown; settledAt?: number }): { request: ChatRequest; answer: unknown; replayed: boolean };
  readRequestAnswer(requestId: string): unknown;
  recordToolIntent(input: ToolIntentInput, options: { fence: ExecutionFence }): { invocationId: string; state: ToolInvocation['state']; result: unknown; replayed: boolean };
  settleToolInvocation(invocationId: string, result: unknown, options: { fence: ExecutionFence }): { invocationId: string; state: 'settled'; result: unknown };
  getToolInvocation(invocationId: string): ToolInvocation | null;
  listUnsettledToolInvocations(executionId: string): ToolInvocation[];
  getCancellationEpoch(chatId: string): number;
  advanceCancellationEpoch(chatId: string, options?: { expectedEpoch?: number }): number;
  putOutbox(input: OutboxInput): OutboxRecord & { replayed: boolean };
  getOutbox(outboxId: string): OutboxRecord | null;
  listOutbox(options?: { states?: OutboxRecord['state'][]; limit?: number }): OutboxRecord[];
  claimOutbox(outboxId: string, ownerId: string, leaseMs?: number): OutboxRecord | null;
  finishOutbox(outboxId: string, claim: { ownerId: string | null; attempts: number }, error?: ChatContractIssue | null): OutboxRecord;
}
export function hashChatPayload(value: unknown): string;
export function createChatRepository(options?: { db?: Database; now?: () => number }): ChatRepository;
