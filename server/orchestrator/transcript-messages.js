/**
 * Map a lossy attempt transcript (TurnEvent JSONL) onto the API-message shape `renderTranscriptView` already understands.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function argsString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/**
 * Last assistant row, walking backward past tool results.
 *
 * @param {unknown[]} messages
 * @returns {{ index: number, row: Record<string, unknown> } | null}
 */
function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.role === 'assistant') return { index: i, row };
  }
  return null;
}

/**
 * True when coalesced `thinking` may rewrite this assistant row's `reasoning`.
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function canAttachThinking(row) {
  const toolCalls = row.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
  if (row.content == null) return true;
  if (typeof row.content === 'string') return row.content.trim() === '';
  return false;
}

/**
 * True when any assistant row already has visible prose (not a tool-call stub).
 *
 * @param {unknown[]} messages
 * @returns {boolean}
 */
function hasAssistantProse(messages) {
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.role !== 'assistant') continue;
    const toolCalls = row.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue;
    const text = typeof row.content === 'string' ? row.content.trim() : '';
    if (text) return true;
  }
  return false;
}

/**
 * Last tool_call id that does not yet have a matching tool row.
 *
 * @param {unknown[]} messages
 * @returns {string}
 */
function lastOpenToolCallId(messages) {
  /** @type {Set<string>} */
  const answered = new Set();
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.role === 'tool' && typeof row.tool_call_id === 'string') {
      answered.add(row.tool_call_id);
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.role !== 'assistant' || !Array.isArray(row.tool_calls)) continue;
    for (let j = row.tool_calls.length - 1; j >= 0; j -= 1) {
      const tc = row.tool_calls[j];
      const id =
        tc && typeof tc === 'object' && typeof /** @type {Record<string, unknown>} */ (tc).id === 'string'
          ? /** @type {{ id: string }} */ (tc).id
          : '';
      if (id && !answered.has(id)) return id;
    }
  }
  return '';
}

/**
 * Apply one recorded TurnEvent onto an API-message list.
 * @param {unknown[]} messages
 * @param {unknown} event
 * @returns {unknown[]}
 */
export function applyTurnEventToMessages(messages, event) {
  const list = Array.isArray(messages) ? messages : [];
  if (!event || typeof event !== 'object') return list;
  const rec = /** @type {Record<string, unknown>} */ (event);
  const type = typeof rec.type === 'string' ? rec.type : '';

  if (type === 'tool_call') {
    const name = typeof rec.name === 'string' && rec.name ? rec.name : 'tool';
    const id =
      typeof rec.id === 'string' && rec.id
        ? rec.id
        : `call_${name}_${list.length}`;
    return [
      ...list,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name, arguments: argsString(rec.arguments) },
          },
        ],
      },
    ];
  }

  if (type === 'tool_result') {
    const id =
      typeof rec.id === 'string' && rec.id ? rec.id : lastOpenToolCallId(list);
    if (!id) return list;
    return [
      ...list,
      {
        role: 'tool',
        tool_call_id: id,
        content: typeof rec.content === 'string' ? rec.content : '',
      },
    ];
  }

  if (type === 'round_end') {
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    // Some providers only supply reasoning on the settled round. Do not rely
    // on having received a live thinking frame before this checkpoint.
    const reasoning = typeof rec.reasoning === 'string' ? rec.reasoning.trim() : '';
    let next = list;
    if (reasoning) next = applyTurnEventToMessages(next, { type: 'thinking', text: reasoning });
    if (!text) return next;
    return [...next, { role: 'assistant', content: text }];
  }

  if (type === 'thinking') {
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) return list;
    const found = lastAssistant(list);
    if (found && canAttachThinking(found.row)) {
      const next = list.slice();
      next[found.index] = { ...found.row, reasoning: text };
      return next;
    }
    return [...list, { role: 'assistant', content: '', reasoning: text }];
  }

  if (type === 'context_compaction') {
    // A UI-only `context` row, the same shape main chat persists: the drawer
    // renders it as a checkpoint divider; it never reaches a model.
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const trigger = rec.trigger === 'overflow' || rec.trigger === 'manual' ? rec.trigger : 'auto';
    const summary = typeof rec.summary === 'string' ? rec.summary : '';
    return [
      ...list,
      {
        role: 'context',
        policy: 'compact',
        droppedTurns: num(rec.droppedTurns),
        ...(num(rec.droppedRounds) > 0 ? { droppedRounds: num(rec.droppedRounds) } : {}),
        summaryText: summary,
        createdAt: 0,
        compaction: {
          version: 1,
          foldThroughIndex: typeof rec.foldThroughRow === 'number' ? rec.foldThroughRow : null,
          summary,
          state: null,
          trigger,
          tokensBefore: num(rec.tokensBefore),
          tokensAfter: num(rec.tokensAfter),
        },
      },
    ];
  }

  if (type === 'attempt_end') {
    const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
    if (!summary) return list;
    if (hasAssistantProse(list)) return list;
    const found = lastAssistant(list);
    if (found) {
      const toolCalls = found.row.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        const next = list.slice();
        next[found.index] = { ...found.row, content: summary };
        return next;
      }
    }
    return [...list, { role: 'assistant', content: summary }];
  }

  return list;
}

/**
 * Fold a transcript's events into API messages for the drawer.
 *
 * @param {unknown[]} events
 * @returns {unknown[]}
 */
export function turnEventsToMessages(events) {
  /** @type {unknown[]} */
  let messages = [];
  if (!Array.isArray(events)) return messages;
  for (const event of events) {
    messages = applyTurnEventToMessages(messages, event);
  }
  return messages;
}

/**
 * Count nested tool invocations from API-shaped messages.
 *
 * @param {unknown[]} messages
 * @returns {number}
 */
export function countToolCalls(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
      n += row.tool_calls.length;
    }
  }
  return n;
}

/**
 * Reconcile an authoritative transcript with frames received while it loaded.
 * Tool ids anchor overlapping history; cumulative prose/thoughts match by
 * prefix. Message counts cannot distinguish complete history from tool stubs.
 * @param {unknown[]} history
 * @param {unknown[]} recent
 * @returns {unknown[]}
 */
export function mergeTranscriptMessages(history, recent) {
  const result = history.slice();
  let cursor = 0;
  let pending = [];
  for (const raw of recent) {
    if (!raw || typeof raw !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const match = result.findIndex((candidate, index) => index >= cursor && sameMessage(candidate, row));
    if (match < 0) {
      pending.push(row);
      continue;
    }
    result.splice(match, 0, ...pending);
    const position = match + pending.length;
    pending = [];
    const old = /** @type {Record<string, unknown>} */ (result[position]);
    const merged = { ...old, ...row };
    for (const key of ['content', 'reasoning', 'reasoning_content']) {
      if (typeof old[key] === 'string' && typeof row[key] === 'string' && old[key].startsWith(row[key])) {
        merged[key] = old[key];
      }
    }
    result[position] = merged;
    cursor = position + 1;
  }
  result.push(...pending);
  return result;
}

/** @param {unknown} candidate @param {unknown} raw @returns {boolean} */
function sameMessage(candidate, raw) {
  if (!candidate || typeof candidate !== 'object' || !raw || typeof raw !== 'object') return false;
  const a = /** @type {Record<string, any>} */ (candidate);
  const b = /** @type {Record<string, any>} */ (raw);
  if (a.role !== b.role) return false;
  if (a.role === 'tool') return Boolean(a.tool_call_id) && a.tool_call_id === b.tool_call_id;
  if (a.tool_calls?.length || b.tool_calls?.length) {
    return Boolean(a.tool_calls?.[0]?.id) && a.tool_calls[0].id === b.tool_calls?.[0]?.id;
  }
  for (const key of ['content', 'reasoning', 'reasoning_content']) {
    if (typeof a[key] === 'string' && a[key] && typeof b[key] === 'string' && b[key]) {
      if (a[key].startsWith(b[key]) || b[key].startsWith(a[key])) return true;
    }
  }
  return a.role === 'context' && JSON.stringify(a) === JSON.stringify(b);
}
