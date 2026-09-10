import { randomUUID } from 'node:crypto';
import { agentBrowserToolDefinition } from '../tools/agent-browser-tool-defs.js';

import {
  createInProcessToolDispatch,
  createMemoryTranscriptStore,
  headlessToolIdsForRole,
  postChatCompletionsInProcess,
  runTurn as defaultRunTurn,
} from '../runner/node.js';
import {
  ASK_QUESTION_TOOL_NAME,
  DEFAULT_REPORT_TOOL_NAME,
} from '../runner/run-turn.js';
import {
  resolveSummarySchemaPreset,
  validateStructuredOutcomeForPreset,
} from '../runner/sub-agent-summary-schemas.js';
import {
  agentContextBudgetFromSubAgentType,
  applyContextBudget,
  resolveContextBudget,
} from '../runner/context-budget.js';
import { cancel as cancelGeneration, listGenerationStates } from '../generations/store.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { getProvider } from '../providers/store.js';
import { attemptLimits } from '../orchestrator/attempt-limits.js';
import { emitLive } from '../orchestrator/live-events.js';
import { shouldEmitSubAgentLiveTurnEvent } from '../runner/turn-event.js';
import { resolveAttemptModel } from '../orchestrator/model-binding.js';
import { peekEngine } from '../orchestrator/engine.js';
import {
  DEFAULT_AGENT_MAX_TOKENS,
  readGlobalSamplerForTurn,
  wrapSamplerForTurn,
} from '../agents/sampler.js';
import {
  flushTranscripts,
  readTranscript,
  recordTranscriptEnd,
  recordTranscriptEvent,
} from '../orchestrator/transcripts.js';
import { turnEventsToMessages } from '../orchestrator/transcript-messages.js';
import { SUB_AGENT_ROLE } from './events.js';
import { AGENTS_NAMESPACE, lastEndedAttempt } from './derive.js';
import { agentsDir } from './journal.js';
import { getSubAgentTypeRow, loadSubAgentFile } from './config.js';
import { loadSubAgentSystemPrompt } from './prompts.js';
import {
  formatAgentBrowserGuideForTranscript,
  registerAgentBrowserRuntime,
} from '../browser-agent-api.js';

const LIVE_DELTA_MS = 80;
const LIVE_PARTIAL_CAP = 400;

/**
 * Pending cumulative assistant text per attempt, flushed on a timer.
 *
 * @type {Map<string, { text: string, timer: ReturnType<typeof setTimeout> | null, parentChatId: string, runId: string, attemptId: string }>}
 */
const liveDeltaByAttempt = new Map();

/**
 * Attempt-id prefix so orphan cancel does not steal board live-attempt ids
 * (`r-…` from the board effector). Untagged persist:false streams are left
 * alone for the same reason.
 */
const ATTEMPT_PREFIX = 'sa-';

/**
 * Spawn tools stay denied even if a type row forgets them. A sub-agent that
 * can spawn is the fan-out the shipped defaults exist to stop.
 */
const ALWAYS_DENIED = Object.freeze([
  'spawn_sub_agent',
  'cancel_sub_agent',
  'list_sub_agents',
  'get_sub_agent_status',
]);

/**
 * Attempt ids currently visible to some sub-agent effector's `inspect()`.
 *
 * Module-scoped so two parent chats in one process do not cancel each other,
 * and so a board effector's live set is a different set.
 *
 * @type {Set<string>}
 */
const liveAttemptIds = new Set();

/**
 * Cancel persist:false generations owned by a vanished sub-agent attempt.
 *
 * Sibling of `cancelOrphanedRunnerGenerations`: it only touches chatIds that
 * start with {@link ATTEMPT_PREFIX}. Board streams (`r-…`) and untagged
 * persist:false gens are left alone.
 *
 * @returns {number} how many generations were cancelled
 */
export function cancelOrphanedSubAgentGenerations() {
  let n = 0;
  for (const state of listGenerationStates()) {
    if (state.status !== 'pending' && state.status !== 'streaming') continue;
    if (state.persist !== false) continue;
    const owner = typeof state.chatId === 'string' ? state.chatId : '';
    if (!owner.startsWith(ATTEMPT_PREFIX)) continue;
    if (liveAttemptIds.has(owner)) continue;
    cancelGeneration(state);
    n += 1;
  }
  return n;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

/**
 * Last committed assistant prose on a memory transcript.
 * Tool-call-only rows are skipped — those are not a summary.
 *
 * @param {unknown} messages
 * @returns {string}
 */
function lastAssistantProse(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (!row || typeof row !== 'object') continue;
    if (/** @type {{ role?: string }} */ (row).role !== 'assistant') continue;
    const toolCalls = /** @type {{ tool_calls?: unknown }} */ (row).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue;
    const text =
      typeof /** @type {{ content?: unknown }} */ (row).content === 'string'
        ? /** @type {{ content: string }} */ (row).content.trim()
        : '';
    if (text) return text;
  }
  return '';
}

/**
 * Boards stay on the report tool. Sub-agents that stream real prose (or a
 * valid structured JSON blob) without calling `report_outcome` used to land as
 * `no_report` → retry → abandon with an empty parent message. Map that to a
 * degraded pass here, not inside `runTurn`.
 *
 * @param {import('../runner/run-turn').TurnResult} result
 * @param {unknown} messages
 * @param {string} schemaId
 * @returns {import('../runner/run-turn').TurnResult}
 */
export function degradeNoReportIfProse(result, messages, schemaId) {
  if (!result || result.outcome !== 'no_report') return result;
  const prose = lastAssistantProse(messages);
  if (!prose) return result;
  try {
    const parsed = JSON.parse(prose);
    const structured = validateStructuredOutcomeForPreset(
      parsed,
      resolveSummarySchemaPreset(schemaId),
    );
    if (structured) {
      return { ...result, outcome: 'pass', summary: structured.summary };
    }
  } catch {
  }
  return { ...result, outcome: 'pass', summary: prose };
}

/**
 * Resume a continue-seed from the lossy disk transcript after a process
 * restart (in-memory `transcriptByRun` does not survive).
 *
 * @param {string} parentChatId
 * @param {import('./types').RunState} run
 * @returns {Promise<unknown[] | undefined>}
 */
async function loadContinuePriorFromDisk(parentChatId, run) {
  const last = lastEndedAttempt(run);
  if (!last?.attemptId) return undefined;
  const entryDir = agentsDir(parentChatId);
  try {
    await flushTranscripts(parentChatId, last.attemptId, { entryDir });
    const { events } = await readTranscript(parentChatId, last.attemptId, { entryDir });
    const mapped = turnEventsToMessages(events);
    if (mapped.length === 0) return undefined;
    const hasUser = mapped.some(
      (row) => row && typeof row === 'object' && /** @type {{ role?: string }} */ (row).role === 'user',
    );
    if (hasUser) return mapped;
    return [{ role: 'user', content: run.task }, ...mapped];
  } catch {
    return undefined;
  }
}

/**
 * @param {{ parentChatId: string, runId: string, attemptId: string, text: string }} buf
 * @returns {void}
 */
function emitPartialDelta(buf) {
  if (!buf.text) return;
  emitLive({
    key: buf.parentChatId,
    boardId: buf.parentChatId,
    attemptId: buf.attemptId,
    taskId: buf.runId,
    role: SUB_AGENT_ROLE,
    event: { type: 'delta', text: buf.text.slice(-LIVE_PARTIAL_CAP) },
  });
}

/**
 * Coalesce cumulative `delta` text and emit at most every {@link LIVE_DELTA_MS}.
 *
 * @param {{ parentChatId: string, runId: string, attemptId: string }} meta
 * @param {string} text
 * @returns {void}
 */
function noteLiveDelta(meta, text) {
  let buf = liveDeltaByAttempt.get(meta.attemptId);
  if (!buf) {
    buf = { text: '', timer: null, ...meta };
    liveDeltaByAttempt.set(meta.attemptId, buf);
  }
  buf.text = text;
  if (buf.timer) return;
  buf.timer = setTimeout(() => {
    buf.timer = null;
    emitPartialDelta(buf);
  }, LIVE_DELTA_MS);
  buf.timer.unref?.();
}

/**
 * Flush a pending delta so the last tokens are not stuck in the timer.
 *
 * @param {string} attemptId
 * @returns {void}
 */
function flushLiveDelta(attemptId) {
  const buf = liveDeltaByAttempt.get(attemptId);
  if (!buf) return;
  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }
  emitPartialDelta(buf);
}

/**
 * @param {string} attemptId
 * @returns {void}
 */
function clearLiveDelta(attemptId) {
  flushLiveDelta(attemptId);
  liveDeltaByAttempt.delete(attemptId);
}

/**
 * OpenAI function stubs. Full parameter schemas live in the renderer catalog;
 * the server must not import that TS module. Names are what the allow-list
 * and dispatch key on.
 *
 * @param {string[]} ids
 * @returns {import('../runner/run-turn').TurnToolDefinition[]}
 */
function toolDefsFor(ids) {
  return ids.map((name) => agentBrowserToolDefinition(name) ?? ({
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', additionalProperties: true },
    },
  }));
}

/**
 * Headless default, then the per-type allow/deny list. Resolved once per
 * type id — do not re-walk the catalog on every turn of the same run.
 *
 * Sub-agents are not role `final`, so `headlessToolIdsForRole` yields
 * `DEFAULT_HEADLESS_TOOL_IDS` and no `browser_drive_*` tools.
 *
 * @param {Record<string, unknown>} typeRow
 * @returns {string[]}
 */
export function resolveSubAgentToolIds(typeRow) {
  let ids = [...headlessToolIdsForRole(SUB_AGENT_ROLE)];
  if (Array.isArray(typeRow.allowedTools) && typeRow.allowedTools.length > 0) {
    const allow = new Set(typeRow.allowedTools.filter((n) => typeof n === 'string'));
    ids = ids.filter((name) => allow.has(name));
  }
  const deny = new Set([
    ...ALWAYS_DENIED,
    ...(Array.isArray(typeRow.deniedTools)
      ? typeRow.deniedTools.filter((n) => typeof n === 'string')
      : []),
  ]);
  ids = ids.filter((name) => !deny.has(name) && name !== ASK_QUESTION_TOOL_NAME);
  return ids;
}

/**
 * `summarySchema` → `parseReport`. Accepts the structured-outcome payload
 * (`minnow.sub-agent.v1`) *or* the PRD `report_outcome` union so a fake host
 * (and a model that already knows the board report tool) can still finish.
 *
 * @param {string} schemaId
 * @returns {import('../runner/run-turn').ParseReport}
 */
export function parseReportForSchema(schemaId) {
  const preset = resolveSummarySchemaPreset(schemaId);
  return (raw) => {
    let obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          error:
            'Error: report arguments must be a JSON object. The string you sent was not valid JSON. Retry with a single JSON object.',
        };
      }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {
        ok: false,
        error: 'Error: report requires a JSON object. Retry with an object, not an array or primitive.',
      };
    }
    const rec = /** @type {Record<string, unknown>} */ (obj);
    const structured = validateStructuredOutcomeForPreset(rec, preset);
    if (structured) {
      return {
        ok: true,
        result: {
          outcome: 'pass',
          summary: structured.summary,
          evidence: structured.artifacts.map((a) => a.ref),
        },
      };
    }
    const outcome = rec.outcome;
    if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'blocked') {
      return {
        ok: false,
        error: `Error: report requires a ${schemaId} payload (summary, findings, artifacts) or outcome "pass" | "fail" | "blocked". Retry.`,
      };
    }
    if (typeof rec.summary !== 'string') {
      return {
        ok: false,
        error: 'Error: report requires "summary" as a string. Retry and include summary.',
      };
    }
    if (outcome === 'pass') {
      const evidence = Array.isArray(rec.evidence) ? rec.evidence.filter((x) => typeof x === 'string') : [];
      return { ok: true, result: { outcome: 'pass', summary: rec.summary, evidence } };
    }
    if (outcome === 'fail') {
      const blockers = Array.isArray(rec.blockers) ? rec.blockers.filter((x) => typeof x === 'string') : [];
      return { ok: true, result: { outcome: 'fail', summary: rec.summary, blockers } };
    }
    const needs = Array.isArray(rec.needs) ? rec.needs.filter((x) => typeof x === 'string') : [];
    return { ok: true, result: { outcome: 'blocked', summary: rec.summary, needs } };
  };
}

/**
 * @param {string} attemptId
 * @param {string} runId
 * @param {import('../runner/run-turn').TurnResult} result
 * @returns {import('../orchestrator/engine.js').AttemptEnd}
 */
function toAttemptEnd(attemptId, runId, result) {
  /** @type {Record<string, unknown>} */
  const evidence = {};
  if (result.outcome === 'pass' && Array.isArray(result.evidence)) {
    evidence.evidence = result.evidence;
  }
  if (result.outcome === 'fail' && Array.isArray(result.blockers)) {
    evidence.blockers = result.blockers;
  }
  if (result.outcome === 'blocked' && Array.isArray(result.needs)) {
    evidence.needs = result.needs;
  }
  if (result.outcome === 'crashed' && typeof result.error === 'string') {
    evidence.error = result.error;
  }

  /** @type {import('../orchestrator/engine.js').AttemptEnd} */
  const end = {
    attemptId,
    taskId: runId,
    role: SUB_AGENT_ROLE,
    outcome: result.outcome,
  };
  if (result.outcome === 'pass' || result.outcome === 'fail' || result.outcome === 'blocked') {
    end.summary = result.summary;
  } else if (result.outcome === 'crashed') {
    end.summary = result.error;
  }
  if (Object.keys(evidence).length > 0) end.evidence = evidence;
  if (result.usage && typeof result.usage === 'object') {
    /** @type {Record<string, number>} */
    const usage = {};
    for (const [key, value] of Object.entries(result.usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
    }
    if (Object.keys(usage).length > 0) end.usage = usage;
  }
  return end;
}

/**
 * Server-side `RunnerDeps`. Sampler / thinking on the `TurnModel` win
 * (`bindTypeModel` wraps type JSON as `{ preset, maxTokens }` and inherits
 * Settings max when the type omits it). The stub is the shipped Settings
 * default, not 2048. A missing capability probe must not block a turn.
 *
 * @param {import('../runner/adapters').PostChatCompletions} postChatCompletions
 * @returns {import('../runner/adapters').RunnerDeps}
 */
function createServerRunnerDeps(postChatCompletions) {
  return {
    transcriptStore: createMemoryTranscriptStore(),
    postChatCompletions,
    runHeadlessToolBatch: async () => [],
    resolveProvider: async (providerId) => {
      if (providerId === 'minnow-router') return { id: providerId, label: 'Router', baseUrl: '', apiKind: 'openai-v1' };
      const row = await getProvider(providerId);
      return {
        id: row.id,
        label: row.label,
        baseUrl: row.baseUrl,
        apiKind: row.apiKind,
        chatCompletionsPath: row.chatCompletionsPath,
      };
    },
    getSubAgentTypeConfig: async (typeId) => (await getSubAgentTypeRow(String(typeId))) ?? {},
    // Last-ditch only: production `bindTypeModel` attaches `{ preset, maxTokens }`.
    // 2048 here reintroduced finish_reason: length when a type omitted maxTokens.
    resolveSamplerPreset: () => ({ preset: {}, maxTokens: DEFAULT_AGENT_MAX_TOKENS }),
    resolveThinkingMode: () => ({ mode: 'off' }),
    resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
    loadToolCallsMeta: async () => {},
    getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
    isConstrainedDecodingEnabledForProvider: () => false,
    readProviderCapabilities: async () => null,
    isStructuredOutcomeResponseFormatAvailable: () => false,
    resolveSendCapabilities: () => ({}),
    resolveModelContextLimit: () => null,
    applyContextPolicy: async (input) => ({
      applied: false,
      messages: input?.messages ?? [],
    }),
  };
}

/**
 * Map a type row onto `TurnModel`. Sampler in `sub-agents.json` is a flat
 * preset (`temperature` / `topP` / …). `runTurn` needs `{ preset, maxTokens }`
 * because it substitutes the whole object for `deps.resolveSamplerPreset` —
 * a flat row would crash `applySamplerToBody`. Types that omit `maxTokens`
 * inherit Settings → Sampler max, not 2048.
 *
 * `thinkingMode: inherit` leaves the bound model alone — a type that does
 * not opt in must not flip thinking.
 *
 * @param {{ providerId: string, id: string }} model
 * @param {Record<string, unknown>} typeRow
 * @param {{ preset: Record<string, unknown>, maxTokens: number }} [globalSampler]
 * @returns {{ providerId: string, id: string, sampler?: object, thinking?: object }}
 */
function bindTypeModel(model, typeRow, globalSampler) {
  /** @type {{ providerId: string, id: string, sampler?: object, thinking?: object }} */
  const turnModel = { ...model };
  const fallbackMax = globalSampler?.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS;
  if (typeRow.sampler && typeof typeRow.sampler === 'object') {
    // Honor an explicit type cap; otherwise inherit Settings → Sampler max.
    turnModel.sampler = wrapSamplerForTurn(typeRow.sampler, fallbackMax);
  } else {
    // Type omitted sampler entirely — still attach Settings so `runTurn`
    // does not fall through to the deps stub.
    turnModel.sampler = globalSampler ?? wrapSamplerForTurn(null, fallbackMax);
  }
  const thinking = typeRow.thinkingMode;
  if (thinking === 'off' || thinking === false) {
    turnModel.thinking = { mode: 'off' };
  } else if (thinking === 'on' || thinking === true || thinking === 'low' || thinking === 'medium' || thinking === 'high') {
    turnModel.thinking = {
      mode: 'on',
      ...(typeof typeRow.thinkingBudgetTokens === 'number'
        ? { budgetTokens: typeRow.thinkingBudgetTokens }
        : {}),
    };
  }
  return turnModel;
}

/**
 * Create the production effector for one parent chat.
 *
 * @param {{
 *   parentChatId?: string,
 *   getState?: () => import('./types').AgentsState | Promise<import('./types').AgentsState>,
 *   model?: { providerId: string, id: string },
 *   limits?: { maxTurns?: number, wallClockMs?: number },
 *   promptVariant?: 'full' | 'lite',
 *   runTurn?: typeof defaultRunTurn,
 *   deps?: import('../runner/adapters').RunnerDeps,
 *   postChatCompletions?: import('../runner/adapters').PostChatCompletions,
 *   loadConfig?: typeof loadSubAgentFile,
 *   getTypeRow?: typeof getSubAgentTypeRow,
 *   reapOrphans?: boolean,
 *   ask?: import('../runner/run-turn').AskCapability | null,
 * }} [options]
 */
export function createSubAgentEffector(options = {}) {
  const parentChatId = options.parentChatId;
  const runTurnFn = options.runTurn ?? defaultRunTurn;
  const promptVariant = options.promptVariant === 'lite' ? 'lite' : 'full';
  const ask = options.ask === undefined ? null : options.ask;
  const loadConfig = options.loadConfig ?? loadSubAgentFile;
  const getTypeRow = options.getTypeRow ?? getSubAgentTypeRow;
  const deps = options.deps ?? createServerRunnerDeps(
    options.postChatCompletions ?? postChatCompletionsInProcess,
  );

  if (options.reapOrphans) cancelOrphanedSubAgentGenerations();

  /**
   * @typedef {object} LiveAttempt
   * @property {string} runId
   * @property {string} role
   * @property {string} attemptId
   * @property {AbortController} controller
   * @property {boolean} stopped
   * @property {string} cwd
   */

  /** @type {Map<string, LiveAttempt>} */
  const running = new Map();
  /** @type {Array<(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void>} */
  const listeners = [];
  /** @type {Array<{ taskId: string, role: string, attemptId: string, seedKind?: string, cwd: string }>} */
  const startLog = [];
  /** Tool ids resolved once per type — not per turn. */
  /** @type {Map<string, string[]>} */
  const toolIdsByType = new Map();
  /**
   * Last transcript for a run, so a continue seed is a resume rather than a
   * cold start. Keyed by runId because each attempt has a fresh chatId.
   *
   * @type {Map<string, unknown[]>}
   */
  const transcriptByRun = new Map();

  /**
   * @returns {Promise<import('./types').AgentsState>}
   */
  async function currentState() {
    if (typeof options.getState === 'function') return options.getState();
    if (parentChatId) {
      const engine = peekEngine(parentChatId, AGENTS_NAMESPACE);
      if (engine) return /** @type {import('./types').AgentsState} */ (engine.getState());
    }
    throw new Error('createSubAgentEffector: parentChatId or getState is required');
  }

  /**
   * Keep the attempt in `inspect()` until every onEnd handler has settled.
   * Dropping it first is the contract violation `engine.js` warns about.
   *
   * @param {LiveAttempt} entry
   * @param {import('../orchestrator/engine.js').AttemptEnd} end
   */
  async function deliverEnd(entry, end) {
    if (entry.stopped) return;
    try {
      for (const listener of listeners) await listener(end);
    } finally {
      running.delete(entry.attemptId);
      liveAttemptIds.delete(entry.attemptId);
    }
  }

  return {
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string }>} */
    inspect() {
      return [...running.values()].map(({ runId, role, attemptId, cwd }) => ({
        taskId: runId,
        role,
        attemptId,
        cwd,
      }));
    },

    /**
     * @returns {Promise<void>}
     */
    async preflight() {
      const file = await loadConfig();
      if (file.enabled === false) {
        throw new Error('sub-agents are disabled in sub-agents.json');
      }
      if (options.model) {
        await resolveLibraryAttemptBinding(options.model);
        return;
      }
      await resolveLibraryAttemptBinding(await resolveAttemptModel(null));
    },

    /**
     * @param {{ taskId: string | null, role: string, seedKind?: string }} desired
     * @returns {Promise<{ attemptId: string }>}
     */
    async start(desired) {
      if (desired.role !== SUB_AGENT_ROLE) {
        throw new Error(`sub-agent effector: unsupported role ${String(desired.role)}`);
      }
      const runId = desired.taskId;
      if (!runId) {
        throw new Error('sub-agent effector: desired.taskId (runId) is required');
      }

      const state = await currentState();
      const run = state.runs.get(runId);
      if (!run) {
        throw new Error(`sub-agent effector: unknown run ${runId}`);
      }
      const cwd = typeof run.cwd === 'string' ? run.cwd.trim() : '';
      if (!cwd) {
        throw new Error(
          `sub-agent effector: cwd is required on run ${runId} (journaled on run.requested)`,
        );
      }

      const typeRow = await getTypeRow(run.type);
      if (!typeRow) {
        throw new Error(`sub-agent effector: unknown or disabled type ${run.type}`);
      }

      const file = await loadConfig();
      const timeoutMs =
        typeof typeRow.timeoutMs === 'number' && typeRow.timeoutMs > 0
          ? typeRow.timeoutMs
          : typeof file.defaultTimeoutMs === 'number' && file.defaultTimeoutMs > 0
            ? file.defaultTimeoutMs
            : undefined;
      const limits = attemptLimits({
        ...options.limits,
        ...(options.limits?.wallClockMs == null && timeoutMs != null
          ? { wallClockMs: timeoutMs }
          : {}),
      });

      let toolIds = toolIdsByType.get(run.type);
      if (!toolIds) {
        toolIds = resolveSubAgentToolIds(typeRow);
        toolIdsByType.set(run.type, toolIds);
      }
      const tools = toolDefsFor(toolIds);

      const schemaId =
        typeof typeRow.summarySchema === 'string' && typeRow.summarySchema.trim()
          ? typeRow.summarySchema.trim()
          : typeof file.defaultSummarySchema === 'string'
            ? file.defaultSummarySchema
            : 'minnow.sub-agent.v1';

      const prompt = await loadSubAgentSystemPrompt(
        run.type,
        typeRow,
        run.task,
        promptVariant,
      );

      const bound =
        options.model ??
        run.model ??
        (typeof typeRow.providerId === 'string' &&
        typeRow.providerId.trim() &&
        typeof typeRow.modelId === 'string' &&
        typeRow.modelId.trim()
          ? { providerId: typeRow.providerId.trim(), id: typeRow.modelId.trim() }
          : await resolveAttemptModel(null));
      const globalSampler = await readGlobalSamplerForTurn();
      const model = bindTypeModel(
        await resolveLibraryAttemptBinding(bound),
        typeRow,
        globalSampler,
      );

      const agentConfig = agentContextBudgetFromSubAgentType(
        {
          contextEnforcementPolicy:
            typeof typeRow.contextEnforcementPolicy === 'string'
              ? typeRow.contextEnforcementPolicy
              : typeof file.defaultContextEnforcementPolicy === 'string'
                ? file.defaultContextEnforcementPolicy
                : undefined,
          minRecentTurns: typeof typeRow.minRecentTurns === 'number' ? typeRow.minRecentTurns : undefined,
          summaryReserveTokens:
            typeof typeRow.summaryReserveTokens === 'number' ? typeRow.summaryReserveTokens : undefined,
        },
      );
      const modelContextLimit =
        typeof typeRow.maxInputTokens === 'number' ? typeRow.maxInputTokens : null;

      const attemptId = `${ATTEMPT_PREFIX}${randomUUID()}`;
      const runtimeOwner = {
        chatId: run.parentChatId ?? parentChatId ?? `subagent:${runId}`,
        runId,
        agentId: attemptId,
      };
      const browserRuntime = await registerAgentBrowserRuntime(runtimeOwner, { kind: 'subagent' });
      const dispatch = createInProcessToolDispatch({
        cwd,
        allowedToolNames: toolIds,
        runtimeOwner,
      });
      const controller = new AbortController();
      const entry = {
        runId,
        role: SUB_AGENT_ROLE,
        attemptId,
        controller,
        stopped: false,
        cwd,
        browserRuntime,
      };

      running.set(attemptId, entry);
      liveAttemptIds.add(attemptId);
      startLog.push({
        taskId: runId,
        role: SUB_AGENT_ROLE,
        attemptId,
        seedKind: desired.seedKind,
        cwd,
      });

      const seedKind = desired.seedKind === 'continue' ? 'continue' : 'initial';
      const seed =
        seedKind === 'continue'
          ? 'Continue. The previous attempt ended without a verdict. Resume from the transcript.'
          : run.task;

      void (async () => {
        /** @type {unknown[] | undefined} */
        let prior = seedKind === 'continue' ? transcriptByRun.get(runId) : undefined;
        if (seedKind === 'continue' && (!Array.isArray(prior) || prior.length === 0) && parentChatId) {
          prior = await loadContinuePriorFromDisk(parentChatId, run);
        }
        /** @type {import('../runner/run-turn').TurnResult} */
        let result;
        try {
          result = await runTurnFn({
            chatId: attemptId,
            seed,
            tools,
            model,
            cwd,
            signal: controller.signal,
            limits: {
              ...limits,
              modelContextLimit,
            },
            deps: {
              ...deps,
              runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
              applyContextPolicy: async (input) => {
                const messages = Array.isArray(input?.messages) ? input.messages : [];
                const resolved = resolveContextBudget({
                  agentConfig: input?.agentConfig ?? agentConfig,
                  modelLimit: input?.modelLimit ?? modelContextLimit,
                  reservedTokens: input?.reservedTokens,
                });
                const out = applyContextBudget(
                  messages,
                  resolved,
                  input?.agentConfig ?? agentConfig,
                );
                return {
                  applied: out.applied,
                  messages: out.messages,
                  statusMessage: out.statusMessage,
                  tokensAfter: out.tokensAfter,
                };
              },
            },
            execute: dispatch.execute,
            reportToolName: DEFAULT_REPORT_TOOL_NAME,
            parseReport: parseReportForSchema(schemaId),
            systemPrompt: prompt,
            summarySchema: schemaId,
            ask,
            onRoundBoundary: () => {
              const guides = browserRuntime.drainGuides();
              return guides.length
                ? guides.map((guide) => ({
                    role: 'user',
                    content: formatAgentBrowserGuideForTranscript(guide),
                  }))
                : null;
            },
            ...(prior ? { messages: prior, seedKind: 'continue' } : seedKind === 'continue' ? { seedKind: 'continue' } : {}),
            onEvent: (event) => {
              if (!parentChatId) return;
              recordTranscriptEvent({
                entryDir: agentsDir(parentChatId),
                attemptId,
                taskId: runId,
                role: SUB_AGENT_ROLE,
                event: /** @type {Record<string, unknown>} */ (
                  /** @type {unknown} */ (event)
                ),
              });
              if (event?.type === 'delta' && typeof event.text === 'string') {
                noteLiveDelta({ parentChatId, runId, attemptId }, event.text);
                return;
              }
              if (!shouldEmitSubAgentLiveTurnEvent(event?.type)) return;
              if (event?.type === 'tool_call' || event?.type === 'round_end') {
                flushLiveDelta(attemptId);
              }
              emitLive({
                key: parentChatId,
                boardId: parentChatId,
                attemptId,
                taskId: runId,
                role: SUB_AGENT_ROLE,
                event,
              });
            },
          });
        } catch (err) {
          result = { outcome: 'crashed', error: errorMessage(err) };
        }

        browserRuntime.close();
        const rec = deps.transcriptStore?.load?.(attemptId);
        if (Array.isArray(rec?.messages) && rec.messages.length > 0) {
          transcriptByRun.set(runId, rec.messages);
        }

        const incomingOutcome = result?.outcome;
        result = degradeNoReportIfProse(result, rec?.messages, schemaId);
        clearLiveDelta(attemptId);
        if (parentChatId) {
          if (
            incomingOutcome === 'no_report' &&
            result.outcome === 'pass' &&
            typeof result.summary === 'string' &&
            result.summary.trim()
          ) {
            recordTranscriptEvent({
              entryDir: agentsDir(parentChatId),
              attemptId,
              taskId: runId,
              role: SUB_AGENT_ROLE,
              event: { type: 'round_end', text: result.summary },
            });
          }
          recordTranscriptEnd({
            entryDir: agentsDir(parentChatId),
            attemptId,
            outcome: result.outcome,
            ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
          });
        }

        if (entry.stopped) return;
        await deliverEnd(entry, toAttemptEnd(attemptId, runId, result));
      })();

      return { attemptId };
    },

    /**
     * @param {string} attemptId
     * @returns {Promise<void>}
     */
    async stop(attemptId) {
      const entry = running.get(attemptId);
      if (!entry) return;
      entry.stopped = true;
      entry.controller.abort();
      entry.browserRuntime?.close();
      running.delete(attemptId);
      liveAttemptIds.delete(attemptId);
      clearLiveDelta(attemptId);
    },

    /**
     * @param {(end: import('../orchestrator/engine.js').AttemptEnd) => Promise<void> | void} handler
     * @returns {void}
     */
    onEnd(handler) {
      listeners.push(handler);
    },

    get started() {
      return startLog;
    },

    /**
     * Drop every attempt from `inspect()` without aborting and without
     * `onEnd` — the crash analogue. {@link cancelOrphanedSubAgentGenerations}
     * reaps the generations.
     *
     * @returns {void}
     */
    vanishAll() {
      for (const entry of running.values()) {
        entry.stopped = true;
        liveAttemptIds.delete(entry.attemptId);
        clearLiveDelta(entry.attemptId);
      }
      running.clear();
    },

    /**
     * Test seam: record a continue-seed transcript without going through
     * `runTurn`. Production never calls this.
     *
     * @param {string} runId
     * @param {unknown[]} messages
     */
    seedTranscript(runId, messages) {
      transcriptByRun.set(runId, messages);
    },
  };
}
