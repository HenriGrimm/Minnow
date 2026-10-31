import { validateModelSelection } from './contracts.js';
import { readChatPresentationRevision } from './presentation-revision.js';

function parse(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }
function selection(value) {
  const checked = validateModelSelection(parse(value));
  return checked.ok ? checked.value : undefined;
}

/** Lightweight canonical activity, shared by summaries, mounted frames and notices. */
export function readChatActivity(db, chatId) {
  const chat = db.prepare('SELECT unread,turn_error FROM chats WHERE id=?').get(chatId);
  if (!chat) return null;
  const presentationRevision = readChatPresentationRevision(db, chatId), managed = presentationRevision !== null;
  const execution = managed ? db.prepare("SELECT e.execution_id,e.command_id,e.run_id,e.status,e.created_at,e.updated_at,e.settled_at,e.activity_json,COALESCE(json_extract(e.captured_json,'$.modelSelection'),json_extract(c.payload_json,'$.modelSelection'),json_extract(e.captured_json,'$.profile.snapshot.modelSelection')) AS model_selection FROM chat_executions e LEFT JOIN chat_commands c ON c.command_id=e.command_id WHERE e.chat_id=? ORDER BY e.rowid DESC LIMIT 1").get(chatId) : null;
  const pending = managed ? db.prepare("SELECT command_id,run_id,state,held,json_extract(error_json,'$.code') AS error_code FROM chat_commands WHERE chat_id=? AND state IN ('accepted','queued','waiting_for_host') AND json_extract(effective_json,'$.kind') IN ('send','steer') ORDER BY position LIMIT 1").get(chatId) : null;
  const requests = db.prepare("SELECT request_id,json_extract(payload_json,'$.kind') AS kind FROM chat_requests WHERE chat_id=? AND state='pending' ORDER BY updated_at,request_id LIMIT 256").all(chatId);
  const incoming = db.prepare("SELECT seq FROM messages WHERE chat_id=? AND hidden=0 AND ((role='assistant' AND text_len>0) OR (role='user' AND json_extract(payload_json,'$.provenance.actor') IN ('agent','system'))) ORDER BY seq DESC LIMIT 1").get(chatId)?.seq ?? -1;
  const read = managed ? db.prepare('SELECT message_seq,execution_id FROM chat_activity_reads WHERE chat_id=?').get(chatId) : null;
  const terminal = execution && ['completed', 'failed', 'recovery_required'].includes(execution.status);
  const unseenExecution = terminal && read?.execution_id !== execution.execution_id;
  const activity = parse(execution?.activity_json, {});
  const modelSelection = selection(execution?.model_selection);
  const resolvedModel = selection(JSON.stringify(activity.resolvedModel ?? null));
  const contextUsage = activity.contextUsage;
  return {
    ...(managed ? { agentPresentationRevision: presentationRevision } : {}),
    agentExecution: execution ? {
      executionId: execution.execution_id, commandId: execution.command_id, runId: execution.run_id, status: execution.status,
      createdAt: execution.created_at, updatedAt: execution.updated_at, settledAt: execution.settled_at,
      ...(modelSelection ? { modelSelection } : {}), ...(resolvedModel ? { resolvedModel } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    } : null,
    agentPendingCommand: pending ? { commandId: pending.command_id, runId: pending.run_id, state: pending.state,
      held: pending.held === 1, ...(typeof pending.error_code === 'string' ? { errorCode: pending.error_code } : {}) } : null,
    agentRequestSummary: requests.map(row => ({ requestId: row.request_id, kind: row.kind })),
    agentActivityCursor: { messageSeq: incoming, executionId: terminal || execution?.status === 'stopped' ? execution.execution_id : null },
    unread: managed ? incoming > (read?.message_seq ?? -1) || Boolean(unseenExecution) : chat.unread === 1,
    turnError: managed ? Boolean(unseenExecution && ['failed', 'recovery_required'].includes(execution.status)) : chat.turn_error === 1,
  };
}
