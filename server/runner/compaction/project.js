import { apiMessageContentToText } from '../message-content.js';
import { elideToolRow } from './elide.js';
import {
  COMPACTION_HEADER_PREFIX,
  COMPACTION_MERGE_MARK,
  indexToolCalls,
  isRealUserRow,
  isSummaryOnlyRow,
} from './segment.js';

/**
 * Text after a merged summary (the row's own content), or `text` unchanged.
 * @param {string} text
 */
export function stripCompactionSummary(text) {
  if (typeof text !== 'string' || !text.startsWith(COMPACTION_HEADER_PREFIX)) return text;
  const at = text.indexOf(COMPACTION_MERGE_MARK);
  if (at < 0) return '';
  return text.slice(at + COMPACTION_MERGE_MARK.length).replace(/^\s+/, '');
}

/**
 * The user row a merged summary was folded into, as it was before the merge.
 * Rows without a merged summary come back unchanged.
 * @param {any} row
 */
export function unmergeSummaryRow(row) {
  if (row?.role !== 'user') return row;
  if (typeof row.content === 'string') {
    if (!row.content.startsWith(COMPACTION_HEADER_PREFIX) || !row.content.includes(COMPACTION_MERGE_MARK)) return row;
    return { ...row, content: stripCompactionSummary(row.content) };
  }
  if (Array.isArray(row.content) && row.content[0]?.type === 'text') {
    const first = row.content[0].text;
    if (typeof first !== 'string' || !first.startsWith(COMPACTION_HEADER_PREFIX) || !first.includes(COMPACTION_MERGE_MARK)) {
      return row;
    }
    const rest = stripCompactionSummary(first);
    return { ...row, content: rest ? [{ type: 'text', text: rest }, ...row.content.slice(1)] : row.content.slice(1) };
  }
  return row;
}

/**
 * @param {any} row user row
 * @param {string} summary
 */
function mergeSummaryInto(row, summary) {
  if (Array.isArray(row.content)) {
    return { ...row, content: [{ type: 'text', text: `${summary}\n\n${COMPACTION_MERGE_MARK}` }, ...row.content] };
  }
  const own = apiMessageContentToText(row.content);
  return { ...row, content: `${summary}\n\n${COMPACTION_MERGE_MARK}\n\n${own}` };
}

/**
 * @param {ReadonlyArray<any>} rows
 */
function pinnedSystemCount(rows) {
  let n = 0;
  while (n < rows.length && rows[n]?.role === 'system') n += 1;
  return n;
}

/**
 * Apply a checkpoint to unprojected rows:
 * `[system][summary][verbatim tail]`.
 *
 * - Rows whose id is ≤ `foldThroughRow` are folded, along with id-less rows
 *   positioned before the last folded one.
 * - When the first kept row continues a turn, that turn's user row stays
 *   verbatim — the request being answered is never folded out.
 * - Tool results with id ≤ `elideThroughRow` become recall stubs.
 * - The summary merges into the first kept row when that is a user row, so
 *   roles still alternate on strict templates.
 *
 * Deterministic: the same rows, ids and checkpoint produce the same bytes.
 *
 * @param {ReadonlyArray<any>} rows unprojected, system rows first
 * @param {ReadonlyArray<number | null>} ids row ids aligned with `rows`
 * @param {{ foldThroughRow?: number | null, elideThroughRow?: number | null, summary?: string } | null | undefined} checkpoint
 * @returns {{ messages: any[], ids: Array<number | null>, synthetic: Set<any>, foldedRows: number, elidedRows: number }}
 */
export function projectMessages(rows, ids, checkpoint) {
  const systemEnd = pinnedSystemCount(rows);
  const synthetic = new Set();
  /** @type {any[]} */
  const out = rows.slice(0, systemEnd);
  /** @type {Array<number | null>} */
  const outIds = ids.slice(0, systemEnd).map(() => null);

  // Any earlier summary row is replaced by this checkpoint's summary.
  /** @type {Array<{ row: any, id: number | null }>} */
  const body = [];
  for (let i = systemEnd; i < rows.length; i += 1) {
    if (isSummaryOnlyRow(rows[i])) continue;
    body.push({ row: unmergeSummaryRow(rows[i]), id: ids[i] ?? null });
  }
  if (!checkpoint) {
    for (const e of body) {
      out.push(e.row);
      outIds.push(e.id);
    }
    return { messages: out, ids: outIds, synthetic, foldedRows: 0, elidedRows: 0 };
  }

  const fold = Number.isFinite(checkpoint.foldThroughRow) ? /** @type {number} */ (checkpoint.foldThroughRow) : -1;
  const elide = Number.isFinite(checkpoint.elideThroughRow) ? /** @type {number} */ (checkpoint.elideThroughRow) : -1;
  let cut = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i].id != null && body[i].id <= fold) cut = i;
  }
  let kept = body.slice(cut + 1);
  if (cut >= 0 && (kept.length === 0 || !isRealUserRow(kept[0].row))) {
    for (let i = cut; i >= 0; i -= 1) {
      if (isRealUserRow(body[i].row)) {
        kept = [body[i], ...kept];
        break;
      }
    }
  }
  const foldedRows = body.length - kept.length;

  const calls = elide >= 0 ? indexToolCalls(kept.map((e) => e.row)) : null;
  let elidedRows = 0;
  kept = kept.map((e) => {
    if (!calls || e.id == null || e.id > elide || e.row?.role !== 'tool') return e;
    const stub = elideToolRow(e.row, { rowId: e.id, toolName: calls.get(e.row.tool_call_id)?.name });
    if (stub === e.row) return e;
    elidedRows += 1;
    synthetic.add(stub);
    return { row: stub, id: e.id };
  });

  const summary = typeof checkpoint.summary === 'string' ? checkpoint.summary.trim() : '';
  if (summary) {
    if (kept.length > 0 && kept[0].row?.role === 'user' && isRealUserRow(kept[0].row)) {
      const merged = mergeSummaryInto(kept[0].row, summary);
      synthetic.add(merged);
      kept = [{ row: merged, id: kept[0].id }, ...kept.slice(1)];
    } else {
      const row = { role: 'user', content: summary };
      synthetic.add(row);
      kept = [{ row, id: null }, ...kept];
    }
  }

  for (const e of kept) {
    out.push(e.row);
    outIds.push(e.id);
  }
  return { messages: out, ids: outIds, synthetic, foldedRows, elidedRows };
}
