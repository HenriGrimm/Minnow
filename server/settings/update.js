/**
 * Apply validated settings patches to server-backed storage.
 */

import { readResource, writeResource } from '../config/store.js';
import {
  clampGenerationIdleTimeoutMs,
  clampGenerationMaxDurationMs,
} from '../generations/timeouts.js';
import { mergeConfigMeta } from '../config/validators.js';
import { getFieldByKey } from './registry.js';
import { patchFromPath } from './paths.js';
import { readSettingsByKeys } from './read.js';

/** @param {unknown} value */
function isConfirmed(value) {
  return value === true || value === 'true';
}

/**
 * @param {import('../../src/settings/types.ts').SettingsFieldDef} field
 * @param {unknown} value
 */
function validateFieldValue(field, value) {
  if (field.allowedValues && field.allowedValues.length > 0) {
    const str = String(value);
    if (!field.allowedValues.includes(str)) {
      return `Invalid value for ${field.label}. Allowed: ${field.allowedValues.join(', ')}`;
    }
  }

  if (field.type === 'boolean' && typeof value !== 'boolean') {
    return `${field.label} requires a boolean value.`;
  }

  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      return `${field.label} requires a number.`;
    }
  }

  if (field.path === 'chat.generationIdleTimeoutMs') clampGenerationIdleTimeoutMs(value);
  if (field.path === 'chat.generationMaxDurationMs') clampGenerationMaxDurationMs(value);

  return null;
}

/**
 * @param {import('../../src/settings/types.ts').SettingsFieldDef} field
 * @param {unknown} value
 */
function coerceValue(field, value) {
  if (field.type === 'boolean') return Boolean(value);
  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (field.path === 'chat.generationIdleTimeoutMs') return clampGenerationIdleTimeoutMs(n);
    if (field.path === 'chat.generationMaxDurationMs') return clampGenerationMaxDurationMs(n);
    return n;
  }
  if (field.type === 'enum' || field.type === 'string') return String(value);
  return value;
}

/** Map browser storage paths to clientPatches keys. */
const BROWSER_PATCH_MAP = {
  enabled: 'notifications.enabled',
  chatEnabled: 'notifications.chatEnabled',
  tasksEnabled: 'notifications.tasksEnabled',
  backgroundEnabled: 'notifications.backgroundEnabled',
  soundEnabled: 'notifications.soundEnabled',
  soundOnActiveChat: 'notifications.soundOnActiveChat',
  osEnabled: 'notifications.osEnabled',
  soundPackId: 'notifications.soundPackId',
  themeFamily: 'theme.family',
  themeMode: 'theme.mode',
  fileErrorsToIssues: 'diagnostics.fileErrorsToIssues',
};

/**
 * @param {import('../../src/settings/types.ts').SettingsChangePatch[]} changes
 * @param {boolean} confirmed
 */
export async function updateSettings(changes, confirmed = false) {
  /** @type {import('../../src/settings/types.ts').SettingsChangePatch[]} */
  const applied = [];
  /** @type {{ key: string; reason: string }[]} */
  const skipped = [];
  /** @type {{ key: string; error: string }[]} */
  const errors = [];
  /** @type {Record<string, unknown>} */
  const clientPatches = {};

  /** @type {Record<string, unknown>} */
  const metaPatch = {};
  /** @type {Map<string, Record<string, unknown>>} */
  const resourcePatches = new Map();

  for (const change of changes) {
    const key = String(change?.key ?? '').trim();
    const field = getFieldByKey(key);
    if (!field) {
      errors.push({ key, error: `Unknown settings key: ${key}` });
      continue;
    }
    if (!field.writable) {
      skipped.push({ key, reason: 'Field is not writable via agent tools.' });
      continue;
    }

    if (field.sensitivity === 'secret' || field.sensitivity === 'dangerous') {
      if (!confirmed) {
        errors.push({
          key,
          error: `Field "${field.label}" requires confirmed: true after user approval.`,
        });
        continue;
      }
    }

    const validationError = validateFieldValue(field, change.value);
    if (validationError) {
      errors.push({ key, error: validationError });
      continue;
    }

    const coerced = coerceValue(field, change.value);

    if (field.storage === 'browser') {
      const patchKey = field.path ? BROWSER_PATCH_MAP[field.path] : undefined;
      if (patchKey) {
        clientPatches[patchKey] = coerced;
        applied.push({ key, value: coerced });
      } else {
        skipped.push({ key, reason: 'Browser field not yet supported for agent writes.' });
      }
      continue;
    }

    if (field.storage === 'section') {
      skipped.push({ key, reason: 'Section header — no value to write.' });
      continue;
    }

    if (!field.path) {
      errors.push({ key, error: 'Missing storage path.' });
      continue;
    }

    if (field.storage === 'meta') {
      const nested = patchFromPath(field.path, coerced);
      Object.assign(metaPatch, deepMerge(metaPatch, nested));
      applied.push({ key, value: coerced });
      continue;
    }

    if (field.storage === 'resource') {
      const resource = field.resource;
      if (!resource) {
        errors.push({ key, error: 'Missing resource name.' });
        continue;
      }
      const existing = resourcePatches.get(resource) ?? {};
      const nested = patchFromPath(field.path, coerced);
      resourcePatches.set(resource, deepMerge(existing, nested));
      applied.push({ key, value: coerced });
      continue;
    }

    errors.push({ key, error: `Storage kind "${field.storage}" is not yet supported for writes.` });
  }

  if (Object.keys(metaPatch).length > 0) {
    try {
      const existing = await readResource('meta');
      const merged = mergeConfigMeta(existing, metaPatch);
      await writeResource('meta', merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        applied: [],
        skipped,
        errors: [...errors, { key: 'meta', error: message }],
        clientPatches: Object.keys(clientPatches).length ? clientPatches : undefined,
      };
    }
  }

  for (const [resource, patch] of resourcePatches) {
    try {
      const existing = await readResource(resource);
      const merged = deepMerge(
        /** @type {Record<string, unknown>} */ (existing),
        patch,
      );
      await writeResource(resource, merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ key: resource, error: message });
    }
  }

  return {
    applied,
    skipped,
    errors,
    clientPatches: Object.keys(clientPatches).length ? clientPatches : undefined,
  };
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function deepMerge(target, source) {
  /** @type {Record<string, unknown>} */
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(
        /** @type {Record<string, unknown>} */ (out[key]),
        /** @type {Record<string, unknown>} */ (value),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {import('../../src/settings/types.ts').SettingsChangePatch[]} changes
 */
export async function buildSettingsApprovalDiff(changes) {
  const keys = changes.map((c) => String(c.key));
  const { values: current } = await readSettingsByKeys(keys);
  const currentMap = new Map(current.map((v) => [v.key, v]));

  const lines = [];
  for (const change of changes) {
    const field = getFieldByKey(change.key);
    if (!field) continue;
    const prev = currentMap.get(change.key);
    const oldVal = prev?.redacted ? '[redacted]' : formatDiffValue(prev?.value);
    const newVal =
      field.sensitivity === 'secret'
        ? '(set new secret value)'
        : formatDiffValue(change.value);
    lines.push(`${field.label}: ${oldVal} → ${newVal}`);
  }
  return lines;
}

/** @param {unknown} value */
function formatDiffValue(value) {
  if (value === undefined || value === null) return '(unset)';
  if (typeof value === 'string') return value || '(empty)';
  return JSON.stringify(value);
}

/** @param {unknown} args */
export function parseUpdateSettingsArgs(args) {
  const rawChanges = Array.isArray(args?.changes) ? args.changes : [];
  /** @type {import('../../src/settings/types.ts').SettingsChangePatch[]} */
  const changes = [];
  for (const item of rawChanges) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const key = String(row.key ?? '').trim();
    if (!key) continue;
    changes.push({ key, value: row.value });
  }
  const confirmed = isConfirmed(args?.confirmed);
  return { changes, confirmed };
}
