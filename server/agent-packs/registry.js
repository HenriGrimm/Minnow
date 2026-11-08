/**
 * Agent pack registry snapshot + pack agent source index for prompt resolution.
 */

import fs from 'node:fs/promises';
import { getMinnowHome } from '../config/home.js';
import { invalidateNativePolicyBeforeWrite } from '../chats/native-policy-monitor.js';
import { getAgentPacksRoot } from './paths.js';
import { scanAgentPacks, loadAgentPacksState, isPackEnabled } from './scan.js';
import { getDiskTemplateFileMap, writeTemplateFiles } from './template.js';
import { workAgentsFromPackManifest } from './pack-agents.js';

/** @type {Map<string, object> | null} */
let packAgentSources = null;

/** @type {import('./types.js').ScannedAgentPack[] | null} */
let cachedPackList = null;

/**
 * @param {string} projectRoot
 * @param {ReadonlySet<string>} builtinAgentIds
 */
export async function refreshAgentPackCache(projectRoot, builtinAgentIds) {
  cachedPackList = await scanAgentPacks(projectRoot, builtinAgentIds);
  packAgentSources = new Map();

  for (const pack of cachedPackList) {
    if (!pack.valid || !pack.enabled || !pack.manifest) continue;
    const { sources } = workAgentsFromPackManifest(pack.manifest, pack.packRoot);
    for (const [id, src] of sources) {
      packAgentSources.set(id, src);
    }
  }

  return cachedPackList;
}

/**
 * @returns {import('./types.js').ScannedAgentPack[]}
 */
export function getCachedAgentPackList() {
  return cachedPackList ?? [];
}

/**
 * @param {string} agentId
 */
export function getPackAgentSource(agentId) {
  return packAgentSources?.get(agentId) ?? null;
}

/**
 * Enabled pack work agents for registry merge.
 * @param {string} projectRoot
 * @param {ReadonlySet<string>} builtinAgentIds
 */
export async function loadPackWorkAgents(projectRoot, builtinAgentIds) {
  const packs = await refreshAgentPackCache(projectRoot, builtinAgentIds);
  /** @type {object[]} */
  const agents = [];

  for (const pack of packs) {
    if (!pack.valid || !pack.enabled || !pack.manifest) continue;
    const { agents: packAgents } = workAgentsFromPackManifest(
      pack.manifest,
      pack.packRoot,
    );
    agents.push(...packAgents);
  }

  return { packs, agents };
}

/**
 * @param {string} packId
 * @param {boolean} enabled
 */
export async function setPackEnabled(packId, enabled) {
  const { getAgentPacksStatePath, assertValidPackId } = await import('./paths.js');
  assertValidPackId(packId);
  const state = await loadAgentPacksState();
  state[packId] = { ...(state[packId] ?? {}), enabled: !!enabled };
  const filePath = getAgentPacksStatePath();
  await fs.mkdir(getMinnowHome(), { recursive: true });
  invalidateNativePolicyBeforeWrite('agent-packs');
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state[packId];
}

/**
 * Ensure agent-packs directory exists (called from layout bootstrap).
 */
export async function ensureAgentPacksLayout() {
  const root = getAgentPacksRoot();
  await fs.mkdir(root, { recursive: true });
  const templateDir = `${root}/_template`;
  if (!(await isTemplatePackComplete(templateDir))) {
    await scaffoldTemplatePack(templateDir);
  }
}

/** True when the authoring template has all expected files (handles partial failed scaffolds). */
async function isTemplatePackComplete(templateDir) {
  const required = [
    `${templateDir}/manifest.json`,
    `${templateDir}/prompts/example.full.md`,
    `${templateDir}/prompts/example.lite.md`,
    `${templateDir}/README.md`,
  ];
  for (const filePath of required) {
    try {
      await fs.access(filePath);
    } catch {
      return false;
    }
  }
  return true;
}

async function scaffoldTemplatePack(templateDir) {
  await writeTemplateFiles(templateDir, getDiskTemplateFileMap());
}
