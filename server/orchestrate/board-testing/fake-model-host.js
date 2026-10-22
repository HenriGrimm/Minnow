/**
 * In-process singleton for the orchestrate fake model HTTP server.
 */

import {
  createFakeModelServer,
  normalizeScenario,
} from '../../../scripts/fake-model-server.mjs';
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from './fake-model-ids.js';
import { createProvider, listProviders, updateProvider } from '../../providers/store.js';
import { sanitizeFakeModelRequest } from './sanitize.js';

/** @type {{ fake: ReturnType<typeof createFakeModelServer>; port: number; baseUrl: string } | null} */
let active = null;
/** @type {Array<{ match?: { role?: string; taskId?: string; nth?: number }; emit: string[] }>} */
let configuredScenario = [];

/**
 * Validate more strictly than the CLI parser because this accepts remote input.
 * @param {unknown} raw
 */
function validateScenario(raw) {
  const steps = normalizeScenario(raw);
  if (steps.length > 1_000) throw new Error('scenario may contain at most 1000 steps');
  return steps.map((step, index) => {
    const match = step.match ?? {};
    const allowed = new Set(['role', 'taskId', 'nth']);
    for (const key of Object.keys(match)) {
      if (!allowed.has(key)) throw new Error(`scenario step ${index} has unknown match field: ${key}`);
    }
    if (match.role != null && (typeof match.role !== 'string' || !match.role.trim())) {
      throw new Error(`scenario step ${index} match.role must be a non-empty string`);
    }
    if (match.taskId != null && (typeof match.taskId !== 'string' || !match.taskId.trim())) {
      throw new Error(`scenario step ${index} match.taskId must be a non-empty string`);
    }
    if (
      match.nth != null &&
      (!Number.isSafeInteger(match.nth) || /** @type {number} */ (match.nth) < 0)
    ) {
      throw new Error(`scenario step ${index} match.nth must be a non-negative integer`);
    }
    if (
      step.emit.length === 0 ||
      step.emit.length > 1_000 ||
      step.emit.some((chunk) => typeof chunk !== 'string')
    ) {
      throw new Error(`scenario step ${index} emit must be a non-empty string array`);
    }
    const bytes = step.emit.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    if (bytes > 1_000_000) throw new Error(`scenario step ${index} emit exceeds 1 MB`);
    return {
      match: {
        ...(match.role == null ? {} : { role: match.role.trim() }),
        ...(match.taskId == null ? {} : { taskId: match.taskId.trim() }),
        ...(match.nth == null ? {} : { nth: match.nth }),
      },
      emit: [...step.emit],
    };
  });
}

/**
 * @param {string} baseUrl
 */
async function registerFakeProvider(baseUrl) {
  const body = {
    id: FAKE_PROVIDER_ID,
    label: 'Fake board model',
    baseUrl,
    apiKind: 'openai-v1',
  };
  const { providers } = await listProviders();
  if (providers.some((p) => p.id === FAKE_PROVIDER_ID)) {
    await updateProvider(FAKE_PROVIDER_ID, body);
    return;
  }
  await createProvider(body);
}

/** @returns {{ running: boolean; port: number | null; baseUrl: string | null; requestCount: number; modelId: string; providerId: string }} */
export function getFakeModelStatus() {
  if (!active) {
    return {
      running: false,
      port: null,
      baseUrl: null,
      requestCount: 0,
      scenarioStepCount: configuredScenario.length,
      modelId: FAKE_MODEL_ID,
      providerId: FAKE_PROVIDER_ID,
    };
  }
  return {
    running: true,
    port: active.port,
    baseUrl: active.baseUrl,
    requestCount: active.fake.requests.length,
    scenarioStepCount: configuredScenario.length,
    modelId: FAKE_MODEL_ID,
    providerId: FAKE_PROVIDER_ID,
  };
}

/** Default listen port for the in-process fake model host. */
const DEFAULT_PORT = 18765;

/** Clear per-(role, taskId) turn counters so a new board run gets fresh nth=0 responses. */
export function resetFakeModelScenario() {
  active?.fake.reset();
}

/**
 * Replace the scenario in-place so a running fake server observes it immediately.
 * @param {unknown} raw
 */
export function configureFakeModelScenario(raw) {
  const steps = validateScenario(raw);
  configuredScenario.splice(0, configuredScenario.length, ...steps);
  active?.fake.reset();
  return {
    stepCount: configuredScenario.length,
    steps: structuredClone(configuredScenario),
  };
}

export function getFakeModelScenario() {
  return {
    stepCount: configuredScenario.length,
    steps: structuredClone(configuredScenario),
  };
}

/** @param {{ limit?: number }} [options] */
export function getFakeModelRequestTail(options = {}) {
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  if (!active) return [];
  return active.fake.requests
    .slice(-limit)
    .map(sanitizeFakeModelRequest)
    .filter(Boolean);
}

/**
 * @param {{ port?: number }} [options]
 */
export async function startFakeModel(options = {}) {
  if (active) {
    await stopFakeModel();
  }

  const fake = createFakeModelServer({ scenario: configuredScenario, verificationContracts: true });
  fake.reset();
  const port = options.port ?? DEFAULT_PORT;
  const resolvedPort = await fake.listen(port);
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;
  await registerFakeProvider(baseUrl);
  active = { fake, port: resolvedPort, baseUrl };
  return getFakeModelStatus();
}

export async function stopFakeModel() {
  if (!active) {
    return getFakeModelStatus();
  }
  active.fake.reset();
  await active.fake.close();
  active = null;
  return getFakeModelStatus();
}
