import { getModelRowForSelectOrCanonicalId } from '../api/models';
import {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  resolveContextBudget,
} from './context-budget';
import { contextLengthFromModelRow } from '../lib/context-length';
import { formatModelLabel } from '../lib/format-model-label';
import { decodeModelSelectKey, encodeModelSelectKey, findFirstSelectKeyForCanonicalModelId } from '../lib/model-select-key';
import { modelCache } from '../app-state';
import type { Attachment } from '../attachments/types';
import { attachmentImageDataUrl } from '../attachments/attachment-image';
import type { Chat, LmModelRecord } from '../types';
import { resolveLastTurnMetrics } from '../usage/chat-turn-metrics';
import {
  estimateInFlightOverlayTokens,
  type ContextInFlightOverlay,
} from './context-in-flight';
import {
  estimateImageUrlTokens,
  estimateTokensFromText,
  type OutboundPromptEstimate,
} from './prompts/token-estimate-core';

// ── Types ────────────────────────────────────────────────────────────────────

export type ContextUsageSectionKey =
  | 'system'
  | 'brainNotes'
  | 'codeMap'
  | 'contextDocuments'
  | 'rules'
  | 'tools'
  | 'history'
  | 'compressed'
  | 'inFlight'
  | 'composer'
  | 'attachments';

export interface ContextUsageSection {
  key: ContextUsageSectionKey;
  label: string;
  tokens: number;
}

/** Breakdown rows that describe the last request (not pending extras). */
const CORE_USAGE_SECTION_KEYS = new Set<ContextUsageSectionKey>([
  'system',
  'brainNotes',
  'codeMap',
  'contextDocuments',
  'rules',
  'tools',
  'history',
  'compressed',
]);

export interface ContextBudget {
  /** Cumulative provider usage across requests; separate from context capacity. */
  sessionUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    completionCount: number;
  };
  modelId: string;
  modelDisplayName: string;
  /** Model max context length when known. */
  limit: number | null;
  /**
   * Tokens counted toward the window: last-turn API total when known,
   * otherwise the character estimate. Pending composer/attachments/in-flight
   * tool JSON are added on top.
   */
  used: number;
  /** limit - used when limit is known. */
  remaining: number | null;
  /** 0–100 for the ring; capped at 100; null when limit unknown. */
  percent: number | null;
  /**
   * Where the context enforcement policy starts trimming, in whole-prompt
   * tokens. Same ceiling the runner applies before every send, so the ring can
   * never promise room the next request will not get.
   */
  compressAtTokens: number | null;
  /** True when the next send crosses that ceiling and history gets compressed. */
  willCompress: boolean;
  /** False when USED is grounded in provider last-turn usage. */
  isEstimate: boolean;
  /** Provider prompt_tokens from the last completed turn, if any. */
  lastTurnPromptTokens: number | null;
  /** Provider completion_tokens from the last completed turn, if any. */
  lastTurnCompletionTokens: number | null;
  /** Provider total_tokens (prompt+completion) from the last completed turn. */
  lastTurnTotalTokens: number | null;
  breakdown: ContextUsageSection[];
}

export interface GetContextBudgetOptions {
  chat?: Chat;
  modelId?: string;
  /** Pending composer textarea (chars ÷ 4 estimate). */
  pendingComposerText?: string;
  /** Precomputed attachment token estimate. */
  pendingAttachmentTokens?: number;
  /** Streaming / not-yet-persisted turn content (BUG-019). */
  inFlight?: Omit<ContextInFlightOverlay, 'chatId'>;
}

// ── Breakdown ────────────────────────────────────────────────────────────────

/** Rough token count for queued attachment payloads. */
export function estimateAttachmentTokens(attachments: Attachment[]): number {
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.kind === 'error') continue;
    if (attachment.text) {
      total += estimateTokensFromText(attachment.text);
      continue;
    }
    const imageDataUrl = attachmentImageDataUrl(attachment);
    if (imageDataUrl) {
      total += estimateImageUrlTokens(imageDataUrl);
      continue;
    }
    if (attachment.dataUrl) {
      total += estimateTokensFromText(attachment.dataUrl);
      continue;
    }
    if (attachment.workspacePath) {
      total += estimateTokensFromText(attachment.workspacePath) + 256;
      continue;
    }
    total += estimateTokensFromText(attachment.name);
  }
  return total;
}

/** Section rows for the breakdown panel from estimate buckets + pending input. */
export function buildContextUsageBreakdown(
  estimate: OutboundPromptEstimate,
  composerTokens: number,
  attachmentTokens: number,
  inFlightTokens = 0,
): ContextUsageSection[] {
  const historyLabel = estimate.historyCompressed
    ? 'History (after compression)'
    : 'History';
  const rows: ContextUsageSection[] = [
    {
      key: 'system',
      label: estimate.legacyFallback ? 'System (legacy drawer)' : 'System',
      tokens: Math.max(
        0,
        estimate.composedSystem -
          (estimate.brainNotesSystem ?? 0) -
          (estimate.codeMapSystem ?? 0) -
          (estimate.contextDocumentsSystem ?? 0),
      ),
    },
  ];
  if (estimate.brainNotesSystem != null && estimate.brainNotesSystem > 0) {
    rows.push({
      key: 'brainNotes',
      label: 'Brain notes',
      tokens: estimate.brainNotesSystem,
    });
  } else if (estimate.brainNotesInjectionEnabled) {
    rows.push({
      key: 'brainNotes',
      label: 'Brain notes (loading)',
      tokens: 0,
    });
  }
  if (estimate.codeMapSystem != null && estimate.codeMapSystem > 0) {
    rows.push({
      key: 'codeMap',
      label: 'Code map',
      tokens: estimate.codeMapSystem,
    });
  } else if (estimate.codeMapInjectionEnabled) {
    rows.push({
      key: 'codeMap',
      label: 'Code map (loading)',
      tokens: 0,
    });
  }
  if (estimate.contextDocumentsSystem != null && estimate.contextDocumentsSystem > 0) {
    rows.push({
      key: 'contextDocuments',
      label: 'Context documents',
      tokens: estimate.contextDocumentsSystem,
    });
  } else if (estimate.contextDocumentsInjectionEnabled) {
    rows.push({
      key: 'contextDocuments',
      label: 'Context documents (loading)',
      tokens: 0,
    });
  }
  rows.push(
    { key: 'rules', label: 'Rules', tokens: estimate.userRules },
    { key: 'tools', label: 'Tools', tokens: estimate.tools },
    { key: 'history', label: historyLabel, tokens: estimate.history },
  );
  if (
    estimate.compressedContextEstimate != null &&
    estimate.compressedContextEstimate > 0
  ) {
    rows.push({
      key: 'compressed',
      label: 'Compressed context (estimate)',
      tokens: estimate.compressedContextEstimate,
    });
  }
  if (inFlightTokens > 0) {
    rows.push({
      key: 'inFlight',
      label: 'In progress (estimate)',
      tokens: inFlightTokens,
    });
  }
  if (composerTokens > 0) {
    rows.push({ key: 'composer', label: 'Composer (pending)', tokens: composerTokens });
  }
  if (attachmentTokens > 0) {
    rows.push({ key: 'attachments', label: 'Attachments (pending)', tokens: attachmentTokens });
  }
  return rows;
}

function sumBreakdownTokens(sections: ContextUsageSection[]): number {
  let total = 0;
  for (const section of sections) {
    total += section.tokens;
  }
  return total;
}

function sumCoreBreakdownTokens(sections: ContextUsageSection[]): number {
  let total = 0;
  for (const section of sections) {
    if (CORE_USAGE_SECTION_KEYS.has(section.key)) total += section.tokens;
  }
  return total;
}

/**
 * Scale system/tools/history rows so they sum to the last-turn API total.
 * Composer / attachments / in-flight stay unscaled extras on top.
 */
export function scaleCoreBreakdownToTarget(
  sections: ContextUsageSection[],
  target: number,
): ContextUsageSection[] {
  if (!Number.isFinite(target) || target < 0) return sections;
  const coreSum = sumCoreBreakdownTokens(sections);
  if (coreSum <= 0) return sections;

  const scaled = sections.map((section) => {
    if (!CORE_USAGE_SECTION_KEYS.has(section.key)) return section;
    return {
      ...section,
      tokens: Math.round((section.tokens * target) / coreSum),
    };
  });

  const drift = target - sumCoreBreakdownTokens(scaled);
  if (drift === 0) return scaled;

  let maxIndex = -1;
  let maxTokens = -1;
  for (let i = 0; i < scaled.length; i += 1) {
    const section = scaled[i];
    if (!CORE_USAGE_SECTION_KEYS.has(section.key)) continue;
    if (section.tokens >= maxTokens) {
      maxTokens = section.tokens;
      maxIndex = i;
    }
  }
  if (maxIndex < 0) return scaled;
  const adjusted = scaled[maxIndex];
  scaled[maxIndex] = {
    ...adjusted,
    tokens: Math.max(0, adjusted.tokens + drift),
  };
  return scaled;
}

function lookupCachedModelRow(modelId: string): LmModelRecord | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const direct = modelCache.get(trimmed);
  if (direct) return direct;
  const decoded = decodeModelSelectKey(trimmed);
  if (decoded) {
    return modelCache.get(encodeModelSelectKey(decoded.providerId, decoded.modelId));
  }
  for (const key of modelCache.keys()) {
    const entry = decodeModelSelectKey(key);
    if (entry?.modelId === trimmed) {
      return modelCache.get(key);
    }
  }
  const fallbackKey = findFirstSelectKeyForCanonicalModelId(modelCache.keys(), trimmed);
  return fallbackKey ? modelCache.get(fallbackKey) : undefined;
}

function resolveModelDisplayName(modelId: string): string {
  const cached = lookupCachedModelRow(modelId);
  if (cached) {
    return formatModelLabel({
      id: cached.id,
      quantization: cached.quantization,
      state: cached.state,
    }).primary;
  }
  return formatModelLabel({ id: modelId }).primary;
}

export function resolveContextLimit(modelId: string, chat: Chat): number | null {
  const cached = getModelRowForSelectOrCanonicalId(modelId);
  if (cached) {
    const fromRow = contextLengthFromModelRow(cached);
    if (fromRow != null) return fromRow;
  }

  const fromChat = chat.modelInfo?.context_length;
  if (typeof fromChat === 'number' && Number.isFinite(fromChat) && fromChat > 0) {
    return fromChat;
  }

  return null;
}

/**
 * The trim ceiling for a model window, in whole-prompt tokens.
 *
 * Derived from the enforcement module itself so the ring and the runner cannot
 * drift apart. `reservedTokens` is 0 on purpose: the runner subtracts the tool
 * schemas because it measures messages only, whereas `used` here is a whole
 * prompt — provider `prompt_tokens` counts tool schemas, and so does the
 * estimate breakdown's `tools` row.
 */
export function resolveCompressAtTokens(limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return resolveContextBudget({
    agentConfig: { enforcementPolicy: DEFAULT_CONTEXT_ENFORCEMENT_POLICY },
    modelLimit: limit,
    reservedTokens: 0,
  }).effectiveLimit;
}

/** Ring fill percent (0–100); null when limit unknown. */
export function computeContextUsagePercent(used: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  const raw = (used / limit) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

// ── Budget ───────────────────────────────────────────────────────────────────

/** Pure merge of estimate buckets + pending input into a budget snapshot. */
export function assembleContextBudget(params: {
  modelId: string;
  modelDisplayName: string;
  limit: number | null;
  estimate: OutboundPromptEstimate;
  composerTokens: number;
  attachmentTokens: number;
  inFlightTokens?: number;
  lastTurnPromptTokens?: number | null;
  lastTurnCompletionTokens?: number | null;
  lastTurnTotalTokens?: number | null;
  sessionUsage?: ContextBudget['sessionUsage'];
}): ContextBudget {
  const lastTurnPromptTokens = params.lastTurnPromptTokens ?? null;
  const lastTurnCompletionTokens = params.lastTurnCompletionTokens ?? null;
  const lastTurnTotalTokens = params.lastTurnTotalTokens ?? null;
  const apiCore =
    lastTurnTotalTokens != null
      ? lastTurnTotalTokens
      : lastTurnPromptTokens;

  let breakdown = buildContextUsageBreakdown(
    params.estimate,
    params.composerTokens,
    params.attachmentTokens,
    params.inFlightTokens ?? 0,
  );
  if (apiCore != null) {
    if (sumCoreBreakdownTokens(breakdown) > 0) {
      breakdown = scaleCoreBreakdownToTarget(breakdown, apiCore);
    } else {
      // Nothing to scale (empty first-turn estimate) — show the API total as history.
      breakdown = [
        { key: 'history', label: 'History', tokens: apiCore },
        ...breakdown.filter((section) => !CORE_USAGE_SECTION_KEYS.has(section.key)),
      ];
    }
  }

  const used = sumBreakdownTokens(breakdown);
  const limit = params.limit;
  const remaining = limit != null ? Math.max(0, limit - used) : null;
  const percent = computeContextUsagePercent(used, limit);
  const compressAtTokens = resolveCompressAtTokens(limit);
  // Either signal means the next send is trimmed: the measured prompt already
  // crosses the ceiling, or the outbound estimate says the policy would fire.
  const willCompress =
    (compressAtTokens != null && used >= compressAtTokens) ||
    params.estimate.historyCompressed === true;

  return {
    modelId: params.modelId,
    sessionUsage: params.sessionUsage,
    modelDisplayName: params.modelDisplayName,
    limit,
    used,
    remaining,
    percent,
    compressAtTokens,
    willCompress,
    isEstimate: apiCore == null,
    lastTurnPromptTokens,
    lastTurnCompletionTokens,
    lastTurnTotalTokens,
    breakdown,
  };
}

export async function getContextBudget(
  options?: GetContextBudgetOptions,
): Promise<ContextBudget> {
  const { getActiveChat, ensureChatHistoryLoaded } = await import('../state/sessions');
  const chat = options?.chat ?? getActiveChat();
  await ensureChatHistoryLoaded(chat.id);
  const modelId =
    options?.modelId?.trim() ||
    chat.modelId?.trim() ||
    '';

  const { resolveOutboundPromptEstimate } = await import('./prompts/token-estimate');
  const estimate = await resolveOutboundPromptEstimate({ chat, modelId });
  const composerTokens = estimateTokensFromText(options?.pendingComposerText?.trim() ?? '');
  const attachmentTokens = options?.pendingAttachmentTokens ?? 0;
  const inFlightTokens = estimateInFlightOverlayTokens(options?.inFlight);

  const lastTurn = resolveLastTurnMetrics(chat);

  return assembleContextBudget({
    modelId,
    modelDisplayName: modelId ? resolveModelDisplayName(modelId) : 'No model',
    limit: modelId ? resolveContextLimit(modelId, chat) : null,
    estimate,
    composerTokens,
    attachmentTokens,
    inFlightTokens,
    lastTurnPromptTokens: lastTurn?.prompt_tokens ?? null,
    lastTurnCompletionTokens: lastTurn?.completion_tokens ?? null,
    lastTurnTotalTokens: lastTurn?.total_tokens ?? null,
    sessionUsage: chat.tokenLedger?.totals,
  });
}
