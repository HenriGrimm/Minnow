import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { handleGitRequest } from '../../server/git/middleware.js';
import { createLspMiddleware } from '../../server/lsp/middleware.js';
import { handleTerminalRequest } from '../../server/terminal/middleware.js';
import { getLspDocumentSyncForTest, shutdownAllLsp } from '../../server/lsp/manager.js';
import { getTerminalHistoryForChat } from '../../server/terminal-runner.js';
import { DEFAULT_JSON_BODY_LIMIT } from '../../server/runtime/json-body.js';

const previousHome = process.env.MINNOW_HOME;
let home;
let server;
let port;
let requestStarted;
let requestSettled;
let currentReq;
const routes = ['/api/git', '/api/lsp/notify', '/api/terminal/run'];

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-upload-routes-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  const lsp = createLspMiddleware(home);
  server = createServer((req, res) => {
    currentReq = req;
    req.once('data', () => requestStarted?.());
    const route = req.url;
    const pending = route.startsWith('/api/git') ? handleGitRequest(req, res, route)
      : route.startsWith('/api/lsp') ? lsp(req, res, () => { res.statusCode = 404; res.end(); })
        : handleTerminalRequest(req, res, route, home);
    Promise.resolve(pending).then(() => requestSettled?.(), error => {
      requestSettled?.(error);
      if (!res.destroyed) { res.statusCode = 500; res.end(String(error)); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  shutdownAllLsp();
  closeSessionsDb();
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

function post(route, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { reject(new Error(`${route}: HTTP ${res.statusCode} returned ${JSON.stringify(body)}`)); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('git, LSP and terminal reject malformed uploads with 400 before launching operations', async () => {
  for (const route of routes) {
    const result = await post(route, '{"op":"stageAll","chatId":"upload-test","command":"create marker","event":"open","path":"probe.fake"');
    assert.equal(result.status, 400, route);
    assert.match(result.json.error, /Invalid JSON body/);
  }
  assert.equal(getLspDocumentSyncForTest('probe.fake'), null);
  assert.deepEqual(await getTerminalHistoryForChat('upload-test'), []);
  assert.equal((await fs.readdir(home)).includes('marker'), false);
});

test('all three routes enforce declared and actual chunked byte caps with 413', async () => {
  for (const route of routes) {
    const declared = await post(route, '{', { 'Content-Length': String(DEFAULT_JSON_BODY_LIMIT + 1) });
    assert.equal(declared.status, 413, `${route} declared length`);
    const streamed = await post(route, Buffer.alloc(DEFAULT_JSON_BODY_LIMIT + 1, 'a'), { 'Transfer-Encoding': 'chunked' });
    assert.equal(streamed.status, 413, `${route} chunked length`);
    assert.match(streamed.json.error, /too large/i);
  }
});

test('real disconnected uploads settle each route and never start terminal or LSP work', async () => {
  for (const route of routes) {
    const started = new Promise(resolve => { requestStarted = resolve; });
    const settled = new Promise(resolve => { requestSettled = resolve; });
    const req = request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false });
    req.on('error', () => {});
    req.write('{"op":"stageAll","chatId":"upload-test","event":"open","path":"probe.fake","command":"create marker"');
    await started;
    req.destroy();
    assert.equal(await settled, undefined);
    assert.equal(currentReq.aborted, true);
    for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(currentReq.listenerCount(event), 0);
  }
  requestStarted = null;
  requestSettled = null;
  assert.equal(getLspDocumentSyncForTest('probe.fake'), null);
  assert.deepEqual(await getTerminalHistoryForChat('upload-test'), []);
});
