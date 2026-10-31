import type { Chat } from '../types';
import type { ModelSelection } from '../../server/chats/contracts';
import { validateModelSelection } from '../../server/chats/contracts.js';
import { chatReadOnlyReason } from '../state/chat-relationships';
import { findChatById } from '../state/sessions';
import { sendManagedChatAction } from '../chat/managed-chat-client';
import { subscribeManagedChatMetadata } from '../chat/managed-chat-view';
import '../styles/agent-model-controls.css';

interface ModelControlState { busy: boolean; stopping?: boolean; stoppedExecutionId?: string; error?: string; wanted?: ModelSelection }
const states = new Map<string, ModelControlState>();
const terminal = new Set(['completed', 'failed', 'stopped', 'recovery_required', 'stopping']);
const same = (left?: ModelSelection, right?: ModelSelection) => left?.providerId === right?.providerId && left?.modelId === right?.modelId &&
  JSON.stringify(left?.options ?? {}) === JSON.stringify(right?.options ?? {});

export function managedModelReadOnlyReason(chat: Chat): string | null {
  return chatReadOnlyReason(chat) ?? (chat.agentConversation?.capabilities?.canChooseModel === false ? 'This agent conversation does not permit model changes.' : null);
}
export function isManagedModelBusy(chatId: string): boolean { return states.get(chatId)?.busy === true; }
function retainState(chatId: string, state: ModelControlState): void {
  states.set(chatId, state);
  while (states.size > 128) {
    const candidate = [...states].find(([id, value]) => id !== chatId && !value.busy);
    if (!candidate) break;
    states.delete(candidate[0]);
  }
}
export function managedChatModelSelection(chat: Chat): ModelSelection {
  const parsed = validateModelSelection(chat.agentModelSelection);
  return parsed.ok ? parsed.value : { providerId: chat.providerId ?? '', modelId: chat.modelId,
    options: { ...(chat.reasoningEffort ? { reasoningEffort: chat.reasoningEffort } : {}), ...(chat.thinkingMode ? { thinkingMode: chat.thinkingMode } : {}) } };
}
export function formatManagedModelSelection(selection: ModelSelection): string {
  const options = selection.options ?? {};
  return [selection.modelId, options.reasoningEffort ? `${options.reasoningEffort} effort` : options.thinkingMode && options.thinkingMode !== 'inherit' ? `thinking ${options.thinkingMode}` : '',
    Object.hasOwn(options, 'thinkingBudgetTokens') ? options.thinkingBudgetTokens == null ? 'no token budget' : `${options.thinkingBudgetTokens} token budget` : ''].filter(Boolean).join(' · ');
}
export function managedReasoningSelection(chat: Chat, value: string, effortLevels: boolean): ModelSelection {
  const selected = managedChatModelSelection(chat), options = { ...selected.options };
  delete options.reasoningEffort; delete options.thinkingMode;
  if (value !== 'inherit') {
    if (effortLevels) options.reasoningEffort = value;
    else options.thinkingMode = value === 'off' ? 'off' : 'on';
    if (value === 'off' || options.thinkingBudgetTokens === 0) delete options.thinkingBudgetTokens;
  }
  return { ...selected, options };
}
function changed(chat: Chat): void {
  syncAgentModelControls(chat);
  window.dispatchEvent(new window.CustomEvent('minnow:managed-model-state', { detail: { chatId: chat.id } }));
}

/** Persist one exact next-message selection. Current and queued turns keep their snapshots. */
export async function configureManagedChatModel(chat: Chat, selection: ModelSelection): Promise<void> {
  const unavailable = managedModelReadOnlyReason(chat);
  if (chat.chatCommandVersion !== 1 || unavailable) throw new Error(unavailable ?? 'This conversation uses its existing model controls.');
  const parsed = validateModelSelection({ ...selection, options: selection.options ?? {} });
  if (!parsed.ok) throw new Error(parsed.error.message);
  if (isManagedModelBusy(chat.id)) throw new Error('Wait for the current model change to finish.');
  if (same(managedChatModelSelection(chat), parsed.value)) return;
  const state = { busy: true, wanted: parsed.value, stoppedExecutionId: states.get(chat.id)?.stoppedExecutionId, error: undefined as string | undefined };
  retainState(chat.id, state); changed(chat);
  try { await sendManagedChatAction(chat.id, 'configure', { patch: { modelSelection: parsed.value } }); }
  catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { state.busy = false; changed(findChatById(chat.id) ?? chat); }
}

/** An explicit human action, pinned to the execution visible when clicked. */
export async function stopAndSwitchManagedChat(chat: Chat): Promise<void> {
  const unavailable = managedModelReadOnlyReason(chat);
  if (unavailable || chat.chatCommandVersion !== 1) throw new Error(unavailable ?? 'This conversation is unavailable.');
  if (chat.agentConversation?.capabilities?.canStop === false) throw new Error('This agent conversation does not permit stopping its work.');
  const execution = chat.agentExecution;
  if (!execution || terminal.has(execution.status)) return;
  if (states.get(chat.id)?.stoppedExecutionId === execution.executionId) return;
  if (isManagedModelBusy(chat.id)) throw new Error('Wait for the current model change to finish.');
  const state: ModelControlState = { busy: true, stopping: true };
  retainState(chat.id, state); changed(chat);
  try {
    await sendManagedChatAction(chat.id, 'stop', { executionId: execution.executionId, scope: 'tree' });
    state.stoppedExecutionId = execution.executionId;
  }
  catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { state.busy = false; changed(findChatById(chat.id) ?? chat); }
}

/** A flat status/action row beside the existing child header; model picking stays in the composer. */
export function syncAgentModelControls(chat: Chat, host?: HTMLElement): void {
  const hosts = host ? [host] : [...document.querySelectorAll<HTMLElement>('[data-agent-chat-controls]')].filter(node => node.dataset.agentChatControls === chat.id);
  for (const root of hosts) {
    if (!chat.agentConversation || chat.chatCommandVersion !== 1) { root.replaceChildren(); continue; }
    const state = states.get(chat.id), selection = managedChatModelSelection(chat), unavailable = managedModelReadOnlyReason(chat);
    const execution = chat.agentExecution;
    const renderKey = JSON.stringify([chat.id, selection, unavailable, chat.agentConversation.capabilities?.canStop, state?.busy, state?.stopping, state?.stoppedExecutionId, state?.error,
      execution?.executionId, execution?.status, execution?.modelSelection]);
    if (root.dataset.modelControlsKey === renderKey) continue;
    root.dataset.modelControlsKey = renderKey;
    const hadFocus = root.contains(document.activeElement);
    const focusedAction = (document.activeElement as HTMLElement | null)?.dataset.agentModelAction;
    root.classList.add('agent-model-controls'); root.replaceChildren();
    const label = document.createElement('span'); label.className = 'agent-model-controls__selection';
    label.textContent = state?.busy ? state.stopping ? 'Stopping current reply…' : 'Saving model controls…' : `${unavailable ? 'Saved model' : 'New messages'}: ${formatManagedModelSelection(selection)}`;
    label.title = `${selection.providerId} / ${formatManagedModelSelection(selection)}`;
    label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite'); root.append(label);
    if (!unavailable && chat.agentConversation?.capabilities?.canStop !== false && execution && !terminal.has(execution.status) && state?.stoppedExecutionId !== execution.executionId && execution.modelSelection && !same(execution.modelSelection, selection)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-model-controls__stop';
      button.textContent = 'Stop and switch'; button.disabled = state?.busy === true;
      button.dataset.agentModelAction = 'stop';
      button.title = 'Stop this chat and its sub-agents. Queued messages keep their saved model.';
      button.addEventListener('click', () => { void stopAndSwitchManagedChat(chat).catch(() => {}); }); root.append(button);
    }
    if (state?.error || unavailable) {
      const error = document.createElement('span'); error.className = state?.error ? 'agent-model-controls__error' : 'agent-model-controls__note';
      error.textContent = state?.error ?? unavailable; error.setAttribute('role', state?.error ? 'alert' : 'note'); root.append(error);
    }
    if (hadFocus) {
      const replacement = focusedAction ? root.querySelector<HTMLElement>(`[data-agent-model-action="${focusedAction}"]`) : null;
      if (replacement && !(replacement as HTMLButtonElement).disabled) replacement.focus({ preventScroll: true });
      else { label.tabIndex = -1; label.focus({ preventScroll: true }); }
    }
  }
}

subscribeManagedChatMetadata(chatId => {
  const chat = findChatById(chatId); if (!chat) { states.delete(chatId); return; }
  const state = states.get(chatId);
  if (state?.error && state.wanted && same(state.wanted, managedChatModelSelection(chat))) state.error = undefined;
  syncAgentModelControls(chat);
});
