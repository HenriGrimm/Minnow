import { randomUUID } from '../lib/random-id';
import type { LegacyChatImportReceipt } from '../../server/chats/legacy-import';

const pending = new Map<string, { id: string; title?: string }>();
/** Explicit human copy; the server never starts a generation from this operation. */
export async function continueLegacyAgentChat(parentChatId: string, runId: string, title?: string): Promise<LegacyChatImportReceipt> {
  const key = `minnow.legacyContinue.${parentChatId}.${runId}`;
  let prior = pending.get(key);
  if (!prior) { try { prior = JSON.parse(sessionStorage.getItem(key) || 'null') ?? undefined; } catch {} }
  if (!prior || prior.title !== title || !/^[A-Za-z0-9_-]{1,160}$/.test(prior.id)) prior = { id: randomUUID(), ...(title ? { title } : {}) };
  pending.set(key, prior); if (pending.size > 128) pending.delete(pending.keys().next().value!);
  try { sessionStorage.setItem(key, JSON.stringify(prior)); } catch {}
  const body = JSON.stringify({ clientRequestId: prior.id, ...(title ? { title } : {}) });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { response = await fetch(`/api/chats/${encodeURIComponent(parentChatId)}/legacy/${encodeURIComponent(runId)}/continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' }, body, signal: AbortSignal.timeout(15_000),
    }); break; } catch (error) { if (attempt) throw error; }
  }
  const result = await response!.json();
  if (!response!.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || 'This saved agent could not be continued.');
  const receipt = result.receipt as LegacyChatImportReceipt;
  if (!receipt || receipt.sourceParentChatId !== parentChatId || receipt.sourceRunId !== runId || !/^[A-Za-z0-9_-]{1,160}$/.test(receipt.childChatId) || receipt.context?.partial !== true) throw new Error('The new chat did not return its saved continuation receipt.');
  pending.delete(key); try { sessionStorage.removeItem(key); } catch {}
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-change', { detail: { chatId: receipt.childChatId } }));
  return receipt;
}
