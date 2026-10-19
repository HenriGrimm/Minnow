/**
 * LAN address discovery for Settings and GET /api/system/network.
 */

import { resolveMinnowPort } from '../constants/minnow-port.js';
import os from 'node:os';
import {
  getConfigNetworkAccess,
  getNetworkAccess,
  isNetworkRestartRequired,
  resolveConfigNetworkAccess,
} from '../network/access.js';
import { readConfigJson } from '../config/store.js';

/**
 * Rank LAN addresses for companion pairing. Phones on the same Wi-Fi need a
 * reachable RFC1918 address — not Tailscale CGNAT (100.64/10) or common
 * virtual-adapter subnets that other devices cannot route to.
 * @param {string} addr
 * @returns {number}
 */
export function rankLanAddress(addr) {
  const octets = addr.split('.').map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return 90;
  }
  const [a, b] = octets;

  if (a === 100 && b >= 64 && b <= 127) return 80;

  if (a === 192 && b === 168) {
    if (octets[2] === 56 || octets[2] === 137) return 70;
    return 0;
  }
  if (a === 10) return 10;
  if (a === 172 && b >= 16 && b <= 31) return 20;

  return 50;
}

/**
 * List non-internal IPv4 LAN addresses (excludes loopback and link-local).
 * Best companion targets are first so pairing QR codes pick a phone-reachable IP.
 * @returns {string[]}
 */
export function listLanAddresses() {
  const seen = new Set();
  const out = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const addr = entry.address.trim();
      if (!addr || addr.startsWith('127.') || addr.startsWith('169.254.')) continue;
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.push(addr);
    }
  }

  return out.sort((left, right) => {
    const rankDiff = rankLanAddress(left) - rankLanAddress(right);
    return rankDiff !== 0 ? rankDiff : left.localeCompare(right);
  });
}

/**
 * Build reachable http URLs for each LAN address.
 * @param {number} port
 * @returns {string[]}
 */
export function buildNetworkUrls(port) {
  return listLanAddresses().map((addr) => `http://${addr}:${port}/`);
}

/**
 * Snapshot for GET /api/system/network.
 * @param {{ port: number, localUrl?: string, lanUrls?: string[] }} opts
 * @returns {Promise<{
 *   networkAccess: string,
 *   port: number,
 *   localUrl: string,
 *   lanUrls: string[],
 *   restartRequired: boolean,
 *   configNetworkAccess: string,
 * }>}
 */
export async function getNetworkStatus(opts) {
  // opts.lanUrls: addresses of the live home-network listener (it has its own port).
  const port = Number(opts.port) || resolveMinnowPort();
  const localUrl = opts.localUrl?.trim() || `http://localhost:${port}/`;
  const meta = (await readConfigJson('config.json')) ?? {};
  const persisted = resolveConfigNetworkAccess(meta);

  return {
    networkAccess: getNetworkAccess(),
    configNetworkAccess: persisted,
    port,
    localUrl: localUrl.endsWith('/') ? localUrl : `${localUrl}/`,
    lanUrls: opts.lanUrls ?? buildNetworkUrls(port),
    restartRequired: isNetworkRestartRequired(),
  };
}
