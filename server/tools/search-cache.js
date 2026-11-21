// Shared server helper.
/**
 * Disk cache for research search results and page text (~/.minnow/research/cache/).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

/** Two-hour TTL for search cache. */
export const RESEARCH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * @typedef {{ savedAt: number; results: import('../tools/search-result.js').SearchResult[] }} SearchCacheEntry
 * @typedef {{ savedAt: number; text: string }} PageCacheEntry
 */

/**
 * @returns {string}
 */
export function getResearchCacheDir() {
  return path.join(getMinnowHome(), 'research', 'cache');
}

/**
 * @param {string} prefix
 * @param {string} key
 * @returns {string}
 */
function cacheFilePath(prefix, key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(getResearchCacheDir(), `${prefix}-${hash}.json`);
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown | null>}
 */
async function readCacheFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {number} savedAt
 * @returns {boolean}
 */
function isExpired(savedAt) {
  if (!Number.isFinite(savedAt)) {
    return true;
  }
  return Date.now() - savedAt > RESEARCH_CACHE_TTL_MS;
}

/**
 * @param {string} queryKey
 * @returns {Promise<import('../tools/search-result.js').SearchResult[] | null>}
 */
export async function getSearch(queryKey) {
  const filePath = cacheFilePath('search', queryKey);
  const entry = await readCacheFile(filePath);
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const savedAt = Number(entry.savedAt);
  if (isExpired(savedAt)) {
    return null;
  }
  if (!Array.isArray(entry.results)) {
    return null;
  }
  return entry.results;
}

/**
 * @param {string} queryKey
 * @param {import('../tools/search-result.js').SearchResult[]} results
 * @returns {Promise<void>}
 */
export async function setSearch(queryKey, results) {
  try {
    const dir = getResearchCacheDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = cacheFilePath('search', queryKey);
    /** @type {SearchCacheEntry} */
    const entry = { savedAt: Date.now(), results };
    await fs.writeFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* fail open */
  }
}

/**
 * @param {string} url
 * @returns {Promise<string | null>}
 */
export async function getPage(url) {
  const filePath = cacheFilePath('page', url);
  const entry = await readCacheFile(filePath);
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const savedAt = Number(entry.savedAt);
  if (isExpired(savedAt)) {
    return null;
  }
  if (typeof entry.text !== 'string') {
    return null;
  }
  return entry.text;
}

/**
 * @param {string} url
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function setPage(url, text) {
  try {
    const dir = getResearchCacheDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = cacheFilePath('page', url);
    /** @type {PageCacheEntry} */
    const entry = { savedAt: Date.now(), text };
    await fs.writeFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* fail open */
  }
}
