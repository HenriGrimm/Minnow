import { createHash } from 'node:crypto';
import { getSessionsDb, readSessionMeta, writeSessionMeta } from '../config/sessions-db.js';
import { hashPayload, messageTextContent, upsertChatRow, upsertMessageRow } from '../config/sessions-import.js';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import {
  CHAT_COMMAND_STATES, CHAT_EXECUTION_STATES, ChatContractError,
  validateAgentConversationMeta, validateAgentProfileReference, validateChatCommand,
  validateChatId, validateChatRequest, validateMessageProvenance, validateModelSelection,
} from './contracts.js';
import { isDeletedConversation, isManagedConversation, readAgentConversationProjection } from './schema.js';
import { createChatTaskRepository } from './task-repository.js';
import { readChatActivity } from './activity.js';
import { advanceChatPresentationRevision, hasChatPresentationChanges } from './presentation-revision.js';

const TERMINAL_EXECUTIONS = new Set(['completed', 'failed', 'stopped']);
const TERMINAL_COMMANDS = new Set(['settled', 'failed', 'cancelled']);
const PROTECTED_MESSAGE_FIELDS = ['messageId', 'role', 'tool_call_id', 'commandId', 'provenance', 'createdAt'];
const META_KEYS = new Set(['thinkingMode', 'reasoningEffort', 'compaction', 'lastContextTrim', 'contextBudget', 'thinkingBudgetTokens', 'injectedContext', 'todos', 'todosUpdatedAt']);

function fail(code, message) { throw new ChatContractError(code, message); }
function checked(result) {
  if (!result.ok) throw new ChatContractError(result.error.code, result.error.message, result.error);
  return result.value;
}
function identity(value) { return checked(validateChatId(value)); }
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('invalid_request', 'Invalid ' + name);
  return value;
}
function label(value, name, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_request', 'Invalid ' + name);
  }
  return value;
}
function json(value) {
  let nodes = 0;
  const ancestors = new Set();
  function clone(input, depth) {
    if (++nodes > 100000 || depth > 40) fail('invalid_request', 'Record is too complex');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || ancestors.has(input)) fail('invalid_request', 'Record is not JSON data');
    if (Object.getOwnPropertySymbols(input).length) fail('invalid_request', 'Symbol fields are not JSON data');
    ancestors.add(input);
    let output;
    if (Array.isArray(input)) {
      output = [];
      for (let index = 0; index < input.length; index += 1) {
        const entry = Object.getOwnPropertyDescriptor(input, String(index));
        if (!entry || !Object.hasOwn(entry, 'value')) fail('invalid_request', 'Invalid array data');
        output.push(clone(entry.value, depth + 1));
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid_request', 'Expected plain JSON data');
      output = {};
      for (const key of Object.keys(input).sort()) {
        const entry = Object.getOwnPropertyDescriptor(input, key);
        if (!entry || !Object.hasOwn(entry, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) {
          fail('invalid_request', 'Invalid JSON data field');
        }
        if (entry.value !== undefined) output[key] = clone(entry.value, depth + 1);
      }
    }
    ancestors.delete(input);
    return output;
  }
  const encoded = JSON.stringify(clone(value, 0));
  if (encoded.length > 16 * 1024 * 1024) fail('invalid_request', 'Record exceeds the storage limit');
  return encoded;
}
function parse(value, fallback = null) { return value == null ? fallback : JSON.parse(value); }
export function hashChatPayload(value) { return createHash('sha256').update(json(value)).digest('hex'); }
function commandHash(command) {
  const { commandId: _id, requestedAt: _at, ...intent } = command;
  const { commandId: _provenanceId, ...provenance } = intent.provenance;
  return hashChatPayload({ ...intent, provenance });
}
function commandRecord(row) {
  if (!row) return null;
  return {
    position: row.position, commandId: row.command_id, producerId: row.producer_id,
    requestKey: row.request_key, chatId: row.chat_id, inputHash: row.input_hash,
    command: parse(row.payload_json), effectiveCommand: parse(row.effective_json),
    captured: parse(row.captured_json, {}), held: row.held === 1,
    revision: row.revision, state: row.state, executionId: row.execution_id,
    runId: row.run_id, messageId: row.message_id, result: parse(row.result_json),
    error: parse(row.error_json), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function executionRecord(row) {
  return row ? {
    executionId: row.execution_id, chatId: row.chat_id, commandId: row.command_id,
    runId: row.run_id, attemptId: row.attempt_id, kind: row.kind, status: row.status,
    captured: parse(row.captured_json), result: parse(row.result_json),
    createdAt: row.created_at, updatedAt: row.updated_at, settledAt: row.settled_at, activatedAt: row.activated_at ?? null,
  } : null;
}
function outboxRecord(row) {
  return row ? {
    outboxId: row.outbox_id, chatId: row.chat_id, kind: row.kind,
    payload: parse(row.payload_json), payloadHash: row.payload_hash, state: row.state,
    attempts: row.attempts, ownerId: row.owner_id, expiresAt: row.expires_at,
    error: parse(row.error_json), createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

/** Synchronous transactional primitives; authorization is the service boundary. */
export function createChatRepository({ db: injectedDb, now = Date.now } = {}) {
  if (!injectedDb && process.env.MINNOW_SESSIONS_STORE === 'json') {
    fail('capability_unavailable', 'Persistent agent conversations require the SQLite session store');
  }
  const db = injectedDb ?? getSessionsDb();
  const transaction = (work) => db.transaction(work).immediate();
  const time = () => integer(now(), 'clock');
  function chatRow(chatId) {
    identity(chatId);
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!row) fail('chat_not_found', 'Conversation does not exist');
    return row;
  }
  function revision(chatId) {
    return db.prepare('SELECT revision FROM chat_revisions WHERE chat_id = ?').get(chatId)?.revision ?? 0;
  }
  // Request receipts notify viewers without invalidating a renderer-owned transcript save.
  function touch(chatId, { requestOnly = false } = {}) {
    const next = (readSessionMeta(db, 'revision', 0) || 0) + 1;
    writeSessionMeta(db, 'revision', next);
    db.prepare(`INSERT INTO chat_revisions (chat_id, revision, write_revision) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET revision = excluded.revision,
      write_revision = CASE WHEN ? THEN chat_revisions.write_revision ELSE excluded.write_revision END`)
      .run(chatId, next, next, requestOnly ? 1 : 0);
    db.prepare('UPDATE chats SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(time(), chatId);
    return next;
  }
  function markManaged(chatId) {
    const row = chatRow(chatId);
    const existing = parse(row.meta_json, {});
    const meta = Object.fromEntries(Object.entries(existing).filter(([key]) => META_KEYS.has(key)));
    db.prepare('INSERT OR IGNORE INTO chat_conversation_state (chat_id, project_id, meta_json) VALUES (?, ?, ?)')
      .run(chatId, row.workspace_path, json(meta));
    db.prepare("INSERT OR IGNORE INTO chat_activity_reads(chat_id,message_seq,execution_id) VALUES (?,COALESCE((SELECT MAX(seq) FROM messages WHERE chat_id=?),-1),(SELECT CASE WHEN status IN ('completed','failed','stopped','recovery_required') THEN execution_id END FROM chat_executions WHERE chat_id=? ORDER BY rowid DESC LIMIT 1))").run(chatId, chatId, chatId);
  }
  function assertFence(chatId, fence) {
    chatRow(chatId);
    if (!fence || typeof fence !== 'object') fail('ownership_conflict', 'Execution ownership is required');
    const lease = db.prepare('SELECT * FROM chat_execution_leases WHERE chat_id = ?').get(chatId);
    if (!lease || lease.state !== 'active' || lease.execution_id !== fence.executionId
      || lease.owner_id !== fence.ownerId || lease.epoch !== fence.epoch || lease.expires_at <= time()) {
      fail('ownership_conflict', 'Execution ownership is stale or expired');
    }
    return lease;
  }
  function updateMessageDerived(chatId) {
    // Hashes only, never hydrate or reserialize historical message bodies.
    const hashes = db.prepare('SELECT row_hash FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId);
    const last = db.prepare('SELECT payload_json FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1').get(chatId);
    const message = last ? parse(last.payload_json) : null;
    const stamp = time();
    db.prepare('UPDATE chats SET message_count = ?, history_digest = ?, last_message_preview = ?, last_message_at = ?, last_assistant_at = CASE WHEN ? THEN ? ELSE last_assistant_at END WHERE id = ?')
      .run(hashes.length, hashPayload(hashes.map((row) => row.row_hash).join('\n')),
        message ? messageTextContent(message).slice(0, 240) : '', stamp,
        message?.role === 'assistant' ? 1 : 0, stamp, chatId);
    return touch(chatId);
  }
  function getCommand(commandId) {
    return commandRecord(db.prepare('SELECT * FROM chat_commands WHERE command_id = ?').get(identity(commandId)));
  }
  function getExecution(executionId) {
    return executionRecord(db.prepare('SELECT * FROM chat_executions WHERE execution_id = ?').get(identity(executionId)));
  }
  function getOutbox(outboxId) {
    return outboxRecord(db.prepare('SELECT * FROM chat_outbox WHERE outbox_id = ?').get(identity(outboxId)));
  }
  function saveProfile(chatId, profile) {
    const reference = checked(validateAgentProfileReference({
      profileId: profile?.profileId, profileVersion: profile?.profileVersion,
    }));
    const snapshot = json(profile.snapshot ?? {});
    const inputHash = hashPayload(snapshot);
    const prior = db.prepare('SELECT * FROM chat_execution_profiles WHERE profile_id = ? AND profile_version = ?')
      .get(reference.profileId, reference.profileVersion);
    if (prior) {
      if (prior.chat_id !== chatId || prior.payload_hash !== inputHash) fail('idempotency_conflict', 'A profile version is immutable');
    } else {
      db.prepare('INSERT INTO chat_execution_profiles (profile_id, profile_version, chat_id, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?)')
        .run(reference.profileId, reference.profileVersion, chatId, inputHash, snapshot);
    }
    return { ...reference, chatId, snapshot: parse(snapshot) };
  }
  function findCommandReceipt(producerId, requestKey) {
    return commandRecord(db.prepare('SELECT * FROM chat_commands WHERE producer_id = ? AND request_key = ?')
      .get(label(producerId, 'producer'), label(requestKey, 'request key')));
  }
  function admitCommand(input, { producerId, requestKey, captured = {} } = {}) {
    const command = checked(validateChatCommand(input));
    const producer = label(producerId, 'producer');
    const key = label(requestKey ?? command.clientRequestId ?? command.commandId, 'request key');
    const inputHash = commandHash(command);
    return transaction(() => {
      const prior = findCommandReceipt(producer, key) ?? getCommand(command.commandId);
      if (prior) {
        if (prior.producerId !== producer || prior.requestKey !== key || prior.inputHash !== inputHash) {
          fail('idempotency_conflict', 'Command identity was reused for different input');
        }
        return { ...prior, replayed: true };
      }
      chatRow(command.chatId);
      const stamp = time();
      db.prepare('INSERT INTO chat_commands (command_id,producer_id,request_key,chat_id,input_hash,payload_json,effective_json,captured_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(command.commandId, producer, key, command.chatId, inputHash, json(command), json(command), json(captured), stamp, stamp);
      touch(command.chatId);
      return { ...getCommand(command.commandId), replayed: false };
    });
  }
  function putOutbox(input) {
    const outboxId = identity(input.outboxId);
    const kind = label(input.kind, 'outbox kind');
    const chatId = input.chatId == null ? null : identity(input.chatId);
    const payload = json(input.payload);
    const payloadHash = hashChatPayload({ chatId, kind, payload: parse(payload) });
    const prior = getOutbox(outboxId);
    if (prior) {
      if (prior.payloadHash !== payloadHash) fail('idempotency_conflict', 'Outbox identity was reused');
      return { ...prior, replayed: true };
    }
    const stamp = time();
    db.prepare('INSERT INTO chat_outbox (outbox_id,chat_id,kind,payload_hash,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(outboxId, chatId, kind, payloadHash, payload, stamp, stamp);
    return { ...getOutbox(outboxId), replayed: false };
  }
  function createChat(input) {
    const chatId = identity(input.id);
    if (isDeletedConversation(db, chatId)) fail('chat_not_found', 'A deleted conversation identity cannot be reused');
    if (db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) fail('idempotency_conflict', 'Conversation already exists');
    if (Array.isArray(input.history) && input.history.length) fail('invalid_request', 'New conversations cannot copy an implicit history');
    const chat = normalizeChatRow({
      ...input, history: [], updatedAt: input.updatedAt ?? time(), lastMessageAt: input.lastMessageAt ?? time(),
    });
    delete chat.agentConversation;
    const sortIndex = db.prepare('SELECT COALESCE(MAX(sort_index), -1) + 1 AS next FROM chats').get().next;
    upsertChatRow(db, chat, sortIndex, { messageCount: 0, lastMessagePreview: '', historyDigest: hashPayload('') });
    markManaged(chatId);
    touch(chatId);
    return getChat(chatId);
  }
  function getChat(chatId) {
    const row = chatRow(chatId);
    const output = {
      ...parse(row.meta_json, {}),
      ...parse(db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId)?.meta_json, {}),
      id: row.id, name: row.name, workspacePath: row.workspace_path,
      providerId: row.provider_id, modelId: row.model_id, modeId: row.mode_id,
      groupId: row.group_id, worktreeRoot: row.worktree_root, gitBranch: row.git_branch,
      updatedAt: row.updated_at, lastMessageAt: row.last_message_at,
      messageCount: row.message_count, lastMessagePreview: row.last_message_preview,
      historyDigest: row.history_digest, revision: revision(chatId),
    };
    delete output.agentConversation;
    const relation = readAgentConversationProjection(db, chatId);
    if (relation) output.agentConversation = relation;
    if (isManagedConversation(db, chatId)) output.chatCommandVersion = 1;
    const project = db.prepare('SELECT project_id FROM chat_conversation_state WHERE chat_id=?').get(chatId);
    if (project?.project_id) output.projectId = project.project_id;
    const latest = db.prepare('SELECT profile_id,profile_version FROM chat_execution_profiles WHERE chat_id=? ORDER BY rowid DESC LIMIT 1').get(chatId);
    if (latest) output.profileReference = { profileId: latest.profile_id, profileVersion: latest.profile_version };
    Object.assign(output, readChatActivity(db, chatId));
    return output;
  }
  function createChild(input) {
    const relation = checked(validateAgentConversationMeta(input.relation));
    if (relation.childChatId !== input.chat.id) fail('invalid_request', 'Child relationship identity does not match');
    if (input.spawnIntentHash !== undefined && (typeof input.spawnIntentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.spawnIntentHash))) {
      fail('invalid_request', 'Invalid spawn intent hash');
    }
    return transaction(() => {
      if (input.command) {
        const prior = findCommandReceipt(input.producerId, input.requestKey ?? input.command.clientRequestId ?? input.command.commandId);
        if (prior) {
          if (input.spawnIntentHash !== undefined ? prior.captured.spawnIntentHash !== input.spawnIntentHash
            : prior.inputHash !== commandHash(checked(validateChatCommand(input.command)))) {
            fail('idempotency_conflict', 'Child request key was reused');
          }
          return { chat: getChat(prior.chatId), command: { ...prior, replayed: true }, replayed: true };
        }
      }
      if (input.command && input.command.chatId !== relation.childChatId) fail('invalid_request', 'Initial command targets a different conversation');
      const chat = createChat(input.chat);
      const profile = saveProfile(chat.id, input.profile);
      if (relation.profileReference && (relation.profileReference.profileId !== profile.profileId
        || relation.profileReference.profileVersion !== profile.profileVersion)) fail('invalid_request', 'Child profile reference does not match');
      relation.profileReference = { profileId: profile.profileId, profileVersion: profile.profileVersion };
      db.prepare('INSERT INTO chat_relations (chat_id,parent_chat_id,root_chat_id,journal_owner_id,project_id,payload_json) VALUES (?,?,?,?,?,?)')
        .run(chat.id, relation.parentChatId, relation.rootChatId, relation.journalOwnerId,
          label(input.projectId ?? input.chat.workspacePath, 'project identity', 4096), json(relation));
      db.prepare('UPDATE chat_conversation_state SET project_id=? WHERE chat_id=?')
        .run(input.projectId ?? input.chat.workspacePath, chat.id);
      const command = input.command ? admitCommand(input.command, { ...input, captured: {
        ...(input.captured ?? {}), ...(input.spawnIntentHash === undefined ? {} : { spawnIntentHash: input.spawnIntentHash }),
      } }) : null;
      if (command?.captured.runId && command.captured.completionPolicy) {
        createChatTaskRepository({ repository, now }).ensureSubscription({ runId: command.captured.runId,
          policy: command.captured.completionPolicy, inlineWait: command.captured.inlineWait });
      }
      for (const item of input.outbox ?? []) putOutbox(item);
      touch(chat.id);
      return { chat: getChat(chat.id), command, replayed: false };
    });
  }
  function createExecution(input) {
    const executionId = identity(input.executionId);
    const chatId = identity(input.chatId);
    const stamp = time();
    const values = {
      executionId, chatId, commandId: input.commandId == null ? null : identity(input.commandId),
      runId: input.runId == null ? null : identity(input.runId), attemptId: input.attemptId == null ? null : identity(input.attemptId),
      kind: input.kind ?? 'server', captured: parse(json(input.captured ?? {})),
    };
    if (!['server', 'renderer', 'cli', 'scheduler'].includes(values.kind)) fail('invalid_request', 'Unknown execution host kind');
    const prior = getExecution(executionId);
    if (prior) {
      for (const key of Object.keys(values)) {
        if (hashChatPayload(prior[key]) !== hashChatPayload(values[key])) fail('idempotency_conflict', 'Execution identity was reused');
      }
      return prior;
    }
    chatRow(chatId);
    markManaged(chatId);
    db.prepare('INSERT INTO chat_executions (execution_id,chat_id,command_id,run_id,attempt_id,kind,captured_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(executionId, chatId, values.commandId, values.runId, values.attemptId, values.kind, json(values.captured), stamp, stamp);
    return getExecution(executionId);
  }
  function claimExecution(input) {
    return transaction(() => {
      const chatId = identity(input.chatId);
      const ownerId = identity(input.ownerId);
      const executionId = identity(input.executionId);
      const duration = integer(input.leaseMs ?? 30000, 'lease duration', 1);
      const stamp = time();
      const expiresAt = integer(stamp + duration, 'lease deadline');
      chatRow(chatId);
      const existing = getExecution(executionId);
      if (existing && existing.chatId !== chatId) fail('ownership_conflict', 'Execution belongs to another conversation');
      if (existing && (TERMINAL_EXECUTIONS.has(existing.status) || existing.status === 'recovery_required')) {
        fail('ownership_conflict', 'This execution cannot be restarted by claiming its lease');
      }
      const prior = db.prepare('SELECT * FROM chat_execution_leases WHERE chat_id = ?').get(chatId);
      if (prior?.state === 'active') {
        if (prior.owner_id === ownerId && prior.execution_id === executionId && prior.expires_at > stamp) {
          db.prepare('UPDATE chat_execution_leases SET expires_at = ? WHERE chat_id = ?').run(expiresAt, chatId);
          return { executionId, ownerId, epoch: prior.epoch, expiresAt };
        }
        // Expiry alone is not evidence that a native generation/tool stopped.
        fail('ownership_conflict', 'Conversation execution must settle before replacement');
      }
      if (db.prepare("SELECT 1 FROM chat_tool_invocations WHERE chat_id=? AND state!='settled' LIMIT 1").get(chatId)) {
        fail('recovery_required', 'Unsettled tool effects prevent a replacement execution');
      }
      const execution = existing ?? createExecution(input);
      if (TERMINAL_EXECUTIONS.has(execution.status) || execution.status === 'recovery_required') {
        fail('ownership_conflict', 'This execution cannot be restarted by claiming its lease');
      }
      const epoch = (prior?.epoch ?? 0) + 1;
      db.prepare('INSERT INTO chat_execution_leases (chat_id,execution_id,owner_id,epoch,expires_at,state) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET execution_id=excluded.execution_id,owner_id=excluded.owner_id,epoch=excluded.epoch,expires_at=excluded.expires_at,state=excluded.state')
        .run(chatId, executionId, ownerId, epoch, expiresAt, 'active');
      db.prepare("UPDATE chat_executions SET status='running', kind=?, updated_at=? WHERE execution_id=?").run(input.kind ?? execution.kind, stamp, executionId);
      touch(chatId);
      return { executionId, ownerId, epoch, expiresAt };
    });
  }
  function appendMessage(chatId, input, { fence, messageId = input?.messageId, commandId } = {}) {
    const stableId = identity(messageId);
    const encoded = json(input);
    const message = parse(encoded);
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || typeof message.role !== 'string' || !message.role) fail('invalid_request', 'A transcript message needs a role');
    if (message.messageId && message.messageId !== stableId) fail('invalid_request', 'Message identity does not match');
    if (message.provenance) message.provenance = checked(validateMessageProvenance(message.provenance));
    message.messageId = stableId;
    if (commandId) {
      if (message.commandId && message.commandId !== commandId) fail('invalid_request', 'Message command identity does not match');
      message.commandId = identity(commandId);
    }
    const inputHash = hashChatPayload(message);
    return transaction(() => {
      assertFence(chatId, fence);
      const prior = db.prepare('SELECT seq,input_hash FROM chat_message_identities WHERE chat_id=? AND message_id=?').get(chatId, stableId);
      if (prior) {
        if (prior.input_hash !== inputHash) fail('idempotency_conflict', 'Message identity was reused');
        return { rowId: prior.seq, messageId: stableId, revision: revision(chatId), replayed: true };
      }
      const rowId = db.prepare('SELECT COALESCE(MAX(seq),-1)+1 AS next FROM messages WHERE chat_id=?').get(chatId).next;
      upsertMessageRow(db, chatId, rowId, message);
      db.prepare('INSERT INTO chat_message_identities (chat_id,message_id,seq,input_hash) VALUES (?,?,?,?)').run(chatId, stableId, rowId, inputHash);
      const next = updateMessageDerived(chatId);
      return { rowId, messageId: stableId, revision: next, replayed: false };
    });
  }
  function readMessage(chatId, rowId) {
    const row = db.prepare('SELECT payload_json,row_hash FROM messages WHERE chat_id=? AND seq=?')
      .get(identity(chatId), integer(rowId, 'message row'));
    return row ? { rowId, message: parse(row.payload_json), rowHash: row.row_hash } : null;
  }
  function patchMessage(chatId, rowId, updates, { fence, expectedHash } = {}) {
    const patch = parse(json(updates));
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('invalid_request', 'Expected message updates');
    return transaction(() => {
      assertFence(chatId, fence);
      const prior = readMessage(chatId, rowId);
      if (!prior) fail('invalid_request', 'Message row does not exist');
      if (expectedHash !== undefined && prior.rowHash !== expectedHash) fail('stale_revision', 'Message row changed');
      for (const key of PROTECTED_MESSAGE_FIELDS) {
        if (Object.hasOwn(patch, key) && hashChatPayload(patch[key]) !== hashChatPayload(prior.message[key] ?? null)) {
          fail('policy_denied', 'Message identity and provenance cannot be patched');
        }
      }
      const message = { ...prior.message, ...patch };
      upsertMessageRow(db, chatId, rowId, message);
      return { rowId, messageId: message.messageId, revision: updateMessageDerived(chatId) };
    });
  }
  function readTranscript(chatId) {
    identity(chatId);
    if (!db.prepare('SELECT 1 FROM chats WHERE id=?').get(chatId)) return null;
    const rows = db.prepare('SELECT seq,payload_json FROM messages WHERE chat_id=? ORDER BY seq').all(chatId);
    const meta = parse(db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId)?.meta_json, {});
    return { messages: rows.map((row) => parse(row.payload_json)), rowIds: rows.map((row) => row.seq), meta, compaction: meta.compaction ?? null };
  }
  function setTranscriptMeta(chatId, updates, { fence } = {}) {
    const patch = parse(json(updates));
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !META_KEYS.has(key))) fail('invalid_request', 'Unsupported transcript metadata');
    return transaction(() => {
      assertFence(chatId, fence);
      const current = parse(db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId)?.meta_json, {});
      db.prepare('UPDATE chat_conversation_state SET meta_json=? WHERE chat_id=?').run(json({ ...current, ...patch }), chatId);
      return { revision: touch(chatId) };
    });
  }

  const repository = {
    getDatabase: () => db,
    getActivity: chatId => { chatRow(chatId); return readChatActivity(db, chatId); },
    acknowledgeActivity(chatId, cursor) {
      return transaction(() => {
        chatRow(chatId);
        if (!isManagedConversation(db, chatId)) fail('capability_unavailable', 'This conversation uses its existing attention controls');
        if (!cursor || Object.keys(cursor).some(key => !['messageSeq', 'executionId'].includes(key)) || !Number.isSafeInteger(cursor.messageSeq) || cursor.messageSeq < -1) fail('invalid_request', 'Invalid conversation activity cursor');
        const current = readChatActivity(db, chatId);
        if (cursor.messageSeq > current.agentActivityCursor.messageSeq) fail('stale_revision', 'The activity cursor is ahead of this conversation');
        let acknowledgedExecution = null;
        if (cursor.executionId != null) {
          const target = getExecution(identity(cursor.executionId));
          if (!target || target.chatId !== chatId) fail('invalid_request', 'The activity execution belongs to another conversation');
          if (['completed', 'failed', 'stopped', 'recovery_required'].includes(target.status)) acknowledgedExecution = target.executionId;
        }
        db.prepare('INSERT INTO chat_activity_reads(chat_id,message_seq,execution_id) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET message_seq=MAX(message_seq,excluded.message_seq),execution_id=CASE WHEN excluded.execution_id=(SELECT execution_id FROM chat_executions WHERE chat_id=excluded.chat_id ORDER BY rowid DESC LIMIT 1) THEN excluded.execution_id ELSE execution_id END')
          .run(chatId, cursor.messageSeq, acknowledgedExecution);
        touch(chatId); return readChatActivity(db, chatId);
      });
    },
    updateExecutionActivity(executionId, updates, { fence } = {}) {
      return transaction(() => {
        const execution = getExecution(executionId); if (!execution) fail('request_not_found', 'Execution does not exist');
        assertFence(execution.chatId, fence);
        if (fence.executionId !== executionId) fail('ownership_conflict', 'Activity belongs to another execution');
        const patch = parse(json(updates));
        if (!patch || Array.isArray(patch) || Object.keys(patch).some(key => !['resolvedModel', 'contextUsage'].includes(key))) fail('invalid_request', 'Unsupported execution activity');
        if (patch.resolvedModel) patch.resolvedModel = checked(validateModelSelection(patch.resolvedModel));
        if (patch.contextUsage && (!Number.isFinite(patch.contextUsage.used) || patch.contextUsage.used < 0 ||
          patch.contextUsage.limit !== null && (!Number.isFinite(patch.contextUsage.limit) || patch.contextUsage.limit <= 0) || typeof patch.contextUsage.isEstimate !== 'boolean')) fail('invalid_request', 'Invalid execution context usage');
        const prior = parse(db.prepare('SELECT activity_json FROM chat_executions WHERE execution_id=?').get(executionId).activity_json, {});
        db.prepare('UPDATE chat_executions SET activity_json=? WHERE execution_id=?').run(json({ ...prior, ...patch }), executionId);
        touch(execution.chatId); return readChatActivity(db, execution.chatId);
      });
    },
    setAutoResumeBlocked(chatId, blocked) {
      if (typeof blocked !== 'boolean') fail('invalid_request', 'Invalid automatic resume setting');
      return transaction(() => {
        const row = chatRow(chatId), meta = parse(row.meta_json, {});
        const state = db.prepare('SELECT meta_json FROM chat_conversation_state WHERE chat_id=?').get(chatId);
        const protectedMeta = parse(state?.meta_json, {});
        if (Boolean(protectedMeta.subAgentAutoResumeBlocked ?? meta.subAgentAutoResumeBlocked) === blocked) return;
        meta.subAgentAutoResumeBlocked = blocked;
        db.prepare('UPDATE chats SET meta_json=? WHERE id=?').run(json(meta), chatId);
        if (state) db.prepare('UPDATE chat_conversation_state SET meta_json=? WHERE chat_id=?').run(json({ ...protectedMeta, subAgentAutoResumeBlocked: blocked }), chatId);
        touch(chatId);
      });
    },
    atomic: (work) => transaction(() => work(repository)),
    createChat: (input) => transaction(() => createChat(input)),
    createChild, getChat,
    ensureManagedChat: (chatId, options = {}) => transaction(() => {
      markManaged(chatId);
      if (options.projectId !== undefined) {
        db.prepare('UPDATE chat_conversation_state SET project_id=? WHERE chat_id=?').run(label(options.projectId, 'project identity', 4096), chatId);
      }
      if (options.profile) saveProfile(chatId, options.profile);
      touch(chatId);
      return getChat(chatId);
    }),
    configureChat(chatId, patch, { expectedProfileVersion, profile } = {}) {
      return transaction(() => {
        const existing = chatRow(chatId);
        const latest = repository.getLatestProfile(chatId);
        if (expectedProfileVersion !== undefined && expectedProfileVersion !== (latest?.profileVersion ?? 0)) {
          fail('stale_revision', 'Conversation profile changed');
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)
          || Object.keys(patch).some((key) => !['providerId', 'modelId', 'modeId', 'name', 'pinned', 'archived'].includes(key))) fail('invalid_request', 'Unsupported conversation configuration');
        if (patch.pinned !== undefined && repository.getRelation(chatId)) fail('invalid_request', 'Agent conversations stay within their parent group and cannot be pinned independently');
        let selection = { providerId: existing.provider_id, modelId: existing.model_id };
        if (Object.hasOwn(patch, 'providerId') || Object.hasOwn(patch, 'modelId')) {
          selection = checked(validateModelSelection({ providerId: patch.providerId, modelId: patch.modelId }));
        }
        const mode = patch.modeId ?? existing.mode_id;
        if (!['general', 'build', 'plan', 'debug', 'orchestrate', 'onboarding'].includes(mode)) fail('invalid_request', 'Invalid conversation mode');
        if (profile) saveProfile(chatId, profile);
        markManaged(chatId);
        const name = patch.name === undefined ? existing.name : label(patch.name, 'conversation name', 512).trim();
        const meta = parse(existing.meta_json, {});
        const presentationBefore = { ...meta, name: existing.name, groupId: existing.group_id };
        if (patch.pinned !== undefined) {
          if (typeof patch.pinned !== 'boolean') fail('invalid_request', 'Pinned state must be a boolean');
          delete meta.pinned;
          if (patch.pinned) meta.pinnedAt = Number.isFinite(meta.pinnedAt) && meta.pinnedAt > 0 ? meta.pinnedAt : time();
          else delete meta.pinnedAt;
        }
        if (patch.archived !== undefined) {
          if (typeof patch.archived !== 'boolean') fail('invalid_request', 'Archived state must be a boolean');
          if (patch.archived) meta.archivedAt = Number.isFinite(meta.archivedAt) && meta.archivedAt > 0 ? meta.archivedAt : time();
          else delete meta.archivedAt;
        }
        db.prepare('UPDATE chats SET provider_id=?,model_id=?,mode_id=?,name=?,meta_json=? WHERE id=?')
          .run(selection.providerId, selection.modelId, mode, name, json(meta), chatId);
        if (hasChatPresentationChanges(presentationBefore, { ...meta, name, groupId: existing.group_id })) advanceChatPresentationRevision(db, chatId);
        touch(chatId); return getChat(chatId);
      });
    },
    manageChat: (chatId) => transaction(() => { markManaged(chatId); return getChat(chatId); }),
    getRelation: (chatId) => readAgentConversationProjection(db, identity(chatId)) ?? null,
    getChatProjectId: (chatId) => db.prepare('SELECT project_id FROM chat_conversation_state WHERE chat_id=?').get(identity(chatId))?.project_id || null,
    getTaskAttention(chatId) {
      const row = db.prepare("SELECT COUNT(*) AS pending_count FROM chat_task_subscriptions t JOIN chats c ON c.id=t.recipient_chat_id LEFT JOIN chat_conversation_state s ON s.chat_id=c.id LEFT JOIN chat_cancellation_epochs e ON e.chat_id=c.id WHERE t.recipient_chat_id=? AND t.cancellation_epoch=COALESCE(e.epoch,0) AND t.state IN ('active','inline_hold','inline_returned') AND COALESCE(json_extract(s.meta_json,'$.subAgentAutoResumeBlocked'),json_extract(c.meta_json,'$.subAgentAutoResumeBlocked'),0)!=1").get(identity(chatId));
      return row.pending_count ? { status: 'waiting_for_agents', pendingCount: row.pending_count } : null;
    },
    listActiveChatIds({ projectId, limit = 100 } = {}) {
      label(projectId, 'project identity', 4096);
      integer(limit, 'activity list limit', 1); if (limit > 100) fail('invalid_request', 'Activity list limit exceeds 100');
      const attention = "EXISTS (SELECT 1 FROM chat_task_subscriptions t LEFT JOIN chat_cancellation_epochs ce ON ce.chat_id=t.recipient_chat_id WHERE t.recipient_chat_id=s.chat_id AND t.cancellation_epoch=COALESCE(ce.epoch,0) AND t.state IN ('active','inline_hold','inline_returned'))";
      return db.prepare("SELECT s.chat_id FROM chat_conversation_state s LEFT JOIN chat_executions e ON e.rowid=(SELECT MAX(x.rowid) FROM chat_executions x WHERE x.chat_id=s.chat_id) WHERE s.project_id=? AND (e.status IN ('queued','running','waiting','waiting_for_model','loading_model','waiting_for_agents','waiting_for_input','waiting_for_approval','waiting_for_host','stopping','recovery_required') OR EXISTS (SELECT 1 FROM chat_requests r WHERE r.chat_id=s.chat_id AND r.state='pending') OR " + attention + ") ORDER BY EXISTS (SELECT 1 FROM chat_requests r WHERE r.chat_id=s.chat_id AND r.state='pending') DESC," + attention + " DESC,COALESCE(e.updated_at,0) DESC,s.chat_id LIMIT ?")
        .all(projectId, limit).map(row => row.chat_id);
    },
    saveProfile: (chatId, profile) => transaction(() => { chatRow(chatId); return saveProfile(chatId, profile); }),
    getProfile(profileId, profileVersion) {
      const row = db.prepare('SELECT * FROM chat_execution_profiles WHERE profile_id=? AND profile_version=?')
        .get(identity(profileId), integer(profileVersion, 'profile version', 1));
      return row ? { profileId: row.profile_id, profileVersion: row.profile_version, chatId: row.chat_id, snapshot: parse(row.payload_json) } : null;
    },
    getLatestProfile(chatId) {
      const row = db.prepare('SELECT * FROM chat_execution_profiles WHERE chat_id=? ORDER BY rowid DESC LIMIT 1').get(identity(chatId));
      return row ? { profileId: row.profile_id, profileVersion: row.profile_version, chatId: row.chat_id, snapshot: parse(row.payload_json) } : null;
    },
    listChatShells: (options) => repository.listChats(options),
    listChats({ workspace, projectId, includeChildren = true, afterPosition = -1, limit = 100 } = {}) {
      integer(limit, 'list limit', 1); if (limit > 100) fail('invalid_request', 'List limit exceeds 100');
      const rows = db.prepare('SELECT c.id,c.sort_index FROM chats c LEFT JOIN chat_relations r ON r.chat_id=c.id LEFT JOIN chat_conversation_state s ON s.chat_id=c.id WHERE c.sort_index>? AND (? IS NULL OR COALESCE(r.project_id,s.project_id,c.workspace_path)=?) AND (? IS NULL OR c.workspace_path=?) AND (? OR r.chat_id IS NULL OR NOT EXISTS (SELECT 1 FROM chats p WHERE p.id=r.parent_chat_id)) ORDER BY c.sort_index,c.id LIMIT ?')
        .all(afterPosition, projectId ?? null, projectId ?? null, workspace ?? null, workspace ?? null, includeChildren ? 1 : 0, limit);
      return rows.map((row) => {
        const chat = getChat(row.id);
        return { id: chat.id, name: chat.name, workspacePath: chat.workspacePath, providerId: chat.providerId, modelId: chat.modelId,
          modeId: chat.modeId, messageCount: chat.messageCount, lastMessagePreview: chat.lastMessagePreview,
          updatedAt: chat.updatedAt, position: row.sort_index,
          ...(chat.chatCommandVersion ? { chatCommandVersion: chat.chatCommandVersion } : {}),
          ...(chat.profileReference ? { profileReference: chat.profileReference } : {}),
          ...(chat.agentConversation ? { agentConversation: chat.agentConversation } : {}) };
      });
    },
    admitCommand, findCommandReceipt, getCommand,
    listCommands({ chatId, states, limit = 100 } = {}) {
      integer(limit, 'command limit', 1); if (limit > 1000) fail('invalid_request', 'Command limit exceeds 1000');
      if (chatId !== undefined) identity(chatId);
      if (states !== undefined && !Array.isArray(states)) fail('invalid_request', 'Expected command states');
      const allowed = states === undefined ? null : states.map((state) => {
        if (!CHAT_COMMAND_STATES.includes(state)) fail('invalid_request', 'Invalid command state'); return state;
      });
      if (allowed?.length === 0) return [];
      const filter = allowed ? ' AND state IN (' + allowed.map(() => '?').join(',') + ')' : '';
      return db.prepare('SELECT * FROM chat_commands WHERE (? IS NULL OR chat_id=?)' + filter + ' ORDER BY position LIMIT ?')
        .all(chatId ?? null, chatId ?? null, ...(allowed ?? []), limit).map(commandRecord);
    },
    updateCommand(commandId, update, { expectedRevision } = {}) {
      return transaction(() => {
        const current = getCommand(commandId); if (!current) fail('command_not_found', 'Command does not exist');
        if (expectedRevision !== undefined && current.revision !== expectedRevision) fail('stale_revision', 'Command changed');
        const state = update.state ?? current.state;
        if (!CHAT_COMMAND_STATES.includes(state)) fail('invalid_request', 'Invalid command state');
        const nextResult = Object.hasOwn(update, 'result') ? update.result : current.result;
        const nextError = Object.hasOwn(update, 'error') ? update.error : current.error;
        if (TERMINAL_COMMANDS.has(current.state) && (state !== current.state
          || json(nextResult) !== json(current.result) || json(nextError) !== json(current.error)
          || (update.executionId !== undefined && update.executionId !== current.executionId)
          || (update.runId !== undefined && update.runId !== current.runId)
          || (update.messageId !== undefined && update.messageId !== current.messageId))) {
          fail('idempotency_conflict', 'Settled command receipts are immutable');
        }
        if (TERMINAL_COMMANDS.has(current.state)) return current;
        db.prepare('UPDATE chat_commands SET state=?,execution_id=?,run_id=?,message_id=?,result_json=?,error_json=?,held=?,revision=revision+1,updated_at=? WHERE command_id=?')
          .run(state, update.executionId ?? current.executionId, update.runId ?? current.runId, update.messageId ?? current.messageId,
            json(nextResult), json(nextError), update.held === undefined ? (current.held ? 1 : 0) : update.held === true ? 1 : 0,
            time(), commandId);
        touch(current.chatId); return getCommand(commandId);
      });
    },
    editQueuedCommand(commandId, { message, expectedRevision }) {
      return transaction(() => {
        const current = getCommand(commandId); if (!current) fail('command_not_found', 'Command does not exist');
        if (current.revision !== expectedRevision) fail('stale_revision', 'Queued input changed');
        if (!['accepted', 'queued', 'waiting_for_host'].includes(current.state)) fail('stale_revision', 'Input was already consumed');
        if (current.runId && current.executionId) fail('stale_revision', 'Task input was already consumed by an attempt');
        const effective = checked(validateChatCommand({ ...current.effectiveCommand, message }));
        if (!['send', 'steer'].includes(effective.kind)) fail('invalid_request', 'This command has no editable input');
        db.prepare('UPDATE chat_commands SET effective_json=?,revision=revision+1,updated_at=? WHERE command_id=?').run(json(effective), time(), commandId);
        touch(current.chatId); return getCommand(commandId);
      });
    },
    promoteQueuedCommand(commandId, { expectedRevision, executionId } = {}) {
      return transaction(() => {
        const current = getCommand(commandId); if (!current) fail('command_not_found', 'Command does not exist');
        if (current.revision !== expectedRevision) fail('stale_revision', 'Queued input changed');
        if (!['accepted', 'queued', 'waiting_for_host'].includes(current.state)) fail('stale_revision', 'Input was already consumed');
        if (current.runId && current.executionId) fail('stale_revision', 'Task input was already consumed by an attempt');
        const { mode: _mode, ...effective } = current.effectiveCommand;
        const next = checked(validateChatCommand({ ...effective, kind: executionId ? 'steer' : 'send', ...(executionId ? {} : { mode: 'auto' }) }));
        db.prepare("UPDATE chat_commands SET effective_json=?,execution_id=?,held=0,state='queued',revision=revision+1,updated_at=? WHERE command_id=?")
          .run(json(next), executionId ? identity(executionId) : null, time(), commandId);
        touch(current.chatId); return getCommand(commandId);
      });
    },
    holdQueuedCommands(chatId, { throughPosition = Number.MAX_SAFE_INTEGER } = {}) {
      return transaction(() => {
        chatRow(chatId); integer(throughPosition, 'stop boundary');
        const changed = db.prepare("UPDATE chat_commands SET held=1,revision=revision+1,updated_at=? WHERE chat_id=? AND position<=? AND state IN ('accepted','queued','waiting_for_host') AND held=0")
          .run(time(), chatId, throughPosition).changes;
        if (changed) touch(chatId);
        return changed;
      });
    },
    requeueUnconsumedSteers(chatId, executionId, { held = true } = {}) {
      return transaction(() => {
        if (typeof held !== 'boolean') fail('invalid_request', 'Queued hold state must be a boolean');
        const rows = repository.listCommands({ chatId, states: ['accepted', 'queued', 'waiting_for_host'], limit: 1000 })
          .filter((row) => row.executionId === executionId && row.effectiveCommand.kind === 'steer');
        for (const row of rows) {
          const effective = checked(validateChatCommand({ ...row.effectiveCommand, kind: 'send', mode: 'queue' }));
          db.prepare("UPDATE chat_commands SET effective_json=?,execution_id=NULL,state='queued',held=?,revision=revision+1,updated_at=? WHERE command_id=?")
            .run(json(effective), held ? 1 : 0, time(), row.commandId);
        }
        if (rows.length) touch(chatId);
        return rows.length;
      });
    },
    createExecution: (input) => transaction(() => createExecution(input)),
    getExecution, claimExecution,
    findAttemptExecution(runId, attemptId) {
      return executionRecord(db.prepare('SELECT * FROM chat_executions WHERE run_id=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1').get(identity(runId), identity(attemptId)));
    },
    markExecutionActivated(executionId, { fence } = {}) {
      return transaction(() => {
        const execution = getExecution(identity(executionId)); if (!execution) fail('invalid_request', 'Execution does not exist');
        assertFence(execution.chatId, fence);
        if (fence.executionId !== executionId) fail('ownership_conflict', 'Activation belongs to another execution');
        db.prepare('UPDATE chat_executions SET activated_at=COALESCE(activated_at,?),updated_at=? WHERE execution_id=?').run(time(), time(), executionId);
        return getExecution(executionId);
      });
    },
    getLatestExecution(chatId) {
      return executionRecord(db.prepare('SELECT * FROM chat_executions WHERE chat_id=? ORDER BY rowid DESC LIMIT 1').get(identity(chatId)));
    },
    listExecutions({ chatId, statuses, limit = 100 } = {}) {
      integer(limit, 'execution limit', 1); if (limit > 1000) fail('invalid_request', 'Execution limit exceeds 1000');
      if (chatId !== undefined) identity(chatId);
      if (statuses !== undefined && (!Array.isArray(statuses) || statuses.some((status) => !CHAT_EXECUTION_STATES.includes(status)))) {
        fail('invalid_request', 'Invalid execution statuses');
      }
      if (statuses?.length === 0) return [];
      const filter = statuses ? ' AND status IN (' + statuses.map(() => '?').join(',') + ')' : '';
      return db.prepare('SELECT * FROM chat_executions WHERE (? IS NULL OR chat_id=?)' + filter + ' ORDER BY created_at,execution_id LIMIT ?')
        .all(chatId ?? null, chatId ?? null, ...(statuses ?? []), limit).map(executionRecord);
    },
    getLease(chatId) {
      const row = db.prepare('SELECT * FROM chat_execution_leases WHERE chat_id=?').get(identity(chatId));
      return row ? { executionId: row.execution_id, ownerId: row.owner_id, epoch: row.epoch, expiresAt: row.expires_at, state: row.state } : null;
    },
    renewLease(chatId, fence, leaseMs = 30000) {
      return transaction(() => {
        assertFence(chatId, fence); const expiresAt = integer(time() + integer(leaseMs, 'lease duration', 1), 'lease deadline');
        db.prepare('UPDATE chat_execution_leases SET expires_at=? WHERE chat_id=?').run(expiresAt, chatId);
        return { ...fence, expiresAt };
      });
    },
    releaseLease(chatId, fence) {
      return transaction(() => {
        const current = repository.getLease(chatId);
        if (!current || current.executionId !== fence.executionId || current.ownerId !== fence.ownerId || current.epoch !== fence.epoch) {
          fail('ownership_conflict', 'Cannot release another execution owner');
        }
        const execution = getExecution(fence.executionId);
        if (execution && !TERMINAL_EXECUTIONS.has(execution.status) && execution.status !== 'waiting_for_host') {
          fail('ownership_conflict', 'Settle execution or pause for a host before releasing ownership');
        }
        db.prepare("UPDATE chat_execution_leases SET state='released',expires_at=? WHERE chat_id=?").run(time(), chatId);
      });
    },
    updateExecution(executionId, update, { fence } = {}) {
      return transaction(() => {
        const execution = getExecution(executionId); if (!execution) fail('invalid_request', 'Execution does not exist');
        assertFence(execution.chatId, fence);
        const status = update.status ?? execution.status;
        if (!CHAT_EXECUTION_STATES.includes(status)) fail('invalid_request', 'Invalid execution status');
        if (TERMINAL_EXECUTIONS.has(execution.status) && (status !== execution.status || json(update.result ?? execution.result) !== json(execution.result))) {
          fail('idempotency_conflict', 'Settled execution is immutable');
        }
        if (TERMINAL_EXECUTIONS.has(status) && db.prepare("SELECT 1 FROM chat_tool_invocations WHERE execution_id=? AND state!='settled' LIMIT 1").get(executionId)) {
          fail('recovery_required', 'Unsettled tool effects require recovery');
        }
        db.prepare('UPDATE chat_executions SET status=?,result_json=?,updated_at=?,settled_at=? WHERE execution_id=?')
          .run(status, json(update.result ?? execution.result), time(), TERMINAL_EXECUTIONS.has(status) ? time() : null, executionId);
        touch(execution.chatId); return getExecution(executionId);
      });
    },
    /**
     * Internal recovery boundary. The runtime must first verify that the
     * provider/native process and tool are quiescent; a deadline is not proof.
     * The proof is persisted for audit and never obtained from a client claim.
     */
    recoverExecution(executionId, { fence, quiescence, status = 'failed' } = {}) {
      return transaction(() => {
        const execution = getExecution(executionId); if (!execution) fail('invalid_request', 'Execution does not exist');
        if (!quiescence || quiescence.verified !== true || typeof quiescence.source !== 'string' || !quiescence.source.trim()
          || !Number.isSafeInteger(quiescence.checkedAt) || quiescence.checkedAt < 0) {
          fail('invalid_request', 'Verified runtime quiescence evidence is required');
        }
        const lease = repository.getLease(execution.chatId);
        if (!lease || lease.executionId !== fence?.executionId || lease.ownerId !== fence?.ownerId || lease.epoch !== fence?.epoch
          || executionId !== lease.executionId) fail('ownership_conflict', 'Recovery fence is stale');
        if (!['failed', 'stopped'].includes(status)) fail('invalid_request', 'Invalid recovered execution status');
        if (TERMINAL_EXECUTIONS.has(execution.status)) return execution;
        const unresolved = repository.listUnsettledToolInvocations(executionId);
        const next = unresolved.length ? 'recovery_required' : status;
        const result = { outcome: 'crashed', failure: {
          recoveryRequired: unresolved.length > 0, quiescence: parse(json(quiescence)),
          unresolvedInvocationIds: unresolved.map((entry) => entry.invocationId),
          ...(execution.captured?.taskOwned && execution.activatedAt === null ? { unstartedReservation: true } : {}),
        } };
        db.prepare('UPDATE chat_executions SET status=?,result_json=?,settled_at=?,updated_at=? WHERE execution_id=?')
          .run(next, json(result), TERMINAL_EXECUTIONS.has(next) ? time() : null, time(), executionId);
        db.prepare("UPDATE chat_execution_leases SET state='released',expires_at=? WHERE chat_id=?").run(time(), execution.chatId);
        touch(execution.chatId); return getExecution(executionId);
      });
    },
    assertFence, appendMessage, patchMessage, readMessage, readTranscript, setTranscriptMeta,
    /** Trusted admission only: retain a legacy result while no execution owns the transcript. */
    appendAdmittedResult(commandId) {
      return transaction(() => {
        const record = getCommand(identity(commandId)), command = record?.command;
        if (record?.captured?.legacyCompletion !== true || command?.kind !== 'send' || command.provenance.actor !== 'system'
          || command.provenance.source !== 'task_delivery' || command.provenance.kind !== 'delegation_result'
          || record.captured.delivery?.runId !== command.provenance.runId || record.captured.delivery?.deliveryId !== command.provenance.deliveryId
          || !isManagedConversation(db, record.chatId)) fail('policy_denied', 'A trusted managed legacy result command is required');
        const messageId = commandId.length <= 154 ? 'input-' + commandId : 'input-' + createHash('sha256').update(commandId).digest('hex');
        const message = { role: 'user', content: command.message, commandId, provenance: command.provenance,
          createdAt: command.requestedAt, ...(command.images?.length ? { images: command.images } : {}), messageId };
        const inputHash = hashChatPayload(message);
        const prior = db.prepare('SELECT seq,input_hash FROM chat_message_identities WHERE chat_id=? AND message_id=?').get(record.chatId, messageId);
        if (prior) {
          if (prior.input_hash !== inputHash) fail('idempotency_conflict', 'Legacy result message identity was reused');
          return { rowId: prior.seq, messageId, revision: revision(record.chatId), replayed: true };
        }
        if (repository.getLease(record.chatId)?.state === 'active'
          || db.prepare("SELECT 1 FROM chat_tool_invocations WHERE chat_id=? AND state!='settled' LIMIT 1").get(record.chatId)) fail('ownership_conflict', 'A live or uncertain execution prevents legacy result retention');
        const rowId = db.prepare('SELECT COALESCE(MAX(seq),-1)+1 AS next FROM messages WHERE chat_id=?').get(record.chatId).next;
        upsertMessageRow(db, record.chatId, rowId, message);
        db.prepare('INSERT INTO chat_message_identities(chat_id,message_id,seq,input_hash) VALUES(?,?,?,?)').run(record.chatId, messageId, rowId, inputHash);
        return { rowId, messageId, revision: updateMessageDerived(record.chatId), replayed: false };
      });
    },
    /** One trusted archival context row, only while a legacy-import chat is entirely new. */
    importContext(chatId, input) {
      return transaction(() => {
        chatRow(chatId);
        const relation = repository.getRelation(chatId);
        if (relation?.origin !== 'legacy_import' || relation.parentChatId !== input?.sourceParentChatId) fail('policy_denied', 'Historical context requires its fresh legacy-import conversation');
        if (db.prepare('SELECT 1 FROM chat_executions WHERE chat_id=? LIMIT 1').get(chatId) || db.prepare('SELECT 1 FROM chat_commands WHERE chat_id=? LIMIT 1').get(chatId)) fail('ownership_conflict', 'A conversation that has accepted work cannot import context');
        if (!input || Object.keys(input).some(key => !['messageId', 'content', 'createdAt', 'sourceParentChatId', 'sourceRunId'].includes(key)) || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 120000) fail('invalid_request', 'A bounded historical context note is required');
        const messageId = identity(input.messageId);
        const message = { role: 'user', content: input.content, messageId, createdAt: integer(input.createdAt, 'import time'),
          provenance: checked(validateMessageProvenance({ version: 1, actor: 'human', source: 'migration', kind: 'human_message', sourceChatId: identity(input.sourceParentChatId), runId: identity(input.sourceRunId) })) };
        const prior = readMessage(chatId, 0), inputHash = hashChatPayload(message);
        if (prior) {
          if (hashChatPayload(prior.message) === inputHash && db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id=?').get(chatId).n === 1) return { rowId: 0, messageId, revision: revision(chatId), replayed: true };
          fail('ownership_conflict', 'Historical context can only initialize an empty conversation');
        }
        upsertMessageRow(db, chatId, 0, message);
        db.prepare('INSERT INTO chat_message_identities(chat_id,message_id,seq,input_hash) VALUES(?,?,0,?)').run(chatId, messageId, inputHash);
        return { rowId: 0, messageId, revision: updateMessageDerived(chatId), replayed: false };
      });
    },
    readMessageByIdentity(chatId, messageId) {
      const row = db.prepare('SELECT m.seq,m.payload_json,m.row_hash FROM chat_message_identities i JOIN messages m ON m.chat_id=i.chat_id AND m.seq=i.seq WHERE i.chat_id=? AND i.message_id=?')
        .get(identity(chatId), identity(messageId));
      return row ? { rowId: row.seq, message: parse(row.payload_json), rowHash: row.row_hash } : null;
    },
    readExecutionFinalAssistant(executionId) {
      const execution = getExecution(identity(executionId));
      if (!execution) return '';
      const prefix = 'm-' + createHash('sha256').update(executionId).digest('hex').slice(0, 32) + '-';
      const row = db.prepare("SELECT m.payload_json FROM messages m JOIN chat_message_identities i ON i.chat_id=m.chat_id AND i.seq=m.seq WHERE m.chat_id=? AND i.message_id LIKE ? AND m.role='assistant' AND m.has_tool_calls=0 AND m.hidden=0 AND m.text_len>0 ORDER BY m.seq DESC LIMIT 1")
        .get(execution.chatId, prefix + '%');
      return row ? messageTextContent(parse(row.payload_json)) : '';
    },
    saveRequest(input, { fence } = {}) {
      const request = checked(validateChatRequest(input));
      return transaction(() => {
        assertFence(request.chatId, fence);
        if (request.executionId !== fence.executionId) fail('ownership_conflict', 'Request belongs to another execution');
        const previous = db.prepare('SELECT payload_json FROM chat_requests WHERE request_id=?').get(request.requestId);
        if (previous) {
          if (hashPayload(previous.payload_json) !== hashChatPayload(request)) fail('idempotency_conflict', 'Request identity was reused');
          return parse(previous.payload_json);
        }
        if (request.state !== 'pending') fail('invalid_request', 'New requests must be pending');
        if (db.prepare("SELECT count(*) AS count FROM chat_requests WHERE chat_id=? AND state='pending'").get(request.chatId).count >= 128) fail('queue_full', 'This conversation already has 128 unanswered requests');
        db.prepare('INSERT INTO chat_requests (request_id,chat_id,execution_id,state,payload_json,updated_at) VALUES (?,?,?,?,?,?)')
          .run(request.requestId, request.chatId, request.executionId, request.state, json(request), time());
        touch(request.chatId, { requestOnly: true }); return request;
      });
    },
    saveLegacyRequest(input, { assertOwner } = {}) {
      const request = checked(validateChatRequest(input));
      if (typeof assertOwner !== 'function') fail('caller_denied', 'A trusted legacy owner assertion is required');
      if (request.kind !== 'approval' || request.state !== 'pending') fail('invalid_request', 'Legacy request admission supports pending approvals only');
      return transaction(() => {
        if (assertOwner() !== true) fail('caller_not_active', 'The original renderer no longer owns this request');
        chatRow(request.chatId);
        const prior = repository.getRequest(request.requestId);
        if (prior) {
          const immutable = value => {
            const { state: _state, settledAt: _settled, answerCommandId: _answer, ...record } = value;
            return record;
          };
          if (hashChatPayload(immutable(prior)) !== hashChatPayload(immutable(request))) fail('idempotency_conflict', 'Legacy approval identity was reused');
          return prior;
        }
        if (db.prepare("SELECT count(*) AS count FROM chat_requests WHERE chat_id=? AND state='pending'").get(request.chatId).count >= 128) fail('queue_full', 'This conversation already has 128 unanswered requests');
        db.prepare('INSERT INTO chat_requests(request_id,chat_id,execution_id,state,payload_json,updated_at) VALUES(?,?,?,?,?,?)')
          .run(request.requestId, request.chatId, request.executionId, request.state, json(request), time());
        touch(request.chatId, { requestOnly: true }); return request;
      });
    },
    getRequest(requestId) { return parse(db.prepare('SELECT payload_json FROM chat_requests WHERE request_id=?').get(identity(requestId))?.payload_json); },
    listRequests(chatId, state = 'pending') {
      return db.prepare('SELECT payload_json FROM chat_requests WHERE chat_id=? AND (? IS NULL OR state=?) ORDER BY updated_at,request_id')
        .all(identity(chatId), state, state).map((row) => parse(row.payload_json));
    },
    listRequestPresentation(chatId, { afterRequestId, limit = 32, recentLimit = 8 } = {}) {
      identity(chatId); if (afterRequestId !== undefined) identity(afterRequestId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || !Number.isSafeInteger(recentLimit) || recentLimit < 0 || recentLimit > 8) fail('invalid_request', 'Invalid request presentation limit');
      const pendingCount = db.prepare("SELECT count(*) AS count FROM chat_requests WHERE chat_id=? AND state='pending'").get(chatId).count;
      const pendingRows = db.prepare("SELECT request_id,payload_json FROM chat_requests WHERE chat_id=? AND state='pending' AND request_id>? ORDER BY request_id LIMIT ?")
        .all(chatId, afterRequestId ?? '', limit + 1);
      const requests = []; let bytes = 0, emitted = 0;
      const budget = 256 * 1024 - 2048;
      for (const row of pendingRows.slice(0, limit)) {
        const size = Buffer.byteLength(row.payload_json);
        if (bytes + size > budget && requests.length) break;
        if (size > budget) fail('recovery_required', 'A saved human request exceeds the supported presentation size');
        requests.push(parse(row.payload_json)); bytes += size; emitted++;
      }
      const nextCursor = pendingRows.length > emitted ? requests.at(-1)?.requestId ?? null : null;
      const recent = afterRequestId ? [] : db.prepare("SELECT payload_json FROM chat_requests WHERE chat_id=? AND state!='pending' ORDER BY updated_at DESC,request_id DESC LIMIT ?").all(chatId, recentLimit);
      let recentAdded = 0;
      for (const row of recent) {
        const size = Buffer.byteLength(row.payload_json); if (bytes + size > budget) break;
        requests.push(parse(row.payload_json)); bytes += size; recentAdded++;
      }
      return { requests, pendingCount, nextCursor, truncated: Boolean(nextCursor) || recentAdded < recent.length };
    },
    settleRequest(requestId, settlement) {
      return transaction(() => {
        const prior = repository.getRequest(requestId); if (!prior) fail('request_not_found', 'Request does not exist');
        chatRow(prior.chatId);
        const updated = checked(validateChatRequest({ ...prior, ...settlement, settledAt: settlement.settledAt ?? time() }));
        if (prior.state !== 'pending') {
          if (json(prior) === json(updated)) return prior;
          fail('request_expired', 'Request already settled');
        }
        if (updated.state === 'pending') fail('invalid_request', 'Request settlement must be terminal');
        db.prepare('UPDATE chat_requests SET state=?,payload_json=?,updated_at=? WHERE request_id=?')
          .run(updated.state, json(updated), time(), requestId);
        touch(prior.chatId, { requestOnly: true }); return updated;
      });
    },
    respondToRequest(requestId, { answerCommandId, answer, settledAt } = {}) {
      identity(answerCommandId);
      const encodedResponse = json(answer);
      if (Buffer.byteLength(encodedResponse) > 128_000) fail('invalid_request', 'A human answer must fit within 128 KB');
      const response = parse(encodedResponse);
      const responseHash = hashChatPayload({ answerCommandId, answer: response });
      return transaction(() => {
        const row = db.prepare('SELECT * FROM chat_requests WHERE request_id=?').get(identity(requestId));
        if (!row) fail('request_not_found', 'Request does not exist');
        const prior = parse(row.payload_json);
        chatRow(prior.chatId);
        if (row.response_hash) {
          if (row.response_hash !== responseHash) fail('idempotency_conflict', 'Answer receipt was reused with different data');
          return { request: prior, answer: parse(row.response_json), replayed: true };
        }
        if (prior.state !== 'pending' || (prior.expiresAt !== undefined && prior.expiresAt <= time())) {
          fail('request_expired', 'Request is no longer respondable');
        }
        const updated = checked(validateChatRequest({
          ...prior, state: 'answered', answerCommandId, settledAt: settledAt ?? time(),
        }));
        db.prepare("UPDATE chat_requests SET state='answered',payload_json=?,response_hash=?,response_json=?,updated_at=? WHERE request_id=?")
          .run(json(updated), responseHash, json(response), time(), requestId);
        touch(prior.chatId, { requestOnly: true });
        return { request: updated, answer: response, replayed: false };
      });
    },
    readRequestAnswer(requestId) {
      const row = db.prepare('SELECT response_json FROM chat_requests WHERE request_id=?').get(identity(requestId));
      return row?.response_json == null ? null : parse(row.response_json);
    },
    recordToolIntent(input, { fence } = {}) {
      return transaction(() => {
        assertFence(input.chatId, fence);
        if (input.executionId !== fence.executionId) fail('ownership_conflict', 'Tool belongs to another execution');
        const invocationId = identity(input.invocationId), toolCallId = label(input.toolCallId, 'tool call identity');
        const toolName = label(input.toolName, 'tool name');
        const payload = json(input.input ?? null), inputHash = hashChatPayload({ toolName, input: parse(payload) });
        const prior = db.prepare('SELECT * FROM chat_tool_invocations WHERE invocation_id=? OR (execution_id=? AND tool_call_id=?)')
          .get(invocationId, input.executionId, toolCallId);
        if (prior) {
          if (prior.chat_id !== input.chatId || prior.execution_id !== input.executionId || prior.tool_call_id !== toolCallId || prior.input_hash !== inputHash) {
            fail('idempotency_conflict', 'Tool invocation identity was reused');
          }
          return { invocationId: prior.invocation_id, state: prior.state, result: parse(prior.result_json), replayed: true };
        }
        db.prepare('INSERT INTO chat_tool_invocations (invocation_id,chat_id,execution_id,tool_call_id,tool_name,input_hash,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(invocationId, input.chatId, input.executionId, toolCallId, toolName, inputHash, payload, time());
        return { invocationId, state: 'intent', result: null, replayed: false };
      });
    },
    settleToolInvocation(invocationId, result, { fence } = {}) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM chat_tool_invocations WHERE invocation_id=?').get(identity(invocationId));
        if (!row) fail('invalid_request', 'Tool invocation does not exist');
        assertFence(row.chat_id, fence);
        if (row.execution_id !== fence.executionId) fail('ownership_conflict', 'Tool belongs to another execution');
        const encoded = json(result), resultHash = hashPayload(encoded);
        if (row.state === 'settled' && row.result_hash !== resultHash) fail('idempotency_conflict', 'Tool result receipt is immutable');
        db.prepare("UPDATE chat_tool_invocations SET state='settled',result_hash=?,result_json=?,settled_at=? WHERE invocation_id=?")
          .run(resultHash, encoded, time(), invocationId);
        return { invocationId, state: 'settled', result: parse(encoded) };
      });
    },
    listUnsettledToolInvocations(executionId) {
      return db.prepare("SELECT * FROM chat_tool_invocations WHERE execution_id=? AND state!='settled' ORDER BY created_at,invocation_id")
        .all(identity(executionId)).map((row) => ({ invocationId: row.invocation_id, chatId: row.chat_id,
          executionId: row.execution_id, toolCallId: row.tool_call_id, toolName: row.tool_name, input: parse(row.payload_json), state: row.state }));
    },
    getToolInvocation(invocationId) {
      const row = db.prepare('SELECT * FROM chat_tool_invocations WHERE invocation_id=?').get(identity(invocationId));
      return row ? { invocationId: row.invocation_id, chatId: row.chat_id, executionId: row.execution_id,
        toolCallId: row.tool_call_id, toolName: row.tool_name, input: parse(row.payload_json),
        state: row.state, result: parse(row.result_json) } : null;
    },
    getCancellationEpoch(chatId) {
      return db.prepare('SELECT epoch FROM chat_cancellation_epochs WHERE chat_id=?').get(identity(chatId))?.epoch ?? 0;
    },
    advanceCancellationEpoch(chatId, { expectedEpoch } = {}) {
      return transaction(() => {
        const current = repository.getCancellationEpoch(chatId);
        if (expectedEpoch !== undefined && current !== expectedEpoch) fail('stale_revision', 'Cancellation scope changed');
        db.prepare('INSERT INTO chat_cancellation_epochs (chat_id,epoch) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET epoch=excluded.epoch')
          .run(chatId, current + 1);
        return current + 1;
      });
    },
    putOutbox: (input) => transaction(() => putOutbox(input)), getOutbox,
    listOutbox({ states = ['pending', 'failed', 'applying'], limit = 100 } = {}) {
      integer(limit, 'outbox limit', 1); if (limit > 1000) fail('invalid_request', 'Outbox limit exceeds 1000');
      if (!Array.isArray(states) || states.some((state) => !['pending', 'applying', 'applied', 'failed'].includes(state))) fail('invalid_request', 'Invalid outbox states');
      if (!states.length) return [];
      return db.prepare('SELECT * FROM chat_outbox WHERE state IN (' + states.map(() => '?').join(',') + ') ORDER BY created_at,outbox_id LIMIT ?')
        .all(...states, limit).map(outboxRecord);
    },
    claimOutbox(outboxId, ownerId, leaseMs = 30000) {
      return transaction(() => {
        const row = getOutbox(outboxId); if (!row) fail('invalid_request', 'Outbox entry does not exist');
        identity(ownerId); const stamp = time();
        if (row.state === 'applied') return null;
        if (row.state === 'applying' && row.expiresAt > stamp) return null;
        db.prepare("UPDATE chat_outbox SET state='applying',owner_id=?,expires_at=?,attempts=attempts+1,updated_at=? WHERE outbox_id=?")
          .run(ownerId, stamp + integer(leaseMs, 'outbox lease', 1), stamp, outboxId);
        return getOutbox(outboxId);
      });
    },
    finishOutbox(outboxId, { ownerId, attempts }, error = null) {
      return transaction(() => {
        const row = getOutbox(outboxId);
        if (!row || row.state !== 'applying' || row.ownerId !== ownerId || row.attempts !== attempts) {
          fail('ownership_conflict', 'Outbox claim is stale');
        }
        db.prepare('UPDATE chat_outbox SET state=?,error_json=?,expires_at=NULL,updated_at=? WHERE outbox_id=?')
          .run(error ? 'failed' : 'applied', json(error), time(), outboxId);
        return getOutbox(outboxId);
      });
    },
  };
  return repository;
}
