import { loadTitlesConfig } from '../../config/titles-meta';
import { loadUtilityModelConfig, utilityModelOverride } from '../../config/utility-model-meta';
import { ensureChatModelLoadedForTurn } from '../../api/ensure-chat-model-loaded';
import { resolveLibraryRequestBinding } from '../../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../../models/model-select-library';
import { getActiveProvider } from '../../providers/store';
import { hasMeasurableUsage } from '../../usage/pricing';
import { recordChatCompletionUsage } from '../../usage/record-chat-usage';
import {
  applyGeneratedChatTitle,
  findChatById,
  getChatMessageCount,
  scheduleSaveSessions,
  touchChat,
} from '../../state/sessions';
import type { Chat } from '../../types';
import { scheduleRenderSidebar } from '../../ui/sidebar';
import { generateChatTitle } from './generate';
import { fallbackTitleFromSeed } from './sanitize';
import {
  hasTitleJobInflight,
  registerTitleJobInflight,
  releaseTitleJobInflight,
} from './inflight';
import { emitTitleJobEnded, emitTitleJobStarted } from './activity-events';
import { isPlaceholderChatName } from './placeholder';
import { createTitleProviderPort } from './provider-port';
import type { TitleGenerationOptions } from './types';

/** Resolved send binding passed from the main message path (work-agent / UI designer). */
export interface TitleScheduleContext {
  modelId?: string;
  providerId?: string;
}

const scheduleContextByChatId = new Map<string, TitleScheduleContext>();
/** Exact prompt snippets that a pending auto-title job may still replace. */
const pendingPlaceholderByChatId = new Map<string, string>();

let titleGenerateImpl = generateChatTitle;

/** Replace title generator (unit tests). */
export function setGenerateChatTitleForTests(
  impl: typeof generateChatTitle | null,
): void {
  titleGenerateImpl = impl ?? generateChatTitle;
}

export function isFirstUserMessagePending(chat: Chat): boolean {
  if (chat.historyLoaded === false) {
    return getChatMessageCount(chat) === 0;
  }
  return !chat.history.some((m) => m.role === 'user');
}

export { resetTitleGenerationInflight } from './inflight';

/** Clear per-chat schedule context (tests). */
export function resetTitleScheduleContext(): void {
  scheduleContextByChatId.clear();
  pendingPlaceholderByChatId.clear();
}

/**
 * Replace "New chat" with an immediate first-prompt snippet while preserving
 * the model title job's ability to replace that exact temporary value later.
 */
export function applyPromptTitlePlaceholder(chatId: string, seed: string): boolean {
  const chat = findChatById(chatId);
  if (!chat || !isPlaceholderChatName(chat.name)) return false;

  const snippet = fallbackTitleFromSeed(seed);
  if (!snippet) return false;

  chat.name = snippet;
  pendingPlaceholderByChatId.set(chatId, snippet);
  touchChat(chat);
  return true;
}

function isAutoTitleReplaceable(chat: Pick<Chat, 'id' | 'name'>): boolean {
  if (isPlaceholderChatName(chat.name)) return true;
  const pendingPlaceholder = pendingPlaceholderByChatId.get(chat.id);
  return pendingPlaceholder !== undefined && chat.name === pendingPlaceholder;
}

/** Read-only model binding captured when the title job was scheduled. */
export function getTitleScheduleContext(chatId: string): TitleScheduleContext | undefined {
  return scheduleContextByChatId.get(chatId);
}

export function scheduleChatTitleGeneration(
  chatId: string,
  seed: string,
  context?: TitleScheduleContext,
): void {
  if (hasTitleJobInflight(chatId)) return;

  const chat = findChatById(chatId);
  if (!chat || !isAutoTitleReplaceable(chat)) {
    pendingPlaceholderByChatId.delete(chatId);
    return;
  }

  if (context && (context.modelId?.trim() || context.providerId?.trim())) {
    scheduleContextByChatId.set(chatId, {
      modelId: context.modelId?.trim() || undefined,
      providerId: context.providerId?.trim() || undefined,
    });
  }

  const controller = new AbortController();
  if (!registerTitleJobInflight(chatId, controller)) return;

  emitTitleJobStarted(chatId, scheduleContextByChatId.get(chatId) ?? context);

  void runTitleJob(chatId, seed, controller.signal)
    .catch(() => {
    })
    .finally(() => {
      scheduleContextByChatId.delete(chatId);
      pendingPlaceholderByChatId.delete(chatId);
      releaseTitleJobInflight(chatId, controller);
      emitTitleJobEnded(chatId);
    });
}

function resolveTitleGenerationOptions(
  chatBefore: { modelId: string; providerId?: string },
  config: Awaited<ReturnType<typeof loadTitlesConfig>>,
  scheduled: TitleScheduleContext | undefined,
  utility: Awaited<ReturnType<typeof loadUtilityModelConfig>>,
): Pick<TitleGenerationOptions, 'modelId' | 'providerId'> | null {
  const override = utilityModelOverride(utility);
  const modelId =
    override?.modelId ||
    config.modelId.trim() ||
    scheduled?.modelId?.trim() ||
    chatBefore.modelId.trim();
  if (!modelId) return null;

  const providerId =
    override?.providerId ||
    config.providerId.trim() ||
    scheduled?.providerId?.trim() ||
    chatBefore.providerId?.trim() ||
    undefined;

  return { modelId, providerId };
}

async function runTitleJob(chatId: string, seed: string, signal: AbortSignal): Promise<void> {
  const config = await loadTitlesConfig();
  if (!config.enabled) return;
  const utility = await loadUtilityModelConfig();

  const chatBefore = findChatById(chatId);
  if (!chatBefore || !isAutoTitleReplaceable(chatBefore)) return;

  const scheduled = scheduleContextByChatId.get(chatId);
  const resolved = resolveTitleGenerationOptions(chatBefore, config, scheduled, utility);
  if (!resolved) return;

  let sendBinding = await resolveLibraryRequestBinding(
    resolved.providerId ?? chatBefore.providerId ?? '',
    resolved.modelId,
  );
  if (sendBinding.kind === 'needsLoad') {
    await ensureChatModelLoadedForTurn(
      LIBRARY_MODEL_PROVIDER_ID,
      sendBinding.libraryModelId,
      signal,
    );
    sendBinding = await resolveLibraryRequestBinding(
      LIBRARY_MODEL_PROVIDER_ID,
      sendBinding.libraryModelId,
    );
    if (sendBinding.kind === 'needsLoad') return;
  }

  const activeProvider = await getActiveProvider(sendBinding.providerId);
  const providerId = activeProvider.id;

  const generated = await titleGenerateImpl(
    seed,
    {
      modelId: sendBinding.modelId,
      providerId: sendBinding.providerId,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal,
    },
    createTitleProviderPort(sendBinding.providerId),
  );

  const title = generated.title ?? fallbackTitleFromSeed(seed);
  if (hasMeasurableUsage(generated.usage)) {
    const chatForLedger = findChatById(chatId);
    if (chatForLedger) {
      void recordChatCompletionUsage(chatForLedger, {
        source: { kind: 'title' },
        providerId,
        modelId: sendBinding.modelId,
        usage: generated.usage!,
      });
    }
  }
  if (!title || signal.aborted) return;

  const applied = applyGeneratedChatTitle(
    chatId,
    title,
    pendingPlaceholderByChatId.get(chatId),
  );
  if (!applied) return;

  const chat = findChatById(chatId);
  if (chat) touchChat(chat);
  scheduleSaveSessions();
  scheduleRenderSidebar();
}
