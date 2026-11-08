/**
 * CRUD and lifecycle for ~/.minnow/profiles/*.json setup bundles.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureMinnowLayout, getMinnowHome } from '../config/home.js';
import { readConfigJson, writeConfigJson } from '../config/store.js';
import { mergeConfigMeta, normalizeWorkspacePath } from '../config/validators.js';
import { listPromptConfigs, loadPromptConfigFile } from '../prompt-configs/handlers.js';
import { validateProfileBundle } from './validate.js';
import {
  applyProfileBundle,
  captureCurrentSettings,
  saveRollbackSnapshot,
} from './apply.js';

function profilesDir() {
  return path.join(getMinnowHome(), 'profiles');
}

function profilePath(id) {
  return path.join(profilesDir(), `${id}.json`);
}

/**
 * @returns {Promise<Array<{ id: string, label: string, updatedAt?: string }>>}
 */
export async function listProfiles() {
  await ensureMinnowLayout();
  const dir = profilesDir();
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const items = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (id.startsWith('_')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw);
      items.push({
        id: parsed.id ?? id,
        label: typeof parsed.label === 'string' ? parsed.label : id,
        updatedAt: parsed.meta?.updatedAt,
      });
    } catch {
      items.push({ id, label: id });
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/**
 * @param {string} id
 */
export async function loadProfileFile(id) {
  await ensureMinnowLayout();
  try {
    const raw = await fs.readFile(profilePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * @param {object} bundle
 */
export async function saveProfileFile(bundle) {
  const validated = validateProfileBundle(bundle);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  await ensureMinnowLayout();
  const id = validated.bundle.id;
  const now = new Date().toISOString();
  const existing = (await loadProfileFile(id)) ?? {};
  const toWrite = {
    ...validated.bundle,
    schemaVersion: 1,
    meta: {
      createdAt: existing.meta?.createdAt ?? now,
      updatedAt: now,
      ...(validated.bundle.meta && typeof validated.bundle.meta === 'object'
        ? validated.bundle.meta
        : {}),
    },
  };

  const full = profilePath(id);
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, full);
  return toWrite;
}

/**
 * @param {string} id
 */
export async function deleteProfileFile(id) {
  const meta = (await readConfigJson('config.json')) ?? {};
  if (meta.activeSetupProfileId === id) {
    throw new Error('Cannot delete the active setup profile; apply another profile first');
  }
  const workspaceProfiles =
    meta.workspaceProfiles && typeof meta.workspaceProfiles === 'object'
      ? meta.workspaceProfiles
      : {};
  for (const mapped of Object.values(workspaceProfiles)) {
    if (mapped === id) {
      throw new Error('Cannot delete a profile used as a workspace default; clear the mapping first');
    }
  }

  try {
    await fs.unlink(profilePath(id));
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * @param {string} sourceId
 * @param {string} newId
 * @param {string} [newLabel]
 */
export async function duplicateProfileFile(sourceId, newId, newLabel) {
  const source = await loadProfileFile(sourceId);
  if (!source) {
    throw new Error('Source profile not found');
  }
  const copy = {
    ...source,
    id: newId,
    label: newLabel ?? `${source.label} (copy)`,
    meta: {
      ...source.meta,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  return saveProfileFile(copy);
}

/**
 * @param {string} id
 * @param {{ saveRollback?: boolean }} [options]
 */
export async function activateProfile(id, options = {}) {
  const bundle = await loadProfileFile(id);
  if (!bundle) {
    throw new Error('Profile not found');
  }
  const validated = validateProfileBundle(bundle);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  let previousSnapshotId;
  if (options.saveRollback !== false) {
    previousSnapshotId = await saveRollbackSnapshot(bundle);
  }

  const { appliedAt } = await applyProfileBundle(validated.bundle);
  return {
    ok: true,
    appliedAt,
    previousSnapshotId,
    invalidate: ['prompt-meta', 'tools', 'work-agents', 'sub-agents', 'rules', 'skills'],
  };
}

/**
 * @param {object} body — { id?, label?, description? } or full bundle
 */
export async function captureProfile(body) {
  const id =
    typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : `capture-${Date.now()}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim()
      : 'Captured setup';
  const description = typeof body.description === 'string' ? body.description : '';

  const bundle = await captureCurrentSettings(id, label, description);
  const existing = await loadProfileFile(id);
  if (existing?.meta?.createdAt) {
    bundle.meta.createdAt = existing.meta.createdAt;
  }
  return saveProfileFile(bundle);
}

/**
 * @param {unknown} body
 * @param {'create'|'replace'} mode
 */
export async function importProfileBundle(body, mode = 'create') {
  const rawBundle =
    body && typeof body === 'object' && 'bundle' in /** @type {object} */ (body)
      ? /** @type {{ bundle: unknown }} */ (body).bundle
      : body;

  const validated = validateProfileBundle(rawBundle);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const id = validated.bundle.id;
  const exists = await loadProfileFile(id);
  if (exists && mode !== 'replace') {
    throw new Error(`Profile "${id}" already exists; use mode replace to overwrite`);
  }

  return saveProfileFile(validated.bundle);
}

/**
 * One-shot migration from prompt-configs/*.json into profiles/.
 */
export async function migrateFromPromptConfigs() {
  const configs = await listPromptConfigs();
  const migrated = [];

  for (const item of configs) {
    const cfg = await loadPromptConfigFile(item.id);
    if (!cfg) continue;

    const bundle = {
      id: item.id,
      label: cfg.label ?? item.id,
      schemaVersion: 1,
      meta: {
        description: 'Migrated from prompt-config',
        createdAt: cfg.meta?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      prompt: {
        promptProfile: 'custom',
        activePromptConfigId: item.id,
        activeInfoPresetId: 'general-assistant',
        planGranularity: 'medium',
        source: 'embedded',
        parts: cfg.parts ?? {},
      },
      agents: { workAgents: {}, subAgents: {} },
      tools: {},
    };

    await saveProfileFile(bundle);
    migrated.push(item.id);
  }

  return { ok: true, migrated };
}

/**
 * @param {string} workspacePath
 * @param {string|null} profileId
 */
export async function setWorkspaceProfileDefault(workspacePath, profileId) {
  const key = normalizeWorkspacePath(path.resolve(workspacePath));
  const meta = (await readConfigJson('config.json')) ?? {};
  const map =
    meta.workspaceProfiles && typeof meta.workspaceProfiles === 'object'
      ? { ...meta.workspaceProfiles }
      : {};

  if (profileId === null || profileId === '') {
    delete map[key];
  } else {
    const exists = await loadProfileFile(profileId);
    if (!exists) {
      throw new Error('Profile not found');
    }
    map[key] = profileId;
  }

  const merged = mergeConfigMeta(meta, { workspaceProfiles: map });
  await writeConfigJson('config.json', merged);
  return { workspacePath: key, profileId: profileId || null };
}

/**
 * Apply workspace default profile when auto-apply is enabled.
 * @param {string} workspacePath
 */
export async function maybeAutoApplyWorkspaceProfile(workspacePath) {
  const meta = (await readConfigJson('config.json')) ?? {};
  if (meta.workspaceProfileAutoApply !== true) {
    return { skipped: true, reason: 'auto-apply disabled' };
  }

  const key = normalizeWorkspacePath(path.resolve(workspacePath));
  const map =
    meta.workspaceProfiles && typeof meta.workspaceProfiles === 'object'
      ? meta.workspaceProfiles
      : {};
  const profileId = map[key];
  if (!profileId || typeof profileId !== 'string') {
    return { skipped: true, reason: 'no mapping' };
  }

  const result = await activateProfile(profileId, { saveRollback: true });
  return { skipped: false, ...result, profileId };
}
