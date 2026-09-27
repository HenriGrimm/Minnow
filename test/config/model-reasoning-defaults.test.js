import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

test('per-model reasoning defaults survive restart and reject invalid levels', async () => {
  const previousHome = process.env.MINNOW_HOME;
  const home = setTestHome(process.env, 'minnow-model-reasoning-defaults');
  let server = createConfigTestServer();
  const start = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));

  try {
    let base = await start();
    const path = '/api/config/model-reasoning-defaults';
    assert.deepEqual((await httpRequest(base, 'GET', path)).json, { defaults: {} });

    const defaults = {
      'openai\u001fgpt-5': 'high',
      'anthropic\u001fclaude-opus': 'medium',
    };
    assert.equal((await httpRequest(base, 'PUT', path, { defaults })).status, 200);
    await stop();

    server = createConfigTestServer();
    base = await start();
    assert.deepEqual((await httpRequest(base, 'GET', path)).json, { defaults });
    assert.equal(
      (await httpRequest(base, 'PUT', path, { defaults: { 'openai\u001fgpt-5': 'extreme' } })).status,
      400,
    );
    assert.deepEqual((await httpRequest(base, 'GET', path)).json, { defaults });
  } finally {
    await stop();
    await rmTestHome(home);
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
  }
});
