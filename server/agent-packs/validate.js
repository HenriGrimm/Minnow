/**
 * Validate agent pack manifest.json (schemaVersion-free v1 checks).
 */

import { ALL_TOOL_IDS } from '../config/tool-ids.js';
import { PACK_ID_RE, resolvePackPromptPath } from './paths.js';

const PACK_AGENT_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const toolSet = new Set(ALL_TOOL_IDS);

/**
 * @param {string} dirName
 */
export function shouldExposePackDir(dirName) {
  if (dirName.startsWith('_')) return false;
  return true;
}

function parseNullableString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/**
 * @param {unknown} manifest
 * @param {string} packRoot
 * @param {ReadonlySet<string>} builtinAgentIds
 * @returns {{ ok: true, manifest: object } | { ok: false, errors: string[] }}
 */
export function validatePackManifest(manifest, packRoot, builtinAgentIds) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['Manifest must be a JSON object'] };
  }

  const m = /** @type {Record<string, unknown>} */ (manifest);

  if (typeof m.id !== 'string' || !PACK_ID_RE.test(m.id)) {
    errors.push('Invalid or missing manifest id');
  }
  if (typeof m.label !== 'string' || !m.label.trim()) {
    errors.push('Invalid or missing label');
  }
  if (typeof m.version !== 'string' || !m.version.trim()) {
    errors.push('Invalid or missing version');
  }
  if (!Array.isArray(m.agents) || m.agents.length < 1) {
    errors.push('agents array is required with at least one entry');
  }

  if (errors.length) return { ok: false, errors };

  const packId = m.id;
  const dirBase = packRoot.split(/[/\\]/).pop();
  if (dirBase !== packId) {
    errors.push(`Manifest id "${packId}" must match folder name "${dirBase}"`);
  }

  const agents = /** @type {Array<Record<string, unknown>>} */ (m.agents);
  const seenKeys = new Set();

  for (const entry of agents) {
    const key = entry.key;
    if (typeof key !== 'string' || !PACK_AGENT_KEY_RE.test(key)) {
      errors.push(`Invalid agent key "${key}"`);
      continue;
    }
    if (seenKeys.has(key)) {
      errors.push(`Duplicate agent key "${key}"`);
      continue;
    }
    seenKeys.add(key);

    if (typeof entry.label !== 'string' || !entry.label.trim()) {
      errors.push(`Agent ${key}: invalid label`);
    }

    const workId = `${packId}.${key}`;
    if (builtinAgentIds.has(workId)) {
      errors.push(`Agent "${workId}" collides with a built-in work agent`);
    }

    const prompts = entry.prompts;
    if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
      errors.push(`Agent ${key}: prompts object required`);
      continue;
    }
    const promptObj = /** @type {Record<string, unknown>} */ (prompts);
    if (typeof promptObj.full !== 'string' || !promptObj.full.trim()) {
      errors.push(`Agent ${key}: prompts.full is required`);
    } else {
      try {
        resolvePackPromptPath(packRoot, promptObj.full);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Agent ${key}: ${message}`);
      }
    }
    if (promptObj.lite !== undefined && typeof promptObj.lite === 'string' && promptObj.lite.trim()) {
      try {
        resolvePackPromptPath(packRoot, promptObj.lite);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Agent ${key} lite: ${message}`);
      }
    }

    const allowedTools = entry.allowedTools;
    if (allowedTools !== undefined && allowedTools !== null) {
      if (!Array.isArray(allowedTools)) {
        errors.push(`Agent ${key}: allowedTools must be an array or null`);
      } else {
        for (const toolId of allowedTools) {
          if (!toolSet.has(String(toolId))) {
            errors.push(`Unknown tool id "${toolId}" on agent ${key}`);
          }
        }
      }
    }

    const strategy = entry.contextStrategy;
    if (strategy !== undefined && strategy !== null) {
      if (typeof strategy !== 'object' || Array.isArray(strategy)) {
        errors.push(`Agent ${key}: invalid contextStrategy`);
      } else {
        const policy = /** @type {Record<string, unknown>} */ (strategy).policy;
        if (
          policy !== undefined &&
          policy !== 'inherit' &&
          policy !== 'compact' &&
          // Retired values from packs exported before compaction v2.
          policy !== 'summarize' &&
          policy !== 'dropMiddle' &&
          policy !== 'archive' &&
          policy !== 'slide' &&
          policy !== 'truncate'
        ) {
          errors.push(`Agent ${key}: invalid contextStrategy.policy`);
        }
      }
    }
  }

  const defaults = m.defaults;
  if (defaults !== undefined && defaults !== null) {
    if (typeof defaults !== 'object' || Array.isArray(defaults)) {
      errors.push('defaults must be an object');
    } else {
      const d = /** @type {Record<string, unknown>} */ (defaults);
      parseNullableString(d.providerId);
      if (Array.isArray(d.allowedTools)) {
        for (const toolId of d.allowedTools) {
          if (!toolSet.has(String(toolId))) {
            errors.push(`Unknown tool id "${toolId}" in pack defaults`);
          }
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: m };
}

/**
 * @param {string} packId
 */
export function assertValidPackId(packId) {
  if (!packId || typeof packId !== 'string' || !PACK_ID_RE.test(packId)) {
    throw new Error('Invalid agent pack id');
  }
}
