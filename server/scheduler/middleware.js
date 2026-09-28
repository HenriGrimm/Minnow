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
import { runJobNow } from './runner.js';
import { listRunsForJob } from './runner.js';
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
