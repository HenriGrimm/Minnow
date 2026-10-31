import type { ChatCommand, ChatExecutionState, ModelSelection, AgentConversationsFeature, ChatTaskResult, ChatContractIssue } from './contracts.js';
import type { ChatCaller } from './caller.js';
import type { ChatContext, ChatTargetContext } from './context.js';
import type { ChatRepository, CommandRecord, ExecutionRecord, ExecutionFence, ProfileInput } from './repository.js';
import type { TranscriptMessage } from '../runner/transcript-store.js';
import type { TurnResult } from '../runner/run-turn.js';

export interface ChatCommandReceipt {
  commandId: string; chatId: string; state: CommandRecord['state']; disposition: string;
  position: number; revision: number; executionId: string | null; runId: string | null;
  messageId: string | null; held: boolean; result: unknown; error: unknown; replayed: boolean; link: string;
  assistantFinal?: string;
}
export interface ChatSteerInput { messages: TranscriptMessage[]; rowIds: number[] }
export interface ChatHostExecutionInput {
  command: ChatCommand; execution: ExecutionRecord; fence: ExecutionFence; signal: AbortSignal;
  /** Already persisted under the same fence; return these rows at the runner boundary without appending them again. */
  takeSteers(): ChatSteerInput | null;
}
export interface ChatExecutionHost {
  id: string;
  kind: 'server' | 'renderer' | 'cli' | 'scheduler';
  supportsSteer?: boolean;
  capabilities?: readonly string[];
  canRun?(input: { command: ChatCommand; target: ChatTargetContext; execution: ExecutionRecord | null }): boolean | Promise<boolean>;
  execute(input: ChatHostExecutionInput): TurnResult | Promise<TurnResult>;
}
export interface ChatSendInput {
  chatId: string; message: string; mode?: 'auto' | 'queue' | 'steer'; clientRequestId?: string;
  images?: Array<{ name: string; dataUrl: string }>;
  replyToCommandId?: string;
  /** Internal system ingress only; authenticated adapters cannot accept this from ordinary sends. */
  delivery?: { runId: string; deliveryId: string; causalRootId?: string; causalDepth?: number; cancellationEpoch?: number };
}
export interface ChatStopInput {
  chatId: string; executionId?: string; runId?: string; scope?: 'turn' | 'tree' | 'agents'; clientRequestId?: string;
  expectedLegacyOwnerId?: string;
}
export interface ChatQueueControlInput {
  chatId: string; targetCommandId: string; expectedRevision: number; clientRequestId?: string;
}
export interface ChatServiceEvent {
  type: 'command' | 'execution' | 'execution_error'; chatId: string;
  commandId?: string; executionId?: string; status?: string;
}
export interface ReservedChatTask {
  chatId: string; commandId: string; runId: string; attemptId: string; executionId: string;
  /** Call only after the graph durably appended attempt.started. Repeated calls return the same promise. */
  activate(): Promise<TurnResult>;
  stop(): void;
  /** Resolves after canonical attempt settlement; graph task/command publication remains separate. */
  finished: Promise<TurnResult>;
}
export interface DeferredChatTask { deferred: true; reason: string }
export interface ChatCommandService {
  send(caller: ChatCaller, input: ChatSendInput): Promise<ChatCommandReceipt>;
  /** Server-only bridge for verified terminal legacy journal runs. Never exposed as a transport action. */
  admitLegacyCompletion(caller: ChatCaller, input: Pick<ChatSendInput, 'chatId' | 'message' | 'clientRequestId'> & {
    delivery: NonNullable<ChatSendInput['delivery']>; retainOnly?: boolean;
  }, options?: { canAdmit?: () => boolean }): Promise<ChatCommandReceipt>;
  stop(caller: ChatCaller, input: ChatStopInput): Promise<ChatCommandReceipt>;
  /** Trusted task-runtime cancellation, pinned to an already admitted execution. */
  stopExecution(executionId: string): boolean;
  waitExecution(executionId: string): Promise<unknown>;
  startAdmittedChildTask(input: { commandId: string; runId: string; attemptId: string; signal?: AbortSignal }): Promise<ReservedChatTask | DeferredChatTask>;
  /** Trusted graph adapter only, after its terminal journal fold has committed. */
  settleChildTask(input: { commandId: string; runId: string; result: ChatTaskResult; error?: ChatContractIssue }): ChatCommandReceipt;
  editQueued(caller: ChatCaller, input: ChatQueueControlInput & { message: string }): Promise<ChatCommandReceipt>;
  removeQueued(caller: ChatCaller, input: ChatQueueControlInput): Promise<ChatCommandReceipt>;
  pushQueued(caller: ChatCaller, input: ChatQueueControlInput): Promise<ChatCommandReceipt>;
  readCommand(caller: ChatCaller, commandId: string): Promise<ChatCommandReceipt & { command: ChatCommand; effectiveCommand: ChatCommand }>;
  status(caller: ChatCaller, chatId: string): Promise<{
    chat: Record<string, unknown>;
    execution: { executionId: string; commandId: string | null; runId: string | null; status: ChatExecutionState; createdAt: number; updatedAt: number; settledAt: number | null } | null;
    pending: Array<ChatCommandReceipt & { kind: ChatCommand['kind']; preview: string }>;
  }>;
  registerHost(host: ChatExecutionHost): () => void;
  kick(chatId: string): Promise<void>;
  consumeSteers(executionId: string, fence: ExecutionFence): ChatSteerInput | null;
  drainControls(chatId: string): Promise<boolean>;
  canResumeQuestionExecution(executionId: string): boolean;
  ownsExecution(executionId: string): boolean;
  idle(chatId?: string): Promise<void>;
  recoverExecutions(verifyQuiescence: (execution: ExecutionRecord, lease: ExecutionFence) =>
    Promise<{ verified: boolean; source: string; checkedAt: number } | null> |
    { verified: boolean; source: string; checkedAt: number } | null): Promise<ExecutionRecord[]>;
  notifyExecution(event: { chatId: string; executionId: string; status: ChatExecutionState }): void;
  dispose(): Promise<void>;
}
export function createChatCommandService(options: {
  repository?: ChatRepository;
  context: Pick<ChatContext, 'resolveTarget'>;
  captureProfile?: (input: { target: ChatTargetContext; selection: ModelSelection; caller: ChatCaller; input: ChatSendInput }) => Promise<ProfileInput> | ProfileInput;
  admitCausality?: (input: { caller: ChatCaller; command: ChatCommand }) => { causalRootId: string; causalDepth: number; agentCoordination?: boolean };
  resolveModelSelection?: (input: { target: ChatTargetContext; caller: ChatCaller; input: ChatSendInput; selection: ModelSelection }) =>
    Promise<ModelSelection | { selection: ModelSelection }> | ModelSelection | { selection: ModelSelection };
  feature?: () => AgentConversationsFeature;
  canResumeQuestionExecution?: (executionId: string) => boolean;
  now?: () => number; id?: () => string; leaseMs?: number; maxPendingCommands?: number;
  hasExternalOwner?: (chatId: string) => boolean;
  /** Migration-only: exact branded legacy caller identity plus the still-live raw owner must be rechecked by the runtime. */
  isExternalExecutionActive?: (caller: ChatCaller) => boolean;
  getExternalOwner?: (chatId: string) => { ownerId: string; executionId?: string; runId?: string } | null;
  /** Stop only the captured owner. A replacement returns stopRequested:false; retries are idempotent by commandId. */
  stopExternalOwner?: (input: { chatId: string; commandId: string; requestedAt: number;
    owner: { ownerId: string; executionId?: string; runId?: string } }) =>
    Promise<{ stopRequested: boolean }> | { stopRequested: boolean };
  /** Must cancel only work admitted at/before this captured boundary; replay is idempotent by commandId. */
  cancelTree?: (input: { chatId: string; commandId: string; cancellationEpoch: number; throughPosition: number; record: CommandRecord }) => Promise<void> | void;
  /** Ensure/register the durable graph run only; startAdmittedChildTask is its separately licensed attempt path. */
  admitChildTask?: (input: { record: CommandRecord; target: ChatTargetContext }) =>
    Promise<{ ready?: boolean; runId?: string }> | { ready?: boolean; runId?: string };
  onEvent?: (event: ChatServiceEvent) => void | Promise<void>;
  onCommand?: (command: CommandRecord) => void | Promise<void>;
  onError?: (error: unknown) => void;
}): ChatCommandService;
