/**
 * Load browser automation settings from ~/.minnow/config.json.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

/** @typedef {object} BrowserConfig
 * @property {boolean} enabled
 * @property {boolean} allowNavigate
 * @property {boolean} nativeAgentTabs
 * @property {string[]} allowedOriginPatterns
 */

/**
 * Browser origins have no separate allowlist: the system permission level
 * (Manual / Auto / Full access) decides each navigation before it reaches the
 * browser, so the browser itself admits every web origin.
 */
export const ALL_WEB_ORIGIN_PATTERNS = Object.freeze(['http://*', 'https://*']);

export const DEFAULT_BROWSER_CONFIG = {
  enabled: true,
  allowNavigate: true,
  nativeAgentTabs: false,
  allowedOriginPatterns: [...ALL_WEB_ORIGIN_PATTERNS],
};

let cachedConfig = null;
let cachedMtime = 0;

/**
 * @param {unknown} raw
 * @returns {BrowserConfig}
 */
function mergeBrowserConfig(raw) {
  const base = {
    ...DEFAULT_BROWSER_CONFIG,
    allowedOriginPatterns: [...DEFAULT_BROWSER_CONFIG.allowedOriginPatterns],
  };
  if (!raw || typeof raw !== 'object') return base;
  const row = /** @type {Record<string, unknown>} */ (raw);
  if (typeof row.enabled === 'boolean') base.enabled = row.enabled;
  if (typeof row.allowNavigate === 'boolean') base.allowNavigate = row.allowNavigate;
  if (typeof row.nativeAgentTabs === 'boolean') base.nativeAgentTabs = row.nativeAgentTabs;
  // Stored legacy allowlists are ignored; see ALL_WEB_ORIGIN_PATTERNS.
  return base;
}

/**
 * Read browser section from config.json (cached by mtime).
 * @returns {Promise<BrowserConfig>}
 */
export async function loadBrowserConfig() {
  const configPath = path.join(getMinnowHome(), 'config.json');
  try {
    const stat = await fs.stat(configPath);
    if (cachedConfig && stat.mtimeMs === cachedMtime) {
      return cachedConfig;
    }
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    cachedConfig = mergeBrowserConfig(raw?.browser);
    cachedMtime = stat.mtimeMs;
    return cachedConfig;
  } catch {
    cachedConfig = mergeBrowserConfig(null);
    cachedMtime = 0;
    return cachedConfig;
  }
}

/** Reset cache (tests). */
export function resetBrowserConfigCache() {
  cachedConfig = null;
  cachedMtime = 0;
}

/**
 * Legacy: origins are no longer allowlisted (the permission level gates them).
 * Kept so older callers resolve; never writes.
 * @param {string} _pattern
 * @returns {Promise<boolean>}
 */
export async function appendBrowserAllowlistPattern(_pattern) {
  return false;
}

/**
 * @param {BrowserConfig} cfg
 */
export async function assertBrowserEnabled(cfg) {
  if (!cfg.enabled) {
    throw new Error('browser automation is disabled in settings');
  }
}
