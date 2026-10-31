export const CHAT_CONTRACT_VERSION: 1;
export const AGENT_CONVERSATIONS_CAPABILITY: 'agentConversationsV1';

export type ChatActor = 'human' | 'agent' | 'system';
export type ChatMessageSource = 'composer' | 'agent_tool' | 'task_delivery'
  | 'scheduler' | 'cli' | 'device' | 'migration';
export type ChatMessageKind = 'human_message' | 'peer_message' | 'delegation_result';
export type ChatCommandKind = 'send' | 'steer' | 'stop' | 'edit_queued'
  | 'remove_queued' | 'push_queued';
export type ChatCommandState = 'accepted' | 'queued' | 'waiting_for_host'
  | 'running' | 'settled' | 'failed' | 'cancelled';
export type ChatExecutionState = 'queued' | 'waiting_for_host' | 'waiting_for_model'
  | 'loading_model' | 'running' | 'waiting' | 'waiting_for_agents' | 'waiting_for_input'
  | 'waiting_for_approval' | 'stopping' | 'completed' | 'failed' | 'stopped'
  | 'recovery_required';
export type ChatDisposition = 'accepted' | 'queued' | 'started' | 'steered'
  | 'stopping' | 'settled' | 'waiting_for_host';
export type ChatRequestKind = 'question' | 'approval';
export type ChatRequestState = 'pending' | 'answered' | 'expired' | 'cancelled';
export type ChatTaskTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ChatErrorCode = 'invalid_request' | 'unsupported_version' | 'capability_disabled'
  | 'capability_unavailable' | 'caller_not_active' | 'caller_denied' | 'policy_denied'
  | 'workspace_denied' | 'cross_project_denied' | 'chat_not_found' | 'task_not_found'
  | 'command_not_found' | 'request_not_found' | 'model_unavailable' | 'options_unsupported'
  | 'idempotency_conflict' | 'ownership_conflict' | 'stale_revision' | 'request_expired'
  | 'queue_full' | 'causal_limit' | 'wait_cycle' | 'self_target' | 'steer_unsupported'
  | 'recovery_required' | 'internal_error';

export const CHAT_ACTORS: readonly ChatActor[];
export const CHAT_MESSAGE_SOURCES: readonly ChatMessageSource[];
export const CHAT_MESSAGE_KINDS: readonly ChatMessageKind[];
export const CHAT_COMMAND_KINDS: readonly ChatCommandKind[];
export const CHAT_COMMAND_STATES: readonly ChatCommandState[];
export const CHAT_EXECUTION_STATES: readonly ChatExecutionState[];
export const CHAT_DISPOSITIONS: readonly ChatDisposition[];
export const CHAT_REQUEST_KINDS: readonly ChatRequestKind[];
export const CHAT_REQUEST_STATES: readonly ChatRequestState[];
export const CHAT_TASK_TERMINAL_STATUSES: readonly ChatTaskTerminalStatus[];
export const CHAT_ERROR_HTTP_STATUS: Readonly<Record<ChatErrorCode, number>>;
export const CHAT_ERROR_CODES: readonly ChatErrorCode[];

export interface ChatContractIssue {
  code: ChatErrorCode;
  message: string;
  path?: string;
  retryable: boolean;
}
export type ValidationResult<T> = { ok: true; value: T }
  | { ok: false; error: ChatContractIssue };

export class ChatContractError extends Error {
  readonly code: ChatErrorCode;
  readonly statusCode: number;
  readonly path?: string;
  readonly retryable: boolean;
  constructor(code: ChatErrorCode, message: string, options?: { path?: string; retryable?: boolean });
  toJSON(): ChatContractIssue;
}

/** Semantic options only; the model catalog still validates actual support. */
export interface ModelOptions {
  reasoningEffort?: string;
  thinkingMode?: 'inherit' | 'on' | 'off';
  thinkingBudgetTokens?: number | null;
}

/** Library and pool identities remain selected identities, not serve aliases. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: ModelOptions;
}

export interface AgentProfileReference {
  profileId: string;
  profileVersion: number;
}

/**
 * Durable attribution. Deserializing this record does not authenticate its
 * actor; only trusted ingress may stamp execution caller identities.
 */
export interface MessageProvenance {
  version: 1;
  actor: ChatActor;
  source: ChatMessageSource;
  kind: ChatMessageKind;
  sourceChatId?: string;
  sourceTurnId?: string;
  commandId?: string;
  causalRootId?: string;
  replyToCommandId?: string;
  runId?: string;
  deliveryId?: string;
}

export interface AgentConversationMeta {
  version: 1;
  childChatId: string;
  parentChatId: string | null;
  rootChatId: string;
  journalOwnerId: string;
  origin: 'delegated' | 'legacy_import' | 'native';
  createdAt: number;
  missingParent?: boolean;
  initialRunId?: string;
  profileReference?: AgentProfileReference;
  capabilities?: {
    canSend: boolean;
    canStop: boolean;
    canChooseModel: boolean;
  };
}

export type TaskCompletionPolicy =
  | { version: 1; kind: 'local_only' }
  | {
    version: 1;
    kind: 'wake_delegator';
    recipientChatId: string;
    subscriptionId: string;
    cancellationEpoch: number;
  };

export interface ChatTaskResult {
  version: 1;
  runId: string;
  childChatId: string;
  journalOwnerId: string;
  executionId?: string;
  attemptId?: string;
  resultMessageId?: string;
  status: ChatTaskTerminalStatus;
  summary: string;
  settledAt: number;
  completionPolicy: TaskCompletionPolicy;
}

interface ChatCommandBase {
  version: 1;
  commandId: string;
  chatId: string;
  requestedAt: number;
  provenance: MessageProvenance;
  clientRequestId?: string;
}
interface ChatMessageCommandFields {
  message: string;
  modelSelection?: ModelSelection;
  profileReference?: AgentProfileReference;
}
export interface ChatUserImage { name: string; dataUrl: string }
interface ChatQueueControlFields {
  targetCommandId: string;
  expectedRevision: number;
}
export type ChatCommand = ChatCommandBase & (
  | ({ kind: 'send'; mode: 'auto' | 'queue'; images?: ChatUserImage[] } & ChatMessageCommandFields)
  | ({ kind: 'steer' } & ChatMessageCommandFields)
  | { kind: 'stop'; scope: 'turn' | 'tree' | 'agents'; executionId?: string; runId?: string }
  | ({ kind: 'edit_queued'; message: string } & ChatQueueControlFields)
  | ({ kind: 'remove_queued' | 'push_queued' } & ChatQueueControlFields)
);

export type ChatJsonValue = null | boolean | number | string
  | ChatJsonValue[] | { [key: string]: ChatJsonValue };
export type ChatJsonObject = { [key: string]: ChatJsonValue };

interface ChatRequestBase {
  version: 1;
  requestId: string;
  chatId: string;
  executionId: string;
  toolCallId: string;
  kind: ChatRequestKind;
  createdAt: number;
  title: string;
  presentation: ChatJsonObject;
  expiresAt?: number;
}
export type ChatRequest = ChatRequestBase & (
  | { state: 'pending'; settledAt?: never; answerCommandId?: never }
  | { state: 'answered'; settledAt: number; answerCommandId: string }
  | { state: 'expired' | 'cancelled'; settledAt: number; answerCommandId?: never }
);

export const CHAT_MIN_CLIENT_VERSION: 1;
export interface AgentConversationsFeature {
  version: 1;
  capability: 'agentConversationsV1';
  creationEnabled: boolean;
  recoveryEnabled: boolean;
  reason: 'not_released' | 'development_opt_in' | 'released' | 'disabled';
}

export function validateChatId(value: unknown): ValidationResult<string>;
export function validateModelOptions(value: unknown): ValidationResult<ModelOptions>;
export function validateModelSelection(value: unknown): ValidationResult<ModelSelection>;
export function validateMessageProvenance(value: unknown): ValidationResult<MessageProvenance>;
export function validateAgentConversationMeta(value: unknown): ValidationResult<AgentConversationMeta>;
export function validateAgentProfileReference(value: unknown): ValidationResult<AgentProfileReference>;
export function validateTaskCompletionPolicy(value: unknown): ValidationResult<TaskCompletionPolicy>;
export function validateChatTaskResult(value: unknown): ValidationResult<ChatTaskResult>;
export function validateChatCommand(value: unknown): ValidationResult<ChatCommand>;
export function validateChatRequest(value: unknown): ValidationResult<ChatRequest>;
export function validateChatError(value: unknown): ValidationResult<ChatContractIssue>;
export function validateAgentConversationsFeature(value: unknown): ValidationResult<AgentConversationsFeature>;
export function resolveModelSelection(
  value: unknown,
  options?: { inherited?: ModelSelection; defaults?: ModelOptions },
): ValidationResult<ModelSelection>;
