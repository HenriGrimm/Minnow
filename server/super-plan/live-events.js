/**
 * Live SSE channel for Super Plan: streamed model output, tool activity and
 * research progress for the stage that is running.
 *
 * Deliberately *not* journal events: the fold is a pure function of the
 * journal, and replay must not depend on token deltas. Nothing here is ever
 * written to `~/.minnow/superplan/<runId>/journal.jsonl`.
 */

/**
 * @typedef {object} SuperPlanLiveEvent
 * @property {string} runId
 * @property {string} stage  the pipeline stage the activity belongs to
 * @property {string} [attemptId]
 * @property {Record<string, unknown>} event
 */

/** @type {Map<string, Set<(payload: SuperPlanLiveEvent) => void>>} */
const listeners = new Map();

/**
 * @param {string} runId
 * @param {(payload: SuperPlanLiveEvent) => void} handler
 * @returns {() => void}
 */
export function subscribeLive(runId, handler) {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) listeners.delete(runId);
  };
}

/**
 * @param {SuperPlanLiveEvent} payload
 * @returns {void}
 */
export function emitLive(payload) {
  const set = listeners.get(payload.runId);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(payload);
    } catch {
      /* one broken subscriber must not starve the rest */
    }
  }
}

/** Coalescing window for streamed text. */
const STREAM_MS = 120;
/** Streamed text is cumulative; the page only needs the tail. */
const STREAM_TAIL_CHARS = 6000;
const TOOL_RESULT_CHARS = 1500;

/**
 * Forward `runTurn` events for one attempt: streamed text and thinking are
 * coalesced, bulky fields are trimmed, and metering noise is dropped.
 * @param {{ runId: string, stage: string, attemptId: string }} scope
 */
export function createLiveForwarder(scope) {
  /** @type {Record<string, string>} */
  const pending = {};
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const send = (event) => emitLive({ runId: scope.runId, stage: scope.stage, attemptId: scope.attemptId, event });

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const type of Object.keys(pending)) {
      send({ type, text: pending[type] });
      delete pending[type];
    }
  };

  return {
    /** @param {Record<string, any>} event */
    emit(event) {
      if (!event || typeof event !== 'object') return;
      const type = event.type;
      if (type === 'delta' || type === 'thinking') {
        const text = typeof event.text === 'string' ? event.text : '';
        pending[type] = text.length > STREAM_TAIL_CHARS ? text.slice(-STREAM_TAIL_CHARS) : text;
        if (!timer) {
          timer = setTimeout(flush, STREAM_MS);
          timer.unref?.();
        }
        return;
      }
      if (type === 'stream_meta' || type === 'token' || type === 'reasoning_delta') return;
      flush();
      if (type === 'tool_result') {
        const content = typeof event.content === 'string' ? event.content : '';
        send({
          type,
          name: event.name,
          ...(event.id ? { id: event.id } : {}),
          content: content.length > TOOL_RESULT_CHARS ? `${content.slice(0, TOOL_RESULT_CHARS)}…` : content,
          ...(event.isError ? { isError: true } : {}),
        });
        return;
      }
      if (type === 'tool_call') {
        let args = event.arguments;
        if (typeof args === 'string' && args.length > TOOL_RESULT_CHARS) args = `${args.slice(0, TOOL_RESULT_CHARS)}…`;
        send({ type, name: event.name, ...(event.id ? { id: event.id } : {}), arguments: args });
        return;
      }
      if (type === 'round_end') {
        send({ type, index: event.index, toolCallCount: event.toolCallCount });
        return;
      }
      send(event);
    },
    flush,
  };
}
