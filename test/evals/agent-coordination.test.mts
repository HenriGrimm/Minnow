import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { validateEvalPack } from '../../src/evals/pack-schema.ts';
import { validateEvalPack as validateServerPack } from '../../server/evals/validate.js';
import { createEvalExecuteTool, resolveEvalTaskTools } from '../../src/evals/tool-context.ts';
import { DEFAULT_EVAL_CONFIG } from '../../src/evals/config.ts';
import { setEvalRunnerFactory, resetEvalRunnerFactory } from '../../src/evals/runner.ts';
import { setEvalGraderFactory, resetEvalGraderFactory } from '../../src/evals/grader.ts';
import { runEvalSuite } from '../../src/evals/suite-scheduler.ts';

const raw = JSON.parse(await fs.readFile(new URL('../../src/evals/packs/agent-coordination/pack.json', import.meta.url), 'utf8'));
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; resetEvalRunnerFactory(); resetEvalGraderFactory(); });

test('coordination pack survives both validators with twelve explicit bounded simulations', () => {
  const pack = validateEvalPack(raw);
  assert.deepEqual(pack, validateServerPack(raw));
  assert.equal(pack.tasks.length, 12);
  assert.ok(pack.tasks.every(task => task.toolFixtures?.version === 1));
  assert.deepEqual(pack.tasks.find(task => task.id === 'simple-answer-no-tools')!.toolFixtures!.steps, []);
  const exact = pack.tasks.find(task => task.id === 'exact-counts-options')!.toolFixtures!.steps;
  assert.equal(exact.length, 3);
  assert.equal((exact[0].matchArgs.target as any).options.reasoningEffort, 'low');
  assert.equal((exact[2].matchArgs.target as any).options.reasoningEffort, 'high');
});

test('script executor returns only fixtures and has no live fallback after exhaustion or invalid calls', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Live endpoints forbidden'); };
  for (const task of validateEvalPack(raw).tasks) {
    const execute = createEvalExecuteTool(DEFAULT_EVAL_CONFIG, '/unused-workspace', task);
    const definitions = resolveEvalTaskTools(task);
    assert.ok(definitions.some(tool => tool.function.name === 'chat_send'));
    for (const step of task.toolFixtures!.steps) {
      const result = await execute(step.name, structuredClone(step.matchArgs));
      assert.equal(result.content, typeof step.result === 'string' ? step.result : JSON.stringify(step.result));
    }
    assert.equal(execute.fixtureReport!().pass, true);
    const exhausted = await execute('create_chat_with_mode', { mode_id: 'build' });
    assert.match(exhausted.content, /no real operation was performed/);
    assert.equal(execute.fixtureReport!().pass, false);
  }
  assert.equal(requests, 0);
});

test('fixture validation rejects hidden execution fields, unknown tools and oversized scripts in both mirrors', () => {
  for (const mutate of [
    (pack: any) => { pack.tasks[0].toolFixtures.steps[0].executeRealTool = true; },
    (pack: any) => { pack.tasks[0].toolFixtures.steps[0].name = 'unknown-tool'; },
    (pack: any) => { pack.tasks[0].toolFixtures.steps = Array(21).fill(pack.tasks[0].toolFixtures.steps[0]); },
    (pack: any) => { pack.tasks[0].toolFixtures.steps[0].result = 'x'.repeat(64001); },
    (pack: any) => { pack.tasks[0].allowedTools = ['chat_read']; },
  ]) {
    const pack = structuredClone(raw); mutate(pack);
    assert.throws(() => validateEvalPack(pack), /toolFixtures/);
    assert.throws(() => validateServerPack(pack), /toolFixtures/);
  }
});

test('missing actual model calls cannot earn a passing grade from a prose-only mock grader', async () => {
  const cells: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('/api/evals/'), 'only mocked eval persistence may be reached');
    if (String(url) === '/api/evals/config') return Response.json(DEFAULT_EVAL_CONFIG);
    if (String(url).includes('/cells/')) cells.push(JSON.parse(options!.body as string).cell);
    return Response.json({});
  };
  setEvalRunnerFactory(() => ({ async run() { return { summary: 'I launched all three agents.', toolTurns: 0,
    messages: [{ role: 'assistant', content: 'I launched all three agents.' }] }; } }));
  let grades = 0;
  setEvalGraderFactory(() => ({ async grade() { grades++; return { score: 100, pass: true, rationale: 'Mock prose accepted' }; } }));
  const pack = validateEvalPack(raw); pack.tasks = [pack.tasks[0]];
  await runEvalSuite({ pack, request: { packId: pack.id, targets: [{ providerId: 'fixture', modelId: 'scripted' }] },
    fallbackProviderId: 'fixture', fallbackModelId: 'scripted', defaultWorkspacePath: '/unused-workspace' });
  assert.equal(cells.length, 1); assert.equal(cells[0].grader.pass, false); assert.equal(cells[0].grader.score, 0);
  assert.equal(cells[0].fixtureReport.completedSteps, 0); assert.equal(grades, 0);
});

test.skip('real-model coordination scores and cost: NOT RUN (no provider/account inference authorized for this gate)', () => {});
