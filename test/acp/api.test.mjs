import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleModelsRequest } from '../../server/models/routes.js';
import { shutdownAllAcpRuns } from '../../server/acp/runtime.js';
import { httpRequest, rmTestHome, setTestHome } from '../providers/test-helpers.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url));
let homeDir;
let baseUrl;
let server;

before(async () => {
  homeDir = setTestHome(process.env, `minnow-acp-api-${process.pid}`);
  server = http.createServer((req, res) => {
    req.minnowAuth = { kind: 'host' };
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleModelsRequest(req, res, pathname).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await shutdownAllAcpRuns();
  await new Promise((resolve) => server.close(resolve));
  await rmTestHome(homeDir);
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
});

async function waitForTerminalRun(id) {
  const deadline = Date.now() + 5_000;
  let since = 0;
  const events = [];
  while (Date.now() < deadline) {
    const response = await httpRequest(
      baseUrl,
      'GET',
      `/api/models/acp-runs/${encodeURIComponent(id)}?since=${since}`,
    );
    assert.equal(response.status, 200);
    events.push(...response.json.run.events);
    since = events.at(-1)?.seq ?? since;
    if (['completed', 'failed', 'cancelled'].includes(response.json.run.status)) {
      return { ...response.json.run, events };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ACP run ${id}`);
}

test('registers, verifies, and runs a local ACP stdio agent without returning secrets', async () => {
  const created = await httpRequest(baseUrl, 'POST', '/api/models/acp-agents', {
    id: 'api-agent',
    label: 'API agent',
    command: process.execPath,
    args: [fixture],
    enabled: true,
    secretEnv: { ACP_TOKEN: 'never-return-this' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.agent.hasPrivateEnvironment, true);
  assert.equal(JSON.stringify(created.json).includes('never-return-this'), false);

  const verified = await httpRequest(
    baseUrl,
    'POST',
    '/api/models/acp-agents/api-agent/verify',
    {},
  );
  assert.equal(verified.status, 200);
  assert.equal(verified.json.validation.protocolVersion, 1);

  const started = await httpRequest(
    baseUrl,
    'POST',
    '/api/models/acp-agents/api-agent/runs',
    { prompt: 'through the API' },
  );
  assert.equal(started.status, 202);
  const run = await waitForTerminalRun(started.json.run.id);
  assert.equal(run.status, 'completed');
  assert.match(
    run.events.filter((event) => event.type === 'message').map((event) => event.text).join(''),
    /Echo: through the API/,
  );
});
