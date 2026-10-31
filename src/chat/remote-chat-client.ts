import { isPairedDevice } from '../api/session-token';
import { randomUUID } from '../lib/random-id';
import { getViewId } from '../state/view-workspace';
import { isChatRunningRemotely } from './remote-turn-state';
import type { Attachment } from '../attachments/types';
import { findChatById } from '../state/sessions';

export type RemoteChatAction = 'send' | 'steer' | 'stop' | 'push' | 'remove' | 'edit' | 'cancel-steer' | 'configure';
export interface RemoteChatCommand {
  id: string;
  chatId: string;
  action: RemoteChatAction;
  text?: string;
  itemId?: string;
  attachments?: Attachment[];
  patch?: { modelSelectValue?: string; modelSelection?: import('../../server/chats/contracts').ModelSelection; modeId?: string; name?: string; pinned?: boolean };
  /** Managed Stop pins the displayed execution before capturing its descendants. */
  executionId?: string;
  scope?: 'turn' | 'tree';
  deliveryId?: string;
  /** Legacy Stop is pinned to the renderer that owned the interrupted turn. */
  expectedOwnerId?: string;
}

let hostId = '';
export function getChatHostId(): string {
  if (hostId) return hostId;
  hostId = getViewId();
  try { hostId ||= sessionStorage.getItem('minnow.chatHostId') || ''; } catch {}
  hostId ||= randomUUID();
  try { sessionStorage.setItem('minnow.chatHostId', hostId); } catch {}
  return hostId;
}

export function shouldRelayChat(chatId: string): boolean {
  return findChatById(chatId)?.chatCommandVersion === 1 || isPairedDevice() || isChatRunningRemotely(chatId);
}

const results = new Map<string, { ok?: boolean; error?: string }>();
const pendingInputs = new Map<string, { signature: string; command: RemoteChatCommand }>();
export function receiveRemoteCommandResult(id: string, result: { ok?: boolean; error?: string }): void {
  results.set(id, result);
  if (results.size > 256) results.delete(results.keys().next().value!);
}

/** Retry with the same command id; the computer acknowledges admission once. */
export async function sendRemoteChatCommand(
  chatId: string, action: RemoteChatAction, data: Partial<RemoteChatCommand> = {},
): Promise<void> {
  if (findChatById(chatId)?.chatCommandVersion === 1) {
    const { sendManagedChatAction } = await import('./managed-chat-client');
    await sendManagedChatAction(chatId, action, data);
    return;
  }
  const inputKey = `${chatId}:${action}:${Object.keys(data.patch ?? {}).sort().join(',')}`;
  const storageKey = `minnow.chatCommand.${inputKey}`;
  const signature = JSON.stringify({ ...data, id: undefined, chatId, action,
    attachments: data.attachments?.map(({ id, name, size, kind }) => ({ id, name, size, kind })) });
  const pending = pendingInputs.get(inputKey);
  let remembered: { signature?: string; id?: string } = {};
  try { remembered = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch {}
  const command: RemoteChatCommand = pending?.signature === signature ? pending.command
    : { ...data, id: data.id ?? (remembered.signature === signature ? remembered.id : undefined) ?? randomUUID(), chatId, action };
  pendingInputs.set(inputKey, { signature, command });
  try { sessionStorage.setItem(storageKey, JSON.stringify({ signature, id: command.id })); } catch {}
  const clear = () => {
    if (pendingInputs.get(inputKey)?.command.id === command.id) pendingInputs.delete(inputKey);
    try {
      if (JSON.parse(sessionStorage.getItem(storageKey) || '{}').id === command.id) sessionStorage.removeItem(storageKey);
    } catch {}
  };
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch('/api/chat-sync/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command), signal: AbortSignal.timeout(8_000) });
      break;
    } catch (error) { if (attempt) throw error; }
  }
  const accepted = await response!.json() as { id?: string; error?: string; ok?: boolean; pending?: boolean };
  if (!response!.ok || !accepted.id) {
    clear();
    throw new Error(accepted.error || 'Could not reach Minnow on the computer.');
  }
  const deadline = Date.now() + 20_000;
  let result = accepted;
  while (result.pending && Date.now() < deadline) {
    const pushed = results.get(accepted.id);
    if (pushed) { result = { ...pushed, pending: false }; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
    const status = await fetch(`/api/chat-sync/result?id=${encodeURIComponent(accepted.id)}`, {
      cache: 'no-store', signal: AbortSignal.timeout(5_000),
    });
    if (!status.ok) throw new Error('The computer could not confirm this message. Your draft is kept.');
    result = await status.json();
  }
  results.delete(accepted.id);
  if (!result.pending) clear();
  if (result.pending || result.ok !== true) throw new Error(result.error || 'The computer has not accepted this message yet. Your draft is kept.');
}
