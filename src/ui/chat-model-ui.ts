import { persistDefaultModelValue } from '../models/selection';
import { showToast } from './toast';
import { applyModelSelectValueToChat } from '../lib/model-select-key';
import { isChatStreaming } from '../chat/streaming-state';
import { sendRemoteChatCommand, shouldRelayChat } from '../chat/remote-chat-client';
import { stopGeneration } from '../chat/stop-generation';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { configureManagedChatModel, managedModelReadOnlyReason } from './managed-chat-model';
import { scheduleCapabilityProbeForSelectValue } from '../providers/first-load-probe';
import {
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { syncComposerModelTriggers } from './composer-model-trigger';
import { syncComposerReasoningEffortFromActiveChat } from './composer-reasoning-effort';
import { syncAgentCliView } from './agent-cli-view';
import {
  applyModelReasoningDefaultToChat,
  resolveEffectiveChatModelBinding,
} from './default-model';

/** Refresh composer model UI from the saved chat binding. */
export function syncActiveChatModelUi(): void {
  syncAgentCliView();
  syncComposerModelTriggers();
  syncComposerReasoningEffortFromActiveChat();
  void import('./context-usage-ring').then((m) => m.refreshContextUsageRing());
}

/** Bind the chat and remember an explicit composer selection for future chats. */
export function onActiveChatModelChange(selectValue: string, chat = getActiveChat()): void {
  const readOnly = managedModelReadOnlyReason(chat);
  if (readOnly) { showToast(readOnly); return; }
  const raw = selectValue.trim();
  if (!raw) return;
  if (chat.chatCommandVersion === 1) {
    const selected = decodeModelSelectKey(raw);
    if (!selected) { showToast('Select a model with its provider.', 'error'); return; }
    if (selected.providerId === chat.providerId && selected.modelId === chat.modelId) return;
    void configureManagedChatModel(chat, { ...selected, options: {} })
      .catch(error => showToast(String(error?.message || error), 'error')).finally(syncActiveChatModelUi);
    syncActiveChatModelUi();
    return;
  }
  if (shouldRelayChat(chat.id)) {
    void sendRemoteChatCommand(chat.id, 'configure', { patch: { modelSelectValue: raw } })
      .catch(error => showToast(String(error?.message || error), 'error'));
    return;
  }

  if (isChatStreaming(chat.id)) {
    stopGeneration(chat.id, 'user');
    showToast('Stopped — model changed');
  }

  applyModelSelectValueToChat(chat, raw);
  void persistDefaultModelValue(raw).catch((error) => showToast(`${error.message}. Select the model again to retry.`, 'error'));
  applyModelReasoningDefaultToChat(chat, raw);
  syncAgentCliView();
  touchChat(chat);
  scheduleSaveSessions();
  scheduleCapabilityProbeForSelectValue(raw);
  syncComposerModelTriggers();
  syncComposerReasoningEffortFromActiveChat();
  void import('./context-usage-ring').then((m) => m.refreshContextUsageRing());
}

/** Reapply a changed picker default when the active chat targets that model. */
export function refreshActiveChatReasoningDefault(selectValue: string): void {
  const chat = getActiveChat();
  if (chat.chatCommandVersion === 1) return;
  const binding = resolveEffectiveChatModelBinding(chat);
  if (binding.selectValue !== selectValue.trim()) return;
  applyModelReasoningDefaultToChat(chat, selectValue);
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerReasoningEffortFromActiveChat();
}
