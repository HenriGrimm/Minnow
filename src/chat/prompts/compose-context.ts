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
import { loadPromptConfig } from './prompt-configs';
import { chatHistoryHasBrowserToolUse } from './browser-allowlist-gate';
import { getWorkspacePath } from '../../state/workspace';
import { resolveShellSandboxModeForChat } from '../../tools/shell-sandbox-client';
import type { ComposeContext, PromptProfile } from './types';
import { getBoardGroupForChat } from '../../state/chat-groups';
import { resolveEffectiveOrchestratePlanPath } from '../plans/plan-path';

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
  const profile: PromptProfile = meta.activePromptProfile;

  let customConfig = null;
  if (profile === 'custom' && meta.activePromptConfigId) {
    const loaded = await loadPromptConfig(meta.activePromptConfigId);
    if (loaded && !(loaded instanceof Error)) {
      customConfig = loaded;
    }
  }

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
  let injectionsReplayed = false;

  let memoryBlock: string | null = null;
  const replayBrainNotes =
    replayBodies['brain-notes'] &&
    shouldReplayStoredInjection(chat.brainNotesInjection)
      ? replayBodies['brain-notes']
      : null;
  const injectMemory = runFirstTurn
    ? await shouldInjectMemory(chat)
    : Boolean(replayBrainNotes);
  if (injectMemory && !runFirstTurn) {
    memoryBlock = replayBrainNotes;
    injectionsReplayed = true;
  } else if (injectMemory) {
    const query =
      options?.routeUserText ??
      options?.userMessagePreview ??
      '';
    memoryBlock =
      (await retrieveMemoryBlock({
        query,
        profile,
        ...(chat.kind === 'expert' &&
        chat.expertId?.trim() &&
        chat.expertRuntime?.memoryEnabled !== false
          ? { expertId: chat.expertId.trim() }
          : {}),
      })) || null;
  }

  const worktreeCwd = resolveChatToolWorkspaceRoot(chat, sessionState?.groups);

  let codeMapBlock: string | null = null;
  const replayCodeMap =
    replayBodies['code-map'] && shouldReplayStoredInjection(chat.codeMapInjection)
      ? replayBodies['code-map']
      : null;
  const injectCodeMap = runFirstTurn
    ? await shouldInjectCodeMap(chat)
    : Boolean(replayCodeMap);
  if (injectCodeMap && !runFirstTurn) {
    codeMapBlock = replayCodeMap;
    injectionsReplayed = true;
  } else if (injectCodeMap) {
    const codeConfig = await fetchBrainCodeConfig();
    const preview =
      options?.routeUserText ?? options?.userMessagePreview ?? '';
    const focusHints = extractCodeMapFocusHints(
      preview,
      options?.attachmentWorkspacePaths,
    );
    codeMapBlock =
      (await retrieveCodeMapBlock({
        repoPath: worktreeCwd ?? resolveComposeCwd(),
        tokenBudget: codeConfig?.repoMapInjectionTokenBudget ?? codeConfig?.repoMapTokenBudget,
        focus: focusHints.focus.length ? focusHints.focus : undefined,
        ensureIndexed: false,
        profile: 'injection',
      })) || null;
    if (injectCodeMap && codeConfig?.enabled) {
      void fetch('/api/brain/code/cascade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false, trigger: 'lazy-query' }),
      }).catch(() => undefined);
    }
  }

  let contextDocumentsBlock: string | null = null;
  const replayContextDocuments =
    replayBodies['context-documents'] &&
    shouldReplayStoredInjection(chat.contextDocumentsInjection)
      ? replayBodies['context-documents']
      : null;
  const injectContextDocuments = runFirstTurn
    ? await shouldInjectContextDocuments(chat)
    : Boolean(replayContextDocuments);
  if (injectContextDocuments && !runFirstTurn) {
    contextDocumentsBlock = replayContextDocuments;
    injectionsReplayed = true;
  } else if (injectContextDocuments) {
    const { documents } = await loadContextDocumentsSettings();
    contextDocumentsBlock =
      (await retrieveContextDocumentsBlock({
        repoPath: worktreeCwd ?? resolveComposeCwd(),
        documents,
      })) || null;
  }

  const ctx: ComposeContext = {
    profile,
    customConfigId: meta.activePromptConfigId,
    customConfig,
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
    injectionsReplayed,
    enabledToolIds,
    infoPresetId,
    planGranularity: meta.planGranularity ?? 'medium',
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
  /** Primary system content (composed stack or legacy textarea fallback). */
  composed: string;
  /** Second system message body when rules are enabled and non-empty. */
  userRules: string | null;
  /** Retrieved Brain / code-map bodies from the same compose pass. */
  injectionBlocks: OutboundInjectionBlocks;
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export async function resolveOutboundSystemMessages(
  chat: Chat,
  legacySysPrompt: string,
  options?: BuildComposeContextOptions,
): Promise<OutboundSystemMessages> {
  let composedRaw = '';
  let injectionBlocks: OutboundInjectionBlocks = {
    brainNotes: null,
    codeMap: null,
    contextDocuments: null,
  };
  try {
    const { composeSystemPrompt } = await import('./prompt-composer');
    const ctx = await resolveComposeContextForSend(chat, options);
    composedRaw = composeSystemPrompt(ctx);
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
  } catch {
    composedRaw = '';
  }
  const composed = composedRaw.trim() || legacySysPrompt.trim();
  const rulesSettings = await loadUserRules();
  const userRules = getUserRulesPayloadForSend(rulesSettings);
  return { composed, userRules, injectionBlocks };
}
