/** Minimal project-scoped Debug Adapter Protocol client for Godot 4. */

import net from 'node:net';
import path from 'node:path';
import { startGodotEditor } from './controller.js';
import { resolveGodotProject } from './project.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_EVENTS = 200;
const clients = new Map();

class DapClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.events = [];
    this.closed = false;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.close(err));
    socket.on('close', () => this.close(new Error('Godot debugger disconnected')));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.close(new Error('Invalid DAP frame')); return; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message;
      try { message = JSON.parse(body); } catch { this.close(new Error('Invalid DAP JSON')); return; }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success === false) pending.reject(new Error(message.message || `${message.command} failed`));
      else pending.resolve(message.body ?? {});
      return;
    }
    if (message.type === 'event') {
      this.events.push({ at: new Date().toISOString(), event: message.event, body: message.body ?? {} });
      if (this.events.length > MAX_EVENTS) this.events.shift();
    }
  }

  request(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('Godot debugger is not connected'));
    const seq = this.sequence++;
    const message = { seq, type: 'request', command, arguments: args };
    const body = JSON.stringify(message);
    this.socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Godot DAP ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
    });
  }

  close(reason = new Error('Godot debugger closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.socket.destroy();
  }
}

function connectSocket(port, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) reject(err);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function sourcePath(projectRoot, requested) {
  const normalized = String(requested ?? '').replace(/^res:\/\//, '').replace(/\\/g, '/');
  const absolute = path.resolve(projectRoot, normalized);
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..') ||
      !isResolvedPathUnderRoot(absolute, projectRoot)) {
    throw Object.assign(new Error('Debug source must be project-relative or res://'), { statusCode: 400 });
  }
  return absolute;
}

async function selectedProject(workspaceRoot, project) {
  const selected = await resolveGodotProject(workspaceRoot, project);
  if (selected.status !== 'selected') {
    throw Object.assign(new Error(`Godot project unavailable: ${selected.status}`), { statusCode: 409 });
  }
  return selected.project;
}

export async function startGodotDebug(workspaceRoot, options = {}) {
  const started = await startGodotEditor(workspaceRoot, { project: options.project });
  const project = started.project;
  const key = path.resolve(project.root);
  clients.get(key)?.close();
  const socket = await connectSocket(started.session.dap.port);
  const client = new DapClient(socket);
  clients.set(key, client);
  const capabilities = await client.request('initialize', {
    clientID: 'minnow', clientName: 'Minnow', adapterID: 'godot',
    pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
    supportsVariableType: true, supportsVariablePaging: true,
    supportsRunInTerminalRequest: false,
  });
  let scene = String(options.scene ?? 'main');
  if (!['main', 'current', 'pinned'].includes(scene)) {
    const absoluteScene = sourcePath(project.root, scene);
    const extension = path.extname(absoluteScene).toLowerCase();
    if (!['.tscn', '.scn', '.gd'].includes(extension)) {
      throw Object.assign(new Error('Debug scene must be a project .tscn, .scn, or .gd file'), { statusCode: 400 });
    }
    scene = `res://${path.relative(project.root, absoluteScene).replace(/\\/g, '/')}`;
  }
  const launch = await client.request('launch', {
    project: project.root,
    address: '127.0.0.1',
    port: started.session.dap.port,
    scene,
    profiling: options.profiling === true,
    additional_options: String(options.additionalOptions ?? ''),
  });
  if (Array.isArray(options.breakpoints) && options.path) {
    await setGodotBreakpoints(workspaceRoot, options);
  }
  await client.request('configurationDone', {}).catch((err) => {
    if (!/not supported/i.test(err.message)) throw err;
  });
  return { project, capabilities, launch, dap: started.session.dap };
}

function getClient(projectRoot) {
  const client = clients.get(path.resolve(projectRoot));
  if (!client || client.closed) throw Object.assign(new Error('No active Godot debug session'), { statusCode: 409 });
  return client;
}

export async function setGodotBreakpoints(workspaceRoot, options = {}) {
  const project = await selectedProject(workspaceRoot, options.project);
  const client = getClient(project.root);
  const source = sourcePath(project.root, options.path);
  const lines = Array.isArray(options.lines) ? options.lines : options.breakpoints;
  const breakpoints = (lines ?? []).map((line) => ({ line: Math.max(1, Number(line) || 1) }));
  return client.request('setBreakpoints', { source: { path: source }, breakpoints, sourceModified: false });
}

export async function godotDebugRequest(workspaceRoot, options = {}) {
  const project = await selectedProject(workspaceRoot, options.project);
  const client = getClient(project.root);
  const action = String(options.action ?? 'events');
  if (action === 'events') return { project, events: client.events.slice(-Math.min(200, Number(options.limit) || 50)) };
  if (action === 'stop') {
    const body = await client.request('disconnect', { terminateDebuggee: true }).catch(() => ({}));
    client.close();
    clients.delete(path.resolve(project.root));
    return { project, body };
  }
  if (action === 'breakpoints') return setGodotBreakpoints(workspaceRoot, options);
  const threadId = Number(options.threadId) || 1;
  if (action === 'threads') return client.request('threads');
  if (action === 'stack') return client.request('stackTrace', { threadId, startFrame: Number(options.startFrame) || 0, levels: Number(options.levels) || 50 });
  if (action === 'scopes') return client.request('scopes', { frameId: Number(options.frameId) });
  if (action === 'variables') return client.request('variables', { variablesReference: Number(options.variablesReference), start: Number(options.start) || 0, count: Number(options.count) || 200 });
  if (action === 'evaluate') return client.request('evaluate', { expression: String(options.expression ?? ''), frameId: options.frameId == null ? undefined : Number(options.frameId), context: 'repl' });
  if (action === 'continue') return client.request('continue', { threadId });
  if (action === 'pause') return client.request('pause', { threadId });
  if (action === 'next') return client.request('next', { threadId });
  if (action === 'step_in') return client.request('stepIn', { threadId });
  if (action === 'step_out') return client.request('stepOut', { threadId });
  throw Object.assign(new Error(`Unsupported Godot debug action: ${action}`), { statusCode: 400 });
}

export function resetGodotDebugForTest() {
  for (const client of clients.values()) client.close();
  clients.clear();
}

export function getGodotDebugStatus(projectRoot) {
  if (!projectRoot) return { active: false, events: [] };
  const client = clients.get(path.resolve(projectRoot));
  return {
    active: Boolean(client && !client.closed),
    events: client?.events.slice(-20) ?? [],
  };
}
