import {
  applyContextBudget,
  countPinnedSystemMessages,
  estimateApiMessageTokens,
  estimateApiMessagesTokens,
  sanitizeToolPairing,
} from '../context-budget.js';
import { isUiOnlyTranscriptRole } from '../injection-notice.js';
import { isToolImageFollowUpMessage } from '../tool-image-follow-up.js';
import { ELIDE_MIN_CHARS, elideToolRow } from './elide.js';
import { ingestRows } from './extract.js';
import { defaultSummaryBudgetTokens, formatCompactionSummary } from './format.js';
import { cloneCompactionState } from './merge.js';
import { projectMessages, unmergeSummaryRow } from './project.js';
import { indexToolCalls, isRealUserRow, isSummaryOnlyRow, segmentTurns } from './segment.js';

export { COMPACTION_HEADER_PREFIX, COMPACTION_MERGE_MARK, isRealUserRow, isSummaryOnlyRow, hasCompactionSummary, segmentTurns } from './segment.js';
export { ELIDE_MIN_CHARS, elideToolRow, isElidedToolStub } from './elide.js';
export { ingestRows, isFailureOutput } from './extract.js';
export { defaultSummaryBudgetTokens, formatCompactionSummary, MAX_SUMMARY_BUDGET_TOKENS } from './format.js';
export { cloneCompactionState, emptyCompactionState } from './merge.js';
export { projectMessages, stripCompactionSummary, unmergeSummaryRow } from './project.js';
export { RECALL_HISTORY_TOOL_DEFINITION, RECALL_HISTORY_TOOL_NAME, runRecallHistory } from './recall.js';

/** Compact once the prompt estimate crosses this share of the message ceiling. */
export const DEFAULT_HIGH_WATER = 0.8;
/** A compaction aims for this share, so the checkpoint holds for many sends. */
export const DEFAULT_LOW_WATER = 0.5;
/** Whole turns kept verbatim before rounds of the current turn start to fold. */
export const DEFAULT_RECENT_TURNS = 2;
/** Tool results in the last K rounds are never elided. */
export const DEFAULT_KEEP_TOOL_ROUNDS = 4;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampShare(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Knobs for one compaction, from an agent budget config plus the model window.
 * @param {{ minRecentTurns?: number, highWater?: number, lowWater?: number, summaryBudgetTokens?: number } | null | undefined} agentConfig
 * @param {number | null | undefined} windowTokens
 * @returns {import('./index').CompactionConfig}
 */
export function resolveCompactionConfig(agentConfig, windowTokens) {
  const highWater = clampShare(agentConfig?.highWater, DEFAULT_HIGH_WATER, 0.3, 0.98);
  const lowWater = clampShare(agentConfig?.lowWater, DEFAULT_LOW_WATER, 0.1, highWater - 0.05);
  const recentTurns = Math.max(1, Math.floor(agentConfig?.minRecentTurns ?? DEFAULT_RECENT_TURNS));
  const explicitBudget = agentConfig?.summaryBudgetTokens;
  const summaryBudgetTokens =
    typeof explicitBudget === 'number' && Number.isFinite(explicitBudget) && explicitBudget > 0
      ? Math.max(200, Math.floor(explicitBudget))
      : defaultSummaryBudgetTokens(windowTokens);
  return { highWater, lowWater, recentTurns, summaryBudgetTokens, keepToolRounds: DEFAULT_KEEP_TOOL_ROUNDS };
}

/**
 * A checkpoint as the runner uses it, from any persisted or live shape.
 * @param {unknown} raw
 * @returns {import('./index').CompactionCheckpoint | null}
 */
export function normalizeCompactionCheckpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = /** @type {Record<string, any>} */ (raw);
  const fold = Number.isFinite(c.foldThroughRow) ? c.foldThroughRow : Number.isFinite(c.foldThroughIndex) ? c.foldThroughIndex : null;
  const elide = Number.isFinite(c.elideThroughRow) ? c.elideThroughRow : Number.isFinite(c.elideThroughIndex) ? c.elideThroughIndex : null;
  if (fold == null && elide == null) return null;
  return {
    version: 1,
    foldThroughRow: fold,
    elideThroughRow: elide,
    summary: typeof c.summary === 'string' ? c.summary : '',
    state: cloneCompactionState(c.state),
    trigger: c.trigger === 'overflow' || c.trigger === 'manual' ? c.trigger : 'auto',
    tokensBefore: Number.isFinite(c.tokensBefore) ? c.tokensBefore : 0,
    tokensAfter: Number.isFinite(c.tokensAfter) ? c.tokensAfter : 0,
  };
}

/**
 * The persisted `compaction` payload for a `context` history row.
 * @param {import('./index').CompactionCheckpoint} checkpoint
 */
export function toPersistedCompaction(checkpoint) {
  return {
    version: 1,
    foldThroughIndex: checkpoint.foldThroughRow,
    ...(checkpoint.elideThroughRow != null ? { elideThroughIndex: checkpoint.elideThroughRow } : {}),
    summary: checkpoint.summary,
    state: checkpoint.state,
    trigger: checkpoint.trigger,
    tokensBefore: checkpoint.tokensBefore,
    tokensAfter: checkpoint.tokensAfter,
  };
}

/**
 * Latest compaction checkpoint in a chat history, with its row index.
 * @param {ReadonlyArray<any>} history
 * @returns {{ checkpoint: import('./index').CompactionCheckpoint, index: number } | null}
 */
export function latestCompactionCheckpoint(history) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row?.role !== 'context' || row.compaction?.version !== 1) continue;
    const checkpoint = normalizeCompactionCheckpoint(row.compaction);
    if (checkpoint) return { checkpoint, index: i };
  }
  return null;
}

/**
 * Model-visible transcript rows of a history, with their history indices as ids.
 * @param {ReadonlyArray<any>} history
 * @returns {{ rows: any[], ids: number[] }}
 */
export function transcriptRowsWithIds(history) {
  const rows = [];
  const ids = [];
  if (!Array.isArray(history)) return { rows, ids };
  for (let i = 0; i < history.length; i += 1) {
    const row = history[i];
    if (!row || typeof row !== 'object' || isUiOnlyTranscriptRole(row.role)) continue;
    rows.push(row);
    ids.push(i);
  }
  return { rows, ids };
}

/**
 * Sanitize pairing while keeping ids aligned (rows rewritten by the sanitizer lose theirs).
 * @param {any[]} rows
 * @param {Array<number | null>} ids
 */
function sanitizeWithIds(rows, ids) {
  const byRow = new Map();
  rows.forEach((row, i) => byRow.set(row, ids[i]));
  const clean = sanitizeToolPairing(rows);
  if (clean.length === rows.length && clean.every((row, i) => row === rows[i])) return { rows, ids };
  return { rows: clean, ids: clean.map((row) => byRow.get(row) ?? null) };
}

/**
 * @param {string} summary
 */
function summaryTokens(summary) {
  return summary ? estimateApiMessageTokens({ role: 'user', content: summary }) + 8 : 0;
}

/**
 * Fold older turns into a deterministic checkpoint and project the rows.
 *
 * Stages, in order, stopping once the projection is at `limit × lowWater`:
 *   1. elide tool bodies older than the last K rounds (fold unchanged);
 *   2. fold whole turns oldest-first, keeping `recentTurns`;
 *   3. fold rounds of the kept turns — the latest real user row and the last
 *      round of the current turn stay verbatim;
 *   4. over `limit` even then: hard-truncate the longest row (not persisted).
 * Only rows after `prev.foldThroughRow` are read into the state, so a new
 * checkpoint costs O(new rows).
 *
 * @param {import('./index').CompactMessagesInput} input
 * @returns {import('./index').CompactMessagesResult}
 */
export function compactMessages(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const limit = Math.floor(input?.limit ?? 0);
  const trigger = input?.trigger ?? 'auto';
  const prev = normalizeCompactionCheckpoint(input?.prev);
  const config = input?.config ?? resolveCompactionConfig(null, input?.window ?? limit);
  const idOf = typeof input?.idOf === 'function' ? input.idOf : (_row, index) => index;
  const originalOf = typeof input?.originalOf === 'function' ? input.originalOf : () => undefined;
  const tokensBefore = estimateApiMessagesTokens(messages);
  const unchanged = (extra = {}) => ({
    changed: false,
    messages,
    ids: messages.map((row, i) => idOf(row, i) ?? null),
    synthetic: new Set(),
    checkpoint: prev,
    tokensBefore,
    tokensAfter: tokensBefore,
    droppedTurns: 0,
    droppedRounds: 0,
    elidedRows: 0,
    truncated: false,
    ...extra,
  });
  if (messages.length === 0 || !(limit > 0)) return unchanged();

  // Unprojected view: summary rows out, merged and elided rows restored.
  const systemEnd = countPinnedSystemMessages(messages);
  const base = messages.slice(0, systemEnd);
  /** @type {Array<number | null>} */
  const ids = base.map(() => null);
  for (let i = systemEnd; i < messages.length; i += 1) {
    const row = messages[i];
    if (isSummaryOnlyRow(row)) continue;
    const id = idOf(row, i) ?? null;
    const original = id != null ? originalOf(id) : undefined;
    base.push(original ?? unmergeSummaryRow(row));
    ids.push(id);
  }
  const n = base.length;

  let lastUser = -1;
  for (let i = n - 1; i >= systemEnd; i -= 1) {
    if (isRealUserRow(base[i])) {
      lastUser = i;
      break;
    }
  }
  const rowTokens = base.map((row, i) => estimateApiMessageTokens(row, { replaysReasoning: i > lastUser }));
  let systemTokens = 0;
  for (let i = 0; i < systemEnd; i += 1) systemTokens += rowTokens[i];

  const prevFold = prev?.foldThroughRow ?? -1;
  const prevElide = prev?.elideThroughRow ?? -1;
  const turns = segmentTurns(base, systemEnd, n);
  const rounds = turns.flatMap((t) => t.rounds);
  const calls = indexToolCalls(base);

  // Candidate elision: tool rows in rounds older than the last K.
  let elideCandidate = prevElide;
  if (trigger !== 'manual') {
    const older = rounds.slice(0, Math.max(0, rounds.length - config.keepToolRounds));
    for (const r of older) {
      for (let i = r.start; i < r.end; i += 1) {
        if (ids[i] != null && ids[i] > elideCandidate) elideCandidate = ids[i];
      }
    }
  }

  /** @type {number[]} last real user index at or before i */
  const userAtOrBefore = new Array(n).fill(-1);
  for (let i = systemEnd, last = -1; i < n; i += 1) {
    if (isRealUserRow(base[i])) last = i;
    userAtOrBefore[i] = last;
  }
  const effectiveTokens = (elideId) => {
    const prefix = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i += 1) {
      let t = rowTokens[i];
      if (i >= systemEnd && elideId >= 0 && ids[i] != null && ids[i] <= elideId && base[i]?.role === 'tool' &&
        typeof base[i].content === 'string' && base[i].content.length >= ELIDE_MIN_CHARS) {
        t = estimateApiMessageTokens(elideToolRow(base[i], { rowId: ids[i], toolName: calls.get(base[i].tool_call_id)?.name }));
      }
      prefix[i + 1] = prefix[i] + t;
    }
    return prefix;
  };
  /** Last index whose id is ≤ fold (the projection's cut), or systemEnd - 1. */
  const cutForFold = (fold) => {
    let cut = systemEnd - 1;
    for (let i = systemEnd; i < n; i += 1) if (ids[i] != null && ids[i] <= fold) cut = i;
    return cut;
  };
  const cost = (prefix, cut, summaryTok) => {
    let total = systemTokens + (prefix[n] - prefix[cut + 1]) + summaryTok;
    if (cut >= systemEnd && (cut + 1 >= n || !isRealUserRow(base[cut + 1]))) {
      const pin = userAtOrBefore[cut];
      if (pin >= 0) total += rowTokens[pin];
    }
    return total;
  };

  const target = trigger === 'manual' ? 0 : Math.floor(limit * config.lowWater);
  const prevCut = cutForFold(prevFold);
  const prevSummaryTokens = summaryTokens(prev?.summary ?? '');

  let foldCut = prevCut;
  let elideId = prevElide;
  const elidePrefix = effectiveTokens(elideCandidate);
  if (elideCandidate > prevElide) {
    elideId = elideCandidate;
  }

  const elisionEnough = elideId > prevElide && cost(elidePrefix, prevCut, prevSummaryTokens) <= target;
  if (!elisionEnough) {
    // Fold candidates, in fold order: whole turns, then rounds of kept turns.
    /** @type {number[]} */
    const candidates = [];
    const wholeTurnLimit = Math.max(0, turns.length - config.recentTurns);
    for (let k = 0; k < wholeTurnLimit; k += 1) candidates.push(turns[k].end - 1);
    if (trigger !== 'manual') {
      for (let t = wholeTurnLimit; t < turns.length; t += 1) {
        const turn = turns[t];
        const isLast = t === turns.length - 1;
        const foldable = isLast ? turn.rounds.slice(0, -1) : turn.rounds;
        for (const r of foldable) {
          if (r.start === turn.userIndex && isLast) continue;
          candidates.push(r.end - 1);
        }
      }
    }
    let chosen = -1;
    for (const raw of candidates) {
      // A cut must land on a row with an id, or the checkpoint cannot name it.
      // Unpersisted screenshot follow-ups at a round's end are the one exception.
      let cut = raw;
      while (cut > prevCut && ids[cut] == null && isToolImageFollowUpMessage(base[cut])) cut -= 1;
      if (cut <= prevCut || ids[cut] == null) continue;
      chosen = cut;
      if (cost(elidePrefix, cut, config.summaryBudgetTokens) <= target) break;
    }
    if (chosen > prevCut) foldCut = chosen;
  }

  const notesOnly = trigger === 'manual' && Boolean(input?.notes?.trim()) && prev != null;
  if (foldCut === prevCut && elideId === prevElide && !notesOnly) {
    return finishOverLimit(unchanged(), limit);
  }

  const foldThroughRow = foldCut > prevCut ? /** @type {number} */ (ids[foldCut]) : prevFold >= 0 ? prevFold : null;
  let state = prev?.state ?? null;
  let summary = prev?.summary ?? '';
  let droppedTurns = 0;
  let droppedRounds = 0;
  if (foldCut > prevCut) {
    /** @type {Array<{ id: number | null, row: any }>} */
    const entries = [];
    for (let i = systemEnd; i <= foldCut; i += 1) {
      if (ids[i] != null && ids[i] <= prevFold) continue;
      if (ids[i] == null && base[i]?.role === 'user') continue;
      entries.push({ id: ids[i], row: base[i] });
    }
    state = ingestRows(state, entries, { notes: input?.notes ?? null });
    summary = formatCompactionSummary(state, { budgetTokens: config.summaryBudgetTokens });
    for (const turn of turns) {
      if (turn.end - 1 <= prevCut) continue;
      if (turn.end - 1 <= foldCut) droppedTurns += 1;
      else if (turn.start <= foldCut) {
        droppedRounds += turn.rounds.filter((r) => r.end - 1 <= foldCut && r.start !== turn.userIndex && r.end - 1 > prevCut).length;
      }
    }
  } else if (input?.notes) {
    state = ingestRows(state, [], { notes: input.notes });
    summary = formatCompactionSummary(state, { budgetTokens: config.summaryBudgetTokens });
  }

  /** @type {import('./index').CompactionCheckpoint} */
  const checkpoint = {
    version: 1,
    foldThroughRow,
    elideThroughRow: elideId >= 0 ? elideId : null,
    summary,
    state: cloneCompactionState(state),
    trigger,
    tokensBefore,
    tokensAfter: 0,
  };
  const projected = projectMessages(base, ids, checkpoint);
  let { rows: out, ids: outIds } = sanitizeWithIds(projected.messages, projected.ids);
  let tokensAfter = estimateApiMessagesTokens(out);
  checkpoint.tokensAfter = tokensAfter;

  const result = {
    changed: true,
    messages: out,
    ids: outIds,
    synthetic: projected.synthetic,
    checkpoint,
    tokensBefore,
    tokensAfter,
    droppedTurns,
    droppedRounds,
    elidedRows: projected.elidedRows,
    truncated: false,
  };
  return finishOverLimit(result, limit);
}

/**
 * Last resort: a projection still over `limit` loses bytes from its longest
 * rows. The checkpoint is untouched — truncation is never persisted.
 * @param {import('./index').CompactMessagesResult} result
 * @param {number} limit
 */
function finishOverLimit(result, limit) {
  if (result.tokensAfter <= limit) return result;
  // The request is pinned; on a window too small for it plus the summary, the
  // summary is what gives (on the wire only — the checkpoint keeps it).
  /** @type {any[]} */
  let rows = [];
  /** @type {Array<number | null>} */
  let rowIds = [];
  result.messages.forEach((row, i) => {
    if (isSummaryOnlyRow(row)) return;
    const plain = unmergeSummaryRow(row);
    rows.push(plain);
    rowIds.push(result.ids[i] ?? null);
  });
  if (rows.length < result.messages.length || rows.some((row, i) => row !== result.messages[i])) {
    const tokens = estimateApiMessagesTokens(rows);
    if (tokens <= limit) {
      return { ...result, changed: true, messages: rows, ids: rowIds, tokensAfter: tokens };
    }
  } else {
    rows = result.messages;
    rowIds = result.ids;
  }
  const byRow = new Map();
  rows.forEach((row, i) => byRow.set(row, rowIds[i]));
  const trimmed = applyContextBudget(
    rows,
    { effectiveLimit: limit, modelLimit: null, policy: 'truncate', reservedTokens: 0 },
    { enforcementPolicy: 'truncate' },
  );
  if (!trimmed.applied) return rows === result.messages ? result : { ...result, changed: true, messages: rows, ids: rowIds, tokensAfter: estimateApiMessagesTokens(rows) };
  return {
    ...result,
    changed: true,
    messages: trimmed.messages,
    ids: trimmed.messages.map((row) => byRow.get(row) ?? null),
    tokensAfter: trimmed.tokensAfter,
    truncated: true,
  };
}

/**
 * Status line for a compaction.
 * @param {Pick<import('./index').CompactMessagesResult, 'droppedTurns' | 'droppedRounds' | 'elidedRows' | 'truncated' | 'tokensBefore' | 'tokensAfter'>} result
 */
export function formatCompactionStatus(result) {
  const parts = [];
  if (result.droppedTurns > 0) parts.push(`${result.droppedTurns} turn${result.droppedTurns === 1 ? '' : 's'} folded`);
  if (result.droppedRounds > 0) parts.push(`${result.droppedRounds} tool round${result.droppedRounds === 1 ? '' : 's'} folded`);
  if (result.elidedRows > 0) parts.push(`${result.elidedRows} tool result${result.elidedRows === 1 ? '' : 's'} elided`);
  if (result.truncated) parts.push('longest rows truncated');
  const k = (t) => (t >= 1000 ? `${Math.round(t / 100) / 10}k` : String(t));
  const detail = parts.length ? ` · ${parts.join(' · ')}` : '';
  return `Context compacted${detail} · ${k(result.tokensBefore)} → ${k(result.tokensAfter)} tokens`;
}
