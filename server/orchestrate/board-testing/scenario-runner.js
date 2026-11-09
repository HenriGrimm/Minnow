/**
 * Persisted board scenario run records and an injectable execution boundary.
 *
 * The default manager deliberately has no product driver. Starting it records a
 * harness_error; it never fabricates board convergence.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../../config/home.js';
import { getFakeModelStatus } from './fake-model-host.js';
import { sanitizeDiagnosticValue } from './sanitize.js';
import { importTsModule } from './ts-import.js';

const RUN_ID_RE = /^run_[a-zA-Z0-9_-]{8,100}$/;
const SCENARIO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const MAX_ITERATIONS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_INPUT_BYTES = 2_000_000;
const PASSING_CLASSIFICATIONS = new Set(['pass', 'expected_blocked']);
const RESULT_CLASSIFICATIONS = new Set([
  'pass',
  'expected_blocked',
  'unexpected_blocked',
  'product_failure',
  'timeout',
  'harness_error',
  'stopped',
]);
const CLASSIFICATION_SEVERITY = new Map([
  ['pass', 0],
  ['expected_blocked', 1],
  ['stopped', 2],
  ['unexpected_blocked', 3],
  ['product_failure', 4],
  ['timeout', 5],
  ['harness_error', 6],
]);
const ARTIFACTS = [
  { name: 'manifest', path: 'manifest.json', mediaType: 'application/json' },
  { name: 'iterations', path: 'iterations.jsonl', mediaType: 'application/x-ndjson' },
  { name: 'scenario', path: 'scenario.json', mediaType: 'application/json' },
  { name: 'board-log', path: 'board-log.jsonl', mediaType: 'application/x-ndjson' },
  {
    name: 'fake-model-requests',
    path: 'fake-model-requests.jsonl',
    mediaType: 'application/x-ndjson',
  },
  { name: 'final-state', path: 'final-state.json', mediaType: 'application/json' },
];

function runsRoot() {
  return path.join(getMinnowHome(), 'logs', 'orchestrate-scenarios');
}

/** @param {string} id */
function assertRunId(id) {
  if (!RUN_ID_RE.test(id)) throw new Error('invalid run id');
  return id;
}

/** @param {string} id */
function runDir(id) {
  return path.join(runsRoot(), assertRunId(id));
}

/**
 * Windows runners can briefly lock the destination during rename (AV/indexers).
 * @param {string} src
 * @param {string} dest
 */
async function renameAtomicWithRetry(src, dest) {
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

/** @param {string} filePath @param {unknown} value */
async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await renameAtomicWithRetry(temporary, filePath);
}

/** @param {string} filePath @param {unknown} value */
async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

/** @param {Promise<unknown>} promise @param {number} timeoutMs */
async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} value */
function seedFromString(value) {
  return crypto.createHash('sha256').update(value).digest().readUInt32LE(0);
}

/** @param {unknown} raw */
async function validatePrepareInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('run configuration must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_INPUT_BYTES) {
    throw new Error('run configuration exceeds 2 MB');
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  let scenario = input.scenario;
  if (typeof scenario === 'string') {
    try {
      scenario = JSON.parse(scenario);
    } catch {
      throw new Error('scenario must contain valid JSON');
    }
  }
  if (scenario == null && Array.isArray(input.steps)) {
    scenario = {
      id: typeof input.scenarioId === 'string' ? input.scenarioId : 'custom',
      steps: input.steps,
    };
  }
  const { getBoardScenario } = await importTsModule(
    '../../../src/dev/orchestrate-scenarios/catalog.ts',
  );
  const { parseBoardScenario } = await importTsModule(
    '../../../src/dev/orchestrate-scenarios/schema.ts',
  );
  if (scenario == null && typeof input.scenarioId === 'string') {
    scenario = getBoardScenario(input.scenarioId);
    if (!scenario) throw new Error(`unknown board scenario: ${input.scenarioId}`);
  }
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error('scenario must be a JSON object, or steps must be an array');
  }
  const scenarioRecord = /** @type {Record<string, unknown>} */ (scenario);
  const gateMeta = scenarioRecord.gate;
  const { gate: _gate, ...scenarioForValidation } = scenarioRecord;
  const legacySteps = Array.isArray(scenarioRecord.steps);
  const cleanScenario = legacySteps
    ? structuredClone(scenarioRecord)
    : parseBoardScenario(scenarioForValidation);
  if (gateMeta !== undefined) {
    cleanScenario.gate = structuredClone(gateMeta);
  }
  const scenarioId =
    typeof cleanScenario.id === 'string'
      ? cleanScenario.id.trim()
      : typeof input.scenarioId === 'string'
        ? input.scenarioId.trim()
        : 'custom';
  if (!SCENARIO_ID_RE.test(scenarioId)) {
    throw new Error('scenario id must be a safe identifier');
  }
  cleanScenario.id = scenarioId;
  if (legacySteps && !Array.isArray(cleanScenario.steps)) throw new Error('scenario.steps must be an array');

  const iterations = input.iterations ?? 1;
  if (
    !Number.isSafeInteger(iterations) ||
    /** @type {number} */ (iterations) < 1 ||
    /** @type {number} */ (iterations) > MAX_ITERATIONS
  ) {
    throw new Error(`iterations must be an integer between 1 and ${MAX_ITERATIONS}`);
  }
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    /** @type {number} */ (timeoutMs) < MIN_TIMEOUT_MS ||
    /** @type {number} */ (timeoutMs) > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  const seed =
    input.seed ??
    (typeof cleanScenario.seed === 'string'
      ? seedFromString(cleanScenario.seed)
      : crypto.randomBytes(4).readUInt32LE(0));
  if (!Number.isSafeInteger(seed) || /** @type {number} */ (seed) < 0) {
    throw new Error('seed must be a non-negative safe integer');
  }
  if (
    input.execution !== undefined &&
    input.execution !== 'internal' &&
    input.execution !== 'external'
  ) {
    throw new Error('execution must be "internal" or "external"');
  }
  return {
    scenario: cleanScenario,
    scenarioId,
    iterations: /** @type {number} */ (iterations),
    timeoutMs: /** @type {number} */ (timeoutMs),
    seed: /** @type {number} */ (seed) >>> 0,
    failFast: input.failFast === true,
    execution: input.execution ?? 'internal',
  };
}

/** @param {number} baseSeed @param {number} index */
export function deriveIterationSeed(baseSeed, index) {
  return (baseSeed + Math.imul(index, 0x9e3779b9)) >>> 0;
}

/** @param {unknown} raw */
function normalizeDriverResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('driver must return a result object with classification');
  }
  const result = /** @type {Record<string, unknown>} */ (raw);
  if (
    typeof result.classification !== 'string' ||
    !RESULT_CLASSIFICATIONS.has(result.classification)
  ) {
    throw new Error(
      `driver classification must be one of: ${[...RESULT_CLASSIFICATIONS].join(', ')}`,
    );
  }
  return result;
}

/** @param {string | null} current @param {string} next */
function aggregateClassification(current, next) {
  if (!current) return next;
  return (CLASSIFICATION_SEVERITY.get(next) ?? 99) >
    (CLASSIFICATION_SEVERITY.get(current) ?? 99)
    ? next
    : current;
}

/**
 * @param {unknown[] | string | undefined} rows
 * @returns {string}
 */
function jsonlContent(rows) {
  let values = rows;
  if (typeof rows === 'string') {
    values = rows
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: 'artifact_parse_error', message: 'malformed JSONL line omitted' };
        }
      });
  }
  if (!Array.isArray(values)) return '';
  const content =
    values.map((row) => JSON.stringify(sanitizeDiagnosticValue(row))).join('\n') +
    (values.length ? '\n' : '');
  if (Buffer.byteLength(content) > MAX_INPUT_BYTES) {
    throw new Error('iteration artifact exceeds 2 MB');
  }
  return content;
}

/**
 * @typedef {{
 *   prepare?: (context: object) => Promise<void> | void;
 *   runIteration: (context: object) => Promise<object> | object;
 *   stop?: (context: object) => Promise<void> | void;
 * }} ScenarioDriver
 */

export class ScenarioRunManager {
  /** @param {{ driver?: ScenarioDriver | ((context: object) => Promise<object> | object) }} [options] */
  constructor(options = {}) {
    this.driver =
      typeof options.driver === 'function'
        ? { runIteration: options.driver }
        : options.driver ?? null;
    /** @type {Map<string, { controller: AbortController; promise: Promise<void>; currentIteration: number; external?: boolean; timer?: ReturnType<typeof setTimeout>; iterationStartedAt?: number }>} */
    this.active = new Map();
    /** @type {Set<string>} */
    this.starting = new Set();
    /** @type {Set<string>} */
    this.submitting = new Set();
  }

  /** @param {unknown} raw */
  async prepare(raw) {
    const config = await validatePrepareInput(raw);
    const id = `run_${crypto.randomUUID().replaceAll('-', '')}`;
    const dir = runDir(id);
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      id,
      status: 'prepared',
      classification: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      stopRequestedAt: null,
      config: {
        scenarioId: config.scenarioId,
        iterations: config.iterations,
        timeoutMs: config.timeoutMs,
        seed: config.seed,
        failFast: config.failFast,
        execution: config.execution,
      },
      replayOf: null,
      summary: { completed: 0, passed: 0, failed: 0 },
      artifacts: ARTIFACTS,
    };
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeJsonAtomic(path.join(dir, 'manifest.json'), manifest),
      writeJsonAtomic(path.join(dir, 'scenario.json'), config.scenario),
      fs.writeFile(path.join(dir, 'iterations.jsonl'), '', 'utf8'),
      fs.writeFile(path.join(dir, 'board-log.jsonl'), '', 'utf8'),
      fs.writeFile(path.join(dir, 'fake-model-requests.jsonl'), '', 'utf8'),
      writeJsonAtomic(path.join(dir, 'final-state.json'), {
        runId: id,
        status: 'prepared',
      }),
    ]);
    return manifest;
  }

  /** @param {string} id */
  async readManifest(id) {
    const wasActive = this.active.has(id);
    const manifestPath = path.join(runDir(id), 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
      throw err;
    }
    if (
      (manifest.status === 'running' || manifest.status === 'stopping') &&
      !this.active.has(id) &&
      !this.starting.has(id)
    ) {
      // A poll can open the previous file before the terminal rename and finish
      // reading it after the live runner has removed itself.
      if (wasActive) return this.readManifest(id);
      const result = {
        iteration: manifest.summary?.completed ?? 0,
        seed: null,
        classification: 'harness_error',
        startedAt: manifest.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: null,
        error: 'runner process ended before the run reached a terminal state',
      };
      await appendJsonl(path.join(runDir(id), 'iterations.jsonl'), result);
      manifest.status = 'completed';
      manifest.classification = 'harness_error';
      manifest.finishedAt = result.finishedAt;
      manifest.summary.completed += 1;
      manifest.summary.failed += 1;
      await writeJsonAtomic(manifestPath, manifest);
    }
    return manifest;
  }

  /** @param {string} id */
  async status(id) {
    const manifest = await this.readManifest(id);
    if (!manifest) return null;
    const requestCount = getFakeModelStatus().requestCount;
    return {
      ...manifest,
      currentIteration: this.active.get(id)?.currentIteration ?? null,
      artifactDirectory: runDir(id),
      requestCount,
      fakeRequestCount: requestCount,
    };
  }

  /** @param {string} id */
  async start(id) {
    assertRunId(id);
    if (this.starting.has(id) || this.active.has(id)) {
      throw new Error('run cannot start from status running');
    }
    this.starting.add(id);
    try {
      const manifest = await this.readManifest(id);
      if (!manifest) throw new Error('run not found');
      if (manifest.status !== 'prepared') {
        throw new Error(`run cannot start from status ${manifest.status}`);
      }
      const controller = new AbortController();
      manifest.status = 'running';
      manifest.startedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(runDir(id), 'manifest.json'), manifest);
      const active = { controller, currentIteration: 0, promise: Promise.resolve() };
      this.active.set(id, active);
      if (manifest.config.execution === 'external') {
        active.external = true;
        active.iterationStartedAt = Date.now();
        this.scheduleExternalTimeout(id, manifest, active);
        return this.status(id);
      }
      active.promise = this.execute(id, manifest, controller).finally(() => {
        this.active.delete(id);
      });
      return this.status(id);
    } finally {
      this.starting.delete(id);
    }
  }

  /**
   * @param {string} id
   * @param {Record<string, any>} manifest
   * @param {{ timer?: ReturnType<typeof setTimeout>; iterationStartedAt?: number }} active
   */
  scheduleExternalTimeout(id, manifest, active) {
    clearTimeout(active.timer);
    active.iterationStartedAt = Date.now();
    active.timer = setTimeout(() => {
      void this.expireExternalRun(id).catch((err) => {
        console.error(
          `[board-testing] Failed to expire external run ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, manifest.config.timeoutMs);
  }

  /** @param {string} id */
  async expireExternalRun(id) {
    if (this.submitting.has(id)) {
      const active = this.active.get(id);
      if (active?.external) {
        active.timer = setTimeout(() => {
          void this.expireExternalRun(id).catch((err) => {
            console.error(
              `[board-testing] Failed to expire external run ${id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }, 10);
      }
      return;
    }
    this.submitting.add(id);
    try {
      const active = this.active.get(id);
      if (!active?.external) return;
      const manifest = await this.readManifest(id);
      if (!manifest || manifest.status !== 'running') return;
      const index = manifest.summary.completed;
      const seed = deriveIterationSeed(manifest.config.seed, index);
      await this.persistIteration(id, manifest, {
        classification: 'timeout',
        error: `external renderer did not submit iteration ${index} within ${manifest.config.timeoutMs}ms`,
        iteration: index,
        seed,
      }, active.iterationStartedAt ?? Date.now());
      await this.finalizeRun(id, manifest, 'completed');
      clearTimeout(active.timer);
      this.active.delete(id);
    } finally {
      this.submitting.delete(id);
    }
  }

  /**
   * Accept exactly the next externally-rendered iteration.
   * @param {string} id
   * @param {unknown} raw
   */
  async submitIteration(id, raw) {
    assertRunId(id);
    if (this.submitting.has(id)) throw new Error('iteration submission is already in progress');
    this.submitting.add(id);
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('iteration result must be a JSON object');
      }
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_INPUT_BYTES) {
        throw new Error('iteration result exceeds 2 MB');
      }
      const active = this.active.get(id);
      const manifest = await this.readManifest(id);
      if (!manifest) throw new Error('run not found');
      if (
        manifest.status !== 'running' ||
        manifest.config.execution !== 'external' ||
        !active?.external
      ) {
        throw new Error('iterations can only be submitted to a running external run');
      }
      const input = /** @type {Record<string, unknown>} */ (raw);
      const expectedIteration = manifest.summary.completed;
      const expectedSeed = deriveIterationSeed(manifest.config.seed, expectedIteration);
      if (!Number.isSafeInteger(input.iteration) || input.iteration !== expectedIteration) {
        throw new Error(`expected iteration ${expectedIteration}`);
      }
      if (!Number.isSafeInteger(input.seed) || input.seed !== expectedSeed) {
        throw new Error(`expected seed ${expectedSeed}`);
      }
      const result = normalizeDriverResult(input);
      if (result.classification === 'stopped') {
        throw new Error('stopped is controlled by the stop endpoint');
      }
      clearTimeout(active.timer);
      try {
        await this.persistIteration(
          id,
          manifest,
          result,
          active.iterationStartedAt ?? Date.now(),
        );
      } catch (err) {
        this.scheduleExternalTimeout(id, manifest, active);
        throw err;
      }
      const failed = !PASSING_CLASSIFICATIONS.has(result.classification);
      const terminal =
        manifest.summary.completed >= manifest.config.iterations ||
        (manifest.config.failFast && failed);
      if (terminal) {
        await this.finalizeRun(id, manifest, 'completed');
        clearTimeout(active.timer);
        this.active.delete(id);
      } else {
        active.currentIteration = manifest.summary.completed;
        this.scheduleExternalTimeout(id, manifest, active);
      }
      return this.status(id);
    } finally {
      this.submitting.delete(id);
    }
  }

  /**
   * @param {string} id
   * @param {Record<string, any>} manifest
   * @param {Record<string, any>} result
   * @param {number} started
   */
  async persistIteration(id, manifest, result, started) {
    const dir = runDir(id);
    const index = manifest.summary.completed;
    const expectedSeed = deriveIterationSeed(manifest.config.seed, index);
    const finished = Date.now();
    const {
      boardLog,
      fakeModelRequests,
      finalState,
      iteration: _submittedIteration,
      seed: _submittedSeed,
      startedAt: _submittedStartedAt,
      finishedAt: _submittedFinishedAt,
      durationMs: _submittedDurationMs,
      ...summary
    } = result;
    const boardLogContent = boardLog == null ? '' : jsonlContent(boardLog);
    const requestContent =
      fakeModelRequests == null ? '' : jsonlContent(fakeModelRequests);
    if (boardLogContent) {
      await fs.appendFile(path.join(dir, 'board-log.jsonl'), boardLogContent);
    }
    if (requestContent) {
      await fs.appendFile(path.join(dir, 'fake-model-requests.jsonl'), requestContent);
    }
    if (finalState != null) {
      await writeJsonAtomic(
        path.join(dir, 'final-state.json'),
        sanitizeDiagnosticValue(finalState),
      );
    }
    await appendJsonl(
      path.join(dir, 'iterations.jsonl'),
      sanitizeDiagnosticValue({
        ...summary,
        iteration: index,
        seed: expectedSeed,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
      }),
    );
    manifest.summary.completed += 1;
    if (PASSING_CLASSIFICATIONS.has(result.classification)) manifest.summary.passed += 1;
    else manifest.summary.failed += 1;
    manifest.classification = aggregateClassification(
      manifest.classification,
      result.classification,
    );
    await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  }

  /** @param {string} id @param {Record<string, any>} manifest @param {'completed' | 'stopped'} status */
  async finalizeRun(id, manifest, status) {
    manifest.status = status;
    manifest.finishedAt = new Date().toISOString();
    if (status === 'stopped') manifest.classification = 'stopped';
    await writeJsonAtomic(path.join(runDir(id), 'manifest.json'), manifest);
    const currentFinal = await this.readFinalStateUnchecked(id);
    await writeJsonAtomic(path.join(runDir(id), 'final-state.json'), {
      ...currentFinal,
      runId: id,
      status,
      classification: manifest.classification,
      finishedAt: manifest.finishedAt,
    });
  }

  /** @param {string} id @param {Record<string, unknown>} manifest @param {AbortController} controller */
  async execute(id, manifest, controller) {
    const dir = runDir(id);
    const scenario = JSON.parse(await fs.readFile(path.join(dir, 'scenario.json'), 'utf8'));
    try {
      if (this.driver?.prepare) {
        await this.driver.prepare({ runId: id, scenario, signal: controller.signal });
      }
      for (let index = 0; index < manifest.config.iterations; index += 1) {
        if (controller.signal.aborted) break;
        const active = this.active.get(id);
        if (active) active.currentIteration = index;
        const seed = deriveIterationSeed(manifest.config.seed, index);
        const started = Date.now();
        let result;
        try {
          if (!this.driver?.runIteration) {
            throw new Error('live board execution driver is not configured');
          }
          const iterationController = new AbortController();
          const abortIteration = () => iterationController.abort();
          controller.signal.addEventListener('abort', abortIteration, { once: true });
          let timer;
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error(`iteration exceeded ${manifest.config.timeoutMs}ms`);
              error.name = 'ScenarioTimeoutError';
              reject(error);
              iterationController.abort();
            }, manifest.config.timeoutMs);
          });
          const aborted = new Promise((_, reject) => {
            iterationController.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('iteration stopped');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
          if (controller.signal.aborted) iterationController.abort();
          try {
            const raw = await Promise.race([
              Promise.resolve(
                this.driver.runIteration({
                  runId: id,
                  iteration: index,
                  seed,
                  scenario: structuredClone(scenario),
                  signal: iterationController.signal,
                  timeoutMs: manifest.config.timeoutMs,
                  artifactDir: dir,
                }),
              ),
              timeout,
              aborted,
            ]);
            result = normalizeDriverResult(raw);
          } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortIteration);
          }
        } catch (err) {
          const stopped = controller.signal.aborted;
          result = {
            classification:
              stopped
                ? 'stopped'
                : err instanceof Error && err.name === 'ScenarioTimeoutError'
                  ? 'timeout'
                  : 'harness_error',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        const finished = Date.now();
        const {
          boardLog: resultBoardLog,
          fakeModelRequests: resultFakeModelRequests,
          finalState: resultFinalState,
          ...resultSummary
        } = result;
        const record = sanitizeDiagnosticValue({
          ...resultSummary,
          iteration: index,
          seed,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date(finished).toISOString(),
          durationMs: finished - started,
        });
        await appendJsonl(path.join(dir, 'iterations.jsonl'), record);
        if (resultBoardLog != null) {
          await fs.appendFile(path.join(dir, 'board-log.jsonl'), jsonlContent(resultBoardLog));
        }
        if (resultFakeModelRequests != null) {
          await fs.appendFile(
            path.join(dir, 'fake-model-requests.jsonl'),
            jsonlContent(resultFakeModelRequests),
          );
        }
        if (resultFinalState != null) {
          await writeJsonAtomic(
            path.join(dir, 'final-state.json'),
            sanitizeDiagnosticValue(resultFinalState),
          );
        }
        manifest.summary.completed += 1;
        if (PASSING_CLASSIFICATIONS.has(result.classification)) manifest.summary.passed += 1;
        else manifest.summary.failed += 1;
        manifest.classification = aggregateClassification(
          manifest.classification,
          result.classification,
        );
        await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
        if (
          controller.signal.aborted ||
          (manifest.config.failFast && !PASSING_CLASSIFICATIONS.has(result.classification))
        ) {
          break;
        }
      }
    } catch (err) {
      manifest.classification = 'harness_error';
      manifest.summary.completed += 1;
      manifest.summary.failed += 1;
      await appendJsonl(path.join(dir, 'iterations.jsonl'), {
        iteration: manifest.summary.completed,
        seed: null,
        classification: 'harness_error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      manifest.status = controller.signal.aborted ? 'stopped' : 'completed';
      manifest.finishedAt = new Date().toISOString();
      if (controller.signal.aborted) manifest.classification = 'stopped';
      else if (!manifest.classification) manifest.classification = 'harness_error';
      await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
      const currentFinal = await this.readFinalStateUnchecked(id);
      await writeJsonAtomic(path.join(dir, 'final-state.json'), {
        ...currentFinal,
        runId: id,
        status: manifest.status,
        classification: manifest.classification,
        finishedAt: manifest.finishedAt,
      });
    }
  }

  /** @param {string} id */
  async stop(id) {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new Error('run not found');
    if (manifest.status === 'prepared') {
      manifest.classification = 'stopped';
      manifest.stopRequestedAt = new Date().toISOString();
      await this.finalizeRun(id, manifest, 'stopped');
      return manifest;
    }
    if (manifest.status === 'running' || manifest.status === 'stopping') {
      const active = this.active.get(id);
      if (active?.external) {
        clearTimeout(active.timer);
        active.controller.abort();
        this.active.delete(id);
        manifest.stopRequestedAt ??= new Date().toISOString();
        await this.finalizeRun(id, manifest, 'stopped');
        return this.status(id);
      }
      active?.controller.abort();
      manifest.status = 'stopping';
      manifest.stopRequestedAt ??= new Date().toISOString();
      await writeJsonAtomic(path.join(runDir(id), 'manifest.json'), manifest);
      if (this.driver?.stop) {
        await settleWithin(Promise.resolve(this.driver.stop({ runId: id })), 1_000);
      }
      if (active) {
        await settleWithin(active.promise, 1_000);
      }
      return this.status(id);
    }
    return manifest;
  }

  /** @param {string} id */
  async results(id) {
    const manifest = await this.readManifest(id);
    if (!manifest) return null;
    const text = await fs.readFile(path.join(runDir(id), 'iterations.jsonl'), 'utf8');
    const iterations = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { runId: id, status: manifest.status, classification: manifest.classification, iterations };
  }

  /** @param {string} id @param {number | undefined} iteration */
  async replay(id, iteration) {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new Error('run not found');
    if (manifest.status !== 'completed' && manifest.status !== 'stopped') {
      throw new Error('only terminal runs can be replayed');
    }
    const results = await this.results(id);
    const rows = results?.iterations ?? [];
    const selected =
      iteration == null
        ? [...rows]
            .reverse()
            .find((row) => !PASSING_CLASSIFICATIONS.has(row.classification))
        : rows[iteration];
    if (!selected || !Number.isSafeInteger(selected.seed)) {
      throw new Error('replay iteration with a deterministic seed was not found');
    }
    const scenario = JSON.parse(
      await fs.readFile(path.join(runDir(id), 'scenario.json'), 'utf8'),
    );
    const replay = await this.prepare({
      scenario,
      iterations: 1,
      timeoutMs: manifest.config.timeoutMs,
      seed: selected.seed,
      failFast: true,
      execution: manifest.config.execution,
    });
    replay.replayOf = { runId: id, iteration: selected.iteration, seed: selected.seed };
    await writeJsonAtomic(path.join(runDir(replay.id), 'manifest.json'), replay);
    return replay;
  }

  /** @param {string} id */
  async readFinalStateUnchecked(id) {
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(runDir(id), 'final-state.json'), 'utf8'),
      );
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
}

export const defaultScenarioRunManager = new ScenarioRunManager();
