import { isToolImageFollowUpMessage } from '../tool-image-follow-up.js';
import { isElidedToolStub } from './elide.js';
import { stripCompactionSummary } from './project.js';
import { indexToolCalls, isRealUserRow, isSummaryOnlyRow, oneLine, rowText } from './segment.js';

export const RECALL_HISTORY_TOOL_NAME = 'recall_history';

/** Hits per page for a query. */
export const RECALL_HITS_PER_PAGE = 5;
/** Rows per page for a verbatim slice. */
export const RECALL_ROWS_PER_PAGE = 20;
const TOOL_PREVIEW_CHARS = 600;
const TOOL_FULL_CHARS = 12000;
const ROW_TEXT_CHARS = 6000;
const SNIPPET_CHARS = 240;

export const RECALL_HISTORY_TOOL_DEFINITION = Object.freeze({
  type: 'function',
  function: {
    name: RECALL_HISTORY_TOOL_NAME,
    description:
      'Search or read earlier rows of this conversation that were compacted out of your context. The "Prior context" summary and elided tool results cite rows as #N. Pass query to search (hits grouped by turn, > marks matching rows), or rows ("120" or "120-140") to read those rows verbatim.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for (file names, error text, decisions).' },
        rows: { type: 'string', description: 'Row number or inclusive range, e.g. "412" or "120-140".' },
        include_tool_results: {
          type: 'boolean',
          description: 'With rows: include full tool result bodies (default false shows a preview).',
        },
        page: { type: 'integer', minimum: 1, description: 'Result page, starting at 1.' },
      },
    },
  },
});

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const out = [];
  for (const match of String(text ?? '').toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)) out.push(match[0]);
  return out;
}

/**
 * Searchable text of one row.
 * @param {any} row
 * @param {Map<string, { name: string, args: Record<string, unknown> }>} calls
 */
function searchableText(row, calls) {
  if (row.role === 'tool') {
    const name = calls.get(row.tool_call_id)?.name ?? 'tool';
    return `${name} ${rowText(row)}`;
  }
  if (row.role === 'assistant') {
    const parts = [rowText(row)];
    if (Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        parts.push(`${call?.function?.name ?? ''} ${typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? '')}`);
      }
    }
    return parts.join('\n');
  }
  return stripCompactionSummary(rowText(row));
}

/**
 * @param {unknown} raw
 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 */
function pageOf(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * @param {string} text
 * @param {string[]} terms
 */
function snippetAround(text, terms) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const body = flat.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${body}${start + SNIPPET_CHARS < flat.length ? '…' : ''}`;
}

/**
 * @param {any} row
 * @param {Map<string, { name: string, args: Record<string, unknown> }>} calls
 */
function roleLabel(row, calls) {
  if (row.role === 'tool') {
    const call = calls.get(row.tool_call_id);
    const target = call ? String(call.args.path ?? call.args.command ?? call.args.source ?? '') : '';
    return `tool ${call?.name ?? ''}${target ? ` ${oneLine(target, 80)}` : ''}`.trim();
  }
  return row.role;
}

/**
 * Run `recall_history` over the unprojected rows of this conversation.
 *
 * @param {ReadonlyArray<{ id: number, row: any }>} entries unprojected rows, ascending id
 * @param {unknown} rawArgs
 * @returns {string}
 */
export function runRecallHistory(entries, rawArgs) {
  const args = parseArgs(rawArgs);
  const list = Array.isArray(entries)
    ? entries.filter((e) => e && Number.isFinite(e.id) && e.row && typeof e.row === 'object' && e.row.role !== 'system')
    : [];
  if (list.length === 0) return 'Error: recall_history has no earlier rows to read in this conversation.';
  const calls = indexToolCalls(list.map((e) => e.row));
  const page = pageOf(args.page);

  if (typeof args.rows === 'string' && args.rows.trim()) {
    const range = args.rows.trim().match(/^#?(\d+)\s*(?:[-–]\s*#?(\d+))?$/);
    if (!range) return 'Error: recall_history rows must look like "120" or "120-140".';
    const from = Number(range[1]);
    const to = range[2] != null ? Number(range[2]) : from;
    if (to < from) return 'Error: recall_history rows range ends before it starts.';
    const slice = list.filter((e) => e.id >= from && e.id <= to && !isSummaryOnlyRow(e.row));
    if (slice.length === 0) return `No rows found in #${from}–#${to}. Rows run from #${list[0].id} to #${list[list.length - 1].id}.`;
    const pages = Math.ceil(slice.length / RECALL_ROWS_PER_PAGE);
    const shown = slice.slice((page - 1) * RECALL_ROWS_PER_PAGE, page * RECALL_ROWS_PER_PAGE);
    if (shown.length === 0) return `Page ${page} is past the end (${pages} page${pages === 1 ? '' : 's'}).`;
    const full = args.include_tool_results === true;
    const blocks = shown.map((e) => renderRow(e, calls, full));
    const more = page < pages ? `\n\n(page ${page} of ${pages}; pass page: ${page + 1} for more)` : '';
    return `Rows #${from}–#${to}${pages > 1 ? ` (page ${page} of ${pages})` : ''}:\n\n${blocks.join('\n\n')}${more}`;
  }

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return 'Error: recall_history needs query (words to search) or rows ("120-140").';
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return 'Error: recall_history query has no searchable words.';

  // BM25 over rows.
  const docs = [];
  for (const e of list) {
    if (isToolImageFollowUpMessage(e.row) || isSummaryOnlyRow(e.row)) continue;
    const text = searchableText(e.row, calls);
    if (isElidedToolStub(text)) continue;
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.push({ entry: e, text, length: tokens.length, tf });
  }
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  const hits = [];
  for (const d of docs) {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    if (score > 0) hits.push({ doc: d, score });
  }
  if (hits.length === 0) return `No earlier rows match "${oneLine(query, 80)}".`;
  hits.sort((x, y) => y.score - x.score || x.doc.entry.id - y.doc.entry.id);

  const pages = Math.ceil(hits.length / RECALL_HITS_PER_PAGE);
  const shown = hits.slice((page - 1) * RECALL_HITS_PER_PAGE, page * RECALL_HITS_PER_PAGE);
  if (shown.length === 0) return `Page ${page} is past the end (${pages} page${pages === 1 ? '' : 's'}).`;

  // Group by turn (the latest real user row at or before each hit), in row order.
  const turnOf = (id) => {
    let turn = null;
    for (const e of list) {
      if (e.id > id) break;
      if (isRealUserRow(e.row)) turn = e;
    }
    return turn;
  };
  /** @type {Map<number, { turn: any, rows: typeof shown }>} */
  const groups = new Map();
  for (const hit of [...shown].sort((x, y) => x.doc.entry.id - y.doc.entry.id)) {
    const turn = turnOf(hit.doc.entry.id);
    const key = turn?.id ?? -1;
    if (!groups.has(key)) groups.set(key, { turn, rows: [] });
    groups.get(key).rows.push(hit);
  }
  const lines = [`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${oneLine(query, 80)}" (page ${page} of ${pages}):`];
  for (const { turn, rows } of groups.values()) {
    lines.push('');
    lines.push(turn ? `Turn #${turn.id} — U: ${oneLine(stripCompactionSummary(rowText(turn.row)), 120)}` : 'Before the first request');
    for (const hit of rows) {
      lines.push(`> #${hit.doc.entry.id} ${roleLabel(hit.doc.entry.row, calls)}: ${snippetAround(hit.doc.text, terms)}`);
    }
  }
  lines.push('');
  lines.push(page < pages
    ? `Read a hit in full with rows: "N". More hits: page ${page + 1}.`
    : 'Read a hit in full with rows: "N".');
  return lines.join('\n');
}

/**
 * @param {{ id: number, row: any }} entry
 * @param {Map<string, { name: string, args: Record<string, unknown> }>} calls
 * @param {boolean} fullToolResults
 */
function renderRow(entry, calls, fullToolResults) {
  const { id, row } = entry;
  const header = `#${id} ${roleLabel(row, calls)}`;
  if (row.role === 'tool') {
    const body = rowText(row);
    const cap = fullToolResults ? TOOL_FULL_CHARS : TOOL_PREVIEW_CHARS;
    if (body.length <= cap) return `${header}:\n${body}`;
    const note = fullToolResults
      ? `[… ${body.length - cap} more chars not shown]`
      : `[… ${body.length} chars total; pass include_tool_results: true for more]`;
    return `${header}:\n${body.slice(0, cap)}\n${note}`;
  }
  if (isToolImageFollowUpMessage(row)) return `${header}: [screenshot]`;
  const parts = [];
  const text = stripCompactionSummary(rowText(row));
  if (text) parts.push(text.length > ROW_TEXT_CHARS ? `${text.slice(0, ROW_TEXT_CHARS)}\n[… ${text.length - ROW_TEXT_CHARS} more chars]` : text);
  if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
    for (const call of row.tool_calls) {
      const argsText = typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {});
      parts.push(`→ ${call?.function?.name ?? 'tool'} ${argsText.length > 800 ? `${argsText.slice(0, 800)}…` : argsText}`);
    }
  }
  return `${header}:\n${parts.join('\n') || '(empty)'}`;
}
