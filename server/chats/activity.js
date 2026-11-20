import { validateModelSelection } from './contracts.js';
import { readChatPresentationRevision } from './presentation-revision.js';
import { safeAgentCliDiagnostic } from '../generations/agent-cli/errors.js';

function parse(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }
function selection(value) {
  const checked = validateModelSelection(parse(value));
  return checked.ok ? checked.value : undefined;
}
const FAILURE_KINDS = new Set(['quota', 'rate_limit', 'unavailable']);
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
const futureTime = value => Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : undefined;

/** Structured refusal facts for recovery UI; vendor prose stays in the sanitized `error` line. */
function failureFacts(row) {
  if (!row) return undefined;
  const facts = {
    ...(row.outcome === 'timeout' ? { outcome: 'timeout' } : {}),
    ...(FAILURE_KINDS.has(row.kind) ? { kind: row.kind } : {}),
    ...(row.quota === 1 || row.quota === true ? { quotaExceeded: true } : {}),
    ...(row.unreachable === 1 || row.unreachable === true ? { providerUnreachable: true } : {}),
    ...(Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status < 600 ? { status: row.http_status } : {}),
    ...(typeof row.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(row.code) ? { code: row.code } : {}),
    ...(futureTime(row.reset_at) ? { resetAt: row.reset_at } : {}),
    ...(futureTime(row.retry_at) ? { retryAt: row.retry_at } : {}),
    ...(safeId(row.provider_id) ? { providerId: row.provider_id } : {}),
    ...(safeId(row.model_id) ? { modelId: row.model_id } : {}),
  };
  return Object.keys(facts).length ? facts : undefined;
}

/** Lightweight canonical activity, shared by summaries, mounted frames and notices. */
export function readChatActivity(db, chatId) {
  const chat = db.prepare("SELECT name,unread,turn_error,json_type(meta_json,'$.agentConversation')='object' AS delegated FROM chats WHERE id=?").get(chatId);
  if (!chat) return null;
  const presentationRevision = readChatPresentationRevision(db, chatId), managed = presentationRevision !== null;
  const execution = managed ? db.prepare(`SELECT e.execution_id,e.command_id,e.run_id,e.status,e.created_at,e.updated_at,e.settled_at,e.activated_at,e.activity_json,
    COALESCE(json_extract(e.captured_json,'$.modelSelection'),json_extract(c.payload_json,'$.modelSelection'),json_extract(e.captured_json,'$.profile.snapshot.modelSelection')) AS model_selection
    FROM chat_executions e LEFT JOIN chat_commands c ON c.command_id=e.command_id
    WHERE e.chat_id=? AND e.rowid>COALESCE((SELECT prior.rowid FROM chat_conversation_state s JOIN chat_executions prior
      ON prior.execution_id=json_extract(s.meta_json,'$.historyRewrite.throughExecutionId') WHERE s.chat_id=e.chat_id),0)
    ORDER BY e.rowid DESC LIMIT 1`).get(chatId) : null;
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
  const failed = execution && ['failed', 'recovery_required'].includes(execution.status);
  const outcome = failed ? db.prepare(`SELECT substr(json_extract(result_json,'$.error'),1,2048) AS message, json_extract(result_json,'$.outcome') AS outcome,
    json_extract(result_json,'$.failure.kind') AS kind, json_extract(result_json,'$.failure.resetAt') AS reset_at, json_extract(result_json,'$.failure.retryAt') AS retry_at,
    json_extract(result_json,'$.failure.status') AS http_status, json_extract(result_json,'$.failure.code') AS code,
    json_extract(result_json,'$.failure.providerId') AS provider_id, json_extract(result_json,'$.failure.modelId') AS model_id,
    json_extract(result_json,'$.quotaExceeded') AS quota, json_extract(result_json,'$.providerUnreachable') AS unreachable
    FROM chat_executions WHERE execution_id=?`).get(execution.execution_id) : null;
  const error = outcome?.message;
  const failure = execution?.status === 'failed' ? failureFacts(outcome) : undefined;
  const title = managed && !chat.delegated && execution?.status === 'completed' ? db.prepare("SELECT command_id,json_extract(captured_json,'$.titleUpdate.name') AS placeholder,json_extract(captured_json,'$.titleUpdate.expectedName') AS original_name FROM chat_commands WHERE chat_id=? AND json_extract(payload_json,'$.kind')='send' AND json_extract(payload_json,'$.provenance.actor')='human' ORDER BY position LIMIT 1").get(chatId) : null;
  const autoTitle = title &&
    (chat.name.trim().toLowerCase() === 'new chat' || title.original_name?.trim().toLowerCase() === 'new chat' && chat.name === title.placeholder);
  return {
    ...(managed ? { agentPresentationRevision: presentationRevision } : {}),
    agentTitleCandidate: autoTitle ? { commandId: title.command_id, expectedName: chat.name } : null,
    agentExecution: execution ? {
      executionId: execution.execution_id, commandId: execution.command_id, runId: execution.run_id, status: execution.status,
      createdAt: execution.created_at, updatedAt: execution.updated_at, settledAt: execution.settled_at,
      ...(execution.settled_at != null ? { workDurationMs: Math.max(0, execution.settled_at - (execution.activated_at ?? execution.created_at)) } : {}),
      ...(modelSelection ? { modelSelection } : {}), ...(resolvedModel ? { resolvedModel } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(typeof error === 'string' && error ? { error: safeAgentCliDiagnostic(error).slice(0, 1024) } : {}),
      ...(failure ? { failure } : {}),
    } : null,
    agentPendingCommand: pending ? { commandId: pending.command_id, runId: pending.run_id, state: pending.state,
      held: pending.held === 1, ...(typeof pending.error_code === 'string' ? { errorCode: pending.error_code } : {}) } : null,
    agentRequestSummary: requests.map(row => ({ requestId: row.request_id, kind: row.kind })),
    agentActivityCursor: { messageSeq: incoming, executionId: terminal || execution?.status === 'stopped' ? execution.execution_id : null },
    unread: managed ? incoming > (read?.message_seq ?? -1) || Boolean(unseenExecution) : chat.unread === 1,
    turnError: managed ? Boolean(unseenExecution && ['failed', 'recovery_required'].includes(execution.status)) : chat.turn_error === 1,
  };
}
