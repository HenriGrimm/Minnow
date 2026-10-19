/**
 * A chat's heavy per-turn records ("detail") travel with its history, not in
 * the session summaries. On a long-lived home the summaries otherwise carried
 * every run's message copy and file snapshot — 180 MB for 1,000 chats — and a
 * phone booting over Tailscale never finished the download.
 *
 * Summaries keep each run as a stub (status, ids, timestamps) so the sidebar,
 * activity feed and notifications still see running and failed turns. Token
 * ledgers stay too: Usage totals every chat, and the client gives an unopened
 * chat an empty ledger that a save would otherwise write over the real one. A chat
 * the client never opened is saved without history; those writes, and any run
 * that arrives as a stub, must keep the stored detail instead of erasing it.
 */

/** Chat meta fields that only an opened chat needs. */
export const CHAT_DETAIL_META_KEYS = Object.freeze(['injectedContext', 'runnerTiming']);

/** Child records left out of summaries entirely. */
export const CHAT_DETAIL_CHILD_KEYS = Object.freeze(['subAgentRuns', 'terminalHistory']);

/** Run fields too large for summaries. `snapshot` is required on a full run. */
export const RUN_DETAIL_KEYS = Object.freeze(['outputMessages', 'snapshot', 'generationIds']);

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A run without its snapshot came from a summary, not from an opened chat.
 * @param {unknown} run
 */
export function isRunStub(run) {
  return isRecord(run) && !Object.prototype.hasOwnProperty.call(run, 'snapshot');
}

/** @param {Record<string, unknown>} run */
export function toRunStub(run) {
  /** @type {Record<string, unknown>} */
  const stub = {};
  for (const [key, value] of Object.entries(run)) {
    if (!RUN_DETAIL_KEYS.includes(key)) stub[key] = value;
  }
  return stub;
}

/**
 * Strip a full chat (or summary) down to what the summaries endpoint sends.
 * @param {Record<string, unknown>} chat
 */
export function slimChatSummary(chat) {
  /** @type {Record<string, unknown>} */
  const slim = {};
  for (const [key, value] of Object.entries(chat)) {
    if (CHAT_DETAIL_META_KEYS.includes(key) || CHAT_DETAIL_CHILD_KEYS.includes(key)) continue;
    slim[key] = key === 'runs' && Array.isArray(value)
      ? value.map((run) => (isRecord(run) ? toRunStub(run) : run))
      : value;
  }
  return slim;
}

/**
 * The detail an opened chat needs, from a full chat.
 * @param {Record<string, unknown> | null | undefined} chat
 */
export function pickChatDetail(chat) {
  /** @type {Record<string, unknown>} */
  const detail = {
    runs: Array.isArray(chat?.runs) ? chat.runs : [],
    subAgentRuns: Array.isArray(chat?.subAgentRuns) ? chat.subAgentRuns : [],
    terminalHistory: Array.isArray(chat?.terminalHistory) ? chat.terminalHistory : [],
  };
  for (const key of CHAT_DETAIL_META_KEYS) {
    if (chat && chat[key] !== undefined) detail[key] = chat[key];
  }
  return detail;
}

/**
 * Lay an incoming run over the stored one. A stub keeps the stored heavy fields;
 * a full run replaces them.
 * @param {unknown} stored
 * @param {Record<string, unknown>} incoming
 */
export function mergeRunOverStored(stored, incoming) {
  if (!isRunStub(incoming) || !isRecord(stored)) return incoming;
  return { ...stored, ...incoming };
}

/**
 * @param {unknown[]} stored
 * @param {unknown[]} incoming
 * @param {(item: Record<string, unknown>) => string} keyOf
 * @param {(prior: unknown, next: Record<string, unknown>) => unknown} combine
 */
function mergeKeyed(stored, incoming, keyOf, combine) {
  /** @type {Map<string, unknown>} */
  const byKey = new Map();
  for (const item of stored) if (isRecord(item) && keyOf(item)) byKey.set(keyOf(item), item);
  for (const item of incoming) {
    if (!isRecord(item) || !keyOf(item)) continue;
    byKey.set(keyOf(item), combine(byKey.get(keyOf(item)), item));
  }
  return [...byKey.values()];
}

/**
 * Fill in what a history-omitting write of `incoming` left out, from the stored
 * copy of the same chat (JSON store). Runs and sub-agent runs merge by id and
 * are never dropped; meta detail the write did not carry is kept.
 * @param {Record<string, unknown>} incoming
 * @param {Record<string, unknown>} prior
 */
export function mergeOmittedChatDetail(incoming, prior) {
  const merged = { ...incoming };
  for (const key of CHAT_DETAIL_META_KEYS) {
    if (merged[key] === undefined && prior[key] !== undefined) merged[key] = prior[key];
  }
  if (merged.terminalHistory === undefined && prior.terminalHistory !== undefined) {
    merged.terminalHistory = prior.terminalHistory;
  }
  const runId = (item) => (typeof item.runId === 'string' ? item.runId : '');
  const runs = mergeKeyed(
    Array.isArray(prior.runs) ? prior.runs : [],
    Array.isArray(incoming.runs) ? incoming.runs : [],
    runId,
    mergeRunOverStored,
  );
  if (runs.length) merged.runs = runs;
  const subAgentRuns = mergeKeyed(
    Array.isArray(prior.subAgentRuns) ? prior.subAgentRuns : [],
    Array.isArray(incoming.subAgentRuns) ? incoming.subAgentRuns : [],
    runId,
    (_prior, next) => next,
  );
  if (subAgentRuns.length) merged.subAgentRuns = subAgentRuns;
  return merged;
}
