/**
 * Persisted remote-access settings in config.json:
 *   server.remote = { lan: { enabled, port }, anywhere: { enabled, funnel } }
 * The legacy `server.networkAccess: 'lan'` (restart-based LAN mode) migrates to
 * `lan.enabled` once.
 */

import { readConfigJson, updateConfigJson } from '../config/store.js';
import { normalizeNetworkAccess } from '../network/access.js';

export const DEFAULT_LAN_PORT = 9480;

/**
 * @typedef {{
 *   lan: { enabled: boolean, port: number },
 *   anywhere: { enabled: boolean, funnel: boolean },
 * }} RemoteConfig
 */

/** @param {unknown} value */
function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** Port for the home-network listener (`MINNOW_LAN_PORT` overrides config). */
export function resolveLanPort(config) {
  return parsePort(process.env.MINNOW_LAN_PORT) ?? parsePort(config?.lan?.port) ?? DEFAULT_LAN_PORT;
}

/**
 * Normalize config meta into remote settings, applying the legacy migration.
 * @param {unknown} meta
 * @returns {RemoteConfig}
 */
export function resolveRemoteConfig(meta) {
  const server = /** @type {{ networkAccess?: unknown, remote?: any }} */ (
    meta && typeof meta === 'object' && /** @type {any} */ (meta).server && typeof /** @type {any} */ (meta).server === 'object'
      ? /** @type {any} */ (meta).server
      : {}
  );
  const remote = server.remote && typeof server.remote === 'object' ? server.remote : null;
  const legacyLan = normalizeNetworkAccess(server.networkAccess) === 'lan';
  return {
    lan: {
      enabled: remote?.lan && typeof remote.lan.enabled === 'boolean' ? remote.lan.enabled : legacyLan,
      port: parsePort(remote?.lan?.port) ?? DEFAULT_LAN_PORT,
    },
    anywhere: {
      enabled: remote?.anywhere?.enabled === true,
      funnel: remote?.anywhere?.funnel !== false,
    },
  };
}

/** @returns {Promise<RemoteConfig>} */
export async function readRemoteConfig() {
  return resolveRemoteConfig((await readConfigJson('config.json')) ?? {});
}

/**
 * Merge a patch into server.remote and keep the legacy field in sync so older
 * readers (and downgrades) see the same home-network state.
 * @param {{ lan?: Partial<RemoteConfig['lan']>, anywhere?: Partial<RemoteConfig['anywhere']> }} patch
 * @returns {Promise<RemoteConfig>}
 */
export async function writeRemoteConfig(patch) {
  let result = /** @type {RemoteConfig | null} */ (null);
  await updateConfigJson('config.json', (current) => {
    const meta = current && typeof current === 'object' ? { .../** @type {object} */ (current) } : {};
    const resolved = resolveRemoteConfig(meta);
    const next = {
      lan: { ...resolved.lan, ...(patch.lan ?? {}) },
      anywhere: { ...resolved.anywhere, ...(patch.anywhere ?? {}) },
    };
    result = next;
    const server = /** @type {any} */ (meta).server && typeof /** @type {any} */ (meta).server === 'object'
      ? { .../** @type {any} */ (meta).server }
      : {};
    server.remote = next;
    server.networkAccess = next.lan.enabled ? 'lan' : 'local';
    return { ...meta, server };
  });
  return /** @type {RemoteConfig} */ (result);
}

/** `MINNOW_NETWORK=lan` forces the home-network listener on at boot. */
export function envForcesLan() {
  return normalizeNetworkAccess(process.env.MINNOW_NETWORK) === 'lan';
}
