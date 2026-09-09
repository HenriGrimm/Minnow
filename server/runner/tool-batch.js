import {
  MAX_PARALLEL_READ_TOOLS,
  partitionToolCalls,
} from './parallel-tool-policy.js';
import { toolCallTimeoutMs, toolTimeoutMessage } from './tool-timeouts.js';

export const STOPPED_TOOL_MSG = 'Stopped by user.';

export const TOOL_ARGUMENTS_INVALID_JSON = 'Tool arguments were not valid JSON.';

export const TOOL_ARGUMENTS_EMPTY =
  'Tool arguments were empty. Retry the tool call with a complete JSON object for all required fields.';

/**
 * @param {string} raw
 * @param {{ constrained?: boolean }} [options]
 * @returns {{ args: Record<string, unknown>, parseError?: string }}
 */
export function parseToolArguments(raw, options = {}) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    if (options.constrained) {
      return { args: {}, parseError: TOOL_ARGUMENTS_EMPTY };
    }
    return { args: {} };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed };
    }
    if (options.constrained) {
      return { args: {}, parseError: TOOL_ARGUMENTS_INVALID_JSON };
    }
    return { args: {} };
  } catch {
    if (options.constrained) {
      return { args: {}, parseError: TOOL_ARGUMENTS_INVALID_JSON };
    }
    return { args: {} };
  }
}

/**
 * @template T
 * @template R
 * @param {{
 *   items: Array<{ id: string, payload: T }>,
 *   concurrency: number,
 *   signal?: AbortSignal,
 *   worker: (ctx: { item: { id: string, payload: T }, signal: AbortSignal }) => Promise<R>,
 * }} options
 * @returns {Promise<{ results: R[], aborted: boolean }>}
 */
export async function runWithConcurrency(options) {
  const signal = options.signal ?? new AbortController().signal;
  const concurrency = Math.max(1, options.concurrency);
  /** @type {Map<number, unknown>} */
  const byIndex = new Map();
  let index = 0;

  async function workerLoop() {
    while (index < options.items.length) {
      if (signal.aborted) {
        return;
      }
      const i = index;
      index += 1;
      const item = options.items[i];
      const result = await options.worker({ item, signal });
      byIndex.set(i, result);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

  /** @type {unknown[]} */
  const results = [];
  for (let i = 0; i < options.items.length; i += 1) {
    if (byIndex.has(i)) {
      results.push(byIndex.get(i));
    }
  }
  return { results, aborted: results.length < options.items.length };
}

/**
 * How long an in-flight call may keep running after an abort before we stop waiting.
 *
 * Abort has always let a running tool finish and kept its result — throwing away work that
 * was one tick from done helps nobody. That only becomes a trap when the tool never
 * finishes, so the wait is bounded rather than removed.
 */
export const ABORT_GRACE_MS = 250;

/**
 * Await a tool call, but never past the tool's ceiling (or far past an abort).
 *
 * A losing race leaves `call` pending on purpose: a tool that ignores abort cannot be
 * killed from here, so we stop *waiting* on it and let it finish into the void. Its
 * settlement is swallowed so an abandoned call cannot crash the process later.
 *
 * @param {Promise<{ content: string }>} call
 * @param {{ name: string, timeoutMs: number | null, signal?: AbortSignal }} opts
 * @returns {Promise<{ result: { content: string }, abandoned?: 'timeout' | 'aborted' }>}
 */
async function awaitToolCall(call, opts) {
  /** Resolves when `call` settles; never rejects, so it is safe inside a race. */
  const settledCall = call.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );

  /** @type {Array<Promise<{ kind: string, result?: unknown, error?: unknown }>>} */
  const races = [settledCall.then((outcome) => ({ kind: 'settled', ...outcome }))];

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
    races.push(
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), opts.timeoutMs);
      }),
    );
  }

  const signal = opts.signal;
  /** @type {(() => void) | undefined} */
  let removeAbort;
  if (signal) {
    races.push(
      new Promise((resolve) => {
        const onAbort = () => resolve({ kind: 'aborted' });
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      }),
    );
  }

  /** @type {{ kind: string, ok?: boolean, result?: unknown, error?: unknown }} */
  let winner;
  try {
    winner = await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }

  if (winner.kind === 'aborted') {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let graceTimer;
    const graced = await Promise.race([
      settledCall,
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(null), ABORT_GRACE_MS);
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (graced) winner = { kind: 'settled', ...graced };
  }

  if (winner.kind === 'settled') {
    if (winner.ok) return { result: winner.result };
    throw winner.error;
  }
  if (winner.kind === 'timeout') {
    return {
      result: { content: toolTimeoutMessage(opts.name, opts.timeoutMs) },
      abandoned: 'timeout',
    };
  }
  return { result: { content: STOPPED_TOOL_MSG }, abandoned: 'aborted' };
}

/**
 * @param {object} tc
 * @param {object} options
 */
async function runSingleToolCall(tc, options) {
  const argStr = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '';
  const { args, parseError } = parseToolArguments(argStr, {
    constrained: options.constrained,
  });

  if (options.signal?.aborted) {
    const stopped = {
      toolCall: tc,
      result: { content: STOPPED_TOOL_MSG },
    };
    options.onToolStart?.(tc, args);
    options.onToolDone?.(stopped);
    return stopped;
  }

  options.onToolStart?.(tc, args);

  if (parseError) {
    const outcome = { toolCall: tc, parseError };
    options.onToolDone?.(outcome);
    return outcome;
  }

  const name = tc?.function?.name;
  const { result, abandoned } = await awaitToolCall(
    // `await` used to tolerate an execute() that returned a plain value; the race needs a promise.
    Promise.resolve(options.execute(name, args, { toolCallId: tc.id })),
    {
      name,
      timeoutMs:
        typeof options.toolTimeoutMs === 'number'
          ? options.toolTimeoutMs
          : toolCallTimeoutMs(name),
      signal: options.signal,
    },
  );
  const outcome = { toolCall: tc, result, ...(abandoned ? { abandoned } : {}) };
  options.onToolDone?.(outcome);
  return outcome;
}

/**
 * @param {{
 *   toolCalls: object[],
 *   constrained?: boolean,
 *   signal?: AbortSignal,
 *   toolTimeoutMs?: number,
 *   execute: (name: string, args: unknown, ctx: { toolCallId: string }) => Promise<{ content: string }>,
 *   onToolStart?: (tc: object, args: unknown) => void,
 *   onToolDone?: (outcome: object) => void,
 *   onParallelSegmentStart?: (calls: object[]) => void,
 * }} options
 * @returns {Promise<object[]>}
 */
export async function executeToolCallBatch(options) {
  const toolCalls = Array.isArray(options.toolCalls) ? options.toolCalls : [];
  const segments = partitionToolCalls(toolCalls);
  /** @type {Map<string, object>} */
  const outcomeById = new Map();

  function fillStopped(calls) {
    for (const tc of calls) {
      if (outcomeById.has(tc.id)) {
        continue;
      }
      const stopped = {
        toolCall: tc,
        result: { content: STOPPED_TOOL_MSG },
      };
      options.onToolStart?.(tc, {});
      options.onToolDone?.(stopped);
      outcomeById.set(tc.id, stopped);
    }
  }

  for (const segment of segments) {
    if (options.signal?.aborted) {
      fillStopped(segment.calls);
      continue;
    }

    if (segment.kind === 'sequential') {
      for (const tc of segment.calls) {
        const outcome = await runSingleToolCall(tc, options);
        outcomeById.set(tc.id, outcome);
        if (options.signal?.aborted) {
          break;
        }
      }
      fillStopped(segment.calls);
      continue;
    }

    options.onParallelSegmentStart?.(segment.calls);

    const poolItems = segment.calls.map((tc) => ({
      id: tc.id,
      payload: tc,
    }));

    const segmentRun = await runWithConcurrency({
      items: poolItems,
      concurrency: Math.min(MAX_PARALLEL_READ_TOOLS, segment.calls.length),
      signal: options.signal,
      worker: async ({ item }) => runSingleToolCall(item.payload, options),
    });

    for (const outcome of segmentRun.results) {
      outcomeById.set(outcome.toolCall.id, outcome);
    }

    if (segmentRun.aborted) {
      fillStopped(segment.calls);
    }
  }

  fillStopped(toolCalls);

  return toolCalls.map((tc) => outcomeById.get(tc.id));
}
