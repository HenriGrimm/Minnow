import type { RunnerDeps } from './adapters';
import type { SubAgentRunner } from '../../src/agents/types';
import type { ApiMessage } from '../../src/types';

export { createMemoryTranscriptStore } from './transcript-store';
export type { TranscriptStore, TranscriptRecord, TranscriptMeta, TranscriptMessage } from './transcript-store';
export { postChatCompletionsHttp, runHeadlessToolBatchStub } from './adapters';
export type { RunnerDeps, PostChatCompletions, RunHeadlessToolBatch, RunnerProvider } from './adapters';
export {
  runTurn,
  DEFAULT_REPORT_TOOL_NAME,
  ASK_QUESTION_TOOL_NAME,
  DEFAULT_ASK_TIMEOUT_MS,
  ASK_QUESTION_UNAVAILABLE_ERROR,
  ASK_QUESTION_TIMEOUT_ERROR,
  resolveTurnTools,
  buildOpeningMessages,
  buildOpeningTranscript,
} from './run-turn';
export type {
  TurnResult,
  AttemptResult,
  TurnEvent,
  TurnPhase,
  TurnModel,
  TurnLimits,
  TurnToolDefinition,
  TurnSeedKind,
  MessagesChangeMeta,
  RunTurnOptions,
  ParseReport,
  ParseReportResult,
  AskCapability,
} from './run-turn';
export { isHighFrequencyTurnEvent, shouldEmitSubAgentLiveTurnEvent } from './turn-event';
export { executeToolCallBatch, STOPPED_TOOL_MSG } from './tool-batch';
export {
  MAX_PARALLEL_READ_TOOLS,
  isParallelSafeTool,
  partitionToolCalls,
} from './parallel-tool-policy';
export {
  AGENT_BROWSER_TOOL_IDS,
  DEFAULT_HEADLESS_TOOL_IDS,
  RENDERER_ONLY_TOOL_IDS,
  isRendererOnlyTool,
  rendererOnlyToolsIn,
} from './tool-set';

/** Build a runner that closes over injected I/O. There is one loop implementation. */
export function createSubAgentRunner(deps: RunnerDeps): SubAgentRunner;

export function cloneSubAgentMessages(messages: ApiMessage[]): ApiMessage[];
