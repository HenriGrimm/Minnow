import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { readConfigJson, updateIssuesResource, writeConfigJson } from '../../server/config/store.js';
import { createConfigTestServer, httpRequest, rmTestHome, setTestHome } from './test-helpers.js';

let home;
let server;
let baseUrl;
const savedHome = process.env.MINNOW_HOME;

before(async () => {
  home = setTestHome(process.env, 'minnow-config-corruption');
  server = createConfigTestServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeConfigJson('issues/state.json', { version: 3, issues: [] });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rmTestHome(home);
  if (savedHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = savedHome;
});

test('zero-filled issues fail safely and repeated requests log once per damaged version', async (t) => {
  const target = path.join(home, 'issues/state.json');
  const damaged = Buffer.alloc(2048);
  await fs.writeFile(target, damaged);
  const logs = [];
  const log = t.mock.method(console, 'error', (...args) => logs.push(args));
  try {
    for (let i = 0; i < 3; i++) {
      const result = await httpRequest(baseUrl, 'GET', '/api/config/issues');
      assert.equal(result.status, 500);
      assert.match(result.json.error, /issues\/state.json.*invalid JSON/);
      assert.doesNotMatch(result.json.error, /Unexpected token|\u0000/);
    }
    assert.equal(logs.length, 1);
    await assert.rejects(updateIssuesResource(state => state), { code: 'CONFIG_JSON_CORRUPT' });
    assert.deepEqual(await fs.readFile(target), damaged);

    await fs.writeFile(target, '{"private-data":');
    const changed = await httpRequest(baseUrl, 'GET', '/api/config/issues');
    assert.equal(changed.status, 500);
    assert.equal(logs.length, 2);
    assert.doesNotMatch(JSON.stringify(logs), /private-data/);

    // Repair is picked up without restarting; error suppression does not cache reads.
    await writeConfigJson('issues/state.json', { version: 3, issues: [] });
    assert.equal((await httpRequest(baseUrl, 'GET', '/api/config/issues')).status, 200);
  } finally {
    log.mock.restore();
  }
});

test('flush failure preserves the previous issues file and removes the temporary file', async (t) => {
  const previous = await fs.readFile(path.join(home, 'issues/state.json'));
  const open = fs.open.bind(fs);
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('state.json.tmp-')) {
      handle.sync = async () => { throw new Error('simulated flush failure'); };
    }
    return handle;
  });
  try {
    await assert.rejects(writeConfigJson('issues/state.json', { issues: [{ id: 'VIN-13' }] }), /flush failure/);
    assert.deepEqual(await fs.readFile(path.join(home, 'issues/state.json')), previous);
    assert.deepEqual((await fs.readdir(path.join(home, 'issues'))).filter(name => name.includes('.tmp-')), []);
  } finally {
    mocked.mock.restore();
  }
});

test('issue replacement flushes complete JSON before publishing it', async (t) => {
  const target = path.join(home, 'issues/state.json');
  const previous = await fs.readFile(target);
  const next = { version: 3, issues: [{ id: 'VIN-13' }] };
  const open = fs.open.bind(fs);
  let flushed = false;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('state.json.tmp-')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        assert.deepEqual(await fs.readFile(target), previous);
        assert.deepEqual(JSON.parse(await fs.readFile(args[0], 'utf8')), next);
        await sync();
        flushed = true;
      };
    }
    return handle;
  });
  try {
    await writeConfigJson('issues/state.json', next);
    assert.equal(flushed, true);
    assert.deepEqual(await readConfigJson('issues/state.json'), next);
  } finally {
    mocked.mock.restore();
  }
});
