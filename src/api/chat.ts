import { statsFromLlamaTimings, fillUsageFromLlamaTimings, MAX_PLAUSIBLE_TOKENS_PER_SECOND, decodeWindowCompletionTokens, plausibleTokensPerSecond, resolveDecodeSeconds, buildClientStats, reconcileCompletionStats, finalizeResponseMeta } from '../../server/runner/response-meta.js';
export { statsFromLlamaTimings, fillUsageFromLlamaTimings, MAX_PLAUSIBLE_TOKENS_PER_SECOND, decodeWindowCompletionTokens, plausibleTokensPerSecond, resolveDecodeSeconds, buildClientStats, reconcileCompletionStats, finalizeResponseMeta } from '../../server/runner/response-meta.js';
import { showToast } from '../ui/toast';
import { setChatRunActivity, type ChatRunActivityStatus } from '../state/chat-run-activity';
import { getChatAbort, setChatAbort, setStreaming, isAnyChatStreaming } from '../app-state';
import {
  isActiveChatStreaming,
  isBackgroundStreamBlockingSend,
  isStreamDomVisible,
} from '../chat/streaming-state';
import {
  cancelAssistantBubbleRenderDebounce,
  finishStreamingBubbleRender,
  scheduleAssistantBubbleRender,
  setAssistantBubbleContent,
} from '../markdown/renderer';
import { completeStreamAnnouncer } from '../ui/a11y/stream-announcer';
import { resolveModelInfo } from './models';
import {
  applyPromptTitlePlaceholder,
  isFirstUserMessagePending,
  scheduleChatTitleGeneration,
} from '../chat/titles/schedule';
import {
  ensureChatHistoryLoaded,
  getActiveChat,
  scheduleSaveSessions,
  recordChatMessage,
} from '../state/sessions';
import { resolveEffectiveChatModelBinding } from '../ui/default-model';
import { applyModelSelectValueToChat } from '../lib/model-select-key';
import { clearComposerAfterSend } from '../ui/composer-draft';
import type { OpenAIFunctionDefinition } from '../tools/definitions';
import type {
  ApiMessage,
  AssistantMessage,
  ChatCompletionChunk,
  LlamaPromptProgress,
  LlamaTimings,
  ModelInfo,
  Stats,
  ToolCall,
  ToolCallAccumulator,
  Usage,
} from '../types';
import { formatGenerationErrorMessage } from './generations';
import { normalizeModeId } from '../chat/modes/types.ts';
import { markMessageStopped } from '../ui/stopped-affordance';
import { recordMainChatTurnUsage } from '../usage/record-chat-usage';
import { normalizeUsageTotals } from '../usage/pricing';
import { getActiveProvider } from '../providers/store';
import { scrollChatIfPinned } from '../ui/chat-scroll';
import {
  setComposerStreamingMode,
  syncComposerFromStreamingState,
} from '../ui/composer-send';
import {
  appendBubble,
  appendInjectionNoticesDom,
  appendStats,
  appendStreamingAssistantRow,
  revealAssistantProseBubble,
  setAssistantErrorBubble,
} from '../ui/messages';
import { streamDeltaContentToText } from './message-content.ts';
import {
  extractInlineThinkingFromContent,
  HarmonyChannelRouter,
  InlineContentThinkingRouter,
  modelLikelyUsesInlineThinking,
  type RoutedContentPart,
} from './inline-thinking';
import { extractReasoningDelta, extractReasoningMessage } from './reasoning';
import {
  renderThoughtsToggle,
  ThoughtBubbleController,
  syncThoughtsCaretPulse,
  thoughtsScopeFromEl,
} from '../ui/thought-bubbles';
import { ThinkingDurationTracker } from '../ui/thinking-duration';
import {
  appendInjectionNoticesForTurn,
  isUiOnlyTranscriptMessage,
} from '../chat/context/injection-notice';
import { resolveOutboundSystemMessages } from '../chat/prompts/compose-context';
import { resolveContextLimit } from '../chat/context-usage';
import {
  recordAssistantReplyOnChat,
  setSidebarStreamPhase,
  syncChatItemDotsInDom,
} from '../ui/chat-item-dot';
import { renderSidebar } from '../ui/sidebar';
import {
  completeNonStreamingViaGenerations,
  postChatCompletions,
} from '../providers/fetch-chat';
import {
  createSseEventBuffer,
  feedSseEventBuffer,
  flushSseEventBuffer,
  parseSsePayloads,
} from './sse-parse';
import { clearStaleGenerationStatus, setStatus } from '../ui/status';
import { buildLastStatsSnapshot, updateStrip } from '../ui/stats';
import { createStreamingStatsPublisher } from '../chat/streaming-stats';
import { llamaRuntimeStatusView } from '../chat/llama-runtime-status';
import {
  clearInFlightPromptOverlay,
  publishInFlightPromptFromMeta,
} from '../models/in-flight-prompt';

export { parseSsePayloads } from './sse-parse';

// ── Types ────────────────────────────────────────────────────────────────────

/** Accumulated metadata from SSE chunks (stats, usage, model_info). */
export interface StreamMetaAccumulator {
  minnow_cli?: ChatCompletionChunk['minnow_cli'];
  stats?: Stats;
  usage?: Usage;
  model_info?: ModelInfo;
  model?: string;
  finish_reason?: string;
  error?: string;
  /** Latest llama.cpp `timings` block seen on the stream. */
  timings?: LlamaTimings;
  /** Latest llama.cpp `prompt_progress` seen on the stream. */
  prompt_progress?: LlamaPromptProgress;
  /**
   * True once reasoning text has crossed the wire on this round. Providers that
   * think before their first byte report those tokens in `completion_tokens`
   * without ever streaming them, and counting them against the decode window is
   * what used to inflate hosted tok/s several-fold.
   */
  streamed_reasoning?: boolean;
}

/** Non-streaming completion body (multimodal messages + optional tools). */
export interface ChatCompletionBody {
  model?: string;
  messages: ApiMessage[];
  temperature: number;
  max_tokens: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  presence_penalty?: number;
  tools?: OpenAIFunctionDefinition[];
  tool_choice?: 'auto';
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
  };
}


/** Re-export reasoning helpers for callers that already import `chat.ts`. */
export {
  extractReasoningDelta,
  extractReasoningMessage,
  splitThinkingSegments,
} from './reasoning';

// ── Stream ───────────────────────────────────────────────────────────────────

/** Provider error payload on an SSE chunk (OpenAI-style `error` or `finish_reason: error`). */
export function extractStreamErrorMessage(chunk: ChatCompletionChunk): string | undefined {
  const raw = chunk.error;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object') {
    const message = raw.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }
  const finish = chunk.choices?.[0]?.finish_reason;
  if (finish === 'error') {
    return 'The provider reported a stream error.';
  }
  return undefined;
}

/** Pull visible assistant text from one SSE JSON chunk. */
export function extractStreamDelta(chunk: ChatCompletionChunk): string {
  const choice = chunk.choices?.[0];
  if (!choice) return '';
  const fromDelta = streamDeltaContentToText(choice.delta?.content);
  if (fromDelta) return fromDelta;
  return streamDeltaContentToText(choice.message?.content);
}

/** Merge streaming `tool_calls` fragments into an accumulator keyed by `index`. */
export function mergeToolCallDelta(
  acc: ToolCallAccumulator,
  chunk: ChatCompletionChunk
): ToolCallAccumulator {
  const deltas = chunk.choices?.[0]?.delta?.tool_calls;
  if (!deltas?.length) return acc;

  const next: ToolCallAccumulator = { ...acc };
  for (const d of deltas) {
    const idx = d.index;
    const existing = next[idx] || { type: 'function' as const, function: { name: '', arguments: '' } };
    const merged: Partial<ToolCall> = {
      ...existing,
      type: 'function',
      function: {
        name: existing.function?.name || '',
        arguments: existing.function?.arguments || '',
      },
    };
    if (d.id) merged.id = d.id;
    if (d.function?.name) {
      merged.function = {
        ...merged.function!,
        name: (merged.function?.name || '') + d.function.name,
      };
    }
    if (d.function?.arguments) {
      merged.function = {
        ...merged.function!,
        arguments: (merged.function?.arguments || '') + d.function.arguments,
      };
    }
    next[idx] = merged;
  }
  return next;
}

export { getLatestStreamingToolName } from './tool-call-stream.ts';

/** Turn a streaming accumulator into complete `ToolCall` rows (sorted by index). */
export function finalizeToolCalls(acc: ToolCallAccumulator): ToolCall[] {
  return Object.keys(acc)
    .map((k) => Number(k))
    .filter((idx) => Number.isFinite(idx))
    .sort((a, b) => a - b)
    .map((idx) => {
      const partial = acc[idx];
      return {
        id: partial?.id || `call_${idx}`,
        type: 'function' as const,
        function: {
          name: partial?.function?.name || '',
          arguments: partial?.function?.arguments || '',
        },
      };
    })
    .filter((tc) => Boolean(tc.function.name));
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** Plain message content from a non-streaming completion. */
export function extractMessageText(
  message: { content?: string | unknown } | null | undefined,
): string {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return streamDeltaContentToText(message.content);
}

/**
 * Assistant text from a completion message: prose content, structured parsed JSON, or refusal.
 */
export function extractAssistantCompletionText(
  message:
    | {
        content?: string | unknown;
        parsed?: unknown;
        refusal?: string;
      }
    | null
    | undefined,
): string {
  const fromContent = extractMessageText(message).trim();
  if (fromContent) return fromContent;

  const parsed = message?.parsed;
  if (parsed != null && typeof parsed === 'object') {
    return JSON.stringify(parsed);
  }
  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed.trim();
  }

  const refusal = message?.refusal;
  if (typeof refusal === 'string' && refusal.trim()) {
    return refusal.trim();
  }

  return '';
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Merge stats, usage, model_info, and finish_reason from successive chunks. */
export function mergeStreamMeta(
  acc: StreamMetaAccumulator | null | undefined,
  chunk: ChatCompletionChunk
): StreamMetaAccumulator {
  const next: StreamMetaAccumulator = { ...(acc || {}) };
  if (chunk.timings) {
    next.timings = { ...next.timings, ...chunk.timings };
    const derived = statsFromLlamaTimings(next.timings);
    if (derived) next.stats = { ...next.stats, ...derived };
  } else if (deltaHasGeneratedText(chunk)) {
    const prev = Number(next.timings?.predicted_n) || 0;
    next.timings = { ...next.timings, predicted_n: prev + 1 };
  }
  if (chunk.prompt_progress) next.prompt_progress = chunk.prompt_progress;
  if (chunk.minnow_cli) next.minnow_cli = chunk.minnow_cli;
  if (deltaHasReasoning(chunk)) next.streamed_reasoning = true;
  if (chunk.stats) next.stats = { ...next.stats, ...chunk.stats };
  if (chunk.usage) next.usage = { ...next.usage, ...chunk.usage };
  if (chunk.model_info) next.model_info = { ...next.model_info, ...chunk.model_info };
  if (chunk.model) next.model = chunk.model;
  const finish = chunk.choices?.[0]?.finish_reason;
  if (finish) next.finish_reason = finish;
  const streamError = extractStreamErrorMessage(chunk);
  if (streamError) next.error = streamError;
  // Prefer real usage fields; fill gaps from llama timings when the provider omitted them.
  if (next.timings) {
    const filled = fillUsageFromLlamaTimings(next.usage, next.timings);
    if (
      filled.prompt_tokens != null ||
      filled.completion_tokens != null ||
      filled.total_tokens != null
    ) {
      next.usage = filled;
    }
  } else if (next.usage) {
    next.usage = normalizeUsageTotals(next.usage);
  }
  return next;
}

/** True when this chunk carried reasoning text, so its tokens are in the window. */
function deltaHasReasoning(chunk: ChatCompletionChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta || typeof delta !== 'object') return false;
  const reasoning = delta.reasoning ?? delta.reasoning_content;
  return typeof reasoning === 'string' && reasoning.length > 0;
}

/** True when this chunk added assistant prose or reasoning (one mlx-lm token). */
function deltaHasGeneratedText(chunk: ChatCompletionChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta || typeof delta !== 'object') return false;
  const content = delta.content;
  const reasoning = delta.reasoning ?? delta.reasoning_content;
  if (typeof content === 'string' && content.length > 0) return true;
  if (typeof reasoning === 'string' && reasoning.length > 0) return true;
  return false;
}

// ── Fallback ─────────────────────────────────────────────────────────────────

/** Non-streaming fallback when SSE yields no assistant text. */
export async function tryNonStreamingFallback(
  body: ChatCompletionBody,
  signal: AbortSignal,
  chatProviderId?: string,
): Promise<ChatCompletionChunk> {
  const provider = await getActiveProvider(chatProviderId);
  return completeNonStreamingViaGenerations(provider, body, signal);
}

// ── Send ─────────────────────────────────────────────────────────────────────

/** Send the composer text to LM Studio with SSE streaming and optional JSON fallback. */
export async function sendMessage(): Promise<void> {
  if (isActiveChatStreaming()) return;
  if (isBackgroundStreamBlockingSend()) {
    showToast('Stop or wait for the reply in the other chat first');
    return;
  }
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;

  const chat = getActiveChat();
  const binding = resolveEffectiveChatModelBinding(chat);
  const modelId = binding.modelId;
  if (binding.selectValue && !chat.modelId?.trim()) {
    applyModelSelectValueToChat(chat, binding.selectValue);
  }
  const temp = parseFloat((document.getElementById('temperature') as HTMLInputElement).value);
  const maxTok = parseInt((document.getElementById('maxTokens') as HTMLInputElement).value, 10);
  const legacySysPrompt = (
    document.getElementById('systemPrompt') as HTMLTextAreaElement
  ).value.trim();

  if (!modelId) {
    setStatus('err', 'Select a model first');
    return;
  }
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
    setStatus('err', 'Temperature must be 0 to 2');
    return;
  }
  if (!Number.isFinite(maxTok) || maxTok < 1) {
    setStatus('err', 'Max tokens must be at least 1');
    return;
  }
  getChatAbort(chat.id)?.abort();
  const controller = new AbortController();
  setChatAbort(chat.id, controller);
  const chatSignal = controller.signal;

  chat.modelId = binding.modelId || chat.modelId;
  await ensureChatHistoryLoaded(chat.id);
  const shouldScheduleTitle = isFirstUserMessagePending(chat);
  const firstUserSend = shouldScheduleTitle;
  if (shouldScheduleTitle) applyPromptTitlePlaceholder(chat.id, text);
  chat.history.push({ role: 'user', content: text });
  clearComposerAfterSend(chat, input);
  recordChatMessage(chat);
  scheduleSaveSessions();
  renderSidebar();
  appendBubble('user', text);

  const outbound = await resolveOutboundSystemMessages(chat, legacySysPrompt, {
    userMessagePreview: text,
    routeUserText: text,
    firstUserSend,
    modelContextLimit: modelId ? resolveContextLimit(modelId, chat) : null,
  });

  const injectionAdded = appendInjectionNoticesForTurn(
    chat,
    outbound.injectionBlocks,
  );
  if (injectionAdded.length > 0) {
    scheduleSaveSessions();
    appendInjectionNoticesDom(
      injectionAdded,
      chat.history.length - injectionAdded.length,
      { chatId: chat.id },
    );
  }

  const messages: ApiMessage[] = [];
  if (outbound.composed) {
    messages.push({ role: 'system', content: outbound.composed });
  }
  if (outbound.userRules) {
    messages.push({ role: 'system', content: outbound.userRules });
  }
  for (const m of chat.history) {
    if (isUiOnlyTranscriptMessage(m)) continue;
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id,
        content: m.content,
      });
      continue;
    }
    if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls,
      });
      continue;
    }
    messages.push({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    });
  }

  const body = {
    model: modelId || undefined,
    messages,
    temperature: temp,
    max_tokens: maxTok,
    stream: true,
    stream_options: { include_usage: true },
  };

  const { wrap, bubble, cursor, streamStatus } = appendStreamingAssistantRow(chat.id);
  const revealProse = (): void => {
    if (!isStreamDomVisible(chat.id)) return;
    revealAssistantProseBubble(wrap, bubble, streamStatus);
  };

  const thinkingTracker = new ThinkingDurationTracker((elapsedMs) => {
    thoughtController.setThinkingElapsed(elapsedMs);
  });

  const thoughtController = new ThoughtBubbleController(wrap, {
    onThinkingStart: (): void => {
      streamStatus.setPhase('thinking');
      setSidebarStreamPhase('thinking', chat.id);
      thinkingTracker.startSegment();
    },
    onReasoningEnded: (): void => {
      thinkingTracker.endSegment();
      streamStatus.setThinkingElapsed(null);
      if (wrap.classList.contains('msg--awaiting-prose')) {
        streamStatus.setPhase('generating');
        setSidebarStreamPhase('generating', chat.id);
      } else {
        setSidebarStreamPhase(null, chat.id);
      }
    },
  });

  setStreaming(true, chat.id);
  if (isStreamDomVisible(chat.id)) {
    setComposerStreamingMode('streaming');
    setStatus('spin', 'Generating reply…');
  } else {
    syncComposerFromStreamingState();
  }

  let completionActivityStatus: ChatRunActivityStatus = 'completed';
  let fullText = '';
  let streamMeta: StreamMetaAccumulator = {};
  const t0 = performance.now();
  let tFirst: number | null = null;
  let thinkingLength = 0;
  const streamingStatsPublisher = createStreamingStatsPublisher(chat);
  const inlineRouter = new InlineContentThinkingRouter({
    thinkingModel: modelLikelyUsesInlineThinking(modelId),
  });
  const harmonyRouter = new HarmonyChannelRouter();

  function appendThinking(text: string): void {
    if (!text) return;
    thoughtController.appendReasoningDelta(text);
    thinkingLength += text.length;
  }

  function processRoutedParts(parts: RoutedContentPart[]): void {
    for (const [text, isThinking] of parts) {
      if (text && tFirst == null) tFirst = performance.now();
      if (isThinking) {
        appendThinking(text);
        continue;
      }
      if (!text) {
        continue;
      }
      thoughtController.endReasoningPhase();
      revealProse();
      fullText += text;
      if (isStreamDomVisible(chat.id)) {
        scheduleAssistantBubbleRender(bubble, fullText, cursor);
      }
    }
  }

  function routeContentDelta(delta: string): void {
    if (!delta) {
      return;
    }
    for (const [harmonyText, isHarmonyThinking] of harmonyRouter.feed(delta)) {
      if (isHarmonyThinking) {
        appendThinking(harmonyText);
        continue;
      }
      processRoutedParts(inlineRouter.feed(harmonyText));
    }
  }

  function flushContentRouters(): void {
    for (const [harmonyText, isHarmonyThinking] of harmonyRouter.flush()) {
      if (isHarmonyThinking) {
        appendThinking(harmonyText);
        continue;
      }
      processRoutedParts(inlineRouter.feed(harmonyText));
    }
    processRoutedParts(inlineRouter.flush());
  }

  try {
    const provider = await getActiveProvider(chat.providerId);
    chat.providerId = provider.id;
    const res = await postChatCompletions(provider, body, chatSignal);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const sseBuffer = createSseEventBuffer();

    function handleChunk(chunk: ChatCompletionChunk): void {
      streamMeta = mergeStreamMeta(streamMeta, chunk);
      const reasoning = extractReasoningDelta(chunk);
      if (reasoning) {
        if (tFirst == null) tFirst = performance.now();
        appendThinking(reasoning);
      }
      const contentDelta = extractStreamDelta(chunk);
      if (contentDelta) {
        routeContentDelta(contentDelta);
      }
      const runtime = llamaRuntimeStatusView(streamMeta, tFirst != null);
      if (runtime.phase === 'prompt_processing' && tFirst == null) {
        streamStatus.setPhase('prompt_processing');
      }
      streamStatus.setRuntimeDetail(runtime.detail || null);
      publishInFlightPromptFromMeta(streamMeta, modelId);
      streamingStatsPublisher.schedule({
        streamMeta,
        t0,
        tFirst,
        partialText: fullText,
        partialThinkingLength: thinkingLength,
        modelId,
        modelInfo: chat.modelInfo ?? undefined,
      });
      if (isStreamDomVisible(chat.id)) {
        scrollChatIfPinned();
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      feedSseEventBuffer(sseBuffer, decoder.decode(value, { stream: true }), handleChunk);
    }

    flushSseEventBuffer(sseBuffer, handleChunk);

    flushContentRouters();

    thoughtController.endReasoningPhase();

    const split = extractInlineThinkingFromContent(fullText);
    if (split.thinking.length && split.reply.trim()) {
      thoughtController.ingestCompletedReasoning(split.thinking.join('\n\n'));
      fullText = split.reply;
    }

    cancelAssistantBubbleRenderDebounce();
    finishStreamingBubbleRender(bubble, cursor);

    if (!fullText) {
      revealProse();
      const fallback = await tryNonStreamingFallback(
        {
          model: modelId || undefined,
          messages,
          temperature: temp,
          max_tokens: maxTok,
        },
        chatSignal,
        chat.providerId,
      );
      const fbMsg = fallback.choices?.[0]?.message;
      fullText = extractMessageText(fbMsg);
      const fbReason = extractReasoningMessage(fbMsg);
      if (fbReason) {
        thoughtController.ingestCompletedReasoning(fbReason);
      }
      streamMeta = mergeStreamMeta(streamMeta, fallback);
      setAssistantBubbleContent(bubble, fullText || 'The model returned no text.', {
        streaming: false,
        modeId: chat.modeId,
      });
      completeStreamAnnouncer(fullText || 'The model returned no text.');
    } else {
      revealProse();
      setAssistantBubbleContent(bubble, fullText, { streaming: false, modeId: chat.modeId });
      completeStreamAnnouncer(fullText);
    }

    if (fullText) {
      const tEnd = performance.now();
      const meta = finalizeResponseMeta(
        streamMeta,
        t0,
        tFirst ?? tEnd,
        tEnd,
      );
      const resolvedProvider = await getActiveProvider(chat.providerId);
      void recordMainChatTurnUsage(chat, {
        providerId: resolvedProvider.id,
        modelId: streamMeta.model || modelId,
        streamMeta,
        t0,
        tFirst,
        tEnd,
      });
      const modelInfo = resolveModelInfo(streamMeta.model || modelId, meta.model_info);
      const thinkingNorm = thoughtController.getSegmentsNormalized();
      const thinkingDurationMs = thinkingTracker.finalize();
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: fullText,
        stats: meta.stats,
        usage: meta.usage,
      };
      if (thinkingNorm.length > 0) {
        assistantMsg.thinking = thinkingNorm;
        if (thinkingDurationMs > 0) {
          assistantMsg.thinkingDurationMs = thinkingDurationMs;
        }
      }
      chat.history.push(assistantMsg);
      recordAssistantReplyOnChat(chat);
      chat.lastStats = buildLastStatsSnapshot(meta.stats, meta.usage);
      chat.modelInfo = { ...modelInfo };
      chat.modelId = binding.modelId || chat.modelId;
      recordChatMessage(chat);
      appendStats(wrap, meta.stats, meta.usage);
      if (thinkingNorm.length > 0) {
        renderThoughtsToggle(wrap, thinkingNorm, {
          durationMs: thinkingDurationMs > 0 ? thinkingDurationMs : undefined,
        });
        syncThoughtsCaretPulse(thoughtsScopeFromEl(wrap));
      }
      updateStrip(meta.stats, meta.usage, modelInfo);
      setStatus('ok', 'Ready');
      if (shouldScheduleTitle) {
        scheduleChatTitleGeneration(chat.id, text, {
          modelId: modelId || chat.modelId,
          providerId: chat.providerId,
        });
      }
      renderSidebar();
      scheduleSaveSessions();
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    completionActivityStatus = e?.name === 'AbortError' ? 'stopped' : 'failed';
    if (e && e.name === 'AbortError') {
      thinkingTracker.abort();
      streamStatus.setThinkingElapsed(null);
      cancelAssistantBubbleRenderDebounce();
      finishStreamingBubbleRender(bubble, cursor);
      thoughtController.abort();

      const text = fullText.trim();
      const thinkingNorm = thoughtController.getSegmentsNormalized();
      if (text && wrap.isConnected) {
        wrap.classList.remove('msg--awaiting-prose');
        bubble.classList.remove('msg-bubble--awaiting');
        setAssistantBubbleContent(bubble, text, { streaming: false, modeId: chat.modeId });
        completeStreamAnnouncer(text);
        markMessageStopped(wrap);
      } else if (wrap.isConnected && wrap.classList.contains('msg--awaiting-prose')) {
        wrap.remove();
      }

      if (text || thinkingNorm.length > 0) {
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: text || thinkingNorm.join('\n\n'),
          stopped: true,
        };
        if (thinkingNorm.length > 0) {
          assistantMsg.thinking = thinkingNorm;
        }
        chat.history.push(assistantMsg);
        recordAssistantReplyOnChat(chat);
        recordChatMessage(chat);
        scheduleSaveSessions();
      }

      streamStatus.dispose();
      setStatus('ok', 'Stopped');
      return;
    }
    cancelAssistantBubbleRenderDebounce();
    finishStreamingBubbleRender(bubble, cursor);
    revealProse();
    setAssistantErrorBubble(
      bubble,
      `Could not complete this reply: ${formatGenerationErrorMessage(e.message ?? 'Unknown error')}`,
    );
    const msg = e.message ?? '';
    const statusMsg = msg.length > 48 ? `${msg.slice(0, 45)}…` : msg;
    setStatus('err', statusMsg);
    thoughtController.abort();
    thinkingTracker.abort();
  } finally {
    clearInFlightPromptOverlay();
    streamingStatsPublisher.reset();
    thoughtController.abort();
    setChatRunActivity(chat.id, completionActivityStatus);
    setStreaming(false, chat.id);
    clearStaleGenerationStatus(isAnyChatStreaming());
    setSidebarStreamPhase(null, chat.id);
    syncChatItemDotsInDom();
    syncComposerFromStreamingState();
    if (getChatAbort(chat.id)?.signal === chatSignal) {
      setChatAbort(chat.id, null);
    }
    if (isStreamDomVisible(chat.id)) {
      scrollChatIfPinned();
    }
  }
}
