import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mock, test } from 'node:test';
import { waitForRequestWork } from '../../server/runtime/request-work.js';
import { runProcess } from '../../server/process-runner.js';
import { sendLspRequest } from '../../server/lsp/manager.js';

const gitOps = await import('../../server/git/git-ops.js');
const lspOps = await import('../../server/lsp/manager.js');
let admitted;
let canceled;
let admissionFailed;
let processExited;
let hold = true;
let canceledTokens = 0;
mock.module('../../server/git/git-ops.js', { namedExports: {
  ...gitOps,
  status: async () => runProcess(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify('process.stdout.write("ready\\n");setInterval(()=>{},1000)')}], { stdio: 'inherit' });setInterval(()=>{},1000)`], {
    onStdout: () => admitted?.(),
    onSpawn: child => {
      processExited = once(child, 'close');
      child.once('close', code => admissionFailed?.(new Error(`Git fixture exited before readiness (${code})`)));
    },
  }),
} });
mock.module('../../server/lsp/manager.js', { namedExports: {
  ...lspOps,
  getLspHover: async () => ({ hover: await sendLspRequest({
    sendRequest(_method, _params, token) {
      if (!hold) return Promise.resolve('healthy');
      token.onCancellationRequested(() => { canceledTokens++; canceled?.(); });
      admitted?.();
      return new Promise(() => {});
    },
  }, 'textDocument/hover', {}) }),
} });
const { handleGitRequest } = await import('../../server/git/middleware.js');
const { createLspMiddleware } = await import('../../server/lsp/middleware.js');

function post(port, route, body) {
  const req = request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false });
  req.on('error', () => {});
  req.end(JSON.stringify(body));
  return req;
}

test('disconnected admitted Git work terminates its process tree; LSP cancels its token and accepts later requests', { timeout: 10000 }, async (t) => {
  const wait = promise => waitForRequestWork(promise, t.signal);
  const clients = [];
  const lsp = createLspMiddleware(process.cwd());
  let settled;
  const server = createServer((req, res) => {
    const promise = req.url === '/api/git' ? handleGitRequest(req, res, req.url) : lsp(req, res, () => {});
    Promise.resolve(promise).finally(() => settled?.());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    let ready = new Promise((resolve, reject) => { admitted = resolve; admissionFailed = reject; });
    let done = new Promise(resolve => { settled = resolve; });
    const git = post(port, '/api/git', { op: 'status' });
    clients.push(git);
    await wait(ready);
    git.destroy();
    await wait(done);
    await wait(processExited);

    ready = new Promise((resolve, reject) => { admitted = resolve; admissionFailed = reject; });
    done = new Promise(resolve => { settled = resolve; });
    const tokenCanceled = new Promise(resolve => { canceled = resolve; });
    const hover = post(port, '/api/lsp/hover', { path: 'probe.ts', line: 0, character: 0 });
    clients.push(hover);
    await wait(ready);
    hover.destroy();
    await wait(tokenCanceled);
    await wait(done);
    assert.equal(canceledTokens, 1);

    hold = false;
    const next = post(port, '/api/lsp/hover', { path: 'probe.ts', line: 0, character: 0 });
    const [res] = await once(next, 'response');
    let body = '';
    for await (const chunk of res) body += chunk;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(body), { hover: 'healthy' });
    assert.equal(canceledTokens, 1, 'normal response close does not cancel completed LSP work');
  } finally {
    for (const client of clients) client.destroy();
    admitted = admissionFailed = canceled = settled = null;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
  }
});
