import { applyModelSelectValueToChat } from '../lib/model-select-key';
import { isChatStreaming } from '../chat/streaming-state';
import { stopGeneration } from '../chat/stop-generation';
import { scheduleCapabilityProbeForSelectValue } from '../providers/first-load-probe';
import {
  getActiveChat,
  scheduleSaveSessions,
  touchChat,
} from '../state/sessions';
import { syncComposerModelTriggers } from './composer-model-trigger';
import { syncComposerReasoningEffortFromActiveChat } from './composer-reasoning-effort';
import { setStatus } from './status';
import { syncAgentCliView } from './agent-cli-view';
import {
  applyModelReasoningDefaultToChat,
  resolveEffectiveChatModelBinding,
} from './default-model';

/** Refresh composer model UI from the active chat (default #modelSelect stays put). */
export function syncActiveChatModelUi(): void {
  syncAgentCliView();
  syncComposerModelTriggers();
  syncComposerReasoningEffortFromActiveChat();
  void import('./context-usage-ring').then((m) => m.refreshContextUsageRing());
}

/** Per-chat model changed via composer picker — does not alter the global default. */
export function onActiveChatModelChange(selectValue: string): void {
  const chat = getActiveChat();
  const raw = selectValue.trim();
  if (!raw) return;

  if (isChatStreaming(chat.id)) {
    stopGeneration(chat.id, 'user');
    setStatus('ok', 'Stopped — model changed');
  }

  applyModelSelectValueToChat(chat, raw);
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
  const binding = resolveEffectiveChatModelBinding(chat);
  if (binding.selectValue !== selectValue.trim()) return;
  applyModelReasoningDefaultToChat(chat, selectValue);
  touchChat(chat);
  scheduleSaveSessions();
  syncComposerReasoningEffortFromActiveChat();
}
