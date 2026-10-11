/**
 * Headless subprocess execution for scheduled jobs.
 */

import fs from 'node:fs/promises';
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

/** Append a child output chunk while retaining only the most recent characters. */
export function appendOutputTail(current, chunk, limit) {
  const text = chunk.toString();
  if (text.length >= limit) return text.slice(-limit);
  return `${current}${text}`.slice(-limit);
}

/** @type {Set<string>} */
const activeJobIds = new Set();

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const activeChildren = new Map();

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
  if (history.runs.length > MAX_RUNS_PER_JOB) {
    history.runs = history.runs.slice(0, MAX_RUNS_PER_JOB);
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await renameSchedulerFile(tmp, filePath);
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

/**
 * @param {object} storedJob
 * @param {{ baseUrl?: string; timeoutMs?: number; trigger?: 'schedule' | 'manual'; spawn?: typeof import('node:child_process').spawn }} [options]
 */

/**
 * Spawn the CLI subprocess for a scheduled run and capture its output.
 * Any failure while preparing arguments (locating the runner script,
 * decrypting the prompt, resolving the run model, or resolving the
 * workspace path) propagates to the caller so it can be treated as a
 * uniform preparation failure.
 * @param {{ storedJob: object; runId: string; baseUrl: string; timeoutMs: number; spawnImpl: typeof import('node:child_process').spawn }} params
 */
async function executeJobRun({ storedJob, runId, baseUrl, timeoutMs, spawnImpl }) {
  const entry = resolveHeadlessRunEntry();
  const prompt = await decryptSecretPayload(storedJob.promptEnc);
  const args = [
    entry.script,
    'run',
    '--json',
    '--prompt',
    prompt,
    '--mode',
    storedJob.modeId ?? 'build',
    '--base-url',
    baseUrl,
    '--no-approval',
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
  args.push('--persist-chat', '--chat-id', runId, '--chat-name', storedJob.label || 'Scheduled job');
  args.push('--scheduler-run');

  const env = {
    ...process.env,
    MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION: '1',
    BROWSER: 'none',
    // Hand the child this host's credential directly. The session-token file is
    // shared by every host on the same Minnow home and holds only the newest one.
    MINNOW_TOKEN: getSessionToken(),
  };

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let exitCode = 1;
  let parsedResult = null;

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

    const jsonStart = stdout.indexOf('{');
    if (jsonStart >= 0) {
      try {
        parsedResult = JSON.parse(stdout.slice(jsonStart));
      } catch {
        parsedResult = null;
      }
    }
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  return { stdout, stderr, exitCode, timedOut, parsedResult };
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

async function completeStoredJob(storedJob, options) {
  const jobId = storedJob.id;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? getSchedulerServerBaseUrl();
  const spawnImpl = options.spawn ?? spawn;

  let completedAt = startedAt;

  try {
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
    });

    let stdout;
    let stderr;
    let exitCode;
    let timedOut;
    let parsedResult;

    try {
      const result = storedJob.githubWatch
        ? await executeGithubWatch({ storedJob, runId, baseUrl, timeoutMs, spawnImpl })
        : await executeJobRun({ storedJob, runId, baseUrl, timeoutMs, spawnImpl });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      parsedResult = result.parsedResult;
    } catch (err) {
      completedAt = new Date().toISOString();
      const errorText = err instanceof Error ? err.message : String(err);
      await settleRunFailure(jobId, {
        id: runId,
        jobId,
        startedAt,
        completedAt,
        exitCode: 1,
        error: errorText,
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
    const status = timedOut
      ? 'timeout'
      : exitCode === 0 && parsedResult?.ok !== false
        ? 'completed'
        : 'failed';

    const output = stdout.trim().slice(-MAX_OUTPUT_CHARS);
    const errorText = (stderr.trim() || parsedResult?.error || '').slice(-MAX_OUTPUT_CHARS) || undefined;
    const chatId =
      typeof parsedResult?.chatId === 'string' && parsedResult.chatId.trim()
        ? parsedResult.chatId.trim()
        : undefined;

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
      });
    } catch (err) {
      console.warn(
        '[scheduler] failed to record run history:',
        err instanceof Error ? err.message : err,
      );
    }

    if (parsedResult?.quiet !== true && Array.isArray(storedJob.channels) && storedJob.channels.includes('in_app')) {
      const message = summarizeRunForNotification(
        parsedResult ?? { ok: status === 'completed', error: errorText },
      );
      await enqueueSchedulerNotification({
        jobId,
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

/** Current number of in-flight scheduled runs. */
export function getActiveRunCount() {
  return activeJobIds.size;
}

/** Stop scheduler children on server shutdown. */
export function shutdownSchedulerRuns() {
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
