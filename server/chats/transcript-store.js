import { createHash } from 'node:crypto';
import { createChatRepository } from './repository.js';
import { createTranscriptDecoration } from '../runner/transcript-decoration.js';
import { isUiOnlyTranscriptRole } from '../runner/injection-notice.js';

/** Canonical session history adapter for the shared runner, under an execution fence. */
export function createChatTranscriptStore({ chatId, fence, repository = createChatRepository(), now } = {}) {
  if (!chatId || !fence?.executionId || !fence?.ownerId || !Number.isSafeInteger(fence.epoch)) {
    throw new Error('A chat transcript requires its execution ownership fence');
  }
  const decoration = createTranscriptDecoration({ omitSystem: true, ...(now ? { now } : {}) });
  const prefix = `m-${createHash('sha256').update(fence.executionId).digest('hex').slice(0, 32)}-`;
  let ordinal = 0;
  const initial = repository.readTranscript(chatId);
  for (const row of initial?.messages ?? []) {
    if (typeof row.messageId !== 'string' || !row.messageId.startsWith(prefix)) continue;
    const value = Number(row.messageId.slice(prefix.length));
    if (Number.isSafeInteger(value)) ordinal = Math.max(ordinal, value);
  }
  let lastAssistantId;
  let pendingAppend;
  const assertChat = id => { if (id !== chatId) throw new Error('Transcript belongs to another chat'); };
  return {
    load(id) {
      assertChat(id);
      const stored = repository.readTranscript(chatId);
      if (!stored) return null;
      const messages = [];
      const rowIds = [];
      stored.messages.forEach((row, index) => {
        if (isUiOnlyTranscriptRole(row?.role)) return;
        messages.push(row);
        rowIds.push(stored.rowIds?.[index] ?? index);
      });
      return { messages, rowIds, meta: stored.meta, compaction: stored.compaction ?? null };
    },
    append(id, message) {
      assertChat(id);
      const fingerprint = JSON.stringify(message);
      if (pendingAppend && pendingAppend.fingerprint !== fingerprint) {
        throw new Error('An unsettled transcript append requires recovery');
      }
      if (!pendingAppend) {
        const row = decoration.decorate(message);
        if (!row || isUiOnlyTranscriptRole(row.role)) return -1;
        const next = ordinal + 1;
        pendingAppend = { row, next, fingerprint, messageId: row.messageId ?? `${prefix}${next}` };
      }
      const { row, next, messageId } = pendingAppend;
      const appended = repository.appendMessage(chatId, row, { fence, messageId,
        ...(row.commandId ? { commandId: row.commandId } : {}),
      });
      ordinal = next;
      pendingAppend = undefined;
      if (row.role === 'assistant') lastAssistantId = appended.rowId;
      return appended.rowId;
    },
    setMeta(id, meta) {
      assertChat(id);
      repository.setTranscriptMeta(chatId, meta, { fence });
    },
    setCompaction(id, checkpoint) {
      assertChat(id);
      repository.setTranscriptMeta(chatId, { compaction: checkpoint }, { fence });
    },
    observePersisted(id, event) {
      assertChat(id);
      decoration.observe(event);
      if (event.type === 'round_start') lastAssistantId = undefined;
      if (event.type !== 'round_end' || lastAssistantId === undefined) return;
      const stored = repository.readMessage(chatId, lastAssistantId);
      if (!stored || stored.message.role !== 'assistant') throw new Error('Persisted assistant row is unavailable');
      repository.patchMessage(chatId, lastAssistantId, decoration.patchAssistant(stored.message), {
        fence, expectedHash: stored.rowHash,
      });
    },
  };
}
