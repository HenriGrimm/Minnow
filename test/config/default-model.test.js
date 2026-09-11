import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfigTestServer, httpRequest, setTestHome, rmTestHome } from './test-helpers.js';

test('default model survives a server restart and is independent of workspace headers', async () => {
  const previousHome = process.env.MINNOW_HOME;
  const home = setTestHome(process.env, 'minnow-default-model');
  let server = createConfigTestServer();
  const start = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  try {
    let base = await start();
    assert.deepEqual((await httpRequest(base, 'GET', '/api/config/default-model')).json, { value: null });
    const value = 'provider\u001fchosen-model';
    assert.equal((await httpRequest(base, 'PUT', '/api/config/default-model', { value })).status, 200);
    await stop();
    server = createConfigTestServer();
    base = await start();
    for (const workspace of ['C:/work/one', 'C:/work/two']) {
      const response = await fetch(`${base}/api/config/default-model`, { headers: { 'X-Minnow-Workspace': workspace } });
      assert.deepEqual(await response.json(), { value });
    }
    assert.equal((await httpRequest(base, 'PUT', '/api/config/default-model', { value: {} })).status, 400);
    assert.deepEqual((await httpRequest(base, 'GET', '/api/config/default-model')).json, { value });
  } finally {
    await stop();
    await rmTestHome(home);
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
  }
});
