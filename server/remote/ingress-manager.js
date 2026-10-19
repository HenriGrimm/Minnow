/**
 * Starts and stops the remote listeners at runtime — no restart. The desktop
 * listener is always loopback; phones arrive on:
 *   - the home-network listener (`lan`, fixed port, never drifts), and
 *   - the trusted tailnet listener fed by the built-in Tailscale sidecar.
 */

import { getBonjourHostname, setActiveNetworkAccess } from '../network/access.js';
import { createIngressServer } from '../network/ingress.js';
import { listLanAddresses } from '../system/network.js';
import { attachMinnowWebSockets } from '../runtime/ws-attach.js';
import {
  envForcesLan,
  readRemoteConfig,
  resolveLanPort,
  writeRemoteConfig,
} from './config.js';
import {
  getTailnetStatus,
  logoutTailnet,
  startTailnet,
  stopTailnet,
} from './tailnet.js';

/** @type {import('node:http').RequestListener | null} */
let requestHandler = null;

/**
 * @type {{
 *   server: import('node:http').Server | null,
 *   sockets: Set<import('node:net').Socket>,
 *   state: 'off' | 'starting' | 'on' | 'error',
 *   port: number,
 *   error: { code: string, message: string } | null,
 * }}
 */
const lan = { server: null, sockets: new Set(), state: 'off', port: 0, error: null };

/**
 * Give the manager the app's request handler (packaged: the connect app; dev:
 * Vite's middlewares, which include the SPA and every /api route).
 * @param {{ requestHandler: import('node:http').RequestListener }} opts
 */
export function configureRemoteIngress(opts) {
  requestHandler = opts.requestHandler;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Bind the home-network listener. Dual-stack first (iOS resolves `.local`
 * names to IPv6 link-local addresses too), IPv4 when IPv6 is unavailable. The
 * port never changes: a phone's sign-in belongs to its exact address.
 * @param {{ port: number }} opts
 */
export async function startLanIngress({ port }) {
  if (lan.server && lan.port === port && lan.state === 'on') return getLanStatus();
  await stopLanIngress();
  if (!requestHandler) {
    lan.state = 'error';
    lan.error = { code: 'not-configured', message: 'Remote access is not available in this process.' };
    return getLanStatus();
  }
  lan.state = 'starting';
  lan.port = port;
  lan.error = null;
  for (const host of ['::', '0.0.0.0']) {
    const server = createIngressServer('lan', requestHandler);
    server.on('connection', (socket) => {
      lan.sockets.add(socket);
      socket.once('close', () => lan.sockets.delete(socket));
    });
    attachMinnowWebSockets(server);
    try {
      await listen(server, port, host);
      lan.server = server;
      lan.state = 'on';
      setActiveNetworkAccess('lan');
      return getLanStatus();
    } catch (err) {
      server.close();
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === 'EADDRINUSE') {
        lan.state = 'error';
        lan.error = { code: 'port-in-use', message: `Port ${port} is already in use by another program.` };
        return getLanStatus();
      }
      if (host === '::' && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) continue;
      lan.state = 'error';
      lan.error = { code: 'listen-failed', message: String(/** @type {Error} */ (err)?.message ?? err) };
      return getLanStatus();
    }
  }
  return getLanStatus();
}

export async function stopLanIngress() {
  setActiveNetworkAccess('local');
  const server = lan.server;
  lan.server = null;
  lan.state = 'off';
  lan.error = null;
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve(undefined));
    server.closeAllConnections?.();
    for (const socket of lan.sockets) socket.destroy();
    lan.sockets.clear();
  });
}

/** Addresses a phone can use, best first: the Bonjour name on macOS, then IPs. */
export function lanUrls(port) {
  const urls = [];
  const bonjour = getBonjourHostname();
  if (bonjour) urls.push(`http://${bonjour}:${port}/`);
  for (const address of listLanAddresses()) urls.push(`http://${address}:${port}/`);
  return urls;
}

export function getLanStatus() {
  return {
    state: lan.state,
    port: lan.port,
    urls: lan.state === 'on' ? lanUrls(lan.port) : [],
    ...(lan.error ? { error: lan.error } : {}),
  };
}

export function getRemoteStatus() {
  return { lan: getLanStatus(), anywhere: getTailnetStatus() };
}

/**
 * Where a new QR should point, best first. Anywhere wins when ready: it also
 * works at home, so each phone keeps a single address.
 * @returns {{ kind: 'anywhere' | 'lan', url: string }[]}
 */
export function getConnectTargets() {
  const targets = [];
  const anywhere = getTailnetStatus();
  if (anywhere.state === 'ready' && anywhere.url) targets.push({ kind: 'anywhere', url: anywhere.url });
  for (const url of getLanStatus().urls) targets.push({ kind: 'lan', url });
  return /** @type {{ kind: 'anywhere' | 'lan', url: string }[]} */ (targets);
}

/** @param {boolean} enabled */
export async function setLanEnabled(enabled) {
  const config = await writeRemoteConfig({ lan: { enabled } });
  if (enabled) await startLanIngress({ port: resolveLanPort(config) });
  else await stopLanIngress();
  return getRemoteStatus();
}

/**
 * @param {boolean} enabled
 * @param {{ funnel?: boolean }} [opts]
 */
export async function setAnywhereEnabled(enabled, opts = {}) {
  const config = await writeRemoteConfig({
    anywhere: { enabled, ...(typeof opts.funnel === 'boolean' ? { funnel: opts.funnel } : {}) },
  });
  if (enabled && requestHandler) await startTailnet({ requestHandler, funnel: config.anywhere.funnel });
  else await stopTailnet();
  return getRemoteStatus();
}

/** Sign the built-in node out of Tailscale and forget it. */
export async function logoutAnywhere() {
  await writeRemoteConfig({ anywhere: { enabled: false } });
  await logoutTailnet();
  return getRemoteStatus();
}

/** Start whatever the saved settings (or `MINNOW_NETWORK=lan`) ask for. */
export async function applyRemoteConfigAtBoot() {
  const config = await readRemoteConfig();
  const results = [];
  if (config.lan.enabled || envForcesLan()) {
    results.push(startLanIngress({ port: resolveLanPort(config) }).then((status) => {
      if (status.state === 'on') console.log(`Minnow home-network access on port ${status.port}`);
      else console.warn(`[remote] home-network access could not start: ${status.error?.message ?? status.state}`);
    }));
  }
  if (config.anywhere.enabled && requestHandler) {
    results.push(startTailnet({ requestHandler, funnel: config.anywhere.funnel }));
  }
  await Promise.all(results);
}

export async function shutdownRemoteIngress() {
  await Promise.all([stopLanIngress(), stopTailnet()]);
}
