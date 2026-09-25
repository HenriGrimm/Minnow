/** Project-scoped Godot editor, LSP, and game-process lifecycle. */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { findGodotExecutable, probeGodotExecutable } from './engine.js';
import { readGodotProjectInfo, resolveGodotProject } from './project.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

const MAX_LOG_LINES = 500;
const START_TIMEOUT_MS = 20_000;
let controllerTestHooks = null;

/** @type {Map<string, object>} */
const sessions = new Map();

function appendLog(session, source, chunk) {
  const text = String(chunk ?? '');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    session.logs.push({ at: new Date().toISOString(), source, line });
  }
  if (session.logs.length > MAX_LOG_LINES) {
    session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  }
}

function publicProcess(child) {
  if (!child) return null;
  return { pid: child.pid ?? null, running: child.exitCode == null && !child.killed };
}

function publicSession(session) {
  if (!session) return null;
  return {
    projectRoot: session.projectRoot,
    editor: publicProcess(session.editor),
    game: publicProcess(session.game),
    lsp: session.lspPort ? { host: '127.0.0.1', port: session.lspPort } : null,
    dap: session.dapPort ? { host: '127.0.0.1', port: session.dapPort } : null,
    startedAt: session.startedAt ?? null,
  };
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function waitForPort(port, child, timeoutMs = START_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (err) => {
      if (timer) clearTimeout(timer);
      child?.off?.('exit', onExit);
      if (err) reject(err); else resolve();
    };
    const onExit = (code) => finish(new Error(`Godot exited before LSP became ready (code ${code})`));
    child?.once?.('exit', onExit);
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        finish();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          finish(new Error(`Timed out waiting for Godot LSP on 127.0.0.1:${port}`));
          return;
        }
        timer = setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function spawnGodot(executable, args, projectRoot, session, source) {
  const spawnImpl = controllerTestHooks?.spawn ?? spawn;
  const child = spawnImpl(executable, args, {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout?.on('data', (chunk) => appendLog(session, source, chunk));
  child.stderr?.on('data', (chunk) => appendLog(session, `${source}:stderr`, chunk));
  child.once('error', (err) => appendLog(session, `${source}:error`, err.message));
  return child;
}

async function resolveReadyProject(workspaceRoot, requestedProject) {
  const selected = await resolveGodotProject(workspaceRoot, requestedProject);
  if (selected.status !== 'selected') {
    throw Object.assign(new Error(
      selected.status === 'select-project'
        ? 'Multiple Godot projects found; specify project'
        : `Godot project unavailable: ${selected.status}`,
    ), { statusCode: selected.status === 'invalid-selection' ? 400 : 409, details: selected });
  }
  const engine = await (controllerTestHooks?.findExecutable ?? findGodotExecutable)();
  if (!engine.path) {
    throw Object.assign(new Error('Godot executable not found; install the managed runtime with godot_control install_engine'), {
      statusCode: 409,
    });
  }
  const probe = await (controllerTestHooks?.probeExecutable ?? probeGodotExecutable)(engine.path);
  if (!probe.ok) throw Object.assign(new Error(probe.error), { statusCode: 409 });
  return { selected, engine: { ...engine, ...probe } };
}

function getOrCreateSession(projectRoot) {
  const key = path.resolve(projectRoot);
  let session = sessions.get(key);
  if (!session) {
    session = { projectRoot: key, logs: [], editor: null, game: null, lspPort: null, dapPort: null };
    sessions.set(key, session);
  }
  return session;
}

export async function startGodotEditor(workspaceRoot, options = {}) {
  const { selected, engine } = await resolveReadyProject(workspaceRoot, options.project);
  const session = getOrCreateSession(selected.project.root);
  if (session.editor && session.editor.exitCode == null && !session.editor.killed) {
    if (options.waitForLsp !== false && session.lspPort) {
      await waitForPort(session.lspPort, session.editor);
    }
    return { project: selected.project, engine, session: publicSession(session), reused: true };
  }
  session.lspPort = Number(options.lspPort || process.env.MINNOW_GODOT_LSP_PORT) || await reservePort();
  session.dapPort = Number(options.dapPort || process.env.MINNOW_GODOT_DAP_PORT) || await reservePort();
  const args = [
    '--editor', '--path', selected.project.root,
    '--lsp-port', String(session.lspPort), '--dap-port', String(session.dapPort),
  ];
  session.editor = spawnGodot(engine.path, args, selected.project.root, session, 'editor');
  session.startedAt = new Date().toISOString();
  session.editor.once('exit', () => { session.editor = null; });
  if (options.waitForLsp !== false) await waitForPort(session.lspPort, session.editor);
  return { project: selected.project, engine, session: publicSession(session), reused: false };
}

export async function connectGodotLsp(workspaceRoot, options = {}) {
  const started = await startGodotEditor(workspaceRoot, { ...options, waitForLsp: true });
  const port = started.session.lsp.port;
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection({ host: '127.0.0.1', port });
    candidate.once('connect', () => resolve(candidate));
    candidate.once('error', reject);
  });
  return { socket, projectRoot: started.project.root, endpoint: { host: '127.0.0.1', port } };
}

function resolveProjectFile(projectRoot, requested, extensions) {
  if (!requested) return null;
  const normalized = String(requested).replace(/^res:\/\//, '').replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw Object.assign(new Error('Path must be project-relative or res://'), { statusCode: 400 });
  }
  const absolute = path.resolve(projectRoot, normalized);
  if (!isResolvedPathUnderRoot(absolute, projectRoot)) {
    throw Object.assign(new Error('Path is outside the Godot project'), { statusCode: 400 });
  }
  if (extensions && !extensions.includes(path.extname(absolute).toLowerCase())) {
    throw Object.assign(new Error(`Expected ${extensions.join(' or ')} file`), { statusCode: 400 });
  }
  return { absolute, relative: normalized };
}

export async function runGodotScene(workspaceRoot, options = {}) {
  const { selected, engine } = await resolveReadyProject(workspaceRoot, options.project);
  const session = getOrCreateSession(selected.project.root);
  if (session.game && session.game.exitCode == null && !session.game.killed) {
    if (options.restart) await stopGodot(workspaceRoot, { project: options.project, target: 'game' });
    else throw Object.assign(new Error('A Godot game is already running for this project'), { statusCode: 409 });
  }
  const scene = resolveProjectFile(selected.project.root, options.scene, ['.tscn', '.scn']);
  if (scene) await fs.access(scene.absolute);
  const args = ['--path', selected.project.root];
  if (options.headless) args.push('--headless');
  if (scene) args.push('--scene', `res://${scene.relative}`);
  if (Array.isArray(options.args) && options.args.length > 0) {
    args.push('--', ...options.args.map(String));
  }
  session.game = spawnGodot(engine.path, args, selected.project.root, session, 'game');
  session.game.once('exit', () => { session.game = null; });
  return { project: selected.project, scene: scene?.relative ?? null, session: publicSession(session) };
}

export async function stopGodot(workspaceRoot, options = {}) {
  const selected = await resolveGodotProject(workspaceRoot, options.project);
  if (selected.status !== 'selected') throw Object.assign(new Error(`Godot project unavailable: ${selected.status}`), { statusCode: 409 });
  const session = sessions.get(path.resolve(selected.project.root));
  if (!session) return { project: selected.project, stopped: [] };
  const target = options.target ?? 'game';
  const stopped = [];
  for (const name of target === 'all' ? ['game', 'editor'] : [target]) {
    const child = session[name];
    if (child && child.exitCode == null && !child.killed) {
      child.kill();
      stopped.push(name);
    }
    session[name] = null;
  }
  return { project: selected.project, stopped, session: publicSession(session) };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Godot command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

export async function validateGodotProject(workspaceRoot, options = {}) {
  const { selected, engine } = await resolveReadyProject(workspaceRoot, options.project);
  const session = getOrCreateSession(selected.project.root);
  const script = resolveProjectFile(selected.project.root, options.path, ['.gd']);
  if (script) await fs.access(script.absolute);
  const args = script
    ? ['--headless', '--path', selected.project.root, '--script', script.absolute, '--check-only']
    : ['--headless', '--editor', '--path', selected.project.root, '--quit-after', '1'];
  const child = spawnGodot(engine.path, args, selected.project.root, session, 'validate');
  const result = await waitForExit(child, Number(options.timeoutMs) || 60_000);
  return {
    ok: result.code === 0,
    exitCode: result.code,
    signal: result.signal,
    project: selected.project,
    path: script?.relative ?? null,
    logs: session.logs.slice(-200),
  };
}

export async function runGodotTask(workspaceRoot, options = {}) {
  const { selected, engine } = await resolveReadyProject(workspaceRoot, options.project);
  const session = getOrCreateSession(selected.project.root);
  const action = String(options.action ?? 'import');
  let args;
  if (action === 'import') {
    args = ['--headless', '--path', selected.project.root, '--import', '--quit'];
  } else if (action === 'test') {
    const script = resolveProjectFile(selected.project.root, options.script, ['.gd']);
    if (!script) throw Object.assign(new Error('test requires a project-relative GDScript runner'), { statusCode: 400 });
    await fs.access(script.absolute);
    args = ['--headless', '--path', selected.project.root, '--script', script.absolute];
    if (Array.isArray(options.args) && options.args.length > 0) {
      args.push('--', ...options.args.map(String));
    }
  } else if (action === 'export') {
    const preset = String(options.preset ?? '').trim();
    if (!preset) throw Object.assign(new Error('export requires a preset name'), { statusCode: 400 });
    const output = resolveProjectFile(selected.project.root, options.output);
    if (!output) throw Object.assign(new Error('export requires a project-relative output path'), { statusCode: 400 });
    await fs.mkdir(path.dirname(output.absolute), { recursive: true });
    args = [
      '--headless', '--path', selected.project.root,
      options.release === false ? '--export-debug' : '--export-release',
      preset, output.absolute,
    ];
  } else {
    throw Object.assign(new Error(`Unsupported Godot task: ${action}`), { statusCode: 400 });
  }
  const child = spawnGodot(engine.path, args, selected.project.root, session, action);
  const result = await waitForExit(child, Number(options.timeoutMs) || 120_000);
  return {
    ok: result.code === 0,
    action,
    exitCode: result.code,
    signal: result.signal,
    project: selected.project,
    logs: session.logs.slice(-300),
  };
}

export async function getGodotStatus(workspaceRoot, options = {}) {
  const selected = await resolveGodotProject(workspaceRoot, options.project);
  if (selected.status !== 'selected') return selected;
  const engine = await (controllerTestHooks?.findExecutable ?? findGodotExecutable)();
  const probe = engine.path
    ? await (controllerTestHooks?.probeExecutable ?? probeGodotExecutable)(engine.path)
    : null;
  const info = await readGodotProjectInfo(selected.project.root);
  return {
    ...selected,
    projectInfo: info,
    engine: probe ? { ...engine, ...probe } : engine,
    session: publicSession(sessions.get(path.resolve(selected.project.root))),
  };
}

export async function getGodotLogs(workspaceRoot, options = {}) {
  const selected = await resolveGodotProject(workspaceRoot, options.project);
  if (selected.status !== 'selected') throw Object.assign(new Error(`Godot project unavailable: ${selected.status}`), { statusCode: 409 });
  const session = sessions.get(path.resolve(selected.project.root));
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
  return { project: selected.project, logs: session?.logs.slice(-limit) ?? [] };
}

export function resetGodotSessionsForTest() {
  for (const session of sessions.values()) {
    session.game?.kill?.();
    session.editor?.kill?.();
  }
  sessions.clear();
  controllerTestHooks = null;
}

export function setGodotControllerHooksForTest(hooks) {
  controllerTestHooks = hooks;
}
