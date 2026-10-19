/**
 * Supervises the built-in Tailscale node (the `minnow-tailnet` sidecar) and the
 * trusted loopback listener it proxies into.
 *
 * Protocol (see tools/minnow-tailnet/README.md):
 *   spawn: minnow-tailnet --state-dir <dir> --hostname <name> --target http://127.0.0.1:<port> [--funnel]
 *   env:   MINNOW_INGRESS_SECRET=<per-boot secret>  (never on argv)
 *   stdout: one JSON event per line — starting | needs-login | needs-approval | ready | error | stopped
 *   stdin:  {"cmd":"logout"}; EOF means shut down
 *   proxy:  every request carries X-Minnow-Ingress-Secret, X-Minnow-Ingress (funnel|tailnet),
 *           X-Forwarded-For, and for tailnet peers X-Minnow-Tailnet-User.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { setTailnetHostnames } from '../network/access.js';
import {
  setRequestClientAddress,
  setRequestIngress,
  setRequestRelayHeaders,
  tagServerIngress,
} from '../network/ingress.js';
import { attachMinnowWebSockets } from '../runtime/ws-attach.js';
import { getTailnetNodeName } from './host-name.js';
import { resolveSidecarBinary } from './sidecar-binary.js';

const SECRET_HEADER = 'x-minnow-ingress-secret';
const INGRESS_HEADER = 'x-minnow-ingress';
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 30_000];
const STABLE_AFTER_MS = 60_000;

/**
 * @typedef {{
 *   state: 'off' | 'unavailable' | 'starting' | 'needs-login' | 'needs-approval' | 'ready' | 'error',
 *   funnel?: boolean,
 *   authUrl?: string,
 *   feature?: 'https' | 'funnel' | 'device',
 *   url?: string,
 *   dnsName?: string,
 *   loginName?: string,
 *   tailnet?: string,
 *   code?: string,
 *   message?: string,
 * }} TailnetStatus
 */

/** @type {TailnetStatus} */
let status = { state: 'off' };
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
/** @type {http.Server | null} */
let trustedServer = null;
const trustedSockets = new Set();
let secret = '';
let wanted = false;
let funnel = true;
/** @type {import('node:http').RequestListener | null} */
let handler = null;
let restartAttempt = 0;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
/** @type {NodeJS.Timeout | null} */
let stableTimer = null;

export function tailnetStateDir() {
  return path.join(getMinnowHome(), 'tailnet');
}

export function getTailnetStatus() {
  return { ...status, ...(status.state !== 'off' && status.state !== 'unavailable' ? { funnel } : {}) };
}

/** @param {TailnetStatus} next */
function setStatus(next) {
  status = next;
  setTailnetHostnames(next.state === 'ready' && next.dnsName ? [next.dnsName] : []);
}

function secretMatches(value) {
  if (typeof value !== 'string' || !secret) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopbackPeer(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Validate a proxied request and record its ingress. Returns false (after
 * answering) when it did not come from our sidecar.
 * @param {http.IncomingMessage} req
 */
function admitProxiedRequest(req) {
  if (!isLoopbackPeer(req.socket?.remoteAddress ?? '') || !secretMatches(req.headers[SECRET_HEADER])) return false;
  const kind = req.headers[INGRESS_HEADER] === 'tailnet' ? 'tailnet' : 'funnel';
  setRequestIngress(req, kind);
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  if (forwarded) setRequestClientAddress(req, forwarded);
  // Server-side loops (the stream tunnel) re-enter this listener; give them the proof.
  setRequestRelayHeaders(req, { [SECRET_HEADER]: secret, [INGRESS_HEADER]: kind });
  delete req.headers[SECRET_HEADER];
  return true;
}

async function startTrustedListener() {
  if (trustedServer) return /** @type {import('node:net').AddressInfo} */ (trustedServer.address()).port;
  const upgradeHub = new EventEmitter();
  attachMinnowWebSockets(upgradeHub);
  const server = http.createServer((req, res) => {
    if (!admitProxiedRequest(req)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    /** @type {import('node:http').RequestListener} */ (handler)(req, res);
  });
  tagServerIngress(server, 'funnel');
  server.on('connection', (socket) => {
    trustedSockets.add(socket);
    socket.once('close', () => trustedSockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!admitProxiedRequest(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    upgradeHub.emit('upgrade', req, socket, head);
  });
  server.once('close', () => upgradeHub.emit('close'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  trustedServer = server;
  return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
}

async function stopTrustedListener() {
  const server = trustedServer;
  trustedServer = null;
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve(undefined));
    server.closeAllConnections?.();
    for (const socket of trustedSockets) socket.destroy();
    trustedSockets.clear();
  });
}

/** @param {Record<string, unknown>} event */
function handleEvent(event) {
  switch (event.event) {
    case 'starting':
      if (status.state !== 'ready') setStatus({ state: 'starting' });
      break;
    case 'needs-login':
      setStatus({ state: 'needs-login', authUrl: String(event.authUrl ?? '') });
      break;
    case 'needs-approval':
      setStatus({
        state: 'needs-approval',
        feature: event.feature === 'funnel' || event.feature === 'device' ? event.feature : 'https',
        url: String(event.url ?? ''),
        ...(typeof event.loginName === 'string' && event.loginName ? { loginName: event.loginName } : {}),
      });
      break;
    case 'ready': {
      const dnsName = String(event.dnsName ?? '').replace(/\.$/, '');
      setStatus({
        state: 'ready',
        dnsName,
        url: typeof event.url === 'string' && event.url ? event.url : `https://${dnsName}/`,
        loginName: typeof event.loginName === 'string' ? event.loginName : undefined,
        tailnet: typeof event.tailnet === 'string' ? event.tailnet : undefined,
      });
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { restartAttempt = 0; }, STABLE_AFTER_MS);
      stableTimer.unref?.();
      break;
    }
    case 'error':
      setStatus({
        state: 'error',
        code: String(event.code ?? 'error'),
        message: String(event.message ?? 'Tailscale reported an error.'),
      });
      break;
    default:
      break;
  }
}

function spawnSidecar(port) {
  const binary = resolveSidecarBinary();
  if (!binary) {
    setStatus({ state: 'unavailable' });
    return;
  }
  const stateDir = tailnetStateDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const args = [
    ...binary.args,
    '--state-dir', stateDir,
    '--hostname', getTailnetNodeName(),
    '--target', `http://127.0.0.1:${port}`,
    ...(funnel ? ['--funnel'] : []),
  ];
  const proc = spawn(binary.command, args, {
    env: { ...process.env, MINNOW_INGRESS_SECRET: secret },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = proc;
  setStatus({ state: 'starting' });
  let buffered = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        if (child === proc) handleEvent(JSON.parse(line));
      } catch {
        /* Not a protocol line. */
      }
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk) => {
    if (process.env.MINNOW_DEBUG === '1') process.stderr.write(`[tailnet] ${chunk}`);
  });
  proc.once('error', (err) => {
    if (child !== proc) return;
    setStatus({ state: 'error', code: 'spawn-failed', message: err.message });
  });
  proc.once('exit', () => {
    if (child !== proc) return;
    child = null;
    if (!wanted) return;
    const delay = RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    restartAttempt += 1;
    if (status.state === 'ready' || status.state === 'starting') {
      setStatus({ state: 'error', code: 'helper-exited', message: 'Reconnecting to Tailscale…' });
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted && trustedServer) spawnSidecar(/** @type {import('node:net').AddressInfo} */ (trustedServer.address()).port);
    }, delay);
    restartTimer.unref?.();
  });
}

/**
 * @param {{ requestHandler: import('node:http').RequestListener, funnel?: boolean }} opts
 */
export async function startTailnet(opts) {
  if (wanted && child && funnel === (opts.funnel !== false)) return getTailnetStatus();
  await stopTailnet();
  if (!resolveSidecarBinary()) {
    setStatus({ state: 'unavailable' });
    return getTailnetStatus();
  }
  wanted = true;
  funnel = opts.funnel !== false;
  handler = opts.requestHandler;
  secret = crypto.randomBytes(32).toString('base64url');
  const port = await startTrustedListener();
  spawnSidecar(port);
  return getTailnetStatus();
}

/** @param {import('node:child_process').ChildProcess} proc */
function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(undefined);
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export async function stopTailnet() {
  wanted = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  child = null;
  if (proc) {
    // Closing stdin asks the helper to shut down cleanly.
    try { proc.stdin?.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    await waitForExit(proc, 3_000);
  }
  await stopTrustedListener();
  secret = '';
  setStatus({ state: resolveSidecarBinary() ? 'off' : 'unavailable' });
}

/** Sign out of Tailscale and delete the node identity. */
export async function logoutTailnet() {
  const proc = child;
  wanted = false;
  if (proc?.stdin && !proc.stdin.destroyed) {
    proc.stdin.write(`${JSON.stringify({ cmd: 'logout' })}\n`);
    await waitForExit(proc, 5_000);
  }
  await stopTailnet();
  fs.rmSync(tailnetStateDir(), { recursive: true, force: true });
}

/** Reset module state (tests only). */
export function resetTailnetState() {
  status = { state: 'off' };
  restartAttempt = 0;
}
