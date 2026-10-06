import net from 'node:net';
import os from 'node:os';
import { isPrivateIpAddress } from '../webhooks/ssrf.js';

/** @typedef {'local' | 'lan'} NetworkAccess */

/** @type {NetworkAccess} */
let activeNetworkAccess = 'local';

/** @type {NetworkAccess} */
let configNetworkAccess = 'local';

const NETWORK_ACCESS_VALUES = new Set(['local', 'lan']);

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
 * @param {unknown} configMeta
 * @returns {NetworkAccess}
 */
export function resolveConfigNetworkAccess(configMeta) {
  const fromConfig =
    configMeta && typeof configMeta === 'object'
      ? normalizeNetworkAccess(/** @type {{ server?: { networkAccess?: unknown } }} */ (configMeta).server?.networkAccess)
      : null;
  return fromConfig ?? 'local';
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
 * @param {unknown} configMeta
 */
export function initNetworkAccess(configMeta) {
  configNetworkAccess = resolveConfigNetworkAccess(configMeta);
  activeNetworkAccess = resolveNetworkAccess(configMeta);
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

export function isNetworkRestartRequired() {
  return configNetworkAccess !== activeNetworkAccess;
}

/**
 * @param {NetworkAccess} networkAccess
 * @returns {string | boolean}
 */
export function resolveViteHost(networkAccess) {
  return networkAccess === 'lan' ? true : 'localhost';
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {NetworkAccess} [networkAccess]
 * @returns {boolean}
 */
export function isClientAllowed(req, networkAccess = activeNetworkAccess) {
  const addr = req.socket?.remoteAddress ?? '';
  if (!addr) return false;
  if (isLoopbackClient(req)) return true;
  if (networkAccess !== 'lan') return false;

  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (net.isIP(normalized) === 0 && net.isIP(addr) === 0) return false;
  return isPrivateIpAddress(addr);
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
function stripHostPort(host) {
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

/** @type {Set<string> | null} */
let cachedOwnLanHostnames = null;

/**
 * @returns {Set<string>}
 */
function getOwnLanHostnames() {
  if (cachedOwnLanHostnames) return cachedOwnLanHostnames;
  const names = new Set([os.hostname().toLowerCase()]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal) names.add(entry.address.toLowerCase());
    }
  }
  cachedOwnLanHostnames = names;
  return names;
}

export function resetOwnLanHostnamesCache() {
  cachedOwnLanHostnames = null;
}

/**
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
