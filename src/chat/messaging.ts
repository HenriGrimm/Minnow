import type { Attachment } from '../attachments/types';
import {
  getPendingAttachments,
  replacePendingAttachments,
} from '../attachments/store';
import { attachmentsHaveImages } from '../attachments/attachment-image';
import { resolveWorkspaceReferences } from '../attachments/workspace-ref';
import { handleGoalCommand } from './goal/command';
import { handleLoopCommand } from './loop/command';
import { handleCompressCommand } from './context/compress-command';
import { enqueueComposerMessage } from './message-queue';
import { isChatTurnSetupPending } from './chat-turn-guard';
import {
  isActiveChatStreaming,
  isBackgroundStreamBlockingSend,
  isChatStreaming,
} from './streaming-state';
import { isFirstUserMessagePending } from './titles/schedule';
import { normalizeModeId } from './modes/types';
import { buildHistoryUserContent } from './build-api-messages';
import { runChatTurn } from './run-turn-chat';
import {
  getActiveChat,
  getActiveGoal,
  isGoalLoopActive,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import { canSendImagesToModel } from '../providers/vision-model.ts';
import { detectLocalServer } from '../tools/client';
import {
  composeImpeccableSkillBody,
  shouldComposeImpeccableBody,
  augmentCavemanSkillBody,
  augmentPartyModeSkillBody,
  CAVEMAN_SKILL_ID,
  PARTYMODE_SKILL_ID,
  formatHistoryWithSkillTag,
  isSkillEnabled,
  normalizeCavemanUserText,
  parseSlashCommand,
  resolveActiveSkill,
  resolveTurnSkill,
} from '../skills';
import { UI_DESIGNER_AGENT_ID } from '../agents/ui-designer/constants';
import {
  augmentSkillBodyForUiDesigner,
  prepareUiDesignerTurn,
} from '../agents/ui-designer/runner';
import { applyModelSelectValueToChat } from '../lib/model-select-key';
import {
  resolveEffectiveChatModelBinding,
  syncPerChatModelBindingFromCatalog,
} from '../ui/default-model';
import {
  clearComposerAfterSend,
} from '../ui/composer-draft';
import {
  resolveComposerSurface,
  type ComposerSurface,
} from '../ui/composer-surface';
import { refreshComposerStreamingAffordance } from '../ui/composer-send';
import { syncComposerMessageQueue } from '../ui/composer-message-queue';
import { syncGoalActiveHint } from '../ui/goal-active-hint';
import { syncLoopActiveHint } from '../ui/loop-active-hint';
import { syncTodoPanel } from '../ui/todo-panel';
import { syncComposerPinnedSkillFromActiveChat } from '../ui/composer-pinned-skill';
import { getPickerAppliedSkillId } from '../ui/skill-picker';
import { setStatus } from '../ui/status';
import type { Chat } from '../types';

export {
  buildApiMessages,
  buildHistoryUserContent,
  buildVlmUserApiContent,
  persistableUserImages,
} from './build-api-messages';
export {
  runChatTurn,
  resumeParentChatWithMessage,
} from './run-turn-chat';
export type { RunChatTurnOptions, ResumeParentChatOptions } from './run-turn-chat';
export type { ComposerSurface } from '../ui/composer-surface';
export { resendFromIndex } from './resend-from-index';
export {
  truncateChatHistory,
  updateUserMessageAt,
} from './history-truncate';
/** Non-tool send (legacy / internal). */
export { sendMessage as sendMessagePlain } from '../api/chat';

// ── Options ──────────────────────────────────────────────────────────────────

/** Send the composer text with tool calling. */
export interface ComposerSendOptions extends Partial<ComposerSurface> {
  /** Surface-owned context injected for this turn without adding it to chat history. */
  ephemeralContext?: string;
}

/** Options for {@link sendProgrammaticChatText}. */
export interface SendProgrammaticChatTextOptions {
  goalDriven?: boolean;
  suppressUserEcho?: boolean;
  ephemeralContext?: string;
  validAttachments?: Attachment[];
  composerSurface?: Partial<ComposerSurface>;
  parseSlash?: boolean;
  /** Pre-adjusted slash input (orchestrate plan injection); defaults to `text`. */
  slashInput?: string;
  titleSeed?: string;
  deferTitleUntilTurnEnd?: boolean;
  ownsGlobalStreaming?: boolean;
  /** Report status errors (defaults to setStatus). */
  reportStatus?: (level: 'ok' | 'err', message: string) => void;
}

// ── Programmatic ─────────────────────────────────────────────────────────────

export async function sendProgrammaticChatText(
  chat: Chat,
  text: string,
  options: SendProgrammaticChatTextOptions = {},
): Promise<void> {
  if (isChatStreaming(chat.id)) return;
  if (isChatTurnSetupPending(chat.id)) return;

  const report = options.reportStatus ?? setStatus;
  const rawText = text;
  const slashInput = options.slashInput ?? rawText;
  const validAttachments = options.validAttachments ?? [];
  const parseSlash = options.parseSlash !== false;

  const { skillId: slashSkillId, userText: slashUserText } = parseSlash
    ? parseSlashCommand(slashInput)
    : { skillId: null, userText: slashInput.trim() };

  const turnSkill = resolveTurnSkill({
    slashSkillId,
    userText: slashUserText,
    pinned: chat.pinnedSkill,
    isSkillEnabled,
  });
  chat.pinnedSkill = turnSkill.nextPinned;
  const skillId = turnSkill.skillId;
  const userText = normalizeCavemanUserText(skillId, slashSkillId, slashUserText);
  const hasUserText = Boolean(userText.trim());

  if (!rawText.trim() && validAttachments.length === 0 && !slashInput.trim()) return;
  if (!skillId && !hasUserText && validAttachments.length === 0) return;

  if (chat.modelId?.trim()) {
    syncPerChatModelBindingFromCatalog(chat);
    touchChat(chat);
  } else {
    const binding = resolveEffectiveChatModelBinding(chat);
    if (binding.selectValue) {
      applyModelSelectValueToChat(chat, binding.selectValue);
      touchChat(chat);
    } else if (binding.modelId) {
      chat.modelId = binding.modelId;
      if (binding.providerId) {
        chat.providerId = binding.providerId;
      }
      touchChat(chat);
    }
  }
  if (!chat.modelId?.trim()) {
    report('err', 'Select a model first');
    return;
  }

  await detectLocalServer();

  let skillBody: string | null = null;
  if (skillId) {
    const skill = await resolveActiveSkill(skillId);
    if (!skill?.body?.trim()) {
      report('err', `Unknown skill: ${skillId}`);
      return;
    }
    skillBody = skill.body;
    if (shouldComposeImpeccableBody(skillId, userText)) {
      skillBody = await composeImpeccableSkillBody(skillBody, userText);
    }
    if (skillId === CAVEMAN_SKILL_ID) {
      skillBody = augmentCavemanSkillBody(skillBody, {
        userText,
        pinnedIntensity: chat.pinnedSkill?.intensity,
      });
    }
    if (skillId === PARTYMODE_SKILL_ID) {
      skillBody = augmentPartyModeSkillBody(skillBody);
    }
  }

  const uiDesignerCtx = prepareUiDesignerTurn(chat, {
    skillId,
    userText,
    workAgentId: chat.workAgentId,
  });
  const savedWorkAgentId = chat.workAgentId;
  if (uiDesignerCtx.active) {
    chat.workAgentId = UI_DESIGNER_AGENT_ID;
  }
  if (skillBody && uiDesignerCtx.active) {
    skillBody = augmentSkillBodyForUiDesigner(skillBody, uiDesignerCtx);
  }

  if (!hasUserText && validAttachments.length === 0 && !skillBody?.trim()) {
    report('err', 'Add a message or attachment');
    if (uiDesignerCtx.active) {
      chat.workAgentId = savedWorkAgentId;
    }
    return;
  }

  const displayText = skillId
    ? formatHistoryWithSkillTag(userText, skillId)
    : userText || rawText;
  const historyContent = buildHistoryUserContent(displayText, validAttachments);
  const titleSeed =
    options.titleSeed ??
    (userText || rawText || validAttachments[0]?.name || 'Attachment');
  const deferTitleUntilTurnEnd =
    options.deferTitleUntilTurnEnd ?? isFirstUserMessagePending(chat);
  const firstUserSend = deferTitleUntilTurnEnd;

  syncComposerPinnedSkillFromActiveChat();
  scheduleSaveSessions();
  syncGoalActiveHint();
  syncLoopActiveHint();
  syncTodoPanel();

  await runChatTurn({
    chat,
    pushUser: true,
    suppressUserEcho: options.suppressUserEcho ?? false,
    rawText,
    userText,
    skillId,
    displayText,
    historyContent,
    validAttachments,
    titleSeed,
    deferTitleUntilTurnEnd,
    firstUserSend,
    skillBody,
    composerSurface: options.composerSurface,
    goalDriven: options.goalDriven ?? false,
    ephemeralContext: options.ephemeralContext,
    ownsGlobalStreaming:
      options.ownsGlobalStreaming ?? chat.id === getActiveChat().id,
  });
}

// ── Tools ────────────────────────────────────────────────────────────────────

export async function sendMessageWithTools(
  composer?: ComposerSendOptions,
): Promise<void> {
  const { inputEl: input } = resolveComposerSurface(composer);
  if (!input) {
    setStatus('err', 'Composer is not available');
    return;
  }
  const rawTextEarly = input.value.trim();
  if (isActiveChatStreaming()) {
    if (!rawTextEarly) return;
    const pendingSteer = getPendingAttachments();
    const pendingOk = pendingSteer.filter((a) => a.kind !== 'error');
    if (pendingOk.length > 0) {
      setStatus('err', 'Follow-ups are text only — wait for this turn to finish for attachments');
      return;
    }
    const chat = getActiveChat();
    if (enqueueComposerMessage(chat, rawTextEarly)) {
      clearComposerAfterSend(chat, input);
      setStatus('ok', 'Follow-up queued');
      refreshComposerStreamingAffordance();
      syncComposerMessageQueue();
    }
    return;
  }
  if (isChatTurnSetupPending(getActiveChat().id)) return;
  if (isBackgroundStreamBlockingSend()) {
    setStatus('spin', 'Stop or wait for the reply in the other chat first');
    return;
  }
  const rawText = input.value.trim();
  const { consumePendingMessageEdit, completePendingMessageEdit } = await import(
    '../ui/message-actions'
  );
  const pendingEdit = consumePendingMessageEdit();
  if (pendingEdit) {
    const editChat =
      sessionState?.chats.find((c) => c.id === pendingEdit.chatId) ?? getActiveChat();
    clearComposerAfterSend(editChat, input);
    await completePendingMessageEdit(
      pendingEdit.chatId,
      pendingEdit.historyIndex,
      rawText,
    );
    return;
  }
  const pending = getPendingAttachments();
  const pendingWithoutErrors = pending.filter((a) => a.kind !== 'error');
  const chat = getActiveChat();

  const loopDispatch = handleLoopCommand(chat, rawText, setStatus);
  if (loopDispatch === 'handled') {
    clearComposerAfterSend(chat, input);
    return;
  }

  const goalDispatch = handleGoalCommand(chat, rawText, setStatus);
  if (goalDispatch === 'handled') {
    clearComposerAfterSend(chat, input);
    return;
  }

  const sendProviderId =
    chat.providerId?.trim() ||
    (document.getElementById('providerSelect') as HTMLSelectElement | null)?.value?.trim() ||
    '';
  const sendModelId =
    chat.modelId?.trim() ||
    (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value?.trim() ||
    '';

  const compressDispatch = await handleCompressCommand(
    chat,
    rawText,
    sendProviderId,
    sendModelId,
  );
  if (compressDispatch === 'handled') {
    clearComposerAfterSend(chat, input);
    return;
  }

  let goalDriven = isGoalLoopActive(chat);
  let effectiveRawText = rawText;
  if (goalDispatch === 'set') {
    goalDriven = true;
    effectiveRawText = getActiveGoal(chat)?.conditionText ?? rawText;
    clearComposerAfterSend(chat, input);
  }

  const slashInput = effectiveRawText;
  const pickerSkillId = goalDriven ? null : getPickerAppliedSkillId(input);

  const tempEl = document.getElementById('temperature') as HTMLInputElement | null;
  const maxTokEl = document.getElementById('maxTokens') as HTMLInputElement | null;
  if (tempEl && maxTokEl) {
    const temp = parseFloat(tempEl.value);
    const maxTok = parseInt(maxTokEl.value, 10);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
      setStatus('err', 'Temperature must be 0 to 2');
      return;
    }
    if (!Number.isFinite(maxTok) || maxTok < 1) {
      setStatus('err', 'Max tokens must be at least 1');
      return;
    }
  }

  const peekSlash = pickerSkillId
    ? parseSlashCommand(slashInput)
    : { skillId: null as string | null, userText: slashInput.trim() };
  const peekTurn = resolveTurnSkill({
    slashSkillId: peekSlash.skillId,
    userText: peekSlash.userText,
    pinned: chat.pinnedSkill,
    isSkillEnabled,
  });
  const peekSkillId = peekTurn.skillId;
  const peekUserText = normalizeCavemanUserText(
    peekSkillId,
    peekSlash.skillId,
    peekSlash.userText,
  );
  const hasUserText = Boolean(peekUserText.trim());
  if (!effectiveRawText && pendingWithoutErrors.length === 0 && !slashInput.trim()) return;
  if (!peekSkillId && !hasUserText && pendingWithoutErrors.length === 0) return;

  const resolvedAttachments = await resolveWorkspaceReferences(pending);
  const validAttachments = resolvedAttachments.filter((a) => a.kind !== 'error');
  if (validAttachments.length === 0 && !hasUserText && pendingWithoutErrors.length > 0) {
    replacePendingAttachments(resolvedAttachments);
    setStatus('err', 'Could not read attached workspace file(s)');
    return;
  }
  replacePendingAttachments(resolvedAttachments);

  if (attachmentsHaveImages(validAttachments) && !canSendImagesToModel(sendModelId)) {
    setStatus('err', 'This model cannot read images — sending the text only');
  }

  if (!goalDispatch) {
    clearComposerAfterSend(chat, input);
  }

  await sendProgrammaticChatText(chat, effectiveRawText, {
    goalDriven,
    validAttachments,
    composerSurface: composer,
    parseSlash: Boolean(pickerSkillId),
    slashInput,
    ephemeralContext: composer?.ephemeralContext,
    ownsGlobalStreaming: true,
  });
}

// ── Send ─────────────────────────────────────────────────────────────────────

/** Send with optional composer surface override (defaults to foreground app). */
export async function sendMessage(
  composer?: ComposerSendOptions,
): Promise<void> {
  return sendMessageWithTools(composer);
}
