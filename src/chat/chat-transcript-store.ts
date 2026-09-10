import { createSessionTranscriptStore } from '../agents/session-transcript-store';
import { anthropicReasoningBlocks } from '../lib/anthropic-reasoning.mjs';
import { finalizeResponseMeta } from '../api/chat';
import { splitThinkingSegments } from '../api/reasoning';
import { applyClassifiedStreamEnd, classifyStreamEnd } from '../api/stream-end';
import { findChatById, recordChatMessage, scheduleSaveSessions, touchChat } from '../state/sessions';
import { noteRunGeneration, noteRunOutputIndex } from '../state/runs-store';
import {
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
  EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  INTENT_TO_ACT_RETRY_INSTRUCTION,
  PROSE_QUESTION_RETRY_INSTRUCTION,
  resolveFinalAssistantContent,
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
} from '../tools/turn-continuation';
import { ThinkingDurationTracker } from '../ui/thinking-duration';
import type { ThoughtBubbleController } from '../ui/thought-bubbles';
import { normalizeUsageTotals } from '../usage/pricing';
import type { TurnEvent } from '../../server/runner/run-turn';
import type { TranscriptMessage, TranscriptStore } from '../../server/runner/transcript-store';
import type {
  AssistantMessage,
  AssistantToolCallMessage,
  CodeChangeStats,
  LlamaTimings,
  Stats,
  ToolImageAttachment,
  TurnRunId,
  Usage,
} from '../types';
import { llamaRuntimeFromStreamMetaRuntime } from './turn-stream-meta';

/** Inner-loop user rows. Visible bubbles if they land in `chat.history`. */
const INNER_LOOP_CONTROL_USER_CONTENT = new Set<string>([
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
  EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  PROSE_QUESTION_RETRY_INSTRUCTION,
  INTENT_TO_ACT_RETRY_INSTRUCTION,
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
]);

/** Transport fields are mapped to display thoughts and exact signed thinkingBlocks. */
const WIRE_REASONING_KEYS = ['reasoning', 'reasoning_content', 'reasoning_signature', 'reasoning_blocks'] as const;

export interface ChatTranscriptStore extends TranscriptStore {
  /** Feed `TurnEvent`s so append can decorate from round/tool snapshots. */
  observe(event: TurnEvent): void;
  /** `onGenerationId` dirty-tracking — generation ids live on the turn run. */
  noteGeneration(chatId: string, generationId: string): void;
  abortThinking(): void;
  lastAssistantHistoryIndex(): number | undefined;
}

export interface CreateChatTranscriptStoreOptions {
  /** Defaults to the shared session wrapper. Do not fork that store. */
  inner?: TranscriptStore;
  thoughtController?: ThoughtBubbleController | null;
  turnRunId?: TurnRunId;
}

interface RoundDecorState {
  reasoningBlocks?: import('../types').AnthropicThinkingBlock[];
  index: number;
  thinkingSnapshot: string;
  reasoning: string;
  stats?: Stats;
  usage?: Usage;
  /** llama.cpp timings from stream_meta.runtime — used to derive usage when omitted. */
  timings?: LlamaTimings;
  finishReason?: string;
  streamError?: string;
  toolCallCount: number;
}

interface ToolOutcomeDecor {
  attachments?: ToolImageAttachment[];
  codeChange?: CodeChangeStats;
}

function emptyRound(index: number): RoundDecorState {
  return {
    index,
    thinkingSnapshot: '',
    reasoning: '',
    toolCallCount: 0,
  };
}

function isInnerLoopControlUserRow(message: TranscriptMessage): boolean {
  if (message.role !== 'user') return false;
  return typeof message.content === 'string' && INNER_LOOP_CONTROL_USER_CONTENT.has(message.content);
}

function cloneRow(message: TranscriptMessage): Record<string, unknown> {
  return { ...(message as unknown as Record<string, unknown>) };
}

function stripWireReasoning(row: Record<string, unknown>): void {
  for (const key of WIRE_REASONING_KEYS) {
    delete row[key];
  }
}

function asStats(value: unknown): Stats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Stats;
}

function asUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Usage;
}

function toolCallCountOf(row: Record<string, unknown>): number {
  const calls = row.tool_calls;
  return Array.isArray(calls) ? calls.length : 0;
}

export function createChatTranscriptStore(
  options: CreateChatTranscriptStoreOptions = {},
): ChatTranscriptStore {
  const inner = options.inner ?? createSessionTranscriptStore();
  const thoughtController = options.thoughtController ?? null;
  const turnRunId = options.turnRunId;
  const thinkingTracker = new ThinkingDurationTracker();
  const toolOutcomes = new Map<string, ToolOutcomeDecor>();

  let round = emptyRound(0);
  let lastPersistedAssistantIndex: number | undefined;
  let lastChatId: string | undefined;

  function thinkingSegmentsForRow(): string[] {
    const fromController = thoughtController?.getSegmentsNormalized() ?? [];
    if (fromController.length > 0) return fromController;
    const raw = round.reasoning.trim() || round.thinkingSnapshot.trim();
    return raw ? splitThinkingSegments(raw) : [];
  }

  function applyThinkingToRow(row: Record<string, unknown>): string[] {
    const thinking = thinkingSegmentsForRow();
    if (thinking.length > 0) {
      row.thinking = thinking;
      const durationMs = thinkingTracker.finalizeRound();
      if (durationMs > 0) row.thinkingDurationMs = durationMs;
      const signature = thoughtController?.getAnthropicThinkingSignature();
      if (signature) row.thinkingSignature = signature;
    } else {
      thinkingTracker.finalizeRound();
    }
    return thinking;
  }

  function applyStatsToRow(row: Record<string, unknown>): void {
    if (round.stats && Object.keys(round.stats).length > 0) {
      row.stats = round.stats;
    }
    if (round.usage && Object.keys(round.usage).length > 0) {
      row.usage = round.usage;
    }
  }

  /**
   * Persist the same reconciled stats/usage the live bubble uses.
   * Falls back to raw event fields (+ total_tokens fill) when timings are missing.
   */
  function applyRoundEndMeta(
    event: Extract<TurnEvent, { type: 'round_end' }>,
  ): void {
    round.reasoningBlocks = event.reasoningBlocks;
    const rawStats = asStats(event.stats);
    const rawUsage = asUsage(event.usage);
    const t0 =
      typeof event.t0 === 'number' && Number.isFinite(event.t0) ? event.t0 : null;
    const tEnd =
      typeof event.tEnd === 'number' && Number.isFinite(event.tEnd) ? event.tEnd : null;
    const tFirst =
      event.tFirst == null
        ? null
        : typeof event.tFirst === 'number' && Number.isFinite(event.tFirst)
          ? event.tFirst
          : null;

    if (t0 != null && tEnd != null) {
      const finalized = finalizeResponseMeta(
        {
          usage: rawUsage ?? round.usage,
          stats: rawStats ?? round.stats,
          timings: round.timings,
          finish_reason: event.finishReason ?? round.finishReason,
        },
        t0,
        tFirst,
        tEnd,
      );
      if (Object.keys(finalized.stats).length > 0) round.stats = finalized.stats;
      else if (rawStats) round.stats = rawStats;
      if (Object.keys(finalized.usage).length > 0) round.usage = finalized.usage;
      else if (rawUsage) round.usage = normalizeUsageTotals(rawUsage);
      return;
    }

    if (rawStats) round.stats = rawStats;
    if (rawUsage) round.usage = normalizeUsageTotals(rawUsage);
  }

  function applyStreamEndToRow(row: Record<string, unknown>): void {
    const tools = toolCallCountOf(row);
    const textLength =
      typeof row.content === 'string' ? row.content.trim().length : 0;
    const thinkingCount = Array.isArray(row.thinking) ? row.thinking.length : 0;
    const classified = classifyStreamEnd({
      finishReason: round.finishReason,
      toolCallsCount: tools,
      textLength,
      streamError: round.streamError,
    });
    if (classified.kind === 'aborted') return;
    if (
      classified.kind === 'incomplete' &&
      (textLength > 0 || thinkingCount > 0 || tools > 0)
    ) {
      return;
    }
    const applied = applyClassifiedStreamEnd(classified, {
      hasPostToolTail: tools > 0,
      textLength,
    });
    if (applied.truncated) row.truncated = true;
  }

  function decorateAssistant(message: TranscriptMessage): Record<string, unknown> {
    const row = cloneRow(message);
    const blocks = anthropicReasoningBlocks(row.reasoning_blocks ?? round.reasoningBlocks);
    if (blocks.length) row.thinkingBlocks = blocks;
    stripWireReasoning(row);
    const thinking = applyThinkingToRow(row);
    const hasToolCalls = toolCallCountOf(row) > 0;
    if (!hasToolCalls) {
      const raw = typeof row.content === 'string' ? row.content : '';
      const resolved = resolveFinalAssistantContent(raw, thinking);
      row.content = resolved.content;
    }
    applyStatsToRow(row);
    applyStreamEndToRow(row);
    return row;
  }

  function decorateTool(message: TranscriptMessage): Record<string, unknown> {
    const row = cloneRow(message);
    const id = typeof row.tool_call_id === 'string' ? row.tool_call_id : '';
    if (!id) return row;
    const outcome = toolOutcomes.get(id);
    if (!outcome) return row;
    if (outcome.attachments?.length) row.attachments = outcome.attachments;
    if (outcome.codeChange) row.codeChange = outcome.codeChange;
    return row;
  }

  function decorate(message: TranscriptMessage): Record<string, unknown> | null {
    if (isInnerLoopControlUserRow(message)) return null;
    if (message.role === 'assistant') return decorateAssistant(message);
    if (message.role === 'tool') return decorateTool(message);
    return cloneRow(message);
  }

  function patchPersistedAssistant(chatId: string): void {
    if (lastPersistedAssistantIndex === undefined) return;
    const chat = findChatById(chatId);
    if (!chat) return;
    const row = chat.history[lastPersistedAssistantIndex] as
      | AssistantMessage
      | AssistantToolCallMessage
      | undefined;
    if (!row || row.role !== 'assistant') return;
    const mutable = row as unknown as Record<string, unknown>;
    const blocks = anthropicReasoningBlocks(round.reasoningBlocks);
    if (blocks.length) mutable.thinkingBlocks = blocks;
    if (!Array.isArray(mutable.thinking) || mutable.thinking.length === 0) {
      const thinking = thinkingSegmentsForRow();
      if (thinking.length > 0) mutable.thinking = thinking;
    }
    applyStatsToRow(mutable);
    applyStreamEndToRow(mutable);
    recordChatMessage(chat);
    scheduleSaveSessions();
  }

  return {
    load(chatId) {
      return inner.load(chatId);
    },
    setMeta(chatId, meta) {
      inner.setMeta(chatId, meta);
    },
    append(chatId, message) {
      const chat = findChatById(chatId);
      if (!chat) return;
      lastChatId = chatId;
      const decorated = decorate(message);
      if (decorated === null) return;
      inner.append(chatId, decorated as unknown as TranscriptMessage);
      if (decorated.role === 'assistant') {
        lastPersistedAssistantIndex = chat.history.length - 1;
      }
      if (turnRunId) {
        noteRunOutputIndex(chat, turnRunId, chat.history.length - 1);
      }
      recordChatMessage(chat);
      scheduleSaveSessions();
    },
    observe(event) {
      if (event.type === 'response_restart') {
        round = emptyRound(round.index);
        thinkingTracker.finalizeRound();
        thoughtController?.resetFailedResponse();
        return;
      }
      if (event.type === 'round_start') {
        if (event.index > 0) {
          thoughtController?.consumePersistedSegments();
          thoughtController?.resetStreamPhaseHints();
        }
        round = emptyRound(event.index);
        lastPersistedAssistantIndex = undefined;
        return;
      }
      if (event.type === 'thinking') {
        round.thinkingSnapshot = event.text;
        thinkingTracker.startSegment();
        return;
      }
      if (event.type === 'reasoning_end') {
        thinkingTracker.endSegment();
        return;
      }
      if (event.type === 'stream_meta') {
        const stats = asStats(event.stats);
        const usage = asUsage(event.usage);
        if (stats) round.stats = stats;
        if (usage) round.usage = usage;
        const runtime = llamaRuntimeFromStreamMetaRuntime(event.runtime);
        if (runtime?.timings) {
          round.timings = { ...round.timings, ...runtime.timings };
        }
        if (event.finishReason) round.finishReason = event.finishReason;
        return;
      }
      if (event.type === 'tool_result') {
        if (!event.id) return;
        const outcome: ToolOutcomeDecor = {};
        if (Array.isArray(event.attachments) && event.attachments.length > 0) {
          outcome.attachments = event.attachments as ToolImageAttachment[];
        }
        if (event.codeChange && typeof event.codeChange === 'object') {
          outcome.codeChange = event.codeChange as CodeChangeStats;
        }
        toolOutcomes.set(event.id, outcome);
        return;
      }
      if (event.type === 'round_end') {
        round.index = event.index;
        round.reasoning = event.reasoning;
        round.toolCallCount = event.toolCallCount;
        // Prefer the same finalize path as live chips so history rebuild matches.
        applyRoundEndMeta(event);
        if (event.finishReason) round.finishReason = event.finishReason;
        if (lastChatId) patchPersistedAssistant(lastChatId);
      }
    },
    noteGeneration(chatId, generationId) {
      const chat = findChatById(chatId);
      if (!chat) return;
      if (turnRunId) {
        noteRunGeneration(chat, turnRunId, generationId);
      }
      touchChat(chat);
      scheduleSaveSessions();
    },
    abortThinking() {
      thinkingTracker.abort();
    },
    lastAssistantHistoryIndex() {
      return lastPersistedAssistantIndex;
    },
  };
}
