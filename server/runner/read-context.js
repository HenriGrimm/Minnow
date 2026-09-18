/**
 * File reads priced against the context they land in.
 *
 * Two guards, both applied by the tool loop because only it knows the model's
 * window and what the prompt still holds:
 *
 * - A read's character budget scales with the context window, so one read on a
 *   32k local model cannot eat the whole prompt.
 * - A read that returns exactly what an earlier result still verbatim in
 *   context returned becomes a short stub. Comparing the *output* (not file
 *   mtimes) makes the guard exact across edits, clocks and the renderer/server
 *   split, and an elided or folded earlier result never matches.
 */

import { ELIDE_MIN_CHARS } from './compaction/elide.js';

/** Tools whose output budget follows the context window. */
const BUDGETED_READ_TOOLS = new Set(['read_file', 'read_file_range']);

/** Tools whose repeated identical output is replaced by a stub. */
const DEDUPED_READ_TOOLS = new Set(['read_file', 'read_file_range', 'read_symbol', 'read_document']);

/** Share of the context window one read may fill. */
export const READ_CONTEXT_SHARE = 0.12;

/** Conservative characters per token for source code. */
const CHARS_PER_TOKEN = 3.5;

/** Floor so a tiny window still gets a usable window of lines. */
export const MIN_READ_BUDGET_CHARS = 4_000;

export const UNCHANGED_READ_PREFIX = '[Unchanged: ';

/**
 * @param {number | null | undefined} contextLimitTokens
 * @returns {number | null} null when the window is unknown (tool defaults apply)
 */
export function readBudgetCharsForContext(contextLimitTokens) {
  if (typeof contextLimitTokens !== 'number' || !Number.isFinite(contextLimitTokens) || contextLimitTokens <= 0) {
    return null;
  }
  return Math.max(
    MIN_READ_BUDGET_CHARS,
    Math.floor(contextLimitTokens * READ_CONTEXT_SHARE * CHARS_PER_TOKEN),
  );
}

/**
 * Args with `max_output_chars` lowered to the context budget. The tool layer
 * treats `max_output_chars` as shrink-only, and `full_result` stays the
 * explicit escape hatch.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {number | null} budgetChars
 * @returns {Record<string, unknown>}
 */
export function withReadBudget(name, args, budgetChars) {
  if (budgetChars == null || !BUDGETED_READ_TOOLS.has(name)) return args;
  if (!args || typeof args !== 'object' || args.full_result === true || args.full === true) return args;
  const own = Number(args.max_output_chars);
  const next = Number.isFinite(own) && own > 0 ? Math.min(own, budgetChars) : budgetChars;
  return { ...args, max_output_chars: next };
}

/**
 * @param {unknown} content
 */
export function isUnchangedReadStub(content) {
  return typeof content === 'string' && content.startsWith(UNCHANGED_READ_PREFIX);
}

/**
 * @param {Record<string, unknown>} args
 */
function describeRead(args) {
  const target = typeof args?.path === 'string' && args.path.trim()
    ? args.path.trim()
    : typeof args?.symbol === 'string' ? args.symbol.trim() : '';
  const start = args?.offset ?? args?.start_line;
  const end = args?.end_line;
  const limit = args?.limit;
  if (start != null && end != null) return `${target} lines ${start}-${end}`;
  if (start != null && limit != null) return `${target} from line ${start}, ${limit} lines`;
  if (start != null) return `${target} from line ${start}`;
  if (limit != null) return `${target}, first ${limit} lines`;
  return target;
}

/**
 * A stub for `content` when an earlier read result with identical text is still
 * in `messages`, or null when the full result should be sent.
 *
 * @param {Array<{ role?: string, content?: unknown, tool_call_id?: string, tool_calls?: Array<{ id?: string, function?: { name?: string } }> }>} messages
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {unknown} content
 * @returns {string | null}
 */
export function unchangedReadStub(messages, toolName, args, content) {
  if (!DEDUPED_READ_TOOLS.has(toolName)) return null;
  if (typeof content !== 'string' || content.length < ELIDE_MIN_CHARS || content.startsWith('Error:')) {
    return null;
  }
  /** @type {Map<string, string>} */
  const callNames = new Map();
  for (const row of messages) {
    if (row?.role !== 'assistant' || !Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls) {
      if (call?.id && call.function?.name) callNames.set(call.id, call.function.name);
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (row?.role !== 'tool' || row.content !== content) continue;
    const priorName = row.tool_call_id ? callNames.get(row.tool_call_id) : undefined;
    if (!priorName || !DEDUPED_READ_TOOLS.has(priorName)) continue;
    const label = describeRead(args);
    return (
      `${UNCHANGED_READ_PREFIX}this ${toolName}${label ? ` of ${label}` : ''} returned exactly the same ` +
      'text as an earlier result that is still in your context. Use that result instead of reading it again.]'
    );
  }
  return null;
}
