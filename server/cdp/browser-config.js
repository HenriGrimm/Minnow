/**
 * Load browser automation settings from ~/.minnow/config.json.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { mergeConfigMeta } from '../config/validators.js';
import { normalizeAllowlistPatternLine } from './allowlist.js';

/** @typedef {object} BrowserConfig
 * @property {boolean} enabled
 * @property {boolean} allowNavigate
 * @property {boolean} nativeAgentTabs
 * @property {string[]} allowedOriginPatterns
 */

export const DEFAULT_BROWSER_CONFIG = {
  enabled: true,
  allowNavigate: true,
  nativeAgentTabs: false,
  allowedOriginPatterns: [
    'http://localhost:*',
    'http://127.0.0.1:*',
    'https://localhost:*',
  ],
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
  if (Array.isArray(row.allowedOriginPatterns)) {
    base.allowedOriginPatterns = row.allowedOriginPatterns.filter((p) => typeof p === 'string');
  }
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
 * Append an origin pattern to config.json when missing (persists allowlist).
 * @param {string} pattern
 * @returns {Promise<boolean>} true when a new pattern was written
 */
export async function appendBrowserAllowlistPattern(pattern) {
  const trimmed = normalizeAllowlistPatternLine(pattern);
  if (!trimmed) return false;

  const meta = (await readConfigJson('config.json')) ?? {};
  const cfg = mergeBrowserConfig(meta?.browser);
  if (
    cfg.allowedOriginPatterns.some(
      (p) => normalizeAllowlistPatternLine(p).toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return false;
  }

  const nextPatterns = [...cfg.allowedOriginPatterns, trimmed];
  const merged = mergeConfigMeta(meta, {
    browser: { allowedOriginPatterns: nextPatterns },
  });
  await writeConfigJson('config.json', merged);
  resetBrowserConfigCache();
  return true;
}

/**
 * @param {BrowserConfig} cfg
 */
export async function assertBrowserEnabled(cfg) {
  if (!cfg.enabled) {
    throw new Error('browser automation is disabled in settings');
  }
}
