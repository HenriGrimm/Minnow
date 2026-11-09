/**
 * Capture live Minnow settings into a profile bundle and apply a bundle to disk.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { resetSubAgentServerConfigCache } from '../sub-agents/config.js';
import { mergeConfigMeta, normalizeSubAgentsConfig, normalizeToolConfig, validateUserRulesSettings } from '../config/validators.js';
import { getMinnowHome } from '../config/home.js';
import { loadPromptConfigFile, savePromptConfigFile } from '../prompt-configs/handlers.js';
import { workAgentsOverridesPath } from '../work-agents/paths.js';

/**
 * Flatten rules.json into legacy profile text for portable bundles.
 * @param {unknown} rulesRaw
 */
function composeUserRulesLegacyTextFromRaw(rulesRaw) {
  try {
    const normalized = validateUserRulesSettings(rulesRaw);
    return normalized.rules
      .filter((rule) => rule.enabled && rule.text.trim())
      .map((rule) => rule.text.trim())
      .join('\n\n');
  } catch {
    if (rulesRaw && typeof rulesRaw === 'object' && typeof rulesRaw.text === 'string') {
      return rulesRaw.text;
    }
    return '';
  }
}

/**
 * Build a profile bundle snapshot from current ~/.minnow state.
 * @param {string} id
 * @param {string} label
 * @param {string} [description]
 */
export async function captureCurrentSettings(id, label, description) {
  const meta = (await readConfigJson('config.json')) ?? {};
  const subAgentsRaw = (await readConfigJson('sub-agents.json')) ?? {};
  const rulesRaw = (await readConfigJson('rules.json')) ?? {};
  const skillsRaw = (await readConfigJson('skills.json')) ?? {};

  let workAgents = {};
  try {
    const waPath = workAgentsOverridesPath();
    const raw = await fs.readFile(waPath, 'utf8');
    workAgents = JSON.parse(raw);
  } catch {
    workAgents = {};
  }

  const planning =
    meta.planning && typeof meta.planning === 'object'
      ? /** @type {Record<string, unknown>} */ (meta.planning)
      : {};

  const promptProfile =
    meta.activePromptProfile === 'lite' ||
    meta.activePromptProfile === 'custom' ||
    meta.activePromptProfile === 'full'
      ? meta.activePromptProfile
      : 'full';

  let parts = {};
  let source = promptProfile === 'custom' ? 'prompt-config' : promptProfile;
  const configId =
    typeof meta.activePromptConfigId === 'string' ? meta.activePromptConfigId : null;

  if (promptProfile === 'custom' && configId) {
    const cfg = await loadPromptConfigFile(configId);
    if (cfg?.parts && typeof cfg.parts === 'object') {
      parts = cfg.parts;
      source = 'embedded';
    }
  }

  const now = new Date().toISOString();

  return {
    id,
    label,
    schemaVersion: 1,
    meta: {
      description: description ?? '',
      createdAt: now,
      updatedAt: now,
      minnowVersion: process.env.npm_package_version ?? 'dev',
    },
    prompt: {
      promptProfile,
      activePromptConfigId: configId,
      activeInfoPresetId:
        typeof meta.activeInfoPresetId === 'string'
          ? meta.activeInfoPresetId
          : 'general-assistant',
      planGranularity:
        planning.granularity === 'large' || planning.granularity === 'small'
          ? planning.granularity
          : 'medium',
      source,
      ...(Object.keys(parts).length > 0 ? { parts } : {}),
    },
    agents: {
      workAgents: workAgents && typeof workAgents === 'object' ? workAgents : {},
      subAgents: subAgentsRaw && typeof subAgentsRaw === 'object' ? subAgentsRaw : {},
    },
    tools: {},
    rules: {
      enabled: rulesRaw?.enabled === true,
      text: composeUserRulesLegacyTextFromRaw(rulesRaw),
    },
    skills: {
      enabled:
        skillsRaw?.enabled && typeof skillsRaw.enabled === 'object'
          ? skillsRaw.enabled
          : {},
    },
  };
}

/**
 * Deep-merge work-agent overrides from bundle.
 * @param {object} bundleAgents
 * @param {object} existing
 */
async function mergeWorkAgentsFromBundle(bundleAgents, existing) {
  const patch =
    bundleAgents?.workAgents && typeof bundleAgents.workAgents === 'object'
      ? bundleAgents.workAgents
      : {};
  const merged = { ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const [agentId, row] of Object.entries(patch)) {
    if (!row || typeof row !== 'object') continue;
    merged[agentId] = {
      ...(merged[agentId] && typeof merged[agentId] === 'object' ? merged[agentId] : {}),
      .../** @type {object} */ (row),
    };
  }
  const filePath = workAgentsOverridesPath();
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
  return merged;
}

/**
 * Apply a validated profile bundle to ~/.minnow.
 * Drops the sub-agent cache so new type rows apply without a restart.
 * @param {object} bundle
 * @returns {Promise<{ appliedAt: string }>}
 */
export async function applyProfileBundle(bundle) {
  const meta = (await readConfigJson('config.json')) ?? {};
  const prompt = bundle.prompt && typeof bundle.prompt === 'object' ? bundle.prompt : {};

  const promptPatch = {
    activePromptProfile: prompt.promptProfile,
    activePromptConfigId:
      prompt.activePromptConfigId === null || typeof prompt.activePromptConfigId === 'string'
        ? prompt.activePromptConfigId
        : null,
    activeInfoPresetId:
      typeof prompt.activeInfoPresetId === 'string'
        ? prompt.activeInfoPresetId
        : meta.activeInfoPresetId ?? 'general-assistant',
    activeSetupProfileId: bundle.id,
    planning: {
      granularity:
        prompt.planGranularity === 'large' || prompt.planGranularity === 'small'
          ? prompt.planGranularity
          : 'medium',
    },
  };

  const mergedMeta = mergeConfigMeta(meta, promptPatch);
  await writeConfigJson('config.json', mergedMeta);

  const source = prompt.source ?? 'embedded';
  const configId =
    typeof prompt.activePromptConfigId === 'string' ? prompt.activePromptConfigId : bundle.id;

  if (prompt.promptProfile === 'custom') {
    if (source === 'embedded' && prompt.parts && typeof prompt.parts === 'object') {
      await savePromptConfigFile({
        id: configId,
        label: `${bundle.label} (parts)`,
        profile: 'custom',
        parts: prompt.parts,
      });
      const metaAfter = (await readConfigJson('config.json')) ?? {};
      await writeConfigJson(
        'config.json',
        mergeConfigMeta(metaAfter, { activePromptConfigId: configId }),
      );
    }
  }

  const toolsExisting = (await readConfigJson('tools.json')) ?? {};
  const toolsNext = normalizeToolConfig(toolsExisting);
  await writeConfigJson('tools.json', toolsNext);

  let workExisting = {};
  try {
    workExisting = JSON.parse(await fs.readFile(workAgentsOverridesPath(), 'utf8'));
  } catch {
    workExisting = {};
  }
  await mergeWorkAgentsFromBundle(bundle.agents, workExisting);

  const subPatch =
    bundle.agents?.subAgents && typeof bundle.agents.subAgents === 'object'
      ? bundle.agents.subAgents
      : {};
  const subExisting = (await readConfigJson('sub-agents.json')) ?? {};
  const subMerged = {
    ...(subExisting && typeof subExisting === 'object' ? subExisting : {}),
    ...subPatch,
    types: {
      ...(subExisting?.types && typeof subExisting.types === 'object' ? subExisting.types : {}),
      ...(subPatch.types && typeof subPatch.types === 'object' ? subPatch.types : {}),
    },
  };
  const { config: subNormalized } = normalizeSubAgentsConfig(subMerged);
  await writeConfigJson('sub-agents.json', subNormalized);
  resetSubAgentServerConfigCache();

  if (bundle.rules && typeof bundle.rules === 'object') {
    const rulesExisting = validateUserRulesSettings(
      (await readConfigJson('rules.json')) ?? {
        version: 2,
        enabled: false,
        groups: [{ id: 'general', name: 'General' }],
        rules: [],
      },
    );
    let next = { ...rulesExisting, enabled: bundle.rules.enabled === true };

    if (typeof bundle.rules.text === 'string') {
      const generalGroup =
        next.groups.find((group) => group.id === 'general') ?? next.groups[0];
      if (generalGroup) {
        const existing = next.rules.find((rule) => rule.groupId === generalGroup.id);
        if (existing) {
          next = {
            ...next,
            rules: next.rules.map((rule) =>
              rule.id === existing.id ? { ...rule, text: bundle.rules.text } : rule,
            ),
          };
        } else if (bundle.rules.text.trim()) {
          next = {
            ...next,
            rules: [
              ...next.rules,
              {
                id: crypto.randomUUID(),
                title: 'Profile rule',
                text: bundle.rules.text,
                enabled: true,
                groupId: generalGroup.id,
              },
            ],
          };
        }
      }
    }

    await writeConfigJson('rules.json', validateUserRulesSettings(next));
  }

  if (bundle.skills?.enabled && typeof bundle.skills.enabled === 'object') {
    const skillsExisting = (await readConfigJson('skills.json')) ?? { enabled: {} };
    await writeConfigJson('skills.json', {
      ...skillsExisting,
      enabled: {
        ...(skillsExisting.enabled && typeof skillsExisting.enabled === 'object'
          ? skillsExisting.enabled
          : {}),
        ...bundle.skills.enabled,
      },
    });
  }

  return { appliedAt: new Date().toISOString() };
}

/**
 * Save optional rollback snapshot before activate.
 * @param {object} bundle
 */
export async function saveRollbackSnapshot(bundle) {
  const rollbackDir = path.join(getMinnowHome(), 'profiles', '_rollback');
  await fs.mkdir(rollbackDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshot = await captureCurrentSettings(
    `_rollback-${stamp}`,
    `Rollback before ${bundle.id}`,
    '',
  );
  snapshot.id = `_rollback-${stamp}`;
  const filePath = path.join(rollbackDir, `${snapshot.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot.id;
}
