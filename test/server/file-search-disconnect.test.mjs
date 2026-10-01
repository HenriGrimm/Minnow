import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test, mock } from 'node:test';

test('aborting a sidebar grep request aborts the server search', async () => {
  let searchSignal;
  let started;
  let stopped;
  const didStart = new Promise((resolve) => { started = resolve; });
  const didStop = new Promise((resolve) => { stopped = resolve; });
  mock.module('../../server/lib/ripgrep-run.js', {
    namedExports: {
      RG_TIMEOUT_MS: 30_000,
      RG_MAX_STDOUT_BYTES: 32 * 1024 * 1024,
      runRipgrep: async (_binary, _args, options) => {
        searchSignal = options.signal;
        started();
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        stopped();
        return { stdout: '', stderr: '', code: null, stopped: 'aborted' };
      },
    },
  });
  const { createToolsMiddleware } = await import('../../server/runtime/tools-middleware.js');
  const middleware = createToolsMiddleware();
  const server = http.createServer((req, res) => void middleware(req, res, () => res.end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  try {
    const pending = fetch(`http://127.0.0.1:${server.address().port}/api/tools`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'grep', args: { pattern: 'needle', path: '.' } }),
    }).catch(() => null);
    await Promise.race([didStart, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Search did not start')), 5_000);
      timer.unref();
    })]);
    controller.abort();
    await Promise.race([didStop, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Search was not cancelled')), 5_000);
      timer.unref();
    })]);
    assert.equal(searchSignal.aborted, true);
    await pending;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    mock.reset();
  }
});
