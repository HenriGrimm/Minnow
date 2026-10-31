import { buildHistoryUserContent, persistableUserImages } from './build-api-messages';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { randomUUID } from '../lib/random-id';
import { findChatById } from '../state/sessions';
import type { RemoteChatAction, RemoteChatCommand } from './remote-chat-client';
import { attachmentImageDataUrl } from '../attachments/attachment-image';
import { chatReadOnlyReason } from '../state/chat-relationships';
import { validateChatRequest, type ChatRequest } from '../../server/chats/contracts';

const pending = new Map<string, { fingerprint: string; id: string }>();
const pendingDeletes = new Map<string, string>();
const pendingAnswers = new Map<string, { fingerprint: string; id: string }>();
const CHAT_WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' };

export interface ManagedChatRequestPage { requests: ChatRequest[]; pendingCount: number; nextCursor: string | null; truncated: boolean; }
export async function readManagedChatRequestPage(chatId: string, options: { cursor?: string; signal?: AbortSignal } = {}): Promise<ManagedChatRequestPage> {
  const query = new URLSearchParams({ limit: '32', ...(options.cursor ? { pending_cursor: options.cursor } : {}) });
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/requests?${query}`, { cache: 'no-store', signal: options.signal });
  const body = await response.json();
  if (!response.ok) throw new Error(errorMessage(body));
  if (!Array.isArray(body.requests) || body.requests.length > 40 || !Number.isSafeInteger(body.pendingCount) || body.pendingCount < 0 ||
      (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.nextCursor))) || typeof body.truncated !== 'boolean') throw new Error('This conversation returned an invalid request page.');
  const requests = body.requests.map((value: unknown) => {
    const parsed = validateChatRequest(value);
    if (!parsed.ok || parsed.value.chatId !== chatId) throw new Error('A request does not belong to this conversation.');
    return parsed.value;
  });
  return { requests, pendingCount: body.pendingCount, nextCursor: body.nextCursor, truncated: body.truncated };
}

/** Retry the same human answer identity after a lost acknowledgement. */
export async function respondManagedChatRequest(chatId: string, requestId: string, answer: unknown): Promise<ChatRequest> {
  const storageKey = `minnow.requestAnswer.${chatId}.${requestId}`;
  const digest = await fingerprint(answer);
  let prior = pendingAnswers.get(storageKey);
  if (!prior) { try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null') ?? undefined; } catch {} }
  const id = prior?.fingerprint === digest && /^[A-Za-z0-9_-]{1,160}$/.test(prior.id) ? prior.id : randomUUID();
  const retained = { fingerprint: digest, id }; pendingAnswers.set(storageKey, retained);
  if (pendingAnswers.size > 256) pendingAnswers.delete(pendingAnswers.keys().next().value!);
  try { sessionStorage.setItem(storageKey, JSON.stringify(retained)); } catch {}
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(requestId)}/respond`, {
        method: 'POST', headers: CHAT_WRITE_HEADERS, body: JSON.stringify({ clientRequestId: id, answer }), signal: AbortSignal.timeout(10_000),
      }); break;
    } catch (error) { if (attempt) throw error; }
  }
  const body = await response!.json();
  if (!response!.ok) throw new Error(errorMessage(body));
  const parsed = validateChatRequest(body.request);
  if (!parsed.ok || parsed.value.requestId !== requestId || parsed.value.chatId !== chatId || parsed.value.state !== 'answered') throw new Error('The answer did not return its saved receipt.');
  pendingAnswers.delete(storageKey); try { sessionStorage.removeItem(storageKey); } catch {}
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-change', { detail: { chatId, ...body } }));
  return parsed.value;
}
export interface ConversationDeleteReceipt {
  chatId: string; clientRequestId: string; disposition: 'deleted'; revision: number; retainedWorktree: boolean;
  replacementChat?: import('../types').Chat;
}

/** Keep a lost deletion acknowledgement retryable without unlinking local state. */
export async function deleteManagedConversation(chatId: string): Promise<ConversationDeleteReceipt> {
  const storageKey = `minnow.deleteConversation.${chatId}`;
  let clientRequestId = pendingDeletes.get(chatId);
  if (!clientRequestId) { try { clientRequestId = sessionStorage.getItem(storageKey) || undefined; } catch {} }
  if (clientRequestId && !/^[A-Za-z0-9_-]{1,160}$/.test(clientRequestId)) clientRequestId = undefined;
  clientRequestId ??= randomUUID(); pendingDeletes.set(chatId, clientRequestId);
  if (pendingDeletes.size > 256) pendingDeletes.delete(pendingDeletes.keys().next().value!);
  try { sessionStorage.setItem(storageKey, clientRequestId); } catch {}
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE', headers: CHAT_WRITE_HEADERS,
        body: JSON.stringify({ clientRequestId }), signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) { if (attempt) throw error; }
  }
  const body = await response!.json();
  if (!response!.ok) throw new Error(errorMessage(body));
  const receipt = body.receipt as ConversationDeleteReceipt | undefined;
  if (receipt?.chatId !== chatId || receipt.clientRequestId !== clientRequestId || receipt.disposition !== 'deleted') throw new Error('The conversation did not return its deletion receipt.');
  pendingDeletes.delete(chatId); try { sessionStorage.removeItem(storageKey); } catch {}
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-deleted', { detail: { chatId } }));
  return receipt;
}
export interface ManagedChatReceipt {
  commandId: string; chatId: string; state: string; revision: number; executionId?: string | null;
  held?: boolean; assistantFinal?: string; error?: { message?: string } | null;
}

/** Acknowledge the exact visible activity; a later reply retains its unread state. */
export async function acknowledgeManagedChatActivity(chatId: string, cursor: import('../../server/chats/activity').ChatActivityCursor): Promise<import('../../server/chats/activity').ChatActivityProjection> {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/ack`, { method: 'POST', headers: CHAT_WRITE_HEADERS,
    body: JSON.stringify(cursor), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || body.chatId !== chatId || !body.activity) throw new Error(errorMessage(body));
  return body.activity;
}

export async function stopLegacyConversationScope(chatId: string, ownerId: string): Promise<void> {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/commands`, { method: 'POST', headers: CHAT_WRITE_HEADERS,
    body: JSON.stringify({ action: 'stop', scope: 'tree', expectedLegacyOwnerId: ownerId, clientRequestId: `stop-${ownerId}` }),
    signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(errorMessage(await response.json()));
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(body: any): string {
  return typeof body?.error === 'string' ? body.error : body?.error?.message || 'The conversation could not accept this command.';
}

/** Admission is the receipt; execution and observation continue independently. */
export async function sendManagedChatAction(chatId: string, action: RemoteChatAction, data: Omit<Partial<RemoteChatCommand>, 'scope'> & { scope?: 'turn' | 'agents' | 'tree' } = {}): Promise<ManagedChatReceipt | undefined> {
  const chat = findChatById(chatId);
  if (!chat) throw new Error('This conversation is no longer available.');
  if ((action === 'send' || action === 'steer') && chatReadOnlyReason(chat)) throw new Error(chatReadOnlyReason(chat)!);
  let endpoint = `/api/chats/${encodeURIComponent(chatId)}/commands`;
  let method = 'POST';
  const payload: Record<string, unknown> = { action };
  if (action === 'send' || action === 'steer') {
    const attachments = data.attachments ?? [];
    if (action === 'steer' && attachments.length) throw new Error('Steering is text only. Queue attached files for the next reply.');
    payload.text = buildHistoryUserContent(data.text ?? '', attachments);
    if (action === 'send') {
      const images = persistableUserImages(attachments);
      if (images.length !== attachments.filter(attachment => Boolean(attachmentImageDataUrl(attachment))).length) {
        throw new Error('Attached images exceed this conversation\'s saved image limit. Remove an image and retry.');
      }
      if (images.length) payload.images = images;
    }
  } else if (action === 'configure') {
    endpoint = `/api/chats/${encodeURIComponent(chatId)}/configuration`;
    method = 'PATCH';
    const patch = data.patch ?? {};
    if (patch.modelSelection) {
      payload.selection = patch.modelSelection;
    } else if (patch.modelSelectValue) {
      const selected = decodeModelSelectKey(patch.modelSelectValue);
      if (!selected) throw new Error('Select a model with its provider.');
      payload.selection = { ...selected, options: {} };
    }
    for (const field of ['modeId', 'name', 'pinned'] as const) if (patch[field] !== undefined) payload[field] = patch[field];
    payload.expectedProfileVersion = chat.profileReference?.profileVersion ?? 0;
  } else if (action === 'cancel-steer') {
    throw new Error('Remove an individual pending correction from the queue.');
  } else if (action === 'stop') {
    payload.scope = data.scope ?? 'tree';
    if (data.scope === undefined && chat.agentExecution && !['completed', 'failed', 'stopped', 'recovery_required'].includes(chat.agentExecution.status)) {
      payload.executionId = chat.agentExecution.executionId;
    }
    if (data.executionId) payload.executionId = data.executionId;
  } else {
    const item = chat.pendingMessageQueue?.find(row => row.id === data.itemId);
    if (!item || item.commandRevision === undefined) throw new Error('This queued message has changed. Refresh the conversation and retry.');
    payload.itemId = item.id;
    payload.expectedRevision = item.commandRevision;
    if (action === 'edit') payload.text = data.text ?? '';
  }
  const inputKey = `${chatId}:${action}:${data.itemId ?? ''}`;
  const storageKey = `minnow.managedCommand.${inputKey}`;
  const digest = await fingerprint(payload);
  let prior = pending.get(inputKey);
  if (!prior) {
    try { prior = JSON.parse(sessionStorage.getItem(storageKey) || 'null') ?? undefined; } catch {}
  }
  const id = data.id ?? (prior?.fingerprint === digest ? prior.id : undefined) ?? randomUUID();
  pending.set(inputKey, { fingerprint: digest, id });
  if (pending.size > 256) pending.delete(pending.keys().next().value!);
  try { sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint: digest, id })); } catch {}
  const clearReceipt = () => {
    if (pending.get(inputKey)?.id === id) pending.delete(inputKey);
    try {
      if (JSON.parse(sessionStorage.getItem(storageKey) || 'null')?.id === id) sessionStorage.removeItem(storageKey);
    } catch {}
  };
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(endpoint, { method, headers: CHAT_WRITE_HEADERS,
        body: JSON.stringify({ ...payload, clientRequestId: id }), signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) { if (attempt) throw error; }
  }
  const body = await response!.json();
  if (!response!.ok) {
    // A definite rejection permits a new request; a lost receipt retains the
    // same key and exact input for the next retry, including image bytes.
    if (response!.status < 500) {
      clearReceipt();
    }
    throw new Error(errorMessage(body));
  }
  clearReceipt();
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-change', { detail: { chatId, ...body } }));
  return body.receipt;
}

/** Programmatic callers that need completion wait on their own immutable receipt. */
export async function waitForManagedCommand(receipt: ManagedChatReceipt, signal?: AbortSignal): Promise<ManagedChatReceipt> {
  let current = receipt;
  const read = async (allowAbort = true) => {
    const deadline = AbortSignal.timeout(10_000);
    const response = await fetch(`/api/chat-commands/${encodeURIComponent(receipt.commandId)}`, { cache: 'no-store', signal: allowAbort && signal ? AbortSignal.any([signal, deadline]) : deadline });
    const body = await response.json();
    if (!response.ok || !body.receipt) throw new Error(errorMessage(body));
    return body.receipt as ManagedChatReceipt;
  };
  try {
    while (!['settled', 'failed', 'cancelled'].includes(current.state)) {
      signal?.throwIfAborted();
      if (current.held) throw new Error('This message is preserved in the queue after Stop. Resume it to continue.');
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 300);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      current = await read();
    }
    if (current.state !== 'settled') throw new Error(current.error?.message || (current.state === 'cancelled' ? 'The conversation was stopped.' : 'The conversation failed.'));
    return current;
  } catch (error) {
    if (signal?.aborted) {
      try {
        current = await read(false);
        if (!['settled', 'failed', 'cancelled'].includes(current.state)) {
          const control = current.executionId && current.state === 'running'
            ? { action: 'stop', scope: 'tree', executionId: current.executionId }
            : { action: 'remove', itemId: current.commandId, expectedRevision: current.revision };
          await fetch(`/api/chats/${encodeURIComponent(current.chatId)}/commands`, { method: 'POST', headers: CHAT_WRITE_HEADERS,
            body: JSON.stringify({ ...control, clientRequestId: randomUUID() }), signal: AbortSignal.timeout(5000) });
        }
      } catch { /* A lost cancellation receipt cannot justify stopping another execution. */ }
    }
    throw error;
  }
}
