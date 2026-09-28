/**
 * /api/orchestrate/board-testing — fake model, seed board, log validation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleBoardTestingRequest } from '../../server/orchestrate/board-testing/middleware.js';
import { stopFakeModel } from '../../server/orchestrate/board-testing/fake-model-host.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import { httpRequest, rmTestHome, setTestHome } from '../config/test-helpers.js';

process.env.MINNOW_TEST = '1';

const GROUP_ID = 'grp_a0000000-0000-4000-8000-000000000001';

function createBoardTestingTestServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleBoardTestingRequest(req, res, url.pathname).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
}

describe('orchestrate board-testing API', () => {
  let homeDir;
  let server;
  let baseUrl;

  before(async () => {
    homeDir = setTestHome(process.env);
    await fs.mkdir(homeDir, { recursive: true });
    await setWorkspaceRoot(homeDir);
    server = createBoardTestingTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await stopFakeModel();
    await new Promise((resolve) => server.close(resolve));
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  test('GET status reports fake model stopped by default', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/orchestrate/board-testing/status');
    assert.equal(res.status, 200);
    assert.equal(res.json?.fakeModel?.running, false);
    assert.equal(res.json?.seededBoard?.present, false);
    assert.equal(res.json?.seededBoard?.count, 0);
  });

  test('fake model start and stop', async () => {
    const start = await httpRequest(
      baseUrl,
      'POST',
      '/api/orchestrate/board-testing/fake-model/start',
      { port: 0 },
    );
    assert.equal(start.status, 200);
    assert.equal(start.json?.fakeModel?.running, true);
    assert.ok(start.json?.fakeModel?.baseUrl);

    const status = await httpRequest(baseUrl, 'GET', '/api/orchestrate/board-testing/status');
    assert.equal(status.json?.fakeModel?.running, true);
    assert.equal(status.json?.providerRegistered, true);

    const stop = await httpRequest(
      baseUrl,
      'POST',
      '/api/orchestrate/board-testing/fake-model/stop',
    );
    assert.equal(stop.status, 200);
    assert.equal(stop.json?.fakeModel?.running, false);
  });

  test('configures a running fake-model scenario and exposes only sanitized request tails', async () => {
    const configured = await httpRequest(
      baseUrl,
      'POST',
      '/api/orchestrate/board-testing/fake-model/scenario',
      {
        steps: [
          {
            match: { role: 'builder', nth: 0 },
            emit: [
              'data: {"choices":[{"delta":{"content":"configured"}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            ],
          },
        ],
      },
    );
    assert.equal(configured.status, 200);
    assert.equal(configured.json?.scenario?.stepCount, 1);

    const invalid = await httpRequest(
      baseUrl,
      'POST',
      '/api/orchestrate/board-testing/fake-model/scenario',
      { steps: [{ match: { nth: -1 }, emit: ['data: ok\n\n'] }] },
    );
    assert.equal(invalid.status, 400);

    const start = await httpRequest(
      baseUrl,
      'POST',
      '/api/orchestrate/board-testing/fake-model/start',
      { port: 0 },
    );
    const fakeBaseUrl = start.json?.fakeModel?.baseUrl;
    const completion = await fetch(`${fakeBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer transport-secret',
      },
      body: JSON.stringify({
        model: 'fake-board-model',
        apiKey: 'body-secret',
        messages: [
          {
            role: 'user',
            content: 'Execute this orchestrate task\nTask: W1-A — demo\napiKey=message-secret',
          },
        ],
      }),
    });
    assert.equal(completion.status, 200);
    assert.match(await completion.text(), /configured/);

    const tail = await httpRequest(
      baseUrl,
      'GET',
      '/api/orchestrate/board-testing/fake-model/requests?limit=1',
    );
    assert.equal(tail.status, 200);
    assert.equal(tail.json?.requests?.length, 1);
    const serialized = JSON.stringify(tail.json);
    assert.doesNotMatch(serialized, /transport-secret|body-secret|message-secret/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(tail.json?.requests?.[0]?.context?.taskId, 'W1-A');

    await httpRequest(baseUrl, 'POST', '/api/orchestrate/board-testing/fake-model/stop');
    await httpRequest(baseUrl, 'POST', '/api/orchestrate/board-testing/fake-model/scenario', {
      steps: [],
    });
  });

  test('V1 session seed is retired (MIN-716)', async () => {
    const seed = await httpRequest(baseUrl, 'POST', '/api/orchestrate/board-testing/seed', {
      workspacePath: homeDir,
      preset: 'quick',
      mode: 'manual',
      stableIds: true,
    });
    assert.equal(seed.status, 410);
    assert.match(String(seed.json?.error ?? ''), /POST \/api\/boards/);
  });

  test('V1 JSONL check-log is retired', async () => {
    const res = await httpRequest(baseUrl, 'POST', '/api/orchestrate/board-testing/check-log', {
      groupId: GROUP_ID,
    });
    assert.equal(res.status, 410);
    assert.match(String(res.json?.error ?? ''), /journal under ~\/\.minnow\/boards/);
  });

  test('tails bounded board logs and rejects paths and escaping symlinks', async () => {
    const logDir = path.join(homeDir, 'logs', 'orchestrate');
    await fs.mkdir(logDir, { recursive: true });
    const events = [
      { id: 1, type: 'one' },
      { id: 2, type: 'two', token: 'must-not-leak' },
      { id: 3, type: 'three' },
    ];
    await fs.writeFile(
      path.join(logDir, 'safe-group.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    const tail = await httpRequest(
      baseUrl,
      'GET',
      '/api/orchestrate/board-testing/board-log/tail?groupId=safe-group&limit=2',
    );
    assert.equal(tail.status, 200);
    assert.deepEqual(
      tail.json?.events?.map((event) => event.id),
      [2, 3],
    );
    assert.equal(tail.json?.events?.[0]?.token, '[REDACTED]');

    const traversal = await httpRequest(
      baseUrl,
      'GET',
      '/api/orchestrate/board-testing/board-log/tail?groupId=..%2Foutside',
    );
    assert.equal(traversal.status, 400);

    const outside = path.join(homeDir, 'outside.jsonl');
    await fs.writeFile(outside, '{"secret":"outside"}\n', 'utf8');
    await fs.symlink(outside, path.join(logDir, 'linked.jsonl'));
    const symlink = await httpRequest(
      baseUrl,
      'GET',
      '/api/orchestrate/board-testing/board-log/tail?groupId=linked',
    );
    assert.equal(symlink.status, 400);
    assert.match(symlink.json?.error, /symlink escapes/);
  });
});
