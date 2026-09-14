import type { AgentContextBudgetConfig, ContextEnforcementPolicy } from '../chat/context-budget';
import type { ApiMessage, BoardCategory, Stats, Usage } from '../types';
import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type { MessagesChangeMeta, TurnEvent } from '../../server/runner/run-turn';
import type {
  SubAgentBudgetEvent,
  SubAgentStructuredOutcome,
} from './sub-agent-structured-outcome';
import type { SamplerPreset } from './sampler-types';
import type { ThinkingTriState } from './thinking-types';

export type { TurnEvent, MessagesChangeMeta };

export type SubAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type RunLifecycle =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'suspect'
  | 'recovering'
  | 'completed'
  | 'done_unacked'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export function deriveLifecycleFromStatus(status: SubAgentStatus): RunLifecycle {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

export type SubAgentTerminalReason =
  | 'success'
  | 'max_tool_turns'
  | 'context_budget'
  | 'failed'
  | 'cancelled';

export interface SubAgentTypeConfig {
  label?: string;
  enabled: boolean;
  providerId: string;
  modelId: string;
  maxConcurrent: number;
  timeoutMs: number;
  workAgentId: string | null;
  allowedTools: string[] | null;
  deniedTools: string[];
  systemPromptPath: string | null;
  maxInputTokens?: number | null;
  contextEnforcementPolicy?: ContextEnforcementPolicy;
  minRecentTurns?: number;
  summaryReserveTokens?: number;
  summarySchema?: string;
  sampler?: SamplerPreset;
  thinkingMode?: ThinkingTriState;
  /** Per-type thinking token budget; null = inherit, 0 = off. */
  thinkingBudgetTokens?: number | null;
}

export interface SubAgentsFile {
  version: number;
  enabled: boolean;
  globalMaxConcurrent: number;
  defaultTimeoutMs: number;
  checkInNudgeMs?: number;
  defaultMaxInputTokens?: number | null;
  defaultContextEnforcementPolicy?: ContextEnforcementPolicy;
  defaultSummarySchema?: string;
  types: Record<string, SubAgentTypeConfig>;
}

export interface SubAgentRun {
  runId: string;
  type: string;
  task: string;
  status: SubAgentStatus;
  lifecycle?: RunLifecycle;
  parentChatId: string | null;
  parentToolCallId: string | null;
  parentTurnId: string | null;
  summary: string;
  /** Structured handoff for parent tools (MIN-43). */
  structuredOutcome?: SubAgentStructuredOutcome;
  budgetEvents?: SubAgentBudgetEvent[];
  contextBudgetMaxInputTokens?: number | null;
  contextBudgetPolicy?: ContextEnforcementPolicy;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  toolTurns: number;
  /** @deprecated Ignored; retained for persisted run records from older versions. */
  maxToolTurns?: number;
  cancelled: boolean;
  messages: ApiMessage[];
  liveNestedToolCalls?: number;
  liveCurrentToolName?: string | null;
  livePhase?: SubAgentLivePhase | null;
  livePartialReasoning?: string;
  livePartialText?: string;
  foldAttemptCount?: number;
  providerId?: string;
  modelId?: string;
  category?: BoardCategory;
  boardTaskId?: string | null;
  usage?: Usage;
  stats?: Stats;
  startError?: { message: string; consecutive: number } | null;
  delivered?: boolean;
}

export interface SpawnSubAgentInput {
  type: string;
  task: string;
  wait?: boolean;
  parentTurnId?: string | null;
  parentChatId?: string | null;
  parentToolCallId?: string | null;
  modeId?: string;
  providerId?: string;
  modelId?: string;
  category?: BoardCategory;
  boardTaskId?: string | null;
  timeoutMs?: number;
}

export interface SpawnSubAgentResult {
  runId: string;
  status: SubAgentStatus;
}

export interface CancelSubAgentResult {
  ok: boolean;
  runId: string;
  status: SubAgentStatus;
}

export interface AggregateContextBudgetInfo {
  maxInputTokens: number;
  estimatedInputTokens: number;
  policy: string;
  events: string[];
}

export interface AggregateResult {
  runId: string;
  type: string;
  status: SubAgentStatus;
  summary: string;
  outcome: SubAgentStructuredOutcome;
  startedAt: string | null;
  endedAt: string | null;
  toolTurns: number;
  cancelled: boolean;
  error?: string;
  terminalReason?: SubAgentTerminalReason;
  contextBudget?: AggregateContextBudgetInfo;
}

export interface SubAgentExecutorContext {
  parentTurnId: string;
  modeId: string;
  parentChatId?: string;
  parentToolCallId?: string;
}

export interface SubAgentRunnerOutput {
  summary: string;
  structuredOutcome?: SubAgentStructuredOutcome;
  toolTurns: number;
  messages: ApiMessage[];
  /** @deprecated Real runners no longer cap tool turns; retained for custom/test runners. */
  toolTurnLimitExhausted?: boolean;
  contextBudgetExhausted?: boolean;
  budgetEvents?: SubAgentBudgetEvent[];
  structuredOutcomeParseError?: string;
  usage?: Usage;
  stats?: Stats;
}

export type SubAgentLivePhase = 'thinking' | 'generating' | 'tools' | 'stopping';

export interface SubAgentLiveActivity {
  phase: SubAgentLivePhase | null;
  partialReasoning?: string;
  currentToolName?: string | null;
}

export interface SubAgentRunner {
  run(input: {
    runId: string;
    type: string;
    task: string;
    systemPrompt: string;
    tools: OpenAIFunctionDefinition[];
    providerId: string;
    modelId: string;
    parentChatId?: string | null;
    contextBudget?: AgentContextBudgetConfig;
    summarySchema?: string;
    priorMessages?: unknown[];
    nudgeToolUse?: boolean;
    finalizeStructuredOutcome?: boolean;
    reportToolName?: string | null;
    modelContextLimit?: number | null;
    signal: AbortSignal;
    toolExecuteContext?: {
      chatId?: string;
      subAgentType?: string;
    };
    executeTool: (
      name: string,
      args: Record<string, unknown>,
      toolContext?: import('../tools/client').ExecuteToolContext,
    ) => Promise<import('../types').ToolExecutionResult>;
    onMessagesChange?: (messages: ApiMessage[], meta?: MessagesChangeMeta) => void;
    onLiveActivity?: (activity: SubAgentLiveActivity) => void;
    onTurnEvent?: (event: TurnEvent) => void;
    onUsage?: (usage: Record<string, number>) => void;
    onRoundBoundary?: () => unknown[] | null;
    /** Store id of each `priorMessages` row. */
    priorRowIds?: Array<number | null>;
    /** Latest persisted compaction checkpoint; the opening transcript is projected through it. */
    compaction?: import('../../server/runner/compaction/index').CompactionCheckpoint | null;
    /** Store id of the row persisted at a transcript position, once persisted. */
    resolveRowId?: (position: number) => number | null | undefined;
    /** Hands the caller a reader of the unprojected rows (for `recall_history`). */
    bindRecallRows?: (read: () => Array<{ id: number; row: unknown }>) => void;
    onCompaction?: (event: import('../../server/runner/run-turn').TurnCompactionEvent) => void;
  }): Promise<SubAgentRunnerOutput>;
}
