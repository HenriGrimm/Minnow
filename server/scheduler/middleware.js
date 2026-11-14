/**
 * Scheduler REST API: jobs, run-now, notifications, and run history.
 */

import {
  createJob,
  deleteJob,
  getJobById,
  listJobs,
  updateJob,
} from './store.js';
import { runJobNow, startJobNow, stopSchedulerRun, listRunsForJob } from './runner.js';
import { readWatchLedger } from './github-watch-store.js';
import { retryGithubWatchIssue } from './github-watch.js';
import { readReviewLedger } from './pr-review-store.js';
import { retryPrReview } from './pr-review.js';
import { getLiveRun, listLiveRuns, readRunTranscript, removeJobTranscripts } from './live-runs.js';
import { forgetJobActivity, listActivity } from './activity.js';
import { computeNextRun, validateSchedule } from './schedule.js';
import { getSchedulerServerBaseUrl } from './server-base-url.js';
import {
  ackNotification,
  listUnackedNotifications,
} from './delivery.js';
import { ensureMinnowLayout } from '../config/home.js';
import {
  ensureSchedulerWorkspace,
  getSchedulerWorkspacePath,
} from '../scheduler-workspace/paths.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** What needs a person, newest first: blocked work items, then a failed last run. */
async function attentionFor(job, runs) {
  if (job.githubWatch) {
    const ledger = await readWatchLedger(job.githubWatch.repository).catch(() => ({ issues: [] }));
    const blocked = ledger.issues.find((row) => row.jobId === job.id && row.phase === 'blocked');
    if (blocked) return { kind: 'issue', number: blocked.number, title: blocked.title, url: blocked.url, text: blocked.error ?? 'Needs attention' };
  }
  if (job.preset?.id === 'pr-review') {
    const ledger = await readReviewLedger(job.preset.config.repository).catch(() => ({ pulls: [] }));
    const blocked = [...ledger.pulls].reverse().find((row) => row.jobId === job.id && row.phase === 'blocked');
    if (blocked) return { kind: 'pr', number: blocked.number, title: blocked.title, url: blocked.url, text: blocked.error ?? 'Needs attention', runId: blocked.runId };
  }
  const last = runs.find((run) => run.status !== 'running' && !run.quiet);
  // A run in progress is the retry; its outcome decides whether this still needs you.
  if (!job.running && last && (last.status === 'failed' || last.status === 'timeout')) {
    return { kind: 'run', runId: last.id, text: String(last.error ?? (last.status === 'timeout' ? 'The run timed out.' : 'The last run failed.')).split('\n')[0].slice(0, 280) };
  }
  return null;
}

async function buildOverview() {
  const jobs = await listJobs();
  const live = listLiveRuns();
  const rows = [];
  for (const job of jobs) {
    const runs = await listRunsForJob(job.id).catch(() => []);
    rows.push({
      ...job,
      prompt: undefined,
      recentRuns: runs.map((run) => ({
        id: run.id, status: run.status, quiet: Boolean(run.quiet), startedAt: run.startedAt, completedAt: run.completedAt,
        headline: run.headline, trigger: run.trigger,
      })),
      live: live.find((row) => row.jobId === job.id) ?? null,
      attention: job.enabled || job.running ? await attentionFor(job, runs) : null,
    });
  }
  return { jobs: rows, activity: await listActivity(40), now: new Date().toISOString() };
}

export function createSchedulerMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/scheduler')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      await ensureMinnowLayout();

      if (url === '/api/scheduler/ping' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url === '/api/scheduler/workspace' && req.method === 'GET') {
        await ensureSchedulerWorkspace();
        sendJson(res, 200, {
          ok: true,
          path: getSchedulerWorkspacePath(),
          label: 'Scheduler',
        });
        return;
      }

      if (url === '/api/scheduler/overview' && req.method === 'GET') {
        sendJson(res, 200, await buildOverview());
        return;
      }

      if (url === '/api/scheduler/schedule/preview' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const schedule = validateSchedule(body?.schedule);
        sendJson(res, 200, { schedule, nextRunAt: computeNextRun({ schedule }) ?? null });
        return;
      }

      if (url === '/api/scheduler/github/detect' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { detectGithubRepository } = await import('./pr-review-runtime.js');
        sendJson(res, 200, await detectGithubRepository(String(body?.workspacePath ?? '')));
        return;
      }

      if (url === '/api/scheduler/jobs' && req.method === 'GET') {
        sendJson(res, 200, { jobs: await listJobs() });
        return;
      }

      if (url === '/api/scheduler/jobs' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const job = await createJob(body?.job ?? body);
        sendJson(res, 201, { job });
        return;
      }

      const jobMatch = url.match(/^\/api\/scheduler\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        if (req.method === 'PUT') {
          const body = await readJsonBody(req);
          const job = await updateJob(jobId, body?.job ?? body);
          sendJson(res, 200, { job });
          return;
        }
        if (req.method === 'DELETE') {
          await deleteJob(jobId);
          await removeJobTranscripts(jobId).catch(() => {});
          await forgetJobActivity(jobId);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'GET') {
          const job = await getJobById(jobId);
          if (!job) {
            sendJson(res, 404, { error: 'Job not found' });
            return;
          }
          sendJson(res, 200, { job });
          return;
        }
      }

      const watchMatch = url.match(/^\/api\/scheduler\/jobs\/([^/]+)\/issues(?:\/(\d+)\/retry)?$/);
      if (watchMatch) {
        const job = await getJobById(decodeURIComponent(watchMatch[1]));
        if (!job?.githubWatch) throw new Error('GitHub watcher not found');
        if (req.method === 'GET' && !watchMatch[2]) {
          const ledger = await readWatchLedger(job.githubWatch.repository);
          sendJson(res, 200, { issues: ledger.issues.filter(row => row.jobId === job.id) });
          return;
        }
        if (req.method === 'POST' && watchMatch[2]) {
          const result = await retryGithubWatchIssue(job, Number(watchMatch[2]));
          sendJson(res, result.ok ? 200 : 409, result);
          return;
        }
      }

      const pullsMatch = url.match(/^\/api\/scheduler\/jobs\/([^/]+)\/pulls(?:\/(\d+)\/retry)?$/);
      if (pullsMatch) {
        const job = await getJobById(decodeURIComponent(pullsMatch[1]));
        if (job?.preset?.id !== 'pr-review') throw new Error('PR Reviewer not found');
        if (req.method === 'GET' && !pullsMatch[2]) {
          const ledger = await readReviewLedger(job.preset.config.repository);
          sendJson(res, 200, { pulls: ledger.pulls.filter((row) => row.jobId === job.id), queue: ledger.queue, checkedAt: ledger.checkedAt ?? null });
          return;
        }
        if (req.method === 'POST' && pullsMatch[2]) {
          sendJson(res, 200, await retryPrReview(job, Number(pullsMatch[2])));
          return;
        }
      }

      const startMatch = url.match(/^\/api\/scheduler\/jobs\/([^/]+)\/start$/);
      if (startMatch && req.method === 'POST') {
        const result = await startJobNow(decodeURIComponent(startMatch[1]), { baseUrl: getSchedulerServerBaseUrl() });
        sendJson(res, result.started ? 200 : 409, result);
        return;
      }

      const stopMatch = url.match(/^\/api\/scheduler\/runs\/([^/]+)\/stop$/);
      if (stopMatch && req.method === 'POST') {
        const result = stopSchedulerRun(decodeURIComponent(stopMatch[1]));
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      const runDetailMatch = url.match(/^\/api\/scheduler\/runs\/([^/]+)\/([^/]+)$/);
      if (runDetailMatch && req.method === 'GET') {
        const jobId = decodeURIComponent(runDetailMatch[1]);
        const runId = decodeURIComponent(runDetailMatch[2]);
        const runs = await listRunsForJob(jobId);
        const run = runs.find((row) => row.id === runId) ?? null;
        const live = getLiveRun(runId);
        const transcript = live?.status === 'running' ? null : await readRunTranscript(jobId, runId);
        if (!run && !live) {
          sendJson(res, 404, { error: 'Run not found' });
          return;
        }
        sendJson(res, 200, { run, live, transcript });
        return;
      }

      const runMatch = url.match(/^\/api\/scheduler\/jobs\/([^/]+)\/run$/);
      if (runMatch && req.method === 'POST') {
        const jobId = decodeURIComponent(runMatch[1]);
        const result = await runJobNow(jobId, { baseUrl: getSchedulerServerBaseUrl() });
        sendJson(res, 200, result);
        return;
      }

      if (url === '/api/scheduler/notifications' && req.method === 'GET') {
        sendJson(res, 200, { notifications: await listUnackedNotifications() });
        return;
      }

      const ackMatch = url.match(/^\/api\/scheduler\/notifications\/([^/]+)\/ack$/);
      if (ackMatch && req.method === 'POST') {
        const id = decodeURIComponent(ackMatch[1]);
        const notification = await ackNotification(id);
        sendJson(res, 200, { notification });
        return;
      }

      const runsMatch = url.match(/^\/api\/scheduler\/runs\/([^/]+)$/);
      if (runsMatch && req.method === 'GET') {
        const jobId = decodeURIComponent(runsMatch[1]);
        const runs = await listRunsForJob(jobId);
        sendJson(res, 200, { runs });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      sendJson(res, status, { error: message });
    }
  };
}
