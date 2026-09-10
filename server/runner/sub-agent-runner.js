/**
 * Isolated sub-agent completion + tool loop.
 */
import {
  extractAssistantCompletionText,
  extractStreamDelta,
  finalizeToolCalls,
  mergeStreamMeta,
  mergeToolCallDelta
} from "./stream-parse.js";
import {
  createSseEventBuffer,
  feedSseEventBuffer,
  flushSseEventBuffer,
  parseCompletionResponseBody
} from "./sse-parse.js";
import { applyClassifiedStreamEnd, classifyStreamEnd } from "./stream-end.js";
import { repairUnpairedToolCalls } from "./provider-message-normalize.js";
import {
  extractInlineThinkingFromContent,
  HarmonyChannelRouter,
  InlineContentThinkingRouter,
  modelLikelyUsesInlineThinking
} from "./inline-thinking.js";
import {
  extractReasoningDelta,
  extractReasoningMessage,
  modelRequiresReasoningContentReplay,
  outboundReasoningReplayFields
} from "./reasoning.js";
import {
  applyConstrainedToolCallsToBody,
  isResponseFormatRejectionError,
  stripResponseFormatFromBody
} from "./constrained-tool-calls.js";
import { mergeContentJsonToolCalls } from "./constrained-tool-content.js";
import {
  ContentToolCallRouter,
  hasXmlToolCallMarkup,
  stripXmlToolCallBlocks
} from "./xml-tool-calls.js";
import { sanitizeCompletionBodyForProvider } from "../providers/sanitize-completion-body.js";
import { toolImageFollowUpFromAttachments, pruneSupersededToolImages, TOOL_IMAGE_NO_VISION_HINT } from "./tool-image-follow-up.js";
import { resolveModelApi } from "../generations/resolve-model-api.js";
import {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  SAFETY_MARGIN,
  estimateApiMessagesTokens,
  resolveContextBudget,
  resolveLocalWindowReserves
} from "./context-budget.js";
import { estimateToolsTokens } from "./token-estimate-core.js";
import {
  contextRetryMessageLimit,
  isContextOverflowText,
  parseContextOverflowNumbers
} from "./context-overflow-error.js";
import {
  contextCalibratedMessageLimit,
  recordContextEstimateBias
} from "./estimate-calibration.js";
import { SUB_AGENT_CONTEXT_BUDGET_ERROR } from "./sub-agent-outcome.js";
import { buildSubAgentOutcomeResponseFormat } from "./sub-agent-outcome-response-format.js";
import {
  buildSubAgentFinalizationPrompt,
  legacyOutcomeFromSummary,
  parseStructuredOutcomeJson,
  SUB_AGENT_STRUCTURED_OUTCOME_REPAIR_PROMPT,
  tryParseStructuredOutcomeFromAssistantProse,
  validateStructuredOutcome
} from "./sub-agent-structured-outcome.js";
import { averageStatsSegments, sumUsageSegments } from "./stats-math.js";
import { looksLikeProseStructuredQuestion } from "./prose-question-detect.js";
import { looksLikeIntentToAct } from "./intent-to-act-detect.js";
import {
  EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  hasPostToolTail,
  MAX_EMPTY_POST_TOOL_RETRIES,
  MAX_PROSE_QUESTION_RETRIES,
  PROSE_QUESTION_RETRY_INSTRUCTION,
  MAX_INTENT_TO_ACT_RETRIES,
  INTENT_TO_ACT_RETRY_INSTRUCTION,
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
  buildReportToolNudgeInstruction
} from "./turn-continuation.js";
import { mergeThinkingIntoCompletionBody } from "./merge-thinking-body.js";
import {
  ThinkingBudgetTracker,
  buildBudgetContinuationMessages,
  buildThinkingPrefillAssistantMessage,
  stripCarriedTextEcho,
  stripPrefillEchoFromDelta
} from "./thinking-budget.js";
import { retryOnceOnTransientFetch } from "./transient-fetch-retry.js";
import { LLAMA_CPP_LOCAL_PROVIDER_ID, MLX_LM_LOCAL_PROVIDER_ID } from "./provider-ids.js";
import { applySamplerToBody, DEFAULT_AGENT_MAX_TOKENS } from "./sampler-types.js";
import { buildOpeningMessages } from "./opening-messages.js";
import {
  modelUsesComposerReasoningDropdown,
  resolveEffectiveReasoningEffort
} from "./reasoning-effort.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function isAbortLikeStreamError(err, signal) {
  if (signal?.aborted) return true;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

// ── Runner ───────────────────────────────────────────────────────────────────

function createSubAgentRunner(deps) {
  const postChatCompletions = (provider, body, signal, options) => deps.postChatCompletions(provider, body, signal, options);
  const runHeadlessToolBatch = (options) => deps.runHeadlessToolBatch(options);
  const resolveProvider = (id) => deps.resolveProvider(id);
  const getSubAgentTypeConfig = (type) => deps.getSubAgentTypeConfig(type);
  const resolveSamplerPreset = (input) => deps.resolveSamplerPreset(input);
  const resolveThinkingMode = (input) => deps.resolveThinkingMode(input);
  const resolveThinkingBudgetTokens = (input) => deps.resolveThinkingBudgetTokens(input);
  const loadToolCallsMeta = () => deps.loadToolCallsMeta();
  const getToolCallsMetaSync = () => deps.getToolCallsMetaSync();
  const isConstrainedDecodingEnabledForProvider = (provider, meta) => deps.isConstrainedDecodingEnabledForProvider(provider, meta);
  const readProviderCapabilities = (id) => deps.readProviderCapabilities(id);
  const isStructuredOutcomeResponseFormatAvailable = (modelId, caps) => deps.isStructuredOutcomeResponseFormatAvailable(modelId, caps);
  const resolveSendCapabilities = (providerId, modelId, apiKind) => deps.resolveSendCapabilities(providerId, modelId, apiKind);
  const applyContextPolicy = (input) => deps.applyContextPolicy(input);
  // An absent capability hook is unknown, not a reason to silently drop pixels.
  const canSendToolImages = (modelId) => deps.isVisionModel?.(modelId) !== false;
  const getModelRowForSelectOrCanonicalId = (id) => deps.getModelRow?.(id) ?? null;
  const recordSubAgentTurnUsage = (parentChatId, payload) => deps.recordTurnUsage?.({ parentChatId, ...payload }, payload) ?? Promise.resolve();
  const reportBackgroundError = (kind, detail) => deps.reportBackgroundError?.(kind, detail);
  function findChatById(chatId) {
    return deps.transcriptStore.load(chatId)?.meta;
  }
  async function tryNonStreamingFallback(body, signal, providerId) {
    const provider = await resolveProvider(providerId);
    const res = await postChatCompletions(
      provider,
      { ...body, stream: false },
      signal,
      { stream: false, fallbackRole: "sub-agent" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCompletionResponseBody(await res.text());
  }
  function resolveStreamedCompletionText(content, reasoning) {
    const prose = content.trim();
    if (prose) return prose;
    return reasoning.trim();
  }
  async function completionTextForTurn(turnResult, body, provider, sendCaps, signal) {
    let text = resolveStreamedCompletionText(turnResult.fullText, turnResult.reasoningText);
    if (text.trim()) return text.trim();
    const { stream: _stream, ...fallbackBody } = sanitizeSubAgentBody(body, provider, sendCaps);
    const fallback = await tryNonStreamingFallback(fallbackBody, signal, provider.id);
    const message = fallback.choices?.[0]?.message;
    text = resolveStreamedCompletionText(
      extractAssistantCompletionText(message).trim(),
      extractReasoningMessage(message).trim()
    );
    return text.trim();
  }
  function sanitizeSubAgentBody(body, provider, sendCaps) {
    return sanitizeCompletionBodyForProvider(
      body,
      provider,
      sendCaps
    );
  }
  async function runSubAgentNonStreamTurn(providerId, body, signal, provider, sendCaps) {
    const t0 = performance.now();
    const sanitized = sanitizeSubAgentBody(body, provider, sendCaps);
    const { stream: _stream, ...fallbackBody } = sanitized;
    const chunk = await tryNonStreamingFallback(fallbackBody, signal, providerId);
    const message = chunk.choices?.[0]?.message;
    const fullText = extractAssistantCompletionText(message);
    const reasoningText = extractReasoningMessage(message).trim();
    const finishReasonRaw = chunk.choices?.[0]?.finish_reason;
    const finishReason = finishReasonRaw == null ? void 0 : finishReasonRaw;
    return {
      fullText,
      reasoningText,
      finishReason,
      toolCalls: [],
      streamMeta: {
        usage: chunk.usage,
        stats: chunk.stats,
        finish_reason: finishReason
      },
      t0,
      tFirst: t0,
      tEnd: performance.now()
    };
  }
  function logSubAgentDebug(event, detail) {
    void event;
    void detail;
  }
  function resolveSubAgentModelContextLimit(modelId) {
    const id = modelId.trim();
    if (!id) return null;
    if (deps.resolveModelContextLimit) return deps.resolveModelContextLimit(id);
    return null;
  }
  const LIVE_TRANSCRIPT_EMIT_MS = 80;
  function cloneSubAgentMessages2(messages) {
    return structuredClone(messages);
  }
  function buildSubAgentToolAssistantMessage(modelId, turnResult) {
    let reasoningText = turnResult.reasoningText.trim();
    let content = turnResult.fullText.trim() || null;
    if (modelRequiresReasoningContentReplay(modelId) && !reasoningText && content) {
      reasoningText = content;
      content = null;
    }
    return {
      role: "assistant",
      content,
      tool_calls: turnResult.toolCalls,
      ...outboundReasoningReplayFields(modelId, reasoningText, void 0, {
        toolCallTurn: true
      })
    };
  }
  async function streamSubAgentTurn(providerId, body, signal, fallbackRole, onDelta, sanitizeOptions, streamOptions) {
    return retryOnceOnTransientFetch(
      () => streamSubAgentTurnOnce(
        providerId,
        body,
        signal,
        fallbackRole,
        onDelta,
        sanitizeOptions,
        streamOptions
      )
    );
  }
  async function streamSubAgentTurnOnce(providerId, body, signal, fallbackRole, onDelta, sanitizeOptions, streamOptions) {
    const provider = sanitizeOptions?.provider ?? await resolveProvider(providerId);
    const sanitized = sanitizeSubAgentBody(
      body,
      provider,
      sanitizeOptions?.modelCapabilities
    );
    const turnAbort = new AbortController();
    if (signal.aborted) {
      turnAbort.abort();
    } else {
      signal.addEventListener("abort", () => turnAbort.abort(), { once: true });
    }
    const sessionChatId =
      typeof streamOptions?.chatId === "string" ? streamOptions.chatId.trim() : "";
    const res = await postChatCompletions(provider, sanitized, turnAbort.signal, {
      fallbackRole,
      ...(sessionChatId ? { chatId: sessionChatId } : {})
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }
    const modelId = body.model ?? "";
    let inlineRouter = new InlineContentThinkingRouter({
      thinkingModel: modelLikelyUsesInlineThinking(modelId)
    });
    let harmonyRouter = new HarmonyChannelRouter();
    let toolCallRouter = new ContentToolCallRouter();
    let thinkingToolCallRouter = new ContentToolCallRouter();
    const carriedText = streamOptions?.carriedText ?? "";
    let proseText = carriedText;
    let reasoningText = streamOptions?.carriedReasoning ?? "";
    let streamMeta = {};
    let toolAcc = {};
    const t0 = performance.now();
    let tFirst = null;
    const thinkingBudgetTracker = streamOptions?.thinkingBudgetTracker ?? null;
    let prefillEchoPartial = streamOptions?.prefillEchoPartial?.trim() ?? "";
    let carriedEchoPending = carriedText.trim().length > 0;
    let toolCallPhaseStarted = false;
    let budgetTripped = false;
    let thinkingChannel;
    let reader = null;
    const onTurnEvent = typeof streamOptions?.onTurnEvent === "function"
      ? streamOptions.onTurnEvent
      : null;
    let lastStreamMetaEmit = 0;
    let reasoningEnded = false;
    function emitStreamMeta(force = false) {
      if (!onTurnEvent) return;
      const now = Date.now();
      if (!force && now - lastStreamMetaEmit < LIVE_TRANSCRIPT_EMIT_MS) return;
      lastStreamMetaEmit = now;
      /** @type {Record<string, unknown>} */
      const event = { type: "stream_meta" };
      if (streamMeta.usage) event.usage = streamMeta.usage;
      if (streamMeta.stats) event.stats = streamMeta.stats;
      if (streamMeta.timings || streamMeta.prompt_progress) {
        event.runtime = {
          timings: streamMeta.timings,
          prompt_progress: streamMeta.prompt_progress
        };
      }
      if (typeof streamMeta.model === "string" && streamMeta.model) {
        event.model = streamMeta.model;
      }
      if (streamMeta.finish_reason) event.finishReason = streamMeta.finish_reason;
      onTurnEvent(event);
    }
    function emitReasoningEnd() {
      if (reasoningEnded || !onTurnEvent) return;
      reasoningEnded = true;
      onTurnEvent({ type: "reasoning_end" });
    }
    if (carriedText) {
      onDelta?.(proseText);
    }
    function feedThinkingBudget(delta) {
      if (!thinkingBudgetTracker || !delta) return;
      thinkingBudgetTracker.feed(delta);
      if (thinkingBudgetTracker.exceeded && !budgetTripped) {
        budgetTripped = true;
        void reader?.cancel();
        turnAbort.abort();
      }
    }
    function noteThinkingChannel(channel) {
      thinkingChannel ??= channel;
    }
    function notifyReasoningDelta() {
      if (!reasoningText) return;
      streamOptions?.onReasoningDelta?.(reasoningText);
    }
    function emitThinking(text) {
      if (!text) {
        return;
      }
      feedThinkingBudget(text);
      reasoningText += text;
      notifyReasoningDelta();
    }
    function noteEmbeddedToolProgress(router) {
      // Content and reasoning channels can both carry tool envelopes instead
      // of delta.tool_calls. Surface progress while their arguments stream.
      const streamingName = router.peekStreamingToolName()?.trim();
      if (!streamingName) return;
      if (!toolCallPhaseStarted) {
        toolCallPhaseStarted = true;
        thinkingBudgetTracker?.endSession();
        emitReasoningEnd();
      }
      streamOptions?.onToolCallDelta?.(streamingName);
    }
    function processRoutedParts(parts) {
      for (const [text, isThinking] of parts) {
        if (isThinking) {
          if (text) {
            noteThinkingChannel("inline");
            emitThinking(thinkingToolCallRouter.feed(text));
            noteEmbeddedToolProgress(thinkingToolCallRouter);
          }
          continue;
        }
        if (!text) {
          continue;
        }
        thinkingBudgetTracker?.endSession();
        if (tFirst == null) tFirst = performance.now();
        emitProse(toolCallRouter.feed(text));
        noteEmbeddedToolProgress(toolCallRouter);
      }
    }
    function emitProse(text) {
      if (!text) {
        return;
      }
      emitReasoningEnd();
      proseText += text;
      onDelta?.(proseText);
    }
    function routeContentDelta(delta) {
      if (!delta) {
        return;
      }
      for (const [harmonyText, isHarmonyThinking] of harmonyRouter.feed(delta)) {
        if (isHarmonyThinking) {
          if (harmonyText) {
            noteThinkingChannel("inline");
            feedThinkingBudget(harmonyText);
            reasoningText += harmonyText;
            notifyReasoningDelta();
          }
          continue;
        }
        processRoutedParts(inlineRouter.feed(harmonyText));
      }
    }
    function flushContentRouters() {
      for (const [harmonyText, isHarmonyThinking] of harmonyRouter.flush()) {
        if (isHarmonyThinking) {
          if (harmonyText) {
            noteThinkingChannel("inline");
            feedThinkingBudget(harmonyText);
            reasoningText += harmonyText;
            notifyReasoningDelta();
          }
          continue;
        }
        processRoutedParts(inlineRouter.feed(harmonyText));
      }
      processRoutedParts(inlineRouter.flush());
      emitThinking(thinkingToolCallRouter.flush());
      noteEmbeddedToolProgress(thinkingToolCallRouter);
      emitProse(toolCallRouter.flush());
      noteEmbeddedToolProgress(toolCallRouter);
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sseBuffer = createSseEventBuffer();
    function handleChunk(chunk) {
      if (chunk.minnow_router) {
        if (chunk.minnow_router.phase === 'loading' || chunk.minnow_router.phase === 'waiting') {
          onTurnEvent?.({ type: 'loading_model' });
          if (!chunk.minnow_router.reset) return;
        }
        if (chunk.minnow_router.phase === 'generating' && !chunk.minnow_router.reset) {
          onTurnEvent?.({ type: 'phase', phase: 'generating' });
          return;
        }
      }
      if (chunk.minnow_router?.reset) {
        proseText = carriedText;
        reasoningText = streamOptions?.carriedReasoning ?? '';
        streamMeta = {}; toolAcc = {}; tFirst = null;
        toolCallPhaseStarted = false; reasoningEnded = false; thinkingChannel = undefined;
        inlineRouter = new InlineContentThinkingRouter({ thinkingModel: modelLikelyUsesInlineThinking(chunk.minnow_router.modelId) });
        harmonyRouter = new HarmonyChannelRouter();
        toolCallRouter = new ContentToolCallRouter();
        thinkingToolCallRouter = new ContentToolCallRouter();
        onTurnEvent?.({ type: 'response_restart', warning: chunk.minnow_router.warning });
        onDelta?.(proseText);
        streamOptions?.onReasoningDelta?.(reasoningText);
        return;
      }
      streamMeta = mergeStreamMeta(streamMeta, chunk);
      emitStreamMeta();
      toolAcc = mergeToolCallDelta(toolAcc, chunk);
      const reasoningDelta = extractReasoningDelta(chunk);
      if (reasoningDelta) {
        noteThinkingChannel("native");
        // Same capture as inline `<think>` spans: withhold tool markup from the
        // Thoughts panel and recover it as a real tool call after the stream.
        emitThinking(thinkingToolCallRouter.feed(reasoningDelta));
        noteEmbeddedToolProgress(thinkingToolCallRouter);
      }
      const contentDelta = extractStreamDelta(chunk);
      if (contentDelta) {
        let routedDelta = contentDelta;
        if (prefillEchoPartial) {
          routedDelta = stripPrefillEchoFromDelta(routedDelta, prefillEchoPartial);
          prefillEchoPartial = "";
        }
        if (carriedEchoPending) {
          routedDelta = stripCarriedTextEcho(routedDelta, carriedText);
          carriedEchoPending = false;
        }
        routeContentDelta(routedDelta);
      }
      if (!toolCallPhaseStarted && Object.keys(toolAcc).length > 0) {
        toolCallPhaseStarted = true;
        thinkingBudgetTracker?.endSession();
        emitReasoningEnd();
      }
      const partialTools = finalizeToolCalls(toolAcc);
      const streamingToolName = partialTools[0]?.function?.name?.trim();
      if (streamingToolName) {
        streamOptions?.onToolCallDelta?.(streamingToolName);
      }
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        feedSseEventBuffer(sseBuffer, decoder.decode(value, { stream: true }), handleChunk);
        if (budgetTripped) break;
      }
    } catch (err) {
      const e = err;
      if (e?.name !== "AbortError" || !budgetTripped) {
        throw err;
      }
    }
    flushSseEventBuffer(sseBuffer, handleChunk);
    flushContentRouters();
    emitReasoningEnd();
    emitStreamMeta(true);
    let fullText = proseText;
    const split = extractInlineThinkingFromContent(fullText);
    if (split.thinking.length && split.reply.trim()) {
      reasoningText += split.thinking.join("\n\n");
      fullText = split.reply;
    }
    const streamedToolCalls = finalizeToolCalls(toolAcc);
    const toolCalls = mergeContentJsonToolCalls(fullText, streamedToolCalls, {
      harmonyParseText: harmonyRouter.getCommentaryParseText(),
      xmlParseText: toolCallRouter.getToolCallParseText(),
      thinkingXmlParseText: [
        thinkingToolCallRouter.getToolCallParseText(),
        reasoningText,
        ...split.thinking
      ].join("\n")
    });
    if (toolCalls.length > 0 && hasXmlToolCallMarkup(fullText)) {
      fullText = stripXmlToolCallBlocks(fullText);
    }
    const finishReason = streamMeta.finish_reason || (toolCalls.length > 0 ? "tool_calls" : void 0);
    const tEnd = performance.now();
    return {
      fullText,
      reasoningText,
      finishReason,
      toolCalls,
      streamMeta,
      t0,
      tFirst,
      tEnd,
      thinkingBudgetExceeded: budgetTripped,
      partialThinkingText: budgetTripped ? thinkingBudgetTracker?.sessionText : void 0,
      thinkingChannel
    };
  }
  async function ledgerSubAgentTurn(input, turn) {
    await recordSubAgentTurnUsage(input.parentChatId, {
      subAgentType: input.type,
      runId: input.runId,
      providerId: input.providerId,
      modelId: input.modelId,
      streamMeta: turn.streamMeta,
      t0: turn.t0,
      tFirst: turn.tFirst,
      tEnd: turn.tEnd
    });
  }
  const defaultSubAgentRunner = {
    async run(input) {
      const messages = buildOpeningMessages(
        input.systemPrompt,
        input.task,
        input.priorMessages
      );
      let toolTurns = 0;
      let proseQuestionRetries = 0;
      let intentToActRetries = 0;
      let emptyPostToolRetries = 0;
      let hasAskQuestionTool = input.tools.some((t) => t.function.name === "ask_question");
      const typeConfig = await getSubAgentTypeConfig(input.type);
      // `runTurn({ type: 'turn' })` is main chat, not a sub-agent type. The
      // previous 2048 fallback silently capped every provider at
      // finish_reason: length whenever a caller omitted `model.sampler`.
      // Work-agent kind + shipped Settings max is the safety net; product
      // chat still passes `{ preset, maxTokens }` from Settings/drawer.
      const isMainTurn = input.type === "turn";
      const resolvedSampler = resolveSamplerPreset(
        isMainTurn
          ? {
              kind: "work-agent",
              agentKey: null,
              global: { maxTokens: DEFAULT_AGENT_MAX_TOKENS, preset: {} }
            }
          : {
              kind: "sub-agent",
              agentKey: input.type,
              global: { maxTokens: DEFAULT_AGENT_MAX_TOKENS, preset: {} },
              subAgentMaxTokensFallback: DEFAULT_AGENT_MAX_TOKENS,
              subAgentType: typeConfig
            }
      );
      const parentChat = input.parentChatId ? findChatById(input.parentChatId) : void 0;
      const resolvedThinking = resolveThinkingMode({
        kind: "sub-agent",
        agentKey: input.type,
        chatThinkingMode: parentChat?.thinkingMode,
        subAgentType: typeConfig
      });
      const resolvedThinkingBudget = resolveThinkingBudgetTokens({
        kind: "sub-agent",
        agentKey: input.type,
        subAgentType: typeConfig
      });
      let toolUseNudgeSent = false;
      let reportToolNudgeSent = false;
      const reportToolName =
        typeof input.reportToolName === "string" && input.reportToolName.trim()
          ? input.reportToolName.trim()
          : "";
      const contextBudget = input.contextBudget ?? {
        enforcementPolicy: DEFAULT_CONTEXT_ENFORCEMENT_POLICY
      };
      const modelContextLimit = input.modelContextLimit !== void 0 ? input.modelContextLimit : resolveSubAgentModelContextLimit(input.modelId);
      let lastProgressEmit = 0;
      let forcedEmitQueued = false;
      let forcedPartialAssistant;
      /** Latest streaming prose for a trailing persist snapshot (leading-only used to drop it). */
      let latestUnsettledPartial;
      /** Trailing timer so a token burst still flushes the latest clone after 80ms. */
      let trailingProgressTimer = null;
      const usageSegments = [];
      const statsSegments = [];
      const noteUsage = (segment) => {
        if (typeof input.onUsage !== "function") return;
        try {
          input.onUsage(segment);
        } catch {
        }
      };
      const budgetEvents = [];
      const summarySchema = input.summarySchema;
      const clearTrailingProgress = () => {
        if (trailingProgressTimer == null) return;
        clearTimeout(trailingProgressTimer);
        trailingProgressTimer = null;
      };
      const emitUnsettledProgress = (partialAssistant) => {
        lastProgressEmit = Date.now();
        const snapshot = cloneSubAgentMessages2(messages);
        if (partialAssistant) {
          snapshot.push({ role: "assistant", content: partialAssistant });
        }
        input.onMessagesChange(snapshot, { settled: false });
      };
      const flushForcedEmit = () => {
        forcedEmitQueued = false;
        clearTrailingProgress();
        if (!input.onMessagesChange) return;
        lastProgressEmit = Date.now();
        const snapshot = cloneSubAgentMessages2(messages);
        const partial = forcedPartialAssistant;
        forcedPartialAssistant = void 0;
        if (partial) {
          snapshot.push({ role: "assistant", content: partial });
        }
        input.onMessagesChange(snapshot, { settled: true });
      };
      const emitProgress = (partialAssistant, force = false) => {
        if (!input.onMessagesChange) return;
        if (partialAssistant !== void 0) {
          latestUnsettledPartial = partialAssistant;
        }
        const now = Date.now();
        if (force) {
          // Settled persist must not also fire a trailing synthetic assistant row.
          clearTrailingProgress();
          forcedPartialAssistant = partialAssistant ?? forcedPartialAssistant;
          if (forcedEmitQueued) return;
          forcedEmitQueued = true;
          queueMicrotask(flushForcedEmit);
          return;
        }
        if (now - lastProgressEmit < LIVE_TRANSCRIPT_EMIT_MS) {
          if (trailingProgressTimer == null) {
            const wait = Math.max(0, LIVE_TRANSCRIPT_EMIT_MS - (now - lastProgressEmit));
            trailingProgressTimer = setTimeout(() => {
              trailingProgressTimer = null;
              if (!input.onMessagesChange) return;
              emitUnsettledProgress(latestUnsettledPartial);
            }, wait);
            trailingProgressTimer.unref?.();
          }
          return;
        }
        clearTrailingProgress();
        emitUnsettledProgress(partialAssistant);
      };
      let liveEmitQueued = false;
      let pendingLive = null;
      let lastFlushedPhase = null;
      const flushLiveActivity = () => {
        liveEmitQueued = false;
        if (!pendingLive || !input.onLiveActivity) return;
        const snapshot = pendingLive;
        pendingLive = null;
        lastFlushedPhase = snapshot.phase ?? lastFlushedPhase;
        input.onLiveActivity(snapshot);
      };
      const emitLiveActivity = (patch, force = false) => {
        if (!input.onLiveActivity) return;
        const prevPhase = pendingLive?.phase ?? lastFlushedPhase;
        pendingLive = {
          phase: pendingLive?.phase ?? null,
          partialReasoning: pendingLive?.partialReasoning,
          currentToolName: pendingLive?.currentToolName,
          ...patch
        };
        const phaseChanged =
          patch.phase !== undefined && patch.phase != null && patch.phase !== prevPhase;
        if (force || phaseChanged) {
          flushLiveActivity();
          return;
        }
        if (liveEmitQueued) return;
        liveEmitQueued = true;
        queueMicrotask(flushLiveActivity);
      };
      emitProgress(void 0, true);
      emitLiveActivity({ phase: "generating", partialReasoning: void 0, currentToolName: null }, true);
      const spliceRoundBoundaryRows = () => {
        if (typeof input.onRoundBoundary !== "function") return;
        let extra = null;
        try {
          extra = input.onRoundBoundary();
        } catch {
          return;
        }
        if (!Array.isArray(extra) || extra.length === 0) return;
        let spliced = 0;
        for (const row of extra) {
          if (!row || typeof row !== "object" || typeof row.role !== "string") continue;
          const next = { role: row.role };
          if ("content" in row) next.content = row.content;
          if (typeof row.tool_call_id === "string") next.tool_call_id = row.tool_call_id;
          if (Array.isArray(row.tool_calls)) next.tool_calls = row.tool_calls;
          messages.push(next);
          spliced += 1;
        }
        if (spliced > 0) emitProgress(void 0, true);
      };
      const emitTurnEvent = (event) => {
        if (typeof input.onTurnEvent !== "function") return;
        try {
          input.onTurnEvent(event);
        } catch {
        }
      };
      // Live UI deltas are independent of emitProgress (persist throttle). A
      // token burst in one read() used to paint the first word until stream end.
      let liveDeltaQueued = false;
      let pendingLiveDelta = null;
      const flushLiveDelta = () => {
        liveDeltaQueued = false;
        const text = pendingLiveDelta;
        pendingLiveDelta = null;
        if (!text) return;
        emitTurnEvent({ type: "delta", text });
      };
      const emitLiveDelta = (text, force = false) => {
        if (!text) return;
        pendingLiveDelta = text;
        if (force) {
          flushLiveDelta();
          return;
        }
        if (liveDeltaQueued) return;
        liveDeltaQueued = true;
        queueMicrotask(flushLiveDelta);
      };
      let nextRoundIndex = 0;
      let currentRoundIndex = 0;
      const emitRoundStart = () => {
        currentRoundIndex = nextRoundIndex;
        nextRoundIndex += 1;
        emitTurnEvent({ type: "round_start", index: currentRoundIndex });
      };
      const emitRoundEnd = (turnResult) => {
        const usage = turnResult?.streamMeta?.usage;
        const stats = turnResult?.streamMeta?.stats;
        const finishReason = turnResult?.finishReason;
        emitTurnEvent({
          type: "round_end",
          index: currentRoundIndex,
          text: typeof turnResult?.fullText === "string" ? turnResult.fullText : "",
          reasoning: typeof turnResult?.reasoningText === "string" ? turnResult.reasoningText : "",
          toolCallCount: Array.isArray(turnResult?.toolCalls) ? turnResult.toolCalls.length : 0,
          ...(usage && typeof usage === "object" ? { usage } : {}),
          ...(stats && typeof stats === "object" ? { stats } : {}),
          ...(finishReason ? { finishReason } : {}),
          t0: turnResult?.t0,
          tFirst: turnResult?.tFirst ?? null,
          tEnd: turnResult?.tEnd
        });
      };
      await loadToolCallsMeta();
      const provider = await resolveProvider(input.providerId);
      const sendCaps = resolveSendCapabilities(input.providerId, input.modelId, provider.apiKind);
      const turnReasoningEffort = modelUsesComposerReasoningDropdown(sendCaps) ? resolveEffectiveReasoningEffort(parentChat ?? {}, sendCaps, resolvedThinking.mode) : void 0;
      const providerCapabilities = await readProviderCapabilities(input.providerId);
      const toolCallsMeta = getToolCallsMetaSync();
      const constrainedUserEnabled = isConstrainedDecodingEnabledForProvider(
        provider,
        toolCallsMeta
      );
      // llama.cpp / mlx count prompt + n_predict against n_ctx. Trim against
      // tools only; leftover after the live prompt becomes request max_tokens.
      const refreshLocalWindowReserves = () => resolveLocalWindowReserves({
        providerId: input.providerId,
        maxTokens: resolvedSampler.maxTokens,
        modelLimit: modelContextLimit,
        toolsReserveTokens: estimateToolsTokens(input.tools),
        messages
      });
      let { reservedTokens, requestMaxTokens } = refreshLocalWindowReserves();
      const noteContextStatus = (turnIndex, label, estimatedTokens) => {
        if (!label) return;
        budgetEvents.push({
          turn: turnIndex,
          label,
          estimatedTokens
        });
      };
      const enforceContextBudget = async (turnIndex, effectiveLimitOverride) => {
        // Drop superseded screenshot pixels before anything prices the prompt —
        // a per-turn screenshot loop is otherwise pure context growth.
        const prunedImages = pruneSupersededToolImages(messages);
        if (prunedImages.droppedImages > 0) {
          messages.length = 0;
          messages.push(...prunedImages.messages);
          noteContextStatus(
            turnIndex,
            `Dropped ${prunedImages.droppedImages} superseded screenshot${prunedImages.droppedImages === 1 ? "" : "s"}`,
            estimateApiMessagesTokens(messages)
          );
        }
        ({ reservedTokens, requestMaxTokens } = refreshLocalWindowReserves());
        const calibrated = contextCalibratedMessageLimit(
          input.modelId,
          modelContextLimit,
          SAFETY_MARGIN,
          reservedTokens
        );
        const override = effectiveLimitOverride ?? calibrated ?? void 0;
        const budgetResolved = resolveContextBudget({
          agentConfig: contextBudget,
          modelLimit: modelContextLimit,
          reservedTokens,
          effectiveLimitOverride: override
        });
        const budgetApplied = await applyContextPolicy({
          messages,
          policy: contextBudget.enforcementPolicy,
          modelLimit: modelContextLimit,
          agentConfig: contextBudget,
          providerId: input.providerId,
          modelId: input.modelId,
          signal: input.signal,
          reservedTokens,
          effectiveLimitOverride: override,
          onStatus: (_level, message) => {
            noteContextStatus(turnIndex, message, estimateApiMessagesTokens(messages));
          }
        });
        if (budgetApplied.applied) {
          messages.length = 0;
          messages.push(...budgetApplied.messages);
          if (budgetApplied.statusMessage) {
            noteContextStatus(turnIndex, budgetApplied.statusMessage, budgetApplied.tokensAfter);
          }
        }
        const limit = budgetResolved.effectiveLimit;
        if (limit != null && estimateApiMessagesTokens(messages) > limit) {
          return false;
        }
        return true;
      };
      const requestStructuredOutcome = async (repair) => {
        const finalMessages = cloneSubAgentMessages2(messages);
        if (repair) {
          finalMessages.push({
            role: "user",
            content: SUB_AGENT_STRUCTURED_OUTCOME_REPAIR_PROMPT
          });
        } else {
          finalMessages.push({
            role: "user",
            content: buildSubAgentFinalizationPrompt(summarySchema).trim()
          });
        }
        let body = applySamplerToBody(
          {
            model: input.modelId || void 0,
            messages: finalMessages,
            stream: true
          },
          resolvedSampler.preset,
          requestMaxTokens
        );
        mergeThinkingIntoCompletionBody(
          body,
          "off",
          provider,
          sendCaps
        );
        const modelRow = getModelRowForSelectOrCanonicalId(input.modelId);
        const resolvedApi = resolveModelApi(provider, input.modelId, modelRow ?? void 0);
        const anthropicFinalization = resolvedApi === "anthropic-v1";
        let usedOutcomeResponseFormat = false;
        const outcomeFormat = buildSubAgentOutcomeResponseFormat(summarySchema);
        if (outcomeFormat && !anthropicFinalization && isStructuredOutcomeResponseFormatAvailable(input.modelId, providerCapabilities)) {
          body = { ...body, response_format: outcomeFormat };
          usedOutcomeResponseFormat = true;
        }
        const preferNonStreamFinalization = usedOutcomeResponseFormat && providerCapabilities?.structuredOutputStreaming !== true;
        if (preferNonStreamFinalization) {
          body.stream = false;
        }
        const runFinalizationTurn = async (attemptBody) => {
          if (attemptBody.stream === false) {
            return runSubAgentNonStreamTurn(
              input.providerId,
              attemptBody,
              input.signal,
              provider,
              sendCaps
            );
          }
          try {
            return await streamSubAgentTurn(
              input.providerId,
              attemptBody,
              input.signal,
              input.type,
              void 0,
              { provider, modelCapabilities: sendCaps },
              { onTurnEvent: emitTurnEvent, chatId: input.parentChatId || input.runId }
            );
          } catch (streamErr) {
            if (usedOutcomeResponseFormat && isResponseFormatRejectionError(streamErr)) {
              usedOutcomeResponseFormat = false;
              return streamSubAgentTurn(
                input.providerId,
                stripResponseFormatFromBody(attemptBody),
                input.signal,
                input.type,
                void 0,
                { provider, modelCapabilities: sendCaps },
                { onTurnEvent: emitTurnEvent, chatId: input.parentChatId || input.runId }
              );
            }
            throw streamErr;
          }
        };
        emitRoundStart();
        let turnResult = await runFinalizationTurn(body);
        await ledgerSubAgentTurn(input, turnResult);
        const turnUsage = turnResult.streamMeta.usage ?? {};
        const turnStats = turnResult.streamMeta.stats ?? {};
        if (Object.keys(turnUsage).length > 0) {
          usageSegments.push(turnUsage);
          noteUsage(turnUsage);
        }
        if (Object.keys(turnStats).length > 0 || Object.keys(turnUsage).length > 0) {
          statsSegments.push({ stats: turnStats, usage: turnUsage });
        }
        let rawText = await completionTextForTurn(
          turnResult,
          body,
          provider,
          sendCaps,
          input.signal
        );
        if (!rawText && usedOutcomeResponseFormat) {
          emitRoundEnd(turnResult);
          usedOutcomeResponseFormat = false;
          body = stripResponseFormatFromBody(body);
          emitRoundStart();
          turnResult = await runFinalizationTurn(body);
          await ledgerSubAgentTurn(input, turnResult);
          rawText = await completionTextForTurn(
            turnResult,
            body,
            provider,
            sendCaps,
            input.signal
          );
        }
        emitRoundEnd(turnResult);
        logSubAgentDebug("finalization_turn", {
          repair,
          usedOutcomeResponseFormat,
          finishReason: turnResult.finishReason ?? null,
          rawLen: rawText.length,
          preview: rawText ? `${rawText.slice(0, 200)}${rawText.length > 200 ? "\u2026" : ""}` : ""
        });
        if (!rawText) {
          return {
            ok: false,
            parseError: "Empty response from provider on final turn",
            rawText: ""
          };
        }
        try {
          const parsed = parseStructuredOutcomeJson(rawText);
          const outcome = validateStructuredOutcome(parsed, summarySchema);
          if (outcome) return { ok: true, outcome, rawText };
          const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}\u2026` : rawText;
          return {
            ok: false,
            parseError: `JSON did not match summary schema (preview: ${JSON.stringify(preview)})`,
            rawText
          };
        } catch {
          const preview = rawText.length > 200 ? `${rawText.slice(0, 200)}\u2026` : rawText;
          return {
            ok: false,
            parseError: `Invalid JSON in final response (preview: ${JSON.stringify(preview)})`,
            rawText
          };
        }
      };
      let turnThinkingBudgetTracker = null;
      let turnBudgetContinuationAttempts = 0;
      let overflowRetries = 0;
      for (let turn = 0; ; turn++) {
        const updatedConfig = await input.refreshRoundConfig?.();
        if (updatedConfig) {
          const systemRow = messages.find((row) => row.role === "system");
          if (systemRow) systemRow.content = updatedConfig.systemPrompt;
          else messages.unshift({ role: "system", content: updatedConfig.systemPrompt });
          input.tools = updatedConfig.tools;
          hasAskQuestionTool = input.tools.some((t) => t.function.name === "ask_question");
        }
        spliceRoundBoundaryRows();
        if (!await enforceContextBudget(turn)) {
          return {
            summary: SUB_AGENT_CONTEXT_BUDGET_ERROR,
            toolTurns,
            messages,
            contextBudgetExhausted: true,
            budgetEvents,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        }
        const repaired = repairUnpairedToolCalls(messages);
        messages.length = 0;
        messages.push(...repaired);
        const body = applySamplerToBody(
          {
            model: input.modelId || void 0,
            messages,
            stream: true
          },
          resolvedSampler.preset,
          requestMaxTokens
        );
        const llamaSupportsThinkingBudget = provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID && providerCapabilities?.supportsThinkingBudget === true;
        const { nativeBudgetApplied } = mergeThinkingIntoCompletionBody(
          body,
          resolvedThinking.mode,
          provider,
          sendCaps,
          turnReasoningEffort,
          void 0,
          resolvedThinkingBudget.budgetTokens,
          { llamaSupportsThinkingBudget }
        );
        let thinkingBudgetTracker = null;
        if (resolvedThinkingBudget.budgetTokens != null && !nativeBudgetApplied && resolvedThinking.mode === "on") {
          turnThinkingBudgetTracker ??= new ThinkingBudgetTracker(
            resolvedThinkingBudget.budgetTokens
          );
          thinkingBudgetTracker = turnThinkingBudgetTracker;
        }
        if (input.tools.length > 0) {
          body.tools = input.tools;
          body.tool_choice = "auto";
        }
        let usedConstrained = false;
        if (input.tools.length > 0) {
          const constrainedApplied = applyConstrainedToolCallsToBody(body, {
            providerId: input.providerId,
            modelId: input.modelId,
            userEnabled: constrainedUserEnabled,
            capabilities: providerCapabilities,
            enabledTools: input.tools
          });
          Object.assign(body, constrainedApplied.body);
          usedConstrained = constrainedApplied.usedConstrained;
        }
        let streamingAssistant = "";
        const streamProgress = {
          onReasoningDelta: (reasoningSoFar) => {
            emitLiveActivity({
              phase: "thinking",
              partialReasoning: reasoningSoFar,
              currentToolName: null
            });
          },
          onToolCallDelta: (toolName) => {
            // Argument streaming can last minutes; flush prose before "Calling…".
            emitLiveDelta(streamingAssistant, true);
            emitLiveActivity({
              phase: "tools",
              currentToolName: toolName
            });
          }
        };
        const runSubTurn = (turnBody, streamOpts) => streamSubAgentTurn(
          input.providerId,
          turnBody,
          input.signal,
          input.type,
          (fullSoFar) => {
            streamingAssistant = fullSoFar;
            emitLiveDelta(streamingAssistant);
            emitLiveActivity({
              phase: "generating",
              partialReasoning: void 0,
              currentToolName: null
            });
            emitProgress(streamingAssistant);
          },
          { provider, modelCapabilities: sendCaps },
          {
            ...streamOpts,
            ...streamProgress,
            onTurnEvent: emitTurnEvent,
            chatId: input.parentChatId || input.runId
          }
        ).finally(() => {
          emitLiveDelta(streamingAssistant, true);
        });
        const runSubTurnWithThinkingBudget = async () => {
          let currentBody = body;
          const tracker = thinkingBudgetTracker;
          let prefillPartial = "";
          let carriedText = "";
          let carriedReasoning = "";
          const maxContinuations = 2;
          const streamOpts = () => ({
            thinkingBudgetTracker: tracker,
            prefillEchoPartial: prefillPartial || void 0,
            carriedText: carriedText || void 0,
            carriedReasoning: carriedReasoning || void 0
          });
          while (true) {
            let turnResult2;
            try {
              turnResult2 = await runSubTurn(currentBody, streamOpts());
            } catch (streamErr) {
              if (usedConstrained && isResponseFormatRejectionError(streamErr)) {
                usedConstrained = false;
                currentBody = stripResponseFormatFromBody(currentBody);
                turnResult2 = await runSubTurn(currentBody, streamOpts());
              } else {
                throw streamErr;
              }
            }
            if (!turnResult2.thinkingBudgetExceeded || !tracker || turnBudgetContinuationAttempts >= maxContinuations) {
              if (turnBudgetContinuationAttempts > 0) tracker?.disarm();
              return turnResult2;
            }
            turnBudgetContinuationAttempts += 1;
            const partialThinking = turnResult2.reasoningText.trim() || (turnResult2.partialThinkingText ?? "");
            const partialText = turnResult2.fullText;
            const isFinalAttempt = turnBudgetContinuationAttempts >= maxContinuations;
            if (!isFinalAttempt) {
              const canPrefill = turnResult2.thinkingChannel === "inline" || turnResult2.thinkingChannel == null && (modelLikelyUsesInlineThinking(input.modelId) || provider.id === LLAMA_CPP_LOCAL_PROVIDER_ID && !llamaSupportsThinkingBudget);
              const usePrefill = canPrefill && !partialText.trim();
              currentBody = {
                ...body,
                messages: [
                  ...messages,
                  ...usePrefill ? [buildThinkingPrefillAssistantMessage(partialThinking)] : buildBudgetContinuationMessages({ partialThinking, partialText })
                ]
              };
              prefillPartial = usePrefill ? partialThinking : "";
              carriedText = partialText;
              carriedReasoning = turnResult2.reasoningText;
              tracker.beginContinuation();
              continue;
            }
            const continuationBody = applySamplerToBody(
              {
                model: input.modelId || void 0,
                messages: [
                  ...messages,
                  ...buildBudgetContinuationMessages({ partialThinking, partialText })
                ],
                stream: true
              },
              resolvedSampler.preset,
              requestMaxTokens
            );
            mergeThinkingIntoCompletionBody(
              continuationBody,
              "off",
              provider,
              sendCaps,
              turnReasoningEffort
            );
            if (input.tools.length > 0) {
              continuationBody.tools = input.tools;
              continuationBody.tool_choice = "auto";
            }
            currentBody = continuationBody;
            prefillPartial = "";
            carriedText = partialText;
            carriedReasoning = turnResult2.reasoningText;
            tracker.disarm();
          }
        };
        emitRoundStart();
        let turnResult;
        try {
          turnResult = await runSubTurnWithThinkingBudget();
        } catch (streamErr) {
          if (isAbortLikeStreamError(streamErr, input.signal)) throw streamErr;
          const reason = errorText(streamErr);
          if (isContextOverflowText(reason) && overflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES) {
            const sentEstimate = estimateApiMessagesTokens(messages);
            const numbers = parseContextOverflowNumbers(reason);
            if (numbers) {
              recordContextEstimateBias(
                input.modelId,
                numbers.requestTokens,
                sentEstimate,
                reservedTokens
              );
            }
            const retryLimit = contextRetryMessageLimit(sentEstimate, numbers, SAFETY_MARGIN);
            const fit = await enforceContextBudget(turn, retryLimit);
            const after = estimateApiMessagesTokens(messages);
            if (fit && after < sentEstimate) {
              overflowRetries += 1;
              logSubAgentDebug("context_overflow_retry", {
                retry: overflowRetries,
                sentEstimate,
                after,
                retryLimit
              });
              continue;
            }
          }
          const prose = streamingAssistant.trim();
          const hasPartial = toolTurns > 0 || prose.length > 0;
          if (!hasPartial) throw streamErr;
          if (prose) {
            messages.push({ role: "assistant", content: prose });
          }
          emitProgress(void 0, true);
          const legacy = legacyOutcomeFromSummary(prose || reason);
          logSubAgentDebug("stream_error_partial_transcript", {
            reason,
            proseLen: prose.length,
            toolTurns
          });
          return {
            summary: legacy.summary,
            structuredOutcome: legacy,
            toolTurns,
            messages,
            budgetEvents: budgetEvents.length ? budgetEvents : void 0,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        }
        overflowRetries = 0;
        const subFinishReason = turnResult.finishReason || (turnResult.toolCalls.length > 0 ? "tool_calls" : void 0);
        const subStreamEnd = classifyStreamEnd({
          finishReason: subFinishReason,
          toolCallsCount: turnResult.toolCalls.length,
          textLength: turnResult.fullText.trim().length,
          streamError: turnResult.streamMeta.error
        });
        if (subStreamEnd.kind !== "complete" && subStreamEnd.kind !== "truncated") {
          reportBackgroundError("stream-end-abnormal", {
            kind: subStreamEnd.kind,
            providerId: input.providerId,
            modelId: input.modelId,
            finishReason: subFinishReason ?? null,
            textLength: turnResult.fullText.trim().length,
            round: turn
          });
        }
        applyClassifiedStreamEnd(subStreamEnd, {
          hasPostToolTail: hasPostToolTail(messages),
          textLength: turnResult.fullText.trim().length
        });
        await ledgerSubAgentTurn(input, turnResult);
        const turnUsage = turnResult.streamMeta.usage ?? {};
        const turnStats = turnResult.streamMeta.stats ?? {};
        if (Object.keys(turnUsage).length > 0) {
          usageSegments.push(turnUsage);
          noteUsage(turnUsage);
        }
        if (Object.keys(turnStats).length > 0 || Object.keys(turnUsage).length > 0) {
          statsSegments.push({ stats: turnStats, usage: turnUsage });
        }
        logSubAgentDebug("work_turn", {
          turn,
          toolTurns,
          finishReason: turnResult.finishReason ?? null,
          toolCallCount: turnResult.toolCalls.length,
          proseLen: turnResult.fullText.length
        });
        if (turnResult.toolCalls.length > 0) {
          toolTurns += 1;
          messages.push(
            buildSubAgentToolAssistantMessage(input.modelId, turnResult)
          );
          const firstTool = turnResult.toolCalls[0]?.function?.name?.trim();
          emitLiveActivity(
            {
              phase: "tools",
              currentToolName: firstTool || null,
              partialReasoning: void 0
            },
            true
          );
          emitProgress(void 0, true);
          try {
            const outcomes = await runHeadlessToolBatch({
              toolCalls: turnResult.toolCalls,
              constrained: usedConstrained,
              signal: input.signal,
              execute: (name, args, ctx) => input.executeTool(name, args, {
                ...input.toolExecuteContext,
                toolCallId: ctx.toolCallId
              })
            });
            const imageFollowUps = [];
            const sendImages = canSendToolImages(input.modelId);
            for (const outcome of outcomes) {
              const tc = outcome.toolCall;
              if (outcome.parseError) {
                messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: outcome.parseError
                });
              } else {
                const toolOut = outcome.result ?? { content: "" };
                messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: toolOut.content + (!sendImages && toolOut.attachments?.some((att) => att.type === "image") ? TOOL_IMAGE_NO_VISION_HINT : "")
                });
                if (sendImages) {
                  const followUp = toolImageFollowUpFromAttachments(toolOut.attachments);
                  if (followUp) imageFollowUps.push(followUp);
                }
              }
              emitProgress(void 0, true);
            }
            // Keep all tool replies adjacent before adding multimodal user rows.
            messages.push(...imageFollowUps);
          } finally {
            emitRoundEnd(turnResult);
          }
          continue;
        }
        emitRoundEnd(turnResult);
        let prose = await completionTextForTurn(
          turnResult,
          body,
          provider,
          sendCaps,
          input.signal
        );
        if (!prose && toolTurns > 0 && hasPostToolTail(messages) && emptyPostToolRetries < MAX_EMPTY_POST_TOOL_RETRIES) {
          emptyPostToolRetries += 1;
          messages.push({ role: "user", content: EMPTY_POST_TOOL_CONTINUE_INSTRUCTION });
          emitProgress(void 0, true);
          continue;
        }
        if (hasAskQuestionTool && prose && looksLikeProseStructuredQuestion(prose) && proseQuestionRetries < MAX_PROSE_QUESTION_RETRIES) {
          proseQuestionRetries += 1;
          messages.push({ role: "assistant", content: prose });
          messages.push({ role: "user", content: PROSE_QUESTION_RETRY_INSTRUCTION });
          emitProgress(void 0, true);
          continue;
        }
        // Chat keeps nudgeToolUse off so a first-turn essay is not forced into
        // tools. Announce-then-stop ("Let me inspect…") still gets one hidden
        // retry. Truncation stays on the Continue chip, not this path.
        if (
          input.tools.length > 0 &&
          prose &&
          subStreamEnd.kind !== "truncated" &&
          looksLikeIntentToAct(prose) &&
          intentToActRetries < MAX_INTENT_TO_ACT_RETRIES
        ) {
          intentToActRetries += 1;
          messages.push({ role: "assistant", content: prose });
          messages.push({ role: "user", content: INTENT_TO_ACT_RETRY_INSTRUCTION });
          emitProgress(void 0, true);
          continue;
        }
        if (input.nudgeToolUse !== false && input.tools.length > 0 && toolTurns === 0 && !toolUseNudgeSent) {
          toolUseNudgeSent = true;
          messages.push({ role: "user", content: SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION });
          emitProgress(void 0, true);
          continue;
        }
        if (reportToolName && input.finalizeStructuredOutcome === false && !reportToolNudgeSent) {
          reportToolNudgeSent = true;
          if (prose) {
            messages.push({ role: "assistant", content: prose });
          }
          messages.push({
            role: "user",
            content: buildReportToolNudgeInstruction(reportToolName)
          });
          emitProgress(void 0, true);
          continue;
        }
        if (!await enforceContextBudget(turn)) {
          return {
            summary: SUB_AGENT_CONTEXT_BUDGET_ERROR,
            toolTurns,
            messages,
            contextBudgetExhausted: true,
            budgetEvents,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        }
        const returnProseWithoutFinalization = () => {
          messages.push({ role: "assistant", content: prose });
          emitProgress(void 0, true);
          return {
            summary: prose || "",
            toolTurns,
            messages,
            budgetEvents: budgetEvents.length ? budgetEvents : void 0,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        };
        if (input.finalizeStructuredOutcome === false) {
          return returnProseWithoutFinalization();
        }
        const proseOutcome = tryParseStructuredOutcomeFromAssistantProse(prose, summarySchema);
        if (proseOutcome) {
          messages.push({ role: "assistant", content: prose });
          emitProgress(void 0, true);
          return {
            summary: proseOutcome.summary,
            structuredOutcome: proseOutcome,
            toolTurns,
            messages,
            budgetEvents: budgetEvents.length ? budgetEvents : void 0,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        }
        const returnProseFallbackOutcome = () => {
          messages.push({ role: "assistant", content: prose });
          emitProgress(void 0, true);
          const legacy = legacyOutcomeFromSummary(prose);
          logSubAgentDebug("prose_fallback_outcome", { proseLen: prose.length, toolTurns });
          return {
            summary: legacy.summary,
            structuredOutcome: legacy,
            toolTurns,
            messages,
            budgetEvents: budgetEvents.length ? budgetEvents : void 0,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        };
        try {
          const firstFinal = await requestStructuredOutcome(false);
          const finalized = firstFinal.ok ? firstFinal : await requestStructuredOutcome(true);
          if (finalized.ok === false) {
            if (prose.trim()) {
              return returnProseFallbackOutcome();
            }
            const parseError = finalized.parseError;
            return {
              summary: parseError,
              toolTurns,
              messages,
              structuredOutcomeParseError: parseError,
              budgetEvents: budgetEvents.length ? budgetEvents : void 0,
              usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
              stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
            };
          }
          messages.push({ role: "assistant", content: finalized.rawText });
          emitProgress(void 0, true);
          return {
            summary: finalized.outcome.summary,
            structuredOutcome: finalized.outcome,
            toolTurns,
            messages,
            budgetEvents: budgetEvents.length ? budgetEvents : void 0,
            usage: usageSegments.length ? sumUsageSegments(usageSegments) : void 0,
            stats: statsSegments.length ? averageStatsSegments(statsSegments) : void 0
          };
        } catch (finalErr) {
          if (prose.trim()) {
            logSubAgentDebug("finalization_error_prose_fallback", {
              proseLen: prose.length,
              toolTurns,
              error: finalErr instanceof Error ? finalErr.message : String(finalErr)
            });
            return returnProseFallbackOutcome();
          }
          throw finalErr;
        }
      }
    }
  };
  return defaultSubAgentRunner;
}

// ── Clone ────────────────────────────────────────────────────────────────────

function cloneSubAgentMessages(messages) {
  return structuredClone(messages);
}
export {
  cloneSubAgentMessages,
  createSubAgentRunner
};
