/**
 * Scheduled job CRUD and persistence in ~/.minnow/scheduler.json.
 * Job prompts are encrypted at rest via secret-box (#12).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMinnowLayout } from '../config/home.js';
import {
  decryptSecretPayload,
  encryptSecretPayload,
  isEncryptedSecretPayload,
} from '../security/secret-box.js';
import { computeNextRun, validateSchedule } from './schedule.js';
import { schedulerJobsPath } from './paths.js';

/** Maximum user-defined scheduled jobs. */
export const MAX_SCHEDULER_JOBS = 50;

const VALID_CHANNELS = new Set(['in_app', 'email', 'webhook']);
const VALID_MODES = new Set(['general', 'build', 'plan', 'debug']);

/** Serialize writes so tick + API cannot clobber each other. */
let writeQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} plaintext
 */
async function encryptPrompt(plaintext) {
  return encryptSecretPayload(plaintext);
}

/**
 * @param {unknown} envelope
 */
async function decryptPrompt(envelope) {
  if (!isEncryptedSecretPayload(envelope)) {
    throw new Error('Job prompt is missing or corrupt');
  }
  return decryptSecretPayload(envelope);
}

/**
 * @param {object} stored
 */
async function toPublicJob(stored) {
  const prompt = await decryptPrompt(stored.promptEnc);
  return {
    id: stored.id,
    label: stored.label,
    enabled: Boolean(stored.enabled),
    schedule: stored.schedule,
    prompt,
    modeId: stored.modeId,
    workAgentId: stored.workAgentId ?? undefined,
    providerId: stored.providerId ?? undefined,
    modelId: stored.modelId ?? undefined,
    workspacePath: stored.workspacePath ?? undefined,
    channels: Array.isArray(stored.channels) ? [...stored.channels] : ['in_app'],
    lastRunAt: stored.lastRunAt ?? undefined,
    nextRunAt: stored.nextRunAt ?? undefined,
    running: Boolean(stored.running),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/**
 * @param {object} input
 * @param {string} [existingId]
 */
async function normalizeJobInput(input, existingId) {
  if (!isObject(input)) {
    throw new Error('Job body must be an object');
  }

  const label = String(input.label ?? '').trim();
  if (!label) {
    throw new Error('label is required');
  }

  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const schedule = validateSchedule(input.schedule);
  const modeId = String(input.modeId ?? 'build').trim().toLowerCase();
  if (!VALID_MODES.has(modeId)) {
    throw new Error(`modeId must be one of: ${[...VALID_MODES].join(', ')}`);
  }

  const channels = Array.isArray(input.channels) ? input.channels : ['in_app'];
  const normalizedChannels = channels.map((c) => String(c).trim()).filter(Boolean);
  if (normalizedChannels.length === 0) {
    throw new Error('At least one delivery channel is required');
  }
  for (const channel of normalizedChannels) {
    if (!VALID_CHANNELS.has(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    if (channel !== 'in_app') {
      throw new Error('Only in_app delivery is supported in v1');
    }
  }

  const now = new Date().toISOString();
  const promptEnc = await encryptPrompt(prompt);

  const job = {
    id: existingId ?? randomUUID(),
    label,
    enabled: input.enabled !== false,
    schedule,
    promptEnc,
    modeId,
    workAgentId: input.workAgentId ? String(input.workAgentId).trim() : undefined,
    providerId: input.providerId ? String(input.providerId).trim() : undefined,
    modelId: input.modelId ? String(input.modelId).trim() : undefined,
    workspacePath: input.workspacePath ? String(input.workspacePath).trim() : undefined,
    channels: normalizedChannels,
    lastRunAt: input.lastRunAt ?? undefined,
    nextRunAt: input.nextRunAt ?? undefined,
    running: Boolean(input.running),
    createdAt: existingId ? String(input.createdAt ?? now) : now,
    updatedAt: now,
  };

  job.nextRunAt = computeNextRun(job);
  return job;
}

async function readStoreUnlocked() {
  await ensureMinnowLayout();
  const filePath = schedulerJobsPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      return { version: 1, jobs: [] };
    }
    return {
      version: parsed.version ?? 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

/**
 * @param {{ version: number; jobs: object[] }} store
 */
async function writeStoreUnlocked(store) {
  const filePath = schedulerJobsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, filePath);
}

/** List all jobs with decrypted prompts for the local settings UI. */
export async function listJobs() {
  const store = await readStoreUnlocked();
  const jobs = [];
  for (const stored of store.jobs) {
    jobs.push(await toPublicJob(stored));
  }
  return jobs;
}

/** @param {string} id */
export async function getJobById(id) {
  const store = await readStoreUnlocked();
  const stored = store.jobs.find((job) => job.id === id);
  if (!stored) return null;
  return toPublicJob(stored);
}

/** @param {object} input */
export async function createJob(input) {
  return withWriteLock(async () => {
    const store = await readStoreUnlocked();
    if (store.jobs.length >= MAX_SCHEDULER_JOBS) {
      throw new Error(`Maximum of ${MAX_SCHEDULER_JOBS} scheduled jobs reached`);
    }
    const job = await normalizeJobInput(input);
    store.jobs.push(job);
    await writeStoreUnlocked(store);
    return toPublicJob(job);
  });
}

/** @param {string} id @param {object} input */
export async function updateJob(id, input) {
  return withWriteLock(async () => {
    const store = await readStoreUnlocked();
    const index = store.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error('Job not found');
    }
    const existing = store.jobs[index];
    const merged = {
      ...existing,
      ...input,
      id,
      createdAt: existing.createdAt,
      schedule: input.schedule ?? existing.schedule,
      prompt: input.prompt ?? (await decryptPrompt(existing.promptEnc)),
      running: existing.running,
      lastRunAt: existing.lastRunAt,
    };
    const job = await normalizeJobInput(merged, id);
    job.lastRunAt = existing.lastRunAt;
    job.running = existing.running;
    if (!input.schedule && existing.nextRunAt && !existing.running) {
      job.nextRunAt = existing.nextRunAt;
    }
    store.jobs[index] = job;
    await writeStoreUnlocked(store);
    return toPublicJob(job);
  });
}

/** @param {string} id */
export async function deleteJob(id) {
  return withWriteLock(async () => {
    const store = await readStoreUnlocked();
    const nextJobs = store.jobs.filter((job) => job.id !== id);
    if (nextJobs.length === store.jobs.length) {
      throw new Error('Job not found');
    }
    store.jobs = nextJobs;
    await writeStoreUnlocked(store);
    return { ok: true };
  });
}

/**
 * Internal raw job read for runner (includes encrypted prompt envelope).
 * @param {string} id
 */
export async function getStoredJobById(id) {
  const store = await readStoreUnlocked();
  return store.jobs.find((job) => job.id === id) ?? null;
}

/**
 * @param {string} id
 * @param {(stored: object) => object | Promise<object>} mutator
 */
export async function mutateStoredJob(id, mutator) {
  return withWriteLock(async () => {
    const store = await readStoreUnlocked();
    const index = store.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error('Job not found');
    }
    const next = await mutator({ ...store.jobs[index] });
    store.jobs[index] = next;
    await writeStoreUnlocked(store);
    return next;
  });
}

/** Recompute nextRunAt for all enabled jobs after server restart. */
export async function recomputeAllNextRuns() {
  return withWriteLock(async () => {
    const store = await readStoreUnlocked();
    const now = new Date();
    let changed = false;
    store.jobs = store.jobs.map((job) => {
      if (!job.enabled || job.running) {
        return job;
      }
      const nextRunAt = computeNextRun(job, now);
      if (nextRunAt === job.nextRunAt) {
        return job;
      }
      changed = true;
      return { ...job, nextRunAt, updatedAt: now.toISOString() };
    });
    if (changed) {
      await writeStoreUnlocked(store);
    }
    return store.jobs.length;
  });
}
