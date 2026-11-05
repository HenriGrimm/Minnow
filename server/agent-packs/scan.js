/**
 * Scan ~/.minnow/agent-packs/ for manifest.json packs.
 */

import fs from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getAgentPacksRoot } from './paths.js';
import { shouldExposePackDir, validatePackManifest } from './validate.js';

/**
 * Load user enable state from ~/.minnow/agent-packs.json
 * @returns {Promise<Record<string, { enabled?: boolean }>>}
 */
export async function loadAgentPacksState() {
  const { getAgentPacksStatePath } = await import('./paths.js');
  const filePath = getAgentPacksStatePath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return /** @type {Record<string, { enabled?: boolean }>} */ (parsed);
    }
  } catch {
    /* missing */
  }
  return {};
}

/**
 * @param {Record<string, { enabled?: boolean }>} state
 * @param {string} packId
 * @param {boolean} manifestDefault
 */
export function isPackEnabled(state, packId, manifestDefault = true) {
  const row = state[packId];
  if (row && typeof row.enabled === 'boolean') return row.enabled;
  return manifestDefault;
}

/**
 * @param {string} projectRoot
 * @param {ReadonlySet<string>} builtinAgentIds
 * @returns {Promise<import('./types.js').ScannedAgentPack[]>}
 */
export async function scanAgentPacks(projectRoot, builtinAgentIds) {
  const root = getAgentPacksRoot();
  /** @type {import('./types.js').ScannedAgentPack[]} */
  const packs = [];

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return packs;
    }
    console.warn(`[agent-packs] Cannot read ${root}:`, err);
    return packs;
  }

  // Recover an upgrade interrupted after parking the old complete directory.
  for (const entry of entries) {
    const id = /^_previous-([a-z][a-z0-9-]{0,63})$/.exec(entry.name)?.[1];
    if (entry.isDirectory() && id && !existsSync(path.join(root, id))) {
      renameSync(path.join(root, entry.name), path.join(root, id));
      entries = await fs.readdir(root, {withFileTypes:true});
    }
  }
  const state = await loadAgentPacksState();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!shouldExposePackDir(entry.name)) continue;

    const packRoot = path.join(root, entry.name);
    const manifestPath = path.join(packRoot, 'manifest.json');
    let raw;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      console.warn(`[agent-packs] Skip ${entry.name}: missing manifest.json`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      packs.push({
        id: entry.name,
        label: entry.name,
        version: '?',
        enabled: isPackEnabled(state, entry.name, true),
        valid: false,
        errors: ['manifest.json is not valid JSON'],
        agents: [],
        packRoot,
        manifest: null,
      });
      continue;
    }

    const validation = await validatePackManifest(parsed, packRoot, builtinAgentIds);
    const manifestEnabled =
      parsed && typeof parsed === 'object' && parsed.enabled === false ? false : true;
    const packId =
      validation.ok && typeof parsed.id === 'string' ? parsed.id : entry.name;

    if (!validation.ok) {
      for (const msg of validation.errors) {
        console.warn(`[agent-packs] ${entry.name}: ${msg}`);
      }
      packs.push({
        id: packId,
        label:
          typeof parsed.label === 'string' ? parsed.label : entry.name,
        version: typeof parsed.version === 'string' ? parsed.version : '?',
        description:
          typeof parsed.description === 'string' ? parsed.description : undefined,
        enabled: isPackEnabled(state, packId, manifestEnabled),
        valid: false,
        errors: validation.errors,
        agents: [],
        packRoot,
        manifest: null,
      });
      continue;
    }

    const manifest = validation.manifest;
    const agents = /** @type {Array<Record<string, unknown>>} */ (manifest.agents).map(
      (row) => ({
        id: `${manifest.id}.${row.key}`,
        key: String(row.key),
        label: String(row.label),
        description:
          typeof row.description === 'string' ? row.description : undefined,
      }),
    );

    packs.push({
      id: String(manifest.id),
      label: String(manifest.label),
      version: String(manifest.version),
      description:
        typeof manifest.description === 'string'
          ? manifest.description
          : undefined,
      enabled: isPackEnabled(state, String(manifest.id), manifestEnabled),
      valid: true,
      errors: [],
      agents,
      packRoot,
      manifest,
    });
  }

  packs.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return packs;
}
