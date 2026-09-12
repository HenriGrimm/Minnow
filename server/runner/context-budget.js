import { apiMessageContentToText } from "./message-content.js";
import {
  charsPerTokenFor,
  imagePaddingForEstimate,
  estimateTokensFromText,
  estimateImageUrlsTokens
} from "./token-estimate-core.js";
import { isToolImageFollowUpMessage } from "./tool-image-follow-up.js";
import { LLAMA_CPP_LOCAL_PROVIDER_ID, MLX_LM_LOCAL_PROVIDER_ID } from "./provider-ids.js";
const DEFAULT_CONTEXT_ENFORCEMENT_POLICY = "summarize";
const SAFETY_MARGIN = 0.9;
/**
 * Minimum tokens we still leave for the message estimate after tools when a
 * caller asks "is the ceiling usable?" in tests. Generation is **not** subtracted
 * from this ceiling — llama.cpp leftover is applied to `max_tokens` instead.
 */
const LOCAL_PROMPT_FLOOR_TOKENS = 4096;
/**
 * Least `max_tokens` a local request asks for. llama.cpp accepts prompt +
 * n_predict > n_ctx and stops at the window, so a small floor never overflows;
 * a floor of 1 turned every post-trim turn into a one-token reply.
 */
const LOCAL_MIN_GENERATION_TOKENS = 4096;
const TRUNCATION_MARKER = "[\u2026 truncated for context budget]";
const SUMMARY_HEADER = "## Prior context (compressed)\n";
function normalizePositiveInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n > 0 ? n : null;
}
/** Data URLs of every `image_url` part in a multi-part message content. */
function imageUrlsOf(content) {
  const urls = [];
  for (const part of content) {
    if (part.type === "image_url") urls.push(part.image_url?.url);
  }
  return urls;
}
function serializeApiMessageForEstimate(msg) {
  if (msg.role === "system") return msg.content;
  if (msg.role === "user") {
    const text = apiMessageContentToText(msg.content);
    if (Array.isArray(msg.content)) {
      return text + imagePaddingForEstimate(imageUrlsOf(msg.content));
    }
    return text;
  }
  if (msg.role === "tool") return msg.content;
  if (msg.role === "assistant") {
    const base = apiMessageContentToText(msg.content);
    if (msg.tool_calls?.length) {
      return base + JSON.stringify(msg.tool_calls);
    }
    return base;
  }
  return "";
}
/**
 * Chat templates (Qwen, DeepSeek, gpt-oss) and hosted APIs (Anthropic) drop an
 * assistant turn's reasoning once a later user message exists; only the live
 * tool loop replays it. Counting all of it priced a 64.6k-token Qwen prompt at
 * 115k — trimming what fit and pinning max_tokens at the floor. Local llama.cpp /
 * mlx-lm hosts do render that in-loop reasoning: the sanitizer replays it as
 * `reasoning_content`, the only field their templates read.
 */
function lastUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && !isToolImageFollowUpMessage(messages[i])) return i;
  }
  return -1;
}
function estimateApiMessageTokens(msg, options) {
  if (msg.role === "system") return estimateTokensFromText(msg.content, "prose");
  if (msg.role === "tool") return estimateTokensFromText(msg.content, "payload");
  if (msg.role === "user") {
    const text = apiMessageContentToText(msg.content);
    const images = Array.isArray(msg.content) ? imageUrlsOf(msg.content) : [];
    return estimateTokensFromText(text, "prose") + estimateImageUrlsTokens(images);
  }
  if (msg.role === "assistant") {
    let total = estimateTokensFromText(apiMessageContentToText(msg.content), "prose");
    if (msg.tool_calls?.length) {
      total += estimateTokensFromText(JSON.stringify(msg.tool_calls), "payload");
    }
    if (options?.replaysReasoning === false) return total;
    const reasoning = (msg.reasoning ?? "") + (msg.reasoning_content ?? "") + (msg.reasoning_signature ?? "");
    if (reasoning) total += estimateTokensFromText(reasoning, "prose");
    return total;
  }
  return 0;
}
function estimateApiMessagesTokens(messages) {
  const lastUser = lastUserMessageIndex(messages);
  let total = 0;
  for (let i = 0; i < messages.length; i += 1) {
    total += estimateApiMessageTokens(messages[i], { replaysReasoning: i > lastUser });
  }
  return total;
}
function agentContextBudgetFromWorkAgent(agent, resolvedPolicy) {
  return {
    enforcementPolicy: resolvedPolicy ?? agent.contextEnforcementPolicy ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
    minRecentTurns: agent.minRecentTurns,
    summaryReserveTokens: agent.summaryReserveTokens,
    archive: agent.archive
  };
}
function agentContextBudgetFromSubAgentType(type, resolvedPolicy) {
  return agentContextBudgetFromWorkAgent(type, resolvedPolicy);
}
function resolveContextBudget(params) {
  const policy = params.agentConfig.enforcementPolicy ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY;
  const modelLimit = normalizePositiveInt(params.modelLimit);
  const reservedTokens = Math.max(0, Math.floor(params.reservedTokens ?? 0));
  const override = normalizePositiveInt(params.effectiveLimitOverride);
  if (override != null) {
    return { effectiveLimit: override, modelLimit, policy, reservedTokens };
  }
  const effectiveLimit = modelLimit != null ? Math.max(1, Math.floor(modelLimit * SAFETY_MARGIN) - reservedTokens) : null;
  return { effectiveLimit, modelLimit, policy, reservedTokens };
}
function isLocalKvCacheProvider(providerId) {
  return providerId === LLAMA_CPP_LOCAL_PROVIDER_ID || providerId === MLX_LM_LOCAL_PROVIDER_ID;
}
/**
 * Tokens llama.cpp / mlx can spend on n_predict given the live prompt.
 * This is a `max_tokens` cap, not a tax on the message ceiling — subtracting
 * Settings maxTokens (32k) from a 70k window was what crashed chats that the
 * context wheel still showed as mostly empty.
 */
function localGenerationReserveTokens(params) {
  if (!isLocalKvCacheProvider(params?.providerId)) return 0;
  const requested = Math.floor(params.maxTokens ?? 0);
  if (requested <= 0) return 0;
  const window = Math.floor(params.modelLimit ?? 0);
  if (window <= 0) return 0;
  const tools = Math.max(0, Math.floor(params.toolsReserveTokens ?? 0));
  const currentMessages = estimateApiMessagesTokens(
    Array.isArray(params.messages) ? params.messages : [],
  );
  // Leftover against the whole window: the message ceiling already keeps the
  // SAFETY_MARGIN, so taking it again here left 0 for a prompt trimmed to fit.
  const leftover = window - tools - currentMessages;
  if (leftover <= 0) return 0;
  return Math.min(requested, leftover);
}
/**
 * Request `max_tokens` for a local host. When n_ctx is known this is leftover
 * after the live prompt, floored at LOCAL_MIN_GENERATION_TOKENS so a prompt
 * trimmed right up to the ceiling still gets a real reply.
 * Unknown n_ctx keeps the Settings max.
 */
function localRequestMaxTokens(params) {
  const requested = Math.floor(params?.maxTokens ?? 0);
  if (!isLocalKvCacheProvider(params?.providerId)) return requested;
  const window = Math.floor(params.modelLimit ?? 0);
  if (window <= 0) return requested;
  const leftover = Math.floor(params.generationReserveTokens ?? 0);
  const floor = requested > 0 ? Math.min(requested, LOCAL_MIN_GENERATION_TOKENS) : 1;
  return Math.max(floor, leftover);
}
function resolveLocalWindowReserves(params) {
  const toolsReserveTokens = Math.max(0, Math.floor(params?.toolsReserveTokens ?? 0));
  const requestedMax = Math.floor(params?.maxTokens ?? 0);
  const generationReserveTokens = localGenerationReserveTokens({
    providerId: params?.providerId,
    maxTokens: requestedMax,
    modelLimit: params?.modelLimit,
    toolsReserveTokens,
    messages: params?.messages
  });
  return {
    generationReserveTokens,
    // Trim against tool schemas only. Prompt + n_predict sharing n_ctx is
    // handled by capping requestMaxTokens, not by shrinking the message budget.
    reservedTokens: toolsReserveTokens,
    requestMaxTokens: isLocalKvCacheProvider(params?.providerId)
      ? localRequestMaxTokens({
        providerId: params.providerId,
        maxTokens: requestedMax,
        modelLimit: params.modelLimit,
        generationReserveTokens
      })
      : requestedMax
  };
}
function isPriorContextSummary(msg) {
  return msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith(SUMMARY_HEADER);
}
function countPinnedSystemMessages(messages) {
  let n = 0;
  for (const msg of messages) {
    if (msg.role === "system") n += 1;
    else break;
  }
  return n;
}
function partitionTurns(messages, systemEnd) {
  const turns = [];
  let i = systemEnd;
  while (i < messages.length) {
    if (messages[i].role !== "user" || isToolImageFollowUpMessage(messages[i])) {
      const end = unitEndAt(messages, i);
      turns.push({ start: i, end });
      i = end;
      continue;
    }
    turns.push({ start: i, end: i + 1 });
    i += 1;
    while (i < messages.length && (messages[i].role !== "user" || isToolImageFollowUpMessage(messages[i]))) {
      const end = unitEndAt(messages, i);
      turns.push({ start: i, end });
      i = end;
    }
  }
  return turns;
}
function rebuildFromTurns(messages, systemEnd, turns) {
  const pinned = messages.slice(0, systemEnd);
  const tail = [];
  for (const turn of turns) {
    tail.push(...messages.slice(turn.start, turn.end));
  }
  return [...pinned, ...tail];
}
function unitEndAt(messages, start) {
  const msg = messages[start];
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    let end = start + 1;
    while (end < messages.length && messages[end].role === "tool") end += 1;
    while (end < messages.length && isToolImageFollowUpMessage(messages[end])) end += 1;
    return end;
  }
  return start + 1;
}
function sanitizeToolPairing(messages) {
  const answeredIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) answeredIds.add(msg.tool_call_id);
  }
  const requestedIds = /* @__PURE__ */ new Set();
  const out = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const kept = msg.tool_calls.filter((tc) => answeredIds.has(tc.id));
      if (kept.length === 0) {
        if (apiMessageContentToText(msg.content).trim()) {
          const { tool_calls: _dropped, ...rest } = msg;
          out.push(rest);
        }
        continue;
      }
      for (const tc of kept) requestedIds.add(tc.id);
      out.push(kept.length === msg.tool_calls.length ? msg : { ...msg, tool_calls: kept });
      continue;
    }
    if (msg.role === "tool") {
      if (!requestedIds.has(msg.tool_call_id)) continue;
      out.push(msg);
      continue;
    }
    if (isToolImageFollowUpMessage(msg)) {
      const prev = out[out.length - 1];
      if (prev?.role !== "tool") continue;
      out.push(msg);
      continue;
    }
    out.push(msg);
  }
  return out;
}
function collectTurnText(messages, turn) {
  const parts = [];
  for (let i = turn.start; i < turn.end; i += 1) {
    const text = serializeApiMessageForEstimate(messages[i]).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}
function buildExtractiveSummary(text, maxTokens) {
  const budgetChars = Math.max(32, Math.floor(maxTokens * charsPerTokenFor("payload")));
  const body = text.trim();
  if (!body) return "";
  if (body.length <= budgetChars) return body;
  const headLen = Math.floor(budgetChars * 0.4);
  const tailLen = Math.floor(budgetChars * 0.4);
  return `${body.slice(0, headLen)}
\u2026
${body.slice(-tailLen)}`;
}
function truncateMessageContent(msg, maxChars) {
  const marker = TRUNCATION_MARKER;
  if (msg.role === "system" || msg.role === "tool") {
    const content = msg.content;
    if (content.length <= maxChars) return msg;
    return { ...msg, content: content.slice(0, maxChars) + marker };
  }
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      if (msg.content.length <= maxChars) return msg;
      return { ...msg, content: msg.content.slice(0, maxChars) + marker };
    }
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p.type === "text");
      if (textParts.length === 0) return msg;
      const combined = textParts.map((p) => p.text).join("\n");
      if (combined.length <= maxChars) return msg;
      const trimmed = combined.slice(0, maxChars) + marker;
      const next = [{ type: "text", text: trimmed }];
      for (const part of msg.content) {
        if (part.type === "image_url") next.push(part);
      }
      return { ...msg, content: next };
    }
    return msg;
  }
  if (msg.role === "assistant") {
    if (typeof msg.content === "string" && msg.content.length > maxChars) {
      return { ...msg, content: msg.content.slice(0, maxChars) + marker };
    }
  }
  return msg;
}
function hardTruncateLongestMessage(messages, systemEnd, limit) {
  let bestIdx = -1;
  let bestLen = 0;
  for (let i = systemEnd; i < messages.length; i += 1) {
    const len = serializeApiMessageForEstimate(messages[i]).length;
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return { messages, changed: false };
  const over = estimateApiMessagesTokens(messages) - limit;
  if (over <= 0) return { messages, changed: false };
  const maxChars = Math.max(32, serializeApiMessageForEstimate(messages[bestIdx]).length - over * 4);
  const next = [...messages];
  next[bestIdx] = truncateMessageContent(messages[bestIdx], maxChars);
  return { messages: next, changed: true };
}
function applyTruncatePolicy(messages, limit, systemEnd) {
  let working = [...messages];
  let dropped = 0;
  while (estimateApiMessagesTokens(working) > limit) {
    let removeAt = -1;
    for (let i = systemEnd; i < working.length; i += 1) {
      if (!isPriorContextSummary(working[i])) {
        removeAt = i;
        break;
      }
    }
    if (removeAt < 0) break;
    const removeEnd = unitEndAt(working, removeAt);
    if (removeEnd >= working.length) break;
    working = [...working.slice(0, removeAt), ...working.slice(removeEnd)];
    dropped += removeEnd - removeAt;
  }
  if (estimateApiMessagesTokens(working) > limit) {
    const hard = hardTruncateLongestMessage(working, systemEnd, limit);
    if (hard.changed) working = hard.messages;
  }
  return { messages: working, dropped };
}
function applySlidePolicy(messages, limit, systemEnd, minRecentTurns) {
  let turns = partitionTurns(messages, systemEnd);
  let dropped = 0;
  while (estimateApiMessagesTokens(rebuildFromTurns(messages, systemEnd, turns)) > limit && turns.length > minRecentTurns) {
    turns = turns.slice(1);
    dropped += 1;
  }
  let working = rebuildFromTurns(messages, systemEnd, turns);
  if (estimateApiMessagesTokens(working) > limit) {
    const trunc = applyTruncatePolicy(working, limit, systemEnd);
    working = trunc.messages;
    dropped += trunc.dropped;
  }
  return { messages: working, dropped };
}
function dropOldestTurnsUntilUnderLimit(messages, limit, systemEnd, minRecentTurns) {
  let turns = partitionTurns(messages, systemEnd);
  const droppedChunks = [];
  let droppedTurns = 0;
  while (estimateApiMessagesTokens(rebuildFromTurns(messages, systemEnd, turns)) > limit && turns.length > minRecentTurns) {
    droppedChunks.push(collectTurnText(messages, turns[0]));
    turns = turns.slice(1);
    droppedTurns += 1;
  }
  return { turns, droppedChunks, droppedTurns };
}
function injectSummaryMessage(messages, systemEnd, summaryBody) {
  const trimmed = summaryBody.trim();
  if (!trimmed) return messages;
  const summaryMsg = {
    role: "user",
    content: SUMMARY_HEADER + trimmed
  };
  return [
    ...messages.slice(0, systemEnd),
    summaryMsg,
    ...messages.slice(systemEnd)
  ];
}
function applyDropMiddlePolicy(messages, limit, systemEnd, minRecentTurns, summaryReserveTokens) {
  const { turns, droppedChunks, droppedTurns } = dropOldestTurnsUntilUnderLimit(
    messages,
    limit,
    systemEnd,
    minRecentTurns
  );
  let working = rebuildFromTurns(messages, systemEnd, turns);
  let summaryInjected = false;
  let summaryText;
  if (droppedChunks.length > 0) {
    const summaryBody = buildExtractiveSummary(
      droppedChunks.join("\n\n"),
      summaryReserveTokens
    );
    if (summaryBody.trim()) {
      summaryText = summaryBody;
      working = injectSummaryMessage(working, systemEnd, summaryBody);
      summaryInjected = true;
    }
  }
  let dropped = 0;
  if (estimateApiMessagesTokens(working) > limit) {
    const trunc = applyTruncatePolicy(working, limit, systemEnd);
    working = trunc.messages;
    dropped = trunc.dropped;
  }
  return { messages: working, dropped, droppedTurns, summaryInjected, summaryText };
}
function formatContextTrimStatus(policy, droppedTurns, summaryInjected) {
  const policyLabel = policy === "summarize" ? "summarized" : policy === "dropMiddle" ? "drop middle" : policy;
  const parts = [`Context trimmed (${policyLabel})`];
  if (droppedTurns > 0) {
    parts.push(
      `omitted ${droppedTurns} older turn${droppedTurns === 1 ? "" : "s"}`
    );
  }
  if (summaryInjected) parts.push("prior turns compressed");
  return parts.join(": ");
}
function applyContextBudget(messages, resolved, agentConfig) {
  const policy = resolved.policy;
  const tokensBefore = estimateApiMessagesTokens(messages);
  const limit = resolved.effectiveLimit;
  const base = (next, applied, extra = {}) => ({
    messages: next,
    applied,
    policy,
    tokensBefore,
    tokensAfter: estimateApiMessagesTokens(next),
    droppedMessageCount: 0,
    droppedTurns: 0,
    summaryInjected: false,
    statusMessage: null,
    ...extra
  });
  if (limit == null) {
    return base(messages, false);
  }
  if (tokensBefore <= limit) {
    return base(messages, false);
  }
  if (policy === "summarize") {
    return base(messages, false);
  }
  const systemEnd = countPinnedSystemMessages(messages);
  const minRecentTurns = Math.max(1, Math.floor(agentConfig?.minRecentTurns ?? 1));
  const summaryReserveTokens = Math.max(
    64,
    Math.floor(agentConfig?.summaryReserveTokens ?? 512)
  );
  let nextMessages = messages;
  let dropped = 0;
  let droppedTurns = 0;
  let summaryInjected = false;
  let summaryText;
  if (policy === "truncate") {
    const out = applyTruncatePolicy(messages, limit, systemEnd);
    nextMessages = out.messages;
    dropped = out.dropped;
  } else if (policy === "slide" || policy === "archive") {
    const out = applySlidePolicy(messages, limit, systemEnd, minRecentTurns);
    nextMessages = out.messages;
    dropped = out.dropped;
    droppedTurns = out.dropped;
  } else if (policy === "dropMiddle") {
    const out = applyDropMiddlePolicy(
      messages,
      limit,
      systemEnd,
      minRecentTurns,
      summaryReserveTokens
    );
    nextMessages = out.messages;
    dropped = out.dropped;
    droppedTurns = out.droppedTurns;
    summaryInjected = out.summaryInjected;
    summaryText = out.summaryText;
  }
  let tokensAfter = estimateApiMessagesTokens(nextMessages);
  let tightenPasses = 0;
  while (tokensAfter > limit && tightenPasses < 16) {
    const trunc = applyTruncatePolicy(nextMessages, limit, systemEnd);
    nextMessages = trunc.messages;
    dropped += trunc.dropped;
    tokensAfter = estimateApiMessagesTokens(nextMessages);
    if (tokensAfter > limit) {
      const hard = hardTruncateLongestMessage(nextMessages, systemEnd, limit);
      if (hard.changed) {
        nextMessages = hard.messages;
        tokensAfter = estimateApiMessagesTokens(nextMessages);
      }
    }
    tightenPasses += 1;
    if (tokensAfter <= limit) break;
  }
  const sanitized = sanitizeToolPairing(nextMessages);
  if (sanitized.length !== nextMessages.length) {
    nextMessages = sanitized;
    tokensAfter = estimateApiMessagesTokens(nextMessages);
  }
  return {
    messages: nextMessages,
    applied: true,
    policy,
    tokensBefore,
    tokensAfter,
    droppedMessageCount: dropped,
    droppedTurns,
    summaryInjected,
    summaryText,
    statusMessage: formatContextTrimStatus(policy, droppedTurns, summaryInjected)
  };
}
export {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  LOCAL_MIN_GENERATION_TOKENS,
  LOCAL_PROMPT_FLOOR_TOKENS,
  SAFETY_MARGIN,
  SUMMARY_HEADER,
  agentContextBudgetFromSubAgentType,
  agentContextBudgetFromWorkAgent,
  applyContextBudget,
  buildExtractiveSummary,
  collectTurnText,
  countPinnedSystemMessages,
  dropOldestTurnsUntilUnderLimit,
  estimateApiMessageTokens,
  estimateApiMessagesTokens,
  formatContextTrimStatus,
  injectSummaryMessage,
  isLocalKvCacheProvider,
  localGenerationReserveTokens,
  localRequestMaxTokens,
  partitionTurns,
  rebuildFromTurns,
  resolveContextBudget,
  resolveLocalWindowReserves,
  serializeApiMessageForEstimate
};
