/** ACP agent validation and one-prompt run lifecycle. */

import { randomUUID } from 'node:crypto';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { getAcpAgentRuntime, recordAcpValidation } from './store.js';
import { initializeAcpConnection, spawnAcpConnection } from './connection.js';

const runs = new Map();
const MAX_EVENTS = 2_000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_RUN_EVENT_BYTES = 2 * 1024 * 1024;
const RUN_TTL_MS = 10 * 60_000;

function redactText(value, secrets) {
  let output = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) output = output.split(secret).join('[redacted]');
  }
  return output.replace(/((?:bearer|token|api[_-]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function redactValue(value, secrets, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactValue(entry, secrets, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) => [
    key,
    redactValue(entry, secrets, depth + 1),
  ]));
}

function sanitizeAgentInfo(value, secrets = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    name: redactText(value.name, secrets).slice(0, 200),
    version: redactText(value.version, secrets).slice(0, 100),
  };
}

function publicCapabilities(response) {
  const caps = response?.agentCapabilities ?? {};
  return {
    textPrompt: true,
    imagePrompt: caps.promptCapabilities?.image === true,
    audioPrompt: caps.promptCapabilities?.audio === true,
    embeddedContext: caps.promptCapabilities?.embeddedContext === true,
    loadSession: caps.loadSession === true,
    sessionList: Boolean(caps.sessionCapabilities?.list),
    sessionResume: Boolean(caps.sessionCapabilities?.resume),
    sessionClose: Boolean(caps.sessionCapabilities?.close),
  };
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveRunWorkspace(workspaceRoot) {
  const requested = String(workspaceRoot ?? '').trim();
  if (!requested) return getEffectiveWorkspaceRoot();
  return validateAllowedWorkspaceRoot(requested);
}

function connect(runtime, cwd, handlers = {}) {
  return spawnAcpConnection({
    command: runtime.profile.command,
    args: runtime.profile.args,
    env: runtime.secrets.env,
    cwd,
    ...handlers,
  });
}

export async function validateAcpAgent(id, workspaceRoot) {
  const runtime = await getAcpAgentRuntime(id);
  const cwd = await resolveRunWorkspace(workspaceRoot);
  const connection = connect(runtime, cwd);
  try {
    const response = await initializeAcpConnection(connection);
    const validation = {
      ok: true,
      protocolVersion: response.protocolVersion,
      capabilities: publicCapabilities(response),
      agentInfo: sanitizeAgentInfo(response.agentInfo, Object.values(runtime.secrets.env)),
      authMethods: Array.isArray(response.authMethods)
        ? response.authMethods.slice(0, 50).map((method) => ({
            id: redactText(method?.id, Object.values(runtime.secrets.env)).slice(0, 160),
            name: redactText(method?.name ?? method?.id, Object.values(runtime.secrets.env)).slice(0, 200),
          })).filter((method) => method.id)
        : [],
    };
    await recordAcpValidation(id, validation);
    return validation;
  } catch (error) {
    const validation = { ok: false, error: safeError(error) };
    await recordAcpValidation(id, validation).catch(() => {});
    return validation;
  } finally {
    await connection.stop().catch(() => {});
  }
}

function appendEvent(run, event) {
  let safeEvent = event;
  let serialized = JSON.stringify(safeEvent);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
    safeEvent = event.type === 'message' || event.type === 'thought'
      ? { ...event, text: String(event.text ?? '').slice(0, MAX_EVENT_BYTES / 4), truncated: true }
      : { type: event.type ?? 'update', message: 'ACP update omitted because it exceeded the payload limit', truncated: true };
    serialized = JSON.stringify(safeEvent);
  }
  const next = { seq: run.nextSeq++, at: new Date().toISOString(), ...safeEvent };
  const bytes = Buffer.byteLength(serialized, 'utf8');
  run.events.push(next);
  run.eventBytes += bytes;
  while (run.events.length > MAX_EVENTS || run.eventBytes > MAX_RUN_EVENT_BYTES) {
    const removed = run.events.shift();
    if (!removed) break;
    const { seq: _seq, at: _at, ...payload } = removed;
    run.eventBytes -= Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }
  run.updatedAt = next.at;
  return next;
}

function updateToEvent(params, secrets = []) {
  const update = params?.update;
  if (!update || typeof update !== 'object') return null;
  const kind = String(update.sessionUpdate ?? 'unknown');
  const content = update.content;
  if (
    (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') &&
    content?.type === 'text' &&
    typeof content.text === 'string'
  ) {
    return {
      type: kind === 'agent_message_chunk' ? 'message' : 'thought',
      text: redactText(content.text, secrets),
    };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return {
      type: 'tool',
      toolCallId: redactText(update.toolCallId, secrets).slice(0, 200),
      title: redactText(update.title ?? update.name ?? 'Agent tool', secrets).slice(0, 500),
      status: String(update.status ?? (kind === 'tool_call' ? 'pending' : 'in_progress')),
    };
  }
  if (kind === 'plan') {
    const entries = Array.isArray(update.entries)
      ? update.entries.slice(0, 100).map((entry) => redactValue(entry, secrets))
      : [];
    return { type: 'plan', entries };
  }
  return { type: 'update', update: kind };
}

async function executeRun(run, runtime, cwd, prompt) {
  const secretValues = Object.values(runtime.secrets.env);
  const connection = connect(runtime, cwd, {
    onNotification(method, params) {
      if (method !== 'session/update' || params?.sessionId !== run.sessionId) return;
      const event = updateToEvent(params, secretValues);
      if (event) appendEvent(run, event);
    },
    onUnsupportedRequest(method) {
      appendEvent(run, {
        type: 'unsupported',
        message: `Agent requested unsupported client capability: ${method}`,
      });
    },
  });
  run.connection = connection;
  try {
    appendEvent(run, { type: 'status', status: 'initializing' });
    const initialized = await initializeAcpConnection(connection);
    if (run.cancelRequested) throw new Error('ACP run cancelled');
    run.capabilities = publicCapabilities(initialized);
    run.agentInfo = sanitizeAgentInfo(initialized.agentInfo, secretValues);
    appendEvent(run, { type: 'status', status: 'starting-session' });
    const session = await connection.request('session/new', { cwd, mcpServers: [] });
    if (run.cancelRequested) throw new Error('ACP run cancelled');
    if (typeof session?.sessionId !== 'string' || !session.sessionId.trim()) {
      throw new Error('ACP agent returned no session id');
    }
    run.sessionId = session.sessionId;
    run.status = 'running';
    appendEvent(run, { type: 'status', status: 'running' });
    const response = await connection.request(
      'session/prompt',
      { sessionId: run.sessionId, prompt: [{ type: 'text', text: prompt }] },
      10 * 60_000,
    );
    if (run.cancelRequested) {
      run.status = 'cancelled';
      appendEvent(run, { type: 'status', status: 'cancelled' });
    } else {
      run.status = 'completed';
      run.stopReason = String(response?.stopReason ?? 'end_turn');
      appendEvent(run, {
        type: 'complete',
        status: 'completed',
        stopReason: run.stopReason,
      });
    }
  } catch (error) {
    if (run.cancelRequested) {
      run.status = 'cancelled';
      appendEvent(run, { type: 'status', status: 'cancelled' });
    } else {
      run.status = 'failed';
      run.error = safeError(error);
      appendEvent(run, { type: 'error', message: run.error });
    }
  } finally {
    await connection.stop().catch(() => {});
    run.connection = null;
    run.finishedAt = new Date().toISOString();
    run.expireTimer = setTimeout(() => runs.delete(run.id), RUN_TTL_MS);
    run.expireTimer.unref?.();
  }
}

export async function startAcpRun(id, input) {
  const runtime = await getAcpAgentRuntime(id);
  if (runtime.profile.enabled === false) throw new Error('ACP agent is disabled');
  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt || prompt.length > 200_000) throw new Error('Prompt is required');
  const cwd = await resolveRunWorkspace(input?.workspaceRoot);
  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    agentId: runtime.profile.id,
    agentLabel: runtime.profile.label,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    sessionId: null,
    capabilities: null,
    agentInfo: null,
    stopReason: null,
    error: null,
    cancelRequested: false,
    nextSeq: 1,
    eventBytes: 0,
    events: [],
    connection: null,
    expireTimer: null,
  };
  runs.set(run.id, run);
  void executeRun(run, runtime, cwd, prompt);
  return getAcpRun(run.id);
}

export function getAcpRun(runId, since = 0) {
  const run = runs.get(String(runId));
  if (!run) return null;
  return {
    id: run.id,
    agentId: run.agentId,
    agentLabel: run.agentLabel,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    sessionId: run.sessionId,
    capabilities: run.capabilities,
    agentInfo: run.agentInfo,
    stopReason: run.stopReason,
    error: run.error,
    events: run.events.filter((event) => event.seq > Number(since || 0)),
  };
}

export async function cancelAcpRun(runId) {
  const run = runs.get(String(runId));
  if (!run) return false;
  if (run.finishedAt) return true;
  run.cancelRequested = true;
  run.status = 'cancelling';
  appendEvent(run, { type: 'status', status: 'cancelling' });
  if (run.connection && run.sessionId) {
    try {
      run.connection.notify('session/cancel', { sessionId: run.sessionId });
    } catch {}
    setTimeout(() => {
      if (!run.finishedAt) void run.connection?.stop().catch(() => {});
    }, 500).unref?.();
  } else {
    await run.connection?.stop().catch(() => {});
  }
  return true;
}

export async function shutdownAllAcpRuns() {
  const stopping = [];
  for (const run of runs.values()) {
    if (run.expireTimer) clearTimeout(run.expireTimer);
    if (run.connection) stopping.push(run.connection.stop().catch(() => {}));
  }
  await Promise.allSettled(stopping);
  runs.clear();
}

export const __acpRuntimeInternals = { publicCapabilities, updateToEvent };
