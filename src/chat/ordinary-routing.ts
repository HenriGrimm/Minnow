import type { Chat } from '../types';
import type { OrdinaryChatExecutionFeature } from '../../server/chats/contracts';
import { ordinaryChatScopeBlocker, ordinaryChatHistoryBlocker } from '../../server/chats/ordinary-routing.js';
import { loadOrdinaryChatExecutionCapability } from '../config/agent-conversations-enabled';
import { isServerStorageMode } from '../config/storage-mode';
import { isPairedDevice } from '../api/session-token';
import { applySharedChatFrame, findChatById, getDurablySavedChatRevision, persistSessionsBeforeDeliveryAck, touchChat } from '../state/sessions';
import { isChatTurnInProgress } from './chat-turn-guard';
import { isChatWorktreeSetupPending } from '../state/chat-worktree';
import { randomUUID } from '../lib/random-id';
import { readDefaultModelBinding, resolveEffectiveChatModelBinding } from '../models/selection';
import { applyModelSelectValueToChat, encodeModelSelectKey } from '../lib/model-select-key';

export function ordinaryChatEligibility(chat: Chat, capability: OrdinaryChatExecutionFeature | null, options: {
  serverStorage: boolean; pairedDevice: boolean; busy: boolean;
}): { route: 'server' | 'legacy'; eligible: boolean; reason: string } {
  // A release rollback never downgrades an existing canonical transcript writer.
  if (chat.chatCommandVersion === 1) return { route: 'server', eligible: true, reason: 'already_canonical' };
  const reason = !options.serverStorage ? 'storage_unsupported' : options.pairedDevice ? 'observer_only'
    : options.busy ? 'legacy_owner_active' : chat.historyLoaded === false ? 'history_not_loaded'
    : ordinaryChatScopeBlocker(chat) ?? ordinaryChatHistoryBlocker(chat.history)
    ?? (!capability?.admissionEnabled || chat.history.length > 0 && !capability.promotionEnabled ? capability?.reason ?? 'capability_unavailable' : null);
  return { route: 'legacy', eligible: !reason, reason: reason ?? (chat.history.length ? 'idle_root' : 'new_root') };
}

interface Promotion { id: string; revision: number }
const running = new Map<string, Promise<'server' | 'legacy'>>();
const uncertain = new Map<string, Promotion>();
const keyFor = (chatId: string) => `minnow.ordinaryPromotion.${chatId}`;
function retained(chatId: string): Promotion | undefined {
  let value = uncertain.get(chatId);
  if (!value) { try { value = JSON.parse(sessionStorage.getItem(keyFor(chatId)) || 'null') ?? undefined; } catch {} }
  return value && /^[A-Za-z0-9_-]{1,160}$/.test(value.id) && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value : undefined;
}

/** Called before send dispatch, never from an observer stream or workspace polling. */
export function ensureOrdinaryChatRoute(chat: Chat): Promise<'server' | 'legacy'> {
  const pending = running.get(chat.id);
  if (pending) return pending;
  const work = route(chat);
  running.set(chat.id, work);
  void work.finally(() => { if (running.get(chat.id) === work) running.delete(chat.id); }).catch(() => {});
  return work;
}

async function route(chat: Chat): Promise<'server' | 'legacy'> {
  let promotion = retained(chat.id);
  if (chat.chatCommandVersion === 1 && !promotion) return 'server';
  if (!promotion) {
    const capability = isServerStorageMode() ? await loadOrdinaryChatExecutionCapability() : null;
    const eligible = ordinaryChatEligibility(chat, capability, { serverStorage: isServerStorageMode(), pairedDevice: isPairedDevice(),
      busy: isChatTurnInProgress(chat.id) || isChatWorktreeSetupPending(chat.id) });
    if (eligible.route === 'server' || !eligible.eligible) return eligible.route;
    if (findChatById(chat.id) !== chat) throw new Error('The conversation changed while checking server routing. Open its current view before sending.');
    // New roots can inherit a bare model id. Resolve its existing catalog/default
    // binding before the server captures an immutable provider/model selection.
    const binding = resolveEffectiveChatModelBinding(chat);
    const remembered = !binding.providerId && !chat.history.length ? readDefaultModelBinding() : null;
    const value = remembered?.providerId && remembered.modelId === binding.modelId
      ? encodeModelSelectKey(remembered.providerId, remembered.modelId) : binding.selectValue;
    if (value) applyModelSelectValueToChat(chat, value);
    // Save the complete legacy tail before pinning its revision; no renderer lease is stolen.
    touchChat(chat);
    if (!await persistSessionsBeforeDeliveryAck(chat.id)) throw new Error('Could not save the conversation before server routing. Your draft is kept.');
    if (findChatById(chat.id) !== chat) throw new Error('The conversation changed while preparing server routing. Retry from its current view.');
    if (chat.chatCommandVersion === 1) return 'server';
    if (isChatTurnInProgress(chat.id)) throw new Error('The conversation started in another view. Wait for it to finish before server routing.');
    const revision = getDurablySavedChatRevision(chat.id);
    if (revision === null) throw new Error('The saved conversation revision is unavailable. Your draft is kept.');
    promotion = { id: randomUUID(), revision };
    uncertain.set(chat.id, promotion);
    try { sessionStorage.setItem(keyFor(chat.id), JSON.stringify(promotion)); } catch {}
  }
  // Once dispatched, transport failure is uncertain admission, never permission to run locally.
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/ordinary-routing`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' },
        body: JSON.stringify({ expectedRevision: promotion.revision, clientRequestId: promotion.id }), signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) { if (attempt) throw error; }
  }
  const body = await response!.json();
  const clear = () => { uncertain.delete(chat.id); try { sessionStorage.removeItem(keyFor(chat.id)); } catch {} };
  if (!response!.ok) {
    if (response!.status < 500) clear();
    throw new Error(body?.error?.message || 'The server could not confirm conversation routing. Your draft is kept.');
  }
  if (body.receipt?.chatId !== chat.id || !['promoted', 'already_canonical'].includes(body.receipt?.disposition) ||
      !Number.isSafeInteger(body.receipt?.revision) || body.receipt.revision < 0 || body.frame?.chatId !== chat.id || body.frame?.fields?.chatCommandVersion !== 1) {
    throw new Error('The server routing receipt is incomplete. Retry to recover its original receipt; your draft is kept.');
  }
  // Only the server's durable ownership marker is required to select the command path.
  // The normal bridge hydrates history; do not overwrite a multi-window draft here.
  const current = findChatById(chat.id);
  if (current && !applySharedChatFrame(chat.id, { chatCommandVersion: 1, ...(body.frame.fields.profileReference ? { profileReference: body.frame.fields.profileReference } : {}) })) {
    throw new Error('Canonical ownership was confirmed while this view was busy. Reopen the saved conversation before sending.');
  }
  if (current !== chat) throw new Error('The saved conversation was replaced during routing. Open its current view before sending.');
  clear();
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-change', { detail: { chatId: chat.id, ...body } }));
  return 'server';
}

export function resetOrdinaryChatRoutingForTests(): void { running.clear(); uncertain.clear(); }
