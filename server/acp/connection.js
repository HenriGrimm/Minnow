/** Minimal ACP v1 JSON-RPC stdio client with bounded buffers and process cleanup. */

import { spawn } from 'node:child_process';
import { killProcessTree, killProcessTreeAndWait } from '../terminal-runner.js';

export const ACP_PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function redact(text, values = []) {
  let safe = String(text ?? '');
  safe = safe.replace(/\b(?:bearer|token|api[_-]?key)\s*[=:]?\s*[^\s,"']+/gi, '[redacted]');
  for (const value of values) {
    if (typeof value === 'string' && value) safe = safe.split(value).join('[redacted]');
  }
  return safe;
}

function errorFromRpc(error, secretValues) {
  const message = redact(
    typeof error?.message === 'string' ? error.message : 'ACP request failed',
    secretValues,
  );
  const err = new Error(message);
  err.code = error?.code;
  return err;
}

export function spawnAcpConnection({ command, args, env, cwd, onNotification, onUnsupportedRequest }) {
  const secretValues = Object.values(env ?? {}).filter((value) => typeof value === 'string');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let stdoutBuffer = '';
  let stderrRaw = '';
  let closed = false;
  const pending = new Map();

  const failPending = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  const write = (message) => {
    if (closed || !child.stdin?.writable) throw new Error('ACP agent process is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const respondUnsupported = (message) => {
    const method = String(message.method ?? 'unknown');
    onUnsupportedRequest?.(method);
    if (message.id == null) return;
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `Minnow ACP client does not support agent request ${method}`,
      },
    });
  };

  const handleMessage = (message) => {
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(errorFromRpc(message.error, secretValues));
      else item.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string' && message.id == null) {
      onNotification?.(message.method, message.params ?? {});
      return;
    }
    if (typeof message.method === 'string') respondUnsupported(message);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
      const error = new Error('ACP agent emitted an oversized JSON-RPC message');
      failPending(error);
      void killProcessTreeAndWait(child, { graceMs: 250 });
      return;
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch {
        const error = new Error('ACP agent emitted invalid JSON-RPC');
        failPending(error);
        void killProcessTreeAndWait(child, { graceMs: 250 });
        return;
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    const longestSecret = Math.max(0, ...secretValues.map((value) => value.length));
    stderrRaw = `${stderrRaw}${chunk}`.slice(-(MAX_STDERR_BYTES + longestSecret));
  });
  child.stdin?.on('error', () => {
    // A process may close stdin between the writable check and write(). Pending
    // requests are rejected by the process close/error handlers below.
  });

  const done = new Promise((resolve) => {
    child.once('error', (error) => {
      closed = true;
      failPending(error);
      resolve({ code: 1, signal: null, stderr: redact(stderrRaw, secretValues).slice(-MAX_STDERR_BYTES), error });
    });
    child.once('close', (code, signal) => {
      closed = true;
      const stderr = redact(stderrRaw, secretValues).slice(-MAX_STDERR_BYTES);
      const error = new Error(
        `ACP agent exited before completing a request${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
      failPending(error);
      resolve({ code: code ?? 1, signal, stderr });
    });
  });

  const request = (method, params, timeoutMs = 15_000) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      write({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const item = pending.get(id);
      if (item) {
        pending.delete(id);
        clearTimeout(item.timer);
        item.reject(error);
      }
    }
    return promise;
  };

  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  const stop = (() => {
    let promise = null;
    return () => {
      promise ??= killProcessTreeAndWait(child, { graceMs: 750 });
      return promise;
    };
  })();

  return {
    child,
    request,
    notify,
    done,
    stop,
    getStderr: () => redact(stderrRaw, secretValues).slice(-MAX_STDERR_BYTES),
    killNow: () => killProcessTree(child),
  };
}

export async function initializeAcpConnection(connection) {
  const response = await connection.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      auth: { terminal: false },
    },
    clientInfo: { name: 'Minnow', version: '0.1.6' },
  });
  if (response?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ACP protocol version ${String(response?.protocolVersion ?? 'missing')}; Minnow supports v${ACP_PROTOCOL_VERSION}`,
    );
  }
  return response;
}

export const __acpConnectionInternals = { redact };
