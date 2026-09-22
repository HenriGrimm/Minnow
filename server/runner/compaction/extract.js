import { isToolImageFollowUpMessage } from '../tool-image-follow-up.js';
import { parsePatch } from '../../../src/lib/apply-patch.mjs';
import {
  STATE_CAPS,
  addUniqueText,
  cloneCompactionState,
  noteFile,
  noteProblem,
  pushCapped,
} from './merge.js';
import { capText, indexToolCalls, isRealUserRow, isSummaryOnlyRow, oneLine, rowText } from './segment.js';
import { stripCompactionSummary } from './project.js';
import { isElidedToolStub } from './elide.js';

const GOAL_MAX_CHARS = 900;
const SCOPE_MAX_CHARS = 320;
const NOTE_MAX_CHARS = 220;
const TURN_USER_MAX = 140;
const TURN_ASSISTANT_MAX = 160;
const STATUS_MAX = 420;

const READ_TOOLS = new Set(['read_file', 'read_file_range', 'get_file_metadata', 'search_in_file']);
const MODIFY_TOOLS = new Set(['append_file', 'insert_at_line', 'replace_text_in_file']);
const COMMAND_TOOLS = new Set(['execute_command', 'run_python', 'run_javascript']);

/** A user line that redirects the work rather than continuing it. */
const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|new plan|scrap that|forget (?:that|it)|also (?:need|want)|scope|don['’]t do|do not do|stop doing|rather than|switch to)\b/i;

/** A standing preference worth keeping verbatim. */
const PREFERENCE_RE =
  /\b(always|never|from now on|going forward|i prefer|please don['’]t|don['’]t ever|make sure (?:to|you)|remember (?:to|that))\b/i;

/** Tool output that reports a failure. */
const FAILURE_RES = [
  /^\s*error\b/i,
  /\bexit(?:ed)?(?: with)?(?: code| status)?[:=\s]+[1-9]\d*\b/i,
  /\berror TS\d{3,5}\b/,
  /\b[1-9]\d* (?:failing|failed)\b/i,
  /\bnot ok \d+\b/,
  /\bTraceback \(most recent call last\)/,
  /\bFAIL(?:ED)?\b/,
];

/**
 * @param {string} content
 * @param {{ flagged?: boolean, command?: boolean }} [options] `command`: scan
 *   the output for test / compiler / exit-code failures, not just an `Error` prefix
 */
export function isFailureOutput(content, options = {}) {
  if (options.flagged) return true;
  const head = String(content ?? '').slice(0, 4000);
  if (!options.command) return FAILURE_RES[0].test(head);
  return FAILURE_RES.some((re) => re.test(head));
}

/**
 * First line that explains a failure (the error line when there is one).
 * @param {string} content
 */
function failureLine(content) {
  const lines = String(content ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => FAILURE_RES.some((re) => re.test(l)));
  return oneLine(hit ?? lines[0] ?? '', 160);
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} key
 */
function argString(args, key) {
  const v = args?.[key];
  return typeof v === 'string' ? v : '';
}

/**
 * @param {unknown} codeChange
 * @returns {{ additions: number, deletions: number, paths: string[] } | null}
 */
function readCodeChange(codeChange) {
  if (!codeChange || typeof codeChange !== 'object') return null;
  const cc = /** @type {Record<string, unknown>} */ (codeChange);
  const paths = [];
  if (typeof cc.path === 'string' && cc.path) paths.push(cc.path);
  if (Array.isArray(cc.paths)) {
    for (const p of cc.paths) if (typeof p === 'string' && p && !paths.includes(p)) paths.push(p);
  }
  return {
    additions: Number.isFinite(cc.additions) ? /** @type {number} */ (cc.additions) : 0,
    deletions: Number.isFinite(cc.deletions) ? /** @type {number} */ (cc.deletions) : 0,
    paths,
  };
}

/**
 * Fold rows into a compaction state. Pure: `prev` is not mutated and the
 * result depends only on `prev` plus the rows, in order.
 *
 * @param {unknown} prev previous `CompactionState` (or null)
 * @param {ReadonlyArray<{ id: number | null, row: any }>} entries rows being folded, oldest first
 * @param {{ notes?: string | null }} [options]
 * @returns {import('./index').CompactionState}
 */
export function ingestRows(prev, entries, options = {}) {
  const state = cloneCompactionState(prev);
  const calls = indexToolCalls(entries.map((e) => e.row));
  /** @type {import('./index').CompactionTurn | null} */
  let turn = null;

  const closeTurn = () => {
    if (!turn) return;
    pushCapped(state.turns, turn, STATE_CAPS.turns);
    state.folded.turns += 1;
    turn = null;
  };
  const ensureTurn = (row) => {
    if (!turn) turn = { row, user: '', assistant: '', tools: {} };
    return turn;
  };

  for (const { id, row } of entries) {
    if (!row || typeof row !== 'object') continue;
    if (id != null) {
      if (state.folded.fromRow == null || id < state.folded.fromRow) state.folded.fromRow = id;
      if (state.folded.throughRow == null || id > state.folded.throughRow) state.folded.throughRow = id;
    }
    state.folded.rows += 1;

    if (row.role === 'user') {
      if (isToolImageFollowUpMessage(row) || isSummaryOnlyRow(row)) continue;
      closeTurn();
      const text = stripCompactionSummary(rowText(row)).trim();
      turn = { row: id, user: oneLine(text, TURN_USER_MAX), assistant: '', tools: {} };
      if (!state.goal) {
        state.goal = capText(text, GOAL_MAX_CHARS);
      } else if (SCOPE_CHANGE_RE.test(text)) {
        pushCapped(state.scopeChanges, { row: id, text: capText(text, SCOPE_MAX_CHARS) }, STATE_CAPS.scopeChanges);
      }
      if (PREFERENCE_RE.test(text)) {
        for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
          if (PREFERENCE_RE.test(sentence)) addUniqueText(state.notes, oneLine(sentence, NOTE_MAX_CHARS), STATE_CAPS.notes);
        }
      }
      continue;
    }

    if (row.role === 'assistant') {
      const t = ensureTurn(id);
      const text = rowText(row).trim();
      if (text) {
        t.assistant = oneLine(text, TURN_ASSISTANT_MAX);
        state.status.lastAssistant = capText(text, STATUS_MAX);
      }
      if (Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          const name = typeof call?.function?.name === 'string' ? call.function.name : '';
          if (name) t.tools[name] = (t.tools[name] ?? 0) + 1;
        }
      }
      continue;
    }

    if (row.role === 'tool') {
      const call = calls.get(typeof row.tool_call_id === 'string' ? row.tool_call_id : '');
      if (!call) continue;
      const content = typeof row.content === 'string' ? row.content : rowText(row);
      if (isElidedToolStub(content)) continue;
      ingestToolResult(state, call, content, row, id);
    }
  }
  closeTurn();

  const notes = typeof options.notes === 'string' ? options.notes.trim() : '';
  if (notes) addUniqueText(state.notes, oneLine(notes, NOTE_MAX_CHARS * 2), STATE_CAPS.notes);
  return state;
}

/**
 * @param {import('./index').CompactionState} state
 * @param {{ name: string, args: Record<string, unknown> }} call
 * @param {string} content
 * @param {any} row
 * @param {number | null} id
 */
function ingestToolResult(state, call, content, row, id) {
  const { name, args } = call;
  const failed = isFailureOutput(content, { flagged: row.isError === true, command: COMMAND_TOOLS.has(name) });
  const change = readCodeChange(row.codeChange);
  const path = argString(args, 'path');

  if (READ_TOOLS.has(name)) {
    if (!failed && path) noteFile(state, path, 'read', { row: id });
  } else if (name === 'apply_patch') {
    if (!failed) {
      try {
        for (const file of parsePatch(args.patch)) {
          const op = file.kind === 'Add' ? 'created' : file.kind === 'Delete' ? 'deleted' : file.move ? 'moved' : 'modified';
          noteFile(state, file.path, op, { row: id });
          if (file.move) noteFile(state, file.move, 'created', { row: id });
          state.status.lastFileAction = `${op} ${file.path}`;
        }
      } catch { /* Malformed historical tool arguments are not evidence of edits. */ }
    }
  } else if (name === 'save_file' || MODIFY_TOOLS.has(name)) {
    if (!failed && path) {
      const created = name === 'save_file' && change != null && change.deletions === 0 && change.additions > 0 &&
        !state.files.some((f) => f.path === path);
      noteFile(state, path, created ? 'created' : 'modified', {
        additions: change?.additions,
        deletions: change?.deletions,
        row: id,
      });
      state.status.lastFileAction = `${created ? 'created' : 'modified'} ${path}`;
    }
  } else if (name === 'move_file' || name === 'copy_file') {
    const source = argString(args, 'source');
    const destination = argString(args, 'destination');
    if (!failed && source) {
      const op = name === 'move_file' ? 'moved' : 'copied';
      noteFile(state, source, op, { row: id });
      if (destination) noteFile(state, destination, 'created', { row: id });
      state.status.lastFileAction = `${op} ${source} → ${destination}`;
    }
  } else if (name === 'delete_path') {
    if (!failed && path) {
      noteFile(state, path, 'deleted', { row: id });
      state.status.lastFileAction = `deleted ${path}`;
    }
  } else if (name === 'git_commit') {
    if (!failed) {
      const header = content.match(/\[([^\]\s]+)(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]\s*([^\n]*)/i);
      const subject = oneLine(header?.[3] || argString(args, 'message').split('\n')[0], 100);
      pushCapped(state.commits, { hash: header?.[2] ?? '', subject, row: id }, STATE_CAPS.commits);
    }
  } else if (name === 'spawn_sub_agent') {
    const type = argString(args, 'type') || 'sub-agent';
    const outcome = failed ? `failed: ${failureLine(content)}` : oneLine(content, 140);
    pushCapped(
      state.subAgents,
      { type, task: oneLine(argString(args, 'task'), 90), outcome, row: id },
      STATE_CAPS.subAgents,
    );
  } else if (name === 'todo_write') {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    state.todos = todos
      .filter((t) => t && typeof t === 'object' && typeof t.text === 'string')
      .slice(0, STATE_CAPS.todos)
      .map((t) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${oneLine(t.text, 140)}`);
  }

  if (COMMAND_TOOLS.has(name)) {
    const label = name === 'execute_command'
      ? oneLine(argString(args, 'command'), 90)
      : `${name} (${oneLine(argString(args, 'code'), 50)})`;
    state.status.lastCommand = `${label} → ${failed ? failureLine(content) : 'ok'}`;
  }

  // Errors and their resolution, keyed by tool + what it acted on.
  const target = path || argString(args, 'command') || argString(args, 'source') || argString(args, 'type');
  if (name && name !== 'todo_write') {
    const key = `${name}:${oneLine(target, 80)}`;
    noteProblem(state, key, {
      error: failed,
      row: id,
      text: `${name}${target ? ` ${oneLine(target, 80)}` : ''}: ${failureLine(content)}`,
    });
  }
}
