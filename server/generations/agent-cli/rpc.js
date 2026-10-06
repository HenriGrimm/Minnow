import { spawn } from 'node:child_process';
import { createJsonlDecoder } from '../agent-cli/jsonl.js';
import { killProcessTreeAndWait } from '../../terminal-runner.js';

/** Bounded, bidirectional app-server transport. No inference or tool execution. */
export function createCliRpc(invocation, options = {}) {
  const rpcError = message => new Error(message.replaceAll('Codex', options.name ?? 'Codex'));
  const child = (options.spawn ?? spawn)(invocation.command,
    [...invocation.argsPrefix, ...(invocation.args ?? ['app-server', '--listen', 'stdio://'])], {
      cwd: invocation.cwd, env: invocation.env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
  const pending = new Map();
  const serverRequests = new Map();
  const listeners = new Set();
  const failureListeners = new Set();
  const writes = new Set();
  const maxPending = options.maxPending ?? 128;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  let nextId = 0;
  let failure;
  let closing;
  let queuedBytes = 0;
  let receivedBytes = 0;
  let serverRequestBytes = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function fail(error) {
    if (failure) return;
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    serverRequests.clear();
    serverRequestBytes = 0;
    for (const finish of writes) finish(error);
    for (const listener of failureListeners) { try { listener(error); } catch { /* observer */ } }
    queueMicrotask(() => { void close().catch(() => {}); });
  }
  function send(row) {
    if (failure) return Promise.reject(failure);
    let data;
    try { data = `${JSON.stringify(options.jsonrpc ? { jsonrpc: '2.0', ...row } : row)}\n`; }
    catch { return Promise.reject(rpcError('Codex RPC request is not JSON serializable.')); }
    const bytes = Buffer.byteLength(data);
    if (bytes > maxBytes || queuedBytes + bytes > maxBytes) {
      const error = rpcError('Codex RPC write queue exceeded its size limit.');
      fail(error);
      return Promise.reject(error);
    }
    queuedBytes += bytes;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        writes.delete(finish);
        queuedBytes -= bytes;
        if (error) { fail(error); reject(error); } else resolve();
      };
      writes.add(finish);
      try { child.stdin.write(data, finish); }
      catch (error) { finish(error); }
    });
  }
  const decoder = createJsonlDecoder({ maxLineBytes: maxBytes, onEvent: row => {
    if (failure) return;
    if (typeof row.method === 'string') {
      if (row.id != null) {
        if (typeof row.id !== 'string' && !(typeof row.id === 'number' && Number.isSafeInteger(row.id))) {
          throw rpcError('Codex returned an invalid RPC request ID.');
        }
        const key = JSON.stringify(row.id);
        const previous = serverRequests.get(key);
        if (previous) {
          if (JSON.stringify(previous.row) !== JSON.stringify(row)) throw rpcError('Codex reused a pending RPC request ID.');
          return;
        }
        if (serverRequests.size >= maxPending) throw rpcError('Codex RPC server request limit exceeded.');
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (serverRequestBytes + bytes > maxBytes) throw rpcError('Codex RPC server request queue exceeded its size limit.');
        serverRequestBytes += bytes;
        serverRequests.set(key, { row, bytes });
        if (!options.onRequest) {
          void respond(row.id, null, { code: -32601, message: 'Unsupported server request' }).catch(fail);
          return;
        }
        Promise.resolve(options.onRequest(row)).catch(fail);
      } else {
        for (const listener of listeners) listener(row);
      }
      return;
    }
    const entry = pending.get(row.id);
    if (!entry) return;
    if (row.error) entry.reject(rpcError(`Codex RPC ${entry.method} failed (${row.error.code ?? 'unknown'}).`));
    else if (Object.hasOwn(row, 'result')) entry.resolve(row.result);
    else throw rpcError('Codex RPC returned a malformed response.');
  } });
  child.stdout.on('data', chunk => {
    try {
      receivedBytes += chunk.length;
      if (options.maxTotalBytes && receivedBytes > options.maxTotalBytes) throw rpcError('Codex RPC output exceeded its size limit.');
      decoder.write(chunk);
    } catch (error) { fail(error); }
  });
  // stderr is never model activity and is not retained (it can contain secrets).
  child.stderr.on('data', () => {});
  child.stdin.on('error', fail);
  child.once('error', error => { fail(error); resolveClosed(); });
  child.once('close', () => {
    fail(rpcError('Codex app-server exited.'));
    resolveClosed();
  });
  function request(method, params = {}, { timeoutMs = 15_000, signal } = {}) {
    if (failure) return Promise.reject(failure);
    if (signal?.aborted) return Promise.reject(rpcError('Codex RPC request cancelled.'));
    if (pending.size >= maxPending) return Promise.reject(rpcError('Codex RPC pending request limit exceeded.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(id);
        fn(value);
      };
      const abort = () => finish(reject, rpcError('Codex RPC request cancelled.'));
      pending.set(id, { method, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      if (timeoutMs > 0) timer = setTimeout(() => finish(reject, rpcError(`Codex RPC ${method} timed out.`)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      void send({ id, method, params }).catch(error => finish(reject, error));
    });
  }
  async function respond(id, result, error) {
    const key = JSON.stringify(id);
    const entry = serverRequests.get(key);
    if (!entry || entry.answering) throw rpcError('Unknown or already answered Codex RPC request.');
    entry.answering = true;
    await send(error ? { id, error } : { id, result });
    if (serverRequests.get(key) === entry) {
      serverRequestBytes -= entry.bytes;
      serverRequests.delete(key);
    }
  }
  function close() {
    if (!closing) {
      closing = (async () => {
        if (!failure) fail(rpcError('Codex RPC closed.'));
        await killProcessTreeAndWait(child, { graceMs: 1500 });
        // A spawned process must close before its home can be removed. Spawn
        // failures resolve this too, even when no PID was assigned.
        let timer;
        try {
          await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => reject(rpcError('Codex app-server process did not close after termination.')), 2000);
          })]);
        } finally { clearTimeout(timer); }
      })();
    }
    return closing;
  }
  return {
    child, request, respond, close,
    notify: (method, params = {}) => send({ method, params }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onFailure(listener) { failureListeners.add(listener); return () => failureListeners.delete(listener); },
    async initialize({ experimentalApi = false, signal, timeoutMs } = {}) {
      const result = await request('initialize', { clientInfo: { name: 'minnow', version: '1' },
        capabilities: { experimentalApi } }, { signal, timeoutMs });
      await send({ method: 'initialized', params: {} });
      return result;
    },
    snapshot: () => ({ pending: pending.size, serverRequests: serverRequests.size, queuedBytes, failed: !!failure }),
  };
}
