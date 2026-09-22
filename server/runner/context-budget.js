import { apiMessageContentToText } from "./message-content.js";
import {
  imagePaddingForEstimate,
  estimateTokensFromText,
  estimateImageUrlsTokens
} from "./token-estimate-core.js";
import { isToolImageFollowUpMessage } from "./tool-image-follow-up.js";
import { LLAMA_CPP_LOCAL_PROVIDER_ID, MLX_LM_LOCAL_PROVIDER_ID } from "./provider-ids.js";
import { isRealUserRow, isSummaryOnlyRow } from "./compaction/segment.js";
import { compactMessages, formatCompactionStatus, resolveCompactionConfig } from "./compaction/index.js";
const DEFAULT_CONTEXT_ENFORCEMENT_POLICY = "compact";
/**
 * `summarize`, `dropMiddle` and `archive` were retired with the deterministic
 * compactor; stored values read as `compact`. Unknown values return null.
 */
function normalizeContextEnforcementPolicy(value) {
  if (value === "compact" || value === "slide" || value === "truncate") return value;
  if (value === "summarize" || value === "dropMiddle" || value === "archive") return "compact";
  return null;
}
const SAFETY_MARGIN = 0.9;
const DEFAULT_KNOWN_WORKING_CONTEXT_TOKENS = 160_000;
const DEFAULT_UNKNOWN_WORKING_CONTEXT_TOKENS = 96_000;
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
  const out = {
    enforcementPolicy: normalizeContextEnforcementPolicy(resolvedPolicy ?? agent.contextEnforcementPolicy) ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
    minRecentTurns: agent.minRecentTurns
  };
  if (agent.highWater != null) out.highWater = agent.highWater;
  if (agent.lowWater != null) out.lowWater = agent.lowWater;
  if (agent.summaryBudgetTokens != null) out.summaryBudgetTokens = agent.summaryBudgetTokens;
  if (agent.workingContextTokens != null) out.workingContextTokens = agent.workingContextTokens;
  return out;
}
/**
 * Fill compaction knobs the agent leaves unset from the global defaults
 * (Settings → Agents → Context policy). The agent's own values win.
 */
function withCompactionDefaults(config, defaults) {
  if (!defaults || typeof defaults !== "object") return config;
  const out = { ...config };
  for (const key of ["highWater", "lowWater", "minRecentTurns", "summaryBudgetTokens", "workingContextTokens"]) {
    if (out[key] == null && typeof defaults[key] === "number" && Number.isFinite(defaults[key])) {
      out[key] = defaults[key];
    }
  }
  return out;
}
function agentContextBudgetFromSubAgentType(type, resolvedPolicy) {
  return agentContextBudgetFromWorkAgent(type, resolvedPolicy);
}
function resolveContextBudget(params) {
  const policy = normalizeContextEnforcementPolicy(params.agentConfig?.enforcementPolicy) ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY;
  const modelLimit = normalizePositiveInt(params.modelLimit);
  const reservedTokens = Math.max(0, Math.floor(params.reservedTokens ?? 0));
  const override = normalizePositiveInt(params.effectiveLimitOverride);
  const physical = modelLimit != null ? Math.max(1, Math.floor(modelLimit * SAFETY_MARGIN) - reservedTokens) : null;
  const configured = params.agentConfig?.workingContextTokens;
  // Zero opts out of the efficiency ceiling, never the physical model limit.
  const defaultWorking = modelLimit == null ? DEFAULT_UNKNOWN_WORKING_CONTEXT_TOKENS : DEFAULT_KNOWN_WORKING_CONTEXT_TOKENS;
  const working = configured === 0 ? null : Math.max(1, (normalizePositiveInt(configured) ?? defaultWorking) - reservedTokens);
  const ceilings = [physical, override, working].filter(n => n != null);
  const effectiveLimit = ceilings.length ? Math.min(...ceilings) : null;
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
  return isSummaryOnlyRow(msg);
}
function countPinnedSystemMessages(messages) {
  let n = 0;
  for (const msg of messages) {
    if (msg.role === "system") n += 1;
    else break;
  }
  return n;
}
/** A user row the person typed: not a screenshot follow-up, not an injected summary. */
function isRealUserMessage(msg) {
  return isRealUserRow(msg);
}
/** Index of the latest real user row at or after `systemEnd`, or -1. */
function latestRealUserIndex(messages, systemEnd = 0) {
  for (let i = messages.length - 1; i >= systemEnd; i -= 1) {
    if (isRealUserMessage(messages[i])) return i;
  }
  return -1;
}
/**
 * Rounds: a user row on its own, or an assistant row with its tool results and
 * screenshot follow-ups. Pairing-safe cut points inside a turn.
 */
function partitionRounds(messages, systemEnd, end = messages.length) {
  const rounds = [];
  let i = systemEnd;
  while (i < end) {
    const next = Math.min(end, unitEndAt(messages, i));
    rounds.push({ start: i, end: next });
    i = next;
  }
  return rounds;
}
/**
 * Turns: one user row plus every assistant / tool row up to the next user row.
 * An injected prior-context summary is a turn of its own, and rows before the
 * first user row form a headless turn.
 */
function partitionTurns(messages, systemEnd) {
  const turns = [];
  let i = systemEnd;
  while (i < messages.length) {
    const start = i;
    if (isPriorContextSummary(messages[i])) {
      turns.push({ start, end: i + 1 });
      i += 1;
      continue;
    }
    i = unitEndAt(messages, i);
    while (i < messages.length && (messages[i].role !== "user" || isToolImageFollowUpMessage(messages[i]))) {
      i = unitEndAt(messages, i);
    }
    turns.push({ start, end: i });
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
  // The marker is appended after the cut; leave room for it or a small overage
  // never converges (each pass cut 32 chars and added 33).
  const maxChars = Math.max(32, serializeApiMessageForEstimate(messages[bestIdx]).length - over * 4 - TRUNCATION_MARKER.length);
  const next = [...messages];
  next[bestIdx] = truncateMessageContent(messages[bestIdx], maxChars);
  return { messages: next, changed: true };
}
function applyTruncatePolicy(messages, limit, systemEnd) {
  let working = [...messages];
  let dropped = 0;
  while (estimateApiMessagesTokens(working) > limit) {
    // The latest real user row is the request being answered — never drop it.
    const pinned = latestRealUserIndex(working, systemEnd);
    let removeAt = -1;
    for (let i = systemEnd; i < working.length; i = unitEndAt(working, i)) {
      if (!isPriorContextSummary(working[i]) && i !== pinned) {
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
  const { turns, droppedTurns, droppedRounds } = dropOldestTurnsUntilUnderLimit(
    messages,
    limit,
    systemEnd,
    minRecentTurns
  );
  let working = rebuildFromTurns(messages, systemEnd, turns);
  let dropped = messages.length - working.length;
  if (estimateApiMessagesTokens(working) > limit) {
    const trunc = applyTruncatePolicy(working, limit, systemEnd);
    working = trunc.messages;
    dropped += trunc.dropped;
  }
  return { messages: working, dropped, droppedTurns, droppedRounds };
}
/**
 * Drop whole turns oldest-first down to `minRecentTurns`. If that still does
 * not fit, fold the kept turns' rounds oldest-first — except the latest real
 * user row, and the last round after it, which always stay verbatim.
 * Returned `turns` are the kept slices in order (whole turns or rounds).
 */
function dropOldestTurnsUntilUnderLimit(messages, limit, systemEnd, minRecentTurns) {
  const overLimit = (slices) => estimateApiMessagesTokens(rebuildFromTurns(messages, systemEnd, slices)) > limit;
  let turns = partitionTurns(messages, systemEnd);
  let droppedTurns = 0;
  let droppedRounds = 0;
  while (turns.length > minRecentTurns && overLimit(turns)) {
    turns = turns.slice(1);
    droppedTurns += 1;
  }
  if (turns.length === 0 || !overLimit(turns)) {
    return { turns, droppedTurns, droppedRounds };
  }
  const pinned = latestRealUserIndex(messages, systemEnd);
  let slices = turns.flatMap((t) => partitionRounds(messages, t.start, t.end));
  while (overLimit(slices)) {
    const at = slices.findIndex((s) => !(pinned >= s.start && pinned < s.end));
    if (at < 0) break;
    const candidate = slices[at];
    const roundsAfterPinned = slices.filter((s) => s.start > pinned).length;
    if (candidate.start > pinned && roundsAfterPinned <= 1) break;
    slices = [...slices.slice(0, at), ...slices.slice(at + 1)];
    droppedRounds += 1;
  }
  return { turns: slices, droppedTurns, droppedRounds };
}
function formatContextTrimStatus(policy, droppedTurns, droppedRounds = 0) {
  const parts = [`Context trimmed (${policy})`];
  const omitted = [];
  if (droppedTurns > 0) {
    omitted.push(`${droppedTurns} older turn${droppedTurns === 1 ? "" : "s"}`);
  }
  if (droppedRounds > 0) {
    omitted.push(`${droppedRounds} older tool round${droppedRounds === 1 ? "" : "s"}`);
  }
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(" and ")}`);
  return parts.join(": ");
}
/**
 * Stateless compaction for sync callers (estimates, one-shot trims). Every row
 * id is its index, so there is no previous checkpoint to merge; the runner's
 * turn loop keeps checkpoints across rounds itself.
 */
function applyCompactPolicy(messages, resolved, agentConfig, tokensBefore) {
  const out = compactMessages({
    messages,
    limit: resolved.effectiveLimit,
    window: resolved.modelLimit,
    config: resolveCompactionConfig(agentConfig, resolved.modelLimit ?? resolved.effectiveLimit),
    trigger: "auto"
  });
  if (!out.changed) {
    return {
      messages,
      applied: false,
      policy: "compact",
      tokensBefore,
      tokensAfter: tokensBefore,
      droppedMessageCount: 0,
      droppedTurns: 0,
      droppedRounds: 0,
      summaryInjected: false,
      statusMessage: null
    };
  }
  const summary = out.checkpoint?.summary ?? "";
  return {
    messages: out.messages,
    applied: true,
    policy: "compact",
    tokensBefore,
    tokensAfter: out.tokensAfter,
    droppedMessageCount: Math.max(0, messages.length - out.messages.length),
    droppedTurns: out.droppedTurns,
    droppedRounds: out.droppedRounds,
    summaryInjected: Boolean(summary) && out.checkpoint?.foldThroughRow != null,
    ...summary ? { summaryText: summary } : {},
    checkpoint: out.checkpoint,
    statusMessage: formatCompactionStatus(out)
  };
}
function applyContextBudget(messages, resolved, agentConfig) {
  const policy = normalizeContextEnforcementPolicy(resolved.policy) ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY;
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
    droppedRounds: 0,
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
  if (policy === "compact") {
    return applyCompactPolicy(messages, { ...resolved, policy }, agentConfig, tokensBefore);
  }
  const systemEnd = countPinnedSystemMessages(messages);
  const minRecentTurns = Math.max(1, Math.floor(agentConfig?.minRecentTurns ?? 1));
  let nextMessages = messages;
  let dropped = 0;
  let droppedTurns = 0;
  let droppedRounds = 0;
  if (policy === "truncate") {
    const out = applyTruncatePolicy(messages, limit, systemEnd);
    nextMessages = out.messages;
    dropped = out.dropped;
  } else {
    const out = applySlidePolicy(messages, limit, systemEnd, minRecentTurns);
    nextMessages = out.messages;
    dropped = out.dropped;
    droppedTurns = out.droppedTurns;
    droppedRounds = out.droppedRounds;
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
    droppedRounds,
    summaryInjected: false,
    statusMessage: formatContextTrimStatus(policy, droppedTurns, droppedRounds)
  };
}
/**
 * `RunnerDeps.applyContextPolicy` for server runners (boards, sub-agents,
 * Super Plan). Sync policies only; honors the compact-and-retry override, which
 * a hand-rolled dep that dropped it turned into a no-op retry that then threw.
 */
function applyServerContextPolicy(input, fallbackConfig) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const agentConfig = input?.agentConfig ?? fallbackConfig ?? {
    enforcementPolicy: DEFAULT_CONTEXT_ENFORCEMENT_POLICY
  };
  const resolved = resolveContextBudget({
    agentConfig,
    modelLimit: input?.modelLimit ?? null,
    reservedTokens: input?.reservedTokens,
    effectiveLimitOverride: input?.effectiveLimitOverride
  });
  return applyContextBudget(messages, resolved, agentConfig);
}
export {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  LOCAL_MIN_GENERATION_TOKENS,
  LOCAL_PROMPT_FLOOR_TOKENS,
  SAFETY_MARGIN,
  agentContextBudgetFromSubAgentType,
  agentContextBudgetFromWorkAgent,
  applyContextBudget,
  applyServerContextPolicy,
  countPinnedSystemMessages,
  dropOldestTurnsUntilUnderLimit,
  estimateApiMessageTokens,
  estimateApiMessagesTokens,
  formatContextTrimStatus,
  isLocalKvCacheProvider,
  isPriorContextSummary,
  isRealUserMessage,
  latestRealUserIndex,
  localGenerationReserveTokens,
  localRequestMaxTokens,
  normalizeContextEnforcementPolicy,
  partitionRounds,
  partitionTurns,
  rebuildFromTurns,
  resolveContextBudget,
  resolveLocalWindowReserves,
  sanitizeToolPairing,
  serializeApiMessageForEstimate,
  withCompactionDefaults
};
