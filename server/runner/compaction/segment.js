import { apiMessageContentToText } from '../message-content.js';
import { isToolImageFollowUpMessage } from '../tool-image-follow-up.js';

/** Every compaction summary starts with this; the rest of the header names the folded rows. */
export const COMPACTION_HEADER_PREFIX = '## Prior context (';

/**
 * Closes a summary that was merged into the following user row, so roles still
 * alternate. Everything after it is that row's own content.
 */
export const COMPACTION_MERGE_MARK = '[End of prior context]';

/**
 * @param {unknown} msg
 * @returns {string}
 */
export function rowText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return apiMessageContentToText(/** @type {{ content?: unknown }} */ (msg).content);
}

/**
 * A user row carrying a compaction summary — on its own, or merged into the row after it.
 * @param {unknown} msg
 */
export function hasCompactionSummary(msg) {
  const row = /** @type {{ role?: string }} */ (msg);
  return row?.role === 'user' && rowText(msg).startsWith(COMPACTION_HEADER_PREFIX);
}

/**
 * A user row that is nothing but a summary (not merged into a request).
 * @param {unknown} msg
 */
export function isSummaryOnlyRow(msg) {
  return hasCompactionSummary(msg) && !rowText(msg).includes(COMPACTION_MERGE_MARK);
}

/**
 * A user row someone typed (or a request merged under a summary): not a
 * screenshot follow-up, not a bare summary.
 * @param {unknown} msg
 */
export function isRealUserRow(msg) {
  const row = /** @type {{ role?: string }} */ (msg);
  if (row?.role !== 'user') return false;
  if (isToolImageFollowUpMessage(/** @type {never} */ (msg))) return false;
  return !isSummaryOnlyRow(msg);
}

/**
 * End (exclusive) of the round starting at `start`: an assistant row with its
 * tool results and screenshot follow-ups, or a single row.
 * @param {ReadonlyArray<any>} rows
 * @param {number} start
 * @param {number} [end]
 */
export function roundEndAt(rows, start, end = rows.length) {
  const msg = rows[start];
  if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    let i = start + 1;
    while (i < end && rows[i]?.role === 'tool') i += 1;
    while (i < end && isToolImageFollowUpMessage(rows[i])) i += 1;
    return i;
  }
  return Math.min(end, start + 1);
}

/**
 * Split `rows[from, to)` into turns, each with its rounds. A turn opens on a
 * real user row; rows before the first one form a headless turn.
 * @param {ReadonlyArray<any>} rows
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Array<{ start: number, end: number, userIndex: number, rounds: Array<{ start: number, end: number }> }>}
 */
export function segmentTurns(rows, from = 0, to = rows.length) {
  /** @type {Array<{ start: number, end: number, userIndex: number, rounds: Array<{ start: number, end: number }> }>} */
  const turns = [];
  let current = null;
  let i = from;
  while (i < to) {
    const next = roundEndAt(rows, i, to);
    if (isRealUserRow(rows[i]) || current === null) {
      current = { start: i, end: next, userIndex: isRealUserRow(rows[i]) ? i : -1, rounds: [] };
      turns.push(current);
    }
    current.rounds.push({ start: i, end: next });
    current.end = next;
    i = next;
  }
  return turns;
}

/**
 * Tool calls by id across `rows`, with parsed arguments.
 * @param {ReadonlyArray<any>} rows
 * @returns {Map<string, { name: string, args: Record<string, unknown> }>}
 */
export function indexToolCalls(rows) {
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const out = new Map();
  for (const row of rows) {
    if (row?.role !== 'assistant' || !Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls) {
      const id = typeof call?.id === 'string' ? call.id : '';
      if (!id) continue;
      out.set(id, {
        name: typeof call.function?.name === 'string' ? call.function.name : '',
        args: parseToolArgs(call.function?.arguments),
      });
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function parseToolArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One line of at most `max` characters, whitespace collapsed.
 * @param {string} text
 * @param {number} max
 */
export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Head of `text` capped at `max` characters, line breaks kept.
 * @param {string} text
 * @param {number} max
 */
export function capText(text, max) {
  const body = String(text ?? '').trim();
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
