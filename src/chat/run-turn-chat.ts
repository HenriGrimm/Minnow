import { runTurn } from '../../server/runner/index.js';
import { loadToolConfig } from '../tools/config';
import type {
  AskCapability,
  RunTurnOptions,
  TurnResult,
} from '../../server/runner/run-turn';
import {
  ASK_QUESTION_TOOL_NAME,
  DEFAULT_ASK_TIMEOUT_MS,
} from '../../server/runner/run-turn';
import type { TranscriptMessage, TranscriptStore } from '../../server/runner/transcript-store';
import { createSessionTranscriptStore } from '../agents/session-transcript-store';
import { createChatTranscriptStore, type ChatTranscriptStore } from './chat-transcript-store';
import {
  isAbortError,
  isAbortedTurnResult,
  isFailedTurnResult,
  isGenerationLostMessage,
  settleFailedTurn,
  settleStoppedTurn,
  type InterruptedTurnChrome,
} from './settle-interrupted-turn';
import { createRendererRunnerDeps } from '../agents/renderer-runner-deps';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { getGlobalContextEnforcementPolicySync } from '../agents/sub-agent-config';
import {
  agentContextBudgetFromWorkAgent,
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
} from './context-budget';
import { resolveWorkAgentContextPolicy } from './resolve-context-policy';
import { resolveWorkAgentBinding } from '../agents/resolve-work-agent-binding';
import { UI_DESIGNER_AGENT_ID } from '../agents/ui-designer/constants';
import { resolveUiDesignerBinding } from '../agents/ui-designer/config';
import {
  applyUiDesignerToolFilter,
  augmentSkillBodyForUiDesigner,
  prepareUiDesignerTurn,
} from '../agents/ui-designer/runner';
import { WorkAgentConfigError } from '../agents/work-agent-types';
import { getUserWorkAgentOverride } from '../agents/work-agent-registry';
import { getChatAbort, setChatAbort, setStreaming, modelCache } from '../app-state';
import { getChatMetaSync } from '../config/chat-meta';
import { mergeGlobalSamplerWithLibraryModel } from '../config/library-inference-meta';
import { readGlobalSamplerForSend } from '../config/sampler-meta';
import { resolveSamplerPreset } from '../agents/resolve-sampler';
import { resolveThinkingMode } from '../agents/resolve-thinking';
import {
  chatTurnNeedsModelLoad,
  ensureChatModelLoadedForTurn,
} from '../api/ensure-chat-model-loaded';
import { fetchCachedModels, listModelServes, type ServeRecord } from '../models/api-client';
import type { LibraryModel } from '../models/library';
import { formatLoadPercentLabel } from '../models/load-progress.mjs';
import {
  LIBRARY_MODEL_PROVIDER_ID,
  activeServeForLibraryId,
  libraryBindingNeedsServeLoad,
  loadableLibraryFromCached,
  resolveLibraryModelIdForChatBinding,
  resolveLibrarySendBinding,
  resolveUpstreamProviderId,
  servedContextLength,
} from '../models/model-select-library';
import { fetchReplayPriorReasoningEnabled } from './context/reasoning-replay-config';
import { resolveContextLimit } from './context-usage';
import {
  appendInjectionNoticesForTurn,
} from './context/injection-notice';
import { hiddenTranscriptUserMessage } from './hidden-transcript-user-messages';
import { normalizeModeId } from './modes/types';
import { resolveOutboundSystemMessages } from './prompts/compose-context';
import {
  beginChatTurnSetup,
  endChatTurnSetup,
  isChatTurnSetupPending,
} from './chat-turn-guard';
import {
  isChatStreaming,
  isStreamDomVisible,
  notifyChatStreamActivity,
  notifyChatStreamEnded,
} from './streaming-state';
import {
  createChatTurnEventPainter,
  finalizeAndAnchorThinkingRound,
  type ChatTurnEventPainter,
  type ChatTurnPaintHost,
} from './run-turn-chat-paint';
import { buildTurnDisplayMeta, createStreamingStatsPublisher } from './streaming-stats';
import {
  applyStreamMetaEvent,
  runtimeStatusFromStreamMetaRuntime,
  streamMetaFromRoundEnd,
} from './turn-stream-meta';
import {
  finalizeResponseMeta,
  type StreamMetaAccumulator,
} from '../api/chat';
import { resolveModelInfo } from '../api/models';
import { buildLastStatsSnapshot, updateStrip } from '../ui/stats';
import { consumePendingSteer, clearPendingSteer } from './steer-message';
import { flushPendingMessageQueue } from './message-queue';
import { syncComposerMessageQueue } from '../ui/composer-message-queue';
import { syncComposerFromStreamingState } from '../ui/composer-send';
import {
  clearContextInFlightOverlay,
  syncTurnContextUsage,
} from './context-in-flight';
import { scheduleContextUsageRefresh } from '../ui/context-usage-ring';
import {
  applyPromptTitlePlaceholder,
  isFirstUserMessagePending,
  scheduleChatTitleGeneration,
} from './titles/schedule';
import { repairSessionHistoryTail } from './history';
import { buildTurnSnapshot, resolveForkHistoryIndex } from './turn-snapshot';
import {
  capturePostTurnSnapshot,
  capturePreTurnSnapshot,
} from './turn-snapshots';
import {
  clearMainTurnActivity,
  emitMainTurnActivity,
  patchMainTurnActivity,
} from './main-turn-activity';
import type { ForkOverrides } from './fork-from-run';
import {
  overlayMultimodalHistoryForRunTurn,
  chatTurnNeedsMultimodalOverlay,
  persistableUserImages,
} from './build-api-messages';
import {
  ensureChatHistoryLoaded,
  getActiveChat,
  recordChatMessage,
  requireHistory,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import {
  createRun,
  finalizeRun,
  findRunById,
} from '../state/runs-store';
import { isBoardOwnedChat, isBoardTaskChat } from '../state/chat-groups';
import type {
  Chat,
  ChatStopReason,
  Message,
  ModelInfo,
  Stats,
  TurnRunId,
  TurnRunStatus,
  TurnSnapshot,
  Usage,
} from '../types';
import type { StreamingStatusHandle } from '../ui/stream-status';
import { getModelsState, subscribeModelsStore } from '../ui/models/store';
import type { Attachment } from '../attachments/types';
import { linkSentAttachmentsToTurn } from '../design/annotation-store';
import {
  clearAttachments,
  getPendingAttachments,
  restorePendingAttachments,
} from '../attachments/store';
import { getActiveProvider } from '../providers/store';
import { isLocalProvider } from '../providers/provider-host';
import { canSendImagesToModel } from '../providers/vision-model.ts';
import { acquireTickedMotion } from '../ui/motion-ticker';
import { executeTool, getEnabledToolDefinitionsForChat } from '../tools/client';
import {
  openAgentBrowserRuntime,
  type AgentBrowserRuntimeHandle,
  type AgentBrowserRuntimeOwner,
} from '../tools/agent-browser-runtime';
import { getToolById } from '../tools/definitions';
import { enqueueAskQuestion } from '../tools/ask-question-queue';
import {
  stringifyAskQuestionResult,
  validateAskQuestionArgs,
} from '../tools/ask-question-types';
import { setSubAgentExecutorContext } from '../tools/sub-agent-executor';
import { setBugBoardExecutorContext } from '../tools/bug-board-tools';
import {
  isParallelSafeTool,
  parallelToolsActivityLabel,
} from '../tools/parallel-tool-policy';
import { assertUiDesignerToolAllowed } from '../agents/ui-designer/tools';
import { resolveChatToolWorkspaceRoot } from '../state/chat-worktree';
import {
  recordChatCompletionUsage,
  recordMainChatTurnUsage,
} from '../usage/record-chat-usage';
import { hasMeasurableUsage } from '../usage/pricing';
import { schedulePostTurnSynthesis } from '../synthesis/client';
import {
  buildSynthesisExcerpt,
  buildSynthesisMessages,
} from '../synthesis/post-turn';
import {
  composeImpeccableSkillBody,
  shouldComposeImpeccableBody,
  augmentCavemanSkillBody,
  augmentPartyModeSkillBody,
  CAVEMAN_SKILL_ID,
  PARTYMODE_SKILL_ID,
  GIT_SETUP_SKILL_ID,
  prepareGitSetupTurn,
  isPartyModePinned,
  resolveActiveSkill,
} from '../skills';
import { burstPartyConfetti } from '../ui/party-confetti';
import {
  appendBubble,
  appendInjectionNoticesDom,
  appendStats,
  appendStreamingAssistantRow,
  removeOrphanStreamingRow,
  revealAssistantProseBubble,
} from '../ui/messages';
import { ThinkingDurationTracker } from '../ui/thinking-duration';
import { markMessageTruncated } from '../ui/truncated-affordance';
import {
  cancelAssistantBubbleRenderDebounce,
  finishStreamingBubbleRender,
  setAssistantBubbleContent,
} from '../markdown/renderer';
import {
  ThoughtBubbleController,
  type ThoughtPhaseCallbacks,
} from '../ui/thought-bubbles';
import { getActiveChatMountElement, setTurnChatMount } from '../ui/chat-mount';
import {
  resolveComposerSurface,
  clearComposerInput,
  type ComposerSurface,
} from '../ui/composer-surface';
import { clearComposerDraftOnChat } from '../ui/composer-draft';
import {
  recordAssistantReplyOnChat,
  setSidebarStreamPhase,
  syncChatItemDotsInDom,
} from '../ui/chat-item-dot';
import { scheduleRenderSidebar } from '../ui/sidebar';
import { setStatus } from '../ui/status';
import { scrollChatIfPinned } from '../ui/chat-scroll';
import { completeStreamAnnouncer } from '../ui/a11y/stream-announcer';
import { refreshBranchPickerAtFork } from '../ui/branch-picker';
import { registerStreamDomRemount } from '../tools/stream-chat-dom';
import { rehydrateLiveParentSubAgents } from '../agents/orchestrator';
import {
  applyModelSelectValueToChat,
} from '../lib/model-select-key';
import {
  resolveEffectiveChatModelBinding,
  syncPerChatModelBindingFromCatalog,
} from '../ui/default-model';
import { postChatCompletions } from '../providers/fetch-chat';
import type { PostChatCompletionsOptions } from '../../server/runner/adapters';

// ── Options ──────────────────────────────────────────────────────────────────

/** Browser-native tools kept as a catalog floor for tests. */
export const RUN_TURN_CHAT_SPIKE_TOOL_IDS = ['get_datetime', 'calculate'] as const;

/** Options for {@link runChatTurn} (composer send or history resend). */
export interface RunChatTurnOptions {
  chat: Chat;
  /** When false, the last user row in history is reused (regenerate / remake). */
  pushUser: boolean;
  rawText: string;
  userText: string;
  skillId: string | null;
  displayText?: string;
  historyContent: string;
  validAttachments: Attachment[];
  titleSeed?: string;
  shouldScheduleTitle?: boolean;
  /** Run title job after the first turn completes (avoids competing with main chat for TTFT). */
  deferTitleUntilTurnEnd?: boolean;
  /** First user message in chat (capture before history.push). */
  firstUserSend?: boolean;
  /** Pre-resolved skill body when skillId is set (composer / Super Plan path). */
  skillBody?: string | null;
  /** Re-subscribe to an existing backend generation (boot resume); skips POST. */
  resumeGenerationId?: string;
  /** @deprecated Every in-flight chat is registered by id; retained for caller compatibility. */
  ownsGlobalStreaming?: boolean;
  /** Replay inputs from a prior fork (regenerate / fork with model swap). */
  replaySnapshot?: TurnSnapshot;
  /** Prior run at this fork for branch lineage. */
  parentRunId?: TurnRunId;
  /** Model/provider overrides when forking without a full snapshot clone. */
  forkOverrides?: ForkOverrides;
  /** When set, replaces composed system prompt (Expert Lab expert full body). */
  composedSystemPromptOverride?: string;
  /** Push user text to history without showing a user bubble (sub-agent completion resume). */
  suppressUserEcho?: boolean;
  /** Turn started by /goal or goal auto-continuation (triggers post-turn evaluator). */
  goalDriven?: boolean;
  /** Composer input/send override (defaults to foreground app surface). */
  composerSurface?: Partial<ComposerSurface>;
  /** Surface-owned context reused across every round of this turn only. */
  ephemeralContext?: string;
  /** First model round only: ephemeral user line for API (not stored in history). */
  ephemeralContinueInstruction?: string;
}

export interface ResumeParentChatOptions {
  suppressUserEcho?: boolean;
  goalDriven?: boolean;
}

// ── Tests ────────────────────────────────────────────────────────────────────

/** Test hook so stream-end order can be recorded without mocking ESM. */
let setStreamingFn: typeof setStreaming = setStreaming;
let notifyChatStreamEndedFn: typeof notifyChatStreamEnded = notifyChatStreamEnded;

function endRunTurnChatStreaming(chatId: string): void {
  setStreamingFn(false, chatId);
  notifyChatStreamEndedFn(chatId);
}

let endStreamingImpl: (chatId: string) => void = endRunTurnChatStreaming;

export function setRunTurnChatEndStreamingForTests(
  fns: {
    setStreaming?: typeof setStreaming;
    notifyChatStreamEnded?: typeof notifyChatStreamEnded;
  } | null,
): void {
  setStreamingFn = fns?.setStreaming ?? setStreaming;
  notifyChatStreamEndedFn = fns?.notifyChatStreamEnded ?? notifyChatStreamEnded;
  endStreamingImpl = endRunTurnChatStreaming;
}

export function resolveSpikeAskTimeoutMs(): number {
  const idle = getChatMetaSync().generationIdleTimeoutMs;
  return idle > 0 ? idle : DEFAULT_ASK_TIMEOUT_MS;
}

export function createChatAskCapability(input: {
  chatId: string;
  enqueue?: typeof enqueueAskQuestion;
}): AskCapability {
  const enqueue = input.enqueue ?? enqueueAskQuestion;
  return {
    async ask(question) {
      const parsed = validateAskQuestionArgs(asToolArgs(question));
      if (parsed.ok === false) {
        return stringifyAskQuestionResult({ status: 'error', message: parsed.error });
      }
      return enqueue(parsed.args, {}, input.chatId);
    },
  };
}

export function createChatRoundBoundary(
  chat: Chat,
  browserRuntime?: Pick<AgentBrowserRuntimeHandle, 'drainMessages'> | null,
): () => TranscriptMessage[] | null {
  return () => {
    const browserMessages = browserRuntime?.drainMessages() ?? [];
    const result = consumePendingSteer(chat);
    syncComposerMessageQueue();
    if (!result.consumed || typeof result.content !== 'string' || !result.content) {
      return browserMessages.length ? browserMessages : null;
    }
    return [...browserMessages, { role: 'user', content: result.content }];
  };
}

/** Injected in tests so we can assert `runTurn` was actually called. */
type RunTurnFn = (options: RunTurnOptions) => Promise<TurnResult>;
let runTurnImpl: RunTurnFn = runTurn;

/** Replace `runTurn` in tests. Pass the real function (or omit) to restore. */
export function setRunTurnForTests(fn: RunTurnFn | null): void {
  runTurnImpl = fn ?? runTurn;
}

type ChatTurnNeedsModelLoadFn = typeof chatTurnNeedsModelLoad;
type EnsureChatModelLoadedFn = typeof ensureChatModelLoadedForTurn;
let chatTurnNeedsModelLoadImpl: ChatTurnNeedsModelLoadFn = chatTurnNeedsModelLoad;
let ensureChatModelLoadedImpl: EnsureChatModelLoadedFn = ensureChatModelLoadedForTurn;

export function setChatModelLoadForTests(
  fns: {
    needsLoad?: ChatTurnNeedsModelLoadFn;
    ensure?: EnsureChatModelLoadedFn;
  } | null,
): void {
  chatTurnNeedsModelLoadImpl = fns?.needsLoad ?? chatTurnNeedsModelLoad;
  ensureChatModelLoadedImpl = fns?.ensure ?? ensureChatModelLoadedForTurn;
}

type LibraryAndServes = { library: LibraryModel[]; serves: ServeRecord[] };

async function fetchLibraryAndServes(): Promise<LibraryAndServes> {
  const cached = await fetchCachedModels().catch(() => []);
  const library = await loadableLibraryFromCached(cached);
  const serves = await listModelServes().catch(() => []);
  return { library, serves };
}

let fetchLibraryAndServesImpl: () => Promise<LibraryAndServes> = fetchLibraryAndServes;

/** Replace the My Models library + serve lookup in tests. */
export function setChatLibraryAndServesForTests(fn: (() => Promise<LibraryAndServes>) | null): void {
  fetchLibraryAndServesImpl = fn ?? fetchLibraryAndServes;
}

export function resetRunTurnForTests(): void {
  runTurnImpl = runTurn;
  chatTurnNeedsModelLoadImpl = chatTurnNeedsModelLoad;
  ensureChatModelLoadedImpl = ensureChatModelLoadedForTurn;
  fetchLibraryAndServesImpl = fetchLibraryAndServes;
}

export function createChatTurnTranscriptStore(chatId: string): {
  store: TranscriptStore;
  getIsolatedMessages: () => TranscriptMessage[];
} {
  const session = createSessionTranscriptStore();
  const isolated: TranscriptMessage[] = [];
  return {
    getIsolatedMessages: () => isolated.slice(),
    store: {
      load(id) {
        const meta = session.load(id)?.meta ?? {};
        return { messages: isolated.slice(), meta };
      },
      append(_id, message) {
        isolated.push(message);
      },
      setMeta(id, meta) {
        session.setMeta(id, meta);
      },
    },
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

/** OpenAI function tools for the two spike ids, if they exist in the catalog. */
export function spikeChatToolDefinitions(): RunTurnOptions['tools'] {
  const tools: RunTurnOptions['tools'] = [];
  for (const id of RUN_TURN_CHAT_SPIKE_TOOL_IDS) {
    const def = getToolById(id)?.definition;
    if (!def) continue;
    tools.push({
      type: 'function',
      function: {
        name: def.function.name,
        description: def.function.description,
        parameters: def.function.parameters as Record<string, unknown>,
      },
    });
  }
  return tools;
}

export function chatToolDefinitionsForTurn(
  chat: Chat,
  skillId?: string | null,
): RunTurnOptions['tools'] {
  let defs = getEnabledToolDefinitionsForChat(chat, { skillId });
  const agent = resolveActiveWorkAgent(chat);
  if (agent?.allowedTools?.length) {
    const allow = new Set(agent.allowedTools);
    defs = defs.filter((t) => allow.has(t.function.name));
  }
  const uiDesignerCtx = prepareUiDesignerTurn(chat, {
    skillId: skillId ?? null,
    userText: '',
    workAgentId: chat.workAgentId,
  });
  defs = applyUiDesignerToolFilter(defs, uiDesignerCtx);
  return defs.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * The window the turn is budgeted against. A running local serve's `-c` is
 * authoritative: its served alias matches no model-cache row, and a row that
 * does match may carry n_ctx_train rather than the configured context.
 */
function turnModelContextLimit(
  chat: Chat,
  sendModelId: string,
  servedWindow?: number | null,
): number | null {
  if (servedWindow != null && servedWindow > 0) return servedWindow;
  return sendModelId ? resolveContextLimit(sendModelId, chat) : null;
}

function chatTurnContextLimits(
  chat: Chat,
  sendModelId: string,
  servedWindow?: number | null,
): NonNullable<RunTurnOptions['limits']> {
  const workAgent = resolveActiveWorkAgent(chat);
  const policy = workAgent
    ? resolveWorkAgentContextPolicy(workAgent.id)
    : getGlobalContextEnforcementPolicySync() ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY;
  const contextBudget = workAgent
    ? agentContextBudgetFromWorkAgent(workAgent, policy)
    : { enforcementPolicy: policy };
  return {
    contextBudget,
    modelContextLimit: turnModelContextLimit(chat, sendModelId, servedWindow),
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export async function composeRunTurnChatSystemPrompt(input: {
  chat: Chat;
  rawText: string;
  userText: string;
  skillId?: string | null;
  skillBody?: string | null;
  composedSystemPromptOverride?: string;
  ephemeralContext?: string;
  firstUserSend?: boolean;
  attachmentWorkspacePaths?: string[];
  modelContextLimit?: number | null;
}): Promise<{ composed: string; injectionBlocks: Awaited<ReturnType<typeof resolveOutboundSystemMessages>>['injectionBlocks'] }> {
  const override = input.composedSystemPromptOverride?.trim();
  let composed = override ?? '';
  let injectionBlocks: Awaited<ReturnType<typeof resolveOutboundSystemMessages>>['injectionBlocks'] = {
    brainNotes: null,
    codeMap: null,
    contextDocuments: null,
  };
  if (!composed) {
    const legacy =
      typeof document !== 'undefined'
        ? (document.getElementById('systemPrompt') as HTMLTextAreaElement | null)
            ?.value?.trim() ?? ''
        : '';
    let skillBody: string | null = input.skillBody?.trim() ? input.skillBody : null;
    if (!skillBody && input.skillId) {
      const skill = await resolveActiveSkill(input.skillId);
      if (skill?.body?.trim()) skillBody = skill.body;
    }
    if (skillBody && shouldComposeImpeccableBody(input.skillId ?? null, input.userText) && !input.skillBody) {
      skillBody = await composeImpeccableSkillBody(skillBody, input.userText);
    }
    if (skillBody && input.skillId === CAVEMAN_SKILL_ID && !input.skillBody) {
      skillBody = augmentCavemanSkillBody(skillBody, {
        userText: input.userText,
        pinnedIntensity: input.chat.pinnedSkill?.intensity,
      });
    }
    if (skillBody && input.skillId === PARTYMODE_SKILL_ID && !input.skillBody) {
      skillBody = augmentPartyModeSkillBody(skillBody);
    }
    const uiDesignerCtx = prepareUiDesignerTurn(input.chat, {
      skillId: input.skillId ?? null,
      userText: input.userText,
      workAgentId: input.chat.workAgentId,
    });
    if (skillBody && uiDesignerCtx.active) {
      skillBody = augmentSkillBodyForUiDesigner(skillBody, uiDesignerCtx);
    }
    const outbound = await resolveOutboundSystemMessages(input.chat, legacy, {
      userMessagePreview: input.userText || input.rawText,
      routeUserText: input.userText || input.rawText,
      firstUserSend: input.firstUserSend,
      attachmentWorkspacePaths: input.attachmentWorkspacePaths,
      modelContextLimit: input.modelContextLimit,
      overrides: skillBody ? { skillBody } : undefined,
    });
    composed = outbound.composed.trim() || legacy;
    injectionBlocks = outbound.injectionBlocks;
    if (outbound.userRules?.trim()) {
      composed = composed
        ? `${composed}\n\n---\n\n${outbound.userRules.trim()}`
        : outbound.userRules.trim();
    }
  }
  const ephemeral = input.ephemeralContext?.trim();
  if (ephemeral) {
    composed = composed ? `${composed}\n\n${ephemeral}` : ephemeral;
  }
  return { composed, injectionBlocks };
}

function asToolArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function appendIsolatedProductRows(
  chat: Chat,
  isolated: TranscriptMessage[],
): void {
  for (const msg of isolated) {
    if (msg.role === 'assistant' || msg.role === 'tool') {
      chat.history.push(msg as Message);
    }
  }
}

// ── Turn ─────────────────────────────────────────────────────────────────────

export async function maybeRunChatTurnViaRunner(
  input: RunChatTurnOptions,
): Promise<boolean> {
  await runChatTurn(input);
  return true;
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<boolean> {
  const {
    chat,
    pushUser,
    rawText,
    userText,
    skillId,
    historyContent,
    validAttachments,
    titleSeed = userText || rawText,
    shouldScheduleTitle = false,
    deferTitleUntilTurnEnd = false,
    firstUserSend: firstUserSendOption,
    skillBody: presetSkillBody = null,
    resumeGenerationId,
    ownsGlobalStreaming: _ownsGlobalStreaming = true,
    replaySnapshot,
    parentRunId,
    forkOverrides,
    composedSystemPromptOverride,
    suppressUserEcho = false,
    goalDriven = false,
    ephemeralContext,
    ephemeralContinueInstruction,
  } = options;

  const hideUserEcho = suppressUserEcho;

  if (!beginChatTurnSetup(chat.id)) {
    return false;
  }

  getChatAbort(chat.id)?.abort();
  const controller = new AbortController();
  setChatAbort(chat.id, controller);
  const chatSignal = controller.signal;
  setStreaming(true, chat.id);
  if (getActiveChat().id === chat.id) {
    syncComposerFromStreamingState();
  }

  let turnRunId: TurnRunId | undefined;
  let turnMountPinned = false;
  let turnTeardownRan = false;
  let completedNormally = false;
  let thoughtController: ThoughtBubbleController | null = null;
  let thinkingTracker: ThinkingDurationTracker | null = null;
  let wrap: HTMLDivElement | undefined;
  let bubble: HTMLDivElement | undefined;
  let cursor: HTMLDivElement | undefined;
  let streamStatus: StreamingStatusHandle | undefined;
  let painter: ChatTurnEventPainter | undefined;
  let store: ChatTranscriptStore | undefined;
  let turnRunStatus: TurnRunStatus = 'failed';
  let turnStopReason: ChatStopReason | undefined;
  let turnErrorMessage: string | undefined;
  const savedWorkAgentId = chat.workAgentId;
  let uiDesignerActive = false;
  let sendModelId = '';
  let sendProviderId = '';
  let ownsComposer = false;
  let sentAttachments: Attachment[] = [];
  let releaseTickedMotion: (() => void) | null = null;
  let streamingStatsPublisher: ReturnType<typeof createStreamingStatsPublisher> | null = null;
  let agentBrowserRuntime: AgentBrowserRuntimeHandle | null = null;
  let agentBrowserOwner: AgentBrowserRuntimeOwner | null = null;
  const ledgerWrites: Promise<void>[] = [];

  try {
    await ensureChatHistoryLoaded(chat.id);
    requireHistory(chat);

    if (skillId === GIT_SETUP_SKILL_ID && !resumeGenerationId) {
      await prepareGitSetupTurn();
    }

    const useActiveChatDom = chat.id === getActiveChat().id;
    if (useActiveChatDom) {
      setTurnChatMount(getActiveChatMountElement());
      turnMountPinned = true;
    }

    if (replaySnapshot) {
      chat.providerId = replaySnapshot.providerId;
      chat.modelId = replaySnapshot.modelId;
    } else if (chat.modelId?.trim()) {
      syncPerChatModelBindingFromCatalog(chat);
    } else {
      const binding = resolveEffectiveChatModelBinding(chat);
      if (binding.selectValue) {
        applyModelSelectValueToChat(chat, binding.selectValue);
      } else if (binding.modelId) {
        chat.modelId = binding.modelId;
        if (binding.providerId) {
          chat.providerId = binding.providerId;
        }
      }
    }

    const modelId = replaySnapshot?.modelId ?? chat.modelId?.trim() ?? '';
    if (!modelId && !resumeGenerationId) {
      throw new Error('No model selected for this chat');
    }

    const firstUserSendForInjections = pushUser
      ? (firstUserSendOption ?? isFirstUserMessagePending(chat))
      : false;

    if (
      pushUser &&
      (firstUserSendForInjections || deferTitleUntilTurnEnd || shouldScheduleTitle)
    ) {
      applyPromptTitlePlaceholder(chat.id, titleSeed || userText || rawText);
    }

    if (pushUser) {
      // Only unpaired tool chains go; a Stop mid tool batch leaves a paired tail
      // that is the whole point of the turn the user is following up on.
      if (repairSessionHistoryTail(chat)) {
        scheduleSaveSessions();
      }
      clearComposerDraftOnChat(chat);
      const pushedUserRow: Message = hideUserEcho
        ? hiddenTranscriptUserMessage(historyContent)
        : { role: 'user', content: historyContent };
      const persistedImages = persistableUserImages(validAttachments);
      if (pushedUserRow.role === 'user' && persistedImages.length > 0) {
        pushedUserRow.images = persistedImages;
      }
      chat.history.push(pushedUserRow);
      recordChatMessage(chat);
      scheduleSaveSessions();
      const pushedUserIdx = chat.history.length - 1;
      if (validAttachments.length > 0) {
        void linkSentAttachmentsToTurn(chat.id, String(pushedUserIdx), validAttachments);
      }
      if (!hideUserEcho) {
        // Coalesce with other turn-start sidebar work; click/switch still render immediately.
        scheduleRenderSidebar();
        if (isStreamDomVisible(chat.id)) {
          const { wrap: userWrap } = appendBubble(
            'user',
            historyContent,
            {
              historyIndex: pushedUserIdx,
              turnKind: 'user',
              chatId: chat.id,
            },
            { liveAttachments: validAttachments },
          );
          const { attachMessageActions } = await import('../ui/message-actions');
          attachMessageActions(userWrap, {
            chatId: chat.id,
            historyIndex: pushedUserIdx,
            turnKind: 'user',
          });
        }
        if (useActiveChatDom) {
          clearComposerInput(
            resolveComposerSurface(options.composerSurface).inputEl,
          );
        }
      }
    }

    const activeWorkAgent = resolveActiveWorkAgent(chat);
    const uiDesignerCtx = prepareUiDesignerTurn(chat, {
      skillId,
      userText,
      workAgentId: chat.workAgentId,
    });
    uiDesignerActive = uiDesignerCtx.active;
    if (uiDesignerCtx.active) {
      chat.workAgentId = UI_DESIGNER_AGENT_ID;
    }

    sendModelId = modelId || chat.modelId || '';
    sendProviderId = chat.providerId ?? '';
    try {
      const initialSendProvider = await getActiveProvider(chat.providerId);
      if (uiDesignerCtx.active) {
        const binding = await resolveUiDesignerBinding(chat, {
          providerId: initialSendProvider.id,
          modelId: sendModelId,
        });
        sendModelId = binding.modelId;
        sendProviderId = binding.providerId;
      } else {
        const binding = await resolveWorkAgentBinding(
          activeWorkAgent,
          chat,
          { providerId: initialSendProvider.id, modelId: sendModelId },
          {
            userOverride: activeWorkAgent
              ? getUserWorkAgentOverride(activeWorkAgent.id)
              : undefined,
          },
        );
        sendModelId = binding.modelId;
        sendProviderId = binding.providerId;
      }
    } catch (err) {
      if (err instanceof WorkAgentConfigError) {
        setStatus('err', err.message);
        if (uiDesignerCtx.active) {
          chat.workAgentId = savedWorkAgentId;
        }
        const boardTaskId = chat.boardTaskId?.trim();
        const boardGroupId = chat.boardGroupId?.trim();
        if (boardTaskId && boardGroupId && sessionState) {
          const group = sessionState.groups?.find((g) => g.id === boardGroupId);
          if (group?.orchestrateBoard) {
            const task = group.orchestrateBoard.tasks.find((t) => t.id === boardTaskId);
            if (task) task.error = err.message;
          }
        }
        return true;
      }
      throw err;
    }

    chat.modelId = sendModelId;
    chat.providerId = sendProviderId;

    const { library, serves } = await fetchLibraryAndServesImpl();
    const libraryModelId = resolveLibraryModelIdForChatBinding(
      chat.providerId,
      chat.modelId,
      library,
    );
    let libraryEnsure: { providerId: string; modelId: string } | null = null;
    let pendingModelLoad = false;
    let servedWindow: number | null = null;

    if (libraryModelId != null) {
      libraryEnsure = { providerId: LIBRARY_MODEL_PROVIDER_ID, modelId: libraryModelId };
      pendingModelLoad = libraryBindingNeedsServeLoad(
        libraryModelId,
        library,
        serves,
        modelCache,
      );
      const served = resolveLibrarySendBinding(libraryModelId, library, serves);
      if (served) {
        sendProviderId = served.providerId;
        sendModelId = served.modelId;
        servedWindow =
          servedContextLength(activeServeForLibraryId(libraryModelId, library, serves)) ?? null;
      } else {
        sendProviderId = resolveUpstreamProviderId(LIBRARY_MODEL_PROVIDER_ID, libraryModelId);
        const libRow = library.find((m) => m.id === libraryModelId);
        if (libRow?.format === 'MLX' && libRow.path?.trim() && sendModelId.trim().startsWith('mlx:')) {
          sendModelId = libRow.path.trim();
        }
      }
    }

    let provider = await getActiveProvider(sendProviderId);
    if (libraryModelId == null) {
      pendingModelLoad = chatTurnNeedsModelLoadImpl(provider, sendModelId);
    }

    const mainTurnLabel = uiDesignerCtx.active
      ? 'UI Designer'
      : activeWorkAgent?.label?.trim() || 'Main turn';
    emitMainTurnActivity({
      chatId: chat.id,
      phase: pendingModelLoad ? 'loading_model' : 'generating',
      currentTool: null,
      workAgentLabel: mainTurnLabel,
      modelId: sendModelId,
      providerId: sendProviderId,
      startedAtMs: Date.now(),
    });

    if (isStreamDomVisible(chat.id)) {
      setStatus(
        'spin',
        pendingModelLoad
          ? 'Loading model…'
          : uiDesignerCtx.active
            ? `${uiDesignerCtx.statusHint}…`
            : 'Generating reply…',
      );
    }

    const streamRow = appendStreamingAssistantRow(chat.id);
    wrap = streamRow.wrap;
    bubble = streamRow.bubble;
    cursor = streamRow.cursor;
    streamStatus = streamRow.streamStatus;

    const applyStreamDomRemount = (row: {
      wrap: HTMLDivElement;
      bubble: HTMLDivElement;
      cursor: HTMLDivElement;
      streamStatus: StreamingStatusHandle;
    }): void => {
      wrap = row.wrap;
      bubble = row.bubble;
      cursor = row.cursor;
      streamStatus = row.streamStatus;
      thoughtController?.setAssistantWrap(wrap);
      if (!painter) return;
      painter.retarget({
        wrap,
        bubble,
        cursor,
        streamStatus,
        ...(isStreamDomVisible(chat.id)
          ? { mount: getActiveChatMountElement() }
          : {}),
        thoughtController: thoughtController ?? undefined,
      });
    };
    registerStreamDomRemount(chat.id, applyStreamDomRemount);

    if (pendingModelLoad) {
      streamStatus?.setPhase('loading_model');
      setSidebarStreamPhase('loading_model', chat.id);
      const ensureProviderId = libraryEnsure?.providerId ?? sendProviderId;
      const ensureModelId = libraryEnsure?.modelId ?? sendModelId;
      let unsubLoad: (() => void) | null = null;
      if (isStreamDomVisible(chat.id) && streamStatus) {
        const status = streamStatus;
        const syncLoadDetail = (): void => {
          const live = getModelsState().loads.filter((l) => !l.error);
          const match = libraryEnsure?.modelId
            ? (live.find((l) => l.modelId === libraryEnsure.modelId) ?? live[0])
            : live[0];
          const pct = formatLoadPercentLabel(match?.percent);
          status.setRuntimeDetail(pct || null);
        };
        unsubLoad = subscribeModelsStore(syncLoadDetail);
        syncLoadDetail();
      }
      try {
        await ensureChatModelLoadedImpl(ensureProviderId, ensureModelId, chatSignal);
      } finally {
        unsubLoad?.();
      }
      if (libraryEnsure) {
        const { library: libraryAfter, serves: servesAfter } = await fetchLibraryAndServesImpl();
        const served = resolveLibrarySendBinding(libraryEnsure.modelId, libraryAfter, servesAfter);
        if (!served) {
          throw new Error('Failed to load My Models model — no running serve after load');
        }
        sendProviderId = served.providerId;
        sendModelId = served.modelId;
        servedWindow =
          servedContextLength(
            activeServeForLibraryId(libraryEnsure.modelId, libraryAfter, servesAfter),
          ) ?? null;
      }
      provider = await getActiveProvider(sendProviderId);
      streamStatus?.setRuntimeDetail(null);
      streamStatus?.setPhase('generating');
      setSidebarStreamPhase('generating', chat.id);
      patchMainTurnActivity(chat.id, { phase: 'generating', currentTool: null });
      if (isStreamDomVisible(chat.id)) {
        setStatus('spin', 'Generating reply…');
      }
    } else {
      setSidebarStreamPhase('generating', chat.id);
    }

    if (servedWindow != null) {
      // Keep the ring and token estimates on the served window from the first
      // round, before resolveModelInfo refreshes modelInfo at turn end.
      chat.modelInfo = { ...chat.modelInfo, context_length: servedWindow };
    }

    thinkingTracker = new ThinkingDurationTracker((elapsedMs) => {
      if (!isStreamDomVisible(chat.id)) return;
      thoughtController?.setThinkingElapsed(elapsedMs);
      streamStatus?.setThinkingElapsed(elapsedMs);
    });

    let awaitingProse = true;
    const revealProse = (): void => {
      awaitingProse = false;
      if (!isStreamDomVisible(chat.id) || !wrap || !bubble) return;
      revealAssistantProseBubble(wrap, bubble, streamStatus);
    };

    const thoughtPhaseCallbacks: ThoughtPhaseCallbacks = {
      onThinkingStart: (): void => {
        patchMainTurnActivity(chat.id, { phase: 'thinking', currentTool: null });
        if (isStreamDomVisible(chat.id)) {
          streamStatus?.setPhase('thinking');
        }
        setSidebarStreamPhase('thinking', chat.id);
        thinkingTracker?.startSegment();
      },
      onReasoningEnded: (): void => {
        thinkingTracker?.endSegment();
        if (isStreamDomVisible(chat.id)) {
          streamStatus?.setThinkingElapsed(null);
          if (awaitingProse) {
            streamStatus?.setPhase('generating');
            setSidebarStreamPhase('generating', chat.id);
          } else {
            setSidebarStreamPhase(null, chat.id);
          }
        } else if (awaitingProse) {
          patchMainTurnActivity(chat.id, { phase: 'generating', currentTool: null });
          setSidebarStreamPhase('generating', chat.id);
        } else {
          setSidebarStreamPhase(null, chat.id);
        }
      },
    };

    thoughtController = new ThoughtBubbleController(wrap, thoughtPhaseCallbacks);
    const liveThoughts = thoughtController;

    const beginNextStreamingRow = (): Partial<ChatTurnPaintHost> | void => {
      const nextRow = appendStreamingAssistantRow(chat.id);
      wrap = nextRow.wrap;
      bubble = nextRow.bubble;
      cursor = nextRow.cursor;
      streamStatus = nextRow.streamStatus;
      thoughtController?.setAssistantWrap(wrap);
      thoughtController?.resetStreamPhaseHints();
      awaitingProse = true;
      if (isStreamDomVisible(chat.id)) {
        setStatus('spin', 'Generating reply…');
      }
      patchMainTurnActivity(chat.id, { phase: 'generating', currentTool: null });
      return {
        wrap,
        bubble,
        cursor,
        streamStatus,
        thoughtController: thoughtController ?? undefined,
        revealProse,
      };
    };

    const stampLiveRowHistoryIndex = (row: HTMLElement): number | undefined => {
      const histIdx = store?.lastAssistantHistoryIndex();
      if (histIdx === undefined || !row.isConnected) return histIdx;
      row.dataset.historyIndex = String(histIdx);
      return histIdx;
    };

    streamingStatsPublisher = createStreamingStatsPublisher(chat);
    let statsT0 = 0;
    let statsTFirst: number | null = null;
    let liveStreamMeta: StreamMetaAccumulator = {};
    const turnStatsSegments: Array<{ stats: Stats; usage: Usage }> = [];
    const metricsState: {
      lastRound: { stats: Stats; usage: Usage; model_info: ModelInfo } | null;
      streamModelId: string;
    } = { lastRound: null, streamModelId: '' };
    let recordedUsageViaDeps = false;
    let recordedRoundUsage = false;
    const publishLiveStats = (
      snap: { lastDelta: string; lastThinking: string },
      flush: boolean,
      streamMeta: StreamMetaAccumulator = liveStreamMeta,
    ): void => {
      const input = {
        streamMeta,
        t0: statsT0 || performance.now(),
        tFirst: statsTFirst,
        partialText: snap.lastDelta,
        partialThinkingLength: snap.lastThinking.length,
        priorStatsSegments: turnStatsSegments,
        modelId: metricsState.streamModelId || sendModelId,
        modelInfo: chat.modelInfo ?? undefined,
      };
      if (flush) streamingStatsPublisher?.flush(input);
      else streamingStatsPublisher?.schedule(input);
    };
    const appendLiveRowStats = (row: HTMLElement, stats: Stats, usage: Usage): void => {
      if (!row.isConnected || !isStreamDomVisible(chat.id)) return;
      row.querySelector('.msg-stats')?.remove();
      appendStats(row, stats, usage);
    };
    const recordRoundLedger = (
      streamMeta: StreamMetaAccumulator,
      t0: number,
      tFirst: number | null,
      tEnd: number,
    ): void => {
      if (!hasMeasurableUsage(streamMeta.usage)) return;
      recordedRoundUsage = true;
      ledgerWrites.push(
        recordMainChatTurnUsage(chat, {
          providerId: sendProviderId || provider.id,
          modelId: metricsState.streamModelId || sendModelId,
          streamMeta,
          t0,
          tFirst,
          tEnd,
          workAgentId: activeWorkAgent?.id ?? null,
        }),
      );
    };

    const pendingToolCallsForContext: Array<{
      id?: string;
      name: string;
      arguments?: unknown;
    }> = [];

    const writeLiveContextOverlay = (snap?: {
      lastDelta?: string;
      lastThinking?: string;
    }): void => {
      const painterSnap = painter?.snapshot();
      syncTurnContextUsage({
        chatId: chat.id,
        partialAssistantText: snap?.lastDelta ?? painterSnap?.lastDelta,
        thinkingText: snap?.lastThinking ?? painterSnap?.lastThinking,
        pendingToolCallsJson:
          pendingToolCallsForContext.length > 0
            ? JSON.stringify(pendingToolCallsForContext)
            : undefined,
      });
      if (getActiveChat().id === chat.id) {
        scheduleContextUsageRefresh({ duringStream: true });
      }
    };

    painter = createChatTurnEventPainter({
      wrap: streamRow.wrap,
      bubble: streamRow.bubble,
      cursor: streamRow.cursor,
      streamStatus: streamRow.streamStatus,
      thoughtController: liveThoughts,
      mount: getActiveChatMountElement(),
      chatId: chat.id,
      revealProse,
      onActivity: () => notifyChatStreamActivity(chat.id),
      onCoalescedPaint: (snap) => {
        publishLiveStats(snap, false);
        writeLiveContextOverlay(snap);
      },
      modeId: chat.modeId,
      finalizeThinkingRound: () => thinkingTracker?.finalizeRound() ?? 0,
      beginNextStreamingRow,
      onRoundFinalized: ({ wrap: closedWrap, connected }) => {
        if (!connected || !isStreamDomVisible(chat.id)) return;
        if (metricsState.lastRound) {
          appendLiveRowStats(closedWrap, metricsState.lastRound.stats, metricsState.lastRound.usage);
        }
        const histIdx = stampLiveRowHistoryIndex(closedWrap);
        if (histIdx === undefined) return;
        void import('../ui/message-actions').then(({ attachMessageActions }) => {
          attachMessageActions(closedWrap, {
            chatId: chat.id,
            historyIndex: histIdx,
            turnKind: 'assistant-tools',
          });
        });
        if (isStreamDomVisible(chat.id)) {
          setStatus('spin', 'Running tools…');
        }
      },
    });

    // Local inference shares the GPU with the compositor, so stepping looping animations at
    // STEP_HZ buys tok/s back. A cloud turn reclaims nothing and only looks choppier (MIN-793).
    if (isLocalProvider(provider)) {
      releaseTickedMotion = acquireTickedMotion();
    }

    let systemPrompt = 'You are a helpful assistant.';
    let injectionBlocks: Awaited<ReturnType<typeof composeRunTurnChatSystemPrompt>>['injectionBlocks'] = {
      brainNotes: null,
      codeMap: null,
      contextDocuments: null,
    };
    try {
      const composed = await composeRunTurnChatSystemPrompt({
        chat,
        rawText,
        userText,
        skillId,
        skillBody: presetSkillBody,
        composedSystemPromptOverride:
          composedSystemPromptOverride?.trim() || replaySnapshot?.composedSystemPrompt,
        ephemeralContext,
        firstUserSend: firstUserSendForInjections,
        attachmentWorkspacePaths: validAttachments
          .map((a) => a.workspacePath?.trim())
          .filter((p): p is string => Boolean(p)),
        modelContextLimit: turnModelContextLimit(chat, sendModelId, servedWindow),
      });
      if (composed.composed.trim()) systemPrompt = composed.composed;
      injectionBlocks = composed.injectionBlocks;
    } catch (err) {
      if (err instanceof Error && /setup exploded/i.test(err.message)) throw err;
      if (validAttachments.some((a) => {
        try {
          return Boolean(a.workspacePath);
        } catch (inner) {
          throw inner;
        }
      })) {
        throw err;
      }
    }

    if (pushUser) {
      const injectionAdded = appendInjectionNoticesForTurn(chat, injectionBlocks);
      if (injectionAdded.length > 0) {
        scheduleSaveSessions();
        if (isStreamDomVisible(chat.id)) {
          appendInjectionNoticesDom(
            injectionAdded,
            chat.history.length - injectionAdded.length,
            { chatId: chat.id },
          );
        }
      }
    }

    await fetchReplayPriorReasoningEnabled().catch(() => false);

    // Resolve sampler on every send, including resume. `runTurn` substitutes
    // `model.sampler` for `deps.resolveSamplerPreset`; omitting it drops the
    // inner loop onto the sub-agent 2048-token fallback, so Settings → Sampler
    // max tokens never reached the provider and replies finished with
    // finish_reason: length ("Response truncated").
    const globalSampler = mergeGlobalSamplerWithLibraryModel(
      readGlobalSamplerForSend(
        replaySnapshot
          ? {
              temperature: replaySnapshot.temperature,
              maxTokens: replaySnapshot.maxTokens,
            }
          : undefined,
      ),
      sendModelId,
    );
    const resolvedSampler = resolveSamplerPreset({
      kind: 'work-agent',
      agentKey: activeWorkAgent?.id ?? null,
      global: globalSampler,
    });

    if (!resumeGenerationId) {
      const forkHistoryIndex = resolveForkHistoryIndex(chat, pushUser);
      const userRow = chat.history[forkHistoryIndex];
      const userContent =
        userRow && userRow.role === 'user' ? userRow.content : historyContent;
      let snapTools = getEnabledToolDefinitionsForChat(chat, { skillId });
      if (activeWorkAgent?.allowedTools?.length) {
        const allow = new Set(activeWorkAgent.allowedTools);
        snapTools = snapTools.filter((t) => allow.has(t.function.name));
      }
      snapTools = applyUiDesignerToolFilter(snapTools, uiDesignerCtx);
      const enabledToolNames = snapTools.map((t) => t.function.name);
      const resolvedThinking = replaySnapshot
        ? { mode: replaySnapshot.thinkingMode, sourceLabel: 'replay' }
        : resolveThinkingMode({
            kind: 'work-agent',
            agentKey: activeWorkAgent?.id ?? null,
            chatThinkingMode: chat.thinkingMode,
          });

      if (replaySnapshot) {
        const run = createRun(chat, replaySnapshot, {
          parentRunId,
          parentTurnId: undefined,
          overrides: forkOverrides,
        });
        turnRunId = run.runId;
      } else {
        const snapshot = await buildTurnSnapshot({
          chat,
          forkHistoryIndex,
          composedSystemPrompt: systemPrompt,
          enabledToolNames,
          providerId: sendProviderId,
          modelId: sendModelId,
          temperature:
            resolvedSampler.preset.temperature ??
            globalSampler.preset.temperature ??
            0.7,
          maxTokens: resolvedSampler.maxTokens,
          thinkingMode: resolvedThinking.mode,
          skillId,
          userContent,
        });
        const run = createRun(chat, snapshot, {
          parentRunId,
          parentTurnId: undefined,
          overrides: forkOverrides,
        });
        turnRunId = run.runId;
      }
      if (turnRunId) {
        await capturePreTurnSnapshot(chat, turnRunId);
      }
      scheduleSaveSessions();
    }

    ownsComposer = pushUser && !hideUserEcho && useActiveChatDom;
    sentAttachments = ownsComposer ? getPendingAttachments() : [];
    if (sentAttachments.length > 0) {
      clearAttachments();
    }

    let tools: RunTurnOptions['tools'] = [];
    try {
      tools = chatToolDefinitionsForTurn(chat, skillId);
    } catch {
      tools = spikeChatToolDefinitions();
    }
    if (tools.length === 0) tools = spikeChatToolDefinitions();

    if (tools.some((tool) => tool.function.name.startsWith('browser_'))) {
      agentBrowserOwner = {
        chatId: chat.id,
        runId: turnRunId ?? resumeGenerationId ?? chat.id,
        agentId: activeWorkAgent?.id ?? chat.workAgentId ?? 'main',
      };
      agentBrowserRuntime = await openAgentBrowserRuntime(agentBrowserOwner);
    }

    const chatStore = createChatTranscriptStore({
      thoughtController: liveThoughts,
      turnRunId,
    });
    store = chatStore;
    const deps = createRendererRunnerDeps(chatStore);
    const applyPolicy = deps.applyContextPolicy;
    deps.applyContextPolicy = async (input) => {
      const prev =
        input && typeof input === 'object'
          ? (input as { onStatus?: (level: 'spin' | 'ok', message: string) => void })
          : {};
      return applyPolicy({
        ...(typeof input === 'object' && input ? input : {}),
        onStatus: (level: 'spin' | 'ok', message: string) => {
          prev.onStatus?.(level, message);
          setStatus(level, message);
        },
      });
    };
    deps.recordTurnUsage = async (_input, turn) => {
      const payload = turn as {
        providerId?: string;
        modelId?: string;
        streamMeta?: StreamMetaAccumulator;
        t0?: number;
        tFirst?: number | null;
        tEnd?: number;
      };
      if (!payload?.streamMeta || !hasMeasurableUsage(payload.streamMeta.usage)) return;
      recordedUsageViaDeps = true;
      recordRoundLedger(
        payload.streamMeta,
        Number.isFinite(payload.t0) ? (payload.t0 as number) : performance.now(),
        payload.tFirst ?? null,
        Number.isFinite(payload.tEnd) ? (payload.tEnd as number) : performance.now(),
      );
    };

    let resumeId = resumeGenerationId?.trim() || '';
    deps.postChatCompletions = async (prov, body, signal, postOptions) => {
      const next: PostChatCompletionsOptions = {
        ...postOptions,
        persist: true,
        fallbackRole: postOptions?.fallbackRole ?? 'main-chat',
        chatId: chat.id,
        onGenerationId: (id) => {
          chat.currentGenerationId = id;
          chatStore.noteGeneration(chat.id, id);
          postOptions?.onGenerationId?.(id);
        },
      };
      if (resumeId) {
        next.resumeGenerationId = resumeId;
        resumeId = '';
      }
      try {
        return await postChatCompletions(
          prov as unknown as Parameters<typeof postChatCompletions>[0],
          body as unknown as Parameters<typeof postChatCompletions>[1],
          signal,
          next,
        );
      } catch (err) {
        const { GenerationNotFoundError } = await import('../api/generations');
        if (err instanceof GenerationNotFoundError) {
          chat.currentGenerationId = undefined;
          scheduleSaveSessions();
        }
        throw err;
      }
    };

    const needsOverlay = chatTurnNeedsMultimodalOverlay(chat, validAttachments);
    const priorMessages = needsOverlay
      ? overlayMultimodalHistoryForRunTurn(chat, {
          modelId: sendModelId,
          vision: canSendImagesToModel(sendModelId),
          pendingUserText: userText || rawText,
          attachments: validAttachments,
        })
      : undefined;
    const seed =
      ephemeralContinueInstruction?.trim() ||
      (priorMessages ? '' : historyContent);

    statsT0 = performance.now();
    let parallelSafeStreak = 0;
    let roundModeId = chat.modeId;

    const result = await runTurnImpl({
      chatId: chat.id,
      seed,
      seedKind: 'continue',
      ...(priorMessages ? { messages: priorMessages as TranscriptMessage[] } : {}),
      systemPrompt,
      tools,
      lazyTools: loadToolConfig().lazyTools !== false,
      model: {
        providerId: provider.id,
        id: sendModelId,
        // Wrapped `{ preset, maxTokens }` — same shape the sub-agent effector
        // uses. A flat sampler row would crash `applySamplerToBody`.
        sampler: {
          preset: resolvedSampler.preset as Record<string, unknown>,
          maxTokens: resolvedSampler.maxTokens,
        },
        thinking:
          chat.thinkingMode === 'off' || chat.thinkingMode === 'on'
            ? { mode: chat.thinkingMode }
            : undefined,
      },
      onEvent: (event) => {
        chatStore.observe(event);
        if (event.type === 'response_restart') {
          liveStreamMeta = {}; statsTFirst = null; statsT0 = performance.now();
        }
        if (event.type === 'round_start') {
          liveStreamMeta = {};
          statsT0 = performance.now();
          statsTFirst = null;
          parallelSafeStreak = 0;
        }
        if (
          statsTFirst == null &&
          (event.type === 'delta' || event.type === 'thinking') &&
          event.text
        ) {
          statsTFirst = performance.now();
        }
        if (event.type === 'stream_meta') {
          liveStreamMeta = applyStreamMetaEvent(liveStreamMeta, event);
          if (typeof event.model === 'string' && event.model.trim()) {
            metricsState.streamModelId = event.model.trim();
          }
          const runtime = runtimeStatusFromStreamMetaRuntime(
            event.runtime,
            statsTFirst != null,
          );
          if (isStreamDomVisible(chat.id) && streamStatus) {
            if (runtime.phase === 'prompt_processing' && statsTFirst == null) {
              streamStatus.setPhase('prompt_processing');
            }
            streamStatus.setRuntimeDetail(runtime.detail || null);
          }
          const snap = painter?.snapshot() ?? { lastDelta: '', lastThinking: '' };
          publishLiveStats(snap, false);
        }
        if (event.type === 'round_end') {
          const roundStreamMeta = streamMetaFromRoundEnd(liveStreamMeta, event);
          const tEnd = Number.isFinite(event.tEnd) ? event.tEnd : performance.now();
          const t0 = Number.isFinite(event.t0) ? event.t0 : statsT0 || tEnd;
          const tFirst = event.tFirst ?? statsTFirst ?? tEnd;
          metricsState.lastRound = finalizeResponseMeta(roundStreamMeta, t0, tFirst, tEnd);
          if (metricsState.lastRound.usage && Object.keys(metricsState.lastRound.usage).length > 0) {
            turnStatsSegments.push({
              stats: metricsState.lastRound.stats,
              usage: metricsState.lastRound.usage,
            });
          }
          if (!recordedUsageViaDeps) {
            recordRoundLedger(roundStreamMeta, t0, tFirst, tEnd);
          }
          recordedUsageViaDeps = false;
          liveStreamMeta = {};
          publishLiveStats({ lastDelta: '', lastThinking: '' }, true, {});
        }
        if (event.type === 'loading_model') {
          streamStatus?.setPhase('loading_model');
          setSidebarStreamPhase('loading_model', chat.id);
          patchMainTurnActivity(chat.id, {
            phase: 'loading_model',
            currentTool: null,
          });
        }
        if (event.type === 'phase') {
          if (event.phase === 'thinking' || event.phase === 'generating') {
            patchMainTurnActivity(chat.id, {
              phase: event.phase,
              currentTool: null,
            });
            if (event.phase === 'generating') {
              streamStatus?.setPhase('generating');
              setSidebarStreamPhase('generating', chat.id);
            }
          }
        }
        if (event.type === 'tool_streaming') {
          if (parallelSafeStreak <= 1) {
            patchMainTurnActivity(chat.id, { currentTool: event.name });
          }
        }
        if (event.type === 'tool_call') {
          if (isParallelSafeTool(event.name)) {
            parallelSafeStreak += 1;
          } else {
            parallelSafeStreak = 0;
          }
          const aggregate =
            parallelSafeStreak > 1
              ? parallelToolsActivityLabel(parallelSafeStreak)
              : '';
          patchMainTurnActivity(chat.id, {
            phase: 'tools',
            currentTool: aggregate || event.name,
          });
          pendingToolCallsForContext.push({
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          });
          writeLiveContextOverlay();
        }
        painter?.onEvent(event);
      },
      transcript: chatStore,
      signal: chatSignal,
      deps,
      limits: chatTurnContextLimits(chat, sendModelId, servedWindow),
      ask: createChatAskCapability({ chatId: chat.id }),
      askTimeoutMs: resolveSpikeAskTimeoutMs(),
      onRoundBoundary: createChatRoundBoundary(chat, agentBrowserRuntime),
      refreshRoundConfig: async () => {
        if (chat.modeId === roundModeId) return null;
        const composed = await composeRunTurnChatSystemPrompt({
          chat, rawText, userText, skillId, skillBody: presetSkillBody,
          ephemeralContext, firstUserSend: false,
          attachmentWorkspacePaths: validAttachments
            .map((a) => a.workspacePath?.trim())
            .filter((p): p is string => Boolean(p)),
          modelContextLimit: turnModelContextLimit(chat, sendModelId, servedWindow),
        });
        roundModeId = chat.modeId;
        return { systemPrompt: composed.composed, tools: chatToolDefinitionsForTurn(chat, skillId) };
      },
      injectReportTool: false,
      nudgeToolUse: false,
      finalizeStructuredOutcome: false,
      execute: async (name, args, ctx) => {
        if (name === ASK_QUESTION_TOOL_NAME) {
          return {
            content:
              'Error: ask_question must be handled by the injected ask capability.',
          };
        }
        const planBlock = uiDesignerActive
          ? assertUiDesignerToolAllowed(name, uiDesignerCtx.mode)
          : null;
        if (planBlock) {
          return { content: planBlock };
        }

        const toolLoopModeId = normalizeModeId(chat.modeId);
        setSubAgentExecutorContext({
          parentTurnId: turnRunId ?? chat.id,
          modeId: toolLoopModeId,
          parentChatId: chat.id,
          parentToolCallId: ctx.toolCallId,
        });
        setBugBoardExecutorContext({ chatId: chat.id });

        const scopedWorkspaceRoot = resolveChatToolWorkspaceRoot(
          chat,
          sessionState?.groups,
        );
        const toolOut = await executeTool(name, asToolArgs(args), {
          chatId: chat.id,
          runId: agentBrowserOwner?.runId ?? turnRunId ?? chat.id,
          agentId: agentBrowserOwner?.agentId ?? activeWorkAgent?.id ?? chat.workAgentId ?? 'main',
          toolCallId: ctx.toolCallId,
          modeId: toolLoopModeId,
          workAgentId: chat.workAgentId ?? null,
          signal: chatSignal,
          ...(scopedWorkspaceRoot ? { workspaceRoot: scopedWorkspaceRoot } : {}),
        });
        const payload: {
          content: string;
          attachments?: typeof toolOut.attachments;
          codeChange?: typeof toolOut.codeChange;
        } = {
          content: toolOut.content,
        };
        if (toolOut.attachments?.length) payload.attachments = toolOut.attachments;
        if (toolOut.codeChange) payload.codeChange = toolOut.codeChange;
        return payload;
      },
    });

    await Promise.all(ledgerWrites);

    if (result.usage && !recordedRoundUsage) {
      const agent = resolveActiveWorkAgent(chat);
      await recordChatCompletionUsage(chat, {
        source: {
          kind: 'main',
          modeId: normalizeModeId(chat.modeId),
          workAgentId: agent?.id ?? chat.workAgentId ?? null,
        },
        providerId: sendProviderId || provider.id,
        modelId: sendModelId,
        usage: result.usage as Usage,
      });
    }

    const chrome: InterruptedTurnChrome = {
      chat,
      wrap,
      bubble,
      cursor,
      streamStatus,
      thoughtController,
      painter,
      store,
      turnRunId,
      pushUser,
    };

    if (isAbortedTurnResult(result, chatSignal)) {
      const settled = settleStoppedTurn(chrome);
      turnRunStatus = 'stopped';
      turnStopReason = settled.stopReason;
    } else if (
      isFailedTurnResult(result) ||
      isGenerationLostMessage('error' in result ? result.error : undefined)
    ) {
      const errText =
        result.outcome === 'timeout'
          ? 'timeout'
          : 'error' in result && result.error.trim()
            ? result.error.trim()
            : result.outcome;
      const settled = settleFailedTurn(chrome, errText);
      turnRunStatus = 'failed';
      turnErrorMessage = settled.errorMessage;
    } else {
      chat.currentGenerationId = undefined;
      recordAssistantReplyOnChat(chat);
      recordChatMessage(chat);
      scheduleSaveSessions();

      painter?.flush();
      const painted = painter?.snapshot() ?? {
        lastDelta: '',
        lastThinking: '',
        toolCallCount: 0,
      };
      publishLiveStats(painted, true, {});
      const displayMeta = buildTurnDisplayMeta(turnStatsSegments, metricsState.lastRound);
      if (displayMeta) {
        chat.lastStats = buildLastStatsSnapshot(displayMeta.stats, displayMeta.usage);
        const modelInfo = resolveModelInfo(
          metricsState.streamModelId || sendModelId,
          metricsState.lastRound?.model_info ?? {},
        );
        chat.modelInfo = { ...modelInfo };
        if (getActiveChat().id === chat.id) {
          updateStrip(displayMeta.stats, displayMeta.usage, modelInfo);
        }
      }
      if (bubble && cursor) {
        cancelAssistantBubbleRenderDebounce(bubble);
        finishStreamingBubbleRender(bubble, cursor);
      }
      const prose = painted.lastDelta.trim();
      const thinkingDurationMs = thinkingTracker?.finalizeRound() ?? 0;
      const hasProse = Boolean(prose);
      if (hasProse && wrap?.isConnected && bubble) {
        revealProse();
        setAssistantBubbleContent(bubble, prose, { streaming: false, modeId: chat.modeId });
        completeStreamAnnouncer(prose);
      }
      if (wrap?.isConnected) {
        finalizeAndAnchorThinkingRound({
          thoughtController,
          wrap,
          streamStatus,
          hasProse,
          durationMs: thinkingDurationMs,
          domVisible: isStreamDomVisible(chat.id),
        });
        if (metricsState.lastRound) {
          appendLiveRowStats(wrap, metricsState.lastRound.stats, metricsState.lastRound.usage);
        }
      } else {
        thoughtController?.consumePersistedSegments();
      }
      if (hasProse && wrap?.isConnected && bubble) {
        const histIdx = stampLiveRowHistoryIndex(wrap);
        if (isStreamDomVisible(chat.id)) {
          const { attachMessageActions } = await import('../ui/message-actions');
          const { attachVoicePlayButton } = await import('../ui/voice-controls');
          if (histIdx !== undefined) {
            attachMessageActions(wrap, {
              chatId: chat.id,
              historyIndex: histIdx,
              turnKind: 'assistant',
            });
          }
          attachVoicePlayButton(wrap, prose);
          const lastMsg =
            histIdx !== undefined ? chat.history[histIdx] : undefined;
          if (
            lastMsg &&
            lastMsg.role === 'assistant' &&
            'truncated' in lastMsg &&
            lastMsg.truncated
          ) {
            markMessageTruncated(wrap, chat);
          }
        }
      } else if (wrap?.isConnected && !hasProse) {
        stampLiveRowHistoryIndex(wrap);
      }
      streamStatus?.dispose();
      if (isStreamDomVisible(chat.id)) {
        setStatus('ok', 'Ready');
        scrollChatIfPinned();
      }
      scheduleRenderSidebar();

      if (
        (firstUserSendForInjections || deferTitleUntilTurnEnd || shouldScheduleTitle) &&
        (titleSeed || userText || rawText).trim()
      ) {
        scheduleChatTitleGeneration(chat.id, titleSeed || userText || rawText, {
          modelId: sendModelId,
          providerId: sendProviderId || provider.id,
        });
      }

      if (normalizeModeId(chat.modeId) !== 'debug') {
        const lastAssistant = [...chat.history].reverse().find((m) => m.role === 'assistant');
        const assistantText =
          lastAssistant && typeof lastAssistant.content === 'string'
            ? lastAssistant.content
            : '';
        schedulePostTurnSynthesis({
          chatId: chat.id,
          messages: buildSynthesisMessages(chat),
          roundCount: 1,
          toolCount: painted.toolCallCount,
          sourceExcerpt: buildSynthesisExcerpt(chat),
          assistantText,
          boardChat: isBoardOwnedChat(chat) || isBoardTaskChat(chat),
          ...(chat.kind === 'expert' && chat.expertId?.trim()
            ? { expertId: chat.expertId.trim() }
            : {}),
        });
      }

      completedNormally = result.outcome === 'no_report' || result.outcome === 'pass';
      if (completedNormally) turnRunStatus = 'completed';
    }
  } catch (err) {
    const chrome: InterruptedTurnChrome = {
      chat,
      wrap,
      bubble,
      cursor,
      streamStatus,
      thoughtController,
      painter,
      store,
      turnRunId,
      pushUser,
    };
    if (isAbortError(err) || getChatAbort(chat.id)?.signal.aborted) {
      const settled = settleStoppedTurn(chrome);
      turnRunStatus = 'stopped';
      turnStopReason = settled.stopReason;
    } else {
      const settled = settleFailedTurn(chrome, err);
      turnRunStatus = 'failed';
      turnErrorMessage = settled.errorMessage;
    }
    if (!turnTeardownRan && err instanceof Error && /setup exploded/i.test(err.message)) {
      throw err;
    }
  } finally {
    turnTeardownRan = true;
    setSubAgentExecutorContext(null);
    setBugBoardExecutorContext(null);
    await Promise.all(ledgerWrites);
    streamingStatsPublisher?.reset();
    streamingStatsPublisher = null;
    releaseTickedMotion?.();
    releaseTickedMotion = null;
    thoughtController?.abort();
    thinkingTracker?.abort();
    store?.abortThinking();
    clearContextInFlightOverlay(chat.id);
    scheduleContextUsageRefresh();
    registerStreamDomRemount(chat.id, null);
    if (turnStopReason !== 'system' && chat.currentGenerationId) {
      chat.currentGenerationId = undefined;
      touchChat(chat);
      scheduleSaveSessions();
    }
    clearMainTurnActivity(chat.id);
    const leftoverBrowserGuide = completedNormally ? (agentBrowserRuntime?.drainText() ?? '') : '';
    await agentBrowserRuntime?.close();
    agentBrowserRuntime = null;
    streamStatus?.setPhase('done');
    streamStatus?.dispose();
    if (wrap?.isConnected && wrap.classList.contains('msg--awaiting-prose')) {
      removeOrphanStreamingRow(wrap, streamStatus);
    }
    if (uiDesignerActive) {
      chat.workAgentId = savedWorkAgentId;
    }
    if (!completedNormally) {
      restorePendingAttachments(sentAttachments);
    }
    if (turnRunId) {
      const run = findRunById(chat, turnRunId);
      const start = run?.outputHistoryStart;
      const end = run?.outputHistoryEnd;
      finalizeRun(chat, turnRunId, {
        status: completedNormally ? 'completed' : turnRunStatus,
        outputHistoryStart: start,
        outputHistoryEnd: end,
        stopReason: turnRunStatus === 'stopped' ? (turnStopReason ?? 'user') : undefined,
        errorMessage: turnErrorMessage,
      });
      await capturePostTurnSnapshot(chat, turnRunId);
      scheduleSaveSessions();
      if (isStreamDomVisible(chat.id) && run) {
        refreshBranchPickerAtFork(chat, run.forkHistoryIndex);
      }
    }
    endStreamingImpl(chat.id);
    setSidebarStreamPhase(null, chat.id);
    syncChatItemDotsInDom();
    if (getActiveChat().id === chat.id) {
      syncComposerFromStreamingState();
    }
    void rehydrateLiveParentSubAgents(chat.id);
    if (getChatAbort(chat.id)?.signal) {
      setChatAbort(chat.id, null);
    }
    if (turnMountPinned) {
      setTurnChatMount(null);
    }
    endChatTurnSetup(chat.id);

    if (completedNormally && isPartyModePinned(chat.pinnedSkill) && isStreamDomVisible(chat.id)) {
      burstPartyConfetti();
    }

    if (completedNormally) {
      const leftoverSteer = [leftoverBrowserGuide, chat.pendingSteerMessage?.trim() ?? '']
        .filter(Boolean)
        .join('\n\n');
      if (leftoverSteer) {
        clearPendingSteer(chat);
        void resumeParentChatWithMessage(chat, leftoverSteer);
      } else {
        void flushPendingMessageQueue(chat);
        if (goalDriven) {
          void import('./goal/evaluate').then((mod) => {
            void mod.maybeContinueGoalAfterTurn(chat);
          });
        }
        void import('./loop/pacing').then((mod) => {
          mod.maybeRescheduleLoopsAfterTurn(chat);
        });
      }
    }
  }
  return true;
}

// ── Resume ───────────────────────────────────────────────────────────────────

export async function resumeParentChatWithMessage(
  chat: Chat,
  message: string,
  options: ResumeParentChatOptions = {},
): Promise<boolean> {
  if (isChatStreaming(chat.id)) return false;
  if (isChatTurnSetupPending(chat.id)) return false;
  if (!chat.modelId?.trim()) return false;

  return runChatTurn({
    chat,
    pushUser: true,
    suppressUserEcho: options.suppressUserEcho ?? false,
    rawText: message,
    userText: message,
    skillId: null,
    displayText: message,
    historyContent: message,
    validAttachments: [],
    goalDriven: options.goalDriven ?? false,
  });
}
