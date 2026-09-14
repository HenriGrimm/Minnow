/**
 * Export shipped built-in work agents as a downloadable agent pack zip.
 */

import {
  loadBuiltinWorkAgents,
  readBuiltinWorkAgentPrompt,
} from '../work-agents/registry.js';
import { buildZipFromFileMap } from './template.js';

/** Pack id / folder name inside the downloadable zip. */
export const BUILTIN_AGENT_PACK_ID = 'minnow';
export const BUILTIN_AGENT_PACK_ZIP_ROOT = BUILTIN_AGENT_PACK_ID;
export const BUILTIN_AGENT_PACK_ZIP_FILENAME = 'minnow-default-agent-pack.zip';

const PACK_CONTEXT_POLICIES = new Set(['compact', 'slide', 'truncate']);

/**
 * Map a built-in work agent row to a manifest agents[] entry.
 * @param {object} meta
 */
function packAgentEntryFromBuiltin(meta) {
  /** @type {Record<string, unknown>} */
  const entry = {
    key: meta.id,
    label: meta.label,
    prompts: {
      full: `prompts/${meta.id}.full.md`,
      lite: `prompts/${meta.id}.lite.md`,
    },
  };

  if (meta.description) entry.description = meta.description;
  if (meta.providerId) entry.providerId = meta.providerId;
  if (meta.modelId) entry.modelId = meta.modelId;
  if (Array.isArray(meta.defaultForModes) && meta.defaultForModes.length) {
    entry.defaultForModes = meta.defaultForModes;
  }
  if (meta.disabled === true) entry.disabled = true;

  const policy = meta.contextEnforcementPolicy;
  const packPolicy = PACK_CONTEXT_POLICIES.has(policy) ? policy : 'inherit';
  if (packPolicy !== 'inherit' || meta.maxInputTokens) {
    entry.contextStrategy = {
      policy: packPolicy,
      maxInputTokens: meta.maxInputTokens ?? null,
    };
  }

  return entry;
}

/**
 * Build a file map for the default Minnow agent pack export.
 * @param {string} projectRoot
 * @returns {Promise<Record<string, string>>}
 */
export async function buildBuiltinAgentPackFileMap(projectRoot) {
  const { agents } = await loadBuiltinWorkAgents(projectRoot);
  if (!agents.length) {
    throw new Error('No built-in work agents found to export');
  }

  /** @type {Record<string, string>} */
  const files = {};
  /** @type {Record<string, unknown>[]} */
  const manifestAgents = [];

  for (const meta of agents) {
    const full = await readBuiltinWorkAgentPrompt(projectRoot, meta.id, 'full');
    const lite = await readBuiltinWorkAgentPrompt(projectRoot, meta.id, 'lite');
    files[`prompts/${meta.id}.full.md`] = `${full.content.trim()}\n`;
    files[`prompts/${meta.id}.lite.md`] = `${lite.content.trim()}\n`;
    manifestAgents.push(packAgentEntryFromBuiltin(meta));
  }

  const manifest = {
    id: BUILTIN_AGENT_PACK_ID,
    label: 'Minnow default agents',
    version: '1.0.0',
    description:
      'Built-in Minnow work agents exported for customization. Installed agents appear as minnow.<key> in the composer.',
    enabled: true,
    agents: manifestAgents,
    defaults: { providerId: null, modelId: null },
  };

  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  files['README.md'] = [
    '# Minnow default agent pack',
    '',
    'This pack contains the work agents shipped with Minnow (Builder, Planner, Reviewer, and others).',
    '',
    '1. Copy this folder to `~/.minnow/agent-packs/minnow/`.',
    '2. Edit `manifest.json` and prompts under `prompts/` as needed.',
    '3. Enable the pack under Settings → Agents → Agent packs.',
    '',
    'Installed pack agents use ids like `minnow.builder`. Built-in agents (`builder`, etc.) remain available separately.',
    '',
  ].join('\n');

  return files;
}

/**
 * Zip buffer for GET /api/agent-packs/builtin.
 * @param {string} projectRoot
 * @returns {Promise<Buffer>}
 */
export async function buildBuiltinAgentPackZip(projectRoot) {
  const fileMap = await buildBuiltinAgentPackFileMap(projectRoot);
  return buildZipFromFileMap(fileMap, BUILTIN_AGENT_PACK_ZIP_ROOT);
}
