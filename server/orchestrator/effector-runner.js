/** Runner effector: start real builder and tester attempts. */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { readConfigJson } from '../config/store.js';
import { listEnabledMcpTools } from '../mcp/registry.js';
import { getPluginToolDefinitions } from '../tools/loader.js';

import {
  createInProcessToolDispatch,
  createMemoryTranscriptStore,
  dispatchToolIdsForRole,
  headlessToolIdsForRole,
  postChatCompletionsInProcess,
  runTurn as defaultRunTurn,
} from '../runner/node.js';
import { cancel as cancelGeneration, listGenerationStates } from '../generations/store.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { resolveServerModelContextLimit } from '../models/context-window.js';
import { applyServerContextPolicy } from '../runner/context-budget.js';
import { getProvider, getProviderRuntime } from '../providers/store.js';
import { prerequisitesReady, prerequisiteError } from './prerequisites.js';
import { detectAgentCli } from '../models/agent-cli-detect.js';
import { deriveBrowserAssertions } from './browser-rung.js';
import { loadPlanMarkdown, resolveLadderRungs } from './final-test.js';
import { taskVerificationContract, validateVerificationChecks, prepareVerificationInputs } from './verification-contract.js';
import { peekEngine } from './engine.js';
import * as diskJournal from './journal.js';
import {
  attemptLimits,
  clampAttemptWallClockMs,
  TESTER_MAX_ROUNDS,
  TESTER_VERDICT_ROUNDS,
} from './attempt-limits.js';
import { loadGlobalContextBudget } from '../sub-agents/config.js';
import { emitLive } from './live-events.js';
import { resolveAttemptModel } from './model-binding.js';
import { recordTranscriptEnd, recordTranscriptEvent } from './transcripts.js';
import { loadResumeDigest } from './resume-digest.js';
import { shouldEmitSubAgentLiveTurnEvent } from '../runner/turn-event.js';
import { interpolatePrompt, loadRolePrompt } from './prompts.js';
import {
  extractJsonTextFromAssistantBody,
  tryParseStructuredOutcomeFromAssistantProse,
} from '../runner/sub-agent-structured-outcome.js';
import { parseReportFor, reportToolFor, REPORT_TOOL_NAME } from './report-tool.js';
import { createPauseGate } from '../runner/pause-gate.js';
import { checkpointAttempt } from './checkpoint.js';
import { allowanceContext, getAllowanceTracker } from '../generations/allowance.js';
import { buildSeed } from './seeds.js';
import { runMerge } from './merge-queue.js';
import { finalAttemptEnd, formatRunInstructions, runFinalLadder } from './final-test.js';
import {
  allocateAttemptWorktree,
  attemptBranch,
  commitAttemptWorktree,
  ensureBoardPlan,
  ensureBoardWorkspaceGit,
  INTEGRATION_SLOT,
  integrationBranch,
  previousWorktreeForTask,
  releaseWorktree,
  shouldKeepWorktree,
  slotIdFromWorktreePath,
  taskCommitTitle,
} from './worktree-lifecycle.js';
import { getWorktreeSlotPath } from '../worktree/paths.js';
import {
  DEFAULT_AGENT_MAX_TOKENS,
  readGlobalSamplerForTurn,
} from '../agents/sampler.js';
import { readGlobalThinkingModeForTurn } from '../agents/thinking.js';
import { isComposerReasoningLevel } from '../runner/reasoning-effort.js';
import { getEffectiveWorkspaceRoot, runWithToolContext } from '../runtime/path-access.js';
import { readIntegrationRef, checkWorktreeDirty } from '../worktree/worktree-ops.js';
import path from 'node:path';

const BOARD_CONTEXT7_TOOL_NAMES = [
  'mcp__context7__resolve_library_id',
  'mcp__context7__query_docs',
];

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
 * Server-side `RunnerDeps` for in-process completions. Thinking is a no-op:
 * the attempt's `TurnModel` already carries sampler from Settings
 * (`readGlobalSamplerForTurn`). The stub max is the shipped Settings default,
 * not 2048 — a missed `model.sampler` must not cap every provider. The window
 * comes from `limits.modelContextLimit` (resolved per attempt in `start`), and
 * the context policy is the real sync one so a long attempt trims instead of
 * overflowing.
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
    applyContextPolicy: async (input) => applyServerContextPolicy(input),
  };
}

// ── Tool defs ────────────────────────────────────────────────────────────────

import { headlessToolDefinitions } from '../tools/headless-tool-defs.js';

/**
 * Resolve full schemas from the shared catalog for the board role.
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
    if (Array.isArray(result.checks)) evidence.checks = result.checks;
  }
  if (result.outcome === 'fail' && Array.isArray(result.blockers)) {
    evidence.blockers = result.blockers;
    if (desired.role === 'tester' && result.blockers[0]) {
      evidence.testOutput = result.blockers[0];
    }
  }
  if (result.outcome === 'blocked' && Array.isArray(result.needs)) {
    evidence.needs = result.needs;
    if (Array.isArray(result.prerequisites)) evidence.prerequisites = result.prerequisites;
  }
  if (result.outcome === 'crashed' && typeof result.error === 'string') {
    evidence.error = result.error;
  }
  if (result.outcome === 'crashed' && result.providerUnreachable === true) {
    evidence.providerUnreachable = true;
  }
  if (result.outcome === 'crashed' && result.failure) evidence.failure = result.failure;
  if (result.outcome === 'crashed' && result.quotaExceeded) evidence.failure = { ...(evidence.failure ?? {}), kind: 'quota' };

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

/** @param {import('../runner/run-turn').TurnEvent} event */
function modelRoundSpeed(event) {
  if (event.type !== 'round_end') return null;
  const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const tps = count(event.stats?.tokens_per_second);
  const generationSeconds = count(event.stats?.generation_time);
  if (tps !== null && generationSeconds !== null && generationSeconds > 0) {
    return { tokens: tps * generationSeconds, seconds: generationSeconds };
  }
  const completion = count(event.usage?.completion_tokens);
  if (tps !== null && tps > 0 && completion !== null && completion > 0) {
    return { tokens: completion, seconds: completion / tps };
  }
  const details = event.usage?.completion_tokens_details;
  const reasoning = details && typeof details === 'object' ? count(details.reasoning_tokens) : null;
  if (reasoning !== null && reasoning > 0) return null;
  if (completion !== null && completion > 0 && event.tFirst !== null && event.tEnd > event.tFirst) {
    return { tokens: completion, seconds: (event.tEnd - event.tFirst) / 1000 };
  }
  return null;
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

/**
 * Board attempt wall clock from `config.json` → `autopilot.attemptWallClockMs`.
 * @returns {Promise<number>} milliseconds; `0` means no cap
 */
async function readBoardAttemptWallClockMs() {
  try {
    const cfg = (await readConfigJson('config.json')) ?? {};
    const autopilot = cfg.autopilot && typeof cfg.autopilot === 'object' ? cfg.autopilot : {};
    return clampAttemptWallClockMs(
      /** @type {Record<string, unknown>} */ (autopilot).attemptWallClockMs,
    );
  } catch {
    return clampAttemptWallClockMs(undefined);
  }
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
 *   resolveModelContextLimit?: typeof resolveServerModelContextLimit,
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
  const resolveContextLimit = options.resolveModelContextLimit ?? resolveServerModelContextLimit;

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
   * @property {Map<number, { tokens: number, seconds: number }>} [roundSpeeds]
   */

  /** @type {Map<string, LiveAttempt>} */
  const running = new Map();
  const pauseGate = createPauseGate();
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
    if (pauseGate.paused) await pauseGate.wait(entry.controller.signal).catch(() => {});
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
        const integrationSha = state.integrationSha;
        const checkGitIdentity = state.recoveryVersion && isolateWorktrees && boardId && /^[0-9a-f]{40,64}$/i.test(integrationSha || '');
        const beforeHead = checkGitIdentity ? await readIntegrationRef({ boardId, ref: 'HEAD' }) : null;
        const beforeClean = checkGitIdentity ? await checkWorktreeDirty({ boardId, slotId: INTEGRATION_SLOT }) : null;
        const result = await ladderFn({
          cwd: integrationCwd,
          planPath: state.planPath || null,
          signal: entry.controller.signal,
          browser: state.recoveryVersion > 0,
        });
        const browserRequired = [...state.tasks.values()].some(task => /\bbrowser\b|playwright|puppeteer|\be2e\b/i.test(`${task.testSpec} ${task.accept}`));
        if (state.recoveryVersion && result.evidence?.blockedRung === 'browser' && (result.evidence?.browser?.reason !== 'no-observable-criteria' || browserRequired)) {
          result.outcome = 'fail';
          result.evidence.failure = { category: 'verification', message: result.summary };
        }
        const afterClean = checkGitIdentity ? await checkWorktreeDirty({ boardId, slotId: INTEGRATION_SLOT }) : null;
        if (checkGitIdentity && (!beforeClean?.ok || beforeClean.dirty || !afterClean?.ok || afterClean.dirty || beforeHead !== integrationSha || await readIntegrationRef({ boardId, ref: 'HEAD' }) !== beforeHead)) {
          result.outcome = 'fail';
          result.summary = 'Integration contains uncommitted changes or changed during verification. Retained source must be reconciled before this commit can be certified.';
          result.evidence = { ...result.evidence, failure: { category: 'verification', message: result.summary } };
        }
        result.evidence = { ...(result.evidence ?? {}), integrationSha, relativeCwd: path.relative(integrationCwd, result.evidence?.cwd ?? integrationCwd) || '.' };
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
        const manualMerge = desired.taskId && state.tasks.get(desired.taskId)?.attempts.some(
          (a) => a.role === 'merge' && !a.ended && a.evidence?.mergeAndSkip === true,
        );
        if (manualMerge && boardId && mergeSlotId) {
          const committed = await commitAttemptWorktree({ boardId, slotId: mergeSlotId, message: taskCommitTitle(state, desired.taskId) });
          if (!committed.ok) throw new Error(committed.error || committed.output || 'Could not preserve task changes');
        }
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
      // Journal successful merge before releasing its recovery source. A crash
      // between Git success and end delivery must leave enough state to reconcile.
      if (boardId && mergeSlotId && end.outcome === 'pass' && !(await currentState()).recoveryVersion) {
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
    /** @type {import('./core/types').BoardState | null} */
    let state = null;
    if (entry.slotId && boardId && result.outcome === 'pass') {
      try {
        state = await currentState();
        const committed = await commitAttemptWorktree({
          boardId,
          slotId: entry.slotId,
          message: taskCommitTitle(state, desired.taskId),
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
        if (state === null) state = await currentState();
        keep = shouldKeepWorktree(state, desired, result.outcome, {
          interruption: result.outcome === 'crashed' && result.providerUnreachable === true,
        });
      } catch {
        // Failure to inspect policy/state is never permission to delete work.
        keep = true;
      }
      // Capture and journal the end before considering any destructive cleanup.
      // Unmerged task work remains the recovery source, including untracked files.
      if (result.outcome !== 'pass') keep = true;
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
    if (entry.slotId && boardId && state?.recoveryVersion && result.outcome === 'pass' && desired.role === 'tester') {
      end.evidence = { ...(end.evidence ?? {}), verifiedSha: await readIntegrationRef({ boardId, ref: attemptBranch(boardId, entry.slotId) }) };
    }
    if (entry.slotId && boardId && state?.recoveryVersion && result.outcome !== 'pass') {
      try {
        const previousAttemptId = [...(state.tasks.get(desired.taskId)?.attempts ?? [])].reverse().find((attempt) => attempt.evidence?.checkpoint)?.evidence.checkpoint.attemptId;
        const checkpoint = await checkpointAttempt({ boardId, attemptId: entry.attemptId, worktree: entry.worktree, previousAttemptId });
        end.evidence = { ...(end.evidence ?? {}), checkpoint: { attemptId: checkpoint.attemptId ?? entry.attemptId, tree: checkpoint.tree } };
      } catch (error) {
        end.evidence = { ...(end.evidence ?? {}), failure: { category: 'prerequisite', message: `Could not preserve recovery checkpoint: ${errorMessage(error)}` } };
        end.summary = `Work retained in ${entry.worktree}. Checkpoint failed: ${errorMessage(error)}`;
      }
    }
    if (entry.roundSpeeds?.size) {
      const speed = { tokens: 0, seconds: 0 };
      for (const round of entry.roundSpeeds.values()) {
        speed.tokens += round.tokens;
        speed.seconds += round.seconds;
      }
      if (speed.seconds > 0) end.speed = speed;
    }
    if (discarded) end.discarded = discarded;
    if (boardId) {
      recordTranscriptEnd({ boardId, attemptId: entry.attemptId, outcome: end.outcome,
        ...(end.summary ? { summary: end.summary } : {}) });
    }
    await deliverEnd(entry, end);
  }

  const effector = {
    async recoveryReady(hold) {
      const failure = hold.failure;
      if (failure?.prerequisites?.length) {
        const state = await currentState();
        const cwd = hold.taskId && previousWorktreeForTask(state, hold.taskId) || state.workspacePath || await boardWorkspaceRoot();
        return prerequisitesReady(failure.prerequisites, cwd);
      }
      if (failure?.identity && failure.providerId && failure.modelId) {
        const current = await allowanceContext(failure.providerId, failure.modelId);
        if (current.identity !== failure.identity) return true;
        if (['authentication', 'prerequisite'].includes(failure.category)) return prerequisitesReady([{ kind: 'agent_cli', providerId: failure.providerId, auth: failure.category === 'authentication' }], await boardWorkspaceRoot());
      }
      return false;
    },
    setPaused: (paused) => pauseGate.setPaused(paused),
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
      if (state?.recoveryVersion && state.workspacePath && !(await fs.stat(state.workspacePath)).isDirectory()) throw new Error('The recorded workspace is unavailable');
      const model = await resolveLibraryAttemptBinding(
        await resolveAttemptModel(options.model ?? state?.model ?? null, state?.workspacePath),
      );
      if (state?.recoveryVersion && !usingFakeTurn && model.providerId !== 'minnow-router') {
        const { profile, secrets } = await getProviderRuntime(model.providerId);
        if (profile.apiKind === 'agent-cli-v1') {
          const status = await detectAgentCli(profile.agentCli.kind, { binPath: profile.agentCli.binPath, cliToken: secrets.cliToken, fresh: true });
          if (!status.installed) throw prerequisiteError('Install or reconnect the configured agent CLI to continue.', [{ kind: 'agent_cli', providerId: model.providerId }]);
        }
      }
      await loadRolePrompt('builder', promptVariant);
      await loadRolePrompt('tester', promptVariant);
      if (!isolateWorktrees) return;
      if (!boardId || !state) {
        const git = await ensureBoardWorkspaceGit();
        if (!git.ok) throw new Error(git.error || 'Workspace is not a git repository');
        if (git.event) return { gitInitialized: git.event };
        return;
      }
      const prepared = await ensureBoardPlan(boardId, state.planPath);
      if (!prepared.ok) {
        throw new Error(prepared.error || prepared.output || 'Could not prepare the board worktree');
      }
      if (state.recoveryVersion && !usingFakeTurn) {
        const cwd = getWorktreeSlotPath(boardId, INTEGRATION_SLOT);
        const markdown = await loadPlanMarkdown(cwd, state.planPath);
        await prepareVerificationInputs({ workspace: state.workspacePath || await boardWorkspaceRoot(), cwd, markdown, boardId });
        let packageJson;
        try { packageJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')); } catch {}
        const rungs = resolveLadderRungs({ planMarkdown: markdown, packageJson });
        // Resolve the verifier and commands before allocating paid builders.
        if (deriveBrowserAssertions(markdown).assertions.length && !await prerequisitesReady([{ kind: 'browser' }], cwd)) throw prerequisiteError('Required browser verification is unavailable. Enable browser automation and install a supported Chromium browser.', [{ kind: 'browser' }], 'verification');
        for (const name of new Set(rungs.map((rung) => /^\s*(npm|npx|node|python3?|uv|cargo|go)\b/.exec(rung.command)?.[1]).filter(Boolean))) {
          if (!await prerequisitesReady([{ kind: 'executable', name }], cwd)) throw prerequisiteError(`Required verifier executable ${name} is unavailable.`, [{ kind: 'executable', name }], 'verification');
        }
      }
      if (prepared.gitInitialized) return { gitInitialized: prepared.gitInitialized };
    },

    /**
     * @param {import('./core/types').Desired} desired
     * @returns {Promise<{ attemptId: string, worktree?: string, discarded?: Record<string, unknown>[] }>}
     */
    async start(desired, startOptions = {}) {
      startOptions.signal?.throwIfAborted();
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
      const seedKind = desired.seedKind ?? 'initial';
      const resumeTask = seedKind === 'continue' && boardId ? state.tasks.get(desired.taskId) : undefined;
      let seed = buildSeed(seedKind, {
        state,
        taskId: desired.taskId,
        role: desired.role,
        ...(desired.role === 'tester' && isolateWorktrees && boardId
          ? { diffBase: integrationBranch(boardId) }
          : {}),
        ...(resumeTask ? { resume: await loadResumeDigest(boardId, resumeTask) } : {}),
      });
      const contract = state.recoveryVersion && desired.role === 'tester' ? taskVerificationContract(state.tasks.get(desired.taskId)) : [];
      const omittedFields = state.recoveryVersion ? new Set(state.recoveryHistory
        .filter(hold => hold.taskId === desired.taskId && hold.role === desired.role && hold.revision === state.recoveryRevision)
        .map(hold => hold.failure.omitField).filter(field => ['thinking', 'enable_thinking', 'reasoning_effort', 'reasoning', 'chat_template_kwargs'].includes(field))) : new Set();
      if (contract.length) seed += `\n\n## Required verification contract\n${JSON.stringify(contract)}\nReport checks:[{id,outcome:"pass",evidence:["command and observed output"]}] for every required ID. A blocked or unexecuted required check cannot pass. The server binds accepted evidence to the tested commit.`;
      const model = await resolveLibraryAttemptBinding(
        await resolveAttemptModel(options.model ?? state.model, state.workspacePath),
      );
      const reasoning = options.model ? null : state.model?.reasoning ?? null;
      const thinkingOn = reasoning === 'on' || isComposerReasoningLevel(reasoning);
      // Board workers have no type-row sampler. Pass Settings → Sampler so
      // `runTurn` does not fall through to a 2048 stub (`finish_reason: length`).
      const globalSampler = await readGlobalSamplerForTurn();
      const modelContextLimit = await resolveContextLimit(model);
      // No board reasoning picked → Settings → Thinking default, the same
      // fallback chat uses. Leaving it unset fell through to the runner deps'
      // hard `'off'`, so a board bound without a level never thought.
      const thinkingMode =
        reasoning === 'off' ? 'off' : thinkingOn ? 'on' : await readGlobalThinkingModeForTurn();
      const turnModel = {
        ...model,
        sampler: globalSampler,
        thinking: { mode: thinkingMode },
      };

      if (state.recoveryVersion && !usingFakeTurn && model.providerId !== 'minnow-router') {
        const context = await allowanceContext(model.providerId, model.id);
        const tracker = await getAllowanceTracker();
        const availability = tracker.availability(context);
        if (!availability.available) {
          const error = new Error(availability.reason);
          error.failure = { kind: availability.kind, scope: 'provider', retryAt: availability.retryAt, resetAt: availability.resetAt, identity: context.identity, providerId: context.providerId, modelId: context.modelId };
          throw error;
        }
      }

      const attemptId = `r-${randomUUID()}`;
      if (reasoning) deps.transcriptStore?.setMeta(attemptId, { reasoningEffort: reasoning });
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
      const builtinTools = [...headlessToolDefs(desired.role), reportToolFor(desired.role)];
      const tools = [...builtinTools, ...await listEnabledMcpTools(), ...await getPluginToolDefinitions({ requireFull: true })];
      const lazyTools = (await readConfigJson('tools.json'))?.lazyTools !== false;
      // Settings → Autopilot attempt wall clock, read per attempt so a change
      // applies to the next attempt without a restart. An explicit caller
      // limit (tests) wins. `0` means no cap.
      const wallClockMs = limits.wallClockMs ?? await readBoardAttemptWallClockMs();
      startOptions.signal?.throwIfAborted();
      const runtimeOwner = {
        chatId: boardId ?? `board:${attemptCwd}`,
        runId: desired.taskId,
        agentId: attemptId,
      };
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
        roundSpeeds: new Map(),
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
          recordTranscriptEvent({
            boardId, attemptId, taskId: desired.taskId, role: desired.role,
            event: { type: 'model_selected', providerId: turnModel.providerId, modelId: turnModel.id,
              ...(turnModel.providerId !== 'minnow-router' ? { reasoning: reasoning || (thinkingMode === 'off' ? 'off' : 'on') } : {}),
            },
          });
          result = await runTurnFn({
            chatId: attemptId,
            seed,
            tools,
            lazyTools,
            alwaysLoadedToolNames: BOARD_CONTEXT7_TOOL_NAMES,
            model: turnModel,
            cwd: attemptCwd,
            signal: controller.signal,
            pauseGate,
            limits: {
              ...limits,
              ...(wallClockMs > 0 ? { wallClockMs } : {}),
              modelContextLimit,
              contextBudget: Math.max(2048, (await loadGlobalContextBudget()) * 2 ** -Math.min(3, state.tasks.get(desired.taskId)?.attempts.filter((attempt) => attempt.evidence?.failure?.category === 'context').length ?? 0)),
              progressGuard: desired.role === 'builder',
              batchGuard: true,
              ...(desired.role === 'tester'
                ? { verdictRounds: TESTER_VERDICT_ROUNDS, maxTurns: limits.maxTurns ?? TESTER_MAX_ROUNDS }
                : {}),
            },
            deps: {
              ...deps,
              ...(omittedFields.size ? { postChatCompletions: (provider, body, signal, options) => {
                const adapted = { ...body };
                for (const field of omittedFields) delete adapted[field];
                return deps.postChatCompletions(provider, adapted, signal, options);
              } } : {}),
              runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
              // The library's selected effort survives remapping to an opaque
              // runtime alias, which may have no cached capability row yet.
              resolveSendCapabilities: (providerId, modelId, apiKind) => {
                const caps = deps.resolveSendCapabilities(providerId, modelId, apiKind);
                return isComposerReasoningLevel(reasoning) && !caps?.reasoningAllowedOptions?.length
                  ? { ...caps, reasoning: true, reasoningAllowedOptions: ['off', reasoning] }
                  : caps;
              },
            },
            execute: dispatch.execute,
            reportToolName: REPORT_TOOL_NAME,
            parseReport: (raw) => {
              const parsed = parseReportFor(desired.role)(raw);
              if (parsed.ok && parsed.result.outcome === 'pass' && contract.length) {
                const error = validateVerificationChecks(parsed.result.checks, contract);
                if (error) return { ok: false, error: `Error: ${error}` };
              }
              return parsed;
            },
            systemPrompt: prompt,
            refreshRoundConfig: async () => ({ systemPrompt: prompt, tools: [...builtinTools, ...await listEnabledMcpTools(), ...await getPluginToolDefinitions({ requireFull: true })] }),
            finalizeStructuredOutcome: false,
            ask: null,
            onEvent: (event) => {
              if (!boardId) return;
              if (event?.type === 'round_end') {
                const speed = modelRoundSpeed(event);
                if (speed) entry.roundSpeeds.set(event.index, speed);
              }
              // `phase` rides along even though it is filtered out of the
              // transcript: it is the only frame that says "the model went
              // back to writing", which is what keeps a card between a tool
              // result and the next thought from reading as stuck.
              // A round is silent until the model's first token, and prompt
              // processing on a long context can take tens of seconds. Without
              // a frame here the card keeps naming the tool that already
              // finished, which reads as the tool hanging.
              const liveEvent = event?.type === 'round_start'
                ? /** @type {import('../runner/run-turn').TurnEvent} */ ({ type: 'phase', phase: 'thinking' })
                : event;
              if (shouldEmitSubAgentLiveTurnEvent(liveEvent?.type)) {
                emitLive({
                  boardId,
                  attemptId,
                  taskId: desired.taskId,
                  role: desired.role,
                  event: liveEvent,
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
        if (pauseGate.paused) await pauseGate.wait(controller.signal).catch(() => {});
        if (entry.stopped) return;
        result = recoverBoardReportIfDumped(
          result,
          deps.transcriptStore?.load?.(attemptId)?.messages,
          desired.role,
        );
        if (result.outcome === 'pass' && contract.length) {
          const error = validateVerificationChecks(result.checks, contract);
          if (error) result = { outcome: 'crashed', error: `Verification reporting interrupted: ${error}`, failure: { category: 'interrupted' } };
        }
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
  effector.start = async (desired, startOptions) =>
    runWithToolContext(() => rawStart(desired, startOptions), {
      workspaceRoot: await boardWorkspaceRoot(),
    });

  return effector;
}
