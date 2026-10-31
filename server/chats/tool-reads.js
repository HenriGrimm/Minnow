import { ChatContractError } from './contracts.js';
import { createHash } from 'node:crypto';

export const CHAT_READ_MAX_BYTES = 48 * 1024;
const parse = value => value ? JSON.parse(value) : null;

/** SQL projections never hydrate attachment bytes, signed reasoning, or profile bodies. */
export function createChatToolReads(repository) {
  const db = repository.getDatabase?.();
  if (!db) throw new ChatContractError('capability_unavailable', 'Bounded conversation reads require the canonical SQLite store');
  function execution(chatId, executionId) {
    return db.prepare(`SELECT execution_id AS executionId,chat_id AS chatId,command_id AS commandId,run_id AS runId,
      status,created_at AS createdAt,updated_at AS updatedAt,settled_at AS settledAt
      FROM chat_executions WHERE chat_id=? AND (? IS NULL OR execution_id=?) ORDER BY rowid DESC LIMIT 1`)
      .get(chatId, executionId ?? null, executionId ?? null) ?? null;
  }
  return {
    execution,
    candidates(afterPosition, limit, includeChildren, workspaceKeys) {
      // Apply the verified project registry before the scan budget, so older
      // chats in unrelated projects cannot fill every page with skipped rows.
      const checkout = "COALESCE(NULLIF(c.worktree_root,''),c.workspace_path)";
      const workspace = process.platform === 'win32' ? `lower(${checkout})` : checkout;
      return db.prepare(`SELECT c.rowid AS position,c.id FROM chats c LEFT JOIN chat_relations r ON r.chat_id=c.id
        WHERE c.rowid>? AND (? OR r.chat_id IS NULL OR NOT EXISTS(SELECT 1 FROM chats p WHERE p.id=r.parent_chat_id))
        AND ${workspace} IN (SELECT value FROM json_each(?))
        ORDER BY c.rowid LIMIT ?`).all(afterPosition, includeChildren ? 1 : 0, JSON.stringify(workspaceKeys), limit);
    },
    activity(chatId, executionId) {
      const current = execution(chatId, executionId);
      const requests = db.prepare(`SELECT request_id AS requestId,execution_id AS executionId,
        substr(json_extract(payload_json,'$.kind'),1,40) AS kind FROM chat_requests
        WHERE chat_id=? AND state='pending' AND (? IS NULL OR execution_id=?) ORDER BY updated_at,request_id LIMIT 5`)
        .all(chatId, executionId ?? null, executionId ?? null);
      const requestCount = db.prepare("SELECT count(*) AS count FROM chat_requests WHERE chat_id=? AND state='pending' AND (? IS NULL OR execution_id=?)")
        .get(chatId, executionId ?? null, executionId ?? null).count;
      const pending = db.prepare("SELECT count(*) AS count FROM chat_commands WHERE chat_id=? AND state IN ('accepted','queued','waiting_for_host') AND json_extract(effective_json,'$.kind') IN ('send','steer')").get(chatId).count;
      return { execution: current, requests, pendingRequestCount: requestCount, requestsTruncated: requestCount > requests.length, pendingInputCount: pending };
    },
    messages(chatId, afterSequence, limit) {
      const rows = db.prepare(`SELECT seq,role,hidden,has_tool_calls AS hasToolCalls,has_attachments AS hasAttachments,
        substr(json_extract(payload_json,'$.messageId'),1,160) AS messageId,
        substr(json_extract(payload_json,'$.toolName'),1,256) AS toolName,
        substr(tool_call_id,1,160) AS toolCallId,
        CASE WHEN json_type(payload_json,'$.content')='text' THEN substr(json_extract(payload_json,'$.content'),1,8000)
          WHEN json_type(payload_json,'$.content')='array' THEN (SELECT group_concat(text,'\n') FROM
            (SELECT substr(json_extract(value,'$.text'),1,2000) AS text FROM json_each(payload_json,'$.content')
             WHERE json_extract(value,'$.type')='text' ORDER BY key LIMIT 8)) ELSE '' END AS content,
        text_len AS textLength,
        json_object('version',json_extract(payload_json,'$.provenance.version'),
          'actor',substr(json_extract(payload_json,'$.provenance.actor'),1,16),
          'kind',substr(json_extract(payload_json,'$.provenance.kind'),1,40),
          'source',substr(json_extract(payload_json,'$.provenance.source'),1,40),
          'sourceChatId',substr(json_extract(payload_json,'$.provenance.sourceChatId'),1,160),
          'sourceTurnId',substr(json_extract(payload_json,'$.provenance.sourceTurnId'),1,160),
          'commandId',substr(json_extract(payload_json,'$.provenance.commandId'),1,160),
          'runId',substr(json_extract(payload_json,'$.provenance.runId'),1,160)) AS provenance
        FROM messages WHERE chat_id=? AND seq>? ORDER BY seq LIMIT ?`).all(chatId, afterSequence, limit + 1);
      const messages = [];
      let bytes = 0;
      for (const row of rows.slice(0, limit)) {
        const provenance = parse(row.provenance);
        const message = { sequence: row.seq, role: row.role, content: row.content ?? '',
          ...(row.messageId ? { messageId: row.messageId } : {}), ...(row.toolName ? { toolName: row.toolName } : {}),
          ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
          ...(provenance?.actor ? { provenance: Object.fromEntries(Object.entries(provenance).filter(([, value]) => value !== null)) } : {}),
          hasToolCalls: Boolean(row.hasToolCalls), hasAttachments: Boolean(row.hasAttachments), hidden: Boolean(row.hidden),
          truncated: row.textLength > (row.content?.length ?? 0) };
        if (bytes + Buffer.byteLength(JSON.stringify(message)) > CHAT_READ_MAX_BYTES && messages.length) break;
        while (Buffer.byteLength(JSON.stringify(message)) > CHAT_READ_MAX_BYTES - bytes) {
          message.content = message.content.slice(0, Math.floor(message.content.length / 2)); message.truncated = true;
        }
        bytes += Buffer.byteLength(JSON.stringify(message)); messages.push(message);
      }
      return { messages, after_sequence: afterSequence,
        next_sequence: messages.at(-1)?.sequence ?? afterSequence, has_more: rows.length > messages.length,
        truncated: messages.some(row => row.truncated), omitted: ['image_bytes', 'signed_reasoning', 'raw_tool_arguments'] };
    },
    finalText(executionId) {
      const prefix = 'm-' + createHash('sha256').update(executionId).digest('hex').slice(0, 32) + '-';
      return db.prepare(`SELECT substr(json_extract(m.payload_json,'$.content'),1,12000) AS content FROM messages m
        JOIN chat_message_identities i ON i.chat_id=m.chat_id AND i.seq=m.seq JOIN chat_executions e ON e.chat_id=m.chat_id
        WHERE e.execution_id=? AND i.message_id LIKE ? AND m.role='assistant' AND m.has_tool_calls=0 AND m.hidden=0
        AND m.text_len>0 AND json_type(m.payload_json,'$.content')='text' ORDER BY m.seq DESC LIMIT 1`)
        .get(executionId, prefix + '%')?.content ?? '';
    },
  };
}
