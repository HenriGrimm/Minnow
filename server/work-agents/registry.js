/**
 * Server-side Work Agent registry loader.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePromptMarkdown } from '../prompts/parse.js';
import { getMinnowHome } from '../config/home.js';
import { normalizeContextEnforcementPolicy } from '../runner/context-budget.js';
import {
  assertValidWorkAgentId,
  builtinWorkAgentsDir,
  workAgentsOverridesPath,
} from './paths.js';
import { loadPackWorkAgents, getPackAgentSource } from '../agent-packs/registry.js';
import { resolvePackPromptPath } from '../agent-packs/paths.js';

const SKIP = new Set(['_template', '_example', 'README.md']);

function parseExtendedRecord(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const record = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.endsWith(':') && !trimmed.includes(': ')) {
      const key = trimmed.slice(0, -1).trim();
      const values = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith('- ')) {
        values.push(lines[j].trimStart().slice(2).trim());
        j += 1;
      }
      if (values.length) {
        record[key] = values;
        i = j - 1;
        continue;
      }
      if (key === 'archive') {
        const nested = parseNestedScalarBlock(lines, i);
        record.archive = nested.record;
        i = nested.nextIndex;
        continue;
      }
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    record[key] = value;
  }
  return record;
}

function parseNullableString(value) {
  if (value === null || value === 'null' || value === '') return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function parseNestedScalarBlock(lines, startIndex) {
  const record = {};
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) break;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else {
      const num = Number(value);
      if (value !== '' && Number.isFinite(num)) value = num;
    }
    record[key] = value;
    i += 1;
  }
  return { record, nextIndex: i - 1 };
}

function parseWorkAgentMeta(raw, relativePath) {
  let parsed;
  try {
    parsed = parsePromptMarkdown(raw, relativePath);
  } catch {
    return null;
  }
  if (parsed.kind !== 'work-agent') return null;

  const ext = parseExtendedRecord(raw);
  const defaultForModes = Array.isArray(ext.defaultForModes)
    ? ext.defaultForModes.map(String)
    : undefined;
  const allowedTools = Array.isArray(ext.allowedTools)
    ? ext.allowedTools.map(String)
    : null;

  const maxInputTokens =
    typeof ext.maxInputTokens === 'number' && Number.isFinite(ext.maxInputTokens)
      ? Math.max(1, Math.floor(ext.maxInputTokens))
      : null;

  const contextEnforcementPolicy = normalizeContextEnforcementPolicy(ext.contextEnforcementPolicy) ?? 'compact';

  return {
    id: parsed.id,
    label: parsed.label,
    description: parsed.description ?? '',
    kind: 'work-agent',
    version: String(parsed.version),
    providerId: parseNullableString(ext.providerId),
    modelId: parseNullableString(ext.modelId),
    allowedTools,
    defaultForModes,
    disabled: ext.disabled === true,
    maxInputTokens,
    contextEnforcementPolicy,
  };
}

function mergeDefinition(builtin, override) {
  if (!override) return { ...builtin };
  return {
    ...builtin,
    providerId:
      override.providerId !== undefined ? override.providerId : builtin.providerId,
    modelId: override.modelId !== undefined ? override.modelId : builtin.modelId,
    disabled: override.disabled !== undefined ? override.disabled : builtin.disabled,
    maxInputTokens:
      override.maxInputTokens !== undefined
        ? override.maxInputTokens
        : builtin.maxInputTokens,
    // Stored overrides may still say summarize / dropMiddle / archive: those read as compact.
    contextEnforcementPolicy:
      normalizeContextEnforcementPolicy(override.contextEnforcementPolicy) ??
      builtin.contextEnforcementPolicy,
    minRecentTurns:
      override.minRecentTurns !== undefined
        ? override.minRecentTurns
        : builtin.minRecentTurns,
    summaryReserveTokens:
      override.summaryReserveTokens !== undefined
        ? override.summaryReserveTokens
        : builtin.summaryReserveTokens,
  };
}

async function loadRegistryIndex(projectRoot) {
  const indexPath = path.join(builtinWorkAgentsDir(projectRoot), 'registry.json');
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.ids)) {
      return parsed.ids.map(String);
    }
  } catch {
    /* fallback */
  }
  return ['default', 'builder', 'planner', 'reviewer', 'researcher'];
}

async function loadBuiltinAgents(projectRoot) {
  const baseDir = builtinWorkAgentsDir(projectRoot);
  const ids = await loadRegistryIndex(projectRoot);
  const map = new Map();

  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return { ids, agents: [] };
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || SKIP.has(ent.name)) continue;
    const agentId = ent.name;
    assertValidWorkAgentId(agentId);

    const fullPath = path.join(baseDir, agentId, 'agent.full.md');
    let raw;
    try {
      raw = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    const meta = parseWorkAgentMeta(raw, `work-agents/${agentId}/agent.full.md`);
    if (meta) map.set(agentId, meta);
  }

  const agents = [];
  const seen = new Set();
  for (const id of ids) {
    const agent = map.get(id);
    if (agent) {
      agents.push(agent);
      seen.add(id);
    }
  }
  for (const [id, agent] of map) {
    if (!seen.has(id)) agents.push(agent);
  }

  return { ids, agents };
}

/** Shipped built-in work agents (for pack export and tests). */
export async function loadBuiltinWorkAgents(projectRoot) {
  return loadBuiltinAgents(projectRoot);
}

async function loadUserOverrides() {
  const filePath = workAgentsOverridesPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* missing */
  }
  return {};
}

async function saveUserOverrides(overrides) {
  const filePath = workAgentsOverridesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} projectRoot
 */
export async function loadWorkAgentRegistry(projectRoot) {
  const { agents: builtins } = await loadBuiltinAgents(projectRoot);
  const overrides = await loadUserOverrides();

  const builtinIds = new Set(builtins.map((a) => a.id));
  const { agents: packAgents } = await loadPackWorkAgents(projectRoot, builtinIds);

  const mergedBuiltins = builtins.map((a) => ({
    ...mergeDefinition(a, overrides[a.id]),
    source: 'builtin',
  }));

  const mergedPacks = packAgents.map((a) => mergeDefinition(a, overrides[a.id]));

  const agents = [...mergedBuiltins, ...mergedPacks];
  return { agents, overrides };
}

/**
 * @param {string} projectRoot
 * @param {string} agentId
 */
export async function getWorkAgentById(projectRoot, agentId) {
  const { agents } = await loadWorkAgentRegistry(projectRoot);
  return agents.find((a) => a.id === agentId) ?? null;
}

/**
 * @param {string} agentId
 * @param {Record<string, unknown>} patch
 */
export async function patchWorkAgentOverride(agentId, patch) {
  assertValidWorkAgentId(agentId);
  const overrides = await loadUserOverrides();
  const prev = overrides[agentId] ?? {};
  const next = { ...prev, ...patch };
  if (patch.contextEnforcementPolicy === null) {
    delete next.contextEnforcementPolicy;
  }
  // Brain archive tuning retired with the archive policy.
  delete next.archive;
  overrides[agentId] = next;
  await saveUserOverrides(overrides);
  return overrides[agentId];
}

/**
 * Shipped work-agent prompt only (ignores ~/.minnow overrides).
 */
export async function readBuiltinWorkAgentPrompt(projectRoot, agentId, profile) {
  const builtinPath = path.join(
    builtinWorkAgentsDir(projectRoot),
    agentId,
    `agent.${profile}.md`,
  );
  const raw = await fs.readFile(builtinPath, 'utf8');
  const parsed = parsePromptMarkdown(raw, builtinPath);
  return { content: parsed.body.trim(), source: 'builtin' };
}

async function readPackWorkAgentPrompt(agentId, profile) {
  const source = getPackAgentSource(agentId);
  if (!source) return null;

  const rel =
    profile === 'lite' && source.promptPaths.lite
      ? source.promptPaths.lite
      : source.promptPaths.full;
  const filePath = resolvePackPromptPath(source.packRoot, rel);
  const raw = await fs.readFile(filePath, 'utf8');
  const { parsePromptMarkdown } = await import('../prompts/parse.js');
  try {
    const parsed = parsePromptMarkdown(raw, filePath);
    return { content: parsed.body.trim(), source: 'pack' };
  } catch {
    return { content: raw.trim(), source: 'pack' };
  }
}

// Overrides are often raw markdown without YAML front matter.
export async function readWorkAgentPrompt(projectRoot, agentId, profile) {
  const overridePath = (() => {
    try {
      return path.join(
        getMinnowHome(),
        'prompts',
        'work-agents',
        agentId,
        `agent.${profile}.md`,
      );
    } catch {
      return null;
    }
  })();

  if (overridePath) {
    try {
      const content = await fs.readFile(overridePath, 'utf8');
      try {
        const parsed = parsePromptMarkdown(content, overridePath);
        return { content: parsed.body.trim(), source: 'override' };
      } catch {
        return { content: content.trim(), source: 'override' };
      }
    } catch {
      /* fall through */
    }
  }

  const packPrompt = await readPackWorkAgentPrompt(agentId, profile);
  if (packPrompt) return packPrompt;

  return readBuiltinWorkAgentPrompt(projectRoot, agentId, profile);
}

export async function writeWorkAgentPromptOverride(agentId, profile, content) {
  const { workAgentPromptOverridePath } = await import('./paths.js');
  const filePath = workAgentPromptOverridePath(agentId, profile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body =
    typeof content === 'string' && content.trim()
      ? `${content.trim()}\n`
      : '';
  await fs.writeFile(filePath, body, 'utf8');
}
