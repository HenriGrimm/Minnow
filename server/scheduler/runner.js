/**
 * Headless subprocess execution for scheduled jobs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAppRoot } from '../workspace/root.js';
import { decryptSecretPayload } from '../security/secret-box.js';
import {
  getStoredJobById,
  mutateStoredJob,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Default subprocess timeout per job run. */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/** Maximum persisted runs per job. */
export const MAX_RUNS_PER_JOB = 20;

/** Global concurrent scheduled runs. */
export const MAX_CONCURRENT_RUNS = 2;

/** Maximum stdout JSON bytes captured for history. */
const MAX_OUTPUT_CHARS = 16_000;

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
  await fs.rename(tmp, filePath);
}

/** @param {string} jobId */
export async function listRunsForJob(jobId) {
  const history = await readRunHistory(jobId);
  return history.runs;
}

/**
 * @param {object} storedJob
 * @param {{ baseUrl?: string; timeoutMs?: number; trigger?: 'schedule' | 'manual'; spawn?: typeof import('node:child_process').spawn }} [options]
 */
export async function runStoredJob(storedJob, options = {}) {
  const jobId = storedJob.id;
  if (activeJobIds.has(jobId) || storedJob.running) {
    return { started: false, reason: 'already_running' };
  }
  if (activeJobIds.size >= MAX_CONCURRENT_RUNS) {
    return { started: false, reason: 'concurrency_cap' };
  }

  activeJobIds.add(jobId);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? getSchedulerServerBaseUrl();

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

  const prompt = await decryptSecretPayload(storedJob.promptEnc);
  const args = [
    path.join(PROJECT_ROOT, 'bin/minnow.mjs'),
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
  };

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let exitCode = 1;
  let parsedResult = null;

  const spawnImpl = options.spawn ?? spawn;

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawnImpl(process.execPath, args, {
        cwd: getAppRoot(),
        // Packaged Electron: run minnow.mjs as Node, not as a second app instance.
        env: applyNodeRuntimeEnv(env, process.execPath),
        windowsHide: true,
      });
      activeChildren.set(runId, child);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
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
  } finally {
    activeChildren.delete(runId);
    activeJobIds.delete(jobId);
  }

  const completedAt = new Date().toISOString();
  const status = timedOut
    ? 'timeout'
    : exitCode === 0 && parsedResult?.ok !== false
      ? 'completed'
      : 'failed';

  const output = stdout.trim().slice(0, MAX_OUTPUT_CHARS);
  const errorText = stderr.trim().slice(0, MAX_OUTPUT_CHARS) || parsedResult?.error || undefined;
  const chatId =
    typeof parsedResult?.chatId === 'string' && parsedResult.chatId.trim()
      ? parsedResult.chatId.trim()
      : undefined;

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

  await mutateStoredJob(jobId, (job) => ({
    ...job,
    running: false,
    lastRunAt: completedAt,
    nextRunAt: job.enabled ? computeNextRun(job, new Date(completedAt)) : job.nextRunAt,
    updatedAt: completedAt,
  }));

  if (Array.isArray(storedJob.channels) && storedJob.channels.includes('in_app')) {
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
