import { ChatContractError } from './contracts.js';

export function hasChatPresentationChanges(before, after) {
  const pin = value => Number.isFinite(value) && value > 0 ? value : 0;
  const draft = value => typeof value === 'string' ? value : '';
  return String(before.name ?? '') !== String(after.name ?? '') || String(before.groupId ?? '') !== String(after.groupId ?? '') ||
    pin(before.pinnedAt) !== pin(after.pinnedAt) || draft(before.composerDraft) !== draft(after.composerDraft);
}

/** A separate CAS fence for user-editable metadata, never model output or ACKs. */
export function readChatPresentationRevision(db, chatId) {
  const row = db.prepare("SELECT json_extract(meta_json,'$.presentationRevision') AS revision FROM chat_conversation_state WHERE chat_id=?").get(chatId);
  if (!row) return null;
  if (row.revision == null) return 0;
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new ChatContractError('recovery_required', 'Conversation presentation revision is invalid');
  return row.revision;
}

export function readChatPresentationRevisions(db, chatIds) {
  const selected = new Set(chatIds), revisions = {};
  if (selected.size === 0) return revisions;
  const read = db.prepare("SELECT json_extract(meta_json,'$.presentationRevision') AS revision FROM chat_conversation_state WHERE chat_id=?");
  for (const chatId of selected) {
    const row = read.get(chatId);
    if (!row) continue;
    const revision = row.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ChatContractError('recovery_required', 'Conversation presentation revision is invalid');
    Object.defineProperty(revisions, chatId, { value: revision, enumerable: true });
  }
  return revisions;
}

/** Call only inside the same transaction as an actual safe-field mutation. */
export function advanceChatPresentationRevision(db, chatId) {
  const current = readChatPresentationRevision(db, chatId);
  if (current === null) return null;
  if (current === Number.MAX_SAFE_INTEGER) throw new ChatContractError('recovery_required', 'Conversation presentation revision is exhausted');
  db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.presentationRevision',?) WHERE chat_id=?").run(current + 1, chatId);
  return current + 1;
}
