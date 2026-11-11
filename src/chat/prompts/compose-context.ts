import {
  resolveActiveWorkAgent,
  resolveActiveWorkAgentId,
} from '../../agents/resolve-work-agent';
import { listExperts } from '../experts/registry';
import { normalizeModeId } from '../modes/types';
import { loadExpertsConfig } from '../../config/experts-config';
import { loadPromptMetaSettings } from '../../config/prompt-meta';
import {
  getUserRulesPayloadForSend,
  loadUserRules,
} from '../../config/user-rules';
import { getExpertSelection, sessionState } from '../../state/sessions';
import { resolveChatToolWorkspaceRoot } from '../../state/chat-worktree';
import { getExpertAwareToolNamesForChat } from '../experts/expert-tool-policy';
import { loadToolConfig } from '../../tools/config';
import type { Chat } from '../../types';
import { formatChatLinksPromptBlock } from '../links';
import { retrieveMemoryBlock } from '../../memory/client';
import { shouldInjectMemory } from '../../memory/config';
import { shouldInjectCodeMap } from '../../brain/code-injection-config';
import { retrieveCodeMapBlock } from '../../brain/code-map-injection';
import { extractCodeMapFocusHints } from '../../brain/code-map-focus';
import { fetchBrainCodeConfig } from '../../brain/client';
import { loadContextDocumentsSettings, shouldInjectContextDocuments } from '../../chat/context-documents/config';
import { retrieveContextDocumentsBlock } from '../../chat/context-documents/injection';
import { shouldRunFirstTurnInjections } from './first-turn-injection';
import {
  resolveInjectionReplay,
  shouldReplayStoredInjection,
} from '../context/injection-replay';
import { chatHistoryHasBrowserToolUse } from './browser-allowlist-gate';
import { getWorkspacePath } from '../../state/workspace';
import { resolveShellSandboxModeForChat } from '../../tools/shell-sandbox-client';
import type { ComposeContext } from './types';
import { getBoardGroupForChat } from '../../state/chat-groups';
import { resolveEffectiveOrchestratePlanPath } from '../plans/plan-path';
import { runWithDeadline } from '../../lib/async-deadline.mjs';
import { getPermissionLevelCached } from '../../config/tool-security-meta';
import { getCachedProviderList } from '../../providers/store';
import { isLocalProvider } from '../../providers/provider-host';
import { isLanProviderBaseUrl } from '../../lib/lan-provider-host.mjs';

/** True when the chat's provider runs on this machine or the LAN (local-model appendix `auto`). */
export function chatProviderIsLocal(chat: Pick<Chat, 'providerId'>): boolean {
  const list = getCachedProviderList();
  const id = chat.providerId?.trim() || list?.activeProviderId || '';
  const provider = list?.providers.find((row) => row.id === id);
  if (!provider) return id === 'lm-studio-local';
  return isLocalProvider(provider) || isLanProviderBaseUrl(provider.baseUrl);
}

// ── Cwd ──────────────────────────────────────────────────────────────────────

/** Workspace folder path for {{cwd}} in system prompts (falls back to origin). */
export function resolveComposeCwd(): string {
  const workspace = getWorkspacePath();
  if (workspace.trim()) {
    return workspace;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '.';
}

function getEnabledToolIdsForChat(chat: Chat): string[] {
  loadToolConfig();
  return getExpertAwareToolNamesForChat(chat);
}

export interface BuildComposeContextOptions {
  signal?: AbortSignal;
  enrichmentTimeoutMs?: number;
  separateCliContext?: boolean;
  userMessagePreview?: string;
  /** Workspace paths from composer attachments (bias injection PageRank). */
  attachmentWorkspacePaths?: string[];
  /** When set, used for expert routing instead of last history message. */
  routeUserText?: string;
  /** First user message send (set before history.push); gates first-turn injections. */
  firstUserSend?: boolean;
  /** Model context window (callers still pass it; injection replay is uncapped). */
  modelContextLimit?: number | null;
  overrides?: Partial<ComposeContext>;
}

export interface ResolvedExpertContext {
  expertId: string | null;
  expertLabel: string | null;
  routeSource: string;
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Assemble compose context for the active chat and config.
 */
export async function buildComposeContext(
  chat: Chat,
  options?: BuildComposeContextOptions,
): Promise<ComposeContext> {
  const meta = await loadPromptMetaSettings();

  const modeId = normalizeModeId(chat.modeId);
  const orchestratePlanPath =
    modeId === 'orchestrate'
      ? resolveEffectiveOrchestratePlanPath(chat, getBoardGroupForChat(chat)) ?? null
      : null;
  const enabledToolIds = getEnabledToolIdsForChat(chat);

  const infoPresetId =
    options?.overrides?.infoPresetId ??
    meta.activeInfoPresetId ??
    'general-assistant';

  const runFirstTurn = shouldRunFirstTurnInjections(chat, {
    firstUserSend: options?.firstUserSend,
  });
  const replayBodies = runFirstTurn
    ? {}
    : resolveInjectionReplay(chat.history, chat.injectedContext);
  const worktreeCwd = resolveChatToolWorkspaceRoot(chat, sessionState?.groups);
  const timeoutMs = options?.enrichmentTimeoutMs ?? 3000;
  const omissions: string[] = [];
  const optional = async (kind: string, work: (signal: AbortSignal) => Promise<{ enabled: boolean; block: string | null }>) => {
    try { return await runWithDeadline(work, { timeoutMs, signal: options?.signal }); }
    catch (error) {
      options?.signal?.throwIfAborted();
      omissions.push(`${kind} (${error instanceof Error && error.name === 'TimeoutError' ? 'deadline' : 'unavailable'})`);
      return { enabled: false, block: null };
    }
  };

  const memory = async (signal: AbortSignal) => {
    const replay = replayBodies['brain-notes'] && shouldReplayStoredInjection(chat.brainNotesInjection)
      ? replayBodies['brain-notes'] : null;
    const enabled = runFirstTurn ? await shouldInjectMemory(chat) : Boolean(replay);
    if (!enabled || !runFirstTurn) return { enabled, block: replay };
    signal.throwIfAborted();
    const block = await retrieveMemoryBlock({
      query: options?.routeUserText ?? options?.userMessagePreview ?? '',
      autoInject: chat.kind !== 'expert',
      ...(chat.kind === 'expert' && chat.expertId?.trim() && chat.expertRuntime?.memoryEnabled !== false
        ? { expertId: chat.expertId.trim() } : {}),
    });
    return { enabled, block: block || null };
  };
  const codeMap = async (signal: AbortSignal) => {
    const replay = replayBodies['code-map'] && shouldReplayStoredInjection(chat.codeMapInjection)
      ? replayBodies['code-map'] : null;
    const enabled = runFirstTurn ? await shouldInjectCodeMap(chat) : Boolean(replay);
    if (!enabled || !runFirstTurn) return { enabled, block: replay };
    const codeConfig = await fetchBrainCodeConfig();
    const preview = options?.routeUserText ?? options?.userMessagePreview ?? '';
    const focusHints = extractCodeMapFocusHints(preview, options?.attachmentWorkspacePaths);
    signal.throwIfAborted();
    const block = await retrieveCodeMapBlock({
      repoPath: worktreeCwd ?? resolveComposeCwd(),
      tokenBudget: codeConfig?.repoMapInjectionTokenBudget ?? codeConfig?.repoMapTokenBudget,
      focus: focusHints.focus.length ? focusHints.focus : undefined,
      ensureIndexed: false, profile: 'injection',
    });
    if (!signal.aborted && codeConfig?.enabled) {
      void fetch('/api/brain/code/cascade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false, trigger: 'lazy-query' }),
      }).catch(() => undefined);
    }
    return { enabled, block: block || null };
  };
  const documents = async (signal: AbortSignal) => {
    const replay = replayBodies['context-documents'] && shouldReplayStoredInjection(chat.contextDocumentsInjection)
      ? replayBodies['context-documents'] : null;
    const enabled = runFirstTurn ? await shouldInjectContextDocuments(chat) : Boolean(replay);
    if (!enabled || !runFirstTurn) return { enabled, block: replay };
    const { documents } = await loadContextDocumentsSettings();
    signal.throwIfAborted();
    const block = await retrieveContextDocumentsBlock({ repoPath: worktreeCwd ?? resolveComposeCwd(), documents });
    return { enabled, block: block || null };
  };
  // Three independent lanes with deterministic assembly; replay never fetches.
  const [memoryResult, codeResult, documentsResult] = await Promise.all([
    optional('memory', memory), optional('code-map', codeMap),
    runWithDeadline(documents, { timeoutMs, signal: options?.signal }),
  ]);
  options?.signal?.throwIfAborted();
  const { block: memoryBlock, enabled: injectMemory } = memoryResult;
  const { block: codeMapBlock, enabled: injectCodeMap } = codeResult;
  const { block: contextDocumentsBlock, enabled: injectContextDocuments } = documentsResult;
  const injectionsReplayed = !runFirstTurn && (injectMemory || injectCodeMap || injectContextDocuments);
  // Keep omission feedback in turn context, not the reusable CLI prefix.
  const notice = omissions.length ? 'Optional enrichment unavailable: ' + omissions.sort().join(', ') + '. Use tools if this context is needed.' : '';

  const ctx: ComposeContext = {
    cwd: worktreeCwd ?? resolveComposeCwd(),
    modeId,
    orchestratePlanPath,
    expertId: null,
    workAgentId: null,
    skillBody: null,
    memoryBlock,
    memoryEnabled: injectMemory,
    codeMapBlock,
    codeMapInjectionEnabled: injectCodeMap,
    contextDocumentsBlock,
    contextDocumentsInjectionEnabled: injectContextDocuments,
    chatLinksBlock: formatChatLinksPromptBlock(chat.links),
    enrichmentNotice: notice || null,
    injectionsReplayed,
    enabledToolIds,
    infoPresetId,
    planGranularity: meta.planGranularity ?? 'medium',
    flaticonIconGuidanceEnabled: meta.flaticonIconGuidanceEnabled,
    localModelGuidance: meta.localModelGuidance,
    providerIsLocal: chatProviderIsLocal(chat),
    permissionLevel: getPermissionLevelCached(),
    userMessagePreview:
      options?.userMessagePreview ??
      chat.history
        .slice()
        .reverse()
        .find((m) => m.role === 'user')
        ?.content?.slice(0, 200) ??
      '',
    browserActivated:
      options?.overrides?.browserActivated ??
      chatHistoryHasBrowserToolUse(chat.history),
    shellSandboxMode: resolveShellSandboxModeForChat(chat.id),
    ...options?.overrides,
  };

  return ctx;
}

/**
 * Resolve expert for send: manual selection or expert-thread chat only (no auto-routing).
 */
export async function resolveExpertContextForSend(
  chat: Chat,
  _userText: string,
): Promise<ResolvedExpertContext> {
  const expertsConfig = await loadExpertsConfig();
  if (!expertsConfig.enabled) {
    return { expertId: null, expertLabel: null, routeSource: 'none' };
  }

  const threadExpertId =
    chat.kind === 'expert' && chat.expertId?.trim() ? chat.expertId.trim() : null;
  const selection = getExpertSelection(chat);
  const manualId =
    selection.mode === 'manual' && selection.expertId?.trim()
      ? selection.expertId.trim()
      : null;
  const expertId = threadExpertId ?? manualId;
  if (!expertId) {
    return { expertId: null, expertLabel: null, routeSource: 'none' };
  }

  const expert = listExperts().find((r) => r.meta.id === expertId);
  if (!expert) {
    return {
      expertId,
      expertLabel: null,
      routeSource: 'orphaned',
    };
  }

  return {
    expertId: expert.meta.id,
    expertLabel: expert.meta.label,
    routeSource: 'manual',
  };
}

/**
 * Single compose-context build for send (expert + work-agent overrides).
 */
export async function resolveComposeContextForSend(
  chat: Chat,
  options?: BuildComposeContextOptions,
): Promise<ComposeContext> {
  const routeText =
    options?.routeUserText ??
    options?.userMessagePreview ??
    '';

  const expertCtx = await resolveExpertContextForSend(chat, routeText);

  const activeWorkAgent = resolveActiveWorkAgent(chat);
  const workAgentId = resolveActiveWorkAgentId(chat);

  return buildComposeContext(chat, {
    ...options,
    overrides: {
      expertId:
        expertCtx.routeSource === 'orphaned' ? null : expertCtx.expertId,
      expertLabel: expertCtx.expertLabel,
      workAgentId,
      workAgentLabel: activeWorkAgent?.label ?? null,
      ...options?.overrides,
    },
  });
}

/**
 * Resolve composed system prompt for send path (async config + compose).
 */
export async function resolveComposedSystemPrompt(
  chat: Chat,
  options?: BuildComposeContextOptions,
): Promise<string> {
  const { composeSystemPrompt } = await import('./prompt-composer');
  const ctx = await resolveComposeContextForSend(chat, options);
  return composeSystemPrompt(ctx);
}

/** Raw injection payloads for the outgoing send (UI transcript chips). */
export interface OutboundInjectionBlocks {
  brainNotes: string | null;
  codeMap: string | null;
  contextDocuments: string | null;
}

/** Outbound system messages for LM Studio (composed prompt + optional user rules). */
export interface OutboundSystemMessages {
  cliStable?: string;
  cliTurnContext?: string;
  /** Primary system content. */
  composed: string;
  /** Second system message body when rules are enabled and non-empty. */
  userRules: string | null;
  /** Retrieved Brain / code-map bodies from the same compose pass. */
  injectionBlocks: OutboundInjectionBlocks;
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export async function resolveOutboundSystemMessages(
  chat: Chat,
  options?: BuildComposeContextOptions,
): Promise<OutboundSystemMessages> {
  let cliStable: string | undefined;
  let cliTurnContext: string | undefined;
  let injectionBlocks: OutboundInjectionBlocks = {
    brainNotes: null,
    codeMap: null,
    contextDocuments: null,
  };
  const { composeSystemPrompt } = await import('./prompt-composer');
  const ctx = await resolveComposeContextForSend(chat, options);
  const composed = composeSystemPrompt(ctx).trim();
  if (options?.separateCliContext) {
    const parts: string[] = [];
    cliStable = composeSystemPrompt(ctx, { turnContext: parts });
    cliTurnContext = parts.join('\n\n---\n\n');
  }
  if (!ctx.injectionsReplayed) {
    const brain = ctx.memoryBlock?.trim() ?? '';
    const codeMap = ctx.codeMapBlock?.trim() ?? '';
    const contextDocuments = ctx.contextDocumentsBlock?.trim() ?? '';
    injectionBlocks = {
      brainNotes: brain || null,
      codeMap: codeMap || null,
      contextDocuments: contextDocuments || null,
    };
  }
  const rulesSettings = await loadUserRules();
  const userRules = getUserRulesPayloadForSend(rulesSettings);
  return { composed, userRules, injectionBlocks, cliStable, cliTurnContext };
}
