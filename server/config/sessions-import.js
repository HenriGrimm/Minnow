import crypto from 'node:crypto';
import fs from 'node:fs';
import { validateSessionState } from './validators.js';
import {
  sessionsJsonMigratedPath,
  sessionsJsonPath,
} from './sessions-paths.js';
import {
  BOARD_LOG_MAX,
  readSessionMeta,
  writeSessionMeta,
} from './sessions-schema.js';

const CHAT_HOT_KEYS = new Set([
  'id',
  'name',
  'kind',
  'appScope',
  'expertId',
  'workspacePath',
  'providerId',
  'modelId',
  'modeId',
  'groupId',
  'boardGroupId',
  'boardTaskId',
  'worktreeRoot',
  'gitBranch',
  'updatedAt',
  'lastMessageAt',
  'lastAssistantAt',
  'unread',
  'turnError',
  'history',
  'historyLoaded',
  'messageCount',
  'lastMessagePreview',
  'sortIndex',
  'historyDigest',
  'terminalHistory',
  'runs',
  'subAgentRuns',
  'activeLoops',
]);

function nowIso() {
  return new Date().toISOString();
}

export function hashPayload(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function messageTextContent(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} chat
 * @param {number} sortIndex
 * @param {{ messageCount: number, lastMessagePreview: string, historyDigest: string }} derived
 */
export function upsertChatRow(db, chat, sortIndex, derived) {
  /** @type {Record<string, unknown>} */
  const meta = {};
  for (const [key, value] of Object.entries(chat)) {
    if (CHAT_HOT_KEYS.has(key)) continue;
    if (value !== undefined) meta[key] = value;
  }
  const priorRow = db.prepare('SELECT meta_json FROM chats WHERE id = ?').get(String(chat.id ?? ''));
  if (priorRow) {
    const prior = JSON.parse(priorRow.meta_json || '{}');
    if (prior.superPlanRunId === meta.superPlanRunId && (prior.superPlanView?.seq ?? 0) > (meta.superPlanView?.seq ?? 0)) meta.superPlanView = prior.superPlanView;
  }


  db.prepare(
    `INSERT INTO chats (
       id, sort_index, name, kind, app_scope, expert_id, workspace_path,
       provider_id, model_id, mode_id, group_id, board_group_id, board_task_id,
       worktree_root, git_branch, updated_at, last_message_at, last_assistant_at,
       unread, turn_error, message_count, last_message_preview, history_digest, meta_json
     ) VALUES (
       @id, @sort_index, @name, @kind, @app_scope, @expert_id, @workspace_path,
       @provider_id, @model_id, @mode_id, @group_id, @board_group_id, @board_task_id,
       @worktree_root, @git_branch, @updated_at, @last_message_at, @last_assistant_at,
       @unread, @turn_error, @message_count, @last_message_preview, @history_digest, @meta_json
     )
     ON CONFLICT(id) DO UPDATE SET
       sort_index = excluded.sort_index,
       name = excluded.name,
       kind = excluded.kind,
       app_scope = excluded.app_scope,
       expert_id = excluded.expert_id,
       workspace_path = excluded.workspace_path,
       provider_id = excluded.provider_id,
       model_id = excluded.model_id,
       mode_id = excluded.mode_id,
       group_id = excluded.group_id,
       board_group_id = excluded.board_group_id,
       board_task_id = excluded.board_task_id,
       worktree_root = excluded.worktree_root,
       git_branch = excluded.git_branch,
       updated_at = excluded.updated_at,
       last_message_at = excluded.last_message_at,
       last_assistant_at = excluded.last_assistant_at,
       unread = excluded.unread,
       turn_error = excluded.turn_error,
       message_count = excluded.message_count,
       last_message_preview = excluded.last_message_preview,
       history_digest = excluded.history_digest,
       meta_json = excluded.meta_json`,
  ).run({
    id: String(chat.id ?? ''),
    sort_index: sortIndex,
    name: typeof chat.name === 'string' ? chat.name : '',
    kind: typeof chat.kind === 'string' ? chat.kind : '',
    app_scope: '',
    expert_id: typeof chat.expertId === 'string' ? chat.expertId : '',
    workspace_path: typeof chat.workspacePath === 'string' ? chat.workspacePath : '',
    provider_id: typeof chat.providerId === 'string' ? chat.providerId : '',
    model_id: typeof chat.modelId === 'string' ? chat.modelId : '',
    mode_id: typeof chat.modeId === 'string' ? chat.modeId : '',
    group_id: typeof chat.groupId === 'string' ? chat.groupId : '',
    board_group_id: typeof chat.boardGroupId === 'string' ? chat.boardGroupId : '',
    board_task_id: typeof chat.boardTaskId === 'string' ? chat.boardTaskId : '',
    worktree_root: typeof chat.worktreeRoot === 'string' ? chat.worktreeRoot : '',
    git_branch: typeof chat.gitBranch === 'string' ? chat.gitBranch : '',
    updated_at: typeof chat.updatedAt === 'number' ? chat.updatedAt : 0,
    last_message_at: typeof chat.lastMessageAt === 'number' ? chat.lastMessageAt : 0,
    last_assistant_at: typeof chat.lastAssistantAt === 'number' ? chat.lastAssistantAt : 0,
    unread: chat.unread === true ? 1 : 0,
    turn_error: chat.turnError === true ? 1 : 0,
    message_count: derived.messageCount,
    last_message_preview: derived.lastMessagePreview,
    history_digest: derived.historyDigest,
    meta_json: JSON.stringify(meta),
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {number} seq
 * @param {Record<string, unknown>} message
 */
export function upsertMessageRow(db, chatId, seq, message) {
  const payloadJson = JSON.stringify(message);
  const rowHash = hashPayload(payloadJson);
  const text = messageTextContent(message);
  const role = typeof message.role === 'string' ? message.role : '';
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? 1 : 0;
  const hasAttachments =
    Array.isArray(message.attachments) && message.attachments.length > 0 ? 1 : 0;
  const hidden = message.hidden === true ? 1 : 0;

  db.prepare(
    `INSERT INTO messages (
       chat_id, seq, payload_json, role, tool_call_id, has_tool_calls,
       has_attachments, hidden, text_len, row_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, seq) DO UPDATE SET
       payload_json = excluded.payload_json,
       role = excluded.role,
       tool_call_id = excluded.tool_call_id,
       has_tool_calls = excluded.has_tool_calls,
       has_attachments = excluded.has_attachments,
       hidden = excluded.hidden,
       text_len = excluded.text_len,
       row_hash = excluded.row_hash`,
  ).run(
    chatId,
    seq,
    payloadJson,
    role,
    toolCallId,
    hasToolCalls,
    hasAttachments,
    hidden,
    text.length,
    rowHash,
  );

  db.prepare('DELETE FROM messages_fts WHERE chat_id = ? AND seq = ?').run(chatId, seq);
  db.prepare(
    `INSERT INTO messages_fts (chat_id, seq, role, body) VALUES (?, ?, ?, ?)`,
  ).run(chatId, seq, role, text);

  return rowHash;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {number} seq
 * @param {Record<string, any>} record
 */
export function upsertTerminalHistoryRow(db, chatId, seq, record) {
  db.prepare(
    `INSERT INTO chat_terminal_history (
       chat_id, seq, id, command, cwd, source, tool_call_id,
       started_at, finished_at, exit_code, timed_out, log_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, seq) DO UPDATE SET
       id = excluded.id,
       command = excluded.command,
       cwd = excluded.cwd,
       source = excluded.source,
       tool_call_id = excluded.tool_call_id,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       exit_code = excluded.exit_code,
       timed_out = excluded.timed_out,
       log_path = excluded.log_path`,
  ).run(
    chatId,
    seq,
    typeof record.id === 'string' ? record.id : '',
    typeof record.command === 'string' ? record.command : '',
    typeof record.cwd === 'string' ? record.cwd : '',
    record.source === 'user' ? 'user' : 'agent',
    typeof record.toolCallId === 'string' ? record.toolCallId : '',
    typeof record.startedAt === 'number' ? record.startedAt : 0,
    typeof record.finishedAt === 'number' ? record.finishedAt : 0,
    typeof record.exitCode === 'number' ? record.exitCode : null,
    record.timedOut === true ? 1 : 0,
    typeof record.logPath === 'string' ? record.logPath : '',
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>} run
 */
export function upsertChatRunRow(db, chatId, run) {
  const runId = typeof run.runId === 'string' ? run.runId : '';
  if (!runId) return;
  db.prepare(
    `INSERT INTO chat_runs (chat_id, run_id, branch_id, fork_history_index, status, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, run_id) DO UPDATE SET
       branch_id = excluded.branch_id,
       fork_history_index = excluded.fork_history_index,
       status = excluded.status,
       payload_json = excluded.payload_json`,
  ).run(
    chatId,
    runId,
    typeof run.branchId === 'string' ? run.branchId : '',
    typeof run.forkHistoryIndex === 'number' ? run.forkHistoryIndex : 0,
    typeof run.status === 'string' ? run.status : '',
    JSON.stringify(run),
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>} run
 */
export function upsertSubAgentRunRow(db, chatId, run) {
  const runId = typeof run.runId === 'string' ? run.runId : '';
  if (!runId) return;
  db.prepare(
    `INSERT INTO chat_sub_agent_runs (chat_id, run_id, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id, run_id) DO UPDATE SET payload_json = excluded.payload_json`,
  ).run(chatId, runId, JSON.stringify(run));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>} loop
 */
export function upsertChatLoopRow(db, chatId, loop) {
  const loopId = typeof loop.id === 'number' ? loop.id : Number(loop.id);
  if (!Number.isFinite(loopId)) return;
  db.prepare(
    `INSERT INTO chat_loops (chat_id, loop_id, due_at, paused, payload_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, loop_id) DO UPDATE SET
       due_at = excluded.due_at,
       paused = excluded.paused,
       payload_json = excluded.payload_json`,
  ).run(
    chatId,
    loopId,
    typeof loop.dueAt === 'number' ? loop.dueAt : 0,
    loop.paused === true ? 1 : 0,
    JSON.stringify(loop),
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} group
 */
export function upsertGroupRow(db, group) {
  const board = group.orchestrateBoard && typeof group.orchestrateBoard === 'object'
    ? { ...group.orchestrateBoard }
    : null;
  if (board) {
    delete board.tasks;
    delete board.log;
  }

  /** @type {Record<string, unknown>} */
  const payload = { ...group };
  delete payload.orchestrateBoard;

  db.prepare(
    `INSERT INTO groups (
       id, name, workspace_path, collapsed, sort_order, created_at,
       orchestrate_plan_path, view_mode, planner_chat_id, board_state_json, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       workspace_path = excluded.workspace_path,
       collapsed = excluded.collapsed,
       sort_order = excluded.sort_order,
       created_at = excluded.created_at,
       orchestrate_plan_path = excluded.orchestrate_plan_path,
       view_mode = excluded.view_mode,
       planner_chat_id = excluded.planner_chat_id,
       board_state_json = excluded.board_state_json,
       payload_json = excluded.payload_json`,
  ).run(
    String(group.id ?? ''),
    typeof group.name === 'string' ? group.name : '',
    typeof group.workspacePath === 'string' ? group.workspacePath : '',
    group.collapsed === true ? 1 : 0,
    typeof group.order === 'number' ? group.order : 0,
    typeof group.createdAt === 'number' ? group.createdAt : 0,
    typeof group.orchestratePlanPath === 'string' ? group.orchestratePlanPath : '',
    typeof group.viewMode === 'string' ? group.viewMode : '',
    typeof group.plannerChatId === 'string' ? group.plannerChatId : '',
    JSON.stringify(board ?? {}),
    JSON.stringify(payload),
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} groupId
 * @param {Record<string, any>} task
 */
export function upsertBoardTaskRow(db, groupId, task) {
  const taskId = typeof task.id === 'string' ? task.id : '';
  if (!taskId) return;
  db.prepare(
    `INSERT INTO board_tasks (
       group_id, task_id, worktree_path, dev_port, api_port, chat_id, status, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, task_id) DO UPDATE SET
       worktree_path = excluded.worktree_path,
       dev_port = excluded.dev_port,
       api_port = excluded.api_port,
       chat_id = excluded.chat_id,
       status = excluded.status,
       payload_json = excluded.payload_json`,
  ).run(
    groupId,
    taskId,
    typeof task.worktreePath === 'string' ? task.worktreePath : '',
    typeof task.devPort === 'number' ? task.devPort : 0,
    typeof task.apiPort === 'number' ? task.apiPort : 0,
    typeof task.chatId === 'string' ? task.chatId : '',
    typeof task.status === 'string' ? task.status : '',
    JSON.stringify(task),
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} groupId
 * @param {Record<string, any>} event
 */
export function insertBoardLogRow(db, groupId, event) {
  db.prepare(
    `INSERT INTO board_log (group_id, event_id, ts, type, level, task_id, message, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    groupId,
    typeof event.id === 'string' ? event.id : '',
    typeof event.ts === 'number' ? event.ts : 0,
    typeof event.type === 'string' ? event.type : '',
    typeof event.level === 'string' ? event.level : 'info',
    typeof event.taskId === 'string' ? event.taskId : '',
    typeof event.message === 'string' ? event.message : '',
    JSON.stringify(event.detail && typeof event.detail === 'object' ? event.detail : {}),
  );
}

export function trimBoardLog(db, groupId) {
  db.prepare(
    `DELETE FROM board_log
     WHERE group_id = ?
       AND seq NOT IN (
         SELECT seq FROM board_log WHERE group_id = ? ORDER BY seq DESC LIMIT ?
       )`,
  ).run(groupId, groupId, BOARD_LOG_MAX);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} state
 */
export function writeValidatedSessionState(db, state) {
  writeSessionMeta(db, 'schemaVersion', state.version ?? 6);
  writeSessionMeta(db, 'activeId', state.activeId ?? '');
  writeSessionMeta(db, 'sidebarCollapsed', !!state.sidebarCollapsed);
  if (typeof state.sidebarWidth === 'number') {
    writeSessionMeta(db, 'sidebarWidth', state.sidebarWidth);
  }
  if (typeof state.activeBoardGroupId === 'string') {
    writeSessionMeta(db, 'activeBoardGroupId', state.activeBoardGroupId);
  } else {
    writeSessionMeta(db, 'activeBoardGroupId', null);
  }
  writeSessionMeta(db, 'lastActiveChatIdByWorkspace', state.lastActiveChatIdByWorkspace ?? {});
  writeSessionMeta(db, 'lastActiveChatIdByApp', state.lastActiveChatIdByApp ?? {});
  if (state.codeChangeTotalsByWorkspace) {
    writeSessionMeta(db, 'codeChangeTotalsByWorkspace', state.codeChangeTotalsByWorkspace);
  }

  const groups = Array.isArray(state.groups) ? state.groups : [];
  for (const group of groups) {
    if (!group?.id) continue;
    upsertGroupRow(db, group);
    const board = group.orchestrateBoard;
    const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
    for (const task of tasks) {
      upsertBoardTaskRow(db, group.id, task);
    }
    const log = Array.isArray(board?.log) ? board.log : [];
    for (const event of log) {
      insertBoardLogRow(db, group.id, event);
    }
    trimBoardLog(db, group.id);
  }

  const chats = Array.isArray(state.chats) ? state.chats : [];
  chats.forEach((chat, sortIndex) => {
    if (!chat?.id) return;
    const history = Array.isArray(chat.history) ? chat.history : [];
    const last = history.length ? history[history.length - 1] : null;
    const preview = last ? messageTextContent(last).slice(0, 240) : '';

    upsertChatRow(db, chat, sortIndex, {
      messageCount: history.length,
      lastMessagePreview: preview,
      historyDigest: '',
    });

    const rowHashes = [];
    history.forEach((message, seq) => {
      rowHashes.push(upsertMessageRow(db, chat.id, seq, message));
    });

    upsertChatRow(db, chat, sortIndex, {
      messageCount: history.length,
      lastMessagePreview: preview,
      historyDigest: hashPayload(rowHashes.join('\n')),
    });

    const terminalHistory = Array.isArray(chat.terminalHistory) ? chat.terminalHistory : [];
    terminalHistory.forEach((record, seq) => {
      upsertTerminalHistoryRow(db, chat.id, seq, record);
    });

    const runs = Array.isArray(chat.runs) ? chat.runs : [];
    for (const run of runs) {
      upsertChatRunRow(db, chat.id, run);
    }

    const subAgentRuns = Array.isArray(chat.subAgentRuns) ? chat.subAgentRuns : [];
    for (const run of subAgentRuns) {
      upsertSubAgentRunRow(db, chat.id, run);
    }

    const loops = Array.isArray(chat.activeLoops) ? chat.activeLoops : [];
    for (const loop of loops) {
      upsertChatLoopRow(db, chat.id, loop);
    }
  });
}

/**
 * @param {string[]} candidates
 * @returns {{ path: string, raw: string } | { path: null, raw: null, enoent: true } | never}
 */
function readFirstJsonFile(candidates) {
  let sawEnoent = false;
  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return { path: filePath, raw };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        sawEnoent = true;
        continue;
      }
      throw err;
    }
  }
  if (sawEnoent) {
    return { path: null, raw: null, enoent: true };
  }
  return { path: null, raw: null, enoent: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ recovery?: boolean }} [options]
 */
export function importJsonSessionsIfNeeded(db, options = {}) {
  if (readSessionMeta(db, 'jsonImportedAt')) {
    return { migrated: false, reason: 'already_migrated' };
  }

  // Recovery fallback only: snapshots (server/config/sessions-snapshot.js) are
  // tried first, and `.migrated` is all that is left for a very old profile that
  // never got past the one-time JSON import.
  const candidates = options.recovery ? [sessionsJsonMigratedPath()] : [sessionsJsonPath()];

  let filePath;
  let raw;
  try {
    const result = readFirstJsonFile(candidates);
    if (result.enoent) {
      writeSessionMeta(db, 'jsonImportedAt', nowIso());
      return { migrated: false, reason: 'no_json' };
    }
    filePath = result.path;
    raw = result.raw;
  } catch (err) {
    writeSessionMeta(db, 'jsonImportFailedAt', nowIso());
    writeSessionMeta(db, 'jsonImportFailedMessage', String(/** @type {Error} */ (err).message ?? err));
    return { migrated: false, reason: 'read_failed', error: String(err) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    writeSessionMeta(db, 'jsonImportFailedAt', nowIso());
    writeSessionMeta(db, 'jsonImportFailedMessage', String(/** @type {Error} */ (err).message ?? err));
    return { migrated: false, reason: 'invalid_json', error: String(err) };
  }

  let state;
  try {
    state = validateSessionState(parsed);
  } catch (err) {
    writeSessionMeta(db, 'jsonImportFailedAt', nowIso());
    writeSessionMeta(db, 'jsonImportFailedMessage', String(/** @type {Error} */ (err).message ?? err));
    return { migrated: false, reason: 'validation_failed', error: String(err) };
  }

  const expectedChats = Array.isArray(state.chats) ? state.chats.length : 0;
  const expectedMessages = Array.isArray(state.chats)
    ? state.chats.reduce((sum, chat) => sum + (Array.isArray(chat.history) ? chat.history.length : 0), 0)
    : 0;

  const tx = db.transaction(() => {
    writeValidatedSessionState(db, state);
    writeSessionMeta(db, 'jsonImportedAt', nowIso());
    writeSessionMeta(db, 'jsonImportFailedAt', null);
    writeSessionMeta(db, 'jsonImportFailedMessage', null);
  });
  tx();

  const chatCount = db.prepare('SELECT COUNT(*) AS n FROM chats').get()?.n ?? 0;
  const messageCount = db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n ?? 0;

  if (chatCount >= expectedChats && messageCount >= expectedMessages) {
    if (filePath === sessionsJsonPath()) {
      try {
        fs.renameSync(filePath, sessionsJsonMigratedPath());
      } catch {
      }
    }
  }

  return {
    migrated: true,
    chats: expectedChats,
    messages: expectedMessages,
    sourcePath: filePath,
  };
}
