/**
 * Convert validated pack manifests into work agent definitions (server).
 */

const CONTEXT_POLICIES = new Set(['compact', 'slide', 'truncate']);

function parseNullableString(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/**
 * @param {object} manifest
 * @param {string} packRoot
 * @returns {{ agents: object[], sources: Map<string, object> }}
 */
export function workAgentsFromPackManifest(manifest, packRoot) {
  const packId = String(manifest.id);
  const defaults = manifest.defaults ?? {};
  /** @type {object[]} */
  const agents = [];
  /** @type {Map<string, object>} */
  const sources = new Map();

  for (const entry of manifest.agents) {
    const key = String(entry.key);
    const id = `${packId}.${key}`;
    const strategy = entry.contextStrategy ?? null;
    let contextEnforcementPolicy = 'compact';
    let maxInputTokens = null;
    if (strategy && typeof strategy === 'object') {
      const policy = strategy.policy;
      if (CONTEXT_POLICIES.has(policy)) {
        contextEnforcementPolicy = policy;
      }
      const rawMax = strategy.maxInputTokens;
      if (typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0) {
        maxInputTokens = Math.floor(rawMax);
      }
    }

    const providerId =
      parseNullableString(entry.providerId) ?? parseNullableString(defaults.providerId);
    const modelId =
      parseNullableString(entry.modelId) ?? parseNullableString(defaults.modelId);
    let allowedTools = null;
    if (entry.allowedTools !== undefined && entry.allowedTools !== null) {
      allowedTools = entry.allowedTools.map(String);
    } else if (defaults.allowedTools !== undefined && defaults.allowedTools !== null) {
      allowedTools = defaults.allowedTools.map(String);
    }

    const agent = {
      id,
      label: String(entry.label).trim(),
      description:
        typeof entry.description === 'string' ? entry.description.trim() : '',
      kind: 'work-agent',
      version: String(manifest.version),
      providerId,
      modelId,
      allowedTools,
      defaultForModes: Array.isArray(entry.defaultForModes)
        ? entry.defaultForModes.map(String)
        : undefined,
      disabled: entry.disabled === true,
      maxInputTokens,
      contextEnforcementPolicy,
      source: 'pack',
      packId,
    };

    agents.push(agent);
    sources.set(id, {
      packId,
      agentKey: key,
      packRoot,
      promptPaths: {
        full: String(entry.prompts.full),
        lite:
          entry.prompts.lite !== undefined && entry.prompts.lite !== null
            ? String(entry.prompts.lite)
            : undefined,
      },
    });
  }

  return { agents, sources };
}
