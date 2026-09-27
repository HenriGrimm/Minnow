/**
 * Memory-only relay between the privileged host renderer and paired LAN devices.
 * The server validates and bounds every payload; no command survives a restart.
 */

import crypto from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASKS = 50;
const MAX_APPROVALS = 20;
const MAX_COMMANDS = 100;
const COMMAND_TTL_MS = 5 * 60_000;
const HOST_FRESH_MS = 15_000;

const TASK_STATUSES = new Set(['running', 'queued', 'needs-input', 'failed', 'completed', 'idle']);
const COMMAND_KINDS = new Set(['message', 'approval']);
const MESSAGE_DELIVERIES = new Set(['steer', 'queue', 'send']);
const APPROVAL_DECISIONS = new Set(['allow-once', 'cancel']);
const SECRET_KEY = /authorization|cookie|token|secret|password|api[-_]?key/i;
const SECRET_TEXT = /((?:bearer|token|api[-_ ]?key|password|secret)\s*[:=]\s*)([^\s,;"']+)/gi;

let hostState = null;
let commands = [];

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function redactApprovalValue(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '$1[redacted]');
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactApprovalValue(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? '[redacted]' : redactApprovalValue(entry, depth + 1),
  ]));
}

function redactApprovalArgs(value) {
  const raw = text(value, 16_000);
  if (!raw) return '';
  try {
    return JSON.stringify(redactApprovalValue(JSON.parse(raw))).slice(0, 4_000);
  } catch {
    return raw.replace(SECRET_TEXT, '$1[redacted]').slice(0, 4_000);
  }
}

function integer(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sanitizeFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((row) => ({
    path: text(row?.path, 320),
    additions: integer(row?.additions, 0, 1_000_000),
    deletions: integer(row?.deletions, 0, 1_000_000),
    countsKnown: row?.countsKnown !== false,
  })).filter((row) => row.path);
}

function sanitizeTask(row) {
  const id = text(row?.id, 160);
  if (!id) return null;
  const status = TASK_STATUSES.has(row?.status) ? row.status : 'idle';
  const review = row?.review && typeof row.review === 'object'
    ? {
        status: TASK_STATUSES.has(row.review.status) ? row.review.status : status,
        outcome: text(row.review.outcome, 600),
        summary: text(row.review.summary, 400),
        actions: integer(row.review.actions, 0, 10_000),
        failedActions: integer(row.review.failedActions, 0, 10_000),
        files: sanitizeFiles(row.review.files),
      }
    : null;
  return {
    id,
    title: text(row?.title, 200) || 'Untitled task',
    status,
    queued: integer(row?.queued, 0, 999),
    updatedAt: integer(row?.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    ...(review ? { review } : {}),
  };
}

function sanitizeApproval(row) {
  const id = text(row?.id, 160);
  const toolName = text(row?.toolName, 160);
  if (!id || !toolName) return null;
  return {
    id,
    chatId: text(row?.chatId, 160),
    taskTitle: text(row?.taskTitle, 200),
    title: text(row?.title, 240) || toolName,
    toolName,
    description: text(row?.description, 600),
    argsJson: redactApprovalArgs(row?.argsJson),
    workspaceLabel: text(row?.workspaceLabel, 200),
    createdAt: integer(row?.createdAt, 0, Number.MAX_SAFE_INTEGER),
  };
}

function sanitizeHostState(body, now) {
  const tasks = Array.isArray(body?.tasks)
    ? body.tasks.slice(0, MAX_TASKS).map(sanitizeTask).filter(Boolean)
    : [];
  const approvals = Array.isArray(body?.approvals)
    ? body.approvals.slice(0, MAX_APPROVALS).map(sanitizeApproval).filter(Boolean)
    : [];
  return { publishedAt: now, tasks, approvals };
}

function pruneCommands(now) {
  commands = commands.filter((command) => now - command.createdAt < COMMAND_TTL_MS);
}

function requireHost(req, res) {
  if (req.minnowAuth?.kind === 'host') return true;
  sendJson(res, 403, { error: 'Host session required' });
  return false;
}

function requireDevice(req, res) {
  if (req.minnowAuth?.kind === 'device') return true;
  sendJson(res, 403, { error: 'Paired companion device required' });
  return false;
}

function sanitizeCommand(body, auth, now) {
  if (!COMMAND_KINDS.has(body?.kind)) return null;
  const base = {
    id: crypto.randomUUID(),
    kind: body.kind,
    createdAt: now,
    deviceId: auth.deviceId,
    deviceName: text(auth.deviceName, 64) || 'Paired device',
  };
  if (body.kind === 'message') {
    const chatId = text(body.chatId, 160);
    const message = text(body.text, 4_000);
    const delivery = MESSAGE_DELIVERIES.has(body.delivery) ? body.delivery : '';
    if (!chatId || !message || !delivery) return null;
    return { ...base, chatId, text: message, delivery };
  }
  const approvalId = text(body.approvalId, 160);
  const decision = APPROVAL_DECISIONS.has(body.decision) ? body.decision : '';
  if (!approvalId || !decision) return null;
  return { ...base, approvalId, decision };
}

function commandAllowed(command, state) {
  if (!state) return false;
  if (command.kind === 'message') {
    const task = state.tasks.find((row) => row.id === command.chatId);
    if (!task) return false;
    return command.delivery === 'send'
      ? ['completed', 'failed', 'idle'].includes(task.status)
      : task.status === 'running';
  }
  return state.approvals.some((approval) => approval.id === command.approvalId);
}

/** Authenticated companion control-plane routes. */
export function createCompanionControlMiddleware(deps = {}) {
  const nowFn = deps.now ?? Date.now;
  return async function companionControlMiddleware(req, res, next) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!pathname.startsWith('/api/companion/control')) {
      next();
      return;
    }

    try {
      const now = nowFn();
      pruneCommands(now);

      if (pathname === '/api/companion/control' && req.method === 'GET') {
        if (!requireDevice(req, res)) return;
        const connected = Boolean(hostState && now - hostState.publishedAt <= HOST_FRESH_MS);
        sendJson(res, 200, {
          connected,
          publishedAt: hostState?.publishedAt ?? null,
          tasks: connected ? hostState?.tasks ?? [] : [],
          approvals: connected ? hostState?.approvals ?? [] : [],
        });
        return;
      }

      if (pathname === '/api/companion/control/state' && req.method === 'PUT') {
        if (!requireHost(req, res)) return;
        hostState = sanitizeHostState(await readJsonBody(req), now);
        commands = commands.filter((command) => commandAllowed(command, hostState));
        sendJson(res, 200, { ok: true, publishedAt: hostState.publishedAt });
        return;
      }

      if (pathname === '/api/companion/control/commands' && req.method === 'POST') {
        if (!requireDevice(req, res)) return;
        if (!hostState || now - hostState.publishedAt > HOST_FRESH_MS) {
          sendJson(res, 409, { error: 'Host task renderer is unavailable' });
          return;
        }
        if (commands.length >= MAX_COMMANDS) {
          sendJson(res, 429, { error: 'Companion command queue is full' });
          return;
        }
        const command = sanitizeCommand(await readJsonBody(req), req.minnowAuth, now);
        if (!command) {
          sendJson(res, 400, { error: 'Invalid companion command' });
          return;
        }
        if (!commandAllowed(command, hostState)) {
          sendJson(res, 409, { error: 'Companion command target is no longer available' });
          return;
        }
        commands.push(command);
        if (command.kind === 'approval') {
          hostState.approvals = hostState.approvals.filter(
            (approval) => approval.id !== command.approvalId,
          );
        }
        sendJson(res, 202, { accepted: true, commandId: command.id });
        return;
      }

      if (pathname === '/api/companion/control/commands' && req.method === 'GET') {
        if (!requireHost(req, res)) return;
        if (!hostState || now - hostState.publishedAt > HOST_FRESH_MS) commands = [];
        else commands = commands.filter((command) => commandAllowed(command, hostState));
        sendJson(res, 200, { commands });
        return;
      }

      const ack = /^\/api\/companion\/control\/commands\/([0-9a-f-]+)$/.exec(pathname);
      if (ack && req.method === 'DELETE') {
        if (!requireHost(req, res)) return;
        const before = commands.length;
        commands = commands.filter((command) => command.id !== ack[1]);
        sendJson(res, before === commands.length ? 404 : 200, {
          acknowledged: before !== commands.length,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(res, status, { error: status === 500 ? 'Companion control failed' : error.message });
    }
  };
}

/** Test hook: control-plane state is intentionally process-local. */
export function resetCompanionControlPlaneForTests() {
  hostState = null;
  commands = [];
}
