/** Runner effector: start real builder and tester attempts. */

import { randomUUID } from 'node:crypto';
import { readConfigJson } from '../config/store.js';

import {
  createInProcessToolDispatch,
  createMemoryTranscriptStore,
  dispatchToolIdsForRole,
  headlessToolIdsForRole,
  postChatCompletionsInProcess,
  runTurn as defaultRunTurn,
} from '../runner/node.js';
import { cancel as cancelGeneration, listGenerationStates } from '../generations/store.js';
import {
  formatAgentBrowserGuideForTranscript,
  registerAgentBrowserRuntime,
} from '../browser-agent-api.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { getProvider } from '../providers/store.js';
import { peekEngine } from './engine.js';
import * as diskJournal from './journal.js';
import { attemptLimits } from './attempt-limits.js';
import { emitLive } from './live-events.js';
import { resolveAttemptModel } from './model-binding.js';
import { recordTranscriptEnd, recordTranscriptEvent } from './transcripts.js';
import { shouldEmitSubAgentLiveTurnEvent } from '../runner/turn-event.js';
import { interpolatePrompt, loadRolePrompt } from './prompts.js';
import {
  extractJsonTextFromAssistantBody,
  tryParseStructuredOutcomeFromAssistantProse,
} from '../runner/sub-agent-structured-outcome.js';
import { parseReportFor, reportToolFor, REPORT_TOOL_NAME } from './report-tool.js';
import { buildSeed } from './seeds.js';
import { runMerge } from './merge-queue.js';
import { finalAttemptEnd, formatRunInstructions, runFinalLadder } from './final-test.js';
import {
  allocateAttemptWorktree,
  commitAttemptWorktree,
  ensureBoardWorkspaceGit,
  INTEGRATION_SLOT,
  previousWorktreeForTask,
  releaseWorktree,
  shouldKeepWorktree,
  slotIdFromWorktreePath,
} from './worktree-lifecycle.js';
import { getWorktreeSlotPath } from '../worktree/paths.js';
import {
  DEFAULT_AGENT_MAX_TOKENS,
  readGlobalSamplerForTurn,
} from '../agents/sampler.js';
import { getEffectiveWorkspaceRoot, runWithToolContext } from '../runtime/path-access.js';

// ── Orphans ──────────────────────────────────────────────────────────────────

/**
 * Attempt ids currently visible to some runner effector's `inspect()`.
 * @type {Set<string>}
 */
const liveAttemptIds = new Set();

/**
 * Cancel persist:false generations that no live attempt still owns.
 * @returns {number} how many generations were cancelled
 */
export function cancelOrphanedRunnerGenerations() {
  let n = 0;
  for (const state of listGenerationStates()) {
    if (state.status !== 'pending' && state.status !== 'streaming') continue;
    if (state.persist !== false) continue;
    const owner = typeof state.chatId === 'string' ? state.chatId : '';
    if (owner && liveAttemptIds.has(owner)) continue;
    if (!owner && liveAttemptIds.size > 0) continue;
    cancelGeneration(state);
    n += 1;
  }
  return n;
}

// ── Runner deps ──────────────────────────────────────────────────────────────

/**
 * Server-side `RunnerDeps` for in-process completions. Thinking / context
 * policy are no-ops: the attempt's `TurnModel` already carries sampler from
 * Settings (`readGlobalSamplerForTurn`). The stub max is the shipped Settings
 * default, not 2048 — a missed `model.sampler` must not cap every provider.
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
    getSubAgentTypeConfig: async () => ({}),
    // Last-ditch only: production `start()` attaches `model.sampler` from
    // Settings. 2048 here reintroduced finish_reason: length on every board.
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
      messages: input.messages,
    }),
  };
}

// ── Tool defs ────────────────────────────────────────────────────────────────

import { headlessToolDefinitions } from '../tools/headless-tool-defs.js';

/**
 * Resolve full schemas from the shared catalog, preserving agent browser overrides.
 * @param {string} role
 * @returns {import('../runner/run-turn').TurnToolDefinition[]}
 */
function headlessToolDefs(role) {
  return headlessToolDefinitions(headlessToolIdsForRole(role));
}

// ── Attempt map ──────────────────────────────────────────────────────────────

/**
 * Map a `TurnResult` object onto the engine's `AttemptEnd`.
 * @param {string} attemptId
 * @param {import('./core/types').Desired} desired
 * @param {import('../runner/run-turn').TurnResult} result
 * @returns {import('./engine.js').AttemptEnd}
 */
function toAttemptEnd(attemptId, desired, result) {
  /** @type {Record<string, unknown>} */
  const evidence = {};
  if (result.outcome === 'pass' && Array.isArray(result.evidence)) {
    evidence.evidence = result.evidence;
  }
  if (result.outcome === 'fail' && Array.isArray(result.blockers)) {
    evidence.blockers = result.blockers;
    if (desired.role === 'tester' && result.blockers[0]) {
      evidence.testOutput = result.blockers[0];
    }
  }
  if (result.outcome === 'blocked' && Array.isArray(result.needs)) {
    evidence.needs = result.needs;
  }
  if (result.outcome === 'crashed' && typeof result.error === 'string') {
    evidence.error = result.error;
  }

  /** @type {import('./engine.js').AttemptEnd} */
  const end = {
    attemptId,
    taskId: desired.taskId,
    role: desired.role,
    outcome: result.outcome,
  };
  if (result.outcome === 'pass' || result.outcome === 'fail' || result.outcome === 'blocked') {
    end.summary = result.summary;
  } else if (result.outcome === 'crashed') {
    end.summary = result.error;
  }
  if (Object.keys(evidence).length > 0) end.evidence = evidence;
  if (result.usage && typeof result.usage === 'object') {
    const usage = {};
    for (const [key, value] of Object.entries(result.usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
    }
    if (Object.keys(usage).length > 0) end.usage = usage;
  }
  return end;
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
 * Map a sub-agent findings dump onto a board TurnResult.
 * @param {{ summary: string, findings?: Array<{ title?: string, detail?: string, severity?: string, paths?: string[] }>, artifacts?: Array<{ ref?: string }> }} structured
 * @param {'builder' | 'tester' | 'final'} role
 * @returns {import('../runner/run-turn').TurnResult}
 */
function turnResultFromFindingsDump(structured, role) {
  const findings = Array.isArray(structured.findings) ? structured.findings : [];
  const artifacts = Array.isArray(structured.artifacts) ? structured.artifacts : [];
  const summary = structured.summary;
  const details = findings
    .map((finding) => {
      const title = typeof finding.title === 'string' ? finding.title : '';
      const detail = typeof finding.detail === 'string' ? finding.detail : '';
      return [title, detail].filter(Boolean).join(': ');
    })
    .filter(Boolean);
  const evidence = [
    ...findings.flatMap((finding) =>
      Array.isArray(finding.paths)
        ? finding.paths.filter((path) => typeof path === 'string')
        : [],
    ),
    ...artifacts
      .map((artifact) => (typeof artifact.ref === 'string' ? artifact.ref : ''))
      .filter(Boolean),
  ];
  const hasBlocker = findings.some((finding) => finding.severity === 'blocker');
  const hasWarn = findings.some((finding) => finding.severity === 'warn');
  const testerLike = role === 'tester' || role === 'final';
  if (hasBlocker) {
    if (testerLike) {
      return { outcome: 'fail', summary, blockers: details.length ? details : evidence };
    }
    return { outcome: 'blocked', summary, needs: details.length ? details : evidence };
  }
  if (hasWarn) {
    return { outcome: 'fail', summary, blockers: details.length ? details : evidence };
  }
  return { outcome: 'pass', summary, evidence };
}

/**
 * Boards require `report_outcome`.
 * @param {import('../runner/run-turn').TurnResult} result
 * @param {unknown} messages
 * @param {'builder' | 'tester' | 'final'} role
 * @returns {import('../runner/run-turn').TurnResult}
 */
export function recoverBoardReportIfDumped(result, messages, role) {
  if (!result || result.outcome !== 'no_report') return result;
  if (role !== 'builder' && role !== 'tester' && role !== 'final') return result;
  const prose = lastAssistantProse(messages);
  if (!prose) return result;
  const parsed = parseReportFor(role)(extractJsonTextFromAssistantBody(prose));
  if (parsed.ok) return { ...result, ...parsed.result };
  const structured = tryParseStructuredOutcomeFromAssistantProse(prose);
  if (!structured) return result;
  return { ...result, ...turnResultFromFindingsDump(structured, role) };
}

// ── Effector ─────────────────────────────────────────────────────────────────

/**
 * Create the production effector for one board.
 *
 * @param {{
 *   boardId?: string,
 *   journal?: typeof diskJournal,
 *   getState?: () => import('./core/types').BoardState | Promise<import('./core/types').BoardState>,
 *   model?: { providerId: string, id: string },
 *   cwd?: string,
 *   limits?: { maxTurns?: number, wallClockMs?: number },
 *   promptVariant?: 'full' | 'lite',
 *   runTurn?: typeof defaultRunTurn,
 *   runFinalLadder?: typeof runFinalLadder,
 *   deps?: import('../runner/adapters').RunnerDeps,
 *   postChatCompletions?: import('../runner/adapters').PostChatCompletions,
 *   reapOrphans?: boolean,
 *   worktrees?: boolean,
 * }} [options]
 */
export function createRunnerEffector(options = {}) {
  const boardId = options.boardId;
  const journal = options.journal ?? diskJournal;
  const runTurnFn = options.runTurn ?? defaultRunTurn;
  const limits = attemptLimits(options.limits);
  const promptVariant = options.promptVariant === 'lite' ? 'lite' : 'full';
  const isolateWorktrees = options.worktrees ?? !(typeof options.cwd === 'string' && options.cwd.trim());
  const explicitCwd = typeof options.cwd === 'string' && options.cwd.trim()
    ? options.cwd.trim()
    : '';
  const fallbackCwd = explicitCwd || getEffectiveWorkspaceRoot();
  const ladderFn = typeof options.runFinalLadder === 'function' ? options.runFinalLadder : runFinalLadder;
  const usingFakeTurn = typeof options.runTurn === 'function';
  const deps = options.deps ?? createServerRunnerDeps(
    options.postChatCompletions ?? postChatCompletionsInProcess,
  );

  if (options.reapOrphans) cancelOrphanedRunnerGenerations();

  /**
   * @typedef {object} LiveAttempt
   * @property {string | null} taskId
   * @property {string} role
   * @property {string} attemptId
   * @property {AbortController} controller
   * @property {boolean} stopped
   * @property {string} [worktree]
   * @property {string} [slotId]
   * @property {import('./core/types').Desired} [desired]
   */

  /** @type {Map<string, LiveAttempt>} */
  const running = new Map();
  /** @type {Array<(end: import('./engine.js').AttemptEnd) => Promise<void> | void>} */
  const listeners = [];
  /** @type {Array<{ taskId: string | null, role: string, attemptId: string, seedKind?: string, worktree?: string }>} */
  const startLog = [];

  /**
   * The workspace this board belongs to.
   *
   * Board work outlives the request that started it, so ALS scoping does not
   * reach it — it has to carry its own workspace. Boards journal one on
   * `board.created`; read that rather than whatever folder happened to be
   * global when the effector was constructed.
   * @returns {Promise<string>}
   */
  async function boardWorkspaceRoot() {
    if (explicitCwd) return explicitCwd;
    try {
      const state = await currentState();
      const stamped =
        typeof state?.workspacePath === 'string' ? state.workspacePath.trim() : '';
      if (stamped) return stamped;
    } catch {
      // No journal yet (a fresh board, or a getState-less test effector).
    }
    return fallbackCwd;
  }

  /**
   * @returns {Promise<import('./core/types').BoardState>}
   */
  async function currentState() {
    if (typeof options.getState === 'function') return options.getState();
    if (boardId) {
      const engine = peekEngine(boardId);
      if (engine) return engine.getState();
      return journal.loadState(boardId);
    }
    throw new Error('createRunnerEffector: boardId or getState is required to build a seed');
  }

  /**
 * Keep the attempt in `inspect()` until every onEnd handler has settled.
   * @param {LiveAttempt} entry
   * @param {import('./engine.js').AttemptEnd} end
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

  /** Contain failures outside runTurn so finalization cannot strand a live slot. */
  function backgroundFailure(entry, err) {
    console.warn(`[orchestrator] ${boardId}: attempt ${entry.attemptId} finalization failed:`, errorMessage(err));
    // The engine reaps an unjournaled end on its next tick and applies the
    // normal bounded crash retry policy. Leave its worktree available.
    running.delete(entry.attemptId);
    liveAttemptIds.delete(entry.attemptId);
  }

  /**
 * Merge-without-worktrees ( / explicit cwd) and Final under a fake `runTurn` / scripted path.
   * @param {import('./core/types').Desired} desired
   * @returns {Promise<{ attemptId: string }>}
   */
  async function startEngineDriven(desired) {
    const attemptId = `r-${randomUUID()}`;
    const entry = {
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      controller: new AbortController(),
      stopped: false,
    };
    running.set(attemptId, entry);
    liveAttemptIds.add(attemptId);
    startLog.push({
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      seedKind: desired.seedKind,
    });

    /** @type {import('./engine.js').AttemptEnd} */
    const end = {
      attemptId,
      taskId: desired.taskId,
      role: desired.role,
      outcome: 'pass',
    };
    if (desired.role === 'merge') end.sha = 'workspace-head';
    if (desired.role === 'final') end.runInstructions = '';

    void Promise.resolve().then(() => deliverEnd(entry, end)).catch((err) => backgroundFailure(entry, err));
    return { attemptId };
  }

  /**
   * Run the fixed ladder in the integration worktree.
   * @param {import('./core/types').Desired} desired
   * @returns {Promise<{ attemptId: string, worktree?: string }>}
   */
  async function startFinal(desired) {
    const attemptId = `r-${randomUUID()}`;
    const integrationCwd = boardId
      ? getWorktreeSlotPath(boardId, INTEGRATION_SLOT)
      : await boardWorkspaceRoot();
    const entry = {
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      controller: new AbortController(),
      stopped: false,
      worktree: integrationCwd,
    };
    running.set(attemptId, entry);
    liveAttemptIds.add(attemptId);
    startLog.push({
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      seedKind: desired.seedKind,
      worktree: integrationCwd,
    });

    void (async () => {
      /** @type {import('./engine.js').AttemptEnd} */
      let end;
      try {
        const state = await currentState();
        const result = await ladderFn({
          cwd: integrationCwd,
          planPath: state.planPath || null,
          signal: entry.controller.signal,
        });
        end = finalAttemptEnd(attemptId, result);
      } catch (err) {
        end = {
          attemptId,
          taskId: null,
          role: 'final',
          outcome: 'fail',
          summary: errorMessage(err),
          runInstructions: formatRunInstructions({
            command: '(ladder threw)',
            cwd: integrationCwd,
          }),
          evidence: {
            failedRung: null,
            output: errorMessage(err),
            cwd: integrationCwd,
          },
        };
      }
      if (entry.stopped) return;
      await deliverEnd(entry, end);
    })().catch((err) => backgroundFailure(entry, err));

    return { attemptId, worktree: integrationCwd };
  }

  /**
   * Rebase-then-merge in the task worktree.
   * @param {import('./core/types').Desired} desired
   * @returns {Promise<{ attemptId: string }>}
   */
  async function startMerge(desired) {
    const attemptId = `r-${randomUUID()}`;
    const entry = {
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      controller: new AbortController(),
      stopped: false,
    };
    running.set(attemptId, entry);
    liveAttemptIds.add(attemptId);
    startLog.push({
      taskId: desired.taskId,
      role: desired.role,
      attemptId,
      seedKind: desired.seedKind,
    });

    void (async () => {
      /** @type {import('./engine.js').AttemptEnd} */
      let end;
      /** @type {string | null} */
      let mergeWorktree = null;
      /** @type {string | null} */
      let mergeSlotId = null;
      try {
        const state = await currentState();
        mergeWorktree = desired.taskId ? previousWorktreeForTask(state, desired.taskId) : null;
        mergeSlotId =
          mergeWorktree && boardId ? slotIdFromWorktreePath(boardId, mergeWorktree) : null;
        end = await runMerge({
          boardId: /** @type {string} */ (boardId),
          taskId: desired.taskId,
          attemptId,
          state,
        });
      } catch (err) {
        end = {
          attemptId,
          taskId: desired.taskId,
          role: 'merge',
          outcome: 'conflicted',
          files: [],
          summary: errorMessage(err),
        };
      }
      if (boardId && mergeSlotId && end.outcome === 'pass') {
        const released = await releaseWorktree({
          boardId,
          slotId: mergeSlotId,
          taskId: desired.taskId,
          worktree: mergeWorktree || undefined,
        });
        if (released.discarded && !end.discarded) end.discarded = released.discarded;
      }
      if (entry.stopped) return;
      await deliverEnd(entry, end);
    })().catch((err) => backgroundFailure(entry, err));

    return { attemptId };
  }

  /**
 * Commit on pass (an uncommitted tree cannot merge) then release unless the next start will reuse this path.
   * @param {LiveAttempt} entry
   * @param {import('./core/types').Desired} desired
   * @param {import('../runner/run-turn').TurnResult} result
   */
  async function finishAgent(entry, desired, result) {
    if (entry.slotId && boardId && result.outcome === 'pass') {
      try {
        const committed = await commitAttemptWorktree({
          boardId,
          slotId: entry.slotId,
          message: `${desired.role} ${desired.taskId} pass`,
        });
        if (!committed.ok) throw new Error(committed.error || committed.output || 'git commit failed');
      } catch (err) {
        console.warn(
          `[orchestrator] ${boardId}: commitWorktree failed for ${entry.attemptId}:`,
          errorMessage(err),
        );
        result = { outcome: 'crashed', error: `Could not commit task changes: ${errorMessage(err)}` };
      }
    }

    /** @type {Record<string, unknown> | null} */
    let discarded = null;
    if (entry.slotId && boardId) {
      let keep = false;
      try {
        const state = await currentState();
        keep = shouldKeepWorktree(state, desired, result.outcome);
      } catch {
        keep = false;
      }
      if (!keep) {
        try {
          const released = await releaseWorktree({
            boardId,
            slotId: entry.slotId,
            taskId: desired.taskId,
            attemptId: entry.attemptId,
            worktree: entry.worktree,
          });
          discarded = released.discarded;
        } catch (err) {
          console.warn(`[orchestrator] ${boardId}: worktree cleanup failed:`, errorMessage(err));
        }
      }
    }

    const end = toAttemptEnd(entry.attemptId, desired, result);
    if (discarded) end.discarded = discarded;
    if (boardId) {
      recordTranscriptEnd({ boardId, attemptId: entry.attemptId, outcome: end.outcome,
        ...(end.summary ? { summary: end.summary } : {}) });
    }
    await deliverEnd(entry, end);
  }

  const effector = {
    /** @returns {Array<{ taskId: string | null, role: string, attemptId: string }>} */
    inspect() {
      return [...running.values()].map(({ taskId, role, attemptId, worktree }) => ({
        taskId,
        role,
        attemptId,
        ...(worktree ? { worktree } : {}),
      }));
    },

    /**
     * @returns {Promise<{ gitInitialized?: Record<string, unknown> } | void>}
     */
    async preflight() {
      const state = boardId || options.getState ? await currentState() : null;
      const model = await resolveAttemptModel(options.model ?? state?.model ?? null);
      await resolveLibraryAttemptBinding(model);
      await loadRolePrompt('builder', promptVariant);
      await loadRolePrompt('tester', promptVariant);
      if (!isolateWorktrees) return;
      const git = await ensureBoardWorkspaceGit();
      if (!git.ok) {
        throw new Error(git.error || 'Workspace is not a git repository');
      }
      if (git.event) return { gitInitialized: git.event };
    },

    /**
     * @param {import('./core/types').Desired} desired
     * @returns {Promise<{ attemptId: string, worktree?: string, discarded?: Record<string, unknown>[] }>}
     */
    async start(desired) {
      if (desired.role === 'final') {
        const hasLadderHook = typeof options.runFinalLadder === 'function';
        if (hasLadderHook || (isolateWorktrees && boardId && !usingFakeTurn)) {
          return startFinal(desired);
        }
        return startEngineDriven(desired);
      }
      if (desired.role === 'merge') {
        if (isolateWorktrees && boardId) return startMerge(desired);
        return startEngineDriven(desired);
      }
      if (desired.role !== 'builder' && desired.role !== 'tester') {
        throw new Error(`runner effector: unsupported role ${String(desired.role)}`);
      }
      if (!desired.taskId) {
        throw new Error(`runner effector: ${desired.role} requires a taskId`);
      }

      const state = await currentState();
      const seed = buildSeed(desired.seedKind ?? 'initial', {
        state,
        taskId: desired.taskId,
      });
      const model = await resolveLibraryAttemptBinding(
        await resolveAttemptModel(options.model ?? state.model),
      );
      const reasoning = options.model ? null : state.model?.reasoning ?? null;
      const thinkingOn =
        reasoning === 'on' ||
        reasoning === 'low' ||
        reasoning === 'medium' ||
        reasoning === 'high';
      // Board workers have no type-row sampler. Pass Settings → Sampler so
      // `runTurn` does not fall through to a 2048 stub (`finish_reason: length`).
      const globalSampler = await readGlobalSamplerForTurn();
      const turnModel = {
        ...model,
        sampler: globalSampler,
        ...(reasoning === 'off'
          ? { thinking: { mode: 'off' } }
          : thinkingOn
            ? { thinking: { mode: 'on' } }
            : {}),
      };

      const attemptId = `r-${randomUUID()}`;
      /** @type {string} */
      let attemptCwd = await boardWorkspaceRoot();
      /** @type {string | undefined} */
      let slotId;
      /** @type {Record<string, unknown>[]} */
      const discarded = [];
      /** @type {Record<string, unknown> | undefined} */
      let gitInitialized;

      if (isolateWorktrees) {
        if (!boardId) {
          throw new Error('runner effector: boardId is required to allocate a worktree');
        }
        const allocated = await allocateAttemptWorktree({
          boardId,
          taskId: desired.taskId,
          attemptId,
          desired,
          state,
        });
        if (!allocated.ok || !allocated.path || !allocated.slotId) {
          throw new Error(`runner effector: worktree allocate failed: ${allocated.error || 'unknown'}`);
        }
        attemptCwd = allocated.path;
        slotId = allocated.slotId;
        discarded.push(...allocated.discarded);
        if (allocated.gitInitialized) gitInitialized = allocated.gitInitialized;
      }

      const prompt = interpolatePrompt(
        await loadRolePrompt(desired.role, promptVariant),
        { cwd: attemptCwd },
      );
      const tools = [...headlessToolDefs(desired.role), reportToolFor(desired.role)];
      const lazyTools = (await readConfigJson('tools.json'))?.lazyTools !== false;
      const runtimeOwner = {
        chatId: boardId ?? `board:${attemptCwd}`,
        runId: desired.taskId,
        agentId: attemptId,
      };
      const browserRuntime = await registerAgentBrowserRuntime(runtimeOwner, { kind: 'board' });
      const dispatch = createInProcessToolDispatch({
        cwd: attemptCwd,
        allowedToolNames: dispatchToolIdsForRole(desired.role),
        runtimeOwner,
      });

      const controller = new AbortController();
      const entry = {
        taskId: desired.taskId,
        role: desired.role,
        attemptId,
        controller,
        stopped: false,
        worktree: isolateWorktrees ? attemptCwd : undefined,
        slotId,
        desired,
        browserRuntime,
      };

      running.set(attemptId, entry);
      liveAttemptIds.add(attemptId);
      startLog.push({
        taskId: desired.taskId,
        role: desired.role,
        attemptId,
        seedKind: desired.seedKind,
        worktree: entry.worktree,
      });

      void (async () => {
        /** @type {import('../runner/run-turn').TurnResult} */
        let result;
        try {
          result = await runTurnFn({
            chatId: attemptId,
            seed,
            tools,
            lazyTools,
            model: turnModel,
            cwd: attemptCwd,
            signal: controller.signal,
            limits,
            deps: {
              ...deps,
              runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
            },
            execute: dispatch.execute,
            reportToolName: REPORT_TOOL_NAME,
            parseReport: parseReportFor(desired.role),
            systemPrompt: prompt,
            finalizeStructuredOutcome: false,
            ask: null,
            onRoundBoundary: () => {
              const guides = browserRuntime.drainGuides();
              return guides.length
                ? guides.map((guide) => ({
                    role: 'user',
                    content: formatAgentBrowserGuideForTranscript(guide),
                  }))
                : null;
            },
            onEvent: (event) => {
              if (!boardId) return;
              // `phase` rides along even though it is filtered out of the
              // transcript: it is the only frame that says "the model went
              // back to writing", which is what keeps a card between a tool
              // result and the next thought from reading as stuck.
              if (shouldEmitSubAgentLiveTurnEvent(event?.type)) {
                emitLive({
                  boardId,
                  attemptId,
                  taskId: desired.taskId,
                  role: desired.role,
                  event,
                });
              }
              recordTranscriptEvent({
                boardId,
                attemptId,
                taskId: desired.taskId,
                role: desired.role,
                event: /** @type {Record<string, unknown>} */ (
                  /** @type {unknown} */ (event)
                ),
              });
            },
          });
        } catch (err) {
          result = { outcome: 'crashed', error: errorMessage(err) };
        }
        browserRuntime.close();
        if (entry.stopped) return;
        result = recoverBoardReportIfDumped(
          result,
          deps.transcriptStore?.load?.(attemptId)?.messages,
          desired.role,
        );
        await finishAgent(entry, desired, result);
      })().catch((err) => backgroundFailure(entry, err));

      return {
        attemptId,
        ...(entry.worktree ? { worktree: entry.worktree } : {}),
        ...(discarded.length > 0 ? { discarded } : {}),
        ...(gitInitialized ? { gitInitialized } : {}),
      };
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
    },

    /**
     * @param {(end: import('./engine.js').AttemptEnd) => Promise<void> | void} handler
     * @returns {void}
     */
    onEnd(handler) {
      listeners.push(handler);
    },


    get started() {
      return startLog;
    },

    /**
     * Drop every attempt from inspect without aborting and without onEnd.
     * @returns {void}
     */
    vanishAll() {
      for (const entry of running.values()) {
        entry.stopped = true;
        liveAttemptIds.delete(entry.attemptId);
      }
      running.clear();
    },
  };

  // Re-enter the path-access scope on the board's own workspace. Everything the
  // attempt starts inherits it — worktree paths, git, and the tool loop — including
  // the detached run that outlives `start()` returning.
  const rawPreflight = effector.preflight.bind(effector);
  const rawStart = effector.start.bind(effector);
  effector.preflight = async () =>
    runWithToolContext(rawPreflight, { workspaceRoot: await boardWorkspaceRoot() });
  effector.start = async (desired) =>
    runWithToolContext(() => rawStart(desired), {
      workspaceRoot: await boardWorkspaceRoot(),
    });

  return effector;
}
