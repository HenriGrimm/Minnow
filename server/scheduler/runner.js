/**
 * Headless subprocess execution for scheduled jobs (Automations).
 *
 * Every run streams runner events (`--stream-json`) into live-runs.js so the
 * Automations hub can paint it with the chat renderer while it works, then
 * persists the transcript beside run history when it ends.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { decryptSecretPayload, encryptSecretPayload } from '../security/secret-box.js';
import { getSessionToken } from '../runtime/session-token.js';
import {
  getStoredJobById,
  mutateStoredJob,
  recoverInterruptedJobs,
} from './store.js';
import { computeNextRun } from './schedule.js';
import {
  enqueueSchedulerNotification,
  summarizeRunForNotification,
} from './delivery.js';
import { schedulerRunHistoryPath } from './paths.js';
import { resolveJobWorkspacePath } from './workspace.js';
import { getSchedulerServerBaseUrl } from './server-base-url.js';
import { resolveJobRunModel } from './resolve-job-model.js';
import { applyNodeRuntimeEnv } from '../lsp/node-runtime.js';
import { renameSchedulerFile } from './atomic-file.js';
import { resolveHeadlessRunEntry } from './headless-entry.js';
import {
  applyLiveEvent,
  beginLiveRun,
  finishLiveRun,
  getLiveRun,
  persistRunTranscript,
  pruneRunTranscripts,
  setLiveRunOpening,
} from './live-runs.js';
import { recordActivity } from './activity.js';
import { NOTHING_TO_DO } from '../../src/lib/automation-presets.mjs';

/** Default subprocess timeout per job run. */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/** Maximum persisted runs per job. */
export const MAX_RUNS_PER_JOB = 20;

/** Global concurrent scheduled runs. */
export const MAX_CONCURRENT_RUNS = 2;

/** Maximum output retained in each persisted run field. */
const MAX_OUTPUT_CHARS = 16_000;
/** Keep enough of stdout to parse the final CLI JSON without unbounded capture. */
const MAX_STDOUT_CAPTURE_CHARS = 64_000;
/** Largest partial stdout line kept while waiting for its newline. */
const MAX_LINE_BUFFER_CHARS = 2_000_000;

/** Append a child output chunk while retaining only the most recent characters. */
export function appendOutputTail(current, chunk, limit) {
  const text = chunk.toString();
  if (text.length >= limit) return text.slice(-limit);
  return `${current}${text}`.slice(-limit);
}

/** A run's final reply means "nothing to do" when it is exactly the marker. */
export function isNothingToDoReply(text) {
  return String(text ?? '').trim().replace(/[.`*]/g, '') === NOTHING_TO_DO;
}

/** @type {Set<string>} */
const activeJobIds = new Set();

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const activeChildren = new Map();

/** Reviewer sub-run ids by parent run id. @type {Map<string, Set<string>>} */
const childRunsByParent = new Map();

/** Runs a person asked to stop. @type {Set<string>} */
const cancelledRunIds = new Set();

/** In-flight top-level run id by job id. @type {Map<string, string>} */
const activeRunIdByJob = new Map();

async function readRunHistory(jobId) {
  const filePath = schedulerRunHistoryPath(jobId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed?.version ?? 1,
      runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
    };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { version: 1, runs: [] };
    }
    throw err;
  }
}

/**
 * Insert or replace a run row in per-job history.
 * @param {string} jobId
 * @param {object} run
 */
async function upsertRun(jobId, run) {
  const filePath = schedulerRunHistoryPath(jobId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const history = await readRunHistory(jobId);
  const index = history.runs.findIndex((row) => row.id === run.id);
  if (index >= 0) {
    history.runs[index] = { ...history.runs[index], ...run };
  } else {
    history.runs.unshift(run);
  }
  let pruned = false;
  if (history.runs.length > MAX_RUNS_PER_JOB) {
    history.runs = history.runs.slice(0, MAX_RUNS_PER_JOB);
    pruned = true;
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await renameSchedulerFile(tmp, filePath);
  if (pruned) {
    await pruneRunTranscripts(jobId, history.runs.map((row) => row.id)).catch(() => {});
  }
}

/** @param {string} jobId */
export async function listRunsForJob(jobId) {
  const history = await readRunHistory(jobId);
  return history.runs;
}

/** Reconcile persisted runs whose owning process no longer exists at startup. */
export async function recoverInterruptedSchedulerRuns() {
  const interrupted = await recoverInterruptedJobs(activeJobIds);
  for (const jobId of interrupted) {
    const history = await readRunHistory(jobId);
    for (const run of history.runs.filter((row) => row.status === 'running')) {
      await upsertRun(jobId, {
        id: run.id,
        completedAt: new Date().toISOString(),
        status: 'failed',
        exitCode: 1,
        error: 'Minnow stopped before this run finished.',
      });
    }
  }
  return interrupted;
}

async function readRunResultFile(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Older runners (and tests) print the result JSON at the end of stdout. */
function parseResultFromStdout(stdout) {
  const tryParse = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && value.type === undefined ? value : null;
    } catch {
      return null;
    }
  };
  const first = stdout.indexOf('{');
  if (first < 0) return null;
  const whole = tryParse(stdout.slice(first));
  if (whole) return whole;
  // Event lines precede the result: take the last top-level object.
  const marker = stdout.lastIndexOf('\n{');
  return marker >= 0 ? tryParse(stdout.slice(marker + 1)) : null;
}

/**
 * Spawn the CLI subprocess for a scheduled run and capture its output.
 * Any failure while preparing arguments (locating the runner script,
 * decrypting the prompt, resolving the run model, or resolving the
 * workspace path) propagates to the caller so it can be treated as a
 * uniform preparation failure.
 * @param {{ storedJob: object; runId: string; baseUrl: string; timeoutMs: number; spawnImpl: typeof import('node:child_process').spawn; liveRunId?: string; persistChat?: boolean; chatName?: string }} params
 */
async function executeJobRun({ storedJob, runId, baseUrl, timeoutMs, spawnImpl, liveRunId = runId, persistChat = true, chatName }) {
  const entry = resolveHeadlessRunEntry();
  const prompt = await decryptSecretPayload(storedJob.promptEnc);
  // The result is written to --json-out below; stdout carries --stream-json events.
  const args = [
    entry.script,
    'run',
    '--prompt',
    prompt,
    '--mode',
    storedJob.modeId ?? 'build',
    '--base-url',
    baseUrl,
    '--auto-reject-questions',
  ];

  if (storedJob.workAgentId) {
    args.push('--agent', storedJob.workAgentId);
  }

  const { providerId, modelId } = await resolveJobRunModel(storedJob);
  if (providerId) {
    args.push('--provider', providerId);
  }
  if (modelId) {
    args.push('--model', modelId);
  }

  const workspacePath = await resolveJobWorkspacePath(storedJob);
  args.push('--workspace', workspacePath);
  if (persistChat) {
    args.push('--persist-chat', '--chat-id', runId, '--chat-name', chatName || storedJob.label || 'Scheduled job');
  }
  args.push('--scheduler-run');
  // Stream runner events for the live hub; the final result lands in a file.
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-run-'));
  const resultFile = path.join(resultDir, 'result.json');
  args.push('--stream-json', '--json-out', resultFile);

  const env = {
    ...process.env,
    BROWSER: 'none',
    // Hand the child this host's credential directly. The session-token file is
    // shared by every host on the same Minnow home and holds only the newest one.
    MINNOW_TOKEN: getSessionToken(),
  };
  delete env.MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION;

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let exitCode = 1;
  let parsedResult = null;
  let lineBuffer = '';
  const consumeLines = (text) => {
    lineBuffer += text;
    if (lineBuffer.length > MAX_LINE_BUFFER_CHARS) lineBuffer = '';
    let newline = lineBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line.startsWith('{') && line.includes('"type"')) {
        try {
          const event = JSON.parse(line);
          if (event && typeof event.type === 'string' && event.version === undefined) applyLiveEvent(liveRunId, event);
        } catch {
          /* not an event line */
        }
      }
      newline = lineBuffer.indexOf('\n');
    }
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawnImpl(process.execPath, args, {
        cwd: entry.cwd,
        // Packaged Electron: run the script as Node, not as a second app instance.
        env: applyNodeRuntimeEnv(env, process.execPath),
        windowsHide: true,
      });
      activeChildren.set(runId, child);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdout = appendOutputTail(stdout, chunk, MAX_STDOUT_CAPTURE_CHARS);
        consumeLines(chunk.toString());
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendOutputTail(stderr, chunk, MAX_OUTPUT_CHARS);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        exitCode = code ?? 1;
        resolve({ code: exitCode, stdout, stderr, timedOut });
      });
    });

    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.code;
    timedOut = result.timedOut;

    parsedResult = (await readRunResultFile(resultFile)) ?? parseResultFromStdout(stdout);
    if (parsedResult) {
      // Run history keeps the result, not the raw event stream.
      stdout = JSON.stringify(parsedResult);
    }
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  } finally {
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});
  }

  return { stdout, stderr, exitCode, timedOut, parsedResult };
}

/**
 * Run one headless sub-run (a PR reviewer) under a parent run. Its transcript
 * streams into the hub nested under the parent; it is not saved as a Code chat.
 * @param {{ storedJob: object; parentRunId: string; role: string; roleLabel: string; prompt: string; workspacePath: string; modeId?: string; baseUrl?: string; timeoutMs?: number; spawn?: typeof import('node:child_process').spawn }} input
 */
export async function runHeadlessSubRun(input) {
  const runId = randomUUID();
  beginLiveRun({
    runId, jobId: input.storedJob.id, label: input.roleLabel, prompt: input.prompt,
    parentRunId: input.parentRunId, role: input.role, roleLabel: input.roleLabel, workspacePath: input.workspacePath,
  });
  const siblings = childRunsByParent.get(input.parentRunId) ?? new Set();
  siblings.add(runId);
  childRunsByParent.set(input.parentRunId, siblings);
  try {
    if (cancelledRunIds.has(input.parentRunId)) throw new Error('Run stopped');
    const result = await executeJobRun({
      storedJob: {
        ...input.storedJob,
        workspacePath: input.workspacePath,
        modeId: input.modeId ?? 'build',
        workAgentId: undefined,
        promptEnc: await encryptSecretPayload(input.prompt),
      },
      runId,
      baseUrl: input.baseUrl ?? getSchedulerServerBaseUrl(),
      timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      spawnImpl: input.spawn ?? spawn,
      persistChat: false,
    });
    const status = cancelledRunIds.has(input.parentRunId) ? 'cancelled'
      : result.timedOut ? 'timeout'
        : result.exitCode === 0 && result.parsedResult?.ok !== false ? 'completed' : 'failed';
    const assistantFinal = String(result.parsedResult?.assistantFinal ?? '');
    const error = status === 'completed' ? null : String(result.parsedResult?.error || result.stderr || status).slice(-2000);
    finishLiveRun(runId, { status, result: { assistantFinal, error } });
    return { runId, status, assistantFinal, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishLiveRun(runId, { status: 'failed', result: { error: message } });
    return { runId, status: 'failed', assistantFinal: '', error: message };
  } finally {
    activeChildren.delete(runId);
  }
}

/**
 * Stop an in-flight run and any reviewer sub-runs it started.
 * @param {string} runId
 */
export function stopSchedulerRun(runId) {
  const isActive = activeChildren.has(runId) || [...activeRunIdByJob.values()].includes(runId);
  if (!isActive) return { ok: false, reason: 'not_running' };
  cancelledRunIds.add(runId);
  const kill = (id) => {
    const child = activeChildren.get(id);
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  kill(runId);
  for (const childId of childRunsByParent.get(runId) ?? []) kill(childId);
  return { ok: true };
}

/** Whether a person asked this run to stop (engines check between steps). */
export function isRunCancelled(runId) {
  return cancelledRunIds.has(runId);
}

/** In-flight top-level run id for a job, if any. */
export function getActiveRunIdForJob(jobId) {
  return activeRunIdByJob.get(jobId) ?? null;
}

/**
 * Best-effort persistence of a failed run row. Never throws — a history
 * write rejection must not prevent the run slot from being released.
 * @param {string} jobId
 * @param {object} run
 */
async function settleRunFailure(jobId, run) {
  try {
    await upsertRun(jobId, { ...run, status: 'failed' });
  } catch (err) {
    console.warn(
      '[scheduler] failed to record failed run history:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Clear the `running` flag on the stored job and schedule its next run.
 * Wrapped so a rejection can never leave the job stuck as running.
 * @param {string} jobId
 * @param {object} storedJob
 * @param {string} completedAt
 */
async function clearJobRunningFlag(jobId, storedJob, completedAt) {
  try {
    await mutateStoredJob(jobId, (job) => ({
      ...job,
      running: false,
      lastRunAt: completedAt,
      nextRunAt: job.enabled ? computeNextRun(job, new Date(completedAt)) : job.nextRunAt,
      updatedAt: completedAt,
    }));
  } catch (err) {
    console.warn(
      '[scheduler] failed to clear running flag for job',
      jobId,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Reserve a slot immediately; completion is independent of admission. */
export function startStoredJob(storedJob, options = {}) {
  const jobId = storedJob.id;
  if (activeJobIds.has(jobId) || storedJob.running) {
    return { started: false, reason: 'already_running' };
  }
  if (activeJobIds.size >= MAX_CONCURRENT_RUNS) {
    return { started: false, reason: 'concurrency_cap' };
  }

  activeJobIds.add(jobId);
  const completion = completeStoredJob(storedJob, options);
  // Admission callers can observe completion, but detached runs must never
  // create an unhandled rejection if persistence or delivery fails.
  void completion.catch((err) => {
    console.warn('[scheduler] run failed:', err instanceof Error ? err.message : err);
  });
  return { started: true, completion };
}

/** Completion-oriented API retained for manual runs. */
export async function runStoredJob(storedJob, options = {}) {
  const admission = startStoredJob(storedJob, options);
  return admission.started ? admission.completion : admission;
}

/** @param {object} storedJob */
function engineFor(storedJob) {
  if (storedJob.githubWatch) return 'github-watch';
  if (storedJob.preset?.id === 'pr-review') return 'pr-review';
  return 'prompt';
}

async function completeStoredJob(storedJob, options) {
  const jobId = storedJob.id;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? getSchedulerServerBaseUrl();
  const spawnImpl = options.spawn ?? spawn;
  const trigger = options.trigger === 'manual' ? 'manual' : 'schedule';
  const engine = engineFor(storedJob);

  let completedAt = startedAt;
  // Registered synchronously so Run now can return the run id immediately.
  beginLiveRun({ runId, jobId, label: storedJob.label, workspacePath: storedJob.workspacePath });
  activeRunIdByJob.set(jobId, runId);

  try {
    if (engine === 'prompt') {
      try { setLiveRunOpening(runId, await decryptSecretPayload(storedJob.promptEnc)); } catch { /* the run reports it */ }
    }
    await mutateStoredJob(jobId, (job) => ({
      ...job,
      running: true,
      updatedAt: startedAt,
    }));

    await upsertRun(jobId, {
      id: runId,
      jobId,
      startedAt,
      status: 'running',
      trigger,
    });

    let stdout;
    let stderr;
    let exitCode;
    let timedOut;
    let parsedResult;

    try {
      const result = engine === 'github-watch'
        ? await executeGithubWatch({ storedJob, runId, baseUrl, timeoutMs, spawnImpl })
        : engine === 'pr-review'
          ? await executePrReview({ storedJob, runId, baseUrl, timeoutMs, spawnImpl })
          : await executeJobRun({ storedJob, runId, baseUrl, timeoutMs, spawnImpl });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      parsedResult = result.parsedResult;
    } catch (err) {
      completedAt = new Date().toISOString();
      const errorText = err instanceof Error ? err.message : String(err);
      finishLiveRun(runId, { status: 'failed', result: { error: errorText } });
      await persistRunTranscript(jobId, runId).catch(() => {});
      void recordActivity({ jobId, label: storedJob.label, runId, tone: 'fail', text: `${storedJob.label} failed: ${errorText}` });
      await settleRunFailure(jobId, {
        id: runId,
        jobId,
        startedAt,
        completedAt,
        exitCode: 1,
        error: errorText,
        trigger,
      });
      return {
        started: true,
        runId,
        status: 'failed',
        exitCode: 1,
        output: '',
        error: errorText,
      };
    }

    completedAt = new Date().toISOString();
    const status = cancelledRunIds.has(runId)
      ? 'cancelled'
      : timedOut
        ? 'timeout'
        : exitCode === 0 && parsedResult?.ok !== false
          ? 'completed'
          : 'failed';
    const quiet = status === 'completed' && (parsedResult?.quiet === true || isNothingToDoReply(parsedResult?.assistantFinal));

    const output = stdout.trim().slice(-MAX_OUTPUT_CHARS);
    const errorText = status === 'cancelled'
      ? 'Stopped from Automations.'
      : (stderr.trim() || parsedResult?.error || '').slice(-MAX_OUTPUT_CHARS) || undefined;
    const chatId =
      typeof parsedResult?.chatId === 'string' && parsedResult.chatId.trim()
        ? parsedResult.chatId.trim()
        : undefined;

    finishLiveRun(runId, { status, result: { assistantFinal: parsedResult?.assistantFinal ?? '', error: errorText ?? null, quiet } });
    const liveEntry = getLiveRun(runId, { withMessages: false });

    try {
      await upsertRun(jobId, {
        id: runId,
        jobId,
        startedAt,
        completedAt,
        status,
        exitCode,
        output: output || undefined,
        error: errorText,
        chatId,
        trigger,
        quiet: quiet || undefined,
        headline: liveEntry?.headline,
        stats: liveEntry?.stats,
        reviewers: liveEntry?.children?.length
          ? liveEntry.children.map((child) => ({ runId: child.runId, role: child.role, label: child.roleLabel, status: child.status }))
          : undefined,
      });
    } catch (err) {
      console.warn(
        '[scheduler] failed to record run history:',
        err instanceof Error ? err.message : err,
      );
    }

    await persistRunTranscript(jobId, runId).catch((err) => {
      console.warn('[scheduler] failed to save run transcript:', err instanceof Error ? err.message : err);
    });

    if (status === 'failed' || status === 'timeout') {
      void recordActivity({
        jobId, label: storedJob.label, runId, tone: 'fail',
        text: `${storedJob.label} ${status === 'timeout' ? 'timed out' : 'failed'}${errorText ? `: ${errorText.split('\n')[0]}` : ''}`,
      });
    } else if (status === 'completed' && !quiet && engine === 'prompt') {
      const first = String(parsedResult?.assistantFinal ?? '').trim().split('\n').find(Boolean) ?? 'Finished';
      void recordActivity({ jobId, label: storedJob.label, runId, tone: 'ok', text: `${storedJob.label}: ${first}` });
    }

    if (status !== 'cancelled') {
      const message = summarizeRunForNotification(
        parsedResult ?? { ok: status === 'completed', error: errorText },
      );
      await enqueueSchedulerNotification({
        jobId,
        runId,
        chatId,
        workspacePath: await resolveJobWorkspacePath(storedJob),
        status,
        silent: quiet || !storedJob.channels?.includes('in_app'),
        label: storedJob.label,
        message,
      });
    }

    return {
      started: true,
      runId,
      status,
      exitCode,
      output,
      error: errorText,
    };
  } finally {
    activeChildren.delete(runId);
    activeRunIdByJob.delete(jobId);
    cancelledRunIds.delete(runId);
    childRunsByParent.delete(runId);
    try {
      await clearJobRunningFlag(jobId, storedJob, completedAt);
    } finally {
      activeJobIds.delete(jobId);
    }
  }
}

async function executeGithubWatch({ storedJob, runId, baseUrl, timeoutMs, spawnImpl }) {
  let result;
  try {
    const { runGithubWatch } = await import('./github-watch-runtime.js');
    result = await runGithubWatch({
      job: { ...storedJob, prompt: await decryptSecretPayload(storedJob.promptEnc) }, baseUrl,
      runPlanner: async ({ prompt, workspacePath, modeId }) => executeJobRun({
        storedJob: { ...storedJob, workspacePath, modeId, workAgentId: undefined, promptEnc: await encryptSecretPayload(prompt) },
        runId, baseUrl, timeoutMs, spawnImpl,
      }),
    });
  } catch (error) {
    result = { blocked: true, changed: true, summary: `GitHub watcher failed: ${String(error.message ?? error)}` };
  }
  const parsedResult = { ok: !result.blocked, assistantFinal: result.summary, quiet: !result.changed, chatId: result.chatId };
  return { stdout: result.summary, stderr: result.blocked ? result.summary : '', exitCode: result.blocked ? 1 : 0, timedOut: false, parsedResult };
}

async function executePrReview({ storedJob, runId, baseUrl, timeoutMs, spawnImpl }) {
  let result;
  try {
    const { runPrReview } = await import('./pr-review-runtime.js');
    result = await runPrReview({
      job: storedJob,
      runId,
      isCancelled: () => cancelledRunIds.has(runId),
      runReviewer: ({ role, roleLabel, prompt, workspacePath }) => runHeadlessSubRun({
        storedJob, parentRunId: runId, role, roleLabel, prompt, workspacePath, modeId: 'build', baseUrl, timeoutMs, spawn: spawnImpl,
      }),
    });
  } catch (error) {
    result = { blocked: true, changed: true, summary: `PR Reviewer failed: ${String(error?.message ?? error)}` };
  }
  const parsedResult = { ok: !result.blocked, assistantFinal: result.summary, quiet: !result.changed };
  return { stdout: result.summary, stderr: result.blocked ? result.summary : '', exitCode: result.blocked ? 1 : 0, timedOut: false, parsedResult };
}

/** @param {string} jobId @param {{ baseUrl?: string }} [options] */
export async function runJobNow(jobId, options = {}) {
  const stored = await getStoredJobById(jobId);
  if (!stored) {
    throw new Error('Job not found');
  }
  return runStoredJob(stored, {
    ...options,
    baseUrl: options.baseUrl ?? getSchedulerServerBaseUrl(),
    trigger: 'manual',
  });
}

/**
 * Start a job without waiting for it to finish (the hub's Run now).
 * @param {string} jobId @param {{ baseUrl?: string }} [options]
 */
export async function startJobNow(jobId, options = {}) {
  const stored = await getStoredJobById(jobId);
  if (!stored) {
    throw new Error('Job not found');
  }
  const admission = startStoredJob(stored, {
    ...options,
    baseUrl: options.baseUrl ?? getSchedulerServerBaseUrl(),
    trigger: 'manual',
  });
  return admission.started
    ? { started: true, runId: activeRunIdByJob.get(jobId) ?? null }
    : { started: false, reason: admission.reason };
}

/** Current number of in-flight scheduled runs. */
export function getActiveRunCount() {
  return activeJobIds.size;
}

/** Stop scheduler children on server shutdown. */
export function shutdownSchedulerRuns() {
  activeRunIdByJob.clear();
  childRunsByParent.clear();
  for (const child of activeChildren.values()) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  activeJobIds.clear();
}
