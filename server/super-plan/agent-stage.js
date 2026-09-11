/**
 * One Super Plan agent attempt (interview, draft, review or polish), run
 * in-process through `runTurn` with the real tool schemas, a stage prompt,
 * a per-stage write guard and a checkpointed transcript. I/O module.
 */

import {
  createInProcessToolDispatch,
  postChatCompletionsInProcess,
  runTurn as defaultRunTurn,
} from '../runner/node.js';
import { applyContextBudget, resolveContextBudget } from '../runner/context-budget.js';
import { headlessToolDefinitions } from '../tools/headless-tool-defs.js';
import { resolveAttemptModel } from '../orchestrator/model-binding.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { getProvider } from '../providers/store.js';
import { DEFAULT_AGENT_MAX_TOKENS, readGlobalSamplerForTurn } from '../agents/sampler.js';
import { readResource } from '../config/store.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import {
  artifactPaths,
  checkPlan,
  checkSpec,
  chooseSlug,
  moveArtifact,
  normalizeRelativePath,
  readArtifact,
  specPathFor,
} from './artifacts.js';
import { answerForDanglingAsk, createInterviewAsk } from './ask.js';
import { stepRecords } from './derive.js';
import { findImplementationCode } from './no-code-guard.js';
import { buildSeed, buildSystemPrompt, interviewAskTool, parseReportFor, reportToolFor, REPORT_TOOL_NAME } from './prompts.js';
import { createStepTranscriptStore, danglingToolCalls } from './transcripts.js';
import { createLiveForwarder } from './live-events.js';

/** Tools every agent stage may call. Read and search only. */
const READ_TOOLS = Object.freeze([
  'list_directory',
  'read_file',
  'read_file_range',
  'find_files',
  'get_file_metadata',
  'search_in_file',
  'grep',
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
  'git_status',
  'git_log',
  'git_diff',
  'brain_search',
  'brain_read_page',
  'web_search_ddg',
  'fetch_web_content',
]);

/** @type {Record<string, readonly string[]>} */
export const STAGE_TOOL_IDS = Object.freeze({
  interview: [...READ_TOOLS, 'save_file', 'make_directory'],
  draft: [...READ_TOOLS, 'save_file', 'make_directory'],
  review: READ_TOOLS,
  polish: [...READ_TOOLS, 'save_file'],
});

/** Model rounds per attempt. A runaway loop ends as a timeout and retries. */
const MAX_ROUNDS = Object.freeze({ interview: 80, draft: 60, review: 50, polish: 40 });

/** The interview waits on the user, so its wall clock is long; the others are bounded work. */
const WALL_CLOCK_MS = Object.freeze({ interview: 24 * 60 * 60 * 1000, draft: 2 * 60 * 60 * 1000, polish: 60 * 60 * 1000 });

/** Questions wait for the user as long as the run exists. */
const ASK_TIMEOUT_MS = 20 * 24 * 60 * 60 * 1000;

const INTERRUPTED_TOOL_REPLY =
  'Error: this tool call was interrupted before it finished (the stage was paused or Minnow restarted). Call it again if you still need the result.';

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? 'unknown error');
}

/**
 * Server `RunnerDeps` for in-process completions, with a real context policy
 * so a long exploration compacts instead of overflowing.
 * @param {import('../runner/adapters').PostChatCompletions} postChatCompletions
 * @param {import('../runner/transcript-store').TranscriptStore} transcriptStore
 * @returns {import('../runner/adapters').RunnerDeps}
 */
function createDeps(postChatCompletions, transcriptStore) {
  const agentConfig = { enforcementPolicy: 'summarize' };
  return {
    transcriptStore,
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
    applyContextPolicy: async (input) => {
      const messages = Array.isArray(input?.messages) ? input.messages : [];
      const resolved = resolveContextBudget({
        agentConfig: input?.agentConfig ?? agentConfig,
        modelLimit: input?.modelLimit ?? null,
        reservedTokens: input?.reservedTokens,
      });
      const out = applyContextBudget(messages, resolved, input?.agentConfig ?? agentConfig);
      return { applied: out.applied, messages: out.messages, statusMessage: out.statusMessage, tokensAfter: out.tokensAfter };
    },
  };
}

/**
 * The model binding for a stage: the stage override, the planner, then the
 * Autopilot / active-chat default. Library ids (`gguf:…`) are mapped to a
 * running serve, starting it if needed.
 * @param {import('./types').RunState} state
 * @param {import('./types').StageId} role
 * @returns {Promise<{ providerId: string, id: string, sampler?: object, thinking?: { mode: 'on' | 'off' } }>}
 */
export async function resolveStageModel(state, role) {
  const config = state.config;
  const binding = (role === 'review' ? config.reviewerModel : null) ?? config.plannerModel ?? null;
  // resolveAttemptModel completes a missing provider and falls back to the
  // Autopilot planner, then the active chat, when the run bound nothing.
  const pair = await resolveAttemptModel(binding?.modelId ? { providerId: binding.providerId, id: binding.modelId } : null);
  const resolved = await resolveLibraryAttemptBinding(pair);
  const sampler = await readGlobalSamplerForTurn();
  let thinking = binding?.thinking ?? config.thinking ?? null;
  if (!thinking) {
    try {
      const meta = /** @type {Record<string, any>} */ (await readResource('meta'));
      const mode = meta?.thinking?.defaultMode;
      if (mode === 'on' || mode === 'off') thinking = mode;
    } catch {
      /* keep the model default */
    }
  }
  return { ...resolved, sampler, ...(thinking ? { thinking: { mode: thinking } } : {}) };
}

/**
 * `save_file` / `make_directory` may only touch the stage's own artifact, and
 * a saved plan or spec is checked on the spot so the model can fix it before
 * it reports.
 * @param {{
 *   role: import('./types').StageId,
 *   artifactPath: string,
 *   execute: (name: string, args: unknown, ctx?: { toolCallId?: string }) => Promise<{ content: string }>,
 * }} options
 */
export function guardStageTools({ role, artifactPath, execute }) {
  const expected = normalizeRelativePath(artifactPath);
  const directory = expected.slice(0, expected.lastIndexOf('/'));
  return async (name, args, ctx) => {
    const rec = args && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : {};
    if (name === 'make_directory') {
      const target = normalizeRelativePath(rec.path);
      if (target && (directory === target || directory.startsWith(`${target}/`))) return execute(name, args, ctx);
      return { content: `Error: this stage only writes \`${artifactPath}\`; create its folder or nothing.` };
    }
    if (name !== 'save_file') return execute(name, args, ctx);
    if (role === 'review') return { content: 'Error: the review stage is read-only. Report findings with report_outcome instead.' };
    if (normalizeRelativePath(rec.path) !== expected) {
      return { content: `Error: this stage saves exactly \`${artifactPath}\` (got "${String(rec.path ?? '')}"). Save it to that path.` };
    }
    const content = typeof rec.content === 'string' ? rec.content : '';
    const code = findImplementationCode(content);
    if (code) return { content: `Error: not saved. ${code}` };
    const out = await execute(name, { ...rec, path: artifactPath }, ctx);
    if (String(out.content ?? '').startsWith('Error')) return out;
    const check = role === 'interview' ? checkSpec(content, artifactPath) : checkPlan(content, artifactPath);
    if (!check.ok) {
      return { ...out, content: `${out.content}\n\nSaved, but it will not pass the stage's checks yet:\n${check.errors.map((e) => `- ${e}`).join('\n')}\nFix these and save again before you report.` };
    }
    return out;
  };
}

/**
 * Answer tool calls a stopped attempt left without results, so the resumed
 * transcript is valid. A dangling question is answered from the journal,
 * waiting for the user if it is still open.
 * @param {Record<string, unknown>[]} prior
 * @param {{ engine: any, transcriptKey: string, store: { append: Function }, attemptId: string, signal: AbortSignal, onWait: () => void }} ctx
 * @returns {Promise<void>}
 */
async function repairDanglingCalls(prior, ctx) {
  for (const call of danglingToolCalls(prior)) {
    let content = INTERRUPTED_TOOL_REPLY;
    if (call.name === 'ask_question') {
      ctx.onWait();
      content = (await answerForDanglingAsk(ctx.engine, ctx.transcriptKey, call.arguments, ctx.signal)) ?? content;
    } else if (call.name === REPORT_TOOL_NAME) {
      content = 'The outcome was not recorded because the stage was interrupted. Call report_outcome again when you are done.';
    }
    const message = { role: 'tool', tool_call_id: call.id, content };
    ctx.store.append(ctx.attemptId, message);
    prior.push(message);
  }
}

/**
 * Last assistant prose in a transcript: the summary when a model finished its
 * work but forgot to report.
 * @param {unknown[]} messages
 * @returns {string}
 */
function lastProse(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = /** @type {Record<string, any>} */ (messages[i]);
    if (row?.role !== 'assistant') continue;
    if (Array.isArray(row.tool_calls) && row.tool_calls.length) continue;
    if (typeof row.content === 'string' && row.content.trim()) return row.content.trim();
  }
  return '';
}

/**
 * A reviewer that wrote its report as JSON prose instead of calling the tool.
 * @param {string} prose
 * @param {ReturnType<typeof parseReportFor>} parse
 * @returns {boolean}
 */
function salvageReport(prose, parse) {
  const match = /\{[\s\S]*\}/.exec(prose);
  if (!match) return false;
  try {
    return parse(JSON.parse(match[0])).ok === true;
  } catch {
    return false;
  }
}

/**
 * Run one attempt of an agent stage.
 *
 * @param {{
 *   engine: any,
 *   runId: string,
 *   attemptId: string,
 *   role: import('./types').StageId,
 *   seedKind: import('./types').SeedKind,
 *   transcriptKey: string,
 *   signal: AbortSignal,
 *   runTurn?: typeof defaultRunTurn,
 *   postChatCompletions?: import('../runner/adapters').PostChatCompletions,
 *   resolveModel?: typeof resolveStageModel,
 *   now?: () => Date,
 * }} input
 * @returns {Promise<{ outcome: 'ok' | 'crashed' | 'timeout' | 'rejected', summary: string, evidence?: Record<string, unknown>, usage?: Record<string, number> }>}
 */
export async function runAgentStage(input) {
  const { engine, runId, attemptId, role, transcriptKey, signal } = input;
  const state = engine.getState();
  const cwd = state.workspacePath;
  if (!cwd) return { outcome: 'crashed', summary: 'This plan has no workspace folder. Start a new plan from a workspace.' };
  try {
    await validateAllowedWorkspaceRoot(cwd);
  } catch {
    return { outcome: 'crashed', summary: `The workspace folder ${cwd} is not open in Minnow. Open it in Code, then retry.` };
  }

  const live = createLiveForwarder({ runId, stage: role, attemptId });
  const paths = artifactPaths(state);
  const researchUsable = Boolean(state.artifacts.research && !state.artifacts.research.empty);
  const stepSeed = state.step?.kind === 'stage' ? state.step.seedKind : 'initial';
  const budgetBase = state.config.interview ? state.config.questionBudget : 0;
  const questionBudget = role !== 'interview' ? 0 : stepSeed === 'revise' ? Math.min(3, budgetBase) : budgetBase;
  const artifactPath = role === 'interview' ? paths.specPath : paths.planPath;
  const ctx = {
    cwd,
    date: (input.now?.() ?? new Date()).toISOString().slice(0, 10),
    specPath: paths.specPath,
    researchPath: paths.researchPath,
    planPath: paths.planPath,
    researchUsable,
    questionBudget,
  };

  let model;
  try {
    live.emit({ type: 'loading_model' });
    model = await (input.resolveModel ?? resolveStageModel)(state, role);
  } catch (err) {
    return { outcome: 'crashed', summary: `Could not start the model: ${errorMessage(err)}` };
  }
  if (signal.aborted) return { outcome: 'crashed', summary: 'Stopped.' };

  const store = createStepTranscriptStore(runId, transcriptKey);
  const prior = store.load().messages;
  const resuming = prior.length > 0 && (input.seedKind === 'continue' || input.seedKind === 'errors');
  const seedKind = prior.length === 0 && (input.seedKind === 'continue' || input.seedKind === 'errors') ? stepSeed : input.seedKind;
  if (resuming) {
    try {
      await repairDanglingCalls(prior, {
        engine,
        transcriptKey,
        store,
        attemptId,
        signal,
        onWait: () => live.emit({ type: 'phase', phase: 'waiting' }),
      });
    } catch (err) {
      return { outcome: 'crashed', summary: signal.aborted ? 'Stopped.' : errorMessage(err) };
    }
  }

  const records = stepRecords(state);
  const lastRejected = [...records].reverse().find((r) => r.outcome === 'rejected');
  const seed = buildSeed(role, seedKind, state, { ...ctx, errors: lastRejected?.errors ?? [] });
  const systemPrompt = buildSystemPrompt(role, state, ctx);

  const toolIds = [...(STAGE_TOOL_IDS[role] ?? READ_TOOLS)];
  const tools = [
    ...headlessToolDefinitions(toolIds),
    ...(questionBudget > 0 ? [interviewAskTool()] : []),
    reportToolFor(role),
  ];
  const dispatch = createInProcessToolDispatch({ cwd, modeId: 'super-plan', allowedToolNames: toolIds });
  const execute = guardStageTools({ role, artifactPath, execute: dispatch.execute });
  const ask = questionBudget > 0
    ? createInterviewAsk({ engine, runId, attemptId, transcriptKey, budget: questionBudget })
    : null;

  /** @type {Record<string, any> | null} */
  let report = null;
  const parseReport = parseReportFor(role, (value) => {
    report = value;
  });
  const deps = {
    ...createDeps(input.postChatCompletions ?? postChatCompletionsInProcess, store),
    runHeadlessToolBatch: dispatch.runHeadlessToolBatch,
  };
  const limits = {
    maxTurns: MAX_ROUNDS[role] ?? 50,
    wallClockMs: role === 'review' ? state.config.reviewTimeoutMs : WALL_CLOCK_MS[role] ?? 2 * 60 * 60 * 1000,
  };

  /** @type {import('../runner/run-turn').TurnResult} */
  let result;
  try {
    result = await (input.runTurn ?? defaultRunTurn)({
      chatId: attemptId,
      seed,
      tools,
      lazyTools: false,
      model,
      cwd,
      signal,
      limits,
      deps,
      transcript: store,
      execute,
      reportToolName: REPORT_TOOL_NAME,
      parseReport,
      systemPrompt,
      finalizeStructuredOutcome: false,
      ask,
      askTimeoutMs: ASK_TIMEOUT_MS,
      ...(resuming ? { messages: prior, seedKind: 'continue' } : {}),
      onEvent: (event) => live.emit(event),
    });
  } catch (err) {
    result = { outcome: 'crashed', error: errorMessage(err) };
  } finally {
    live.flush();
  }

  const usage = result.usage && typeof result.usage === 'object' ? result.usage : undefined;
  const withUsage = (end) => (usage ? { ...end, usage } : end);

  if (result.outcome === 'timeout') {
    return withUsage({ outcome: 'timeout', summary: 'The stage ran out of time or model rounds; it continues from its transcript.' });
  }
  if (result.outcome === 'crashed') {
    return withUsage({ outcome: 'crashed', summary: signal.aborted ? 'Stopped.' : result.error || 'The model call failed.' });
  }

  const transcript = store.load().messages;
  if (result.outcome === 'no_report' && !report) {
    const prose = lastProse(transcript);
    if (role === 'review') {
      if (!salvageReport(prose, parseReport)) {
        return withUsage({
          outcome: 'rejected',
          summary: 'The review ended without recording findings.',
          evidence: { errors: ['The review ended without calling report_outcome, so no findings were recorded.'] },
        });
      }
    } else {
      report = { summary: prose.slice(0, 4000) || 'Saved.' };
    }
  }
  const summary = String(/** @type {any} */ (report)?.summary ?? '');

  if (role === 'review') {
    const findings = /** @type {any} */ (report)?.findings ?? [];
    const round = state.reviews.filter((r) => r.cycle === state.reviewCycle).length + 1;
    return withUsage({
      outcome: 'ok',
      summary,
      evidence: { review: { round, summary, findings } },
    });
  }

  if (role === 'interview') {
    const markdown = await readArtifact(cwd, artifactPath);
    const check = checkSpec(markdown, artifactPath);
    if (!check.ok) return withUsage({ outcome: 'rejected', summary: summary || 'The spec did not pass its checks.', evidence: { errors: check.errors } });
    /** @type {Record<string, unknown>} */
    const evidence = {};
    let finalPath = artifactPath;
    if (!state.slugFinal) {
      const slug = await chooseSlug(state, check.title);
      finalPath = specPathFor(slug);
      await moveArtifact(cwd, artifactPath, finalPath);
      evidence.slug = { slug, title: check.title };
    }
    evidence.artifact = {
      kind: 'spec',
      path: finalPath,
      sha256: check.sha256,
      title: check.title,
      bytes: check.bytes,
      involvesUi: check.involvesUi,
    };
    return withUsage({ outcome: 'ok', summary, evidence });
  }

  // draft and polish both produce the plan.
  const markdown = await readArtifact(cwd, artifactPath);
  const requireChange = role === 'draft' && (stepSeed === 'findings' || stepSeed === 'feedback');
  const check = checkPlan(markdown, artifactPath, {
    previousSha256: state.artifacts.plan?.sha256 ?? null,
    requireChange,
  });
  if (!check.ok) {
    return withUsage({ outcome: 'rejected', summary: summary || 'The plan did not pass its checks.', evidence: { errors: check.errors } });
  }
  return withUsage({
    outcome: 'ok',
    summary,
    evidence: {
      artifact: {
        kind: 'plan',
        path: artifactPath,
        sha256: check.sha256,
        title: check.title,
        bytes: check.bytes,
        involvesUi: check.involvesUi,
        executable: true,
        tasks: check.tasks,
      },
      ...(role === 'draft' && /** @type {any} */ (report)?.addressed ? { addressed: /** @type {any} */ (report).addressed } : {}),
    },
  });
}
