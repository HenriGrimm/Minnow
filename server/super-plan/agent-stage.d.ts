import type { RunState, SeedKind, StageId } from './types';

export const STAGE_TOOL_IDS: Readonly<Record<string, readonly string[]>>;

export function resolveStageModel(
  state: RunState,
  role: StageId,
): Promise<{ providerId: string; id: string; sampler?: object; thinking?: { mode: 'on' | 'off' } }>;

export function guardStageTools(options: {
  role: StageId;
  artifactPath: string;
  execute: (name: string, args: unknown, ctx?: { toolCallId?: string }) => Promise<{ content: string }>;
}): (name: string, args: unknown, ctx?: { toolCallId?: string }) => Promise<{ content: string }>;

export function runAgentStage(input: {
  engine: any;
  runId: string;
  attemptId: string;
  role: StageId;
  seedKind: SeedKind;
  transcriptKey: string;
  signal: AbortSignal;
  runTurn?: (options: any) => Promise<any>;
  postChatCompletions?: (...args: any[]) => Promise<Response>;
  resolveModel?: typeof resolveStageModel;
  now?: () => Date;
}): Promise<{
  outcome: 'ok' | 'crashed' | 'timeout' | 'rejected';
  summary: string;
  evidence?: Record<string, unknown>;
  usage?: Record<string, number>;
}>;
