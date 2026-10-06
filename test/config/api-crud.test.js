import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  closeSessionsDb,
  getSessionsDb,
  readSessionMeta,
} from '../../server/config/sessions-db.js';
import {
  createConfigTestServer,
  httpRequest,
  readFixture,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

describe('config API CRUD', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env);
    server = createConfigTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeSessionsDb();
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    await rmTestHome(homeDir);
  });

  test('GET sessions on empty home returns default blob', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.json.version, 6);
    assert.ok(Array.isArray(res.json.chats));
    assert.ok(res.json.chats.length >= 1);
  });

  test('PUT sessions round-trip matches fixture', async () => {
    const expected = JSON.parse(await readFixture('expected-sessions-state.json'));
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', expected);
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/sessions');
    assert.equal(get.status, 200);
    // revision / chatRevisions are server-owned concurrency counters.
    const { revision: _revision, chatRevisions: _chatRevisions, ...got } = get.json;
    assert.deepEqual(got, expected);
  });

  test('PUT sessions round-trip preserves modeId', async () => {
    const base = JSON.parse(await readFixture('expected-sessions-state.json'));
    base.chats[0].modeId = 'plan';
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', base);
    assert.equal(put.status, 200);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/sessions');
    assert.equal(get.status, 200);
    const chat = get.json.chats.find((c) => c.id === base.chats[0].id);
    assert.equal(chat?.modeId, 'plan');
  });

  test('PUT tools with brave key round-trips', async () => {
    const expected = JSON.parse(await readFixture('expected-tools.json'));
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/tools', expected);
    assert.equal(put.status, 200);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/tools');
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, expected);
  });

  test('GET system-prompt round-trip', async () => {
    const expected = JSON.parse(await readFixture('expected-system-prompt.json'));
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/system-prompt', expected);
    assert.equal(put.status, 200);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/system-prompt');
    assert.deepEqual(get.json, expected);
  });

  test('GET search seeds from tools.json when missing', async () => {
    const tools = {
      enabled: { web_search: true },
      permissions: { default: { web_search: 'ask' } },
      keys: { braveApiKey: 'brave-seed', tavilyApiKey: 'tvly-seed' },
      webSearchProvider: 'tavily',
    };
    const toolsPut = await httpRequest(baseUrl, 'PUT', '/api/config/tools', tools);
    assert.equal(toolsPut.status, 200);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/search');
    assert.equal(get.status, 200);
    assert.equal(get.json.provider, 'tavily');
    assert.equal(get.json.keys.braveApiKey, 'brave-seed');
    assert.equal(get.json.keys.tavilyApiKey, 'tvly-seed');
    assert.ok(Array.isArray(get.json.fallbackChain));
  });

  test('PUT search round-trip normalizes', async () => {
    const payload = {
      provider: 'brave',
      fallbackChain: ['duckduckgo', 'tavily', 'brave'],
      searxngUrl: 'http://127.0.0.1:9999/',
      keys: { braveApiKey: 'k1', tavilyApiKey: 'k2' },
      resultCount: 99,
    };
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/search', payload);
    assert.equal(put.status, 200);
    assert.equal(put.json.data.provider, 'brave');
    assert.equal(put.json.data.resultCount, 50);
    assert.deepEqual(put.json.data.fallbackChain, ['duckduckgo', 'tavily', 'brave']);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/search');
    assert.equal(get.json.provider, 'brave');
    assert.equal(get.json.searxngUrl, 'http://127.0.0.1:9999');
  });

  test('GET servers returns default searxng entry', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/servers');
    assert.equal(res.status, 200);
    assert.equal(res.json.searxng.enabled, true);
    assert.equal(res.json.searxng.autoStart, true);
    assert.equal(res.json.searxng.port, 8899);
  });

  test('PUT servers round-trip normalizes ports and booleans', async () => {
    const payload = {
      searxng: {
        enabled: true,
        autoStart: false,
        port: 9123,
      },
    };
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/servers', payload);
    assert.equal(put.status, 200);
    assert.equal(put.json.data.searxng.enabled, true);
    assert.equal(put.json.data.searxng.autoStart, false);
    assert.equal(put.json.data.searxng.port, 9123);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/servers');
    assert.equal(get.json.searxng.enabled, true);
    assert.equal(get.json.searxng.autoStart, false);
    assert.equal(get.json.searxng.port, 9123);
  });

  test('PUT servers clamps sub-minimum port to 1024', async () => {
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/servers', {
      searxng: { enabled: false, autoStart: true, port: 500 },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.searxng.port, 1024);
  });

  test('PUT servers clamps high port to 65535', async () => {
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/servers', {
      searxng: { enabled: false, autoStart: true, port: 70000 },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.searxng.port, 65535);
  });

  test('PUT research round-trip normalizes', async () => {
    const payload = {
      model: { providerId: 'lm-studio', model: 'test-model' },
      searchProvider: '',
      maxRounds: 99,
      minRounds: 2,
      maxTimeSeconds: 10,
      runTimeoutSeconds: 999999,
      maxReportTokens: 500,
      extractionTimeoutSeconds: 5,
      extractionConcurrency: 0,
      maxUrlsPerRound: 100,
      maxContentChars: 500,
      synthesisWindow: 0,
      maxEmptyRounds: 0,
    };
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/research', payload);
    assert.equal(put.status, 200);
    assert.equal(put.json.data.maxRounds, 20);
    assert.equal(put.json.data.minRounds, 2);
    assert.equal(put.json.data.maxTimeSeconds, 30);
    assert.equal(put.json.data.runTimeoutSeconds, 86400);
    assert.equal(put.json.data.extractionConcurrency, 1);

    const get = await httpRequest(baseUrl, 'GET', '/api/config/research');
    assert.equal(get.json.model.providerId, 'lm-studio');
    assert.equal(get.json.maxRounds, 20);
  });

  test('GET file API rejects traversal key', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/config/file?key=..%2F..%2Fetc%2Fpasswd',
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Invalid config path');
  });

  test('written sessions.db exists; state.json retired', async () => {
    const dbPath = path.join(homeDir, 'sessions', 'sessions.db');
    await fs.access(dbPath);

    const db = getSessionsDb();
    assert.equal(readSessionMeta(db, 'activeId'), '11111111-1111-1111-1111-111111111111');

    const stateJson = path.join(homeDir, 'sessions', 'state.json');
    const migrated = `${stateJson}.migrated`;
    let stateExists = true;
    try {
      await fs.access(stateJson);
    } catch {
      stateExists = false;
    }
    let migratedExists = true;
    try {
      await fs.access(migrated);
    } catch {
      migratedExists = false;
    }
    // After SQLite cutover, live state.json must not exist (may be .migrated from import).
    assert.equal(stateExists, false);
    assert.ok(!stateExists || migratedExists);
  });
});
