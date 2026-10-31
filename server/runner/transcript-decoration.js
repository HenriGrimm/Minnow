import { anthropicReasoningBlocks } from './anthropic-reasoning.js';
import { splitThinkingSegments } from './reasoning.js';
import { applyClassifiedStreamEnd, classifyStreamEnd } from './stream-end.js';
import { finalizeResponseMeta, normalizeUsageTotals } from './response-meta.js';
import { isToolImageFollowUpMessage } from './tool-image-follow-up.js';
import {
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION, EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  INTENT_TO_ACT_RETRY_INSTRUCTION, PROSE_QUESTION_RETRY_INSTRUCTION,
  resolveFinalAssistantContent, SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
} from './turn-continuation.js';

const CONTROL_ROWS = new Set([
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION, EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  PROSE_QUESTION_RETRY_INSTRUCTION, INTENT_TO_ACT_RETRY_INSTRUCTION,
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
]);
const WIRE_REASONING_KEYS = ['reasoning', 'reasoning_content', 'reasoning_signature', 'reasoning_blocks'];
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const emptyRound = index => ({ index, thinkingSnapshot: '', reasoning: '' });

/** Event-to-history projection shared by both execution hosts. No timers or I/O. */
export function createTranscriptDecoration(options = {}) {
  const now = options.now ?? (() => performance.now());
  const toolOutcomes = new Map();
  let round = emptyRound(0);
  let segmentStart = null;
  let closedMs = 0;
  const closeSegment = () => {
    if (segmentStart !== null) closedMs += Math.max(0, now() - segmentStart);
    segmentStart = null;
  };
  const resetDuration = () => { segmentStart = null; closedMs = 0; };
  const thoughts = () => {
    const supplied = options.readThinkingSegments?.() ?? [];
    if (supplied.length) return supplied;
    const text = round.reasoning?.trim() || round.thinkingSnapshot?.trim();
    return text ? splitThinkingSegments(text) : [];
  };
  const applyMeta = row => {
    if (round.stats && Object.keys(round.stats).length) row.stats = round.stats;
    if (round.usage && Object.keys(round.usage).length) row.usage = round.usage;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls.length : 0;
    const textLength = typeof row.content === 'string' ? row.content.trim().length : 0;
    const classified = classifyStreamEnd({ finishReason: round.finishReason,
      toolCallsCount: toolCalls, textLength, streamError: round.streamError });
    if (classified.kind === 'aborted') return;
    if (classified.kind === 'incomplete' && (textLength || row.thinking?.length || toolCalls)) return;
    if (applyClassifiedStreamEnd(classified, { hasPostToolTail: toolCalls > 0, textLength }).truncated) {
      row.truncated = true;
    }
  };

  return {
    observe(event) {
      if (event.type === 'response_restart') {
        round = emptyRound(round.index); resetDuration(); return;
      }
      if (event.type === 'round_start') {
        round = emptyRound(event.index); resetDuration(); return;
      }
      if (event.type === 'thinking') {
        round.thinkingSnapshot = event.text;
        round.reasoningFormat = event.reasoningFormat;
        if (segmentStart === null) segmentStart = now();
        return;
      }
      if (event.type === 'reasoning_end') { closeSegment(); return; }
      if (event.type === 'stream_meta') {
        if (record(event.stats)) round.stats = event.stats;
        if (record(event.usage)) round.usage = event.usage;
        if (record(event.runtime?.timings)) round.timings = { ...round.timings, ...event.runtime.timings };
        if (event.finishReason) round.finishReason = event.finishReason;
        return;
      }
      if (event.type === 'tool_result' && event.id) {
        toolOutcomes.set(event.id, {
          ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          ...(record(event.codeChange) ? { codeChange: event.codeChange } : {}),
        });
        return;
      }
      if (event.type !== 'round_end') return;
      closeSegment();
      round.reasoning = event.reasoning;
      round.reasoningFormat = event.reasoningFormat ?? round.reasoningFormat;
      round.reasoningBlocks = event.reasoningBlocks;
      if (record(event.runtime?.timings)) round.timings = { ...round.timings, ...event.runtime.timings };
      if (event.finishReason) round.finishReason = event.finishReason;
      const stats = record(event.stats);
      const usage = record(event.usage);
      if (Number.isFinite(event.t0) && Number.isFinite(event.tEnd)) {
        const finalized = finalizeResponseMeta({ usage: usage ?? round.usage,
          stats: stats ?? round.stats, timings: round.timings, finish_reason: round.finishReason,
          ...(event.reasoning?.trim() ? { streamed_reasoning: true } : {}),
        }, event.t0, Number.isFinite(event.tFirst) ? event.tFirst : null, event.tEnd);
        if (Object.keys(finalized.stats).length) round.stats = finalized.stats;
        else if (stats) round.stats = stats;
        if (Object.keys(finalized.usage).length) round.usage = finalized.usage;
        else if (usage) round.usage = normalizeUsageTotals(usage);
      } else {
        if (stats) round.stats = stats;
        if (usage) round.usage = normalizeUsageTotals(usage);
      }
    },
    decorate(message) {
      if ((options.omitSystem && message.role === 'system') ||
          (message.role === 'user' && CONTROL_ROWS.has(message.content)) ||
          isToolImageFollowUpMessage(message)) return null;
      const row = { ...message };
      if (row.role === 'tool') {
        return { ...row, ...(toolOutcomes.get(row.tool_call_id) ?? {}) };
      }
      if (row.role !== 'assistant') return row;
      const blocks = anthropicReasoningBlocks(row.reasoning_blocks ?? round.reasoningBlocks);
      if (blocks.length) row.thinkingBlocks = blocks;
      const signature = options.readThinkingSignature?.() || row.reasoning_signature;
      for (const key of WIRE_REASONING_KEYS) delete row[key];
      const thinking = thoughts();
      if (thinking.length) {
        row.thinking = thinking;
        if (round.reasoningFormat) row.reasoningFormat = round.reasoningFormat;
        closeSegment();
        const duration = Math.max(0, Math.round(closedMs));
        if (duration > 0) row.thinkingDurationMs = duration;
        if (signature) row.thinkingSignature = signature;
      }
      resetDuration();
      if (!row.tool_calls?.length) {
        row.content = resolveFinalAssistantContent(typeof row.content === 'string' ? row.content : '', thinking).content;
      }
      applyMeta(row);
      return row;
    },
    patchAssistant(message) {
      const row = { ...message };
      if (row.role !== 'assistant') return row;
      if (round.reasoningFormat) row.reasoningFormat = round.reasoningFormat;
      const blocks = anthropicReasoningBlocks(round.reasoningBlocks);
      if (blocks.length) row.thinkingBlocks = blocks;
      if (!row.thinking?.length) {
        const thinking = thoughts();
        if (thinking.length) row.thinking = thinking;
      }
      applyMeta(row);
      return row;
    },
    abortThinking: resetDuration,
  };
}
