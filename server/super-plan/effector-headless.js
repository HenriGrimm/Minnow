import { runResearchStage } from './research.js';
import { createStageTranscriptStore } from './transcripts.js';
import { artifactPaths, checkStageArtifact } from './artifacts.js';
import { createJournaledAsk } from './ask-bridge.js';
/**
 * Headless effector for the Super Plan run engine (W3-A).
 *
 * Implements the `Effector` contract (`{inspect, start, stop, onEnd?}`) for the
 * three headless stages: `research`, `review`, `polish`. Modeled on
 * `server/sub-agents/effector-runner.js`: every attempt runs `runTurn`
 * in-process with no renderer, and an attempt stays visible to `inspect()`
 * until every `onEnd` handler has settled.
 *
 * Like the sub-agent effector, this module is I/O — it imports the runner and
 * the engine registry — so it is excluded from the graph purity guard the same
 * way `journal.js` is.
 */

import { randomUUID } from 'node:crypto';

import {
  createInProcessToolDispatch,
  createMemoryTranscriptStore,
  headlessToolIdsForRole,
  postChatCompletionsInProcess,
  runTurn as defaultRunTurn,
} from '../runner/node.js';
import { DEFAULT_REPORT_TOOL_NAME } from '../runner/run-turn.js';
import {
  resolveSummarySchemaPreset,
  validateStructuredOutcomeForPreset,
} from '../runner/sub-agent-summary-schemas.js';
import { attemptLimits } from '../orchestrator/attempt-limits.js';
import { resolveAttemptModel } from '../orchestrator/model-binding.js';
import { peekEngine } from '../orchestrator/engine.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { getProvider } from '../providers/store.js';
import {
  DEFAULT_AGENT_MAX_TOKENS,
  readGlobalSamplerForTurn,
} from '../agents/sampler.js';
import { SUPERPLAN_NAMESPACE } from './journal.js';
import { emitLive } from './live-events.js';

/** The three pipeline stages that run headless in this wave. */
export const HEADLESS_ROLES = /** @type {const} */ (['research', 'review', 'polish']);

/** Default structured-outcome schema id for a headless stage. */
const DEFAULT_SCHEMA_ID = 'minnow.sub-agent.v1';

/**
 * Per-stage structured-outcome schema. Review must carry findings, so it uses
 * the `requireFindings: true` Super Plan review preset; draft and polish keep
 * the standard summary + artifacts shape. This is the per-stage
 * `report_outcome` contract — a review stage cannot complete without findings.
 */
export const STAGE_SUMMARY_SCHEMAS = Object.freeze({
  research: DEFAULT_SCHEMA_ID,
  review: 'minnow.super-plan.review.v1',
  polish: DEFAULT_SCHEMA_ID,
});

/**
 * Resolve the structured-outcome schema id for one headless stage.
 *
 * @param {string} role
 * @returns {string}
 */
export function schemaIdForStage(role) {
  return STAGE_SUMMARY_SCHEMAS[role] ?? DEFAULT_SCHEMA_ID;
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
 * Server-side `RunnerDeps` for in-process completions. The attempt's
 * `TurnModel` already carries sampler from Settings
 * (`readGlobalSamplerForTurn`); the stub max is only a last-ditch fallback.
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
      const row = await getProvider(providerId);
      return {
        id: row.id,
        label: row.label,
        baseUrl: row.baseUrl,
        apiKind: row.apiKind,
        chatCompletionsPath: row.chatCompletionsPath,
      };
    },
    getSubAgentTypeConfig: async () => ({}),
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
 * `summarySchema` → `parseReport`. Accepts the structured-outcome payload
 * (`minnow.sub-agent.v1`) *or* the PRD `report_outcome` union, so a stage that
 * returns findings (review) and one that returns a plain summary (research /
 * polish) can both finish.
 *
 * @param {string} schemaId
 * @returns {import('../runner/run-turn').ParseReport}
 */
export function parseReportForStage(schemaId, onStructured = () => {}) {
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
        error:
          'Error: report requires a JSON object. Retry with an object, not an array or primitive.',
      };
    }
    const rec = /** @type {Record<string, unknown>} */ (obj);
    const structured = validateStructuredOutcomeForPreset(rec, { ...preset, requireFindings: false });
    if (structured) {
      onStructured(structured);
      return {
        ok: true,
        result: {
          outcome: 'pass',
          summary: structured.summary,
          evidence: structured.artifacts.map((a) => a.ref),
        },
      };
    }
    // A preset with `requireFindings` (the review stage) does not fall back to
    // the PRD `report_outcome` union: the stage cannot complete without
    // structured findings, even when it reports `outcome: "pass"`.
    if (preset.requireFindings) {
      return {
        ok: false,
        error:
          'Error: this stage requires structured findings — report a summary, a findings array (empty when no issues remain), and artifacts. Retry with a finding for each issue.',
      };
    }
    const outcome = rec.outcome;
    if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'blocked') {
      return {
        ok: false,
        error:
          'Error: report requires a structured outcome (summary, findings, artifacts) or outcome "pass" | "fail" | "blocked". Retry.',
      };
    }
    if (typeof rec.summary !== 'string') {
      return {
        ok: false,
        error: 'Error: report requires "summary" as a string. Retry and include summary.',
      };
    }
    if (outcome === 'pass') {
      const evidence = Array.isArray(rec.evidence)
        ? rec.evidence.filter((x) => typeof x === 'string')
        : [];
      return { ok: true, result: { outcome: 'pass', summary: rec.summary, evidence } };
    }
    if (outcome === 'fail') {
      const blockers = Array.isArray(rec.blockers)
        ? rec.blockers.filter((x) => typeof x === 'string')
        : [];
      return { ok: true, result: { outcome: 'fail', summary: rec.summary, blockers } };
    }
    const needs = Array.isArray(rec.needs)
      ? rec.needs.filter((x) => typeof x === 'string')
      : [];
    return { ok: true, result: { outcome: 'blocked', summary: rec.summary, needs } };
  };
}

/**
 * Map a `TurnResult` object onto the engine's `AttemptEnd`.
 *
 * @param {string} attemptId
 * @param {string} runId
 * @param {string} role
 * @param {import('../runner/run-turn').TurnResult} result
 * @returns {import('../orchestrator/engine.js').AttemptEnd}
 */
function toAttemptEnd(attemptId, runId, role, result) {
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
    role,
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
 * The errors a rejected draft retry must carry: the parse/accept errors from
 * the most recent draft stage record, or the errors from the last rejected
 * accept gate. Empty when neither is present.
 *
 * @param {import('./types').RunState} state
 * @returns {string[]}
 */
function draftRetryErrors(state) {
  const records = Array.isArray(state?.stageRecords) ? state.stageRecords : [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.stage === 'draft' && Array.isArray(record.errors) && record.errors.length > 0) {
      return record.errors.map(String);
    }
  }
  const history = Array.isArray(state?.gateHistory) ? state.gateHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.kind === 'accept' && entry.verdict === 'reject' && Array.isArray(entry.errors)) {
      return entry.errors.map(String);
    }
  }
  return [];
}

/**
 * One-stage seed from the derived run state. The engine's `plan()` decides
 * *which* stage runs; the effector only turns that stage into a prompt. Roles
 * without a dedicated prompt file in this wave get a minimal stage brief that
 * names the artifacts the stage is responsible for.
 *
 * @param {string} role
 * @param {import('./types').RunState} state
 * @param {string} [seedKind]
 * @returns {string}
 */
export function buildStageSeed(role, state, seedKind) {
  state = { ...state, ...artifactPaths(state) };
  const prompt = typeof state?.prompt === 'string' ? state.prompt.trim() : '';
  const parts = [];
  if (seedKind === 'continue') {
    parts.push('Continue. The previous attempt ended without a verdict.');
  }
  if (role === 'draft' && seedKind === 'errors') {
    parts.push('The previous draft was rejected. Fix these problems and write the plan again:');
    parts.push(...draftRetryErrors(state));
  }
  if (role === 'research') {
    parts.push(`Deep Research stage for: ${prompt}`);
    if (typeof state?.specPath === 'string' && state.specPath.trim()) {
      parts.push(`Read the build spec at ${state.specPath} first.`);
    }
    if (typeof state?.researchPath === 'string' && state.researchPath.trim()) {
      parts.push(`Write the research artifact to ${state.researchPath}.`);
    }
  } else if (role === 'review') {
    parts.push(`Plan Review stage for: ${prompt}`);
    if (typeof state?.planPath === 'string' && state.planPath.trim()) {
      parts.push(`Review the plan at ${state.planPath}.`);
    }
    parts.push('Read the spec and plan, check referenced code paths, dependencies, acceptance criteria and verification. Re-check each prior finding; retain its title and paths if unresolved. Do not modify files.');
    parts.push(JSON.stringify({ specPath: state.specPath, priorReviews: state.reviews, claimedFixes: state.draftAddressed }));
    parts.push('Report summary, findings (title, detail, severity: blocker|warn|info, paths), and artifacts. Use an empty findings array when no issues remain.');
  } else if (role === 'polish') {
    parts.push(`Polish stage for: ${prompt}`);
    if (typeof state?.planPath === 'string' && state.planPath.trim()) {
      parts.push(`Read and refine the plan at ${state.planPath}, then save it to the same path. Improve UI hierarchy, accessibility, responsive behavior and error states. Preserve scope, task dependencies, acceptance criteria and verification. Do not implement the product or edit other files.`);
    }
  } else {
    parts.push(`${role} stage for: ${prompt}`);
  }
  return parts.join('\n');
}

/**
 * Default system prompt for a headless stage. Later waves can inject richer
 * role prompts via `options.systemPrompt`.
 *
 * @param {string} role
 * @returns {string}
 */
function defaultStagePrompt(role) {
  return [
    `Super Plan — ${role} stage.`,
    'Work in the workspace with the available tools. When the stage is done, call the report tool with the outcome. Do not put the outcome only in assistant text.',
  ].join('\n');
}

/**
 * Create the headless effector for one Super Plan run.
 *
 * @param {{
 *   runId?: string,
 *   getState?: () => import('./types').RunState | Promise<import('./types').RunState>,
 *   model?: { providerId: string, id: string },
 *   limits?: { maxTurns?: number, wallClockMs?: number },
 *   runTurn?: typeof defaultRunTurn,
 *   deps?: import('../runner/adapters').RunnerDeps,
 *   postChatCompletions?: import('../runner/adapters').PostChatCompletions,
 *   schemaId?: string,
 *   systemPrompt?: string,
 *   ask?: import('../runner/run-turn').AskCapability | null,
 *   onEvent?: (event: import('../runner/run-turn').TurnEvent) => void,
 * }} [options]
 */
export function createHeadlessEffector(options = {}) {
  const runId = options.runId;
  const runTurnFn = options.runTurn ?? defaultRunTurn;
  const limits = attemptLimits(options.limits);
  const deps = options.deps ?? createServerRunnerDeps(
    options.postChatCompletions ?? postChatCompletionsInProcess,
  );

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
  /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string }>} */
  const startLog = [];
  /**
   * Last transcript for a run, so a continue seed is a resume rather than a
   * cold start. Keyed by runId because each attempt has a fresh chatId.
   *
   * @type {Map<string, unknown[]>}
   */
  const transcriptByRun = new Map();

  /**
   * @returns {Promise<import('./types').RunState>}
   */
  async function currentState() {
    if (typeof options.getState === 'function') return options.getState();
    if (runId) {
      const engine = peekEngine(runId, SUPERPLAN_NAMESPACE);
      if (engine) return /** @type {import('./types').RunState} */ (engine.getState());
    }
    throw new Error('createHeadlessEffector: runId or getState is required');
  }

  /**
   * Keep the attempt in `inspect()` until every onEnd handler has settled.
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
    }
  }

  return {
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string, cwd?: string }>} */
    inspect() {
      return [...running.values()].map(({ runId: taskId, role, attemptId, cwd }) => ({
        taskId,
        role,
        attemptId,
        cwd,
      }));
    },

    /**
     * @returns {Promise<void>}
     */
    async preflight() {
      const model = options.model ?? (await resolveAttemptModel(null));
      await resolveLibraryAttemptBinding(model);
    },

    /**
     * @param {{ taskId: string | null, role: string, seedKind?: string }} desired
     * @returns {Promise<{ attemptId: string }>}
     */
    async start(desired) {
      if (!HEADLESS_ROLES.includes(/** @type {any} */ (desired.role))) {
        throw new Error(`headless effector: unsupported role ${String(desired.role)}`);
      }
      const taskRunId = desired.taskId;
      if (!taskRunId) {
        throw new Error('headless effector: desired.taskId (runId) is required');
      }

      const state = await currentState();
      const cwd =
        typeof state?.workspacePath === 'string' && state.workspacePath.trim()
          ? state.workspacePath.trim()
          : '';
      if (!cwd) {
        throw new Error(
          `headless effector: workspacePath is required on run ${taskRunId} (journaled on run.created)`,
        );
      }

      const isResearch = desired.role === 'research' && !options.runTurn;
      const override = state.config?.[desired.role === 'review' ? 'reviewerModel' : 'plannerModel'];
      const binding = override?.modelId ? override : state.config?.plannerModel;
      const model = isResearch ? {} : await resolveLibraryAttemptBinding(
        options.model ?? (binding?.modelId ? { providerId: binding.providerId, id: binding.modelId } : await resolveAttemptModel(null)),
      );
      const globalSampler = await readGlobalSamplerForTurn();
      const turnModel = { ...model, sampler: globalSampler };

      const readTools = new Set(['read_file', 'list_directory', 'find_files', 'search_in_file', 'grep', 'repo_map', 'find_symbol', 'who_calls', 'read_symbol', 'explain_symbol', 'git_status', 'git_diff', 'git_log', 'brain_search', 'brain_read_page', 'brain_list', 'web_search_ddg', 'web_search_tavily', 'web_search_searxng', 'fetch_web_content', 'rag_web_content', 'minnow_docs_search', 'minnow_docs_read', 'minnow_docs_list']);
      if (desired.role !== 'review') { readTools.add('save_file'); readTools.add('make_directory'); }
      const toolIds = [...headlessToolIdsForRole(desired.role)].filter((name) => readTools.has(name));
      const tools = toolIds.map((name) => ({
        type: 'function',
        function: {
          name,
          description: name,
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file or directory path.' }, ...(name === 'save_file' ? { content: { type: 'string', description: 'Complete UTF-8 file content.' } } : {}), ...(name.includes('search') || name === 'grep' ? { query: { type: 'string' }, pattern: { type: 'string' } } : {}) }, additionalProperties: true },
        },
      }));
      const dispatch = createInProcessToolDispatch({
        cwd,
        modeId: 'super-plan',
        allowedToolNames: toolIds,
      });

      const schemaId =
        typeof options.schemaId === 'string' && options.schemaId.trim()
          ? options.schemaId.trim()
          : schemaIdForStage(desired.role);

      let structuredOutcome = null;
      const seed = buildStageSeed(desired.role, state, desired.seedKind ?? 'initial');
      const systemPrompt =
        typeof options.systemPrompt === 'string' && options.systemPrompt.trim()
          ? options.systemPrompt
          : defaultStagePrompt(desired.role);

      const attemptId = `sp-${randomUUID()}`;
      const controller = new AbortController();
      const entry = {
        runId: taskRunId,
        role: desired.role,
        attemptId,
        controller,
        stopped: false,
        cwd,
      };

      running.set(attemptId, entry);
      startLog.push({
        taskId: taskRunId,
        role: desired.role,
        attemptId,
        seedKind: desired.seedKind,
      });

      const seedKind = desired.seedKind === 'continue' ? 'continue' : 'initial';
      const transcriptStore = options.deps?.transcriptStore ?? createStageTranscriptStore(taskRunId, desired.role);
      const prior = seedKind === 'continue' ? transcriptStore.load(attemptId)?.messages ?? transcriptByRun.get(taskRunId) : undefined;
      if (seedKind !== 'continue') transcriptStore.reset?.();

      void (async () => {
        /** @type {import('../runner/run-turn').TurnResult} */
        let result;
        try {
          result = desired.role === 'research' && !options.runTurn ? await runResearchStage({ state, engine: peekEngine(taskRunId, 'superplan'), signal: controller.signal }) : await runTurnFn({
            chatId: attemptId,
            seed,
            tools,
            model: turnModel,
            cwd,
            signal: controller.signal,
            limits: { ...limits, ...(desired.role === 'review' && state.config.reviewTimeoutMs ? { wallClockMs: state.config.reviewTimeoutMs } : {}) },
            deps: {
              ...deps,
              transcriptStore,
              runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
            },
            execute: dispatch.execute,
            reportToolName: DEFAULT_REPORT_TOOL_NAME,
            parseReport: parseReportForStage(schemaId, (value) => { structuredOutcome = value; }),
            systemPrompt,
            summarySchema: schemaId,
            ask: options.ask ?? (peekEngine(taskRunId, 'superplan') ? { ask: createJournaledAsk({ engine: peekEngine(taskRunId, 'superplan'), runId: taskRunId, attemptId }) } : null),
            ...(Array.isArray(prior) && prior.length > 0
              ? { messages: prior, seedKind: 'continue' }
              : seedKind === 'continue'
                ? { seedKind: 'continue' }
                : {}),
            onEvent: (event) => {
              // Live channel for research progress and activity. This is the
              // parallel SSE bus in `live-events.js`, deliberately not the
              // journal — replay must stay a pure fold of durable events.
              emitLive({ runId: taskRunId, stage: desired.role, event });
              if (typeof options.onEvent === 'function') options.onEvent(event);
            },
          });
        } catch (err) {
          result = { outcome: 'crashed', error: errorMessage(err) };
        }

        const rec = transcriptStore.load(attemptId);
        if (Array.isArray(rec?.messages) && rec.messages.length > 0) {
          transcriptByRun.set(taskRunId, rec.messages);
        }

        if (entry.stopped) return;
        const end = toAttemptEnd(attemptId, taskRunId, desired.role, result);
        if (result.outcome === 'pass') {
          if (desired.role === 'review') {
            if (!structuredOutcome) { end.outcome = 'rejected'; end.summary = 'Review did not report structured findings.'; }
            else end.evidence = { ...end.evidence, findings: structuredOutcome.findings };
          } else {
            const checked = await checkStageArtifact(state, desired.role);
            end.evidence = { ...end.evidence, ...checked };
            if (checked.errors) end.outcome = 'rejected';
          }
        }
        await deliverEnd(entry, end);
      })().catch(async (error) => {
        if (!entry.stopped) await deliverEnd(entry, { attemptId, taskId: taskRunId, role: desired.role, outcome: 'crashed', summary: errorMessage(error) });
      });

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
      running.delete(attemptId);
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
     * `onEnd` — the crash analogue. The engine's next tick reaps the open
     * attempts as crashed and replans.
     *
     * @returns {void}
     */
    vanishAll() {
      for (const entry of running.values()) {
        entry.stopped = true;
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