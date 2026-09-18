/**
 * Provider registry under ~/.minnow/providers/<id>/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import {
  readEncryptedJsonFile,
  writeEncryptedJsonFile,
} from '../security/secret-box.js';
import { buildAuthHeaders, secretsFlags } from './auth-headers.js';
import { getDefaultPaths, getProviderCapabilities } from './paths.js';
import {
  validateApiKind,
  validateAgentCliKind,
  validateAgentCliProfile,
  validateAuthStyle,
  validateBaseUrl,
  validateMessagesPath,
  validateModelApiOverrides,
  validateProviderId,
  validateProviderPricing,
} from './validate.js';
import {
  CLAUDE_CODE_CLI_ID,
  CODEX_CLI_ID,
  CURSOR_AGENT_CLI_ID,
  LLAMA_CPP_LOCAL_ID,
  MLX_LM_LOCAL_ID,
  isAgentCliProviderId,
} from '../../src/models/runtime-ids.mjs';

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234';
const LM_STUDIO_LOCAL_ID = 'lm-studio-local';
// Re-export so `import { LLAMA_CPP_LOCAL_ID } from './store.js'` keeps working.
export { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID };
export { CLAUDE_CODE_CLI_ID, CODEX_CLI_ID, CURSOR_AGENT_CLI_ID };

const AGENT_CLI_DEFAULTS = Object.freeze({
  claude: Object.freeze({ id: CLAUDE_CODE_CLI_ID, label: 'Claude Code' }),
  codex: Object.freeze({ id: CODEX_CLI_ID, label: 'Codex CLI' }),
  cursor: Object.freeze({ id: CURSOR_AGENT_CLI_ID, label: 'Cursor Agent' }),
});

/** Synthetic id on serve records / model picker for Minnow-hosted My Models (not a registry row). */
export const MINNOW_LIBRARY_PROVIDER_ID = 'minnow-library';
const DEFAULT_LLAMA_CPP_URL = 'http://127.0.0.1:8085';

/** Best-effort restrictive permissions on secrets files (Unix). */
async function chmodSecrets(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    /* ignore on Windows */
  }
}

/**
 * @returns {string}
 */
function providersRoot() {
  return path.join(getMinnowHome(), 'providers');
}

/**
 * @param {string} id
 * @returns {string}
 */
function providerDir(id) {
  validateProviderId(id);
  return path.join(providersRoot(), id);
}

/**
 * @param {object} profile
 * @param {{ hasApiKey: boolean, hasBearer: boolean, hasCliToken?: boolean }} flags
 */
export function toProviderPublic(profile, flags) {
  const caps = getProviderCapabilities(profile.apiKind);
  const supportsModelLoadUnload =
    profile.supportsModelLoadUnload !== undefined
      ? profile.supportsModelLoadUnload === true
      : caps.supportsModelLoadUnload;

  return {
    id: profile.id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    apiKind: profile.apiKind,
    enabled: profile.enabled !== false,
    authStyle: profile.authStyle || 'bearer',
    modelsPath: profile.modelsPath,
    chatCompletionsPath: profile.chatCompletionsPath,
    messagesPath: profile.messagesPath,
    autoApi: profile.autoApi === true,
    modelApiOverrides: profile.modelApiOverrides,
    supportsModelLoadUnload,
    modelsLoadPath: profile.modelsLoadPath,
    modelsUnloadPath: profile.modelsUnloadPath,
    customHeaders: profile.customHeaders || {},
    constrainedToolCalls:
      profile.constrainedToolCalls === true
        ? true
        : profile.constrainedToolCalls === false
          ? false
          : undefined,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    hasApiKey: flags.hasApiKey,
    hasBearer: flags.hasBearer,
    ...(profile.apiKind === 'agent-cli-v1'
      ? {
          hasCliToken: flags.hasCliToken === true,
          agentCli: validateAgentCliProfile(profile.agentCli),
        }
      : {}),
    ...(profile.pricing ? { pricing: profile.pricing } : {}),
    supportsExtendedSamplers: profile.supportsExtendedSamplers === true,
  };
}

/**
 * @param {string} id
 */
async function readProfile(id) {
  const file = path.join(providerDir(id), 'profile.json');
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

const EMPTY_SECRETS = { apiKey: '', bearerToken: '', cliToken: '', headerOverrides: {} };

/**
 * @param {string} id
 */
async function readSecrets(id) {
  const file = path.join(providerDir(id), 'secrets.json');
  try {
    const secrets = await readEncryptedJsonFile(file, EMPTY_SECRETS);
    return {
      apiKey: typeof secrets.apiKey === 'string' ? secrets.apiKey : '',
      bearerToken: typeof secrets.bearerToken === 'string' ? secrets.bearerToken : '',
      cliToken: typeof secrets.cliToken === 'string' ? secrets.cliToken : '',
      headerOverrides:
        secrets.headerOverrides && typeof secrets.headerOverrides === 'object'
          ? secrets.headerOverrides
          : {},
    };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { ...EMPTY_SECRETS };
    }
    throw err;
  }
}

/**
 * @param {string} id
 * @param {object} profile
 */
async function writeProfile(id, profile) {
  const dir = providerDir(id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'profile.json');
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * @param {string} id
 * @param {object} secrets
 */
async function writeSecrets(id, secrets) {
  const dir = providerDir(id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'secrets.json');
  await writeEncryptedJsonFile(file, secrets);
  await chmodSecrets(file);
}

/**
 * @returns {Promise<string[]>}
 */
async function listProviderIds() {
  const root = providersRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * @returns {Promise<string>}
 */
export async function getActiveProviderId() {
  const meta = (await readConfigJson('config.json')) ?? {};
  if (typeof meta.activeProviderId === 'string' && meta.activeProviderId) {
    return meta.activeProviderId;
  }
  return LM_STUDIO_LOCAL_ID;
}

/**
 * @param {string} id
 */
export async function setActiveProviderId(id) {
  validateProviderId(id);
  const ids = await listProviderIds();
  if (!ids.includes(id)) {
    throw new Error('Provider not found');
  }
  const meta = (await readConfigJson('config.json')) ?? {};
  await writeConfigJson('config.json', {
    ...meta,
    activeProviderId: id,
  });
}

/**
 * @param {string} [legacyServerUrl]
 */
async function seedLmStudioLocal(legacyServerUrl) {
  const baseUrl = validateBaseUrl(legacyServerUrl || DEFAULT_LM_STUDIO_URL);
  const now = new Date().toISOString();
  const paths = getDefaultPaths('lm-studio-v0');
  const profile = {
    id: LM_STUDIO_LOCAL_ID,
    label: 'LM Studio (local)',
    baseUrl,
    apiKind: 'lm-studio-v0',
    enabled: true,
    authStyle: 'bearer',
    modelsPath: paths.modelsPath,
    chatCompletionsPath: paths.chatCompletionsPath,
    supportsModelLoadUnload: true,
    modelsLoadPath: paths.modelsLoadPath,
    modelsUnloadPath: paths.modelsUnloadPath,
    customHeaders: {},
    createdAt: now,
    updatedAt: now,
  };
  await writeProfile(LM_STUDIO_LOCAL_ID, profile);
  await writeSecrets(LM_STUDIO_LOCAL_ID, {
    apiKey: '',
    bearerToken: '',
    headerOverrides: {},
  });

  const meta = (await readConfigJson('config.json')) ?? {};
  if (!meta.activeProviderId) {
    await writeConfigJson('config.json', {
      ...meta,
      activeProviderId: LM_STUDIO_LOCAL_ID,
    });
  }
}

/**
 * Ensure provider registry exists; seed default LM Studio provider when empty.
 */
/**
 * Backfill load/unload capability fields on existing provider profiles.
 */
async function migrateProviderCapabilities() {
  const ids = await listProviderIds();
  for (const id of ids) {
    let profile;
    try {
      profile = await readProfile(id);
    } catch {
      continue;
    }
    const caps = getProviderCapabilities(profile.apiKind);
    const paths = getDefaultPaths(profile.apiKind, profile);
    let changed = false;

    if (profile.supportsModelLoadUnload === undefined) {
      profile.supportsModelLoadUnload = caps.supportsModelLoadUnload;
      changed = true;
    }
    if (caps.supportsModelLoadUnload) {
      if (!profile.modelsLoadPath && paths.modelsLoadPath) {
        profile.modelsLoadPath = paths.modelsLoadPath;
        changed = true;
      }
      if (!profile.modelsUnloadPath && paths.modelsUnloadPath) {
        profile.modelsUnloadPath = paths.modelsUnloadPath;
        changed = true;
      }
    }
    if (changed) {
      profile.updatedAt = new Date().toISOString();
      await writeProfile(id, profile);
    }
  }
}

/**
 * Seed a disabled llama.cpp provider row (upserted when a model is served).
 */
export async function seedLlamaCppLocal() {
  const profilePath = path.join(providerDir(LLAMA_CPP_LOCAL_ID), 'profile.json');
  try {
    await fs.access(profilePath);
    return;
  } catch {
    /* capabilities.json can mkdir this dir first — still need a profile */
  }

  const baseUrl = validateBaseUrl(DEFAULT_LLAMA_CPP_URL);
  const now = new Date().toISOString();
  const paths = getDefaultPaths('openai-v1');
  const profile = {
    id: LLAMA_CPP_LOCAL_ID,
    label: 'llama.cpp (local)',
    baseUrl,
    apiKind: 'openai-v1',
    enabled: false,
    authStyle: 'bearer',
    modelsPath: paths.modelsPath,
    chatCompletionsPath: paths.chatCompletionsPath,
    supportsModelLoadUnload: false,
    supportsExtendedSamplers: true,
    customHeaders: {},
    createdAt: now,
    updatedAt: now,
  };
  await writeProfile(LLAMA_CPP_LOCAL_ID, profile);
  await writeSecrets(LLAMA_CPP_LOCAL_ID, {
    apiKey: '',
    bearerToken: '',
    headerOverrides: {},
  });
}

/**
 * Remove legacy per-serve Models · providers (models-xxxxxxxx ids).
 */
export async function migrateLegacyModelServeProviders() {
  const ids = await listProviderIds();
  for (const id of ids) {
    if (id === LLAMA_CPP_LOCAL_ID || id === LM_STUDIO_LOCAL_ID || id === MLX_LM_LOCAL_ID) continue;

    let profile;
    try {
      profile = await readProfile(id);
    } catch {
      continue;
    }

    const isLegacyId = /^models-[a-f0-9]{8}$/.test(id);
    const isLegacyLabel =
      typeof profile.label === 'string' && /^Models · /.test(profile.label);
    const isLoopbackOpenAi =
      profile.apiKind === 'openai-v1' &&
      typeof profile.baseUrl === 'string' &&
      /^https?:\/\/127\.0\.0\.1:\d+/.test(profile.baseUrl);

    if ((isLegacyId || isLegacyLabel) && isLoopbackOpenAi) {
      try {
        await deleteProvider(id);
      } catch {
        await updateProvider(id, { enabled: false });
      }
    }
  }
}

export async function ensureProviderRegistry() {
  await fs.mkdir(providersRoot(), { recursive: true });
  const ids = await listProviderIds();
  if (ids.length === 0) {
    const meta = (await readConfigJson('config.json')) ?? {};
    const legacyUrl =
      typeof meta.serverUrl === 'string' && meta.serverUrl.trim()
        ? meta.serverUrl
        : DEFAULT_LM_STUDIO_URL;
    await seedLmStudioLocal(legacyUrl);
    await seedLlamaCppLocal();
    return;
  }

  await migrateProviderCapabilities();
  await migrateLegacyModelServeProviders();
  await seedLlamaCppLocal();
}

/**
 * @returns {Promise<{ providers: object[], activeProviderId: string }>}
 */
export async function listProviders() {
  await ensureProviderRegistry();
  const ids = await listProviderIds();
  const providers = [];
  for (const id of ids.sort()) {
    try {
      const profile = await readProfile(id);
      const secrets = await readSecrets(id);
      providers.push(toProviderPublic(profile, {
        ...secretsFlags(secrets),
        hasCliToken: Boolean(secrets.cliToken?.trim()),
      }));
    } catch {
      /* skip broken provider dirs */
    }
  }
  let activeProviderId = await getActiveProviderId();
  if (!providers.some((p) => p.id === activeProviderId) && providers.length > 0) {
    activeProviderId = providers[0].id;
    await setActiveProviderId(activeProviderId);
  }
  return { providers, activeProviderId };
}

/**
 * `minnow-library` is a picker id, not a registry row. Callers must remap to
 * the live llama-cpp-local / mlx-lm-local serve first; a raw ENOENT here is a
 * routing bug, not a missing file.
 * @param {string} id
 */
function rejectSyntheticLibraryProvider(id) {
  if (id === MINNOW_LIBRARY_PROVIDER_ID) {
    throw new Error('synthetic My Models id — remap to the running serve first');
  }
}

/**
 * @param {string} id
 */
export async function getProvider(id) {
  await ensureProviderRegistry();
  validateProviderId(id);
  rejectSyntheticLibraryProvider(id);
  const profile = await readProfile(id);
  const secrets = await readSecrets(id);
  return toProviderPublic(profile, {
    ...secretsFlags(secrets),
    hasCliToken: Boolean(secrets.cliToken?.trim()),
  });
}

/**
 * @param {object} body
 */
export async function createProvider(body) {
  await ensureProviderRegistry();
  const id = validateProviderId(body.id);
  if (isAgentCliProviderId(id) || body.apiKind === 'agent-cli-v1') {
    throw new Error('Agent CLI providers must be configured through /api/models/agent-clis');
  }
  const ids = await listProviderIds();
  if (ids.includes(id)) {
    throw new Error('Provider already exists');
  }

  const apiKind = validateApiKind(body.apiKind || 'lm-studio-v0');
  const baseUrl = validateBaseUrl(body.baseUrl);
  const authStyle = validateAuthStyle(body.authStyle);
  const paths = getDefaultPaths(apiKind, body);
  const caps = getProviderCapabilities(apiKind);
  const now = new Date().toISOString();

  const profile = {
    id,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : id,
    baseUrl,
    apiKind,
    enabled: body.enabled !== false,
    authStyle,
    modelsPath: body.modelsPath || paths.modelsPath,
    chatCompletionsPath: body.chatCompletionsPath || paths.chatCompletionsPath,
    ...(paths.messagesPath ? { messagesPath: body.messagesPath || paths.messagesPath } : {}),
    ...(body.autoApi === true ? { autoApi: true } : {}),
    ...(body.modelApiOverrides ? { modelApiOverrides: validateModelApiOverrides(body.modelApiOverrides) } : {}),
    supportsModelLoadUnload:
      body.supportsModelLoadUnload !== undefined
        ? body.supportsModelLoadUnload === true
        : caps.supportsModelLoadUnload,
    supportsExtendedSamplers: body.supportsExtendedSamplers === true,
    modelsLoadPath: body.modelsLoadPath || paths.modelsLoadPath,
    modelsUnloadPath: body.modelsUnloadPath || paths.modelsUnloadPath,
    customHeaders:
      body.customHeaders && typeof body.customHeaders === 'object' ? body.customHeaders : {},
    createdAt: now,
    updatedAt: now,
  };

  await writeProfile(id, profile);
  await writeSecrets(id, { apiKey: '', bearerToken: '', headerOverrides: {} });

  const meta = (await readConfigJson('config.json')) ?? {};
  if (!meta.activeProviderId) {
    await setActiveProviderId(id);
  }

  return getProvider(id);
}

/**
 * @param {string} id
 * @param {object} body
 */
export async function updateProvider(id, body) {
  validateProviderId(id);
  if (isAgentCliProviderId(id) || body.apiKind === 'agent-cli-v1') {
    throw new Error('Agent CLI providers must be configured through /api/models/agent-clis');
  }
  const profile = await readProfile(id);
  const now = new Date().toISOString();

  if (body.label !== undefined) {
    profile.label =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim() : profile.label;
  }
  if (body.baseUrl !== undefined) {
    profile.baseUrl = validateBaseUrl(body.baseUrl);
  }
  if (body.apiKind !== undefined) {
    profile.apiKind = validateApiKind(body.apiKind);
    const paths = getDefaultPaths(profile.apiKind, body);
    profile.modelsPath = body.modelsPath || paths.modelsPath;
    profile.chatCompletionsPath = body.chatCompletionsPath || paths.chatCompletionsPath;
    if (paths.messagesPath) {
      profile.messagesPath = body.messagesPath || paths.messagesPath;
    }
  } else {
    if (body.modelsPath) profile.modelsPath = body.modelsPath;
    if (body.chatCompletionsPath) profile.chatCompletionsPath = body.chatCompletionsPath;
    if (body.messagesPath) profile.messagesPath = validateMessagesPath(body.messagesPath);
  }
  if (body.autoApi === true) {
    profile.autoApi = true;
  } else if (body.autoApi === false) {
    delete profile.autoApi;
  }
  if (body.modelApiOverrides !== undefined) {
    const overrides = validateModelApiOverrides(body.modelApiOverrides);
    if (overrides && Object.keys(overrides).length > 0) {
      profile.modelApiOverrides = overrides;
    } else {
      delete profile.modelApiOverrides;
    }
  }
  if (body.enabled !== undefined) {
    profile.enabled = Boolean(body.enabled);
  }
  if (body.authStyle !== undefined) {
    profile.authStyle = validateAuthStyle(body.authStyle);
  }
  if (body.customHeaders !== undefined && typeof body.customHeaders === 'object') {
    profile.customHeaders = body.customHeaders;
  }
  if (body.constrainedToolCalls === true) {
    profile.constrainedToolCalls = true;
  } else if (body.constrainedToolCalls === false) {
    profile.constrainedToolCalls = false;
  } else   if (body.constrainedToolCalls === null) {
    delete profile.constrainedToolCalls;
  }
  if (body.supportsExtendedSamplers === true) {
    profile.supportsExtendedSamplers = true;
  } else if (body.supportsExtendedSamplers === false) {
    profile.supportsExtendedSamplers = false;
  }

  if (body.pricing !== undefined) {
    const pricing = validateProviderPricing(body.pricing);
    if (pricing === null) {
      delete profile.pricing;
    } else if (pricing) {
      profile.pricing = pricing;
    }
  }

  profile.updatedAt = now;
  await writeProfile(id, profile);
  return getProvider(id);
}

/**
 * @param {string} id
 */
export async function deleteProvider(id) {
  validateProviderId(id);
  if (isAgentCliProviderId(id)) {
    throw new Error('Agent CLI providers cannot be deleted through generic provider CRUD');
  }
  const ids = await listProviderIds();
  if (ids.length <= 1) {
    throw new Error('Cannot delete the last provider');
  }
  if (!ids.includes(id)) {
    throw new Error('Provider not found');
  }

  await fs.rm(providerDir(id), { recursive: true, force: true });

  const active = await getActiveProviderId();
  if (active === id) {
    const remaining = (await listProviderIds()).sort();
    if (remaining.length > 0) {
      await setActiveProviderId(remaining[0]);
    }
  }
}

/**
 * @param {string} id
 * @param {object} body
 */
export async function updateProviderSecrets(id, body) {
  validateProviderId(id);
  if (isAgentCliProviderId(id)) {
    throw new Error('Agent CLI providers must be configured through /api/models/agent-clis');
  }
  await readProfile(id);
  const secrets = await readSecrets(id);

  if (body.apiKey !== undefined) {
    secrets.apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  }
  if (body.bearerToken !== undefined) {
    secrets.bearerToken = typeof body.bearerToken === 'string' ? body.bearerToken : '';
  }
  if (body.headerOverrides !== undefined && typeof body.headerOverrides === 'object') {
    secrets.headerOverrides = body.headerOverrides;
  }

  await writeSecrets(id, secrets);
  return { ok: true, ...secretsFlags(secrets) };
}

/**
 * @param {string} id
 * @returns {Promise<{ profile: object, secrets: object, headers: Record<string, string>, paths: object }>}
 */
export async function getProviderRuntime(id) {
  rejectSyntheticLibraryProvider(id);
  const profile = await readProfile(id);
  const secrets = await readSecrets(id);
  const paths = getDefaultPaths(profile.apiKind, profile);
  const caps = getProviderCapabilities(profile.apiKind);
  const supportsModelLoadUnload =
    profile.supportsModelLoadUnload !== undefined
      ? profile.supportsModelLoadUnload === true
      : caps.supportsModelLoadUnload;

  return {
    profile,
    secrets,
    headers: buildAuthHeaders(profile, secrets),
    paths,
    capabilities: { supportsModelLoadUnload },
  };
}

/** @param {unknown} kind */
function agentCliDefaults(kind) {
  const validated = validateAgentCliKind(kind);
  return { kind: validated, ...AGENT_CLI_DEFAULTS[validated] };
}

/**
 * Read a dedicated CLI configuration without creating or enabling it.
 * @param {unknown} kind
 */
export async function getAgentCliProviderConfig(kind) {
  const defaults = agentCliDefaults(kind);
  try {
    const profile = await readProfile(defaults.id);
    if (profile.apiKind !== 'agent-cli-v1' || profile.agentCli?.kind !== defaults.kind) {
      throw new Error('Reserved agent CLI provider has an invalid profile');
    }
    const secrets = await readSecrets(defaults.id);
    return { profile, secrets };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    return { profile: null, secrets: { ...EMPTY_SECRETS } };
  }
}

/**
 * Dedicated creation path for reserved CLI providers.
 * @param {unknown} kind
 * @param {boolean} enabled
 */
async function ensureAgentCliProvider(kind, enabled) {
  const defaults = agentCliDefaults(kind);
  await ensureProviderRegistry();
  const existing = await getAgentCliProviderConfig(defaults.kind);
  if (existing.profile) return existing;
  const now = new Date().toISOString();
  const profile = {
    id: defaults.id,
    label: defaults.label,
    baseUrl: '',
    apiKind: 'agent-cli-v1',
    enabled: enabled === true,
    authStyle: 'bearer',
    modelsPath: '',
    chatCompletionsPath: '',
    supportsModelLoadUnload: false,
    supportsExtendedSamplers: false,
    customHeaders: {},
    agentCli: validateAgentCliProfile({ kind: defaults.kind }),
    createdAt: now,
    updatedAt: now,
  };
  await writeProfile(defaults.id, profile);
  await writeSecrets(defaults.id, { ...EMPTY_SECRETS });
  return { profile, secrets: { ...EMPTY_SECRETS } };
}

/** @param {unknown} kind @param {boolean} enabled */
export async function setAgentCliProviderEnabled(kind, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const defaults = agentCliDefaults(kind);
  const { profile } = await ensureAgentCliProvider(defaults.kind, enabled);
  profile.enabled = enabled;
  profile.updatedAt = new Date().toISOString();
  await writeProfile(defaults.id, profile);
  const secrets = await readSecrets(defaults.id);
  return toProviderPublic(profile, {
    ...secretsFlags(secrets),
    hasCliToken: Boolean(secrets.cliToken?.trim()),
  });
}

/**
 * Apply the narrow settings contract for a reserved CLI provider.
 * @param {unknown} kind
 * @param {unknown} raw
 */
export async function updateAgentCliProviderSettings(kind, raw) {
  const defaults = agentCliDefaults(kind);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid agent CLI settings');
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  const allowed = new Set([
    'binPath',
    'allowUtilityRoles',
    'maxConcurrent',
    'maxBudgetUsd',
    'cliToken',
    'clearCliToken',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new Error(`Unsupported agent CLI setting: ${key}`);
  }
  if (body.cliToken !== undefined && typeof body.cliToken !== 'string') {
    throw new Error('Invalid cliToken');
  }
  if (typeof body.cliToken === 'string' && body.cliToken.length > 16_384) {
    throw new Error('cliToken is too long');
  }
  if (body.clearCliToken !== undefined && typeof body.clearCliToken !== 'boolean') {
    throw new Error('Invalid clearCliToken');
  }

  const { profile, secrets } = await ensureAgentCliProvider(defaults.kind, false);
  const patch = validateAgentCliProfile(
    Object.fromEntries(
      Object.entries(body).filter(([key]) =>
        ['binPath', 'allowUtilityRoles', 'maxConcurrent', 'maxBudgetUsd'].includes(key),
      ),
    ),
    { partial: true },
  );
  profile.agentCli = validateAgentCliProfile({
    ...profile.agentCli,
    ...patch,
    kind: defaults.kind,
    sessionMode: 'replay',
  });
  profile.updatedAt = new Date().toISOString();
  if (body.clearCliToken === true) secrets.cliToken = '';
  if (typeof body.cliToken === 'string' && body.cliToken.trim()) {
    secrets.cliToken = body.cliToken.trim();
  }
  await writeProfile(defaults.id, profile);
  await writeSecrets(defaults.id, secrets);
  return toProviderPublic(profile, {
    ...secretsFlags(secrets),
    hasCliToken: Boolean(secrets.cliToken?.trim()),
  });
}

export { LM_STUDIO_LOCAL_ID, DEFAULT_LM_STUDIO_URL, buildAuthHeaders };
