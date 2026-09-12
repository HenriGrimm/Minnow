import { streamDeltaContentToText } from './message-content.js';

/** @param {{ error?: unknown, choices?: Array<{ finish_reason?: string, delta?: { content?: unknown, tool_calls?: unknown[] }, message?: { content?: unknown } }> }} chunk */
export function extractStreamErrorMessage(chunk) {
  const raw = chunk.error;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object') {
    const message = /** @type {{ message?: unknown }} */ (raw).message;
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
export function extractStreamDelta(chunk) {
  const choice = chunk.choices?.[0];
  if (!choice) return '';
  const fromDelta = streamDeltaContentToText(choice.delta?.content);
  if (fromDelta) return fromDelta;
  return streamDeltaContentToText(choice.message?.content);
}

/** Merge streaming `tool_calls` fragments into an accumulator keyed by `index`. */
export function mergeToolCallDelta(acc, chunk) {
  const deltas = chunk.choices?.[0]?.delta?.tool_calls;
  if (!deltas?.length) return acc;

  const next = { ...acc };
  for (const d of deltas) {
    const idx = d.index;
    const existing = next[idx] || { type: 'function', function: { name: '', arguments: '' } };
    const merged = {
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
        ...merged.function,
        name: (merged.function?.name || '') + d.function.name,
      };
    }
    if (d.function?.arguments) {
      merged.function = {
        ...merged.function,
        arguments: (merged.function?.arguments || '') + d.function.arguments,
      };
    }
    next[idx] = merged;
  }
  return next;
}

/** Turn a streaming accumulator into complete `tool_calls` rows (sorted by index). */
export function finalizeToolCalls(acc) {
  return Object.keys(acc)
    .map((k) => Number(k))
    .filter((idx) => Number.isFinite(idx))
    .sort((a, b) => a - b)
    .map((idx) => {
      const partial = acc[idx];
      return {
        id: partial?.id || `call_${idx}`,
        type: 'function',
        function: {
          name: partial?.function?.name || '',
          arguments: partial?.function?.arguments || '',
        },
      };
    })
    .filter((tc) => Boolean(tc.function.name));
}

/** Plain message content from a non-streaming completion. */
export function extractMessageText(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return streamDeltaContentToText(message.content);
}

/**
 * Assistant text from a completion message: prose content, structured parsed JSON, or refusal.
 */
export function extractAssistantCompletionText(message) {
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

/**
 * llama.cpp `timings` in the shape the stats reconciler already understands.
 * Returns null until there is something worth trusting.
 */
export function statsFromLlamaTimings(timings) {
  if (!timings) return null;
  const predictedN = Number(timings.predicted_n);
  const predictedMs = Number(timings.predicted_ms);
  if (!(predictedN >= 2) || !(predictedMs > 0)) return null;

  const out = {
    generation_time: predictedMs / 1000,
    tokens_per_second:
      Number(timings.predicted_per_second) > 0
        ? Number(timings.predicted_per_second)
        : (predictedN / predictedMs) * 1000,
  };
  if (Number(timings.prompt_ms) > 0) out.time_to_first_token = Number(timings.prompt_ms) / 1000;
  if (Number(timings.prompt_per_second) > 0) {
    out.prompt_tokens_per_second = Number(timings.prompt_per_second);
  }
  const draftN = Number(timings.draft_n);
  const draftAccepted = Number(timings.draft_n_accepted);
  if (draftN > 0 && Number.isFinite(draftAccepted)) {
    out.draft_acceptance = draftAccepted / draftN;
  }
  return out;
}

/**
 * Fill OpenAI-style usage gaps from llama.cpp `prompt_n` / `predicted_n`.
 * Hosted llama often emits timings without a `usage` block.
 * `prompt_n` excludes KV-cache reuse (`cache_n`); the whole prompt is their sum.
 */
export function fillUsageFromLlamaTimings(usage, timings) {
  const out = { ...(usage || {}) };
  if (!timings) return normalizeUsageFields(out);
  const promptN = Number(timings.prompt_n);
  const cacheN = Number(timings.cache_n);
  const predictedN = Number(timings.predicted_n);
  if (out.prompt_tokens == null && Number.isFinite(promptN) && promptN >= 0) {
    out.prompt_tokens = promptN + (Number.isFinite(cacheN) && cacheN > 0 ? cacheN : 0);
  }
  if (out.completion_tokens == null && Number.isFinite(predictedN) && predictedN >= 0) {
    out.completion_tokens = predictedN;
  }
  return normalizeUsageFields(out);
}

/** Derive total_tokens when only prompt/completion counts are present. */
function normalizeUsageFields(usage) {
  const out = { ...usage };
  if (out.total_tokens != null && Number.isFinite(out.total_tokens)) return out;
  const hasPrompt = out.prompt_tokens != null && Number.isFinite(out.prompt_tokens);
  const hasCompletion =
    out.completion_tokens != null && Number.isFinite(out.completion_tokens);
  if (!hasPrompt && !hasCompletion) return out;
  out.total_tokens = (out.prompt_tokens ?? 0) + (out.completion_tokens ?? 0);
  return out;
}

/** Merge stats, usage, model_info, and finish_reason from successive chunks. */
export function mergeStreamMeta(acc, chunk) {
  const next = { ...(acc || {}) };
  if (chunk.timings) {
    next.timings = { ...next.timings, ...chunk.timings };
    const derived = statsFromLlamaTimings(next.timings);
    if (derived) next.stats = { ...next.stats, ...derived };
  }
  if (chunk.prompt_progress) next.prompt_progress = chunk.prompt_progress;
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
    next.usage = normalizeUsageFields(next.usage);
  }
  return next;
}
