import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleBoardTestingRequest } from '../../server/orchestrate/board-testing/middleware.js';
import {
  deriveIterationSeed,
  ScenarioRunManager,
} from '../../server/orchestrate/board-testing/scenario-runner.js';
import { httpRequest, rmTestHome, setTestHome } from '../config/test-helpers.js';

process.env.MINNOW_TEST = '1';

async function waitForTerminal(manager, runId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await manager.status(runId);
    if (run && ['completed', 'stopped'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not become terminal`);
}

function createServer(manager) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleBoardTestingRequest(req, res, url.pathname, {
      scenarioRunManager: manager,
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
}

function legacyScenario(id) {
  return { id, steps: [] };
}

describe('orchestrate scenario runner', () => {
  let homeDir;

  before(async () => {
    homeDir = setTestHome(process.env);
    await fs.mkdir(homeDir, { recursive: true });
  });

  after(async () => {
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  test('validates prepare input and writes a fixed artifact manifest', async () => {
    const manager = new ScenarioRunManager();
    await assert.rejects(
      manager.prepare({ scenario: { id: '../escape', steps: [] } }),
      /safe identifier/,
    );
    await assert.rejects(
      manager.prepare({ scenario: legacyScenario('valid'), iterations: 0 }),
      /iterations/,
    );
    await assert.rejects(
      manager.prepare({ scenario: legacyScenario('valid'), timeoutMs: 49 }),
      /timeoutMs/,
    );
    await assert.rejects(
      manager.prepare({
        scenario: {
          id: 'strict-custom',
          family: 'custom',
          description: 'Invalid custom scenario.',
          preset: 'quick',
          concurrency: 2,
          seed: 'strict.v1',
          expected: { boardOutcome: 'passed' },
          faults: [],
          unknown: true,
        },
      }),
      /unknown field/,
    );

    const run = await manager.prepare({
      scenario: legacyScenario('happy'),
      iterations: 2,
      seed: 123,
      timeoutMs: 500,
    });
    assert.match(run.id, /^run_[a-zA-Z0-9_-]+$/);
    assert.equal(run.status, 'prepared');
    assert.deepEqual(
      run.artifacts.map((entry) => entry.path),
      [
        'manifest.json',
        'iterations.jsonl',
        'scenario.json',
        'board-log.jsonl',
        'fake-model-requests.jsonl',
        'final-state.json',
      ],
    );
    const root = path.join(homeDir, 'logs', 'orchestrate-scenarios', run.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'scenario.json'), 'utf8')), {
      id: 'happy',
      steps: [],
    });
  });

  test('unsupported live execution is recorded as harness_error', async () => {
    const manager = new ScenarioRunManager();
    const prepared = await manager.prepare({
      scenario: legacyScenario('unsupported'),
      seed: 7,
      timeoutMs: 500,
      failFast: true,
    });
    await manager.start(prepared.id);
    const terminal = await waitForTerminal(manager, prepared.id);
    const results = await manager.results(prepared.id);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.classification, 'harness_error');
    assert.equal(results.iterations[0].classification, 'harness_error');
    assert.match(results.iterations[0].error, /driver is not configured/);
  });

  test('uses deterministic seeds and sanitizes persisted driver artifacts', async () => {
    const seen = [];
    const manager = new ScenarioRunManager({
      driver: async ({ iteration, seed }) => {
        seen.push(seed);
        return {
          classification: iteration === 0 ? 'pass' : 'expected_blocked',
          boardLog: [{ type: 'board_event', password: 'do-not-store' }],
          fakeModelRequests: [{ authorization: 'Bearer do-not-store', body: 'ok' }],
          finalState: { token: 'do-not-store', status: 'done' },
        };
      },
    });
    const prepared = await manager.prepare({
      scenario: legacyScenario('deterministic'),
      iterations: 2,
      seed: 99,
      timeoutMs: 500,
    });
    await manager.start(prepared.id);
    const terminal = await waitForTerminal(manager, prepared.id);
    assert.deepEqual(seen, [deriveIterationSeed(99, 0), deriveIterationSeed(99, 1)]);
    assert.deepEqual(
      (await manager.results(prepared.id)).iterations.map((row) => row.seed),
      seen,
    );
    assert.equal(terminal.summary.passed, 2);

    const root = path.join(homeDir, 'logs', 'orchestrate-scenarios', prepared.id);
    const stored = await Promise.all([
      fs.readFile(path.join(root, 'board-log.jsonl'), 'utf8'),
      fs.readFile(path.join(root, 'fake-model-requests.jsonl'), 'utf8'),
      fs.readFile(path.join(root, 'final-state.json'), 'utf8'),
    ]);
    assert.ok(stored.every((text) => !text.includes('do-not-store')));
    assert.ok(stored.every((text) => text.includes('[REDACTED]')));
  });

  test('cooperatively stops an active driver and bounds iteration timeout', async () => {
    const driverStarted = Promise.withResolvers();
    let observedAbort = false;
    const manager = new ScenarioRunManager({
      driver: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolve({ classification: 'stopped' });
            },
            { once: true },
          );
          driverStarted.resolve();
        }),
    });
    const prepared = await manager.prepare({
      scenario: legacyScenario('stop'),
      timeoutMs: 1_000,
    });
    await manager.start(prepared.id);
    await driverStarted.promise;
    await manager.stop(prepared.id);
    const stopped = await waitForTerminal(manager, prepared.id);
    assert.equal(observedAbort, true);
    assert.equal(stopped.status, 'stopped');

    const timeoutManager = new ScenarioRunManager({
      driver: () => new Promise(() => {}),
    });
    const timed = await timeoutManager.prepare({
      scenario: legacyScenario('timeout'),
      timeoutMs: 50,
      failFast: true,
    });
    const started = Date.now();
    await timeoutManager.start(timed.id);
    const terminal = await waitForTerminal(timeoutManager, timed.id);
    assert.equal(terminal.classification, 'timeout');
    assert.ok(Date.now() - started < 1_000);
  });

  test('a status read across completion preserves the terminal manifest', async (t) => {
    const driver = Promise.withResolvers();
    const manager = new ScenarioRunManager({ driver: () => driver.promise });
    const run = await manager.prepare({ scenario: legacyScenario('status-race') });
    await manager.start(run.id);
    const execution = manager.active.get(run.id).promise;
    const manifestPath = path.join(homeDir, 'logs', 'orchestrate-scenarios', run.id, 'manifest.json');
    const readFile = fs.readFile;
    let capturedRunningManifest = false;
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      const contents = await readFile(file, ...args);
      if (file === manifestPath && !capturedRunningManifest) {
        capturedRunningManifest = true;
        assert.equal(JSON.parse(contents).status, 'running');
        driver.resolve({ classification: 'pass' });
        await execution;
      }
      return contents;
    });

    assert.equal((await manager.status(run.id)).classification, 'pass');
    const results = await manager.results(run.id);
    assert.deepEqual(results.iterations.map((row) => row.classification), ['pass']);
  });

  test('external API accepts only the next deterministic result and supports replay', async () => {
    const manager = new ScenarioRunManager();
    const server = createServer(manager);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const scenarios = await httpRequest(
        baseUrl,
        'GET',
        '/api/orchestrate/board-testing/scenarios',
      );
      assert.equal(scenarios.status, 200);
      assert.ok(scenarios.json.scenarios.some((scenario) => scenario.id === 'happy.quick'));

      const prepared = await httpRequest(
        baseUrl,
        'POST',
        '/api/orchestrate/board-testing/runs/prepare',
        {
          scenarioId: 'happy.quick',
          execution: 'external',
          iterations: 2,
          seed: 314,
          timeoutMs: 500,
        },
      );
      assert.equal(prepared.status, 201);
      const runId = prepared.json.run.id;
      const started = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/start`,
        {},
      );
      assert.equal(started.status, 200);
      assert.equal(started.json.run.status, 'running');
      assert.equal(started.json.run.currentIteration, 0);
      assert.match(started.json.run.artifactDirectory, new RegExp(`${runId}$`));
      assert.equal(typeof started.json.run.requestCount, 'number');
      assert.equal(typeof started.json.run.fakeRequestCount, 'number');
      assert.equal((await manager.results(runId)).iterations.length, 0);

      const wrong = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        { iteration: 1, seed: deriveIterationSeed(314, 1), classification: 'pass' },
      );
      assert.equal(wrong.status, 409);

      const wrongSeed = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        { iteration: 0, seed: 999, classification: 'pass' },
      );
      assert.equal(wrongSeed.status, 409);

      const wrongClassification = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        {
          iteration: 0,
          seed: deriveIterationSeed(314, 0),
          classification: 'made_up',
        },
      );
      assert.equal(wrongClassification.status, 400);

      const first = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        {
          iteration: 0,
          seed: deriveIterationSeed(314, 0),
          classification: 'pass',
          boardLog: [{ type: 'first', password: 'external-secret' }],
          fakeModelRequests: [{ authorization: 'external-secret' }],
          finalState: { token: 'external-secret', phase: 'first' },
        },
      );
      assert.equal(first.status, 200);
      assert.equal(first.json.run.status, 'running');
      assert.equal(first.json.run.currentIteration, 1);

      const duplicate = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        { iteration: 0, seed: deriveIterationSeed(314, 0), classification: 'pass' },
      );
      assert.equal(duplicate.status, 409);

      const secondSeed = deriveIterationSeed(314, 1);
      const second = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        { iteration: 1, seed: secondSeed, classification: 'expected_blocked' },
      );
      assert.equal(second.status, 200);
      assert.equal(second.json.run.status, 'completed');
      assert.equal(second.json.run.summary.completed, 2);

      const afterTerminal = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/iterations`,
        { iteration: 2, seed: 0, classification: 'pass' },
      );
      assert.equal(afterTerminal.status, 409);

      const artifactRoot = second.json.run.artifactDirectory;
      const artifactText = (
        await Promise.all([
          fs.readFile(path.join(artifactRoot, 'board-log.jsonl'), 'utf8'),
          fs.readFile(path.join(artifactRoot, 'fake-model-requests.jsonl'), 'utf8'),
          fs.readFile(path.join(artifactRoot, 'final-state.json'), 'utf8'),
        ])
      ).join('\n');
      assert.doesNotMatch(artifactText, /external-secret/);
      assert.match(artifactText, /\[REDACTED\]/);

      const replay = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/replay`,
        { iteration: 1 },
      );
      assert.equal(replay.status, 201);
      assert.equal(replay.json.run.config.execution, 'external');
      assert.equal(replay.json.run.config.seed, secondSeed);
      const replayId = replay.json.run.id;
      await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${replayId}/start`,
        {},
      );
      const replayResult = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${replayId}/iterations`,
        { iteration: 0, seed: secondSeed, classification: 'pass' },
      );
      assert.equal(replayResult.status, 200);
      assert.equal(replayResult.json.run.status, 'completed');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('external timeout, fail-fast, and stop all reach bounded terminal states', async () => {
    const manager = new ScenarioRunManager();
    const timed = await manager.prepare({
      scenario: legacyScenario('external-timeout'),
      execution: 'external',
      iterations: 3,
      timeoutMs: 50,
      seed: 1,
    });
    await manager.start(timed.id);
    const timeout = await waitForTerminal(manager, timed.id);
    assert.equal(timeout.classification, 'timeout');
    assert.equal(timeout.summary.completed, 1);

    const failed = await manager.prepare({
      scenario: legacyScenario('external-fail-fast'),
      execution: 'external',
      iterations: 3,
      timeoutMs: 500,
      seed: 2,
      failFast: true,
    });
    await manager.start(failed.id);
    const failedSeed = deriveIterationSeed(2, 0);
    const failFast = await manager.submitIteration(failed.id, {
      iteration: 0,
      seed: failedSeed,
      classification: 'product_failure',
    });
    assert.equal(failFast.status, 'completed');
    assert.equal(failFast.summary.completed, 1);

    const stoppable = await manager.prepare({
      scenario: legacyScenario('external-stop'),
      execution: 'external',
      timeoutMs: 50,
      seed: 3,
    });
    await manager.start(stoppable.id);
    const stopped = await manager.stop(stoppable.id);
    assert.equal(stopped.status, 'stopped');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await manager.results(stoppable.id)).iterations.length, 0);
    assert.equal((await manager.status(stoppable.id)).classification, 'stopped');
  });

  test('replay preserves the selected iteration seed and API enforces state transitions', async () => {
    const manager = new ScenarioRunManager({
      driver: ({ iteration }) => ({
        classification: iteration === 0 ? 'pass' : 'product_failure',
      }),
    });
    const server = createServer(manager);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const create = await httpRequest(
        baseUrl,
        'POST',
        '/api/orchestrate/board-testing/runs/prepare',
        {
          scenario: legacyScenario('replayable'),
          iterations: 2,
          seed: 42,
          timeoutMs: 500,
        },
      );
      assert.equal(create.status, 201);
      const runId = create.json.run.id;

      const duplicateStartBeforeStart = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/start`,
        {},
      );
      assert.equal(duplicateStartBeforeStart.status, 200);
      await waitForTerminal(manager, runId);
      const duplicateStart = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/start`,
        {},
      );
      assert.equal(duplicateStart.status, 409);

      const replay = await httpRequest(
        baseUrl,
        'POST',
        `/api/orchestrate/board-testing/runs/${runId}/replay`,
        { iteration: 1 },
      );
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.json.run.replayOf, {
        runId,
        iteration: 1,
        seed: deriveIterationSeed(42, 1),
      });
      assert.equal(replay.json.run.config.seed, deriveIterationSeed(42, 1));

      const missing = await httpRequest(
        baseUrl,
        'GET',
        '/api/orchestrate/board-testing/runs/run_notfound/status',
      );
      assert.equal(missing.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
