/** Persistent local ACP agent registrations with encrypted per-agent environment. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import {
  readEncryptedJsonFile,
  writeEncryptedJsonFile,
} from '../security/secret-box.js';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGS = 64;

function rootDir() {
  return path.join(getMinnowHome(), 'acp', 'agents');
}

function validateId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new Error('ACP agent id must use 1-64 lowercase letters, numbers, or hyphens');
  }
  return id;
}

function agentDir(id) {
  return path.join(rootDir(), validateId(id));
}

function normalizeArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw new Error(`ACP agent args must be an array of at most ${MAX_ARGS} strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 4096) {
      throw new Error('ACP agent args must be strings without null bytes');
    }
    return entry;
  });
}

function normalizeSecretEnv(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACP private environment must be an object');
  }
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey).trim();
    if (!ENV_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (typeof rawValue !== 'string' || rawValue.includes('\0') || rawValue.length > 16_384) {
      throw new Error(`Environment value for ${key} must be a bounded string`);
    }
    if (rawValue) out[key] = rawValue;
  }
  return out;
}

function normalizeProfile(input, current = null) {
  const id = validateId(input.id ?? current?.id);
  const label = String(input.label ?? current?.label ?? id).trim();
  const command = String(input.command ?? current?.command ?? '').trim();
  if (!label || label.length > 120) throw new Error('ACP agent label is required');
  if (!command || command.length > 2048 || command.includes('\0')) {
    throw new Error('ACP agent command is required and must not contain null bytes');
  }
  const now = new Date().toISOString();
  return {
    id,
    label,
    command,
    args: normalizeArgs(input.args ?? current?.args ?? []),
    enabled: input.enabled === undefined ? current?.enabled !== false : input.enabled === true,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    ...(current?.lastValidation ? { lastValidation: current.lastValidation } : {}),
  };
}

async function readProfile(id) {
  const file = path.join(agentDir(id), 'profile.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readSecrets(id) {
  const file = path.join(agentDir(id), 'secrets.json');
  try {
    const value = await readEncryptedJsonFile(file, { env: {} });
    return { env: normalizeSecretEnv(value?.env) ?? {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { env: {} };
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function toPublic(profile, secrets) {
  return {
    ...profile,
    envKeys: Object.keys(secrets.env).sort(),
    hasPrivateEnvironment: Object.keys(secrets.env).length > 0,
  };
}

export async function listAcpAgents() {
  let entries;
  try {
    entries = await fs.readdir(rootDir(), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    try {
      const [profile, secrets] = await Promise.all([
        readProfile(entry.name),
        readSecrets(entry.name),
      ]);
      rows.push(toPublic(profile, secrets));
    } catch {}
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

export async function getAcpAgentRuntime(id) {
  const safeId = validateId(id);
  const [profile, secrets] = await Promise.all([readProfile(safeId), readSecrets(safeId)]);
  return { profile, secrets };
}

export async function saveAcpAgent(input) {
  const id = validateId(input?.id);
  let current = null;
  try {
    current = await readProfile(id);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const currentSecrets = await readSecrets(id);
  const profile = normalizeProfile(input, current);
  const secretEnv = normalizeSecretEnv(input.secretEnv);
  const secrets = secretEnv === undefined ? currentSecrets : { env: secretEnv };
  const dir = agentDir(id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(path.join(dir, 'profile.json'), profile);
  await writeEncryptedJsonFile(path.join(dir, 'secrets.json'), secrets);
  try {
    await fs.chmod(path.join(dir, 'secrets.json'), 0o600);
  } catch {}
  return toPublic(profile, secrets);
}

export async function recordAcpValidation(id, validation) {
  const { profile, secrets } = await getAcpAgentRuntime(id);
  const next = {
    ...profile,
    lastValidation: {
      ok: validation.ok === true,
      checkedAt: new Date().toISOString(),
      ...(validation.protocolVersion != null
        ? { protocolVersion: validation.protocolVersion }
        : {}),
      ...(validation.agentInfo ? { agentInfo: validation.agentInfo } : {}),
      ...(validation.error ? { error: String(validation.error).slice(0, 500) } : {}),
    },
  };
  await atomicWriteJson(path.join(agentDir(id), 'profile.json'), next);
  return toPublic(next, secrets);
}

export async function deleteAcpAgent(id) {
  const dir = agentDir(id);
  await fs.rm(dir, { recursive: true, force: true });
}

export const __acpStoreInternals = { validateId, normalizeArgs, normalizeSecretEnv };
