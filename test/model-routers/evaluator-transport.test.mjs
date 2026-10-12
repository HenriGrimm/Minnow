import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createProvider, setAgentCliProviderEnabled, updateAgentCliProviderSettings } from '../../server/providers/store.js';
import { deleteGenerationsForProviderShutdown } from '../../server/generations/store.js';
import { __setAgentCliPumpMocksForTests, __resetAgentCliPumpMocksForTests } from '../../server/generations/agent-cli/pump.js';
import { evaluateTask } from '../../server/model-routers/evaluator.js';

const verdict = { tier: 'balanced', effort: 'medium', confidence: 0.9, reason: 'Focused change' };
const body = { messages: [{ role: 'user', content: 'Fix a bug in one function' }] };
const cli = { providerId: 'claude-code-cli', modelId: 'claude-haiku-5-5' };
let home, upstream, httpDelay, cliRun, invocation;
const previousHome = process.env.MINNOW_HOME;

before(async () => {
  home = setTestHome(process.env, 'minnow-evaluator-transport');
  await ensureMinnowLayout();
  upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    const timer = setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
    }, httpDelay);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await createProvider({ id: 'judge-http', label: 'Judge', apiKind: 'openai-v1', baseUrl: `http://127.0.0.1:${upstream.address().port}` });
  await setAgentCliProviderEnabled('claude', true);
  await updateAgentCliProviderSettings('claude', { allowUtilityRoles: true });
});
afterEach(() => {
  __resetAgentCliPumpMocksForTests();
  deleteGenerationsForProviderShutdown();
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await rmTestHome(home);
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
});

function mockCli(delay) {
  cliRun = null; invocation = null;
  __setAgentCliPumpMocksForTests({
    prepareInvocation: async input => { invocation = input; return { env: {} }; },
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const timer = setTimeout(() => {
        const text = JSON.stringify(verdict);
        child.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'judge', content: [{ type: 'text', text }] } }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text }) + '\n');
      }, delay);
      cliRun = { child, done, stopped: false,
        async stop() { clearTimeout(timer); this.stopped = true; finish({ code: 0, stderr: '' }); },
      };
      return cliRun;
    },
  });
}

test('an HTTP chat judge can finish after the decision-model four-second limit', async () => {
  httpDelay = 4500;
  const result = await evaluateTask({ providerId: 'judge-http', modelId: 'judge' }, body);
  assert.equal(result.source, 'evaluator');
  assert.equal(result.tier, 'balanced');
});

test('a CLI judge has time to start and returns its actual judgment', async () => {
  mockCli(4500);
  const result = await evaluateTask(cli, body);
  assert.equal(result.source, 'evaluator');
  assert.equal(result.judgedBy, 'claude-haiku-5-5');
  assert.equal(result.reason, verdict.reason);
  assert.equal(cliRun.stopped, true);
  assert.equal(invocation.body.tools, undefined);
  assert.equal(invocation.body.stream, false);
});

test('a hanging CLI judge is cancelled at its deadline and the process is stopped', async () => {
  mockCli(60_000);
  await assert.rejects(evaluateTask(cli, body, { timeoutMs: 100 }), /Evaluator took longer than 0\.1s/);
  assert.equal(cliRun.stopped, true);
});

test('cancelling evaluation stops an active CLI judge', async () => {
  mockCli(60_000);
  const controller = new AbortController();
  const evaluation = evaluateTask(cli, body, { signal: controller.signal });
  while (!cliRun) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(evaluation, { name: 'AbortError' });
  assert.equal(cliRun.stopped, true);
});

test('an already cancelled evaluation never starts a CLI', async () => {
  mockCli(0);
  await assert.rejects(evaluateTask(cli, body, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(invocation, null);
});

test('CLI evaluation respects the background-use setting', async () => {
  mockCli(0);
  await updateAgentCliProviderSettings('claude', { allowUtilityRoles: false });
  try {
    await assert.rejects(evaluateTask(cli, body), /Background use of this CLI is off/);
    assert.equal(invocation, null);
  } finally {
    await updateAgentCliProviderSettings('claude', { allowUtilityRoles: true });
  }
});
