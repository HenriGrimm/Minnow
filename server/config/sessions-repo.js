import path from 'node:path';
import { defaultSessionStateJson } from './home.js';
import {
  getSessionsDb,
  readSessionMeta,
  writeSessionMeta,
} from './sessions-db.js';
import {
  hashPayload,
  insertBoardLogRow,
  messageTextContent,
  trimBoardLog,
  upsertBoardTaskRow,
  upsertChatLoopRow,
  upsertChatRow,
  upsertChatRunRow,
  upsertGroupRow,
  upsertMessageRow,
  upsertSubAgentRunRow,
  upsertTerminalHistoryRow,
} from './sessions-import.js';
import {
  migrateChatRowV5ToV6,
  normalizeChatRow,
  normalizeGroupRow,
  normalizeSessionScalars,
  normalizeWorkspacePath,
  SESSION_SCHEMA_VERSION,
  validateSessionState,
} from './validators.js';

import { recallQueryTerms, runRecallHistory } from '../runner/compaction/recall.js';
import { isUiOnlyTranscriptRole } from '../runner/injection-notice.js';

const MAX_TERMINAL_HISTORY = 50;

const PRUNE_GUARD_MIN_CHATS = 5;
const PRUNE_GUARD_MAX_RATIO = 0.5;

export function readSessionRevision() {
  const value = readSessionMeta(getSessionsDb(), 'revision');
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bumpSessionRevision() {
  const db = getSessionsDb();
  const current = readSessionMeta(db, 'revision');
  const next = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1;
  writeSessionMeta(db, 'revision', next);
  return next;
}

/**
 * @param {unknown} baseRevision
 */
function assertSessionRevision(baseRevision) {
  if (baseRevision === undefined || baseRevision === null) return;
  const expected = Number(baseRevision);
  if (!Number.isFinite(expected)) return;
  const current = readSessionRevision();
  if (expected === current) return;
  const err = new Error('Session state changed in another window');
  /** @type {Error & { statusCode?: number, revision?: number }} */ (err).statusCode = 409;
  /** @type {Error & { revision?: number }} */ (err).revision = current;
  throw err;
}

/** @type {WeakMap<import('better-sqlite3').Database, Record<string, import('better-sqlite3').Statement>>} */
const readStmtsByDb = new WeakMap();

/**
 * @param {import('better-sqlite3').Database} db
 */
function getReadStmts(db) {
  let stmts = readStmtsByDb.get(db);
  if (stmts) return stmts;
  stmts = {
    chats: db.prepare('SELECT * FROM chats ORDER BY sort_index ASC, id ASC'),
    messages: db.prepare(
      'SELECT chat_id, seq, payload_json FROM messages ORDER BY chat_id ASC, seq ASC',
    ),
    terminal: db.prepare(
      'SELECT * FROM chat_terminal_history ORDER BY chat_id ASC, seq ASC',
    ),
    runs: db.prepare(
      'SELECT chat_id, run_id, payload_json FROM chat_runs ORDER BY chat_id ASC, run_id ASC',
    ),
    subAgentRuns: db.prepare(
      'SELECT chat_id, run_id, payload_json FROM chat_sub_agent_runs ORDER BY chat_id ASC, run_id ASC',
    ),
    loops: db.prepare(
      'SELECT chat_id, loop_id, payload_json FROM chat_loops ORDER BY chat_id ASC, loop_id ASC',
    ),
    groups: db.prepare('SELECT * FROM groups ORDER BY sort_order ASC, id ASC'),
    boardTasks: db.prepare(
      'SELECT group_id, task_id, payload_json FROM board_tasks ORDER BY group_id ASC, task_id ASC',
    ),
    boardLog: db.prepare(
      'SELECT * FROM board_log ORDER BY group_id ASC, seq ASC',
    ),
    sessionMeta: db.prepare('SELECT key, value FROM session_meta'),
    chatIds: db.prepare('SELECT id FROM chats ORDER BY sort_index ASC, id ASC'),
  };
  readStmtsByDb.set(db, stmts);
  return stmts;
}

function parseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFn
 */
function bucketBy(rows, keyFn) {
  /** @type {Map<string, T[]>} */
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function terminalRowToRecord(row) {
  /** @type {Record<string, unknown>} */
  const record = {
    id: typeof row.id === 'string' ? row.id : '',
    command: typeof row.command === 'string' ? row.command : '',
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    source: row.source === 'user' ? 'user' : 'agent',
    startedAt: typeof row.started_at === 'number' ? row.started_at : 0,
    finishedAt: typeof row.finished_at === 'number' ? row.finished_at : 0,
    timedOut: row.timed_out === 1,
    logPath: typeof row.log_path === 'string' ? row.log_path : '',
  };
  if (typeof row.tool_call_id === 'string' && row.tool_call_id) {
    record.toolCallId = row.tool_call_id;
  }
  if (typeof row.exit_code === 'number') {
    record.exitCode = row.exit_code;
  }
  return record;
}

function boardLogRowToEvent(row) {
  const detail = parseJson(row.detail_json, {});
  /** @type {Record<string, unknown>} */
  const event = {
    id: typeof row.event_id === 'string' ? row.event_id : '',
    ts: typeof row.ts === 'number' ? row.ts : 0,
    type: typeof row.type === 'string' ? row.type : '',
    level: typeof row.level === 'string' ? row.level : 'info',
    message: typeof row.message === 'string' ? row.message : '',
  };
  if (typeof row.task_id === 'string' && row.task_id) {
    event.taskId = row.task_id;
  }
  if (detail && typeof detail === 'object' && Object.keys(detail).length > 0) {
    event.detail = detail;
  }
  return event;
}

/**
 * @param {Record<string, any>} row
 * @param {{ messages: unknown[], terminalHistory: Record<string, unknown>[], runs: unknown[], subAgentRuns: unknown[], activeLoops: unknown[], }} children
 */
function stitchChat(row, children) {
  const meta = parseJson(row.meta_json, {});
  /** @type {Record<string, unknown>} */
  const chat = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    id: row.id,
    name: row.name ?? '',
    history: children.messages,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
    lastMessageAt: typeof row.last_message_at === 'number' ? row.last_message_at : 0,
  };

  if (row.kind) chat.kind = row.kind;
  // Stored app_scope calendar/email (removed apps) is dropped.
  if (row.expert_id) chat.expertId = row.expert_id;
  if (row.workspace_path) chat.workspacePath = row.workspace_path;
  else chat.workspacePath = '';
  if (row.provider_id) chat.providerId = row.provider_id;
  chat.modelId = typeof row.model_id === 'string' ? row.model_id : '';
  if (row.mode_id) chat.modeId = row.mode_id;
  if (row.group_id) chat.groupId = row.group_id;
  if (row.board_group_id) chat.boardGroupId = row.board_group_id;
  if (row.board_task_id) chat.boardTaskId = row.board_task_id;
  if (row.worktree_root) chat.worktreeRoot = row.worktree_root;
  if (row.git_branch) chat.gitBranch = row.git_branch;
  if (row.unread === 1) chat.unread = true;
  if (row.turn_error === 1) chat.turnError = true;
  if (typeof row.last_assistant_at === 'number' && row.last_assistant_at > 0) {
    chat.lastAssistantAt = row.last_assistant_at;
  }

  if (children.terminalHistory.length) {
    chat.terminalHistory = children.terminalHistory;
  }
  if (children.runs.length) chat.runs = children.runs;
  if (children.subAgentRuns.length) chat.subAgentRuns = children.subAgentRuns;
  if (children.activeLoops.length) chat.activeLoops = children.activeLoops;

  return chat;
}

/**
 * @param {Record<string, any>} row
 * @param {unknown[]} tasks
 * @param {Record<string, unknown>[]} log
 */
function stitchGroup(row, tasks, log) {
  const payload = parseJson(row.payload_json, {});
  const boardState = parseJson(row.board_state_json, {});
  /** @type {Record<string, unknown>} */
  const group = {
    ...(payload && typeof payload === 'object' ? payload : {}),
    id: row.id,
    name: row.name ?? '',
    workspacePath: row.workspace_path ?? '',
    collapsed: row.collapsed === 1,
    order: typeof row.sort_order === 'number' ? row.sort_order : 0,
    createdAt: typeof row.created_at === 'number' ? row.created_at : 0,
  };
  if (row.orchestrate_plan_path) {
    group.orchestratePlanPath = row.orchestrate_plan_path;
  }
  if (row.view_mode) group.viewMode = row.view_mode;
  if (row.planner_chat_id) group.plannerChatId = row.planner_chat_id;

  const hasBoard =
    (boardState && typeof boardState === 'object' && Object.keys(boardState).length > 0) ||
    tasks.length > 0 ||
    log.length > 0;
  if (hasBoard) {
    group.orchestrateBoard = {
      ...(boardState && typeof boardState === 'object' ? boardState : {}),
      tasks,
      log,
    };
  }
  return group;
}

export function readWholeSessionState() {
  const db = getSessionsDb();
  const stmts = getReadStmts(db);

  const chatRows = stmts.chats.all();
  if (!chatRows.length) {
    return defaultSessionStateJson();
  }

  const messageRows = stmts.messages.all();
  const terminalRows = stmts.terminal.all();
  const runRows = stmts.runs.all();
  const subAgentRows = stmts.subAgentRuns.all();
  const loopRows = stmts.loops.all();
  const groupRows = stmts.groups.all();
  const boardTaskRows = stmts.boardTasks.all();
  const boardLogRows = stmts.boardLog.all();
  void stmts.sessionMeta.all();

  const messagesByChat = bucketBy(messageRows, (r) => r.chat_id);
  const terminalByChat = bucketBy(terminalRows, (r) => r.chat_id);
  const runsByChat = bucketBy(runRows, (r) => r.chat_id);
  const subAgentsByChat = bucketBy(subAgentRows, (r) => r.chat_id);
  const loopsByChat = bucketBy(loopRows, (r) => r.chat_id);
  const tasksByGroup = bucketBy(boardTaskRows, (r) => r.group_id);
  const logByGroup = bucketBy(boardLogRows, (r) => r.group_id);

  const chats = chatRows.map((row) => {
    const messages = (messagesByChat.get(row.id) ?? []).map((m) =>
      parseJson(m.payload_json, null),
    ).filter((m) => m && typeof m === 'object');
    const terminalHistory = (terminalByChat.get(row.id) ?? []).map(terminalRowToRecord);
    const runs = (runsByChat.get(row.id) ?? []).map((r) => parseJson(r.payload_json, null)).filter(
      (r) => r && typeof r === 'object',
    );
    const subAgentRuns = (subAgentsByChat.get(row.id) ?? [])
      .map((r) => parseJson(r.payload_json, null))
      .filter((r) => r && typeof r === 'object');
    const activeLoops = (loopsByChat.get(row.id) ?? [])
      .map((r) => parseJson(r.payload_json, null))
      .filter((r) => r && typeof r === 'object');
    return stitchChat(row, {
      messages,
      terminalHistory,
      runs,
      subAgentRuns,
      activeLoops,
    });
  });

  const groups = groupRows.map((row) => {
    const tasks = (tasksByGroup.get(row.id) ?? [])
      .map((t) => parseJson(t.payload_json, null))
      .filter((t) => t && typeof t === 'object');
    const log = (logByGroup.get(row.id) ?? []).map(boardLogRowToEvent);
    return stitchGroup(row, tasks, log);
  });

  /** @type {Record<string, unknown>} */
  const raw = {
    version: readSessionMeta(db, 'schemaVersion') ?? 6,
    activeId: readSessionMeta(db, 'activeId') ?? '',
    sidebarCollapsed: !!readSessionMeta(db, 'sidebarCollapsed'),
    lastActiveChatIdByWorkspace: readSessionMeta(db, 'lastActiveChatIdByWorkspace') ?? {},
    lastActiveChatIdByApp: readSessionMeta(db, 'lastActiveChatIdByApp') ?? {},
    groups,
    chats,
  };

  const sidebarWidth = readSessionMeta(db, 'sidebarWidth');
  if (typeof sidebarWidth === 'number') raw.sidebarWidth = sidebarWidth;
  const activeBoardGroupId = readSessionMeta(db, 'activeBoardGroupId');
  if (typeof activeBoardGroupId === 'string' && activeBoardGroupId) {
    raw.activeBoardGroupId = activeBoardGroupId;
  }
  const lastBoardGroupId = readSessionMeta(db, 'lastBoardGroupId');
  if (typeof lastBoardGroupId === 'string' && lastBoardGroupId) {
    raw.lastBoardGroupId = lastBoardGroupId;
  }
  const codeChangeTotalsByWorkspace = readSessionMeta(db, 'codeChangeTotalsByWorkspace');
  if (codeChangeTotalsByWorkspace && typeof codeChangeTotalsByWorkspace === 'object') {
    raw.codeChangeTotalsByWorkspace = codeChangeTotalsByWorkspace;
  }

  return validateSessionState(raw);
}

/**
 * @param {unknown} raw
 */
function wireChatIncludesHistory(raw) {
  return (
    raw &&
    typeof raw === 'object' &&
    Object.prototype.hasOwnProperty.call(raw, 'history')
  );
}

/**
 * @param {unknown[]} rawChats
 * @returns {Map<string, Record<string, unknown>>}
 */
function indexRawWireChats(rawChats) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  if (!Array.isArray(rawChats)) return map;
  for (const raw of rawChats) {
    if (!raw || typeof raw !== 'object') continue;
    const id = /** @type {Record<string, unknown>} */ (raw).id;
    if (typeof id === 'string' && id) {
      map.set(id, /** @type {Record<string, unknown>} */ (raw));
    }
  }
  return map;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 */
function readChatMessageDerived(db, chatId) {
  const row = db
    .prepare(
      'SELECT message_count, last_message_preview, history_digest FROM chats WHERE id = ?',
    )
    .get(chatId);
  if (!row) {
    return { messageCount: 0, lastMessagePreview: '', historyDigest: '' };
  }
  return {
    messageCount: row.message_count ?? 0,
    lastMessagePreview: row.last_message_preview ?? '',
    historyDigest: row.history_digest ?? '',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} chat
 * @param {number} sortIndex
 * @param {boolean} syncHistory
 * @returns {boolean}
 */
function upsertChatWithOptionalHistory(db, chat, sortIndex, syncHistory) {
  const chatId = String(chat.id);
  if (syncHistory) {
    const history = Array.isArray(chat.history) ? chat.history : [];
    upsertChatRow(db, chat, sortIndex, {
      messageCount: history.length,
      lastMessagePreview: '',
      historyDigest: '',
    });
    const derived = syncMessages(db, chatId, history);
    upsertChatRow(db, chat, sortIndex, derived);
  } else {
    const existing = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
    if (!existing) {
      console.warn(
        `[sessions] refusing to create chat ${chatId} from a history-omitting write`,
      );
      return false;
    }
    const derived = readChatMessageDerived(db, chatId);
    upsertChatRow(db, chat, sortIndex, derived);
  }
  syncChatRuns(db, chatId, Array.isArray(chat.runs) ? chat.runs : []);
  syncSubAgentRuns(db, chatId, Array.isArray(chat.subAgentRuns) ? chat.subAgentRuns : []);
  syncChatLoops(db, chatId, Array.isArray(chat.activeLoops) ? chat.activeLoops : []);
  return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} chatIds
 * @returns {number}
 */
function deleteChatRows(db, chatIds) {
  const delFts = db.prepare('DELETE FROM messages_fts WHERE chat_id = ?');
  const delChat = db.prepare('DELETE FROM chats WHERE id = ?');
  let removed = 0;
  for (const rawId of chatIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    delFts.run(id);
    const result = delChat.run(id);
    if (result.changes > 0) removed += 1;
  }
  return removed;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, unknown>[]} history
 * @returns {{ messageCount: number, lastMessagePreview: string, historyDigest: string }}
 */
export function syncMessages(db, chatId, history) {
  const messages = Array.isArray(history) ? history : [];
  const hashes = messages.map((message) => hashPayload(JSON.stringify(message)));
  const historyDigest = hashPayload(hashes.join('\n'));
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastMessagePreview = last ? messageTextContent(last).slice(0, 240) : '';
  const derived = {
    messageCount: messages.length,
    lastMessagePreview,
    historyDigest,
  };

  const chatRow = db
    .prepare('SELECT message_count, history_digest FROM chats WHERE id = ?')
    .get(chatId);
  if (
    chatRow &&
    chatRow.message_count === messages.length &&
    chatRow.history_digest === historyDigest
  ) {
    return derived;
  }

  const before = chatRow?.message_count ?? 0;
  if (before > 0 && messages.length < before) {
    console.warn(
      `[sessions] chat ${chatId} history ${before} → ${messages.length} messages`,
    );
  }

  const existing = db
    .prepare('SELECT seq, row_hash FROM messages WHERE chat_id = ? ORDER BY seq ASC')
    .all(chatId);

  let k = 0;
  const limit = Math.min(existing.length, messages.length);
  while (k < limit && existing[k].row_hash === hashes[k]) {
    k += 1;
  }

  if (k < existing.length) {
    db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(chatId, k);
    db.prepare('DELETE FROM messages_fts WHERE chat_id = ? AND seq >= ?').run(chatId, k);
  } else if (messages.length < existing.length) {
    db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(
      chatId,
      messages.length,
    );
    db.prepare('DELETE FROM messages_fts WHERE chat_id = ? AND seq >= ?').run(
      chatId,
      messages.length,
    );
  }

  for (let seq = k; seq < messages.length; seq += 1) {
    upsertMessageRow(db, chatId, seq, messages[seq]);
  }

  return derived;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>[]} runs
 */
function syncChatRuns(db, chatId, runs) {
  const list = Array.isArray(runs) ? runs : [];
  const keep = [];
  for (const run of list) {
    const runId = typeof run?.runId === 'string' ? run.runId : '';
    if (!runId) continue;
    keep.push(runId);
    upsertChatRunRow(db, chatId, run);
  }
  if (keep.length === 0) {
    db.prepare('DELETE FROM chat_runs WHERE chat_id = ?').run(chatId);
    return;
  }
  const placeholders = keep.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM chat_runs WHERE chat_id = ? AND run_id NOT IN (${placeholders})`,
  ).run(chatId, ...keep);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>[]} runs
 */
function syncSubAgentRuns(db, chatId, runs) {
  const list = Array.isArray(runs) ? runs : [];
  const keep = [];
  for (const run of list) {
    const runId = typeof run?.runId === 'string' ? run.runId : '';
    if (!runId) continue;
    keep.push(runId);
    upsertSubAgentRunRow(db, chatId, run);
  }
  if (keep.length === 0) {
    db.prepare('DELETE FROM chat_sub_agent_runs WHERE chat_id = ?').run(chatId);
    return;
  }
  const placeholders = keep.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM chat_sub_agent_runs WHERE chat_id = ? AND run_id NOT IN (${placeholders})`,
  ).run(chatId, ...keep);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} chatId
 * @param {Record<string, any>[]} loops
 */
function syncChatLoops(db, chatId, loops) {
  const list = Array.isArray(loops) ? loops : [];
  const keep = [];
  for (const loop of list) {
    const loopId = typeof loop?.id === 'number' ? loop.id : Number(loop?.id);
    if (!Number.isFinite(loopId)) continue;
    keep.push(loopId);
    upsertChatLoopRow(db, chatId, loop);
  }
  if (keep.length === 0) {
    db.prepare('DELETE FROM chat_loops WHERE chat_id = ?').run(chatId);
    return;
  }
  const placeholders = keep.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM chat_loops WHERE chat_id = ? AND loop_id NOT IN (${placeholders})`,
  ).run(chatId, ...keep);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} groupId
 * @param {Record<string, any>[]} tasks
 */
function syncBoardTasks(db, groupId, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const keep = [];
  for (const task of list) {
    const taskId = typeof task?.id === 'string' ? task.id : '';
    if (!taskId) continue;
    keep.push(taskId);
    upsertBoardTaskRow(db, groupId, task);
  }
  if (keep.length === 0) {
    db.prepare('DELETE FROM board_tasks WHERE group_id = ?').run(groupId);
    return;
  }
  const placeholders = keep.map(() => '?').join(', ');
  db.prepare(
    `DELETE FROM board_tasks WHERE group_id = ? AND task_id NOT IN (${placeholders})`,
  ).run(groupId, ...keep);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} groupId
 * @param {Record<string, any>[]} log
 */
function syncBoardLog(db, groupId, log) {
  db.prepare('DELETE FROM board_log WHERE group_id = ?').run(groupId);
  const list = Array.isArray(log) ? log : [];
  for (const event of list) {
    insertBoardLogRow(db, groupId, event);
  }
  trimBoardLog(db, groupId);
}

function writeScalars(db, state) {
  writeSessionMeta(db, 'schemaVersion', state.version ?? 6);
  writeSessionMeta(db, 'activeId', state.activeId ?? '');
  writeSessionMeta(db, 'sidebarCollapsed', !!state.sidebarCollapsed);
  if (typeof state.sidebarWidth === 'number') {
    writeSessionMeta(db, 'sidebarWidth', state.sidebarWidth);
  } else {
    writeSessionMeta(db, 'sidebarWidth', null);
  }
  if (typeof state.activeBoardGroupId === 'string') {
    writeSessionMeta(db, 'activeBoardGroupId', state.activeBoardGroupId);
  } else {
    writeSessionMeta(db, 'activeBoardGroupId', null);
  }
  if (typeof state.lastBoardGroupId === 'string') {
    writeSessionMeta(db, 'lastBoardGroupId', state.lastBoardGroupId);
  } else {
    writeSessionMeta(db, 'lastBoardGroupId', null);
  }
  writeSessionMeta(db, 'lastActiveChatIdByWorkspace', state.lastActiveChatIdByWorkspace ?? {});
  writeSessionMeta(db, 'lastActiveChatIdByApp', state.lastActiveChatIdByApp ?? {});
  if (state.codeChangeTotalsByWorkspace) {
    writeSessionMeta(db, 'codeChangeTotalsByWorkspace', state.codeChangeTotalsByWorkspace);
  } else {
    writeSessionMeta(db, 'codeChangeTotalsByWorkspace', null);
  }
}

/**
 * @param {Record<string, any>} state
 * @param {{ rawChats?: unknown[], deleteChatIds?: string[], deleteGroupIds?: string[], pruneMissingChats?: boolean, baseRevision?: number, }} [options]
 */
export function writeWholeSessionState(state, options = {}) {
  const db = getSessionsDb();
  const chats = Array.isArray(state.chats) ? state.chats : [];
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const rawById = indexRawWireChats(options.rawChats);
  const pruneMissing = options.pruneMissingChats === true;
  const deleteChatIds = Array.isArray(options.deleteChatIds) ? options.deleteChatIds : [];
  const deleteGroupIds = Array.isArray(options.deleteGroupIds) ? options.deleteGroupIds : [];

  const tx = db.transaction(() => {
    assertSessionRevision(options.baseRevision);
    writeScalars(db, state);

    deleteChatRows(db, deleteChatIds);
    for (const rawId of deleteGroupIds) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (id) db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    }

    const groupIds = [];
    for (const group of groups) {
      if (!group?.id) continue;
      groupIds.push(String(group.id));
      upsertGroupRow(db, group);
      const board = group.orchestrateBoard;
      syncBoardTasks(db, group.id, Array.isArray(board?.tasks) ? board.tasks : []);
      syncBoardLog(db, group.id, Array.isArray(board?.log) ? board.log : []);
    }
    if (pruneMissing) {
      if (groupIds.length === 0) {
        db.prepare('DELETE FROM groups').run();
      } else {
        const placeholders = groupIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM groups WHERE id NOT IN (${placeholders})`).run(...groupIds);
      }
    }

    const chatIds = [];
    chats.forEach((chat, sortIndex) => {
      if (!chat?.id) return;
      const chatId = String(chat.id);
      const hasHistoryKey =
        rawById.size === 0 || wireChatIncludesHistory(rawById.get(chatId) ?? {});

      if (upsertChatWithOptionalHistory(db, chat, sortIndex, hasHistoryKey)) {
        chatIds.push(chatId);
      }
    });

    if (pruneMissing) {
      const keep = new Set(chatIds);
      const stored = db.prepare('SELECT id FROM chats').all().map((row) => String(row.id));
      const doomed = stored.filter((id) => !keep.has(id));
      assertPruneIsSane(db, stored.length, doomed);
      deleteChatRows(db, doomed);
    }

    bumpSessionRevision();
  });
  tx();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} storedCount
 * @param {string[]} doomed
 */
function assertPruneIsSane(db, storedCount, doomed) {
  if (doomed.length === 0) return;
  const ratio = storedCount > 0 ? doomed.length / storedCount : 0;
  if (storedCount >= PRUNE_GUARD_MIN_CHATS && ratio > PRUNE_GUARD_MAX_RATIO) {
    const err = new Error(
      `Refusing to prune ${doomed.length} of ${storedCount} chats from one write`,
    );
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 409;
    throw err;
  }
  const messages = db
    .prepare(
      `SELECT COALESCE(SUM(message_count), 0) AS n FROM chats WHERE id IN (${doomed
        .map(() => '?')
        .join(', ')})`,
    )
    .get(...doomed);
  if ((messages?.n ?? 0) > 0) {
    console.warn(
      `[sessions] prune removing ${doomed.length} chats holding ${messages.n} messages`,
    );
  }
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} record
 */
export function appendTerminalRun(chatId, record) {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmed || !record || typeof record !== 'object') return;

  const db = getSessionsDb();
  const tx = db.transaction(() => {
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(trimmed);
    if (!chat) return;

    const countRow = db
      .prepare('SELECT COUNT(*) AS n FROM chat_terminal_history WHERE chat_id = ?')
      .get(trimmed);
    let count = countRow?.n ?? 0;
    while (count >= MAX_TERMINAL_HISTORY) {
      db.prepare(
        `DELETE FROM chat_terminal_history
         WHERE chat_id = ? AND seq = (
           SELECT MIN(seq) FROM chat_terminal_history WHERE chat_id = ?
         )`,
      ).run(trimmed, trimmed);
      count -= 1;
    }

    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) AS m FROM chat_terminal_history WHERE chat_id = ?',
      )
      .get(trimmed);
    const nextSeq = (maxRow?.m ?? -1) + 1;
    upsertTerminalHistoryRow(db, trimmed, nextSeq, record);
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), trimmed);
  });
  tx();
}

/**
 * @param {string} chatId
 * @returns {Record<string, unknown>[]}
 */
export function readTerminalHistory(chatId) {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmed) return [];
  const db = getSessionsDb();
  const rows = db
    .prepare(
      'SELECT * FROM chat_terminal_history WHERE chat_id = ? ORDER BY seq ASC',
    )
    .all(trimmed);
  return rows.map(terminalRowToRecord);
}

/**
 * @param {string} chatId
 * @returns {{ worktreeRoot: string | undefined, groupId: string | undefined }}
 */
export function resolveChatWorktreeContext(chatId) {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmed) return { worktreeRoot: undefined, groupId: undefined };

  const db = getSessionsDb();
  const chat = db
    .prepare(
      `SELECT worktree_root, board_group_id, board_task_id
       FROM chats WHERE id = ?`,
    )
    .get(trimmed);
  if (!chat) return { worktreeRoot: undefined, groupId: undefined };

  const groupId = chat.board_group_id?.trim() || undefined;
  const direct = chat.worktree_root?.trim();
  if (direct) return { worktreeRoot: direct, groupId };

  const taskId = chat.board_task_id?.trim();
  const gId = chat.board_group_id?.trim();
  if (!taskId || !gId) return { worktreeRoot: undefined, groupId };

  const task = db
    .prepare(
      `SELECT worktree_path FROM board_tasks
       WHERE group_id = ? AND task_id = ?`,
    )
    .get(gId, taskId);
  return {
    worktreeRoot: task?.worktree_path?.trim() || undefined,
    groupId,
  };
}

/**
 * @param {{ chatId?: string, cwd?: string }} params
 * @returns {{ devPort: number, apiPort: number } | undefined}
 */
export function resolveBoardTaskPorts({ chatId, cwd } = {}) {
  const db = getSessionsDb();
  const API_PORT_OFFSET = 100;
  const trimmedChatId = typeof chatId === 'string' ? chatId.trim() : '';
  let resolvedCwd = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : '';

  if (trimmedChatId) {
    const ctx = resolveChatWorktreeContext(trimmedChatId);
    if (ctx.worktreeRoot) resolvedCwd = path.resolve(ctx.worktreeRoot);
  }
  if (!resolvedCwd) return undefined;

  const normalize = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const target = normalize(resolvedCwd);

  if (trimmedChatId) {
    const chat = db
      .prepare('SELECT board_group_id, board_task_id FROM chats WHERE id = ?')
      .get(trimmedChatId);
    const taskId = chat?.board_task_id?.trim();
    const groupId = chat?.board_group_id?.trim();
    if (taskId && groupId) {
      const task = db
        .prepare(
          `SELECT worktree_path, dev_port, api_port
           FROM board_tasks WHERE group_id = ? AND task_id = ?`,
        )
        .get(groupId, taskId);
      const wt = task?.worktree_path?.trim();
      if (
        task &&
        wt &&
        normalize(wt) === target &&
        typeof task.dev_port === 'number' &&
        Number.isFinite(task.dev_port) &&
        task.dev_port > 0
      ) {
        const apiPort =
          typeof task.api_port === 'number' && Number.isFinite(task.api_port) && task.api_port > 0
            ? task.api_port
            : task.dev_port + API_PORT_OFFSET;
        return { devPort: task.dev_port, apiPort };
      }
    }
  }

  const rows = db
    .prepare(
      `SELECT worktree_path, dev_port, api_port FROM board_tasks
       WHERE worktree_path != '' AND dev_port > 0`,
    )
    .all();
  for (const row of rows) {
    const wt = row.worktree_path?.trim();
    if (!wt || normalize(wt) !== target) continue;
    const apiPort =
      typeof row.api_port === 'number' && Number.isFinite(row.api_port) && row.api_port > 0
        ? row.api_port
        : row.dev_port + API_PORT_OFFSET;
    return { devPort: row.dev_port, apiPort };
  }
  return undefined;
}

/**
 * @returns {{ chatId: string, providerId: string, modelId: string } | null}
 */
export function readActiveChatModelBinding() {
  const db = getSessionsDb();
  const activeId = readSessionMeta(db, 'activeId');
  if (typeof activeId !== 'string' || !activeId) return null;
  const chat = db
    .prepare('SELECT id, provider_id, model_id FROM chats WHERE id = ?')
    .get(activeId);
  if (!chat) return null;
  return {
    chatId: chat.id,
    providerId: typeof chat.provider_id === 'string' ? chat.provider_id : '',
    modelId: typeof chat.model_id === 'string' ? chat.model_id : '',
  };
}

export function readAllChatIds() {
  const db = getSessionsDb();
  return getReadStmts(db).chatIds.all().map((row) => row.id);
}

/**
 * @param {Record<string, any>} row
 * @param {{ terminalHistory?: Record<string, unknown>[], runs?: unknown[], subAgentRuns?: unknown[], activeLoops?: unknown[], }} [children]
 */
function chatRowToSummary(row, children = {}) {
  const stitched = stitchChat(row, {
    messages: [],
    terminalHistory: children.terminalHistory ?? [],
    runs: children.runs ?? [],
    subAgentRuns: children.subAgentRuns ?? [],
    activeLoops: children.activeLoops ?? [],
  });
  const { history: _history, ...rest } = stitched;
  void _history;
  /** @type {Record<string, unknown>} */
  const summary = {
    ...rest,
    messageCount: typeof row.message_count === 'number' ? row.message_count : 0,
    lastMessagePreview:
      typeof row.last_message_preview === 'string' ? row.last_message_preview : '',
  };
  if (typeof row.sort_index === 'number') summary.sortIndex = row.sort_index;
  if (typeof row.history_digest === 'string' && row.history_digest) {
    summary.historyDigest = row.history_digest;
  }
  return summary;
}

/**
 * @param {{ workspace?: string }} [filter]
 * @returns {Record<string, unknown>[]}
 */
export function readChatSummaries(filter = {}) {
  const db = getSessionsDb();
  const stmts = getReadStmts(db);
  const workspaceRaw = typeof filter.workspace === 'string' ? filter.workspace : '';
  const workspace = normalizeWorkspacePath(workspaceRaw);
  const rows = workspace
    ? db
        .prepare(
          'SELECT * FROM chats WHERE workspace_path = ? ORDER BY sort_index ASC, id ASC',
        )
        .all(workspace)
    : stmts.chats.all();

  const terminalByChat = bucketBy(stmts.terminal.all(), (r) => r.chat_id);
  const runsByChat = bucketBy(stmts.runs.all(), (r) => r.chat_id);
  const subAgentsByChat = bucketBy(stmts.subAgentRuns.all(), (r) => r.chat_id);
  const loopsByChat = bucketBy(stmts.loops.all(), (r) => r.chat_id);

  return rows.map((row) =>
    chatRowToSummary(row, {
      terminalHistory: (terminalByChat.get(row.id) ?? []).map(terminalRowToRecord),
      runs: (runsByChat.get(row.id) ?? [])
        .map((r) => parseJson(r.payload_json, null))
        .filter((r) => r && typeof r === 'object'),
      subAgentRuns: (subAgentsByChat.get(row.id) ?? [])
        .map((r) => parseJson(r.payload_json, null))
        .filter((r) => r && typeof r === 'object'),
      activeLoops: (loopsByChat.get(row.id) ?? [])
        .map((r) => parseJson(r.payload_json, null))
        .filter((r) => r && typeof r === 'object'),
    }),
  );
}

export function toSessionsFtsQuery(raw) {
  const terms = String(raw ?? '')
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, '').trim())
    .filter(Boolean);
  if (!terms.length) return '';
  return terms.map((term) => `"${term}"*`).join(' AND ');
}

/**
 * @param {{ q: string, workspace?: string, limit?: number }} opts
 * @returns {{ results: Array<Record<string, unknown>> }}
 */
export function searchSessionChats(opts) {
  const q = typeof opts?.q === 'string' ? opts.q.trim() : '';
  const limitRaw = typeof opts?.limit === 'number' ? opts.limit : 30;
  const limit = Math.min(100, Math.max(1, Math.floor(limitRaw) || 30));
  if (!q) return { results: [] };

  const db = getSessionsDb();
  const workspaceRaw = typeof opts?.workspace === 'string' ? opts.workspace : '';
  const workspace = normalizeWorkspacePath(workspaceRaw);
  const ftsQuery = toSessionsFtsQuery(q);
  const qLower = q.toLowerCase();
  const tokens = qLower.split(/\s+/).filter(Boolean);

  /** @type {Map<string, Record<string, unknown>>} */
  const byChatId = new Map();

  const titleRows = workspace
    ? db
        .prepare(
          `SELECT id, name, workspace_path, last_message_at, last_message_preview
           FROM chats WHERE workspace_path = ?`,
        )
        .all(workspace)
    : db
        .prepare(
          `SELECT id, name, workspace_path, last_message_at, last_message_preview
           FROM chats`,
        )
        .all();

  for (const row of titleRows) {
    const name = typeof row.name === 'string' ? row.name : '';
    const lower = name.toLowerCase();
    if (!tokens.every((t) => lower.includes(t))) continue;
    const preview =
      typeof row.last_message_preview === 'string' ? row.last_message_preview : '';
    byChatId.set(row.id, {
      chatId: row.id,
      name,
      workspacePath: row.workspace_path ?? '',
      lastMessageAt: typeof row.last_message_at === 'number' ? row.last_message_at : 0,
      score: 280,
      matchedIn: 'title',
      snippet: preview.slice(0, 110),
    });
  }

  if (ftsQuery) {
    const params = [ftsQuery];
    let workspaceClause = '';
    if (workspace) {
      workspaceClause = 'AND c.workspace_path = ?';
      params.push(workspace);
    }
    const msgRows = db
      .prepare(
        `SELECT f.chat_id AS chatId, f.role AS role, f.body AS body,
                c.name AS name, c.workspace_path AS workspacePath,
                c.last_message_at AS lastMessageAt,
                bm25(messages_fts) AS rank
         FROM messages_fts f
         JOIN chats c ON c.id = f.chat_id
         WHERE messages_fts MATCH ? ${workspaceClause}
         ORDER BY bm25(messages_fts) ASC, c.last_message_at DESC`,
      )
      .all(...params);

    for (const row of msgRows) {
      const chatId = row.chatId;
      const body = typeof row.body === 'string' ? row.body : '';
      const firstIdx = Math.max(
        0,
        ...tokens.map((t) => {
          const i = body.toLowerCase().indexOf(t);
          return i >= 0 ? i : 0;
        }),
      );
      const start = Math.max(0, firstIdx - 32);
      const snippet = `${start > 0 ? '…' : ''}${body
        .slice(start, start + 110)
        .replace(/\s+/g, ' ')
        .trim()}${start + 110 < body.length ? '…' : ''}`;
      const bm25 = typeof row.rank === 'number' ? row.rank : 0;
      const score = Math.max(1, 200 - bm25 * 10);
      const existing = byChatId.get(chatId);
      if (existing && existing.score >= score) continue;
      const role =
        row.role === 'user' || row.role === 'assistant' ? row.role : undefined;
      byChatId.set(chatId, {
        chatId,
        name: row.name ?? '',
        workspacePath: row.workspacePath ?? '',
        lastMessageAt: typeof row.lastMessageAt === 'number' ? row.lastMessageAt : 0,
        score,
        matchedIn: 'message',
        role,
        snippet,
      });
    }
  }

  const results = [...byChatId.values()].sort((a, b) => {
    if (a.score !== b.score) return /** @type {number} */ (b.score) - /** @type {number} */ (a.score);
    return (
      (/** @type {number} */ (b.lastMessageAt) || 0) -
      (/** @type {number} */ (a.lastMessageAt) || 0)
    );
  });

  return { results: results.slice(0, limit) };
}

/** Most FTS hits a recall ranking returns; fused with the local ranker downstream. */
const RECALL_RANK_LIMIT = 200;

/**
 * History indices of one chat's rows matching `query`, best first (FTS5 bm25,
 * porter-stemmed). Any term may match. UI-only rows (`context` / `injection`)
 * are never ranked: recall reads what the model once saw.
 *
 * @param {string} chatId
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {number[]}
 */
export function rankChatHistoryRows(chatId, query, opts = {}) {
  const id = typeof chatId === 'string' ? chatId.trim() : '';
  const terms = recallQueryTerms(query);
  if (!id || terms.length === 0) return [];
  const limit = Math.min(RECALL_RANK_LIMIT, Math.max(1, Math.floor(opts.limit ?? RECALL_RANK_LIMIT)));
  const match = terms.map((term) => `"${term.replace(/"/g, '')}"*`).join(' OR ');
  const rows = getSessionsDb()
    .prepare(
      `SELECT seq FROM messages_fts
       WHERE messages_fts MATCH ? AND chat_id = ? AND role IN ('user', 'assistant', 'tool')
       ORDER BY bm25(messages_fts) ASC, seq ASC
       LIMIT ?`,
    )
    .all(match, id, limit);
  return rows.map((row) => Number(row.seq)).filter(Number.isFinite);
}

/**
 * `recall_history` over a persisted chat: `rows` reads a verbatim slice, `q`
 * searches (FTS ranking fused with the in-memory BM25, which also sees tool-call
 * arguments the index does not store).
 *
 * @param {string} chatId
 * @param {{ q?: string, rows?: string, page?: number, include_tool_results?: boolean }} args
 * @returns {{ text: string, ranked: number[] }}
 */
export function recallChatHistory(chatId, args) {
  const history = readChatHistory(chatId);
  const entries = [];
  history.forEach((row, seq) => {
    if (row && typeof row === 'object' && !isUiOnlyTranscriptRole(row.role)) entries.push({ id: seq, row });
  });
  const query = typeof args?.q === 'string' ? args.q.trim() : '';
  const ranked = query && !args?.rows ? rankChatHistoryRows(chatId, query) : [];
  const text = runRecallHistory(
    entries,
    {
      ...(query ? { query } : {}),
      ...(args?.rows ? { rows: args.rows } : {}),
      ...(args?.page ? { page: args.page } : {}),
      ...(args?.include_tool_results ? { include_tool_results: true } : {}),
    },
    { ranking: ranked },
  );
  return { text, ranked };
}

/**
 * @param {string} chatId
 * @param {{ offset?: number, limit?: number }} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function readChatHistory(chatId, opts = {}) {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmed) return [];

  const db = getSessionsDb();
  const offset =
    typeof opts.offset === 'number' && Number.isFinite(opts.offset) && opts.offset > 0
      ? Math.floor(opts.offset)
      : 0;
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : null;

  let sql =
    'SELECT payload_json FROM messages WHERE chat_id = ? ORDER BY seq ASC';
  /** @type {unknown[]} */
  const params = [trimmed];
  if (limit != null) {
    sql += ' LIMIT ?';
    params.push(limit);
    if (offset > 0) {
      sql += ' OFFSET ?';
      params.push(offset);
    }
  } else if (offset > 0) {
    sql += ' LIMIT -1 OFFSET ?';
    params.push(offset);
  }

  const rows = db.prepare(sql).all(...params);
  return rows
    .map((row) => parseJson(row.payload_json, null))
    .filter((message) => message && typeof message === 'object');
}

/**
 * @param {{ workspace?: string }} [filter]
 */
export function readSessionSummariesState(filter = {}) {
  const db = getSessionsDb();
  const stmts = getReadStmts(db);
  const workspaceRaw = typeof filter.workspace === 'string' ? filter.workspace : '';
  const workspace = normalizeWorkspacePath(workspaceRaw);

  const groupRows = stmts.groups.all();
  const boardTaskRows = stmts.boardTasks.all();
  const boardLogRows = stmts.boardLog.all();
  const tasksByGroup = bucketBy(boardTaskRows, (r) => r.group_id);
  const logByGroup = bucketBy(boardLogRows, (r) => r.group_id);

  let groups = groupRows.map((row) => {
    const tasks = (tasksByGroup.get(row.id) ?? [])
      .map((t) => parseJson(t.payload_json, null))
      .filter((t) => t && typeof t === 'object');
    const log = (logByGroup.get(row.id) ?? []).map(boardLogRowToEvent);
    return stitchGroup(row, tasks, log);
  });
  if (workspace) {
    groups = groups.filter(
      (g) => normalizeWorkspacePath(String(g.workspacePath ?? '')) === workspace,
    );
  }

  /** @type {Record<string, unknown>} */
  const raw = {
    revision: readSessionRevision(),
    version: readSessionMeta(db, 'schemaVersion') ?? SESSION_SCHEMA_VERSION,
    activeId: readSessionMeta(db, 'activeId') ?? '',
    sidebarCollapsed: !!readSessionMeta(db, 'sidebarCollapsed'),
    lastActiveChatIdByWorkspace: readSessionMeta(db, 'lastActiveChatIdByWorkspace') ?? {},
    lastActiveChatIdByApp: readSessionMeta(db, 'lastActiveChatIdByApp') ?? {},
    groups,
    chats: readChatSummaries(filter),
  };

  const sidebarWidth = readSessionMeta(db, 'sidebarWidth');
  if (typeof sidebarWidth === 'number') raw.sidebarWidth = sidebarWidth;
  const activeBoardGroupId = readSessionMeta(db, 'activeBoardGroupId');
  if (typeof activeBoardGroupId === 'string' && activeBoardGroupId) {
    raw.activeBoardGroupId = activeBoardGroupId;
  }
  const lastBoardGroupId = readSessionMeta(db, 'lastBoardGroupId');
  if (typeof lastBoardGroupId === 'string' && lastBoardGroupId) {
    raw.lastBoardGroupId = lastBoardGroupId;
  }
  const codeChangeTotalsByWorkspace = readSessionMeta(db, 'codeChangeTotalsByWorkspace');
  if (codeChangeTotalsByWorkspace && typeof codeChangeTotalsByWorkspace === 'object') {
    raw.codeChangeTotalsByWorkspace = codeChangeTotalsByWorkspace;
  }

  return raw;
}

export function exportSessionStateToJson() {
  return readWholeSessionState();
}

/**
 * @param {unknown} delta
 * @returns {{ ok: true, applied: { chats: number, deletedChats: number, groups: number, deletedGroups: number, scalars: boolean } }}
 */
export function patchSessionState(delta) {
  if (!delta || typeof delta !== 'object') {
    const err = new Error('Invalid session patch');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
    throw err;
  }

  const body = /** @type {Record<string, unknown>} */ (delta);
  const baseVersion = body.baseVersion;
  if (
    baseVersion !== undefined &&
    baseVersion !== 1 &&
    baseVersion !== 2 &&
    baseVersion !== 3 &&
    baseVersion !== 4 &&
    baseVersion !== 5 &&
    baseVersion !== 6
  ) {
    const err = new Error('Invalid session baseVersion');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
    throw err;
  }
  void SESSION_SCHEMA_VERSION;

  const applied = {
    chats: 0,
    deletedChats: 0,
    groups: 0,
    deletedGroups: 0,
    scalars: false,
  };

  const db = getSessionsDb();
  let revision = 0;
  const tx = db.transaction(() => {
    assertSessionRevision(body.baseRevision);

    if (Array.isArray(body.deleteChatIds)) {
      applied.deletedChats += deleteChatRows(db, body.deleteChatIds);
    }

    if (Array.isArray(body.deleteGroupIds)) {
      const delGroup = db.prepare('DELETE FROM groups WHERE id = ?');
      for (const id of body.deleteGroupIds) {
        if (typeof id !== 'string' || !id.trim()) continue;
        const result = delGroup.run(id.trim());
        if (result.changes > 0) applied.deletedGroups += 1;
      }
    }

    if (Array.isArray(body.chats)) {
      for (const raw of body.chats) {
        if (!raw || typeof raw !== 'object') continue;
        const chat = normalizeChatRow(raw);
        migrateChatRowV5ToV6(chat);
        const chatId = String(chat.id);
        const existing = db
          .prepare('SELECT sort_index FROM chats WHERE id = ?')
          .get(chatId);
        let sortIndex;
        if (existing && typeof existing.sort_index === 'number') {
          sortIndex = existing.sort_index;
        } else {
          const maxRow = db
            .prepare('SELECT COALESCE(MAX(sort_index), -1) AS m FROM chats')
            .get();
          sortIndex = (maxRow?.m ?? -1) + 1;
        }

        const hasHistoryKey = wireChatIncludesHistory(raw);
        if (upsertChatWithOptionalHistory(db, chat, sortIndex, hasHistoryKey)) {
          applied.chats += 1;
        }
      }
    }

    if (Array.isArray(body.groups)) {
      for (const raw of body.groups) {
        const group = normalizeGroupRow(raw);
        if (!group?.id) continue;
        upsertGroupRow(db, group);
        const board = group.orchestrateBoard;
        syncBoardTasks(db, group.id, Array.isArray(board?.tasks) ? board.tasks : []);
        syncBoardLog(db, group.id, Array.isArray(board?.log) ? board.log : []);
        applied.groups += 1;
      }
    }

    if (body.scalars && typeof body.scalars === 'object') {
      const scalars = normalizeSessionScalars(body.scalars, { mode: 'partial' });
      applyPartialScalars(db, scalars);
      applied.scalars = Object.keys(scalars).length > 0;
    }

    const countRow = db.prepare('SELECT COUNT(*) AS n FROM chats').get();
    if (!countRow?.n) {
      const err = new Error('Session must have at least one chat');
      /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
      throw err;
    }

    const activeId = readSessionMeta(db, 'activeId');
    const activeOk =
      typeof activeId === 'string' &&
      activeId &&
      db.prepare('SELECT id FROM chats WHERE id = ?').get(activeId);
    if (!activeOk) {
      const first = db
        .prepare('SELECT id FROM chats ORDER BY sort_index ASC, id ASC')
        .get();
      if (first?.id) writeSessionMeta(db, 'activeId', first.id);
    }

    writeSessionMeta(db, 'schemaVersion', SESSION_SCHEMA_VERSION);
    revision = bumpSessionRevision();
  });
  tx();
  return { ok: true, applied, revision };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} scalars
 */
function applyPartialScalars(db, scalars) {
  if (Object.prototype.hasOwnProperty.call(scalars, 'version')) {
    writeSessionMeta(db, 'schemaVersion', scalars.version ?? SESSION_SCHEMA_VERSION);
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'activeId')) {
    writeSessionMeta(db, 'activeId', typeof scalars.activeId === 'string' ? scalars.activeId : '');
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'sidebarCollapsed')) {
    writeSessionMeta(db, 'sidebarCollapsed', !!scalars.sidebarCollapsed);
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'sidebarWidth')) {
    writeSessionMeta(
      db,
      'sidebarWidth',
      typeof scalars.sidebarWidth === 'number' ? scalars.sidebarWidth : null,
    );
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'activeBoardGroupId')) {
    writeSessionMeta(
      db,
      'activeBoardGroupId',
      typeof scalars.activeBoardGroupId === 'string' ? scalars.activeBoardGroupId : null,
    );
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'lastBoardGroupId')) {
    writeSessionMeta(
      db,
      'lastBoardGroupId',
      typeof scalars.lastBoardGroupId === 'string' ? scalars.lastBoardGroupId : null,
    );
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'lastActiveChatIdByWorkspace')) {
    writeSessionMeta(
      db,
      'lastActiveChatIdByWorkspace',
      scalars.lastActiveChatIdByWorkspace ?? {},
    );
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'lastActiveChatIdByApp')) {
    writeSessionMeta(db, 'lastActiveChatIdByApp', scalars.lastActiveChatIdByApp ?? {});
  }
  if (Object.prototype.hasOwnProperty.call(scalars, 'codeChangeTotalsByWorkspace')) {
    writeSessionMeta(
      db,
      'codeChangeTotalsByWorkspace',
      scalars.codeChangeTotalsByWorkspace ?? null,
    );
  }
}

export function useJsonSessionsStore() {
  return process.env.MINNOW_SESSIONS_STORE === 'json';
}
