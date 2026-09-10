import type { TranscriptStore } from './transcript-store';

/** Provider row the runner sanitizes against and POSTs with. */
export interface RunnerProvider {
  id: string;
  label?: string;
  baseUrl: string;
  apiKind?: string;
  chatCompletionsPath?: string;
  apiKey?: string;
  autoApi?: boolean;
  modelApiOverrides?: Record<string, string>;
  supportsExtendedSamplers?: boolean;
  constrainedToolCalls?: boolean;
}

export interface PostChatCompletionsOptions {
  stream?: boolean;
  fallbackRole?: string;
  persist?: boolean;
  chatId?: string;
  resumeGenerationId?: string;
  onGenerationId?: (generationId: string) => void;
}

/**
 * Completion-stream seam. Renderer default: `postChatCompletions` from fetch-chat
 * (HTTP `/api/generations`). Server default: `postChatCompletionsInProcess`.
 */
export type PostChatCompletions = (
  provider: RunnerProvider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  options?: PostChatCompletionsOptions,
) => Promise<Response>;

/**
 * Tool-dispatch seam. Renderer default: `runHeadlessToolBatch` from
 * `src/tools/headless-tool-batch.ts`. Server default: `createInProcessToolDispatch`.
 */
export type RunHeadlessToolBatch = (options: {
  toolCalls: unknown[];
  constrained?: boolean;
  signal?: AbortSignal;
  execute: (name: string, args: unknown, ctx: { toolCallId: string }) => Promise<{ content: string }>;
  onToolDone?: (outcome: unknown) => void;
}) => Promise<unknown[]>;

/** Dependencies the turn loop cannot own without pulling `src/` or the DOM. */
export interface RunnerDeps {
  transcriptStore: TranscriptStore;
  postChatCompletions: PostChatCompletions;
  runHeadlessToolBatch: RunHeadlessToolBatch;
  resolveProvider: (providerId: string) => Promise<RunnerProvider>;
  getSubAgentTypeConfig: (type: string) => Promise<unknown>;
  resolveSamplerPreset: (input: unknown) => { preset: Record<string, unknown>; maxTokens: number };
  resolveThinkingMode: (input: unknown) => { mode: 'on' | 'off' };
  resolveThinkingBudgetTokens: (input: unknown) => { budgetTokens: number | null };
  loadToolCallsMeta: () => Promise<void>;
  getToolCallsMetaSync: () => unknown;
  isConstrainedDecodingEnabledForProvider: (provider: RunnerProvider, meta: unknown) => boolean;
  readProviderCapabilities: (providerId: string) => Promise<unknown>;
  isStructuredOutcomeResponseFormatAvailable: (
    modelId: string,
    capabilities: unknown,
  ) => boolean;
  resolveSendCapabilities: (
    providerId: string,
    modelId: string,
    apiKind?: string,
  ) => unknown;
  resolveModelContextLimit: (modelId: string) => number | null;
  getModelRow?: (modelId: string) => unknown;
  applyContextPolicy: (input: unknown) => Promise<{
    applied: boolean;
    messages: unknown[];
    statusMessage?: string | null;
    tokensAfter?: number;
  }>;
  /** Image-input policy: false suppresses tool pixels; omitted permits undeclared models. */
  isVisionModel?: (modelId: string) => boolean;
  recordTurnUsage?: (input: unknown, turn: unknown) => Promise<void>;
  reportBackgroundError?: (kind: string, detail?: Record<string, unknown>) => void;
}

export function postChatCompletionsHttp(
  provider: RunnerProvider,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response>;

export function runHeadlessToolBatchStub(options?: {
  toolCalls?: unknown[];
}): Promise<never[]>;
