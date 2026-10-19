import { execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { isPrivateIpAddress } from '../webhooks/ssrf.js';
import { getRequestIngress } from './ingress.js';

/** @typedef {'local' | 'lan'} NetworkAccess */
/** @typedef {import('./ingress.js').IngressKind} IngressKind */

/**
 * `lan` while the home-network listener is running. The desktop listener is
 * always loopback; this only describes whether phones can reach Minnow.
 * @type {NetworkAccess}
 */
let activeNetworkAccess = 'local';

/** @type {NetworkAccess} */
let configNetworkAccess = 'local';

const NETWORK_ACCESS_VALUES = new Set(['local', 'lan']);
const OWN_HOSTNAMES_TTL_MS = 10_000;

/**
 * @param {unknown} value
 * @returns {NetworkAccess | null}
 */
export function normalizeNetworkAccess(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return NETWORK_ACCESS_VALUES.has(mode) ? /** @type {NetworkAccess} */ (mode) : null;
}

/**
 * Legacy `server.networkAccess`; `server/remote/config.js` migrates it to
 * `server.remote.lan.enabled`.
 * @param {unknown} configMeta
 * @returns {NetworkAccess}
 */
export function resolveConfigNetworkAccess(configMeta) {
  const meta = /** @type {{ server?: { networkAccess?: unknown, remote?: { lan?: { enabled?: unknown } } } }} */ (
    configMeta && typeof configMeta === 'object' ? configMeta : {}
  );
  if (meta.server?.remote?.lan?.enabled === true) return 'lan';
  return normalizeNetworkAccess(meta.server?.networkAccess) ?? 'local';
}

/**
 * @param {unknown} configMeta
 * @returns {NetworkAccess}
 */
export function resolveNetworkAccess(configMeta) {
  const fromEnv = normalizeNetworkAccess(process.env.MINNOW_NETWORK);
  if (fromEnv) return fromEnv;
  return resolveConfigNetworkAccess(configMeta);
}

/**
 * Seed the configured mode; the ingress manager reports the live one.
 * @param {unknown} configMeta
 */
export function initNetworkAccess(configMeta) {
  configNetworkAccess = resolveNetworkAccess(configMeta);
  // Nothing is reachable from the network until the listener actually starts.
  activeNetworkAccess = 'local';
}

/** Record whether the home-network listener is live (ingress manager only). */
export function setActiveNetworkAccess(mode) {
  if (NETWORK_ACCESS_VALUES.has(mode)) activeNetworkAccess = mode;
}

/**
 * @param {NetworkAccess} mode
 */
export function setConfigNetworkAccess(mode) {
  if (NETWORK_ACCESS_VALUES.has(mode)) {
    configNetworkAccess = mode;
  }
}

/** @returns {NetworkAccess} */
export function getNetworkAccess() {
  return activeNetworkAccess;
}

/** @returns {NetworkAccess} */
export function getConfigNetworkAccess() {
  return configNetworkAccess;
}

/** Remote listeners start and stop live; nothing requires a restart any more. */
export function isNetworkRestartRequired() {
  return false;
}

/**
 * The desktop dev server always binds loopback; phones use the separate
 * home-network listener.
 * @returns {string}
 */
export function resolveViteHost() {
  return 'localhost';
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isLoopbackAddress(address) {
  if (net.isIP(address) === 4) return address === '127.0.0.1';
  if (net.isIP(address) !== 6) return false;
  return address === '::1' || address.toLowerCase() === '::ffff:127.0.0.1';
}

/** @param {import('http').IncomingMessage} req */
export function isLoopbackClient(req) {
  return isLoopbackAddress(req.socket?.remoteAddress ?? '');
}

/** @param {string} addr */
function isPrivatePeer(addr) {
  if (!addr) return false;
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (net.isIP(normalized) === 0 && net.isIP(addr) === 0) return false;
  return isPrivateIpAddress(addr);
}

/**
 * Legacy mode-based peer check, kept for callers that predate ingress tagging.
 * @param {import('http').IncomingMessage} req
 * @param {NetworkAccess} [networkAccess]
 * @returns {boolean}
 */
export function isClientAllowed(req, networkAccess = activeNetworkAccess) {
  const addr = req.socket?.remoteAddress ?? '';
  if (!addr) return false;
  if (isLoopbackClient(req)) return true;
  if (networkAccess !== 'lan') return false;
  return isPrivatePeer(addr);
}

/**
 * Peer check for the listener that accepted the request. The home network only
 * serves private peers; tailnet traffic always comes from the local sidecar,
 * whose shared secret the trusted listener has already verified.
 * @param {import('http').IncomingMessage} req
 * @param {IngressKind} ingress
 */
export function isClientAllowedForIngress(req, ingress) {
  const addr = req.socket?.remoteAddress ?? '';
  // Only socket-less test doubles lack a peer; real loopback sockets always have one.
  if (ingress === 'loopback') return !req.socket?.remoteAddress || isLoopbackAddress(addr);
  if (ingress === 'lan') return isLoopbackAddress(addr) || isPrivatePeer(addr);
  return isLoopbackAddress(addr);
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * @param {string} host
 * @returns {string}
 */
export function stripHostPort(host) {
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(1, end);
  }
  const colonCount = host.split(':').length - 1;
  if (colonCount <= 1) {
    const idx = host.indexOf(':');
    return idx === -1 ? host : host.slice(0, idx);
  }
  return host;
}

/** @type {string | null | undefined} */
let cachedBonjourHostname;

/**
 * The name iOS resolves over Bonjour (`<LocalHostName>.local`). On macOS this
 * can differ from `os.hostname()`. Elsewhere `.local` resolution is unreliable,
 * so callers fall back to IP addresses.
 * @returns {string | null}
 */
export function getBonjourHostname() {
  if (cachedBonjourHostname !== undefined) return cachedBonjourHostname;
  cachedBonjourHostname = null;
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'LocalHostName'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[A-Za-z0-9-]{1,63}$/.test(name)) cachedBonjourHostname = `${name.toLowerCase()}.local`;
    } catch {
      /* scutil missing or no LocalHostName configured */
    }
    if (!cachedBonjourHostname) {
      const base = os.hostname().toLowerCase().replace(/\.local$/, '');
      if (/^[a-z0-9-]{1,63}$/.test(base)) cachedBonjourHostname = `${base}.local`;
    }
  }
  return cachedBonjourHostname;
}

/** @type {{ names: Set<string>, at: number } | null} */
let ownHostnames = null;
/** @type {Set<string>} */
const tailnetHostnames = new Set();

/**
 * This machine's names and addresses, recomputed every few seconds so a
 * Wi-Fi or DHCP change never locks phones out until a restart.
 * @returns {Set<string>}
 */
function getOwnLanHostnames() {
  const now = Date.now();
  if (ownHostnames && now - ownHostnames.at < OWN_HOSTNAMES_TTL_MS) return ownHostnames.names;
  const hostname = os.hostname().toLowerCase();
  const names = new Set([hostname, hostname.replace(/\.local$/, ''), `${hostname.replace(/\.local$/, '')}.local`]);
  const bonjour = getBonjourHostname();
  if (bonjour) names.add(bonjour);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) names.add(entry.address.toLowerCase());
    }
  }
  ownHostnames = { names, at: now };
  return names;
}

export function resetOwnLanHostnamesCache() {
  ownHostnames = null;
  cachedBonjourHostname = undefined;
}

/** Register the tailnet DNS name served by the sidecar (empty clears it). */
export function setTailnetHostnames(names) {
  tailnetHostnames.clear();
  for (const name of names ?? []) {
    const normalized = String(name).toLowerCase().replace(/\.$/, '');
    if (normalized) tailnetHostnames.add(normalized);
  }
}

/**
 * Legacy mode-based Host validation.
 * @param {string} hostHeader
 * @param {NetworkAccess} [networkAccess]
 * @returns {boolean}
 */
export function isHostAllowed(hostHeader, networkAccess = activeNetworkAccess) {
  const hostname = stripHostPort(hostHeader).toLowerCase();
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (networkAccess !== 'lan') return false;
  return getOwnLanHostnames().has(hostname);
}

/**
 * Host validation (anti DNS rebinding) for the listener that accepted the request.
 * @param {string} hostHeader
 * @param {IngressKind} ingress
 */
export function isHostAllowedForIngress(hostHeader, ingress) {
  const hostname = stripHostPort(hostHeader).toLowerCase();
  if (!hostname) return false;
  if (ingress === 'loopback') return isLoopbackHostname(hostname);
  if (ingress === 'lan') return isLoopbackHostname(hostname) || getOwnLanHostnames().has(hostname);
  return tailnetHostnames.has(hostname);
}

/**
 * Peer + Host validation for a request on whichever listener received it.
 * @param {import('http').IncomingMessage} req
 * @returns {{ ingress: IngressKind, allowed: boolean }}
 */
export function checkIngressAccess(req) {
  const ingress = getRequestIngress(req);
  // A kept-alive socket from before home-network access was turned off must not
  // keep working.
  if (ingress === 'lan' && activeNetworkAccess !== 'lan') return { ingress, allowed: false };
  const allowed =
    isClientAllowedForIngress(req, ingress) && isHostAllowedForIngress(req.headers.host ?? '', ingress);
  return { ingress, allowed };
}
