import { sumUsageSegments } from './stats-math.js';
import { createLazyToolSession, SEARCH_TOOLS_NAME } from './lazy-tools.js';
import { createSubAgentRunner } from './sub-agent-runner.js';
import { buildOpeningTranscript } from './opening-messages.js';
import { STOPPED_TOOL_MSG } from './tool-batch.js';
import { SUB_AGENT_CONTEXT_BUDGET_ERROR } from './sub-agent-outcome.js';
import {
  ASK_QUESTION_TIMEOUT_ERROR,
  ASK_QUESTION_TOOL_NAME,
  ASK_QUESTION_UNAVAILABLE_ERROR,
  DEFAULT_ASK_TIMEOUT_MS,
  isAskCapability,
  parseAskQuestionArgs,
  resolveAskTimeoutMs,
  stringifyAskAnswer,
  withAskQuestionTool,
} from './ask-question-tool.js';

export const DEFAULT_REPORT_TOOL_NAME = 'report_outcome';

export {
  ASK_QUESTION_TIMEOUT_ERROR,
  ASK_QUESTION_TOOL_NAME,
  ASK_QUESTION_UNAVAILABLE_ERROR,
  DEFAULT_ASK_TIMEOUT_MS,
};

const AGENT_OUTCOMES = new Set(['pass', 'fail', 'blocked']);

const TURN_REPORTED = Symbol('turn-reported');
const TURN_TIMEOUT = Symbol('turn-timeout');
const ASK_TIMEOUT = Symbol('ask-timeout');

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function asStringArray(value) {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value;
}

/**
 * @param {unknown} raw
 * @returns {import('./run-turn').ParseReportResult}
 */
function defaultParseReport(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error:
          'Error: report_outcome arguments must be a JSON object. The string you sent was not valid JSON. Retry with a single JSON object.',
      };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      ok: false,
      error:
        'Error: report_outcome requires a JSON object with "outcome" and "summary". Retry with an object, not an array or primitive.',
    };
  }
  const outcome = obj.outcome;
  if (!AGENT_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      error: `Error: report_outcome requires outcome "pass", "fail", or "blocked". You sent ${JSON.stringify(outcome)}. Retry with one of those three.`,
    };
  }
  if (typeof obj.summary !== 'string') {
    return {
      ok: false,
      error: 'Error: report_outcome requires "summary" as a string. Retry and include summary.',
    };
  }
  if (outcome === 'pass') {
    const evidence = asStringArray(obj.evidence);
    if (!evidence) {
      return {
        ok: false,
        error:
          'Error: report_outcome outcome "pass" requires "evidence", an array of strings (use [] if there are none). Retry with evidence.',
      };
    }
    return { ok: true, result: { outcome: 'pass', summary: obj.summary, evidence } };
  }
  if (outcome === 'fail') {
    const blockers = asStringArray(obj.blockers);
    if (!blockers) {
      return {
        ok: false,
        error:
          'Error: report_outcome outcome "fail" requires "blockers", an array of strings. Retry with blockers.',
      };
    }
    return { ok: true, result: { outcome: 'fail', summary: obj.summary, blockers } };
  }
  const needs = asStringArray(obj.needs);
  if (!needs) {
    return {
      ok: false,
      error:
        'Error: report_outcome outcome "blocked" requires "needs", an array of strings naming what the environment is missing. Retry with needs.',
    };
  }
  return { ok: true, result: { outcome: 'blocked', summary: obj.summary, needs } };
}

/**
 * @param {unknown} toolCall
 * @returns {{ name: string, id?: string, arguments: unknown }}
 */
function inspectToolCall(toolCall) {
  const fn = toolCall && typeof toolCall === 'object' ? toolCall.function : null;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  const id = typeof toolCall?.id === 'string' ? toolCall.id : undefined;
  return { name, id, arguments: fn?.arguments };
}

/**
 * @param {unknown} raw
 * @param {import('./run-turn').ParseReport | undefined} parseReport
 * @returns {import('./run-turn').ParseReportResult}
 */
function runParseReport(raw, parseReport) {
  if (typeof parseReport !== 'function') return defaultParseReport(raw);
  try {
    const out = parseReport(raw);
    if (out && out.ok === true && out.result && AGENT_OUTCOMES.has(out.result.outcome)) {
      return { ok: true, result: out.result };
    }
    if (out && out.ok === false && typeof out.error === 'string' && out.error) {
      return { ok: false, error: out.error };
    }
    return {
      ok: false,
      error:
        'Error: report_outcome rejected the payload. Retry with a valid object matching the tool schema.',
    };
  } catch (err) {
    return {
      ok: false,
      error: `Error: report_outcome could not parse the payload (${errorMessage(err)}). Retry with a valid JSON object.`,
    };
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @returns {import('./run-turn').TurnToolDefinition}
 */
function defaultReportTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description:
        'Report the outcome of this turn. Call once when finished. Do not put the outcome only in assistant text.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
          summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string' } },
        },
        required: ['outcome', 'summary'],
      },
    },
  };
}

/**
 * @param {import('./run-turn').TurnToolDefinition[] | undefined} tools
 * @param {string} reportToolName
 */
function withReportTool(tools, reportToolName) {
  const list = Array.isArray(tools) ? tools.slice() : [];
  if (list.some((tool) => tool?.function?.name === reportToolName)) return list;
  list.push(defaultReportTool(reportToolName));
  return list;
}

/**
 * @param {{ reportToolName?: string | null, injectReportTool?: boolean }} [options]
 * @returns {{ inject: boolean, reportToolName: string | null }}
 */
function resolveReportInjection(options = {}) {
  if (options.injectReportTool === false || options.reportToolName === null) {
    return { inject: false, reportToolName: null };
  }
  const reportToolName =
    typeof options.reportToolName === 'string' && options.reportToolName.trim()
      ? options.reportToolName.trim()
      : DEFAULT_REPORT_TOOL_NAME;
  return { inject: true, reportToolName };
}

/**
 * @param {import('./run-turn').TurnToolDefinition[] | undefined} tools
 * @param {{ reportToolName?: string | null, injectReportTool?: boolean, ask?: unknown }} [options]
 * @returns {import('./run-turn').TurnToolDefinition[]}
 */
export function resolveTurnTools(tools, options = {}) {
  const withAsk = withAskQuestionTool(tools, options.ask);
  const injection = resolveReportInjection(options);
  if (!injection.inject || !injection.reportToolName) return withAsk;
  return withReportTool(withAsk, injection.reportToolName);
}

export { buildOpeningMessages, buildOpeningTranscript } from './opening-messages.js';

// ── Abort ────────────────────────────────────────────────────────────────────

/**
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
function anySignal(signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return new AbortController().signal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live);
  const ctrl = new AbortController();
  for (const signal of live) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      return ctrl.signal;
    }
    signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl.signal;
}

function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

/**
 * @param {AbortSignal} signal
 * @returns {Promise<never>}
 */
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      err.cause = signal.reason;
      reject(err);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

// ── Ask ──────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} rawArgs
 * @param {{
 *   ask: unknown,
 *   askTimeoutMs?: number,
 *   signal?: AbortSignal,
 *   turnTimeoutSignal?: AbortSignal,
 *   chatId: string,
 * }} opts
 * @returns {Promise<string>}
 */
async function runAskCapability(rawArgs, opts) {
  if (!isAskCapability(opts.ask)) {
    return ASK_QUESTION_UNAVAILABLE_ERROR;
  }
  const timeoutMs = resolveAskTimeoutMs(opts.askTimeoutMs);
  const askTimeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    askTimeoutCtrl.abort(ASK_TIMEOUT);
  }, timeoutMs);
  const combined = anySignal(
    [opts.signal, opts.turnTimeoutSignal, askTimeoutCtrl.signal].filter(Boolean),
  );
  try {
    const askPromise = Promise.resolve().then(() =>
      opts.ask.ask(parseAskQuestionArgs(rawArgs), {
        signal: combined,
        chatId: opts.chatId,
      }),
    );
    const abortPromise = waitForAbort(combined);
    try {
      const answer = await Promise.race([askPromise, abortPromise]);
      return stringifyAskAnswer(answer);
    } catch (err) {
      if (opts.turnTimeoutSignal?.aborted) {
        const timeoutErr = new Error('maxTurns or wallClockMs exceeded');
        timeoutErr[TURN_TIMEOUT] = true;
        throw timeoutErr;
      }
      if (opts.signal?.aborted) {
        throw isAbortError(err) ? err : Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (askTimeoutCtrl.signal.aborted) {
        return ASK_QUESTION_TIMEOUT_ERROR;
      }
      if (isAbortError(err)) throw err;
      return `Error: ask_question failed (${errorMessage(err)}).`;
    } finally {
      askPromise.catch(() => {});
      abortPromise.catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

// ── Turn events ──────────────────────────────────────────────────────────────

/**
 * @param {((event: import('./run-turn').TurnEvent) => void) | undefined} onEvent
 * @param {import('./run-turn').TurnEvent} event
 */
function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(event);
  } catch {
  }
}

/**
 * @param {unknown} outcome
 * @returns {import('./run-turn').TurnEvent | null}
 */
function toolResultEventFromOutcome(outcome) {
  const tc = outcome && typeof outcome === 'object' ? outcome.toolCall : null;
  const fn = tc && typeof tc === 'object' ? tc.function : null;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  if (!name) return null;
  const id = typeof tc?.id === 'string' ? tc.id : undefined;
  if (typeof outcome.parseError === 'string' && outcome.parseError) {
    return {
      type: 'tool_result',
      name,
      ...(id ? { id } : {}),
      content: outcome.parseError,
      isError: true,
    };
  }
  const result = outcome.result && typeof outcome.result === 'object' ? outcome.result : {};
  const content = typeof result.content === 'string' ? result.content : '';
  /** @type {import('./run-turn').TurnEvent} */
  const event = { type: 'tool_result', name, content };
  if (id) event.id = id;
  if (Array.isArray(result.attachments) && result.attachments.length > 0) {
    event.attachments = result.attachments;
  }
  if (result.codeChange !== undefined) event.codeChange = result.codeChange;
  if (result.isError === true || content === STOPPED_TOOL_MSG) event.isError = true;
  return event;
}

/**
 * @param {unknown} raw
 * @returns {import('./transcript-store').TranscriptMessage[]}
 */
function normalizeRoundBoundaryRows(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  /** @type {import('./transcript-store').TranscriptMessage[]} */
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || typeof row.role !== 'string') continue;
    /** @type {import('./transcript-store').TranscriptMessage} */
    const next = { role: row.role };
    if ('content' in row) next.content = row.content;
    if (typeof row.tool_call_id === 'string') next.tool_call_id = row.tool_call_id;
    if (Array.isArray(row.tool_calls)) next.tool_calls = row.tool_calls;
    out.push(next);
  }
  return out;
}

/**
 * @param {import('./transcript-store').TranscriptStore} store
 * @param {string} chatId
 * @param {unknown[]} messages
 * @param {{ from?: number }} [opts]
 */
function persistNewMessages(store, chatId, messages, opts = {}) {
  if (!store || typeof store.append !== 'function') return;
  if (!Array.isArray(messages)) return;
  const aligned =
    typeof opts.from === 'number' ? opts.from : (store.load(chatId)?.messages?.length ?? 0);
  if (messages.length <= aligned) return;
  for (let i = aligned; i < messages.length; i += 1) {
    store.append(chatId, messages[i]);
  }
}

// ── Run turn ─────────────────────────────────────────────────────────────────

/**
 * @param {import('./run-turn').RunTurnOptions} options
 * @returns {Promise<import('./run-turn').TurnResult>}
 */
export async function runTurn(options) {
  if (!options || typeof options !== 'object') {
    return { outcome: 'crashed', error: 'runTurn: options object is required' };
  }
  const chatId = String(options.chatId ?? '');
  if (!chatId) {
    return { outcome: 'crashed', error: 'runTurn: chatId is required' };
  }
  const deps = options.deps;
  if (!deps) {
    return { outcome: 'crashed', error: 'runTurn: deps are required' };
  }
  const model = options.model;
  if (!model?.providerId || !model?.id) {
    return { outcome: 'crashed', error: 'runTurn: model.providerId and model.id are required' };
  }

  const injection = resolveReportInjection(options);
  const reportToolName = injection.reportToolName;
  const catalog = resolveTurnTools(options.tools, {
    reportToolName: options.reportToolName,
    injectReportTool: options.injectReportTool,
    ask: options.ask,
  });
  let lazyTools = options.lazyTools !== true ? null : createLazyToolSession(
    catalog, reportToolName ? [reportToolName] : [],
  );
  let tools = lazyTools?.tools ?? catalog;
  const seed = typeof options.seed === 'string' ? options.seed : '';
  const limits = options.limits ?? {};
  const transcript = options.transcript ?? deps.transcriptStore;
  const onEvent = options.onEvent;
  const cwd = options.cwd;
  /** @type {unknown[] | undefined} */
  let priorMessages;
  if (Array.isArray(options.messages)) {
    priorMessages = options.messages;
  } else if (options.seedKind === 'continue') {
    priorMessages = transcript.load(chatId)?.messages ?? [];
  }
  const isContinueTurn = priorMessages !== undefined;
  const systemPrompt =
    typeof options.systemPrompt === 'string' && options.systemPrompt.trim()
      ? options.systemPrompt
      : injection.inject
        ? 'When you have a result, call the report tool. Do not put the outcome only in assistant text.'
        : 'You are a helpful assistant.';

  const continuePersistFrom =
    priorMessages === undefined
      ? 0
      : buildOpeningTranscript(systemPrompt, seed, priorMessages).persistFrom;
  let persistCursor = continuePersistFrom;

  /** @type {import('./run-turn').TurnResult | null} */
  let captured = null;
  let completionCount = 0;
  const timeoutCtrl = new AbortController();
  let wallTimer = null;
  if (typeof limits.wallClockMs === 'number' && limits.wallClockMs > 0) {
    wallTimer = setTimeout(() => {
      timeoutCtrl.abort(TURN_TIMEOUT);
    }, limits.wallClockMs);
  }

  const combinedSignal = anySignal(
    [options.signal, timeoutCtrl.signal].filter(Boolean),
  );

  const countedPost = async (provider, body, signal, postOptions) => {
    if (typeof limits.maxTurns === 'number' && completionCount >= limits.maxTurns) {
      timeoutCtrl.abort(TURN_TIMEOUT);
      const err = new Error('maxTurns exceeded');
      err[TURN_TIMEOUT] = true;
      throw err;
    }
    completionCount += 1;
    return deps.postChatCompletions(provider, body, signal, postOptions);
  };

  const interceptingBatch = async (batchOptions) => {
    const toolCalls = batchOptions?.toolCalls ?? [];
    for (const toolCall of toolCalls) {
      const inspected = inspectToolCall(toolCall);
      if (!inspected.name) continue;
      emit(onEvent, {
        type: 'tool_call',
        name: inspected.name,
        id: inspected.id,
        arguments: inspected.arguments,
      });
    }

    /** @type {Array<{ toolCall: unknown, result: { content: string } }>} */
    const outcomes = [];
    /** @type {unknown[]} */
    const otherCalls = [];
    const callableNames = new Set(tools.map(tool => tool.function.name));
    for (const toolCall of toolCalls) {
      const inspected = inspectToolCall(toolCall);
      if (lazyTools && inspected.name !== ASK_QUESTION_TOOL_NAME &&
          (inspected.name === SEARCH_TOOLS_NAME || !callableNames.has(inspected.name))) {
        const content = inspected.name === SEARCH_TOOLS_NAME && callableNames.has(SEARCH_TOOLS_NAME)
          ? lazyTools.search(inspected.arguments)
          : 'Error: tool is not loaded or available. Use search_tools to find permitted tools before calling them.';
        emit(onEvent, { type: 'tool_result', name: inspected.name, id: inspected.id,
          content, ...(content.startsWith('Error:') ? { isError: true } : {}) });
        outcomes.push({ toolCall, result: { content } });
        continue;
      }
      if (inspected.name === ASK_QUESTION_TOOL_NAME) {
        const content = await runAskCapability(inspected.arguments, {
          ask: options.ask,
          askTimeoutMs: options.askTimeoutMs,
          signal: options.signal,
          turnTimeoutSignal: timeoutCtrl.signal,
          chatId,
        });
        emit(onEvent, {
          type: 'tool_result',
          name: ASK_QUESTION_TOOL_NAME,
          id: inspected.id,
          content,
          ...(content.startsWith('Error:') ? { isError: true } : {}),
        });
        outcomes.push({ toolCall, result: { content } });
        continue;
      }
      if (inspected.name !== reportToolName) {
        otherCalls.push(toolCall);
        continue;
      }
      const parsed = runParseReport(inspected.arguments, options.parseReport);
      if (parsed.ok) {
        captured = parsed.result;
        const content = 'Outcome recorded.';
        emit(onEvent, {
          type: 'tool_result',
          name: reportToolName,
          id: inspected.id,
          content,
        });
        outcomes.push({ toolCall, result: { content } });
      } else {
        emit(onEvent, {
          type: 'tool_result',
          name: reportToolName,
          id: inspected.id,
          content: parsed.error,
          isError: true,
        });
        outcomes.push({ toolCall, result: { content: parsed.error } });
      }
    }

    if (captured) {
      const err = new Error('turn reported');
      err[TURN_REPORTED] = captured;
      throw err;
    }

    if (otherCalls.length === 0) return outcomes;

    const execute = async (name, args, ctx) => {
      if (typeof options.execute === 'function') {
        return options.execute(name, args, {
          toolCallId: ctx.toolCallId,
          chatId,
          cwd,
        });
      }
      return { content: '' };
    };

    const seenToolResultIds = new Set();
    const emitOutcome = (outcome) => {
      const event = toolResultEventFromOutcome(outcome);
      if (!event) return;
      const id = event.id;
      if (id) {
        if (seenToolResultIds.has(id)) return;
        seenToolResultIds.add(id);
      }
      emit(onEvent, event);
    };

    const rest = await deps.runHeadlessToolBatch({
      ...batchOptions,
      toolCalls: otherCalls,
      execute,
      onToolDone: (outcome) => {
        emitOutcome(outcome);
        if (typeof batchOptions.onToolDone === 'function') batchOptions.onToolDone(outcome);
      },
    });
    if (Array.isArray(rest)) {
      for (const outcome of rest) emitOutcome(outcome);
      outcomes.push(...rest);
    }
    return outcomes;
  };

  const wrappedDeps = {
    ...deps,
    transcriptStore: transcript,
    postChatCompletions: countedPost,
    runHeadlessToolBatch: interceptingBatch,
    resolveSamplerPreset: (input) =>
      model.sampler ?? deps.resolveSamplerPreset(input),
    resolveThinkingMode: (input) =>
      model.thinking?.mode
        ? { mode: model.thinking.mode }
        : deps.resolveThinkingMode(input),
    resolveThinkingBudgetTokens: (input) =>
      model.thinking && 'budgetTokens' in model.thinking
        ? { budgetTokens: model.thinking.budgetTokens ?? null }
        : deps.resolveThinkingBudgetTokens(input),
  };

  if (transcript && model.thinking?.mode) {
    transcript.setMeta(chatId, { thinkingMode: model.thinking.mode });
  }

  let lastDelta = '';
  let lastThinking = '';
  let lastStreamingTool = '';
  /** @type {string | null} */
  let lastPhase = null;
  let lastSnapshot = null;

  const runner = createSubAgentRunner(wrappedDeps);

  /** @type {Array<Record<string, number>>} */
  const usageSegments = [];
  /** @type {Record<string, number> | undefined} */
  let usage;
  /** @type {import('../../src/agents/types').SubAgentRunnerOutput | null} */
  let ran = null;

  /**
   * @param {import('./run-turn').TurnResult} result
   * @returns {import('./run-turn').TurnResult}
   */
  const withUsage = (result) => {
    if (!usage && usageSegments.length > 0) usage = sumUsageSegments(usageSegments);
    return usage ? { ...result, usage } : result;
  };

  try {
    ran = await runner.run({
      runId: chatId,
      type: 'turn',
      task: seed,
      systemPrompt,
      tools,
      refreshRoundConfig: async () => {
        const updated = await options.refreshRoundConfig?.();
        if (!updated) return null;
        const catalog = resolveTurnTools(updated.tools, {
          reportToolName: options.reportToolName,
          injectReportTool: options.injectReportTool,
          ask: options.ask,
        });
        lazyTools = options.lazyTools !== true ? null : createLazyToolSession(
          catalog, reportToolName ? [reportToolName] : [],
        );
        tools = lazyTools?.tools ?? catalog;
        return { systemPrompt: updated.systemPrompt, tools };
      },
      providerId: model.providerId,
      modelId: model.id,
      parentChatId: chatId,
      contextBudget: limits.contextBudget,
      modelContextLimit: limits.modelContextLimit,
      signal: combinedSignal,
      toolExecuteContext: { chatId, cwd },
      priorMessages,
      nudgeToolUse: options.nudgeToolUse,
      finalizeStructuredOutcome: options.finalizeStructuredOutcome,
      reportToolName: injection.inject ? reportToolName : null,
      summarySchema: options.summarySchema,
      executeTool: async (name, args, ctx) => {
        if (typeof options.execute === 'function') {
          return options.execute(name, args, {
            toolCallId: ctx?.toolCallId,
            chatId,
            cwd,
          });
        }
        return { content: '' };
      },
      onMessagesChange: (messages, meta) => {
        if (!isContinueTurn) {
          persistNewMessages(transcript, chatId, messages);
        } else if (meta?.settled === true && Array.isArray(messages)) {
          persistNewMessages(transcript, chatId, messages, { from: persistCursor });
          persistCursor = messages.length;
          lastSnapshot = messages;
        }
        if (!Array.isArray(messages) || messages.length === 0) return;
        const last = messages[messages.length - 1];
        if (last?.role !== 'assistant') return;
        const text = typeof last.content === 'string' ? last.content : '';
        if (!text || text === lastDelta) return;
        lastDelta = text;
        emit(onEvent, { type: 'delta', text });
      },
      onTurnEvent: (event) => {
        if (event.type === 'response_restart') { lastDelta = ''; lastThinking = ''; lastStreamingTool = ''; }
        emit(onEvent, event);
      },
      onRoundBoundary:
        typeof options.onRoundBoundary === 'function'
          ? () => {
              try {
                const spliced = normalizeRoundBoundaryRows(options.onRoundBoundary());
                if (spliced.length === 0) return null;
                if (isContinueTurn) persistCursor += spliced.length;
                return spliced;
              } catch {
                return null;
              }
            }
          : undefined,
      onUsage: (segment) => {
        if (segment && typeof segment === 'object') usageSegments.push(segment);
      },
      onLiveActivity: (activity) => {
        const phase = activity?.phase;
        if (
          (phase === 'generating' || phase === 'thinking' || phase === 'tools') &&
          phase !== lastPhase
        ) {
          lastPhase = phase;
          emit(onEvent, { type: 'phase', phase });
        }
        const thinking = activity?.partialReasoning;
        if (typeof thinking === 'string' && thinking && thinking !== lastThinking) {
          lastThinking = thinking;
          emit(onEvent, { type: 'thinking', text: thinking });
        }
        const toolName =
          typeof activity?.currentToolName === 'string'
            ? activity.currentToolName.trim()
            : '';
        if (toolName && toolName !== lastStreamingTool) {
          lastStreamingTool = toolName;
          emit(onEvent, { type: 'tool_streaming', name: toolName });
        }
      },
    });
    if (ran?.usage) usage = ran.usage;
  } catch (err) {
    if (captured) return withUsage(captured);
    if (err?.[TURN_REPORTED]) return withUsage(err[TURN_REPORTED]);
    if (err?.[TURN_TIMEOUT] || timeoutCtrl.signal.aborted) {
      return withUsage({ outcome: 'timeout' });
    }
    if (options.signal?.aborted && isAbortError(err)) {
      return withUsage({ outcome: 'crashed', error: 'aborted' });
    }
    return withUsage({ outcome: 'crashed', error: errorMessage(err) });
  } finally {
    if (isContinueTurn && lastSnapshot) {
      persistNewMessages(transcript, chatId, lastSnapshot, {
        from: persistCursor,
      });
    }
    if (wallTimer) clearTimeout(wallTimer);
  }

  if (captured) return withUsage(captured);
  if (timeoutCtrl.signal.aborted) return withUsage({ outcome: 'timeout' });
  // Compact that cannot shrink used to fall through as a quiet success.
  if (ran?.contextBudgetExhausted) {
    const error =
      typeof ran.summary === 'string' && ran.summary.trim()
        ? ran.summary.trim()
        : SUB_AGENT_CONTEXT_BUDGET_ERROR;
    return withUsage({ outcome: 'crashed', error });
  }
  return withUsage({ outcome: 'no_report' });
}
