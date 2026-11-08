/**
 * Read/write ~/.minnow/providers/<id>/capabilities.json
 */

import fs from 'node:fs/promises';
import { renameFileWithRetry } from '../runtime/atomic-file.js';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { invalidateNativePolicyBeforeWrite } from '../chats/native-policy-monitor.js';
import { normalizeCapabilitiesFile, SCHEMA_VERSION } from './capabilities-schema.js';
import { validateProviderId } from './validate.js';

/**
 * @param {string} id
 * @returns {string}
 */
function capabilitiesPath(id) {
  validateProviderId(id);
  return path.join(getMinnowHome(), 'providers', id, 'capabilities.json');
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function readCapabilities(id) {
  const file = capabilitiesPath(id);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return normalizeCapabilitiesFile(JSON.parse(raw));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return normalizeCapabilitiesFile(null);
    }
    console.warn(`[capabilities] corrupt file for ${id}, resetting:`, err);
    return normalizeCapabilitiesFile(null);
  }
}

/**
 * @param {string} id
 * @param {object} file
 */
export async function writeCapabilities(id, file) {
  validateProviderId(id);
  const normalized = normalizeCapabilitiesFile(file);
  const dir = path.dirname(capabilitiesPath(id));
  await fs.mkdir(dir, { recursive: true });
  const target = capabilitiesPath(id);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    providerId: id,
    probedAt: normalized.probedAt || new Date().toISOString(),
    apiKind: normalized.apiKind || 'openai-v1',
    structuredOutput: normalized.structuredOutput === true,
    structuredOutputWithTools: normalized.structuredOutputWithTools === true,
    structuredOutputStreaming: normalized.structuredOutputStreaming === true,
    supportsThinkingBudget: normalized.supportsThinkingBudget === true,
    probeError: normalized.probeError ?? null,
    models: normalized.models || {},
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  invalidateNativePolicyBeforeWrite(`providers/${id}/capabilities.json`);
  await renameFileWithRetry(tmp, target);
  return payload;
}

/**
 * Persist llama.cpp per-request thinking budget support on the provider capabilities file.
 * @param {string} id
 * @param {boolean} supportsThinkingBudget
 */
export async function setProviderThinkingBudgetSupport(id, supportsThinkingBudget) {
  const existing = await readCapabilities(id);
  return writeCapabilities(id, {
    ...existing,
    supportsThinkingBudget: supportsThinkingBudget === true,
    probedAt: new Date().toISOString(),
  });
}

/** Fields a live chat probe may have already settled. */
const PROBE_MERGE_FIELDS = ['vision', 'tools', 'streaming', 'grammar', 'reasoning'];

/**
 * Merge one model capabilities patch onto a stored entry.
 * Probe-sourced fields win over later catalog ingest so a targeted first-load
 * probe cannot be overwritten when a full provider probe ingests the rest of
 * the catalog (or the reverse: catalog ingest of unprobed siblings).
 *
 * @param {object | undefined} existing
 * @param {object} patch
 */
export function mergeModelCapabilityEntry(existing, patch) {
  if (!existing || typeof existing !== 'object') return patch;
  if (!patch || typeof patch !== 'object') return existing;

  const existingSources =
    existing.sources && typeof existing.sources === 'object' ? existing.sources : {};
  const patchSources = patch.sources && typeof patch.sources === 'object' ? patch.sources : {};
  const sources = { ...existingSources, ...patchSources };
  const merged = { ...existing, ...patch };

  for (const field of PROBE_MERGE_FIELDS) {
    if (existingSources[field] === 'probe' && patchSources[field] !== 'probe') {
      merged[field] = existing[field];
      sources[field] = 'probe';
    }
  }
  merged.sources = sources;
  merged.probeErrors = {
    ...(existing.probeErrors && typeof existing.probeErrors === 'object'
      ? existing.probeErrors
      : {}),
    ...(patch.probeErrors && typeof patch.probeErrors === 'object' ? patch.probeErrors : {}),
  };
  return merged;
}

/**
 * Merge per-model entries into an existing capabilities file.
 *
 * @param {string} id
 * @param {Record<string, object>} modelPatches
 * @param {{ probedAt?: string, apiKind?: string }} meta
 */
export async function mergeCapabilities(id, modelPatches, meta = {}) {
  const existing = await readCapabilities(id);
  const models = { ...existing.models };
  for (const [modelId, patch] of Object.entries(modelPatches)) {
    models[modelId] = mergeModelCapabilityEntry(models[modelId], patch);
  }
  return writeCapabilities(id, {
    ...existing,
    providerId: id,
    probedAt: meta.probedAt || new Date().toISOString(),
    apiKind: meta.apiKind || existing.apiKind,
    models,
    ...meta.providerFields,
  });
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function capabilitiesFileExists(id) {
  try {
    await fs.access(capabilitiesPath(id));
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
