import type { ChatCommand } from './contracts';
import type { ChatPolicySnapshot } from './policy';
import type { ChatRepository, ExecutionFence, ExecutionRecord } from './repository';
import type { ChatRequestService } from './requests';
import type { RunnerDeps } from '../runner/adapters';
import type { RunTurnOptions, TurnEvent, TurnModel, TurnResult, TurnToolDefinition, TurnLimits } from '../runner/run-turn';
import type { TranscriptMessage } from '../runner/transcript-store';
import type { InProcessToolDispatch } from '../runner/tool-dispatch';

export interface ChatExecutionInput {
  command: ChatCommand; execution: ExecutionRecord; fence: ExecutionFence; signal?: AbortSignal;
  /** Service fences and persists these ordered rows before returning them. */
  takeSteers?: RunTurnOptions['onRoundBoundary'];
  onEvent?: (event: ChatHostEvent) => void;
}
export interface ChatHostEvent { chatId: string; executionId: string; event: TurnEvent }
export interface ChatHostPreparation {
  systemPrompt: string; cliTurnContext?: string; tools: TurnToolDefinition[]; model: TurnModel;
  cwd: string; policy: ChatPolicySnapshot; toolContext?: Record<string, unknown>; deps: RunnerDeps;
  hostToolNames?: string[];
  contextBodies?: Partial<Record<'brain-notes' | 'code-map' | 'context-documents', string>>;
  limits?: TurnLimits; onEvent?: (event: TurnEvent) => void;
  runOptions?: Pick<RunTurnOptions, 'lazyTools' | 'alwaysLoadedToolNames' | 'askTimeoutMs' | 'injectReportTool' | 'reportToolName' | 'parseReport' | 'nudgeToolUse' | 'finalizeStructuredOutcome' | 'summarySchema' | 'refreshRoundConfig' | 'recallHistory'>;
}
export interface ChatHostUnavailable {
  waitingForHost?: true; reason?: string; missingCapabilities?: string[]; requiredCapabilities?: string[];
}
export interface ChatDispatchContext extends Omit<ChatExecutionInput, 'takeSteers' | 'onEvent'> {
  runtimeOwner: { chatId: string; runId: string; agentId: string };
}
export interface ServerChatExecutionHost {
  supportsSteer: true; requests: ChatRequestService;
  execute(input: ChatExecutionInput): Promise<TurnResult>;
}
export function chatInputMessageId(commandId: string): string;
export function createServerChatExecutionHost(options: {
  repository: ChatRepository;
  prepareExecution(input: Omit<ChatExecutionInput, 'takeSteers' | 'onEvent'>): Promise<ChatHostPreparation | ChatHostUnavailable>;
  resolveCurrentPolicy(input: ChatDispatchContext & { prepared: ChatHostPreparation }): ChatPolicySnapshot | Promise<ChatPolicySnapshot>;
  createToolDispatch?: (prepared: ChatHostPreparation, input: ChatDispatchContext) => InProcessToolDispatch | Promise<InProcessToolDispatch>;
  executeHostTool?: (input: { name: string; args: Record<string, unknown>; ctx: { toolCallId: string }; chatId: string; executionId: string; fence: ExecutionFence; signal: AbortSignal; prepared: ChatHostPreparation; revalidate(): Promise<unknown> }) => Promise<{ content: string; attachments?: unknown; codeChange?: unknown }>;
  requestService?: ChatRequestService;
  hydrateRecoveredQuestions?: (input: { execution: ExecutionRecord; fence: ExecutionFence; transcript: import('../runner/transcript-store').TranscriptStore;
    signal: AbortSignal; assertAllowed(): Promise<void>; status(value: import('./contracts').ChatExecutionState): void }) => Promise<void> | void;
  beforeInference?: (input: { execution: ExecutionRecord; signal: AbortSignal }) => Promise<void> | void;
  authorizeResponse?: Parameters<typeof import('./requests').createChatRequestService>[0]['authorizeResponse'];
  onEvent?: (event: ChatHostEvent) => void;
  onStatus?: (event: { chatId: string; executionId: string; status: import('./contracts').ChatExecutionState }) => void;
  now?: () => number;
}): ServerChatExecutionHost;
