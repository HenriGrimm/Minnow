import fs from 'node:fs/promises';
import path from 'node:path';
import {
  issuesBackupDir,
  issuesBackupPath,
  resolveConfigPath,
  resourceToRelativeKey,
} from './paths.js';
import { ensureMinnowLayout } from './home.js';
import {
  mergeConfigMeta,
  migrateChatRowV5ToV6,
  normalizeChatRow,
  normalizeGroupRow,
  normalizeSessionScalars,
  normalizeToolConfig,
  normalizeSearchConfig,
  normalizeServersConfig,
  normalizeResearchConfig,
  seedSearchConfigFromTools,
  defaultResearchConfig,
  normalizeSkillConfig,
  normalizeSubAgentsConfig,
  SESSION_SCHEMA_VERSION,
  validateSessionState,
  validateSystemPromptSettings,
  validateUserRulesSettings,
  validateBugsState,
  validateIssuesState,
  issuesSchemaRevisionOf,
  validateIssuesTaxonomy,
  seedDefaultIssueTypes,
  defaultIssuesTaxonomy,
} from './validators.js';
import {
  DEFAULT_META,
  defaultSessionStateJson,
  defaultToolsJson,
  defaultSkillsJson,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_RULES,
} from './home.js';
import {
  patchSessionState,
  readWholeSessionState,
  useJsonSessionsStore,
  writeWholeSessionState,
} from './sessions-repo.js';
import { sessionsJsonPath } from './sessions-paths.js';
import {
  defaultAppearanceConfig,
  normalizeAppearanceConfig,
} from './appearance.js';

async function chmodSecretFile(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
  }
}

/**
 * @param {string} relativeKey
 * @returns {Promise<boolean>}
 */
export async function configFileExists(relativeKey) {
  if (relativeKey === 'sessions/state.json') {
    try {
      await fs.access(sessionsJsonPath());
      return true;
    } catch {
      return false;
    }
  }
  const full = resolveConfigPath(relativeKey);
  try {
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

const SERIALIZED_CONFIG_KEYS = new Set(['config.json']);

/** @type {Map<string, Promise<void>>} */
const configJsonQueues = new Map();

/** @type {Promise<void>} */
let sessionsJsonQueue = Promise.resolve();

/**
 * @param {string} relativeKey
 * @returns {Promise<void>}
 */
function getConfigJsonQueue(relativeKey) {
  let queue = configJsonQueues.get(relativeKey);
  if (!queue) {
    queue = Promise.resolve();
    configJsonQueues.set(relativeKey, queue);
  }
  return queue;
}

/**
 * @template T
 * @param {string} relativeKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withConfigJsonLock(relativeKey, fn) {
  const run = getConfigJsonQueue(relativeKey).then(fn, fn);
  configJsonQueues.set(
    relativeKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withSessionsJsonLock(fn) {
  const run = sessionsJsonQueue.then(fn, fn);
  sessionsJsonQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {string} src
 * @param {string} dest
 */
async function renameConfigAtomic(src, dest) {
  const maxAttempts = 6;
  const baseDelayMs = 25;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * @param {string} relativeKey
 * @returns {Promise<unknown>}
 */
async function readConfigJsonUnlocked(relativeKey) {
  await ensureMinnowLayout();
  if (relativeKey === 'sessions/state.json') {
    try {
      const raw = await fs.readFile(sessionsJsonPath(), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }
  const full = resolveConfigPath(relativeKey);
  try {
    const raw = await fs.readFile(full, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * @param {string} relativeKey
 * @returns {Promise<unknown>}
 */
export async function readConfigJson(relativeKey) {
  if (relativeKey === 'sessions/state.json' && useJsonSessionsStore()) {
    return withSessionsJsonLock(() => readConfigJsonUnlocked(relativeKey));
  }
  if (!SERIALIZED_CONFIG_KEYS.has(relativeKey)) {
    return readConfigJsonUnlocked(relativeKey);
  }
  return withConfigJsonLock(relativeKey, () => readConfigJsonUnlocked(relativeKey));
}

/**
 * @param {string} relativeKey
 * @param {unknown} data
 */
async function writeConfigJsonUnlocked(relativeKey, data) {
  await ensureMinnowLayout();
  const full =
    relativeKey === 'sessions/state.json'
      ? sessionsJsonPath()
      : resolveConfigPath(relativeKey);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  await renameConfigAtomic(tmp, full);
  if (relativeKey === 'tools.json' || relativeKey === 'search.json') {
    await chmodSecretFile(full);
  }
}

/**
 * @param {string} relativeKey
 * @param {unknown} data
 */
export async function writeConfigJson(relativeKey, data) {
  if (relativeKey === 'sessions/state.json' && useJsonSessionsStore()) {
    return withSessionsJsonLock(() => writeConfigJsonUnlocked(relativeKey, data));
  }
  if (!SERIALIZED_CONFIG_KEYS.has(relativeKey)) {
    return writeConfigJsonUnlocked(relativeKey, data);
  }
  return withConfigJsonLock(relativeKey, () => writeConfigJsonUnlocked(relativeKey, data));
}

const ISSUES_BACKUP_KEEP = 5;

/**
 * @param {string} relativeKey
 * @param {number} nextVersion
 */
async function backupIssuesStateOnSchemaChange(relativeKey, nextVersion) {
  try {
    const current = await readConfigJson(relativeKey);
    if (!current || typeof current !== 'object') return;
    const row = /** @type {Record<string, unknown>} */ (current);
    if (!Array.isArray(row.issues)) return;
    const fromVersion = issuesSchemaRevisionOf(row);
    if (fromVersion === nextVersion) return;

    const dir = issuesBackupDir();
    await fs.mkdir(dir, { recursive: true });
    const target = issuesBackupPath(fromVersion, Date.now());
    await fs.writeFile(target, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

    const entries = (await fs.readdir(dir))
      .filter((name) => name.startsWith('state.v') && name.endsWith('.json'))
      .sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - ISSUES_BACKUP_KEEP))) {
      await fs.rm(path.join(dir, stale), { force: true });
    }
  } catch {
  }
}

/**
 * @template T
 * @param {string} relativeKey
 * @param {(current: unknown) => T | Promise<T>} mutator
 * @returns {Promise<T>}
 */
export async function updateConfigJson(relativeKey, mutator) {
  if (relativeKey === 'sessions/state.json' && useJsonSessionsStore()) {
    return withSessionsJsonLock(async () => {
      const current = await readConfigJsonUnlocked(relativeKey);
      const next = await mutator(current);
      await writeConfigJsonUnlocked(relativeKey, next);
      return next;
    });
  }
  if (!SERIALIZED_CONFIG_KEYS.has(relativeKey)) {
    const current = await readConfigJsonUnlocked(relativeKey);
    const next = await mutator(current);
    await writeConfigJsonUnlocked(relativeKey, next);
    return next;
  }
  return withConfigJsonLock(relativeKey, async () => {
    const current = await readConfigJsonUnlocked(relativeKey);
    const next = await mutator(current);
    await writeConfigJsonUnlocked(relativeKey, next);
    return next;
  });
}

/**
 * @param {string} resource
 * @returns {Promise<unknown>}
 */
export async function readResource(resource) {
  const key = resourceToRelativeKey(resource);
  if (!key) throw new Error('Unknown resource');

  if (resource === 'sessions') {
    if (useJsonSessionsStore()) {
      const data = await readConfigJson(key);
      return data ?? defaultSessionStateJson();
    }
    await ensureMinnowLayout();
    return readWholeSessionState();
  }
  if (resource === 'tools') {
    const data = await readConfigJson(key);
    return data ?? defaultToolsJson();
  }
  if (resource === 'search') {
    let data = await readConfigJson(key);
    if (data === null) {
      const toolsRaw = (await readConfigJson('tools.json')) ?? defaultToolsJson();
      const tools = normalizeToolConfig(toolsRaw);
      const seeded = seedSearchConfigFromTools(tools);
      await writeConfigJson(key, seeded);
      data = seeded;
    }
    return normalizeSearchConfig(data);
  }
  if (resource === 'servers') {
    const data = await readConfigJson(key);
    return normalizeServersConfig(data);
  }
  if (resource === 'research') {
    const data = await readConfigJson(key);
    return data ?? defaultResearchConfig();
  }
  if (resource === 'skills') {
    const data = await readConfigJson(key);
    return data ?? defaultSkillsJson();
  }
  if (resource === 'system-prompt') {
    const data = await readConfigJson(key);
    return data ?? DEFAULT_SYSTEM_PROMPT;
  }
  if (resource === 'rules') {
    const data = await readConfigJson(key);
    return data ?? DEFAULT_RULES;
  }
  if (resource === 'meta') {
    let data = await readConfigJson(key);
    if (!data) {
      await ensureMinnowLayout();
      data = await readConfigJson(key);
    }
    const patch = {};
    if (!data?.uiDesigner) {
      patch.uiDesigner = DEFAULT_META.uiDesigner;
    }
    if (!data?.titles) {
      patch.titles = DEFAULT_META.titles;
    }
    if (!data?.utilityModel) {
      patch.utilityModel = DEFAULT_META.utilityModel;
    }
    if (!data?.sampler) {
      patch.sampler = DEFAULT_META.sampler;
    }
    if (!data?.thinking) {
      patch.thinking = DEFAULT_META.thinking;
    }
    if (!data?.chat) {
      patch.chat = DEFAULT_META.chat;
    }
    if (!data?.browser) {
      patch.browser = DEFAULT_META.browser;
    }
    if (!data?.editorAiCompletion) {
      patch.editorAiCompletion = DEFAULT_META.editorAiCompletion;
    }
    if (!data?.gitCommitMessage) {
      patch.gitCommitMessage = DEFAULT_META.gitCommitMessage;
    }
    if (!data?.editorIntentMode) {
      patch.editorIntentMode = DEFAULT_META.editorIntentMode;
    }
    if (!data?.editorSettings) {
      patch.editorSettings = DEFAULT_META.editorSettings;
    }
    if (!data?.voice) {
      patch.voice = DEFAULT_META.voice;
    }
    if (Object.keys(patch).length > 0) {
      return mergeConfigMeta(data ?? {}, patch);
    }
    return data;
  }
  if (resource === 'sub-agents') {
    const data = await readConfigJson(key);
    return data ?? { version: 1, enabled: true, globalMaxConcurrent: 3, defaultTimeoutMs: 300000, types: {} };
  }
  if (resource === 'bugs') {
    const data = await readConfigJson(key);
    return data ?? { version: 1, bugs: [] };
  }
  if (resource === 'issues') {
    return readConfigJson(key);
  }
  if (resource === 'issues-taxonomy') {
    const data = await readConfigJson(key);
    if (!data) return defaultIssuesTaxonomy();
    try {
      return seedDefaultIssueTypes(validateIssuesTaxonomy(data));
    } catch {
      return defaultIssuesTaxonomy();
    }
  }
  if (resource === 'appearance') {
    const data = await readConfigJson(key);
    return normalizeAppearanceConfig(data ?? defaultAppearanceConfig());
  }

  return readConfigJson(key);
}

/**
 * @param {string} resource
 * @param {unknown} body
 */
export async function writeResource(resource, body) {
  const key = resourceToRelativeKey(resource);
  if (!key) throw new Error('Unknown resource');

  if (resource === 'sessions') {
    const validated = validateSessionState(body);
    const raw = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
    const rawChats = Array.isArray(raw.chats) ? raw.chats : undefined;
    if (useJsonSessionsStore()) {
      const merged = await mergeJsonSessionHistories(key, validated, rawChats, {
        deleteChatIds: Array.isArray(raw.deleteChatIds) ? raw.deleteChatIds : [],
        pruneMissingChats: raw.pruneMissingChats === true,
      });
      await writeConfigJson(key, merged);
      return validated;
    }
    await ensureMinnowLayout();
    writeWholeSessionState(validated, {
      rawChats,
      deleteChatIds: Array.isArray(raw.deleteChatIds) ? raw.deleteChatIds : [],
      deleteGroupIds: Array.isArray(raw.deleteGroupIds) ? raw.deleteGroupIds : [],
      pruneMissingChats: raw.pruneMissingChats === true,
      baseRevision: raw.baseRevision,
    });
    return validated;
  }
  if (resource === 'tools') {
    const normalized = normalizeToolConfig(body);
    await writeConfigJson(key, normalized);
    return normalized;
  }
  if (resource === 'search') {
    const normalized = normalizeSearchConfig(body);
    await writeConfigJson(key, normalized);
    return normalized;
  }
  if (resource === 'servers') {
    const normalized = normalizeServersConfig(body);
    await writeConfigJson(key, normalized);
    return normalized;
  }
  if (resource === 'research') {
    const normalized = normalizeResearchConfig(body);
    await writeConfigJson(key, normalized);
    return normalized;
  }
  if (resource === 'skills') {
    const normalized = normalizeSkillConfig(body);
    await writeConfigJson(key, normalized);
    return normalized;
  }
  if (resource === 'system-prompt') {
    const validated = validateSystemPromptSettings(body);
    await writeConfigJson(key, validated);
    return validated;
  }
  if (resource === 'rules') {
    const validated = validateUserRulesSettings(body);
    await writeConfigJson(key, validated);
    return validated;
  }
  if (resource === 'meta') {
    const existing = (await readConfigJson(key)) ?? {};
    const merged = mergeConfigMeta(existing, body);
    await writeConfigJson(key, merged);
    if (body && typeof body === 'object' && 'browser' in /** @type {Record<string, unknown>} */ (body)) {
      const { resetBrowserConfigCache } = await import('../cdp/browser-config.js');
      resetBrowserConfigCache();
    }
    if (body && typeof body === 'object' && 'server' in /** @type {Record<string, unknown>} */ (body)) {
      const { setConfigNetworkAccess, resolveConfigNetworkAccess } = await import('../network/access.js');
      setConfigNetworkAccess(resolveConfigNetworkAccess(merged));
    }
    return merged;
  }
  if (resource === 'sub-agents') {
    const { config } = normalizeSubAgentsConfig(body);
    await writeConfigJson(key, config);
    const { resetSubAgentServerConfigCache } = await import('../sub-agents/config.js');
    resetSubAgentServerConfigCache();
    return config;
  }
  if (resource === 'bugs') {
    const validated = validateBugsState(body);
    await writeConfigJson(key, validated);
    return validated;
  }
  if (resource === 'issues') {
    const validated = validateIssuesState(body);
    await backupIssuesStateOnSchemaChange(key, validated.schemaRevision);
    await writeConfigJson(key, validated);
    return validated;
  }
  if (resource === 'issues-taxonomy') {
    const issuesKey = resourceToRelativeKey('issues');
    const issuesRaw = issuesKey ? await readConfigJson(issuesKey) : null;
    const issuesState = validateIssuesState(issuesRaw);
    const previousRaw = await readConfigJson(key);
    const previous = previousRaw
      ? validateIssuesTaxonomy(previousRaw, { issues: issuesState.issues })
      : defaultIssuesTaxonomy();
    const validated = validateIssuesTaxonomy(body, {
      previous,
      issues: issuesState.issues,
    });
    await writeConfigJson(key, validated);
    return validated;
  }
  if (resource === 'appearance') {
    const normalized = normalizeAppearanceConfig(body);
    normalized.updatedAt = new Date().toISOString();
    await writeConfigJson(key, normalized);
    return normalized;
  }

  await writeConfigJson(key, body);
  return body;
}

/**
 * @param {string} key
 * @param {Record<string, any>} validated
 * @param {unknown[] | undefined} rawChats
 * @param {{ deleteChatIds?: string[], pruneMissingChats?: boolean }} [options]
 */
async function mergeJsonSessionHistories(key, validated, rawChats, options = {}) {
  const stored = await readConfigJson(key);
  const storedChats = Array.isArray(stored?.chats) ? stored.chats : [];
  if (storedChats.length === 0) return validated;

  const deleted = new Set(
    (Array.isArray(options.deleteChatIds) ? options.deleteChatIds : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim()),
  );

  const storedById = new Map(
    storedChats
      .filter((chat) => chat && typeof chat.id === 'string')
      .map((chat) => [chat.id, chat]),
  );
  const rawById = new Map(
    (Array.isArray(rawChats) ? rawChats : [])
      .filter((chat) => chat && typeof chat === 'object' && typeof chat.id === 'string')
      .map((chat) => [chat.id, chat]),
  );

  const chats = [];
  const seen = new Set();
  for (const chat of Array.isArray(validated.chats) ? validated.chats : []) {
    const id = typeof chat?.id === 'string' ? chat.id : '';
    if (!id || deleted.has(id)) continue;
    seen.add(id);
    const wire = rawById.get(id);
    const omitsHistory =
      rawById.size > 0 &&
      (!wire || !Object.prototype.hasOwnProperty.call(wire, 'history'));
    if (!omitsHistory) {
      chats.push(chat);
      continue;
    }
    const prior = storedById.get(id);
    if (!prior) {
      console.warn(`[sessions] refusing to create chat ${id} from a history-omitting write`);
      continue;
    }
    chats.push({ ...chat, history: Array.isArray(prior.history) ? prior.history : [] });
  }

  if (!options.pruneMissingChats) {
    for (const chat of storedChats) {
      const id = typeof chat?.id === 'string' ? chat.id : '';
      if (id && !seen.has(id) && !deleted.has(id)) chats.push(chat);
    }
  }

  return { ...validated, chats };
}

/**
 * @param {string} resource
 * @param {unknown} body
 * @returns {Promise<{ ok: true, applied: Record<string, unknown> }>}
 */
export async function patchResource(resource, body) {
  if (resource !== 'sessions') {
    const err = new Error('PATCH is only supported for sessions');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 405;
    throw err;
  }

  if (useJsonSessionsStore()) {
    return patchJsonSessionState(body);
  }

  await ensureMinnowLayout();
  return patchSessionState(body);
}

/**
 * @param {unknown} delta
 */
async function patchJsonSessionState(delta) {
  if (!delta || typeof delta !== 'object') {
    const err = new Error('Invalid session patch');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
    throw err;
  }

  const body = /** @type {Record<string, unknown>} */ (delta);
  const baseVersion = body.baseVersion;
  if (
    baseVersion !== undefined &&
    baseVersion !== 1 &&
    baseVersion !== 2 &&
    baseVersion !== 3 &&
    baseVersion !== 4 &&
    baseVersion !== 5 &&
    baseVersion !== 6
  ) {
    const err = new Error('Invalid session baseVersion');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
    throw err;
  }

  const applied = {
    chats: 0,
    deletedChats: 0,
    groups: 0,
    deletedGroups: 0,
    scalars: false,
  };

  const current = validateSessionState(
    (await readConfigJson('sessions/state.json')) ?? defaultSessionStateJson(),
  );

  const deleteChatIds = new Set(
    Array.isArray(body.deleteChatIds)
      ? body.deleteChatIds.filter((id) => typeof id === 'string' && id.trim())
      : [],
  );
  const deleteGroupIds = new Set(
    Array.isArray(body.deleteGroupIds)
      ? body.deleteGroupIds.filter((id) => typeof id === 'string' && id.trim())
      : [],
  );

  let chats = current.chats.filter((c) => {
    if (deleteChatIds.has(c.id)) {
      applied.deletedChats += 1;
      return false;
    }
    return true;
  });

  let groups = (current.groups ?? []).filter((g) => {
    if (deleteGroupIds.has(g.id)) {
      applied.deletedGroups += 1;
      return false;
    }
    return true;
  });

  if (Array.isArray(body.chats)) {
    for (const raw of body.chats) {
      if (!raw || typeof raw !== 'object') continue;
      const chat = normalizeChatRow(raw);
      migrateChatRowV5ToV6(chat);
      const existing = chats.find((c) => c.id === chat.id);
      if (existing?.terminalHistory?.length && !chat.terminalHistory?.length) {
        chat.terminalHistory = existing.terminalHistory;
      } else if (existing?.terminalHistory?.length) {
        chat.terminalHistory = existing.terminalHistory;
      } else {
        delete chat.terminalHistory;
      }
      const idx = chats.findIndex((c) => c.id === chat.id);
      if (idx >= 0) chats[idx] = chat;
      else chats.push(chat);
      applied.chats += 1;
    }
  }

  if (Array.isArray(body.groups)) {
    for (const raw of body.groups) {
      const group = normalizeGroupRow(raw);
      if (!group?.id) continue;
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = group;
      else groups.push(group);
      applied.groups += 1;
    }
  }

  /** @type {Record<string, unknown>} */
  let next = {
    ...current,
    version: SESSION_SCHEMA_VERSION,
    chats,
    groups,
  };

  if (body.scalars && typeof body.scalars === 'object') {
    const scalars = normalizeSessionScalars(body.scalars, { mode: 'partial' });
    for (const [key, value] of Object.entries(scalars)) {
      if (value === null && (key === 'sidebarWidth' || key === 'activeBoardGroupId' || key === 'codeChangeTotalsByWorkspace')) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    applied.scalars = Object.keys(scalars).length > 0;
  }

  if (!next.chats.length) {
    const err = new Error('Session must have at least one chat');
    /** @type {Error & { statusCode?: number }} */ (err).statusCode = 400;
    throw err;
  }
  if (!next.chats.some((c) => c.id === next.activeId)) {
    next.activeId = next.chats[0].id;
  }

  const validated = validateSessionState(next);
  await writeConfigJson('sessions/state.json', validated);
  return { ok: true, applied };
}
