import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from './config/home.js';
import {
  appendTerminalRun,
  readTerminalHistory,
  useJsonSessionsStore,
} from './config/sessions-repo.js';
import { readConfigJson, updateConfigJson } from './config/store.js';
import { validateSessionState } from './config/validators.js';
import {
  COMMAND_TIMEOUT_MS,
  formatProcessOutput,
  runProcess,
} from './process-runner.js';
import { resolveOneShotSpawn } from './terminal/one-shot-spawn.js';
import { describeShellProfileRuntime } from './terminal/shell-profiles.js';
import {
  applyAgentShellSandbox,
  formatPreferEscalationError,
  formatRequireSandboxError,
} from './terminal/sandbox/index.js';
import { resolveShellSandboxForRun } from './terminal/sandbox/resolve-for-run.js';
import { appendSandboxTrailer } from './terminal/sandbox/signals.js';
import {
  isPidAlive,
  listOrphanedRuns,
  readRunIndexEntry,
  recordRunStart,
  updateRunIndexEntry,
} from './terminal/run-index.js';
import { getEffectiveWorkspaceRoot } from './runtime/path-access.js';

export const MAX_TERMINAL_BUFFER_BYTES = 2 * 1024 * 1024;

const MAX_TERMINAL_HISTORY = 50;

const RUN_EVICTION_MS = 60_000;

const STOP_SETTLE_TIMEOUT_MS = 3_000;

/** @typedef {'user' | 'agent'} TerminalSource */

/**
 * @typedef {object} TerminalRunRecord
 * @property {string} id
 * @property {string} command
 * @property {string} cwd
 * @property {TerminalSource} source
 * @property {string} [toolCallId]
 * @property {number} startedAt
 * @property {number} finishedAt
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} logPath
 */

/**
 * @typedef {object} RunState
 * @property {string} runId
 * @property {string} command
 * @property {string} cwd
 * @property {TerminalSource} source
 * @property {string} [chatId]
 * @property {string} [toolCallId]
 * @property {number} startedAt
 * @property {import('node:child_process').ChildProcess | null} child
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} bufferBytes
 * @property {boolean} truncated
 * @property {boolean} timedOut
 * @property {boolean} stoppedByUser
 * @property {number | undefined} timeoutMs
 * @property {number | null} exitCode
 * @property {boolean} finished
 * @property {string} logPath
 * @property {string} logRelPath
 * @property {Set<(event: object) => void>} listeners
 * @property {Promise<string>} completion
 * @property {(value: string) => void} resolveCompletion
 * @property {import('./terminal/sandbox/index.js').SandboxMeta | null | undefined} [sandbox]
 * @property {{ headLines?: number, tailLines?: number } | undefined} [outputSlice]
 */

/** @type {Map<string, RunState>} */
const activeRuns = new Map();

// ── Log buffer ───────────────────────────────────────────────────────────────

function terminalLogDir() {
  return path.join(getMinnowHome(), 'logs', 'terminal');
}

function relativeLogPath(runId) {
  return `logs/terminal/${runId}.log`;
}

function appendBuffer(state, stream, text) {
  if (!text) return;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (state.bufferBytes + bytes > MAX_TERMINAL_BUFFER_BYTES) {
    if (!state.truncated) {
      const marker = '\n…[truncated]\n';
      if (stream === 'stdout') state.stdout += marker;
      else state.stderr += marker;
      state.bufferBytes += Buffer.byteLength(marker, 'utf8');
      state.truncated = true;
    }
    return;
  }
  state.bufferBytes += bytes;
  if (stream === 'stdout') state.stdout += text;
  else state.stderr += text;
}

function emit(state, event) {
  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch {
    }
  }
}

/**
 * Merge Git Bash MSYS keys (and any other one-shot env) with caller overrides.
 * Undefined means inherit process.env unchanged.
 * @param {NodeJS.ProcessEnv | Record<string, string> | undefined} spawnEnv
 * @param {Record<string, string> | undefined} envOverrides
 * @returns {NodeJS.ProcessEnv | undefined}
 */
function mergeRunSpawnEnv(spawnEnv, envOverrides) {
  const fromSpawn =
    spawnEnv && typeof spawnEnv === 'object' ? spawnEnv : null;
  const fromCaller =
    envOverrides && typeof envOverrides === 'object' ? envOverrides : null;
  if (!fromSpawn && !fromCaller) return undefined;
  return { ...process.env, ...fromSpawn, ...fromCaller };
}

/** @type {Map<string, Promise<void>>} */
const logWriteQueues = new Map();


async function appendLogFile(logPath, text) {
  if (!text) return;
  const prev = logWriteQueues.get(logPath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, text, 'utf8');
  }).catch(() => {
  }).finally(() => {
    if (logWriteQueues.get(logPath) === next) {
      logWriteQueues.delete(logPath);
    }
  });
  logWriteQueues.set(logPath, next);
  return next;
}

/**
 * @param {string} logPath
 */
async function ensureLogFile(logPath) {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, '', 'utf8');
  } catch {
  }
}

/**
 * @param {string} chatId
 * @param {TerminalRunRecord} record
 */
async function persistTerminalHistory(chatId, record) {
  if (!chatId) return;

  try {
    if (!useJsonSessionsStore()) {
      appendTerminalRun(chatId, record);
      return;
    }

    await updateConfigJson('sessions/state.json', (raw) => {
      const base = raw ?? { version: 3, chats: [] };
      let state;
      try {
        state = validateSessionState(base);
      } catch {
        return base;
      }

      const chat = state.chats.find((c) => c.id === chatId);
      if (!chat) return state;

      const history = Array.isArray(chat.terminalHistory) ? [...chat.terminalHistory] : [];
      history.push(record);
      while (history.length > MAX_TERMINAL_HISTORY) {
        history.shift();
      }
      chat.terminalHistory = history;
      chat.updatedAt = Date.now();
      return state;
    });
  } catch (err) {
    console.warn('[terminal-runner] persistTerminalHistory failed:', err);
  }
}

// ── Create run ───────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.command
 * @param {string[]} [params.args]
 * @param {string} params.cwd
 * @param {boolean} [params.shell]
 * @param {TerminalSource} [params.source]
 * @param {string} [params.chatId]
 * @param {string} [params.toolCallId]
 * @param {number} [params.timeoutMs]
 * @param {Record<string, string>} [params.env]
 * @param {import('./terminal/shell-profiles.js').ShellProfile | null} [params.shellProfile]
 * @param {boolean} [params.sandbox]
 * @param {'off'|'prefer'|'require'} [params.shellSandboxMode]
 * @param {boolean} [params.allowUnsandboxed]
 * @param {string} [params.worktreeRoot]
 * @param {{ headLines?: number, tailLines?: number }} [params.outputSlice]
 * @returns {Promise<{ runId: string, startedAt: number }>}
 */
export async function createRun({
  command,
  args = [],
  cwd,
  shell = false,
  source = 'agent',
  chatId,
  toolCallId,
  timeoutMs,
  env: envOverrides,
  shellProfile = null,
  sandbox,
  shellSandboxMode,
  allowUnsandboxed,
  worktreeRoot,
  outputSlice,
}) {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const logPath = path.join(terminalLogDir(), `${runId}.log`);
  const relLog = relativeLogPath(runId);

  /** @type {(value: string) => void} */
  let resolveCompletion = () => {};
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  const clampedTimeout =
    timeoutMs != null
      ? Math.max(1000, Math.min(600_000, timeoutMs))
      : COMMAND_TIMEOUT_MS;

  /** @type {RunState} */
  const state = {
    runId,
    command,
    cwd,
    source,
    chatId,
    toolCallId,
    startedAt,
    child: null,
    stdout: '',
    stderr: '',
    bufferBytes: 0,
    truncated: false,
    timedOut: false,
    stoppedByUser: false,
    timeoutMs: clampedTimeout,
    exitCode: null,
    finished: false,
    logPath,
    logRelPath: relLog,
    listeners: new Set(),
    completion,
    resolveCompletion,
    sandbox: null,
    outputSlice,
  };

  activeRuns.set(runId, state);

  await ensureLogFile(logPath);
  await recordRunStart({
    runId,
    command,
    cwd,
    source,
    ...(chatId ? { chatId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    background: false,
    logPath,
    logRelPath: relLog,
    startedAt,
  });

  emit(state, { type: 'meta', runId, command, cwd });

  const runChild = async () => {
    try {
      const resolvedMode = await resolveShellSandboxForRun({
        chatId,
        modeOverride: shellSandboxMode,
        allowUnsandboxed,
      });

      const resolved = resolveOneShotSpawn({
        command,
        args,
        shell,
        shellProfile,
        cwd,
      });
      const spawnTarget = applyAgentShellSandbox(resolved, {
        source,
        sandbox,
        mode: resolvedMode.mode,
        allowUnsandboxed: resolvedMode.allowUnsandboxed,
        cwd,
        workspaceRoot: getEffectiveWorkspaceRoot(),
        worktreeRoot,
        runtime: describeShellProfileRuntime(shellProfile).runtime,
      });
      state.sandbox = spawnTarget.sandbox ?? null;
      emit(state, {
        type: 'meta',
        runId,
        command,
        cwd,
        sandbox: state.sandbox,
      });

      if (spawnTarget.sandbox?.blocked) {
        const message = formatRequireSandboxError(spawnTarget.sandbox.detail);
        state.exitCode = 1;
        state._sandboxBlockMessage = message;
        emit(state, { type: 'error', message });
        await appendLogFile(logPath, `\n${message}\n`);
        return;
      }

      if (spawnTarget.sandbox?.needsEscalation) {
        const message = formatPreferEscalationError(spawnTarget.sandbox.detail);
        state.exitCode = 1;
        state._sandboxBlockMessage = message;
        emit(state, { type: 'error', message });
        await appendLogFile(logPath, `\n${message}\n`);
        return;
      }

      const result = await runProcess(spawnTarget.command, spawnTarget.args, {
        cwd: spawnTarget.cwd ?? cwd,
        timeout: clampedTimeout,
        shell: spawnTarget.shell,
        killTree: killProcessTree,
        env: mergeRunSpawnEnv(spawnTarget.env, envOverrides),
        onSpawn: (child) => {
          state.child = child;
          if (child.pid) void updateRunIndexEntry(runId, { pid: child.pid });
          if (state.stoppedByUser) killProcessTree(child);
        },
        onStdout: (text) => {
          appendBuffer(state, 'stdout', text);
          emit(state, { type: 'stdout', text });
          void appendLogFile(logPath, text);
        },
        onStderr: (text) => {
          appendBuffer(state, 'stderr', text);
          emit(state, { type: 'stderr', text });
          void appendLogFile(logPath, text);
        },
      });

      state.exitCode = result.code;
      state.timedOut = result.timedOut;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('timed out')) {
        state.timedOut = true;
        state.exitCode = null;
      } else {
        state.exitCode = 1;
        emit(state, { type: 'error', message });
        await appendLogFile(logPath, `\nError: ${message}\n`);
      }
    } finally {
      await finishRun(runId);
    }
  };

  void runChild();

  return { runId, startedAt, logPath: relLog };
}

// ── Background ───────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.command
 * @param {string[]} [params.args]
 * @param {string} params.cwd
 * @param {TerminalSource} [params.source]
 * @param {string} [params.chatId]
 * @param {string} [params.toolCallId]
 * @param {boolean} [params.shell]
 * @param {string} [params.logSubdir]
 * @param {Record<string, string>} [params.env]
 * @param {import('./terminal/shell-profiles.js').ShellProfile | null} [params.shellProfile]
 * @param {boolean} [params.sandbox]
 * @param {'off'|'prefer'|'require'} [params.shellSandboxMode]
 * @param {boolean} [params.allowUnsandboxed]
 * @param {string} [params.worktreeRoot]
 * @returns {Promise<{ runId: string, startedAt: number, logPath: string, pid: number | null }>}
 */
export async function createBackgroundRun({
  command,
  args = [],
  cwd,
  shell = false,
  source = 'agent',
  chatId,
  toolCallId,
  logSubdir = 'terminal',
  env: envOverrides,
  shellProfile = null,
  sandbox,
  shellSandboxMode,
  allowUnsandboxed,
  worktreeRoot,
}) {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const logDir = path.join(getMinnowHome(), 'logs', logSubdir);
  const logPath = path.join(logDir, `${runId}.log`);
  const relLog = `logs/${logSubdir}/${runId}.log`;

  /** @type {(value: string) => void} */
  let resolveCompletion = () => {};
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  /** @type {RunState} */
  const state = {
    runId,
    command,
    cwd,
    source,
    chatId,
    toolCallId,
    startedAt,
    child: null,
    stdout: '',
    stderr: '',
    bufferBytes: 0,
    truncated: false,
    timedOut: false,
    stoppedByUser: false,
    timeoutMs: undefined,
    exitCode: null,
    finished: false,
    logPath,
    logRelPath: relLog,
    listeners: new Set(),
    completion,
    resolveCompletion,
    sandbox: null,
  };

  activeRuns.set(runId, state);
  await ensureLogFile(logPath);

  const resolvedMode = await resolveShellSandboxForRun({
    chatId,
    modeOverride: shellSandboxMode,
    allowUnsandboxed,
  });

  const resolved = resolveOneShotSpawn({
    command,
    args,
    shell,
    shellProfile,
    cwd,
  });
  const spawnTarget = applyAgentShellSandbox(resolved, {
    source,
    sandbox,
    mode: resolvedMode.mode,
    allowUnsandboxed: resolvedMode.allowUnsandboxed,
    cwd,
    workspaceRoot: getEffectiveWorkspaceRoot(),
    worktreeRoot,
    runtime: describeShellProfileRuntime(shellProfile).runtime,
  });
  state.sandbox = spawnTarget.sandbox ?? null;
  emit(state, { type: 'meta', runId, command, cwd, sandbox: state.sandbox });

  if (spawnTarget.sandbox?.blocked || spawnTarget.sandbox?.needsEscalation) {
    const message = spawnTarget.sandbox.blocked
      ? formatRequireSandboxError(spawnTarget.sandbox.detail)
      : formatPreferEscalationError(spawnTarget.sandbox.detail);
    state.exitCode = 1;
    state._sandboxBlockMessage = message;
    emit(state, { type: 'error', message });
    await appendLogFile(logPath, `\n${message}\n`);
    await finishRun(runId);
    return { runId, startedAt, logPath: relLog, pid: null };
  }

  const execCommand = spawnTarget.command;
  const execArgs = spawnTarget.args;
  const useShell = spawnTarget.shell;
  const spawnCwd = spawnTarget.cwd ?? cwd;

  const mergedEnv = mergeRunSpawnEnv(spawnTarget.env, envOverrides);
  const childEnv = mergedEnv ?? process.env;

  const child = spawn(execCommand, execArgs, {
    cwd: spawnCwd,
    env: childEnv,
    shell: useShell,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  state.child = child;
  child.unref();

  const indexed = recordRunStart({
    runId,
    command,
    cwd,
    source,
    ...(chatId ? { chatId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    pid: child.pid ?? null,
    background: true,
    logPath,
    logRelPath: relLog,
    startedAt,
  });

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    appendBuffer(state, 'stdout', text);
    emit(state, { type: 'stdout', text });
    void appendLogFile(logPath, text);
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    appendBuffer(state, 'stderr', text);
    emit(state, { type: 'stderr', text });
    void appendLogFile(logPath, text);
  });

  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    emit(state, { type: 'error', message });
    void appendLogFile(logPath, `\nError: ${message}\n`);
    state.exitCode = 1;
    void finishRun(runId);
  });

  child.on('close', (code) => {
    state.exitCode = code;
    void finishRun(runId);
  });

  await indexed;

  return { runId, startedAt, logPath: relLog, pid: child.pid ?? null };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * @param {string} runId
 */
export async function finishRun(runId) {
  const state = activeRuns.get(runId);
  if (!state || state.finished) return;

  state.finished = true;
  const finishedAt = Date.now();

  emit(state, {
    type: 'exit',
    code: state.exitCode,
    timedOut: state.timedOut,
    stopped: state.stoppedByUser,
  });

  const formatted = state._sandboxBlockMessage
    ? String(state._sandboxBlockMessage)
    : appendSandboxTrailer(
        formatProcessOutput(state.command, {
          code: state.exitCode ?? 1,
          stdout: state.stdout,
          stderr: state.stderr,
          timedOut: state.timedOut,
          stopped: state.stoppedByUser,
          timeoutSecs: state.timeoutMs ? state.timeoutMs / 1000 : undefined,
          outputSlice: state.outputSlice,
        }),
        state.sandbox,
      );
  state.resolveCompletion(formatted);

  const record = {
    id: runId,
    command: state.command,
    cwd: state.cwd,
    source: state.source,
    ...(state.toolCallId ? { toolCallId: state.toolCallId } : {}),
    startedAt: state.startedAt,
    finishedAt,
    exitCode: state.exitCode,
    timedOut: state.timedOut,
    logPath: state.logRelPath ?? relativeLogPath(runId),
  };

  await updateRunIndexEntry(runId, {
    finished: true,
    finishedAt,
    exitCode: state.exitCode,
    timedOut: state.timedOut,
    stopped: state.stoppedByUser,
    truncated: state.truncated,
  });

  if (state.chatId) {
    await persistTerminalHistory(state.chatId, record);
  }

  setTimeout(() => {
    activeRuns.delete(runId);
  }, RUN_EVICTION_MS);
}

/**
 * @param {string} runId
 * @returns {RunState | undefined}
 */
export function getRun(runId) {
  return activeRuns.get(runId);
}

/**
 * @param {string} runId
 */
export function __evictForTests(runId) {
  return activeRuns.delete(runId);
}

/**
 * @param {string} runId
 * @returns {Promise<string>}
 */
export function waitForRun(runId) {
  const state = activeRuns.get(runId);
  if (!state) {
    return Promise.reject(new Error('Unknown run'));
  }
  return state.completion;
}

/**
 * @param {string} runId
 * @param {(event: object) => void} listener
 * @returns {() => void}
 */
export function subscribeRun(runId, listener) {
  const state = activeRuns.get(runId);
  if (!state) return () => {};

  state.listeners.add(listener);
  listener({
    type: 'meta',
    runId: state.runId,
    command: state.command,
    cwd: state.cwd,
  });

  if (state.stdout) {
    listener({ type: 'stdout', text: state.stdout });
  }
  if (state.stderr) {
    listener({ type: 'stderr', text: state.stderr });
  }

  if (state.finished) {
    listener({
      type: 'exit',
      code: state.exitCode,
      timedOut: state.timedOut,
      stopped: state.stoppedByUser,
    });
  }

  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * @param {string} runId
 */
export function cancelRun(runId) {
  const state = activeRuns.get(runId);
  if (!state || state.finished || !state.child) return false;
  state.stoppedByUser = true;
  killProcessTree(state.child);
  return true;
}

/**
 * @param {string} runId
 * @returns {Promise<{ ok: boolean, runId: string, alreadyStopped?: boolean, orphaned?: boolean, pid?: number | null, error?: string }>}
 */
export async function stopActiveRun(runId) {
  const state = activeRuns.get(runId);
  if (!state) {
    const indexed = await readRunIndexEntry(runId);
    if (indexed && !indexed.finished && isPidAlive(indexed.pid)) {
      return {
        ok: false,
        runId,
        orphaned: true,
        pid: indexed.pid,
        error:
          `run ${runId} was started by a previous server process (pid ${indexed.pid}); ` +
          'it is still alive but cannot be stopped from here — stop it by pid',
      };
    }
    if (indexed?.finished) {
      return { ok: true, runId, alreadyStopped: true };
    }
    return { ok: false, runId, error: `unknown run_id ${runId}` };
  }
  if (state.finished) {
    const settled = await waitForCompletionWithin(state.completion, STOP_SETTLE_TIMEOUT_MS);
    return settled
      ? { ok: true, runId, alreadyStopped: true }
      : { ok: false, runId, error: `run ${runId} finished but completion did not settle` };
  }
  state.stoppedByUser = true;
  if (state.child) {
    await killProcessTreeAndWait(state.child);
  } else {
    killLiveRun(state);
  }

  const settled = await waitForCompletionWithin(state.completion, STOP_SETTLE_TIMEOUT_MS);
  if (!settled) {
    const pid = state.child?.pid ?? null;
    return {
      ok: false,
      runId,
      pid,
      error:
        pid == null
          ? `run ${runId} cancellation is pending; startup did not settle`
          : isPidAlive(pid)
            ? `failed to stop run ${runId}; process ${pid} is still alive`
            : `run ${runId} exited but completion did not settle`,
    };
  }
  return { ok: true, runId };
}

/**
 * @param {Promise<unknown>} completion
 * @param {number} timeoutMs
 */
async function waitForCompletionWithin(completion, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {RunState} state
 */
function killLiveRun(state) {
  state.stoppedByUser = true;
  if (state.child) {
    killProcessTree(state.child);
  } else {
    cancelRun(state.runId);
  }
}

/**
 * @param {string} chatId
 * @returns {{ ok: boolean, stopped: number }}
 */
export function stopActiveRunsForChat(chatId) {
  const trimmed = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmed) return { ok: false, stopped: 0 };
  let stopped = 0;
  for (const state of activeRuns.values()) {
    if (state.finished || state.chatId !== trimmed) continue;
    killLiveRun(state);
    stopped += 1;
  }
  return { ok: true, stopped };
}

/**
 * @param {{ source?: TerminalSource, chatId?: string }} [filter]
 */
export function listActiveRuns(filter = {}) {
  /** @type {Array<{ runId: string, command: string, cwd: string, pid: number | null, startedAt: number, chatId?: string, source: TerminalSource }>} */
  const rows = [];
  for (const state of activeRuns.values()) {
    if (state.finished) continue;
    if (filter.source && state.source !== filter.source) continue;
    if (filter.chatId && state.chatId !== filter.chatId) continue;
    rows.push({
      runId: state.runId,
      command: state.command,
      cwd: state.cwd,
      pid: state.child?.pid ?? null,
      startedAt: state.startedAt,
      source: state.source,
      ...(state.chatId ? { chatId: state.chatId } : {}),
    });
  }
  return rows;
}

/**
 * @param {{ source?: TerminalSource, chatId?: string }} [filter]
 */
export async function listKnownActiveRuns(filter = {}) {
  const rows = listActiveRuns(filter);
  const seen = new Set(rows.map((r) => r.runId));

  let entries = [];
  try {
    entries = await listOrphanedRuns();
  } catch {
    return rows;
  }

  for (const entry of entries) {
    if (seen.has(entry.runId)) continue;
    if (filter.source && entry.source !== filter.source) continue;
    if (filter.chatId && entry.chatId !== filter.chatId) continue;
    rows.push({
      runId: entry.runId,
      command: entry.command,
      cwd: entry.cwd,
      pid: entry.pid ?? null,
      startedAt: entry.startedAt,
      source: entry.source,
      ...(entry.chatId ? { chatId: entry.chatId } : {}),
      orphaned: true,
    });
  }
  return rows;
}

function formatRunOutputTail(state) {
  let out = `${state.stdout}${state.stderr}`;
  if (state.truncated && !out.includes('…[truncated]')) {
    out += '\n…[truncated]\n';
  }
  return out;
}

/**
 * @param {string} runId
 * @param {number} maxMs
 * @returns {Promise<string>}
 */
export function waitForRunOutput(runId, maxMs) {
  const state = activeRuns.get(runId);
  if (!state) {
    return Promise.reject(new Error('Unknown run'));
  }
  const clamped = Math.max(0, Math.min(maxMs, 120_000));
  if (clamped === 0) {
    return Promise.resolve(formatRunOutputTail(state));
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + clamped;
    const finish = () => resolve(formatRunOutputTail(state));
    let timer = null;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (timer) clearInterval(timer);
      unsubscribe();
    };
    unsubscribe = subscribeRun(runId, (event) => {
      if (event.type === 'exit' || event.type === 'error') {
        cleanup();
        finish();
      }
    });
    timer = setInterval(() => {
      if (state.finished || Date.now() >= deadline) {
        cleanup();
        finish();
      }
    }, 50);
  });
}

/**
 * @param {string} runId
 * @param {number} [maxBytes]
 */
export async function readCommandLogSnapshot(runId, maxBytes = 64 * 1024) {
  const state = activeRuns.get(runId);
  const indexed = state ? null : await readRunIndexEntry(runId);
  const logPath =
    state?.logPath ?? indexed?.logPath ?? path.join(terminalLogDir(), `${runId}.log`);
  const fileTail = await readLogTailAt(logPath, maxBytes);
  const memory = state ? formatRunOutputTail(state) : '';
  const output = memory.length >= (fileTail?.length ?? 0) ? memory : (fileTail ?? memory);

  if (!state && !indexed) {
    return {
      runId,
      found: false,
      output: output ?? '',
      finished: true,
      exitCode: null,
      timedOut: false,
      truncated: false,
      error: `unknown run_id ${runId} — it was never started here, or its record aged out`,
    };
  }

  const source = state ?? indexed;
  const running = state ? !state.finished : !indexed.finished;
  return {
    runId,
    found: true,
    output: output ?? '',
    command: source.command,
    cwd: source.cwd,
    startedAt: source.startedAt,
    finished: !running,
    exitCode: source.exitCode ?? null,
    timedOut: source.timedOut ?? false,
    truncated: state?.truncated ?? indexed?.truncated ?? false,
    logPath: state?.logRelPath ?? indexed?.logRelPath ?? relativeLogPath(runId),
    ...(indexed?.finishedAt ? { finishedAt: indexed.finishedAt } : {}),
    ...(indexed?.orphaned ? { orphaned: true, pid: indexed.pid } : {}),
    ...(indexed?.endedReason ? { endedReason: indexed.endedReason } : {}),
  };
}

function logKillDebug(entry) {
  try {
    const dir = path.join(getMinnowHome(), 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'kill-debug.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
      'utf8',
    );
  } catch {
  }
}

/** @type {Set<number> | null} */
let cachedAncestorPids = null;
/** @type {Promise<void> | null} */
let ancestorWarmupPromise = null;

/**
 * Parse PowerShell CIM CSV into pid→ppid and walk from process.pid.
 * @param {string} stdout
 * @param {Set<number>} ancestors
 */
function fillAncestorsFromCsv(stdout, ancestors) {
  /** @type {Map<number, number>} */
  const parentOf = new Map();
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const m = line.match(/^"?(\d+)"?,"?(\d+)"?/);
    if (m) parentOf.set(Number(m[1]), Number(m[2]));
  }
  let cur = process.pid;
  for (let i = 0; i < 64; i++) {
    const parent = parentOf.get(cur);
    if (parent == null || parent === 0 || ancestors.has(parent)) break;
    ancestors.add(parent);
    cur = parent;
  }
}

/**
 * Fill the rest of the Windows ancestor set without blocking the event loop.
 * Mutates {@link cachedAncestorPids} in place so callers already holding the Set see new pids.
 */
function warmupWindowsAncestorPids() {
  if (process.platform !== 'win32') return Promise.resolve();
  if (ancestorWarmupPromise) return ancestorWarmupPromise;
  ancestorWarmupPromise = new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        const ancestors = cachedAncestorPids ?? new Set([process.pid]);
        cachedAncestorPids = ancestors;
        if (!err && stdout) {
          try {
            fillAncestorsFromCsv(stdout, ancestors);
          } catch {
            if (typeof process.ppid === 'number') ancestors.add(process.ppid);
          }
        } else if (typeof process.ppid === 'number') {
          ancestors.add(process.ppid);
        }
        resolve();
      },
    );
    child.on('error', () => resolve());
  });
  return ancestorWarmupPromise;
}

/**
 * @returns {Set<number>}
 */
function selfAncestorPids() {
  if (cachedAncestorPids) return cachedAncestorPids;
  const ancestors = new Set([process.pid]);
  cachedAncestorPids = ancestors;
  if (typeof process.ppid === 'number') ancestors.add(process.ppid);
  if (process.platform === 'win32') {
    void warmupWindowsAncestorPids();
  }
  return ancestors;
}

/** Idle warmup so the first shell tool does not stall the server event loop (MIN-584). */
export function warmupTerminalPlatformCaches() {
  if (process.platform !== 'win32') return Promise.resolve();
  return Promise.all([
    warmupWindowsAncestorPids(),
    import('./terminal/shell-profiles.js').then((m) => m.warmupWslShellProfiles()),
  ]);
}

// ── Kill tree ────────────────────────────────────────────────────────────────

/**
 * @param {import('node:child_process').ChildProcess | { pid: number }} child
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  const targetPid = child.pid;

  const ancestors = selfAncestorPids();
  if (ancestors.has(targetPid)) {
    logKillDebug({
      kind: 'kill-refused-ancestor',
      targetPid,
      ancestors: [...ancestors],
    });
    try {
      if (typeof child.kill === 'function') child.kill('SIGTERM');
      else process.kill(targetPid, 'SIGTERM');
    } catch {
    }
    return;
  }

  logKillDebug({ kind: 'kill', targetPid, parentPid: process.ppid });

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(targetPid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          if (typeof child.kill === 'function') child.kill('SIGTERM');
          else process.kill(targetPid, 'SIGTERM');
        } catch {
        }
      });
      killer.unref();
    } catch {
      try {
        if (typeof child.kill === 'function') child.kill('SIGTERM');
        else process.kill(targetPid, 'SIGTERM');
      } catch {
      }
    }
    return;
  }
  try {
    process.kill(-targetPid, 'SIGTERM');
  } catch {
    try {
      if (typeof child.kill === 'function') child.kill('SIGTERM');
      else process.kill(targetPid, 'SIGTERM');
    } catch {
    }
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
function waitForChildExit(child, timeoutMs) {
  if (!child) return Promise.resolve();
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.removeListener('exit', done);
      child.removeListener('close', done);
      clearTimeout(timer);
    };
    child.on('exit', done);
    child.on('close', done);
    const timer = setTimeout(done, timeoutMs);
  });
}

/**
 * @param {import('node:child_process').ChildProcess | { pid: number }} child
 * @param {{ graceMs?: number }} [opts]
 */
export async function killProcessTreeAndWait(child, opts = {}) {
  const graceMs = opts.graceMs ?? 3000;
  if (!child?.pid) return;
  if (child.exitCode != null || child.signalCode != null) return;

  killProcessTree(child);

  const hasExitEvents = typeof child.on === 'function';
  if (!hasExitEvents) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isPidAlive(child.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!isPidAlive(child.pid)) return;
    if (process.platform === 'win32') {
      killProcessTree(child);
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    return;
  }

  await waitForChildExit(child, graceMs);

  if (child.exitCode == null && child.signalCode == null && child.pid) {
    if (process.platform === 'win32') {
      killProcessTree(child);
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
        }
      }
    }
    await waitForChildExit(child, 1500);
  }
}

// ── History ──────────────────────────────────────────────────────────────────

/**
 * @param {string} chatId
 * @returns {Promise<TerminalRunRecord[]>}
 */
export async function getTerminalHistoryForChat(chatId) {
  if (!useJsonSessionsStore()) {
    return /** @type {TerminalRunRecord[]} */ (readTerminalHistory(chatId));
  }

  const raw = (await readConfigJson('sessions/state.json')) ?? { version: 3, chats: [] };
  let state;
  try {
    state = validateSessionState(raw);
  } catch {
    return [];
  }
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || !Array.isArray(chat.terminalHistory)) return [];
  return chat.terminalHistory;
}

/**
 * @param {string} runId
 * @returns {Promise<string | null>}
 */
export async function readRunLogTail(runId, maxBytes = 64 * 1024) {
  const state = activeRuns.get(runId);
  const indexed = state ? null : await readRunIndexEntry(runId);
  const logPath =
    state?.logPath ?? indexed?.logPath ?? path.join(terminalLogDir(), `${runId}.log`);
  return readLogTailAt(logPath, maxBytes);
}

/**
 * @param {string} logPath
 * @param {number} maxBytes
 * @returns {Promise<string | null>}
 */
async function readLogTailAt(logPath, maxBytes) {
  try {
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * @param {object} params
 * @param {string} params.command
 * @param {string} params.cwd
 * @param {string} [params.chatId]
 * @param {string} [params.toolCallId]
 * @param {number} [params.timeoutMs]
 * @param {Record<string, string>} [params.env]
 * @param {import('./terminal/shell-profiles.js').ShellProfile | null} [params.shellProfile]
 * @param {boolean} [params.allowUnsandboxed]
 * @param {string} [params.worktreeRoot]
 */
export async function executeCommandBlocking({
  command,
  args = [],
  cwd,
  shell,
  chatId,
  toolCallId,
  timeoutMs,
  env,
  shellProfile = null,
  allowUnsandboxed,
  worktreeRoot,
  sandbox,
  shellSandboxMode,
  outputSlice,
}) {
  const { runId } = await createRun({
    command,
    args,
    cwd,
    shell,
    source: 'agent',
    chatId,
    toolCallId,
    timeoutMs,
    env,
    shellProfile,
    allowUnsandboxed,
    worktreeRoot,
    sandbox,
    shellSandboxMode,
    outputSlice,
  });
  return waitForRun(runId);
}
