import { runTurn, type RunTurnOptions, type TurnEvent, type TurnLimits } from '../../server/runner/run-turn.js';
import type { RunnerDeps } from '../../server/runner/adapters';
import type { TranscriptMessage } from '../../server/runner/transcript-store';
import { parseToolArguments } from '../tools/parse-tool-arguments';
import { previewToolResult, type HeadlessToolCallRecord, type HeadlessTurnRecord } from './result';

export const HEADLESS_MAX_TURNS = 100;
export const HEADLESS_WALL_CLOCK_MS = 10 * 60_000;
export const HEADLESS_CONTEXT_TOKENS = 32_768;
export const HEADLESS_MAX_REPEATED_TOOL_CALLS = 8;

export interface HeadlessSharedTurnOptions {
  chatId: string;
  messages: TranscriptMessage[];
  systemPrompt: string;
  model: RunTurnOptions['model'];
  tools: RunTurnOptions['tools'];
  signal: AbortSignal;
  deps: RunnerDeps;
  execute: (name: string, args: unknown, signal: AbortSignal, toolCallId?: string) => Promise<{ content: string }>;
  refreshTools?: () => Promise<RunTurnOptions['tools']>;
  onEvent?: (event: TurnEvent) => void;
  limits?: TurnLimits;
}

/** CLI and Scheduler use the same bounded loop as chat and board workers. */
export async function runHeadlessSharedTurn(options: HeadlessSharedTurnOptions) {
  const turns: HeadlessTurnRecord[] = [];
  let current: HeadlessTurnRecord | null = null;
  let generationId = '';
  const callsById = new Map<string, HeadlessToolCallRecord>();
  let permittedNames = new Set(options.tools.map(tool => tool.function.name));
  let executionSignal = options.signal;
  const deps: RunnerDeps = {
    ...options.deps,
    postChatCompletions: async (provider, body, signal, postOptions) => {
      executionSignal = signal;
      return options.deps.postChatCompletions(provider, body, signal, {
        ...postOptions,
        onGenerationId: id => {
          generationId = id;
          if (current) current.generationId = id;
          postOptions?.onGenerationId?.(id);
        },
      });
    },
  };
  for (const message of options.messages) {
    if (message.role !== 'system') deps.transcriptStore.append(options.chatId, message);
  }
  const result = await runTurn({
    chatId: options.chatId,
    seed: '',
    messages: options.messages,
    systemPrompt: options.systemPrompt,
    model: options.model,
    tools: options.tools,
    signal: options.signal,
    deps,
    limits: {
      maxTurns: HEADLESS_MAX_TURNS,
      wallClockMs: HEADLESS_WALL_CLOCK_MS,
      maxRepeatedToolCalls: HEADLESS_MAX_REPEATED_TOOL_CALLS,
      contextBudget: { workingContextTokens: HEADLESS_CONTEXT_TOKENS, enforcementPolicy: 'compact', minRecentTurns: 1 },
      ...options.limits,
    },
    injectReportTool: false,
    reportToolName: null,
    nudgeToolUse: false,
    finalizeStructuredOutcome: false,
    execute: (name, args, context) => permittedNames.has(name)
      ? options.execute(name, args, executionSignal, context?.toolCallId)
      : Promise.resolve({ content: `Error: tool "${name}" is not available for this headless run.` }),
    refreshRoundConfig: options.refreshTools
      ? async () => {
        const tools = await options.refreshTools!();
        permittedNames = new Set(tools.map(tool => tool.function.name));
        return { systemPrompt: options.systemPrompt, tools };
      }
      : undefined,
    onEvent: event => {
      if (event.type === 'round_start') {
        callsById.clear();
        current = { generationId: '', finishReason: null, assistantText: '', toolCalls: [] };
        turns.push(current);
      } else if (event.type === 'round_end' && current) {
        current.generationId ||= generationId;
        current.finishReason = event.finishReason ?? null;
        current.assistantText = event.text;
      } else if (event.type === 'delta' && current) {
        current.assistantText = event.text;
      } else if (event.type === 'tool_call' && current) {
        const raw = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {});
        const call = { name: event.name, args: parseToolArguments(raw).args, resultPreview: '' };
        current.toolCalls.push(call);
        if (event.id) callsById.set(event.id, call);
      } else if (event.type === 'tool_result' && current) {
        const call = event.id ? callsById.get(event.id) : current.toolCalls.find(row => row.name === event.name && !row.resultPreview);
        if (call) call.resultPreview = previewToolResult(event.content);
      }
      options.onEvent?.(event);
    },
  });
  const history = (deps.transcriptStore.load(options.chatId)?.messages ?? []).filter(row => row.role !== 'system');
  const last = history.at(-1);
  const assistantFinal = last?.role === 'assistant' && typeof last.content === 'string' ? last.content.trim() : '';
  return { result, turns, history, assistantFinal };
}
